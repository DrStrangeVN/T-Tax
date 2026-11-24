import JSZip from "jszip"
import { createHash } from "node:crypto"
import { extractTT78Xml } from "../xml/tt78-parser.js"
import { verifyEInvoiceXmlSignature } from "../xml/xmldsig-verifier.js"
import { auditParsedEInvoice } from "../xml/arithmetic-audit.js"
import { buildAnalyzePrompt, DEFAULT_ANALYZE_PROMPT_TEMPLATE, type PromptAccountInput, type PromptCategoryInput, type PromptFieldInput, type PromptProjectInput } from "./prompt-builder.js"
import { buildDynamicAnalyzeSchema } from "./schema-builder.js"
import { requestStructuredWithFallback, type LLMAttachment } from "./providers.js"
import { inspectAndRenderPdf, normalizeImageForLLM, type AttachmentImageFormat } from "./pdf-renderer.js"
import type {
  AuditIssue,
  ExtractionMethod,
  FieldProvenance,
  LLMProviderConfig,
  LineItemDTO,
  ParsedEInvoice,
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
 * 3-Tier Hybrid Document Pipeline:
 * Tier 0: Deterministic XML parser (TT78 / NĐ70 / QĐ1450-1510) + XMLDSig + Audit (0 tokens)
 * Tier 1: Rich PDF text layer -> AI Text (fast & low cost)
 * Tier 2: Scanned PDF / Photo -> Vision LLM with Zero-Hallucination confidence enforcement
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
    const extractedFields: Record<string, unknown> = {
      name:
        parsed.items[0]?.name
          ? `${parsed.seller.name ?? "HĐ"} — ${parsed.items[0].name}${parsed.items.length > 1 ? ` (+${parsed.items.length - 1})` : ""}`
          : `Hóa đơn ${parsed.symbol}-${parsed.invoiceNumber}`,
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
      taxAuthorityCode: parsed.mccqt ?? null
    }

    const provenance: Record<string, FieldProvenance> = {}
    for (const k of Object.keys(extractedFields)) provenance[k] = xmlProv

    return {
      extractionMethod: "xml",
      confidence: 1,
      parsedEInvoice: parsed,
      signatureVerification: sig,
      auditIssues: audit.issues,
      extractedFields,
      items: parsed.items,
      provenance,
      extractedText: `${parsed.seller.name ?? ""} ${parsed.seller.taxCode ?? ""} ${parsed.symbol} ${parsed.invoiceNumber} ${parsed.items.map((i) => i.name).join(" ")}`,
      tokensUsed: 0
    }
  }

  // TIER 1 & 2: PDF or Image -> Text + Vision LLM
  const isPdf = params.filename.toLowerCase().endsWith(".pdf") || params.mimetype === "application/pdf"
  const format = params.imageFormat ?? "webp"
  const attachments: LLMAttachment[] = []
  let pdfTextContext: string | undefined
  let method: ExtractionMethod = "vlm"

  if (isPdf) {
    const inspected = await inspectAndRenderPdf(params.buffer, {
      maxPages: 4,
      format,
      renderImages: true
    })
    pdfTextContext = inspected.extractedText || undefined
    method = inspected.hasRichTextLayer ? "pdf_text" : "vlm"
    // When rich text exists we still pass page 1 image for visual table alignment if providers support vision;
    // if text-only fallback is configured we still preserve text context.
    const pagesToAttach = inspected.hasRichTextLayer ? inspected.pages.slice(0, 1) : inspected.pages
    for (const pg of pagesToAttach) {
      attachments.push({
        filename: `${params.filename}#p${pg.pageIndex}.${format}`,
        mediaType: pg.mediaType,
        buffer: pg.buffer
      })
    }
  } else {
    const normalized = await normalizeImageForLLM(params.buffer, format)
    attachments.push({
      filename: params.filename,
      mediaType: normalized.mediaType,
      buffer: normalized.buffer
    })
  }

  const prompt = buildAnalyzePrompt(params.promptTemplate || DEFAULT_ANALYZE_PROMPT_TEMPLATE, {
    fields: params.fields,
    categories: params.categories,
    projects: params.projects,
    accounts: params.accounts,
    regime: params.regime
  })

  const schema = buildDynamicAnalyzeSchema(params.fields)

  const llmRes = await requestStructuredWithFallback(params.providers, {
    prompt,
    schema,
    attachments,
    textContext: pdfTextContext,
    onRateLimit: params.onRateLimit
  })

  const output = llmRes.output as Record<string, unknown>
  const confMap = (output.fieldConfidence as Record<string, number> | undefined) ?? {}
  const provenance: Record<string, FieldProvenance> = {}
  const cleanedFields: Record<string, unknown> = {}
  const issues: AuditIssue[] = []

  for (const [key, val] of Object.entries(output)) {
    if (key === "items" || key === "fieldConfidence") continue
    const conf = typeof confMap[key] === "number" ? confMap[key]! : 0.85
    if (conf < 0.75 && val !== null && val !== undefined) {
      provenance[key] = {
        source: method === "pdf_text" ? "pdf_text" : "vlm",
        confidence: conf,
        warning: `Độ tin cậy thấp (${Math.round(conf * 100)}%) — cần kế toán xác nhận.`
      }
      issues.push({
        code: "LOW_OCR_CONFIDENCE",
        severity: "warning",
        field: key,
        message: `Trường "${key}" có độ tin cậy OCR thấp (${Math.round(conf * 100)}%).`
      })
    } else {
      provenance[key] = { source: method === "pdf_text" ? "pdf_text" : "vlm", confidence: conf }
    }
    cleanedFields[key] = val ?? null
  }

  const rawItems = Array.isArray(output.items) ? (output.items as Array<Record<string, unknown>>) : []
  const items: LineItemDTO[] = rawItems.map((it, idx) => ({
    index: idx + 1,
    name: String(it.name ?? ""),
    unit: it.unit ? String(it.unit) : undefined,
    quantity: it.quantity ? String(it.quantity) : undefined,
    unitPrice: it.unitPrice ? String(it.unitPrice) : undefined,
    preTaxAmount: typeof it.preTaxAmount === "number" ? Math.round(it.preTaxAmount) : Math.round(Number(it.total ?? 0)),
    vatRate: it.vatRate ? String(it.vatRate) : undefined,
    vatAmount: typeof it.vatAmount === "number" ? Math.round(it.vatAmount) : undefined,
    amount: typeof it.total === "number" ? Math.round(it.total) : 0,
    categoryCode: it.categoryCode ? String(it.categoryCode) : undefined,
    projectCode: it.projectCode ? String(it.projectCode) : undefined
  }))

  const confValues = Object.values(provenance).map((p) => p.confidence)
  const avgConf = confValues.length ? confValues.reduce((a, b) => a + b, 0) / confValues.length : 0.8

  return {
    extractionMethod: method,
    confidence: Number(avgConf.toFixed(2)),
    auditIssues: issues,
    extractedFields: cleanedFields,
    items,
    provenance,
    extractedText: pdfTextContext || (typeof cleanedFields.text === "string" ? cleanedFields.text : undefined),
    tokensUsed: llmRes.tokensUsed,
    providerUsed: `${llmRes.provider}:${llmRes.model}`
  }
}
