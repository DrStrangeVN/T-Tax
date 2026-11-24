import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm"
import {
  analyzeDocumentHybrid,
  applyColumnMapping,
  auditParsedEInvoice,
  convertAmount,
  exportFastBravoExcelBuffer,
  exportHtkkExcelBuffer,
  exportMisaImportExcelBuffer,
  exportTransactionsCsvAndZip,
  extractTT78Xml,
  getHistoricalExchangeRate,
  lookupVietnamTaxCode,
  matchBankRowsToTransactions,
  pairXmlAndPdfFiles,
  parseBankStatementBuffer,
  parseTabularBuffer,
  renderEInvoiceHtml,
  renderOutgoingInvoiceHtml,
  suggestJournalLines,
  syncEmailAttachments,
  unpackIngestBuffers,
  verifyEInvoiceXmlSignature,
  verifyJournalBalance,
  type AccountingRegime,
  type AttachmentImageFormat,
  type AuditIssue,
  type BankDetails,
  type BatchAnalyzeProgressEvent,
  type DocumentAnalysisOutcome,
  type ExportInvoiceRow,
  type FxCacheAdapter,
  type LLMProviderConfig,
  type LineItemDTO,
  type OutgoingInvoiceTemplateData,
  type ParsedEInvoice,
  type TransactionDirection,
  type XmlSignatureVerification
} from "@t-tax/core"
import type Database from "better-sqlite3"
import * as schema from "./schema.js"
import { ensureDefaultWorkspace, searchTransactionsFts, seedWorkspaceDefaults, type TTaxDb } from "./client.js"
import type { VaultStorage } from "./vault.js"
import { exportWorkspaceBackupZip, restoreWorkspaceBackupZip } from "./backup.js"

export interface TransactionFilterParams {
  search?: string
  direction?: "input" | "output" | "all"
  categoryCode?: string
  projectCode?: string
  vatRateCode?: string
  complianceStatus?: string
  dateFrom?: string
  dateTo?: string
  sortBy?: "issuedAt" | "totalAmount" | "merchant" | "invoiceNumber"
  sortDir?: "asc" | "desc"
  lightweight?: boolean
  limit?: number
  offset?: number
}

function enrichWorkspaceRow<T extends { bankDetailsJson: string | null }>(row: T): T & { bankDetails: BankDetails | null } {
  let bankDetails: BankDetails | null = null
  if (row.bankDetailsJson) {
    try {
      bankDetails = JSON.parse(row.bankDetailsJson) as BankDetails
    } catch {
      bankDetails = null
    }
  }
  return { ...row, bankDetails }
}

export class TTaxService {
  constructor(
    public readonly db: TTaxDb,
    public readonly sqlite: Database.Database,
    public readonly vault: VaultStorage
  ) {}

  ensureWorkspace() {
    return enrichWorkspaceRow(ensureDefaultWorkspace(this.db))
  }

  listWorkspaces() {
    return this.db.select().from(schema.workspaces).orderBy(schema.workspaces.createdAt).all().map(enrichWorkspaceRow)
  }

  createWorkspace(input: {
    name: string
    taxCode: string
    entityType: "enterprise" | "household" | "freelancer"
    accountingRegime: AccountingRegime
    address?: string
    bankDetails?: BankDetails | null
  }) {
    const id = randomUUID()
    this.db
      .insert(schema.workspaces)
      .values({
        id,
        name: input.name.trim(),
        taxCode: input.taxCode.trim(),
        entityType: input.entityType,
        accountingRegime: input.accountingRegime,
        address: input.address ?? null,
        bankDetailsJson: input.bankDetails ? JSON.stringify(input.bankDetails) : null
      })
      .run()
    seedWorkspaceDefaults(this.db, id, input.accountingRegime)
    return enrichWorkspaceRow(this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get()!)
  }

  updateWorkspace(
    workspaceId: string,
    patch: Partial<{
      name: string
      taxCode: string
      entityType: string
      accountingRegime: AccountingRegime
      fiscalYearStart: string
      baseCurrency: string
      address: string | null
      bankDetails: BankDetails | null
      bankDetailsJson: string | null
    }>
  ) {
    const { bankDetails, ...rest } = patch
    const nextValues: Record<string, unknown> = { ...rest, updatedAt: new Date().toISOString() }
    if (bankDetails !== undefined) {
      nextValues.bankDetailsJson = bankDetails ? JSON.stringify(bankDetails) : null
    }
    this.db
      .update(schema.workspaces)
      .set(nextValues)
      .where(eq(schema.workspaces.id, workspaceId))
      .run()
    const updated = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    return updated ? enrichWorkspaceRow(updated) : undefined
  }

  getSidebarBadgeCounts(workspaceId: string): { unreviewedCount: number; complianceWarnings: number } {
    const unrevRow = this.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM files WHERE workspace_id = ? AND is_reviewed = 0")
      .get(workspaceId) as { cnt: number }
    const warnRow = this.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM transactions WHERE workspace_id = ? AND compliance_status IN ('warning', 'error')")
      .get(workspaceId) as { cnt: number }
    return {
      unreviewedCount: unrevRow?.cnt ?? 0,
      complianceWarnings: warnRow?.cnt ?? 0
    }
  }

