import JSZip from "jszip"
import { createHash } from "node:crypto"
import { extractTT78Xml } from "../xml/tt78-parser.js"
import { verifyEInvoiceXmlSignature } from "../xml/xmldsig-verifier.js"
import { auditParsedEInvoice } from "../xml/arithmetic-audit.js"
import {
  buildAnalyzePrompt,
  buildCompactLocalVlmPrompt,
  DEFAULT_ANALYZE_PROMPT_TEMPLATE,
  type PromptAccountInput,
  type PromptCategoryInput,
  type PromptFieldInput,
  type PromptProjectInput
} from "./prompt-builder.js"
import { buildDynamicAnalyzeSchema } from "./schema-builder.js"
import {
  discoverLocalOllamaModels,
  requestFlexibleJsonWithFallback,
  type LLMAttachment
} from "./providers.js"
import {
  inspectAndRenderPdf,
  normalizeImageForLLM,
  runLocalTesseractOcr,
  type AttachmentImageFormat
} from "./pdf-renderer.js"
import {
  classifyVietnameseReceipt,
  parseOfflineOcrReceiptText,
  reconcileHandwrittenBill
} from "./handwritten-bill.js"
import type {
  AuditIssue,
  DocumentKind,
  ExtractionMethod,
  FieldProvenance,
  LLMProviderConfig,
  LineItemDTO,
  ParsedEInvoice,
  SmartRuleDTO,
  XmlSignatureVerification
} from "../types.js"

export interface UnpackedIngestItem {
  filename: string
  mimetype: string
  buffer: Buffer
  sha256: string
  stemKey: string
}

export interface DocumentAnalysisOutcome {
  extractionMethod: ExtractionMethod
  documentKind?: DocumentKind
  detectedRotationDeg?: number
  amountInWords?: string | null
  confidence: number
  parsedEInvoice?: ParsedEInvoice
  signatureVerification?: XmlSignatureVerification
  auditIssues: AuditIssue[]
  extractedFields: Record<string, unknown>
  items: LineItemDTO[]
  provenance: Record<string, FieldProvenance>
  extractedText?: string
  tokensUsed: number
  providerUsed?: string
}

function stemOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  return base.replace(/\.[^.]+$/, "").toLowerCase()
}

function guessMimetype(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith(".xml")) return "application/xml"
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".zip")) return "application/zip"
  return "application/octet-stream"
}

export async function unpackIngestBuffers(
  inputs: Array<{ filename: string; mimetype?: string; buffer: Buffer }>
): Promise<UnpackedIngestItem[]> {
  const out: UnpackedIngestItem[] = []
  const seenHashes = new Set<string>()

  const pushFile = (filename: string, buffer: Buffer, mimetype?: string) => {
    const cleanName = filename.split(/[\\/]/).pop() || filename
    if (!cleanName || cleanName.startsWith(".") || cleanName.startsWith("__MACOSX")) return
    const mime = mimetype || guessMimetype(cleanName)
    if (!/\.(xml|pdf|png|jpe?g|webp|heic)$/i.test(cleanName)) return
    const sha256 = createHash("sha256").update(buffer).digest("hex")
    if (seenHashes.has(sha256)) return
    seenHashes.add(sha256)
    out.push({ filename: cleanName, mimetype: mime, buffer, sha256, stemKey: stemOf(cleanName) })
  }

  for (const input of inputs) {
    if (input.filename.toLowerCase().endsWith(".zip") || input.mimetype === "application/zip") {
      try {
        const zip = await JSZip.loadAsync(input.buffer)
        for (const [entryPath, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue
          const buf = await entry.async("nodebuffer")
          pushFile(entryPath, buf)
        }
      } catch {
        // Ignore malformed archive
      }
    } else {
      pushFile(input.filename, input.buffer, input.mimetype)
    }
  }

  return out
}

export function pairXmlAndPdfFiles(items: UnpackedIngestItem[]): Array<{
  primary: UnpackedIngestItem
  companionPdf?: UnpackedIngestItem
}> {
  const pdfByStem = new Map<string, UnpackedIngestItem>()
  const xmlItems: UnpackedIngestItem[] = []
  const otherItems: UnpackedIngestItem[] = []

  for (const item of items) {
    if (item.filename.toLowerCase().endsWith(".xml")) xmlItems.push(item)
    else if (item.filename.toLowerCase().endsWith(".pdf")) pdfByStem.set(item.stemKey, item)
    else otherItems.push(item)
  }

  const paired: Array<{ primary: UnpackedIngestItem; companionPdf?: UnpackedIngestItem }> = []
  const consumedPdfHashes = new Set<string>()

  for (const xml of xmlItems) {
    const matchPdf = pdfByStem.get(xml.stemKey)
    if (matchPdf) consumedPdfHashes.add(matchPdf.sha256)
    paired.push({ primary: xml, companionPdf: matchPdf })
  }

  for (const pdf of pdfByStem.values()) {
    if (!consumedPdfHashes.has(pdf.sha256)) paired.push({ primary: pdf })
  }

  for (const other of otherItems) {
    paired.push({ primary: other })
  }

  return paired
}

/**
 * 4-Tier Hybrid Document Pipeline:
 * Tier 0: Deterministic XML parser (TT78 / NĐ70 / QĐ1450-1510) + XMLDSig + Audit (0 tokens)
 * Tier 1: Rich PDF text layer -> AI Text + Smart Rules / Vietnamese Lexicon Classifier
 * Tier 2: Photo / Handwritten Bill -> Auto-Orient (OSD 90/180/270) + Ink Enhance -> Vision LLM (Cloud or Auto-Discovered Ollama) + Handwritten Math/Words Reconciler
 * Tier 3: Zero-API-Key Offline Fallback -> Local Tesseract OCR (`vie+eng`) + Deterministic Handwritten Parser
 */
export async function analyzeDocumentHybrid(params: {
  filename: string
  mimetype: string
  buffer: Buffer
  providers: LLMProviderConfig[]
  fields: PromptFieldInput[]
  categories: PromptCategoryInput[]
  projects: PromptProjectInput[]
  accounts?: PromptAccountInput[]
  smartRules?: SmartRuleDTO[]
  regime?: string
  promptTemplate?: string
  imageFormat?: AttachmentImageFormat
  existingUniqueKeys?: Set<string>
  nonCashThresholdVnd?: number
  onRateLimit?: () => void
}): Promise<DocumentAnalysisOutcome> {
  const isXml =
    params.filename.toLowerCase().endsWith(".xml") ||
    params.mimetype.includes("xml")

  const validCategoryCodes = params.categories.map((c) => c.code)

  // TIER 0: Deterministic XML
  if (isXml) {
    const rawXml = params.buffer.toString("utf8")
    const parsed = extractTT78Xml(rawXml)
    const sig = verifyEInvoiceXmlSignature(rawXml)
    const audit = auditParsedEInvoice(parsed, {
      existingUniqueKeys: params.existingUniqueKeys,
      nonCashThresholdVnd: params.nonCashThresholdVnd,
      signatureVerification: sig
    })

    const xmlProv: FieldProvenance = { source: "xml", confidence: 1 }
    const summaryName = parsed.items[0]?.name
      ? `${parsed.seller.name ?? "HĐ"} — ${parsed.items[0].name}${parsed.items.length > 1 ? ` (+${parsed.items.length - 1})` : ""}`
      : `Hóa đơn ${parsed.symbol}-${parsed.invoiceNumber}`
    const extractedText = `${parsed.seller.name ?? ""} ${parsed.seller.taxCode ?? ""} ${parsed.symbol} ${parsed.invoiceNumber} ${parsed.items.map((i) => i.name).join(" ")}`

    const cls = classifyVietnameseReceipt({
      merchant: parsed.seller.name,
      merchantTaxCode: parsed.seller.taxCode,
      name: summaryName,
      items: parsed.items,
      extractedText,
      validCategoryCodes,
      smartRules: params.smartRules
    })

    const extractedFields: Record<string, unknown> = {
      documentKind: "einvoice",
      name: summaryName,
      merchant: parsed.seller.name ?? null,
      merchantTaxCode: parsed.seller.taxCode ?? null,
      issuedAt: parsed.issuedDate || null,
      total: parsed.totals.totalPayable,
      preTaxAmount: parsed.totals.totalBeforeVat,
      vatAmount: parsed.totals.totalVat,
      currencyCode: parsed.currencyCode,
      invoiceSymbol: `${parsed.templateCode}${parsed.symbol}`,
      invoiceNumber: parsed.invoiceNumber,
      sellerTaxCode: parsed.seller.taxCode ?? null,
      paymentMethod: parsed.paymentMethod ?? null,
      taxAuthorityCode: parsed.mccqt ?? null,
      categoryCode: cls.categoryCode
    }

    const provenance: Record<string, FieldProvenance> = {}
    for (const k of Object.keys(extractedFields)) provenance[k] = xmlProv
    provenance.categoryCode = {
      source: "rule",
      confidence: cls.confidence,
      warning: cls.matchedReason
    }

    return {
      extractionMethod: "xml",
      documentKind: "einvoice",
      confidence: 1,
      parsedEInvoice: parsed,
      signatureVerification: sig,
      auditIssues: audit.issues,
      extractedFields,
      items: parsed.items,
      provenance,
      extractedText,
      tokensUsed: 0
    }
  }

  // Resolve effective providers (auto-discover local Ollama vision model when none configured!)
  let activeProviders = params.providers.filter(
    (p) => p.enabled !== false && Boolean(p.model) && (p.provider === "openai_compatible" || Boolean(p.apiKey))
  )
  if (activeProviders.length === 0) {
    const discovered = await discoverLocalOllamaModels()
    if (discovered.reachable && discovered.bestVisionModel) {
      activeProviders = [
        {
          provider: "openai_compatible",
          model: discovered.bestVisionModel,
          baseUrl: discovered.baseUrl,
          apiKey: "ollama",
          enabled: true
        }
      ]
    }
  }

  // Local OpenAI-compatible VLMs (Ollama/LM Studio) work fastest & most reliably with 1024px JPEG
  const prefersLocalJpeg = activeProviders.length > 0 && activeProviders[0]!.provider === "openai_compatible"
  const effectiveFormat: AttachmentImageFormat = prefersLocalJpeg ? "jpeg" : params.imageFormat ?? "webp"
  const effectiveMaxDim = prefersLocalJpeg ? 1024 : 1800

  // TIER 1 & 2: PDF or Image preprocessing (with auto-orientation + handwriting ink enhancement)
  const isPdf = params.filename.toLowerCase().endsWith(".pdf") || params.mimetype === "application/pdf"
  const attachments: LLMAttachment[] = []
  let pdfTextContext: string | undefined
  let method: "pdf_text" | "vlm" | "local_ocr" = "vlm"
  let detectedRotationDeg = 0

  if (isPdf) {
    const inspected = await inspectAndRenderPdf(params.buffer, {
      maxPages: 4,
      format: effectiveFormat,
      renderImages: true
    })
    pdfTextContext = inspected.extractedText || undefined
    method = inspected.hasRichTextLayer ? "pdf_text" : "vlm"
    const pagesToAttach = inspected.hasRichTextLayer ? inspected.pages.slice(0, 1) : inspected.pages
    for (const pg of pagesToAttach) {
      attachments.push({
        filename: `${params.filename}#p${pg.pageIndex}.${effectiveFormat}`,
        mediaType: pg.mediaType,
        buffer: pg.buffer
      })
    }
  } else {
    const normalized = await normalizeImageForLLM(params.buffer, effectiveFormat, effectiveMaxDim, {
      autoOrient: true,
      enhanceHandwriting: true
    })
    detectedRotationDeg = normalized.rotatedDeg
    attachments.push({
      filename: params.filename,
      mediaType: normalized.mediaType,
      buffer: normalized.buffer
    })
  }

  // Always use the upgraded handwritten-aware template unless user customized it away from legacy default
  const useTemplate =
    !params.promptTemplate ||
    params.promptTemplate.includes("QUY TẮC NGHIÊM NGẶT (ZERO HALLUCINATION):")
      ? DEFAULT_ANALYZE_PROMPT_TEMPLATE
      : params.promptTemplate

  const prompt = prefersLocalJpeg
    ? buildCompactLocalVlmPrompt({ categories: params.categories })
    : buildAnalyzePrompt(useTemplate, {
        fields: params.fields,
        categories: params.categories,
        projects: params.projects,
        accounts: params.accounts,
        regime: params.regime
      })

  const schema = buildDynamicAnalyzeSchema(params.fields) as unknown as import("zod").ZodType<Record<string, unknown>>

  let rawOutput: Record<string, unknown>
  let tokensUsed = 0
  let providerUsed: string | undefined

  if (activeProviders.length > 0) {
    try {
      const llmRes = await requestFlexibleJsonWithFallback(activeProviders, {
        prompt,
        schema: prefersLocalJpeg ? undefined : schema,
        attachments,
        textContext: pdfTextContext,
        onRateLimit: params.onRateLimit
      })
      rawOutput = llmRes.output
      tokensUsed = llmRes.tokensUsed
      providerUsed = `${llmRes.provider}:${llmRes.model}`
    } catch (llmErr) {
      // TIER 3 fallback: if all VLM providers fail and we have an image or PDF text, try local offline OCR!
      const ocrText = pdfTextContext || (attachments[0] ? await runLocalTesseractOcr(attachments[0].buffer) : "")
      if (!ocrText || ocrText.trim().length < 15) {
        throw llmErr
      }
      method = "local_ocr"
      rawOutput = parseOfflineOcrReceiptText(ocrText, params.filename)
      providerUsed = "local:tesseract-vie"
    }
  } else {
    // TIER 3: Zero-API-key offline fallback via local Tesseract OCR (`vie+eng`)
    const ocrText = pdfTextContext || (attachments[0] ? await runLocalTesseractOcr(attachments[0].buffer) : "")
    if (!ocrText || ocrText.trim().length < 10) {
      throw new Error("Chưa cấu hình AI Provider (Gemini/OpenAI/Ollama) và không có kết quả OCR cục bộ.")
    }
    method = "local_ocr"
    rawOutput = parseOfflineOcrReceiptText(ocrText, params.filename)
    providerUsed = "local:tesseract-vie"
  }

  const reconciled = reconcileHandwrittenBill(rawOutput, {
    filename: params.filename,
    method,
    validCategoryCodes,
    smartRules: params.smartRules,
    extractedText: pdfTextContext,
    detectedRotationDeg
  })

  const confValues = Object.values(reconciled.provenance).map((p) => p.confidence)
  const avgConf = confValues.length ? confValues.reduce((a, b) => a + b, 0) / confValues.length : 0.8

  return {
    extractionMethod: method,
    documentKind: reconciled.documentKind,
    detectedRotationDeg,
    amountInWords: reconciled.amountInWords,
    confidence: Number(avgConf.toFixed(2)),
    auditIssues: reconciled.auditIssues,
    extractedFields: reconciled.cleanedFields,
    items: reconciled.items,
    provenance: reconciled.provenance,
    extractedText:
      pdfTextContext ||
      (typeof reconciled.cleanedFields.text === "string"
        ? reconciled.cleanedFields.text
        : `${reconciled.cleanedFields.merchant ?? ""} ${reconciled.cleanedFields.name ?? ""} ${reconciled.items.map((i) => i.name).join(" ")}`.trim()),
    tokensUsed,
    providerUsed
  }
}