  searchGlobal(workspaceId: string, query: string) {
    const q = query.trim()
    if (!q) return { transactions: [], counterparties: [] }
    const ftsIds = searchTransactionsFts(this.sqlite, workspaceId, q).slice(0, 8)
    const transactions =
      ftsIds.length > 0
        ? this.db
            .select({
              id: schema.transactions.id,
              name: schema.transactions.name,
              merchant: schema.transactions.merchant,
              merchantTaxCode: schema.transactions.merchantTaxCode,
              invoiceNumber: schema.transactions.invoiceNumber,
              totalAmount: schema.transactions.totalAmount,
              currencyCode: schema.transactions.currencyCode,
              issuedAt: schema.transactions.issuedAt
            })
            .from(schema.transactions)
            .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ftsIds)))
            .all()
        : []

    const pattern = `%${q}%`
    const counterparties = this.sqlite
      .prepare(
        "SELECT id, tax_code AS taxCode, name, status FROM counterparties WHERE workspace_id = ? AND (name LIKE ? OR tax_code LIKE ?) LIMIT 6"
      )
      .all(workspaceId, pattern, pattern) as Array<{ id: string; taxCode: string; name: string; status: string }>

    return { transactions, counterparties }
  }

  getSettings(workspaceId: string): Record<string, string> {
    const rows = this.db.select().from(schema.settings).where(eq(schema.settings.workspaceId, workspaceId)).all()
    const map: Record<string, string> = {}
    for (const r of rows) map[r.code] = r.value ?? ""
    return map
  }

  setSetting(workspaceId: string, code: string, value: string, name?: string) {
    const existing = this.db
      .select()
      .from(schema.settings)
      .where(and(eq(schema.settings.workspaceId, workspaceId), eq(schema.settings.code, code)))
      .get()
    if (existing) {
      this.db.update(schema.settings).set({ value }).where(eq(schema.settings.id, existing.id)).run()
    } else {
      this.db
        .insert(schema.settings)
        .values({ id: randomUUID(), workspaceId, code, name: name ?? code, value })
        .run()
    }
    return this.getSettings(workspaceId)
  }

  listCategories(workspaceId: string) {
    return this.db.select().from(schema.categories).where(eq(schema.categories.workspaceId, workspaceId)).all()
  }

  upsertCategory(
    workspaceId: string,
    data: { id?: string; code: string; name: string; color: string; llmPrompt?: string; defaultDebitAccount?: string }
  ) {
    if (data.id) {
      this.db
        .update(schema.categories)
        .set({
          code: data.code,
          name: data.name,
          color: data.color,
          llmPrompt: data.llmPrompt ?? null,
          defaultDebitAccount: data.defaultDebitAccount ?? null
        })
        .where(and(eq(schema.categories.id, data.id), eq(schema.categories.workspaceId, workspaceId)))
        .run()
      return this.listCategories(workspaceId)
    }
    this.db
      .insert(schema.categories)
      .values({
        id: randomUUID(),
        workspaceId,
        code: data.code,
        name: data.name,
        color: data.color,
        llmPrompt: data.llmPrompt ?? null,
        defaultDebitAccount: data.defaultDebitAccount ?? "6428"
      })
      .run()
    return this.listCategories(workspaceId)
  }

  deleteCategory(workspaceId: string, id: string) {
    this.db.delete(schema.categories).where(and(eq(schema.categories.id, id), eq(schema.categories.workspaceId, workspaceId))).run()
    return this.listCategories(workspaceId)
  }

  listProjects(workspaceId: string) {
    return this.db.select().from(schema.projects).where(eq(schema.projects.workspaceId, workspaceId)).all()
  }

  upsertProject(workspaceId: string, data: { id?: string; code: string; name: string; color: string; llmPrompt?: string }) {
    if (data.id) {
      this.db
        .update(schema.projects)
        .set({ code: data.code, name: data.name, color: data.color, llmPrompt: data.llmPrompt ?? null })
        .where(and(eq(schema.projects.id, data.id), eq(schema.projects.workspaceId, workspaceId)))
        .run()
      return this.listProjects(workspaceId)
    }
    this.db
      .insert(schema.projects)
      .values({
        id: randomUUID(),
        workspaceId,
        code: data.code,
        name: data.name,
        color: data.color,
        llmPrompt: data.llmPrompt ?? null
      })
      .run()
    return this.listProjects(workspaceId)
  }

  deleteProject(workspaceId: string, id: string) {
    this.db.delete(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, workspaceId))).run()
    return this.listProjects(workspaceId)
  }

  listFields(workspaceId: string) {
    return this.db
      .select()
      .from(schema.fields)
      .where(eq(schema.fields.workspaceId, workspaceId))
      .orderBy(schema.fields.sortOrder)
      .all()
  }

  upsertField(
    workspaceId: string,
    data: {
      id?: string
      code: string
      name: string
      type: string
      llmPrompt?: string
      isVisibleInList?: boolean
      isVisibleInAnalysis?: boolean
      isRequired?: boolean
      isExtra?: boolean
    }
  ) {
    if (data.id) {
      this.db
        .update(schema.fields)
        .set({
          code: data.code,
          name: data.name,
          type: data.type,
          llmPrompt: data.llmPrompt ?? null,
          isVisibleInList: data.isVisibleInList ?? false,
          isVisibleInAnalysis: data.isVisibleInAnalysis ?? false,
          isRequired: data.isRequired ?? false
        })
        .where(and(eq(schema.fields.id, data.id), eq(schema.fields.workspaceId, workspaceId)))
        .run()
      return this.listFields(workspaceId)
    }
    this.db
      .insert(schema.fields)
      .values({
        id: randomUUID(),
        workspaceId,
        code: data.code,
        name: data.name,
        type: data.type,
        llmPrompt: data.llmPrompt ?? null,
        isVisibleInList: data.isVisibleInList ?? true,
        isVisibleInAnalysis: data.isVisibleInAnalysis ?? true,
        isRequired: data.isRequired ?? false,
        isExtra: data.isExtra ?? true,
        sortOrder: 99
      })
      .run()
    return this.listFields(workspaceId)
  }

  deleteField(workspaceId: string, id: string) {
    this.db.delete(schema.fields).where(and(eq(schema.fields.id, id), eq(schema.fields.workspaceId, workspaceId))).run()
    return this.listFields(workspaceId)
  }

  listCurrencies(workspaceId: string) {
    return this.db.select().from(schema.currencies).where(eq(schema.currencies.workspaceId, workspaceId)).all()
  }

  listAccounts(workspaceId: string, regime?: AccountingRegime) {
    const cond = regime
      ? and(eq(schema.chartOfAccounts.workspaceId, workspaceId), eq(schema.chartOfAccounts.regime, regime))
      : eq(schema.chartOfAccounts.workspaceId, workspaceId)
    return this.db.select().from(schema.chartOfAccounts).where(cond).orderBy(schema.chartOfAccounts.code).all()
  }

  listLegalRules() {
    return this.db.select().from(schema.legalRulesCache).all()
  }

  async ingestFiles(
    workspaceId: string,
    inputs: Array<{ filename: string; mimetype?: string; buffer: Buffer }>,
    source: "upload" | "drop" | "email" | "gdt" | "tray" = "upload"
  ) {
    const unpacked = await unpackIngestBuffers(inputs)
    const paired = pairXmlAndPdfFiles(unpacked)
    const createdFiles: Array<typeof schema.files.$inferSelect> = []
    const skippedDuplicates: string[] = []

    const saveSingle = (item: (typeof unpacked)[number], pairedFileId?: string) => {
      const dup = this.db
        .select()
        .from(schema.files)
        .where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.sha256, item.sha256)))
        .get()
      if (dup) {
        skippedDuplicates.push(item.filename)
        return dup
      }

      const saved = this.vault.saveBuffer({
        workspaceId,
        filename: item.filename,
        buffer: item.buffer
      })

      this.db
        .insert(schema.files)
        .values({
          id: saved.fileId,
          workspaceId,
          filename: item.filename,
          normalizedAsciiName: saved.asciiName,
          relativePath: saved.relativePath,
          sha256: saved.sha256,
          mimetype: item.mimetype,
          sizeBytes: saved.sizeBytes,
          source,
          pairedFileId: pairedFileId ?? null,
          isReviewed: Boolean(pairedFileId) // Companion PDF attached to XML does not clutter unsorted separately
        })
        .run()

      const row = this.db.select().from(schema.files).where(eq(schema.files.id, saved.fileId)).get()!
      createdFiles.push(row)
      return row
    }

    for (const pair of paired) {
      if (pair.companionPdf) {
        const xmlRow = saveSingle(pair.primary)
        const pdfRow = saveSingle(pair.companionPdf, xmlRow.id)
        this.db.update(schema.files).set({ pairedFileId: pdfRow.id }).where(eq(schema.files.id, xmlRow.id)).run()
      } else {
        saveSingle(pair.primary)
      }
    }

    return { createdFiles, skippedDuplicates }
  }

  listFiles(workspaceId: string, opts: { unreviewedOnly?: boolean } = {}) {
    const cond = opts.unreviewedOnly
      ? and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.isReviewed, false))
      : eq(schema.files.workspaceId, workspaceId)
    return this.db.select().from(schema.files).where(cond).orderBy(desc(schema.files.createdAt)).all()
  }

  readFilePreviewData(workspaceId: string, fileId: string): {
    file: typeof schema.files.$inferSelect
    base64?: string
    xmlHtml?: string
    parsedEInvoice?: ParsedEInvoice
    signatureVerification?: XmlSignatureVerification
  } {
    const file = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.id, fileId), eq(schema.files.workspaceId, workspaceId)))
      .get()
    if (!file) throw new Error("Không tìm thấy tệp chứng từ.")

    const buf = this.vault.readFile(file.relativePath)
    if (file.filename.toLowerCase().endsWith(".xml") || file.mimetype.includes("xml")) {
      const parsed = extractTT78Xml(buf.toString("utf8"))
      const sig = verifyEInvoiceXmlSignature(buf.toString("utf8"))
      return { file, parsedEInvoice: parsed, signatureVerification: sig }
    }

    return {
      file,
      base64: `data:${file.mimetype};base64,${buf.toString("base64")}`
    }
  }

  async renderXmlHtmlPreview(workspaceId: string, fileId: string): Promise<string> {
    const file = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.id, fileId), eq(schema.files.workspaceId, workspaceId)))
      .get()
    if (!file) throw new Error("Không tìm thấy tệp XML.")
    const xml = this.vault.readFile(file.relativePath).toString("utf8")
    const parsed = extractTT78Xml(xml)
    const sig = verifyEInvoiceXmlSignature(xml)
    return renderEInvoiceHtml(parsed, sig)
  }

  async analyzeFile(
    workspaceId: string,
    fileId: string,
    providers: LLMProviderConfig[],
    onRateLimit?: () => void
  ): Promise<DocumentAnalysisOutcome> {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    const file = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.id, fileId), eq(schema.files.workspaceId, workspaceId)))
      .get()
    if (!ws || !file) throw new Error("Không tìm thấy chứng từ.")

    const buffer = this.vault.readFile(file.relativePath)
    const settingsMap = this.getSettings(workspaceId)
    const fieldsList = this.listFields(workspaceId)
    const categoriesList = this.listCategories(workspaceId)
    const projectsList = this.listProjects(workspaceId)
    const accountsList = this.listAccounts(workspaceId, ws.accountingRegime as AccountingRegime)

    const existingKeys = new Set(
      this.db
        .select({ uniqueKey: schema.einvoiceRecords.uniqueKey })
        .from(schema.einvoiceRecords)
        .where(eq(schema.einvoiceRecords.workspaceId, workspaceId))
        .all()
        .map((r) => r.uniqueKey)
    )

    const threshold = Number(settingsMap.tax_non_cash_threshold_vnd || 20_000_000)

    const outcome = await analyzeDocumentHybrid({
      filename: file.filename,
      mimetype: file.mimetype,
      buffer,
      providers,
      fields: fieldsList,
      categories: categoriesList,
      projects: projectsList,
      accounts: accountsList,
      regime: ws.accountingRegime,
      promptTemplate: settingsMap.prompt_analyse_new_file,
      imageFormat: (settingsMap.llm_attachment_format as AttachmentImageFormat) || "webp",
      existingUniqueKeys: existingKeys,
      nonCashThresholdVnd: Number.isFinite(threshold) ? threshold : 20_000_000,
      onRateLimit
    })

    // Enrich direction automatically from Workspace MST
    if (outcome.parsedEInvoice) {
      const isSellerSelf = outcome.parsedEInvoice.seller.taxCode === ws.taxCode
      outcome.extractedFields.direction = isSellerSelf ? "output" : "input"
      outcome.extractedFields.type = isSellerSelf ? "income" : "expense"
    }

    this.db
      .update(schema.files)
      .set({
        extractionMethod: outcome.extractionMethod,
        extractionConfidence: outcome.confidence,
        cachedParseResultJson: JSON.stringify(outcome),
        fieldProvenanceJson: JSON.stringify(outcome.provenance)
      })
      .where(eq(schema.files.id, fileId))
      .run()

    return outcome
  }

  async approveFileToTransaction(
    workspaceId: string,
    fileId: string,
    input: {
      name: string
      merchant?: string | null
      merchantTaxCode?: string | null
      direction: TransactionDirection
      type?: "expense" | "income" | "transfer"
      preTaxAmount: number
      vatAmount: number
      totalAmount: number
      currencyCode: string
      vatRateCode?: string | null
      invoiceSymbol?: string | null
      invoiceNumber?: string | null
      categoryCode?: string | null
      projectCode?: string | null
      issuedAt?: string | null
      paymentMethod?: string | null
      paymentStatus?: "paid" | "unpaid" | "partial"
      note?: string | null
      items?: LineItemDTO[]
      extra?: Record<string, unknown>
    }
  ) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    const file = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.id, fileId), eq(schema.files.workspaceId, workspaceId)))
      .get()
    if (!ws || !file) throw new Error("Không tìm thấy tệp hoặc Workspace.")

    let cachedOutcome: DocumentAnalysisOutcome | null = null
    if (file.cachedParseResultJson) {
      try {
        cachedOutcome = JSON.parse(file.cachedParseResultJson) as DocumentAnalysisOutcome
      } catch {
        cachedOutcome = null
      }
    }

    // FX conversion if foreign currency
    let fxRate = "1"
    let convertedTotalVnd = input.totalAmount
    const baseCur = ws.baseCurrency || "VND"
    const txCur = (input.currencyCode || baseCur).toUpperCase()
    if (txCur !== baseCur) {
      try {
        const fx = await getHistoricalExchangeRate(
          txCur,
          baseCur,
          input.issuedAt || new Date(),
          this.createFxCacheAdapter()
        )
        fxRate = fx.rate
        convertedTotalVnd = convertAmount(input.totalAmount, fxRate, baseCur)
      } catch {
        // Keep manual fallback if offline
        convertedTotalVnd = input.totalAmount
      }
    }

    const fileIds = [file.id]
    if (file.pairedFileId) fileIds.push(file.pairedFileId)

    const issues: AuditIssue[] = cachedOutcome?.auditIssues ?? []
    const hasError = issues.some((i) => i.severity === "error")
    const hasWarn = issues.some((i) => i.severity === "warning")
    const complianceStatus = hasError ? "error" : hasWarn ? "warning" : "valid"

    const txId = randomUUID()
    const now = new Date().toISOString()

    this.db.transaction((tx) => {
      tx.insert(schema.transactions)
        .values({
          id: txId,
          workspaceId,
          name: input.name,
          merchant: input.merchant ?? null,
          merchantTaxCode: input.merchantTaxCode ?? null,
          direction: input.direction,
          type: input.type ?? (input.direction === "output" ? "income" : "expense"),
          preTaxAmount: Math.round(input.preTaxAmount || 0),
          vatAmount: Math.round(input.vatAmount || 0),
          totalAmount: Math.round(input.totalAmount || 0),
          currencyCode: txCur,
          fxRateDecimal: fxRate,
          convertedTotalVnd,
          convertedCurrencyCode: baseCur,
          vatRateCode: input.vatRateCode ?? null,
          invoiceSymbol: input.invoiceSymbol ?? null,
          invoiceNumber: input.invoiceNumber ?? null,
          itemsJson: JSON.stringify(input.items ?? cachedOutcome?.items ?? []),
          filesJson: JSON.stringify(fileIds),
          extraJson: input.extra ? JSON.stringify(input.extra) : null,
          categoryCode: input.categoryCode ?? "other",
          projectCode: input.projectCode ?? "general",
          issuedAt: input.issuedAt ?? now.slice(0, 10),
          paymentMethod: input.paymentMethod ?? null,
          paymentStatus: input.paymentStatus ?? "paid",
          complianceStatus,
          complianceIssuesJson: JSON.stringify(issues),
          note: input.note ?? null,
          extractedText: cachedOutcome?.extractedText ?? null
        })
        .run()

      if (cachedOutcome?.parsedEInvoice) {
        const inv = cachedOutcome.parsedEInvoice
        const sig = cachedOutcome.signatureVerification
        const einvId = randomUUID()
        tx.insert(schema.einvoiceRecords)
          .values({
            id: einvId,
            workspaceId,
            transactionId: txId,
            xmlFileId: file.id,
            pdfFileId: file.pairedFileId ?? null,
            uniqueKey: inv.uniqueKey,
            templateCode: inv.templateCode,
            symbol: inv.symbol,
            invoiceNumber: inv.invoiceNumber,
            invoiceKind: inv.decodedSymbol?.kindCode ?? null,
            hasTaxCode: inv.decodedSymbol?.hasTaxAuthorityCode ?? true,
            mccqt: inv.mccqt ?? null,
            issuedDate: inv.issuedDate,
            signedDate: inv.signedDate ?? null,
            sellerName: inv.seller.name ?? null,
            sellerTaxCode: inv.seller.taxCode ?? null,
            sellerAddress: inv.seller.address ?? null,
            buyerName: inv.buyer.name ?? null,
            buyerTaxCode: inv.buyer.taxCode ?? null,
            buyerIdCard: inv.buyer.citizenId ?? null,
            buyerBudgetCode: inv.buyer.budgetUnitCode ?? null,
            currencyCode: inv.currencyCode,
            exchangeRate: inv.exchangeRate,
            totalBeforeVat: inv.totals.totalBeforeVat,
            totalDiscount: inv.totals.totalDiscount,
            totalVat: inv.totals.totalVat,
            totalPayable: inv.totals.totalPayable,
            totalInWords: inv.totals.totalPayableInWords ?? null,
            vatBreakdownJson: JSON.stringify(inv.vatBreakdown),
            signatureStatus: sig?.status ?? "unsigned",
            signerCn: sig?.signerCn ?? null,
            signerTaxCode: sig?.signerTaxCode ?? null,
            signerIssuer: sig?.signerIssuer ?? null,
            signerValidTo: sig?.validTo ?? null,
            arithmeticValid: !issues.some((i) => i.code.includes("MISMATCH")),
            arithmeticDiffVnd: 0,
            rawXmlHash: file.sha256
          })
          .onConflictDoNothing()
          .run()

        for (const item of inv.items) {
          tx.insert(schema.einvoiceLineItems)
            .values({
              id: randomUUID(),
              einvoiceId: einvId,
              lineIndex: item.index,
              nature: item.nature ?? 1,
              itemCode: item.code ?? null,
              itemName: item.name,
              unit: item.unit ?? null,
              quantityDecimal: item.quantity ?? null,
              unitPriceDecimal: item.unitPrice ?? null,
              discountRate: item.discountRate ?? null,
              discountAmount: item.discountAmount ?? 0,
              preTaxAmount: item.preTaxAmount,
              vatRateCode: item.vatRate ?? null,
              vatAmount: item.vatAmount ?? 0,
              totalAmount: item.amount
            })
            .run()
        }
      }

      // Upsert counterparty if tax code exists
      if (input.merchantTaxCode && input.merchant) {
        tx.insert(schema.counterparties)
          .values({
            id: randomUUID(),
            workspaceId,
            taxCode: input.merchantTaxCode.trim(),
            name: input.merchant.trim(),
            status: "unknown",
            defaultCategoryCode: input.categoryCode ?? null
          })
          .onConflictDoNothing()
          .run()
      }

      // Auto-post balanced VAS journal entry
      this.postAutoJournalInTx(tx, {
        workspaceId,
        regime: ws.accountingRegime as AccountingRegime,
        transactionId: txId,
        name: input.name,
        direction: input.direction,
        categoryCode: input.categoryCode,
        paymentMethod: input.paymentMethod,
        paymentStatus: input.paymentStatus,
        preTaxAmount: Math.round(input.preTaxAmount || 0),
        vatAmount: Math.round(input.vatAmount || 0),
        totalAmount: convertedTotalVnd,
        merchant: input.merchant,
        merchantTaxCode: input.merchantTaxCode,
        invoiceNumber: input.invoiceNumber,
        voucherDate: input.issuedAt ?? now.slice(0, 10)
      })

      tx.update(schema.files).set({ isReviewed: true }).where(eq(schema.files.id, file.id)).run()
    })

    return this.db.select().from(schema.transactions).where(eq(schema.transactions.id, txId)).get()!
  }

  private postAutoJournalInTx(
    tx: Parameters<Parameters<TTaxDb["transaction"]>[0]>[0],
    p: {
      workspaceId: string
      regime: AccountingRegime
      transactionId: string
      name: string
      direction: TransactionDirection
      categoryCode?: string | null
      paymentMethod?: string | null
      paymentStatus?: string | null
      preTaxAmount: number
      vatAmount: number
      totalAmount: number
      merchant?: string | null
      merchantTaxCode?: string | null
      invoiceNumber?: string | null
      voucherDate: string
    }
  ) {
    const cat = tx
      .select()
      .from(schema.categories)
      .where(and(eq(schema.categories.workspaceId, p.workspaceId), eq(schema.categories.code, p.categoryCode ?? "other")))
      .get()
    const cp = p.merchantTaxCode
      ? tx
          .select()
          .from(schema.counterparties)
          .where(and(eq(schema.counterparties.workspaceId, p.workspaceId), eq(schema.counterparties.taxCode, p.merchantTaxCode)))
          .get()
      : undefined

    const lines = suggestJournalLines({
      regime: p.regime,
      direction: p.direction,
      categoryCode: p.categoryCode,
      categoryDefaultDebit: cat?.defaultDebitAccount,
      counterpartyDefaultAccount: cp?.defaultAccountCode,
      paymentMethod: p.paymentMethod,
      paymentStatus: p.paymentStatus,
      preTaxAmount: Math.round(p.preTaxAmount || 0),
      vatAmount: Math.round(p.vatAmount || 0),
      totalAmount: Math.round(p.totalAmount || 0),
      merchant: p.merchant,
      merchantTaxCode: p.merchantTaxCode,
      invoiceNumber: p.invoiceNumber
    })

    if (lines.length > 0 && verifyJournalBalance(lines).balanced) {
      const jeId = randomUUID()
      const voucherNo = `${p.direction === "output" ? "PT" : "PC"}-${p.transactionId.slice(0, 6).toUpperCase()}`
      tx.insert(schema.journalEntries)
        .values({
          id: jeId,
          workspaceId: p.workspaceId,
          transactionId: p.transactionId,
          voucherNo,
          voucherDate: p.voucherDate,
          description: p.name,
          status: "posted",
          postedBy: "auto_rule"
        })
        .run()
      for (const ln of lines) {
        tx.insert(schema.journalLines)
          .values({
            id: randomUUID(),
            entryId: jeId,
            debitAccount: ln.debitAccount,
            creditAccount: ln.creditAccount,
            amountVnd: ln.amountVnd,
            description: ln.description,
            taxCode: ln.taxCode ?? null,
            partnerTaxCode: p.merchantTaxCode ?? null
          })
          .run()
      }
    }
  }

  async analyzeFilesBatch(
    workspaceId: string,
    fileIds: string[],
    providers: LLMProviderConfig[],
    onProgress?: (ev: BatchAnalyzeProgressEvent) => void,
    shouldCancel?: () => boolean
  ) {
    const jobId = randomUUID()
    const uniqueIds = [...new Set(fileIds)]
    const total = uniqueIds.length
    const enabledCloud = providers.filter((p) => p.enabled !== false && (p.apiKey || p.baseUrl))
    const concurrency = Math.max(1, Math.min(4, enabledCloud[0]?.maxConcurrency ?? 3))
    let cursor = 0
    let done = 0
    let cancelled = false

    const worker = async () => {
      while (cursor < uniqueIds.length) {
        if (shouldCancel?.()) {
          cancelled = true
          return
        }
        const idx = cursor++
        const fileId = uniqueIds[idx]
        if (!fileId) continue
        const file = this.db.select({ filename: schema.files.filename }).from(schema.files).where(eq(schema.files.id, fileId)).get()
        const fname = file?.filename ?? fileId
        try {
          await this.analyzeFile(workspaceId, fileId, providers)
          done++
          onProgress?.({ jobId, done, total, currentFileId: fileId, currentFilename: fname, status: "running" })
        } catch (err) {
          done++
          onProgress?.({
            jobId,
            done,
            total,
            currentFileId: fileId,
            currentFilename: fname,
            status: "error",
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker()))
    onProgress?.({
      jobId,
      done,
      total,
      currentFileId: "",
      currentFilename: "",
      status: cancelled ? "cancelled" : "done"
    })
    return { jobId, done, total, cancelled }
  }

  async batchApproveCleanXml(workspaceId: string, fileIds: string[]) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) throw new Error("Workspace không tồn tại.")
    let approved = 0
    let skipped = 0
    for (const fileId of fileIds) {
      const f = this.db
        .select()
        .from(schema.files)
        .where(and(eq(schema.files.id, fileId), eq(schema.files.workspaceId, workspaceId), eq(schema.files.isReviewed, false)))
        .get()
      if (!f || f.extractionMethod !== "xml" || !f.cachedParseResultJson) {
        skipped++
        continue
      }
      try {
        const outcome = JSON.parse(f.cachedParseResultJson) as DocumentAnalysisOutcome
        if (outcome.auditIssues.some((i) => i.severity === "error")) {
          skipped++
          continue
        }
        const ef = outcome.extractedFields
        await this.approveFileToTransaction(workspaceId, f.id, {
          name: String(ef.name ?? f.filename),
          merchant: ef.merchant ? String(ef.merchant) : undefined,
          merchantTaxCode: ef.merchantTaxCode ? String(ef.merchantTaxCode) : undefined,
          direction: (ef.direction as TransactionDirection) || "input",
          preTaxAmount: Number(ef.preTaxAmount ?? 0) || 0,
          vatAmount: Number(ef.vatAmount ?? 0) || 0,
          totalAmount: Number(ef.total ?? 0) || 0,
          currencyCode: String(ef.currencyCode ?? ws.baseCurrency ?? "VND"),
          vatRateCode: ef.vatRateCode ? String(ef.vatRateCode) : undefined,
          invoiceSymbol: ef.invoiceSymbol ? String(ef.invoiceSymbol) : undefined,
          invoiceNumber: ef.invoiceNumber ? String(ef.invoiceNumber) : undefined,
          issuedAt: ef.issuedAt ? String(ef.issuedAt) : undefined,
          paymentMethod: ef.paymentMethod ? String(ef.paymentMethod) : "Chuyển khoản",
          items: outcome.items
        })
        approved++
      } catch {
        skipped++
      }
    }
    return { approved, skipped }
  }

  async splitFileItemsToTransactions(
    workspaceId: string,
    fileId: string,
    items: LineItemDTO[],
    baseMeta: { merchant?: string; merchantTaxCode?: string; issuedAt?: string; currencyCode?: string; direction?: TransactionDirection }
  ) {
    const created = []
    for (const item of items) {
      const tx = await this.approveFileToTransaction(workspaceId, fileId, {
        name: item.name,
        merchant: baseMeta.merchant,
        merchantTaxCode: baseMeta.merchantTaxCode,
        direction: baseMeta.direction ?? "input",
        preTaxAmount: item.preTaxAmount,
        vatAmount: item.vatAmount ?? 0,
        totalAmount: item.amount,
        currencyCode: baseMeta.currencyCode || "VND",
        vatRateCode: item.vatRate ?? null,
        categoryCode: item.categoryCode ?? "other",
        projectCode: item.projectCode ?? "general",
        issuedAt: baseMeta.issuedAt,
        items: [item]
      })
      created.push(tx)
    }
    this.db.update(schema.files).set({ isSplitted: true, isReviewed: true }).where(eq(schema.files.id, fileId)).run()
    return created
  }

  deleteFile(workspaceId: string, fileId: string) {
    const file = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.id, fileId), eq(schema.files.workspaceId, workspaceId)))
      .get()
    if (!file) return false
    this.vault.deleteFile(file.relativePath)
    this.db.delete(schema.files).where(eq(schema.files.id, fileId)).run()
    return true
  }

  async batchProcessXmlFiles(
    workspaceId: string,
    inputs: Array<{ filename: string; mimetype?: string; buffer: Buffer }>,
    saveToLedger = false
  ) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) throw new Error("Workspace không tồn tại.")

    const unpacked = await unpackIngestBuffers(inputs)
    const existingKeys = new Set(
      this.db
        .select({ uniqueKey: schema.einvoiceRecords.uniqueKey })
        .from(schema.einvoiceRecords)
        .where(eq(schema.einvoiceRecords.workspaceId, workspaceId))
        .all()
        .map((r) => r.uniqueKey)
    )

    const results: Array<{
      filename: string
      status: "valid" | "warning" | "error"
      parsed?: ParsedEInvoice
      signature?: XmlSignatureVerification
      issues: AuditIssue[]
      htmlPreview?: string
      error?: string
      savedTransactionId?: string
    }> = []

    const ingested = saveToLedger ? await this.ingestFiles(workspaceId, inputs, "upload") : null

    for (const item of unpacked) {
      if (!item.filename.toLowerCase().endsWith(".xml")) continue
      try {
        const rawXml = item.buffer.toString("utf8")
        const parsed = extractTT78Xml(rawXml)
        const sig = verifyEInvoiceXmlSignature(rawXml)
        const audit = auditParsedEInvoice(parsed, {
          existingUniqueKeys: existingKeys,
          signatureVerification: sig
        })
        const htmlPreview = await renderEInvoiceHtml(parsed, sig)

        const hasErr = audit.issues.some((i) => i.severity === "error")
        const hasWarn = audit.issues.some((i) => i.severity === "warning")
        let savedTxId: string | undefined

        if (saveToLedger && ingested && !existingKeys.has(parsed.uniqueKey)) {
          const matchingFile = ingested.createdFiles.find((f) => f.sha256 === item.sha256)
          if (matchingFile) {
            const direction: TransactionDirection = parsed.seller.taxCode === ws.taxCode ? "output" : "input"
            this.db
              .update(schema.files)
              .set({
                extractionMethod: "xml",
                extractionConfidence: 1,
                cachedParseResultJson: JSON.stringify({
                  extractionMethod: "xml",
                  confidence: 1,
                  parsedEInvoice: parsed,
                  signatureVerification: sig,
                  auditIssues: audit.issues,
                  items: parsed.items
                })
              })
              .where(eq(schema.files.id, matchingFile.id))
              .run()

            const tx = await this.approveFileToTransaction(workspaceId, matchingFile.id, {
              name: parsed.items[0]?.name || `HĐ ${parsed.symbol}-${parsed.invoiceNumber}`,
              merchant: direction === "input" ? parsed.seller.name : parsed.buyer.name,
              merchantTaxCode: direction === "input" ? parsed.seller.taxCode : parsed.buyer.taxCode,
              direction,
              preTaxAmount: parsed.totals.totalBeforeVat,
              vatAmount: parsed.totals.totalVat,
              totalAmount: parsed.totals.totalPayable,
              currencyCode: parsed.currencyCode,
              vatRateCode: parsed.vatBreakdown[0]?.vatRate ?? parsed.items[0]?.vatRate ?? null,
              invoiceSymbol: `${parsed.templateCode}${parsed.symbol}`,
              invoiceNumber: parsed.invoiceNumber,
              issuedAt: parsed.issuedDate,
              paymentMethod: parsed.paymentMethod ?? null,
              items: parsed.items
            })
            savedTxId = tx.id
            existingKeys.add(parsed.uniqueKey)
          }
        }

        results.push({
          filename: item.filename,
          status: hasErr ? "error" : hasWarn ? "warning" : "valid",
          parsed,
          signature: sig,
          issues: audit.issues,
          htmlPreview,
          savedTransactionId: savedTxId
        })
      } catch (err) {
        results.push({
          filename: item.filename,
          status: "error",
          issues: [],
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    return results
  }

  listTransactions(workspaceId: string, filters: TransactionFilterParams = {}) {
    const conds = [eq(schema.transactions.workspaceId, workspaceId)]

    if (filters.direction && filters.direction !== "all") {
      conds.push(eq(schema.transactions.direction, filters.direction))
    }
    if (filters.categoryCode) conds.push(eq(schema.transactions.categoryCode, filters.categoryCode))
    if (filters.projectCode) conds.push(eq(schema.transactions.projectCode, filters.projectCode))
    if (filters.vatRateCode) conds.push(eq(schema.transactions.vatRateCode, filters.vatRateCode))
    if (filters.complianceStatus) {
      if (filters.complianceStatus === "warning_or_error") {
        conds.push(inArray(schema.transactions.complianceStatus, ["warning", "error"]))
      } else {
        conds.push(eq(schema.transactions.complianceStatus, filters.complianceStatus))
      }
    }
    if (filters.dateFrom) conds.push(gte(schema.transactions.issuedAt, filters.dateFrom))
    if (filters.dateTo) conds.push(lte(schema.transactions.issuedAt, filters.dateTo))

    if (filters.search?.trim()) {
      const ftsIds = searchTransactionsFts(this.sqlite, workspaceId, filters.search)
      if (ftsIds.length === 0) {
        return { rows: [], total: 0, summary: { preTaxSum: 0, vatSum: 0, totalSum: 0 } }
      }
      conds.push(inArray(schema.transactions.id, ftsIds))
    }

    const whereClause = and(...conds)
    const dirFn = filters.sortDir === "asc" ? asc : desc
    const orderExpr =
      filters.sortBy === "totalAmount"
        ? [dirFn(schema.transactions.totalAmount), desc(schema.transactions.issuedAt)]
        : filters.sortBy === "merchant"
          ? [dirFn(schema.transactions.merchant), desc(schema.transactions.issuedAt)]
          : filters.sortBy === "invoiceNumber"
            ? [dirFn(schema.transactions.invoiceNumber), desc(schema.transactions.issuedAt)]
            : [dirFn(schema.transactions.issuedAt), dirFn(schema.transactions.createdAt)]

    const allTotals = this.db
      .select({
        preTaxAmount: schema.transactions.preTaxAmount,
        vatAmount: schema.transactions.vatAmount,
        totalAmount: schema.transactions.totalAmount,
        convertedTotalVnd: schema.transactions.convertedTotalVnd
      })
      .from(schema.transactions)
      .where(whereClause)
      .all()

    const total = allTotals.length
    let preTaxSum = 0
    let vatSum = 0
    let totalSum = 0
    for (const r of allTotals) {
      preTaxSum += r.preTaxAmount
      vatSum += r.vatAmount
      totalSum += r.convertedTotalVnd ?? r.totalAmount
    }

    const offset = filters.offset ?? 0
    const limit = filters.limit ?? 500
    const rows = filters.lightweight
      ? this.db
          .select({
            id: schema.transactions.id,
            workspaceId: schema.transactions.workspaceId,
            name: schema.transactions.name,
            merchant: schema.transactions.merchant,
            merchantTaxCode: schema.transactions.merchantTaxCode,
            direction: schema.transactions.direction,
            type: schema.transactions.type,
            preTaxAmount: schema.transactions.preTaxAmount,
            vatAmount: schema.transactions.vatAmount,
            totalAmount: schema.transactions.totalAmount,
            currencyCode: schema.transactions.currencyCode,
            fxRateDecimal: schema.transactions.fxRateDecimal,
            convertedTotalVnd: schema.transactions.convertedTotalVnd,
            vatRateCode: schema.transactions.vatRateCode,
            invoiceSymbol: schema.transactions.invoiceSymbol,
            invoiceNumber: schema.transactions.invoiceNumber,
            categoryCode: schema.transactions.categoryCode,
            projectCode: schema.transactions.projectCode,
            issuedAt: schema.transactions.issuedAt,
            paymentMethod: schema.transactions.paymentMethod,
            paymentStatus: schema.transactions.paymentStatus,
            complianceStatus: schema.transactions.complianceStatus,
            extraJson: schema.transactions.extraJson,
            note: schema.transactions.note,
            createdAt: schema.transactions.createdAt
          })
          .from(schema.transactions)
          .where(whereClause)
          .orderBy(...orderExpr)
          .limit(limit)
          .offset(offset)
          .all()
      : this.db
          .select()
          .from(schema.transactions)
          .where(whereClause)
          .orderBy(...orderExpr)
          .limit(limit)
          .offset(offset)
          .all()

    return {
      rows,
      total,
      summary: { preTaxSum, vatSum, totalSum }
    }
  }

  getTransactionDetail(workspaceId: string, id: string) {
    const tx = this.db
      .select()
      .from(schema.transactions)
      .where(and(eq(schema.transactions.workspaceId, workspaceId), eq(schema.transactions.id, id)))
      .get()
    if (!tx) return null
    const fileIds = JSON.parse(tx.filesJson || "[]") as string[]
    const files =
      fileIds.length > 0
        ? this.db
            .select({
              id: schema.files.id,
              filename: schema.files.filename,
              mimetype: schema.files.mimetype,
              pairedFileId: schema.files.pairedFileId
            })
            .from(schema.files)
            .where(and(eq(schema.files.workspaceId, workspaceId), inArray(schema.files.id, fileIds)))
            .all()
        : []
    const einvoice = this.db
      .select()
      .from(schema.einvoiceRecords)
      .where(and(eq(schema.einvoiceRecords.workspaceId, workspaceId), eq(schema.einvoiceRecords.transactionId, id)))
      .get()
    const jes = this.db
      .select()
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.workspaceId, workspaceId), eq(schema.journalEntries.transactionId, id)))
      .all()
    const entryIds = jes.map((e) => e.id)
    const lines =
      entryIds.length > 0
        ? this.db.select().from(schema.journalLines).where(inArray(schema.journalLines.entryId, entryIds)).all()
        : []
    return {
      transaction: tx,
      items: JSON.parse(tx.itemsJson || "[]") as LineItemDTO[],
      complianceIssues: JSON.parse(tx.complianceIssuesJson || "[]") as AuditIssue[],
      files,
      einvoice: einvoice ?? null,
      journalEntries: jes.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e.id) }))
    }
  }

  async createManualTransaction(
    workspaceId: string,
    input: {
      name: string
      merchant?: string
      merchantTaxCode?: string
      direction: TransactionDirection
      preTaxAmount: number
      vatAmount: number
      totalAmount: number
      currencyCode?: string
      fxRateDecimal?: string
      vatRateCode?: string
      invoiceSymbol?: string
      invoiceNumber?: string
      categoryCode?: string
      projectCode?: string
      issuedAt?: string
      paymentMethod?: string
      paymentStatus?: "paid" | "unpaid" | "partial"
      note?: string
    }
  ) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    const id = randomUUID()
    const baseCur = ws?.baseCurrency || "VND"
    const cur = (input.currencyCode || baseCur).toUpperCase()
    const total = Math.round(input.totalAmount || input.preTaxAmount + input.vatAmount)
    const issuedAt = input.issuedAt ?? new Date().toISOString().slice(0, 10)

    let fxRate = input.fxRateDecimal || "1"
    let convertedTotalVnd = total
    if (cur !== baseCur) {
      if (input.fxRateDecimal && Number(input.fxRateDecimal) > 0) {
        convertedTotalVnd = convertAmount(total, input.fxRateDecimal, baseCur)
      } else {
        try {
          const fx = await getHistoricalExchangeRate(cur, baseCur, issuedAt, this.createFxCacheAdapter())
          fxRate = fx.rate
          convertedTotalVnd = convertAmount(total, fxRate, baseCur)
        } catch {
          convertedTotalVnd = total
        }
      }
    }

    this.db.transaction((tx) => {
      tx.insert(schema.transactions)
        .values({
          id,
          workspaceId,
          name: input.name,
          merchant: input.merchant ?? null,
          merchantTaxCode: input.merchantTaxCode ?? null,
          direction: input.direction,
          type: input.direction === "output" ? "income" : "expense",
          preTaxAmount: Math.round(input.preTaxAmount || 0),
          vatAmount: Math.round(input.vatAmount || 0),
          totalAmount: total,
          currencyCode: cur,
          fxRateDecimal: fxRate,
          convertedTotalVnd,
          convertedCurrencyCode: baseCur,
          vatRateCode: input.vatRateCode ?? null,
          invoiceSymbol: input.invoiceSymbol ?? null,
          invoiceNumber: input.invoiceNumber ?? null,
          categoryCode: input.categoryCode ?? "other",
          projectCode: input.projectCode ?? "general",
          issuedAt,
          paymentMethod: input.paymentMethod ?? null,
          paymentStatus: input.paymentStatus ?? "paid",
          complianceStatus: "valid",
          note: input.note ?? null
        })
        .run()

      if (ws) {
        this.postAutoJournalInTx(tx, {
          workspaceId,
          regime: ws.accountingRegime as AccountingRegime,
          transactionId: id,
          name: input.name,
          direction: input.direction,
          categoryCode: input.categoryCode,
          paymentMethod: input.paymentMethod,
          paymentStatus: input.paymentStatus ?? "paid",
          preTaxAmount: Math.round(input.preTaxAmount || 0),
          vatAmount: Math.round(input.vatAmount || 0),
          totalAmount: convertedTotalVnd,
          merchant: input.merchant,
          merchantTaxCode: input.merchantTaxCode,
          invoiceNumber: input.invoiceNumber,
          voucherDate: issuedAt
        })
      }
    })

    return this.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!
  }

  updateTransaction(
    workspaceId: string,
    id: string,
    patch: Partial<typeof schema.transactions.$inferInsert>,
    opts: { repostJournal?: boolean } = { repostJournal: true }
  ) {
    this.db.transaction((tx) => {
      tx.update(schema.transactions)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(and(eq(schema.transactions.id, id), eq(schema.transactions.workspaceId, workspaceId)))
        .run()

      const shouldRepost =
        opts.repostJournal !== false &&
        (patch.preTaxAmount !== undefined ||
          patch.vatAmount !== undefined ||
          patch.totalAmount !== undefined ||
          patch.categoryCode !== undefined ||
          patch.paymentMethod !== undefined ||
          patch.paymentStatus !== undefined ||
          patch.direction !== undefined ||
          patch.issuedAt !== undefined)

      if (shouldRepost) {
        const ws = tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
        const curr = tx
          .select()
          .from(schema.transactions)
          .where(and(eq(schema.transactions.id, id), eq(schema.transactions.workspaceId, workspaceId)))
          .get()
        if (ws && curr) {
          // Replace auto-posted journal entry cleanly to keep VAS ledger in sync
          tx.delete(schema.journalEntries)
            .where(
              and(
                eq(schema.journalEntries.workspaceId, workspaceId),
                eq(schema.journalEntries.transactionId, id),
                eq(schema.journalEntries.postedBy, "auto_rule")
              )
            )
            .run()

          this.postAutoJournalInTx(tx, {
            workspaceId,
            regime: ws.accountingRegime as AccountingRegime,
            transactionId: id,
            name: curr.name || "Chứng từ",
            direction: (curr.direction as TransactionDirection) || "input",
            categoryCode: curr.categoryCode,
            paymentMethod: curr.paymentMethod,
            paymentStatus: curr.paymentStatus,
            preTaxAmount: curr.preTaxAmount,
            vatAmount: curr.vatAmount,
            totalAmount: curr.convertedTotalVnd ?? curr.totalAmount,
            merchant: curr.merchant,
            merchantTaxCode: curr.merchantTaxCode,
            invoiceNumber: curr.invoiceNumber,
            voucherDate: curr.issuedAt ?? new Date().toISOString().slice(0, 10)
          })
        }
      }
    })
    return this.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()
  }

  bulkUpdateTransactions(
    workspaceId: string,
    ids: string[],
    patch: Partial<Pick<typeof schema.transactions.$inferInsert, "categoryCode" | "projectCode" | "paymentStatus">>
  ) {
    if (!ids.length) return 0
    this.db
      .update(schema.transactions)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
      .run()
    return ids.length
  }

  deleteTransactions(workspaceId: string, ids: string[]) {
    if (!ids.length) return 0
    this.db
      .delete(schema.transactions)
      .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
      .run()
    return ids.length
  }

  getDashboardStats(workspaceId: string, dateFrom?: string, dateTo?: string) {
    const condSql: string[] = ["workspace_id = ?"]
    const params: unknown[] = [workspaceId]
    if (dateFrom) {
      condSql.push("issued_at >= ?")
      params.push(dateFrom)
    }
    if (dateTo) {
      condSql.push("issued_at <= ?")
      params.push(dateTo)
    }
    const whereSql = condSql.join(" AND ")

    const agg = this.sqlite
      .prepare(
        `SELECT
          COUNT(*) AS tx_count,
          COALESCE(SUM(CASE WHEN direction = 'output' THEN COALESCE(converted_total_vnd, total_amount) ELSE 0 END), 0) AS total_rev,
          COALESCE(SUM(CASE WHEN direction != 'output' THEN COALESCE(converted_total_vnd, total_amount) ELSE 0 END), 0) AS total_exp,
          COALESCE(SUM(CASE WHEN direction = 'output' THEN vat_amount ELSE 0 END), 0) AS out_vat,
          COALESCE(SUM(CASE WHEN direction != 'output' THEN vat_amount ELSE 0 END), 0) AS in_vat,
          COALESCE(SUM(CASE WHEN compliance_status IN ('warning', 'error') THEN 1 ELSE 0 END), 0) AS warnings
        FROM transactions WHERE ${whereSql}`
      )
      .get(...params) as {
        tx_count: number
        total_rev: number
        total_exp: number
        out_vat: number
        in_vat: number
        warnings: number
      }

    const monthlySeries = this.sqlite
      .prepare(
        `SELECT
          substr(coalesce(issued_at, created_at), 1, 7) AS period,
          COALESCE(SUM(CASE WHEN direction = 'output' THEN COALESCE(converted_total_vnd, total_amount) ELSE 0 END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN direction != 'output' THEN COALESCE(converted_total_vnd, total_amount) ELSE 0 END), 0) AS expense,
          COALESCE(SUM(CASE WHEN direction = 'output' THEN vat_amount ELSE 0 END), 0) AS vatOut,
          COALESCE(SUM(CASE WHEN direction != 'output' THEN vat_amount ELSE 0 END), 0) AS vatIn
        FROM transactions WHERE ${whereSql}
        GROUP BY period
        ORDER BY period ASC`
      )
      .all(...params) as Array<{ period: string; revenue: number; expense: number; vatOut: number; vatIn: number }>

    const catRaw = this.sqlite
      .prepare(
        `SELECT
          COALESCE(category_code, 'other') AS code,
          COALESCE(SUM(COALESCE(converted_total_vnd, total_amount)), 0) AS total
        FROM transactions WHERE ${whereSql} AND direction != 'output'
        GROUP BY COALESCE(category_code, 'other')
        ORDER BY total DESC`
      )
      .all(...params) as Array<{ code: string; total: number }>

    const catMap = new Map(this.listCategories(workspaceId).map((c) => [c.code, c]))
    const categoryBreakdown = catRaw.map((r) => ({
      code: r.code,
      name: catMap.get(r.code)?.name ?? "Khác",
      color: catMap.get(r.code)?.color ?? "#64748B",
      total: r.total
    }))

    const { unreviewedCount } = this.getSidebarBadgeCounts(workspaceId)
    const actionItems = this.sqlite
      .prepare(
        `SELECT id, name, merchant, invoice_number AS invoiceNumber, issued_at AS issuedAt, total_amount AS totalAmount, compliance_status AS complianceStatus
        FROM transactions
        WHERE workspace_id = ? AND compliance_status IN ('warning', 'error')
        ORDER BY issued_at DESC, created_at DESC
        LIMIT 6`
      )
      .all(workspaceId) as Array<{
        id: string
        name: string | null
        merchant: string | null
        invoiceNumber: string | null
        issuedAt: string | null
        totalAmount: number
        complianceStatus: string
      }>

    const totalRevenue = agg?.total_rev ?? 0
    const totalExpense = agg?.total_exp ?? 0
    const outputVat = agg?.out_vat ?? 0
    const inputVat = agg?.in_vat ?? 0

    return {
      totalRevenue,
      totalExpense,
      netProfit: totalRevenue - totalExpense,
      outputVat,
      inputVat,
      vatPayable: outputVat - inputVat,
      transactionCount: agg?.tx_count ?? 0,
      unreviewedCount,
      complianceWarnings: agg?.warnings ?? 0,
      monthlySeries,
      categoryBreakdown,
      actionItems
    }
  }

  listJournalEntries(workspaceId: string, opts: { dateFrom?: string; dateTo?: string; limit?: number } = {}) {
    const conds = [eq(schema.journalEntries.workspaceId, workspaceId)]
    if (opts.dateFrom) conds.push(gte(schema.journalEntries.voucherDate, opts.dateFrom))
    if (opts.dateTo) conds.push(lte(schema.journalEntries.voucherDate, opts.dateTo))

    const q = this.db
      .select()
      .from(schema.journalEntries)
      .where(and(...conds))
      .orderBy(desc(schema.journalEntries.voucherDate))
    const entries = opts.limit ? q.limit(opts.limit).all() : q.all()
    if (entries.length === 0) return []

    const linesByEntry = new Map<string, Array<typeof schema.journalLines.$inferSelect>>()
    const ids = entries.map((e) => e.id)
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      const chunkLines = this.db.select().from(schema.journalLines).where(inArray(schema.journalLines.entryId, chunk)).all()
      for (const ln of chunkLines) {
        const arr = linesByEntry.get(ln.entryId) ?? []
        arr.push(ln)
        linesByEntry.set(ln.entryId, arr)
      }
    }

    return entries.map((e) => ({ ...e, lines: linesByEntry.get(e.id) ?? [] }))
  }

  updateJournalLine(lineId: string, patch: { debitAccount?: string; creditAccount?: string; amountVnd?: number; description?: string }) {
    this.db.update(schema.journalLines).set(patch).where(eq(schema.journalLines.id, lineId)).run()
  }

  listCounterparties(workspaceId: string) {
    return this.db.select().from(schema.counterparties).where(eq(schema.counterparties.workspaceId, workspaceId)).all()
  }

  async refreshCounterpartyRisk(workspaceId: string, taxCode: string) {
    const res = await lookupVietnamTaxCode(taxCode)
    const existing = this.db
      .select()
      .from(schema.counterparties)
      .where(and(eq(schema.counterparties.workspaceId, workspaceId), eq(schema.counterparties.taxCode, taxCode)))
      .get()
    if (existing) {
      this.db
        .update(schema.counterparties)
        .set({
          name: res.name || existing.name,
          shortName: res.shortName ?? existing.shortName,
          address: res.address ?? existing.address,
          status: res.status,
          lastCheckedAt: res.checkedAt
        })
        .where(eq(schema.counterparties.id, existing.id))
        .run()
    } else if (res.found) {
      this.db
        .insert(schema.counterparties)
        .values({
          id: randomUUID(),
          workspaceId,
          taxCode: res.taxCode,
          name: res.name || res.taxCode,
          shortName: res.shortName ?? null,
          address: res.address ?? null,
          status: res.status,
          lastCheckedAt: res.checkedAt
        })
        .run()
    }
    return res
  }

  async importBankStatementAndMatch(workspaceId: string, filename: string, buffer: Buffer, bankCode = "BANK") {
    const parsedRows = await parseBankStatementBuffer(filename, buffer)
    const insertedIds: string[] = []
    for (const r of parsedRows) {
      const id = randomUUID()
      this.db
        .insert(schema.bankStatements)
        .values({
          id,
          workspaceId,
          bankCode,
          txDate: r.txDate,
          refNo: r.refNo ?? null,
          description: r.description,
          debitAmount: r.debitAmount,
          creditAmount: r.creditAmount,
          balanceAmount: r.balanceAmount ?? null,
          matchStatus: "unmatched"
        })
        .run()
      insertedIds.push(id)
    }

    const txs = this.db.select().from(schema.transactions).where(eq(schema.transactions.workspaceId, workspaceId)).all()
    const matches = matchBankRowsToTransactions(
      parsedRows,
      txs.map((t) => ({
        id: t.id,
        merchant: t.merchant,
        merchantTaxCode: t.merchantTaxCode,
        invoiceNumber: t.invoiceNumber,
        direction: (t.direction as "input" | "output") || "input",
        totalAmount: t.convertedTotalVnd ?? t.totalAmount,
        issuedAt: t.issuedAt,
        paymentStatus: t.paymentStatus
      }))
    )

    for (const m of matches) {
      const stmtId = insertedIds[m.bankRowIndex]
      if (!stmtId) continue
      this.db
        .update(schema.bankStatements)
        .set({
          matchedTransactionId: m.transactionId,
          matchConfidence: m.confidence,
          matchStatus: "suggested"
        })
        .where(eq(schema.bankStatements.id, stmtId))
        .run()
    }

    return {
      importedCount: parsedRows.length,
      suggestedMatches: matches.length,
      statements: this.listBankStatements(workspaceId)
    }
  }

  listBankStatements(workspaceId: string) {
    const stmts = this.db
      .select()
      .from(schema.bankStatements)
      .where(eq(schema.bankStatements.workspaceId, workspaceId))
      .orderBy(desc(schema.bankStatements.txDate))
      .all()

    const matchedIds = [...new Set(stmts.map((s) => s.matchedTransactionId).filter((x): x is string => Boolean(x)))]
    const matchedMap = new Map<
      string,
      { id: string; merchant: string | null; invoiceNumber: string | null; issuedAt: string | null; totalAmount: number }
    >()
    for (let i = 0; i < matchedIds.length; i += 400) {
      const chunk = matchedIds.slice(i, i + 400)
      const txs = this.db
        .select({
          id: schema.transactions.id,
          merchant: schema.transactions.merchant,
          invoiceNumber: schema.transactions.invoiceNumber,
          issuedAt: schema.transactions.issuedAt,
          totalAmount: schema.transactions.totalAmount
        })
        .from(schema.transactions)
        .where(inArray(schema.transactions.id, chunk))
        .all()
      for (const t of txs) matchedMap.set(t.id, t)
    }

    return stmts.map((s) => ({
      ...s,
      matchedTransaction: s.matchedTransactionId ? matchedMap.get(s.matchedTransactionId) ?? null : null
    }))
  }

  confirmBankMatch(workspaceId: string, statementId: string, transactionId: string) {
    this.db
      .update(schema.bankStatements)
      .set({ matchedTransactionId: transactionId, matchStatus: "matched", matchConfidence: 1 })
      .where(and(eq(schema.bankStatements.id, statementId), eq(schema.bankStatements.workspaceId, workspaceId)))
      .run()
    this.db
      .update(schema.transactions)
      .set({ paymentStatus: "paid", updatedAt: new Date().toISOString() })
      .where(and(eq(schema.transactions.id, transactionId), eq(schema.transactions.workspaceId, workspaceId)))
      .run()
  }

  unmatchBankStatement(workspaceId: string, statementId: string) {
    this.db
      .update(schema.bankStatements)
      .set({ matchedTransactionId: null, matchStatus: "unmatched", matchConfidence: null })
      .where(and(eq(schema.bankStatements.id, statementId), eq(schema.bankStatements.workspaceId, workspaceId)))
      .run()
  }

  getAppData<T = Record<string, unknown>>(workspaceId: string, app: string): T {
    const row = this.db
      .select()
      .from(schema.appData)
      .where(and(eq(schema.appData.workspaceId, workspaceId), eq(schema.appData.app, app)))
      .get()
    if (!row) return {} as T
    try {
      return JSON.parse(row.dataJson) as T
    } catch {
      return {} as T
    }
  }

  saveAppData(workspaceId: string, app: string, data: unknown) {
    const dataJson = JSON.stringify(data)
    const existing = this.db
      .select()
      .from(schema.appData)
      .where(and(eq(schema.appData.workspaceId, workspaceId), eq(schema.appData.app, app)))
      .get()
    if (existing) {
      this.db.update(schema.appData).set({ dataJson }).where(eq(schema.appData.id, existing.id)).run()
    } else {
      this.db.insert(schema.appData).values({ id: randomUUID(), workspaceId, app, dataJson }).run()
    }
    return data
  }

  async syncEmailNow(
    workspaceId: string,
    serverId: string,
    decryptFn: (enc: string) => string
  ) {
    const data = this.getAppData<{ servers?: Array<{
      id: string
      host: string
      port: number
      secure: boolean
      username: string
      encryptedPassword: string
      folder?: string
      allowedExtensions?: string[]
      lastProcessedUid?: number
      lastSyncedAt?: string
      status?: string
      errorMessage?: string | null
    }> }>(workspaceId, "email")

    const servers = data.servers ?? []
    const srv = servers.find((s) => s.id === serverId)
    if (!srv) throw new Error("Không tìm thấy cấu hình máy chủ Email.")

    try {
      const password = decryptFn(srv.encryptedPassword)
      const res = await syncEmailAttachments({
        host: srv.host,
        port: srv.port,
        secure: srv.secure,
        username: srv.username,
        password,
        folder: srv.folder || "INBOX",
        lastProcessedUid: srv.lastProcessedUid ?? 0,
        allowedExtensions: srv.allowedExtensions
      })

      let imported = 0
      if (res.attachments.length > 0) {
        const ing = await this.ingestFiles(
          workspaceId,
          res.attachments.map((a) => ({ filename: a.filename, mimetype: a.mimetype, buffer: a.buffer })),
          "email"
        )
        imported = ing.createdFiles.length
      }

      srv.lastProcessedUid = res.maxUid
      srv.lastSyncedAt = new Date().toISOString()
      srv.status = "connected"
      srv.errorMessage = null
      this.saveAppData(workspaceId, "email", { servers })
      return { imported, maxUid: res.maxUid }
    } catch (err) {
      srv.status = "error"
      srv.errorMessage = err instanceof Error ? err.message : String(err)
      this.saveAppData(workspaceId, "email", { servers })
      throw err
    }
  }

  private buildExportRows(workspaceId: string, filters: TransactionFilterParams = {}): ExportInvoiceRow[] {
    const { rows } = this.listTransactions(workspaceId, { ...filters, limit: 50_000 })
    const cats = new Map(this.listCategories(workspaceId).map((c) => [c.code, c]))
    const projs = new Map(this.listProjects(workspaceId).map((p) => [p.code, p]))
    const entries = this.listJournalEntries(workspaceId)
    const entryByTx = new Map(entries.map((e) => [e.transactionId, e]))

    return rows.map((rawTx) => {
      const tx = rawTx as typeof schema.transactions.$inferSelect
      const je = entryByTx.get(tx.id)
      const firstLine = je?.lines?.[0]
      const taxLine = je?.lines?.find((l) => l.debitAccount.startsWith("133") || l.creditAccount.startsWith("3331"))
      const fileIds = JSON.parse(tx.filesJson || "[]") as string[]
      const attachments: Array<{ filename: string; buffer: Buffer }> = []
      for (const fid of fileIds) {
        const f = this.db.select().from(schema.files).where(eq(schema.files.id, fid)).get()
        if (f && this.vault.exists(f.relativePath)) {
          attachments.push({ filename: f.filename, buffer: this.vault.readFile(f.relativePath) })
        }
      }

      return {
        id: tx.id,
        direction: (tx.direction as "input" | "output") || "input",
        templateCode: tx.invoiceSymbol?.slice(0, 1) || "1",
        symbol: tx.invoiceSymbol && tx.invoiceSymbol.length > 6 ? tx.invoiceSymbol.slice(1) : tx.invoiceSymbol,
        invoiceNumber: tx.invoiceNumber,
        issuedAt: tx.issuedAt,
        merchant: tx.merchant,
        merchantTaxCode: tx.merchantTaxCode,
        name: tx.name,
        description: tx.description,
        preTaxAmount: tx.preTaxAmount,
        vatRate: tx.vatRateCode,
        vatAmount: tx.vatAmount,
        totalAmount: tx.totalAmount,
        currencyCode: tx.currencyCode,
        convertedTotalVnd: tx.convertedTotalVnd,
        categoryCode: tx.categoryCode,
        categoryName: cats.get(tx.categoryCode ?? "")?.name ?? tx.categoryCode,
        projectCode: tx.projectCode,
        projectName: projs.get(tx.projectCode ?? "")?.name ?? tx.projectCode,
        debitAccount: firstLine?.debitAccount ?? null,
        creditAccount: firstLine?.creditAccount ?? null,
        taxAccount: taxLine ? (tx.direction === "input" ? taxLine.debitAccount : taxLine.creditAccount) : null,
        note: tx.note,
        extra: tx.extraJson ? (JSON.parse(tx.extraJson) as Record<string, unknown>) : null,
        attachments
      }
    })
  }

  async exportReport(
    workspaceId: string,
    kind: "htkk_in" | "htkk_out" | "misa_in" | "misa_out" | "fast_bravo" | "csv" | "zip",
    filters: TransactionFilterParams = {}
  ) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) throw new Error("Workspace không tồn tại.")
    const rows = this.buildExportRows(workspaceId, filters)
    const period = `${filters.dateFrom ?? "all"}_${filters.dateTo ?? "now"}`

    switch (kind) {
      case "htkk_in":
        return {
          filename: `bang_ke_mua_vao_htkk_${period}.xlsx`,
          buffer: await exportHtkkExcelBuffer({ workspaceName: ws.name, workspaceTaxCode: ws.taxCode, periodLabel: period, direction: "input", rows })
        }
      case "htkk_out":
        return {
          filename: `bang_ke_ban_ra_htkk_${period}.xlsx`,
          buffer: await exportHtkkExcelBuffer({ workspaceName: ws.name, workspaceTaxCode: ws.taxCode, periodLabel: period, direction: "output", rows })
        }
      case "misa_in":
        return {
          filename: `misa_import_mua_hang_${period}.xlsx`,
          buffer: await exportMisaImportExcelBuffer({ direction: "input", rows })
        }
      case "misa_out":
        return {
          filename: `misa_import_ban_hang_${period}.xlsx`,
          buffer: await exportMisaImportExcelBuffer({ direction: "output", rows })
        }
      case "fast_bravo":
        return {
          filename: `fast_bravo_chung_tu_${period}.xlsx`,
          buffer: await exportFastBravoExcelBuffer(rows)
        }
      case "csv":
      case "zip": {
        const fieldsList = this.listFields(workspaceId).map((f) => ({ code: f.code, name: f.name, isExtra: f.isExtra }))
        return exportTransactionsCsvAndZip({
          rows,
          fields: fieldsList,
          includeAttachments: kind === "zip"
        })
      }
    }
  }

  async previewTabularImport(filename: string, buffer: Buffer) {
    return parseTabularBuffer(filename, buffer)
  }

  async commitTabularImport(
    workspaceId: string,
    headers: string[],
    rows: string[][],
    mapping: Record<string, string>,
    direction: "input" | "output" = "input"
  ) {
    const parsed = applyColumnMapping(headers, rows, mapping, direction)
    let imported = 0
    for (const r of parsed) {
      let categoryCode = "other"
      if (r.categoryName) {
        const existingCat = this.db
          .select()
          .from(schema.categories)
          .where(and(eq(schema.categories.workspaceId, workspaceId), eq(schema.categories.name, r.categoryName)))
          .get()
        if (existingCat) categoryCode = existingCat.code
        else {
          const code = r.categoryName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32) || "imported"
          this.upsertCategory(workspaceId, { code, name: r.categoryName, color: "#38BDF8" })
          categoryCode = code
        }
      }

      let projectCode = "general"
      if (r.projectName) {
        const existingProj = this.db
          .select()
          .from(schema.projects)
          .where(and(eq(schema.projects.workspaceId, workspaceId), eq(schema.projects.name, r.projectName)))
          .get()
        if (existingProj) projectCode = existingProj.code
        else {
          const code = r.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32) || "imported"
          this.upsertProject(workspaceId, { code, name: r.projectName, color: "#A78BFA" })
          projectCode = code
        }
      }

      await this.createManualTransaction(workspaceId, {
        name: r.name,
        merchant: r.merchant,
        merchantTaxCode: r.merchantTaxCode,
        direction: r.direction,
        preTaxAmount: r.preTaxAmount,
        vatAmount: r.vatAmount,
        totalAmount: r.totalAmount,
        currencyCode: r.currencyCode,
        categoryCode,
        projectCode,
        issuedAt: r.issuedAt,
        note: r.note
      })
      imported++
    }
    return { imported }
  }

  async renderOutgoingInvoice(data: OutgoingInvoiceTemplateData) {
    return renderOutgoingInvoiceHtml(data)
  }

  async exportBackup(workspaceId: string) {
    return exportWorkspaceBackupZip(this.db, this.vault, workspaceId)
  }

  async restoreBackup(zipBuffer: Buffer) {
    return restoreWorkspaceBackupZip(this.db, this.vault, zipBuffer)
  }

  createFxCacheAdapter(): FxCacheAdapter {
    return {
      get: async (from, to, rateDate) => {
        const row = this.db
          .select()
          .from(schema.fxRatesCache)
          .where(
            and(
              eq(schema.fxRatesCache.fromCode, from),
              eq(schema.fxRatesCache.toCode, to),
              eq(schema.fxRatesCache.rateDate, rateDate)
            )
          )
          .get()
        if (!row) return null
        return { rate: row.rateDecimal, source: row.source, rateDate: row.rateDate, cached: true }
      },
      set: async (from, to, rateDate, rateDecimal, source) => {
        this.db
          .insert(schema.fxRatesCache)
          .values({ fromCode: from, toCode: to, rateDate, rateDecimal, source })
          .onConflictDoNothing()
          .run()
      }
    }
  }
}
