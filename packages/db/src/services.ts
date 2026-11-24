import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm"
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

  private assertNotLocked(lockDate: string | null | undefined, docDate: string | null | undefined) {
    if (!lockDate || !docDate) return
    const d = docDate.slice(0, 10)
    if (d <= lockDate) {
      const [y, m, day] = lockDate.split("-")
      throw new Error(`Kỳ kế toán đã khóa đến hết ngày ${day}/${m}/${y}. Mở Cài đặt -> Khóa sổ để điều chỉnh.`)
    }
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
      lockDate: string | null
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

  getSidebarBadgeCounts(workspaceId: string): {
    unreviewedCount: number
    complianceWarnings: number
    unmatchedBankCount: number
  } {
    const unrevRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt FROM files f
         WHERE f.workspace_id = ? AND f.is_reviewed = 0
         AND NOT (
           f.mimetype NOT LIKE '%xml%'
           AND EXISTS (
             SELECT 1 FROM files p
             WHERE p.workspace_id = f.workspace_id AND p.paired_file_id = f.id AND p.mimetype LIKE '%xml%'
           )
         )`
      )
      .get(workspaceId) as { cnt: number }
    const warnRow = this.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM transactions WHERE workspace_id = ? AND compliance_status IN ('warning', 'error')")
      .get(workspaceId) as { cnt: number }
    const bankRow = this.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM bank_statements WHERE workspace_id = ? AND match_status != 'matched'")
      .get(workspaceId) as { cnt: number }
    return {
      unreviewedCount: unrevRow?.cnt ?? 0,
      complianceWarnings: warnRow?.cnt ?? 0,
      unmatchedBankCount: bankRow?.cnt ?? 0
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
    const docDate = input.issuedAt ?? new Date().toISOString().slice(0, 10)
    this.assertNotLocked(ws.lockDate, docDate)

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
    const rawPreTax = Math.round(input.preTaxAmount || 0)
    const rawVat = Math.round(input.vatAmount || 0)
    const rawTotal = Math.round(input.totalAmount || rawPreTax + rawVat)
    let convertedPreTaxVnd = rawPreTax
    let convertedVatVnd = rawVat
    let convertedTotalVnd = rawTotal
    const baseCur = ws.baseCurrency || "VND"
    const txCur = (input.currencyCode || baseCur).toUpperCase()
    if (txCur !== baseCur) {
      try {
        const fx = await getHistoricalExchangeRate(
          txCur,
          baseCur,
          docDate,
          this.createFxCacheAdapter()
        )
        fxRate = fx.rate
        convertedPreTaxVnd = convertAmount(rawPreTax, fxRate, baseCur)
        convertedVatVnd = convertAmount(rawVat, fxRate, baseCur)
        convertedTotalVnd = convertAmount(rawTotal, fxRate, baseCur)
      } catch {
        // Keep fallback if offline
        convertedTotalVnd = rawTotal
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

      // Auto-post balanced VAS journal entry (always normalized to VND)
      this.postAutoJournalInTx(tx, {
        workspaceId,
        regime: ws.accountingRegime as AccountingRegime,
        transactionId: txId,
        name: input.name,
        direction: input.direction,
        categoryCode: input.categoryCode,
        paymentMethod: input.paymentMethod,
        paymentStatus: input.paymentStatus,
        preTaxAmount: convertedPreTaxVnd,
        vatAmount: convertedVatVnd,
        totalAmount: convertedTotalVnd,
        merchant: input.merchant,
        merchantTaxCode: input.merchantTaxCode,
        invoiceNumber: input.invoiceNumber,
        voucherDate: docDate
      })

      tx.update(schema.files).set({ isReviewed: true }).where(inArray(schema.files.id, fileIds)).run()
    })

    return this.db.select().from(schema.transactions).where(eq(schema.transactions.id, txId)).get()!
  }

  reopenTransactionToInbox(workspaceId: string, txId: string) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    const row = this.db
      .select()
      .from(schema.transactions)
      .where(and(eq(schema.transactions.workspaceId, workspaceId), eq(schema.transactions.id, txId)))
      .get()
    if (!row) return { restoredFileIds: [] as string[] }
    this.assertNotLocked(ws?.lockDate, row.issuedAt)

    const fileIds = (() => {
      try {
        return JSON.parse(row.filesJson || "[]") as string[]
      } catch {
        return [] as string[]
      }
    })()

    this.db.transaction((tx) => {
      tx.update(schema.bankStatements)
        .set({ matchedTransactionId: null, matchStatus: "unmatched", matchConfidence: null })
        .where(and(eq(schema.bankStatements.workspaceId, workspaceId), eq(schema.bankStatements.matchedTransactionId, txId)))
        .run()
      tx.delete(schema.einvoiceRecords)
        .where(and(eq(schema.einvoiceRecords.workspaceId, workspaceId), eq(schema.einvoiceRecords.transactionId, txId)))
        .run()
      tx.delete(schema.transactions)
        .where(and(eq(schema.transactions.workspaceId, workspaceId), eq(schema.transactions.id, txId)))
        .run()
      if (fileIds[0]) {
        tx.update(schema.files).set({ isReviewed: false }).where(eq(schema.files.id, fileIds[0])).run()
      }
    })

    return { restoredFileIds: fileIds[0] ? [fileIds[0]] : [] }
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
    if (file.pairedFileId) {
      this.db
        .update(schema.files)
        .set({ pairedFileId: null })
        .where(and(eq(schema.files.id, file.pairedFileId), eq(schema.files.workspaceId, workspaceId)))
        .run()
    }
    this.vault.deleteFile(file.relativePath)
    this.db.delete(schema.files).where(eq(schema.files.id, fileId)).run()
    return true
  }

  renderParsedXmlHtml(parsed: ParsedEInvoice, signature?: XmlSignatureVerification) {
    return renderEInvoiceHtml(parsed, signature)
  }

  async batchProcessXmlFiles(
    workspaceId: string,
    inputs: Array<{ filename: string; mimetype?: string; buffer: Buffer }>,
    saveToLedger = false
  ) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) throw new Error("Workspace không tồn tại.")

    const unpacked = await unpackIngestBuffers(inputs)
    const xmlItems = unpacked.filter((item) => item.filename.toLowerCase().endsWith(".xml"))
    const eagerHtml = xmlItems.length <= 10
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

    for (const item of xmlItems) {
      try {
        const rawXml = item.buffer.toString("utf8")
        const parsed = extractTT78Xml(rawXml)
        const sig = verifyEInvoiceXmlSignature(rawXml)
        const audit = auditParsedEInvoice(parsed, {
          existingUniqueKeys: existingKeys,
          signatureVerification: sig
        })
        const htmlPreview = eagerHtml ? await renderEInvoiceHtml(parsed, sig) : undefined

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

    const aggRow = this.db
      .select({
        cnt: sql<number>`count(*)`,
        preTaxSum: sql<number>`coalesce(sum(round(${schema.transactions.preTaxAmount} * cast(coalesce(nullif(${schema.transactions.fxRateDecimal}, ''), '1') as real))), 0)`,
        vatSum: sql<number>`coalesce(sum(round(${schema.transactions.vatAmount} * cast(coalesce(nullif(${schema.transactions.fxRateDecimal}, ''), '1') as real))), 0)`,
        totalSum: sql<number>`coalesce(sum(coalesce(${schema.transactions.convertedTotalVnd}, ${schema.transactions.totalAmount})), 0)`
      })
      .from(schema.transactions)
      .where(whereClause)
      .get()

    const total = Number(aggRow?.cnt ?? 0)
    const preTaxSum = Number(aggRow?.preTaxSum ?? 0)
    const vatSum = Number(aggRow?.vatSum ?? 0)
    const totalSum = Number(aggRow?.totalSum ?? 0)

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
    const rawPreTax = Math.round(input.preTaxAmount || 0)
    const rawVat = Math.round(input.vatAmount || 0)
    const total = Math.round(input.totalAmount || rawPreTax + rawVat)
    const issuedAt = input.issuedAt ?? new Date().toISOString().slice(0, 10)
    this.assertNotLocked(ws?.lockDate, issuedAt)

    let fxRate = input.fxRateDecimal || "1"
    let convertedPreTaxVnd = rawPreTax
    let convertedVatVnd = rawVat
    let convertedTotalVnd = total
    if (cur !== baseCur) {
      if (input.fxRateDecimal && Number(input.fxRateDecimal) > 0) {
        convertedPreTaxVnd = convertAmount(rawPreTax, input.fxRateDecimal, baseCur)
        convertedVatVnd = convertAmount(rawVat, input.fxRateDecimal, baseCur)
        convertedTotalVnd = convertAmount(total, input.fxRateDecimal, baseCur)
      } else {
        try {
          const fx = await getHistoricalExchangeRate(cur, baseCur, issuedAt, this.createFxCacheAdapter())
          fxRate = fx.rate
          convertedPreTaxVnd = convertAmount(rawPreTax, fxRate, baseCur)
          convertedVatVnd = convertAmount(rawVat, fxRate, baseCur)
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
          preTaxAmount: rawPreTax,
          vatAmount: rawVat,
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
          preTaxAmount: convertedPreTaxVnd,
          vatAmount: convertedVatVnd,
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
      const ws = tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
      const existing = tx
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.id, id), eq(schema.transactions.workspaceId, workspaceId)))
        .get()
      if (!existing) return
      this.assertNotLocked(ws?.lockDate, patch.issuedAt ?? existing.issuedAt)

      const nextPatch: Partial<typeof schema.transactions.$inferInsert> = { ...patch, updatedAt: new Date().toISOString() }
      const baseCur = ws?.baseCurrency || "VND"
      const cur = (patch.currencyCode ?? existing.currencyCode ?? baseCur).toUpperCase()
      const fx = patch.fxRateDecimal ?? existing.fxRateDecimal ?? "1"
      if (patch.totalAmount !== undefined || patch.fxRateDecimal !== undefined || patch.currencyCode !== undefined) {
        const rawTotal = patch.totalAmount ?? existing.totalAmount
        nextPatch.convertedTotalVnd = cur !== baseCur ? convertAmount(rawTotal, fx, baseCur) : rawTotal
      }

      tx.update(schema.transactions)
        .set(nextPatch)
        .where(and(eq(schema.transactions.id, id), eq(schema.transactions.workspaceId, workspaceId)))
        .run()

      const shouldRepost =
        opts.repostJournal !== false &&
        (patch.preTaxAmount !== undefined ||
          patch.vatAmount !== undefined ||
          patch.totalAmount !== undefined ||
          patch.fxRateDecimal !== undefined ||
          patch.categoryCode !== undefined ||
          patch.paymentMethod !== undefined ||
          patch.paymentStatus !== undefined ||
          patch.direction !== undefined ||
          patch.issuedAt !== undefined)

      if (shouldRepost && ws) {
        const curr = tx
          .select()
          .from(schema.transactions)
          .where(and(eq(schema.transactions.id, id), eq(schema.transactions.workspaceId, workspaceId)))
          .get()
        if (curr) {
          tx.delete(schema.journalEntries)
            .where(
              and(
                eq(schema.journalEntries.workspaceId, workspaceId),
                eq(schema.journalEntries.transactionId, id),
                eq(schema.journalEntries.postedBy, "auto_rule")
              )
            )
            .run()

          const rate = curr.fxRateDecimal || "1"
          const isFx = (curr.currencyCode || baseCur).toUpperCase() !== baseCur
          const preTaxVnd = isFx ? convertAmount(curr.preTaxAmount, rate, baseCur) : curr.preTaxAmount
          const vatVnd = isFx ? convertAmount(curr.vatAmount, rate, baseCur) : curr.vatAmount
          const totalVnd = curr.convertedTotalVnd ?? (isFx ? convertAmount(curr.totalAmount, rate, baseCur) : curr.totalAmount)

          this.postAutoJournalInTx(tx, {
            workspaceId,
            regime: ws.accountingRegime as AccountingRegime,
            transactionId: id,
            name: curr.name || "Chứng từ",
            direction: (curr.direction as TransactionDirection) || "input",
            categoryCode: curr.categoryCode,
            paymentMethod: curr.paymentMethod,
            paymentStatus: curr.paymentStatus,
            preTaxAmount: preTaxVnd,
            vatAmount: vatVnd,
            totalAmount: totalVnd,
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
    this.db.transaction((tx) => {
      const ws = tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
      const targetRows = tx
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
        .all()
      for (const r of targetRows) {
        this.assertNotLocked(ws?.lockDate, r.issuedAt)
      }

      tx.update(schema.transactions)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
        .run()

      if (ws && (patch.categoryCode !== undefined || patch.paymentStatus !== undefined)) {
        const baseCur = ws.baseCurrency || "VND"
        const updatedRows = tx
          .select()
          .from(schema.transactions)
          .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
          .all()

        tx.delete(schema.journalEntries)
          .where(
            and(
              eq(schema.journalEntries.workspaceId, workspaceId),
              inArray(schema.journalEntries.transactionId, ids),
              eq(schema.journalEntries.postedBy, "auto_rule")
            )
          )
          .run()

        for (const curr of updatedRows) {
          const rate = curr.fxRateDecimal || "1"
          const isFx = (curr.currencyCode || baseCur).toUpperCase() !== baseCur
          this.postAutoJournalInTx(tx, {
            workspaceId,
            regime: ws.accountingRegime as AccountingRegime,
            transactionId: curr.id,
            name: curr.name || "Chứng từ",
            direction: (curr.direction as TransactionDirection) || "input",
            categoryCode: curr.categoryCode,
            paymentMethod: curr.paymentMethod,
            paymentStatus: curr.paymentStatus,
            preTaxAmount: isFx ? convertAmount(curr.preTaxAmount, rate, baseCur) : curr.preTaxAmount,
            vatAmount: isFx ? convertAmount(curr.vatAmount, rate, baseCur) : curr.vatAmount,
            totalAmount: curr.convertedTotalVnd ?? curr.totalAmount,
            merchant: curr.merchant,
            merchantTaxCode: curr.merchantTaxCode,
            invoiceNumber: curr.invoiceNumber,
            voucherDate: curr.issuedAt ?? new Date().toISOString().slice(0, 10)
          })
        }
      }
    })
    return ids.length
  }

  deleteTransactions(workspaceId: string, ids: string[], opts: { restoreFilesToInbox?: boolean } = {}) {
    if (!ids.length) return 0
    this.db.transaction((tx) => {
      const ws = tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
      const rows = tx
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
        .all()
      for (const r of rows) {
        this.assertNotLocked(ws?.lockDate, r.issuedAt)
      }

      // Reset linked bank statements back to unmatched instead of leaving orphaned status='matched'
      tx.update(schema.bankStatements)
        .set({ matchedTransactionId: null, matchStatus: "unmatched", matchConfidence: null })
        .where(and(eq(schema.bankStatements.workspaceId, workspaceId), inArray(schema.bankStatements.matchedTransactionId, ids)))
        .run()

      // Clear einvoice_records so deleted XML invoices can be cleanly re-ingested/re-approved without false duplicate block
      tx.delete(schema.einvoiceRecords)
        .where(and(eq(schema.einvoiceRecords.workspaceId, workspaceId), inArray(schema.einvoiceRecords.transactionId, ids)))
        .run()

      // Optionally return primary files back to inbox when deleting accidental approvals
      if (opts.restoreFilesToInbox !== false) {
        const primaryFileIds: string[] = []
        for (const r of rows) {
          try {
            const arr = JSON.parse(r.filesJson || "[]") as string[]
            if (arr[0]) primaryFileIds.push(arr[0])
          } catch {
            // ignore
          }
        }
        if (primaryFileIds.length > 0) {
          tx.update(schema.files)
            .set({ isReviewed: false })
            .where(and(eq(schema.files.workspaceId, workspaceId), inArray(schema.files.id, primaryFileIds)))
            .run()
        }
      }

      tx.delete(schema.transactions)
        .where(and(eq(schema.transactions.workspaceId, workspaceId), inArray(schema.transactions.id, ids)))
        .run()
    })
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
          COALESCE(SUM(CASE WHEN direction = 'output' THEN ROUND(vat_amount * CAST(COALESCE(NULLIF(fx_rate_decimal, ''), '1') AS REAL)) ELSE 0 END), 0) AS out_vat,
          COALESCE(SUM(CASE WHEN direction != 'output' THEN ROUND(vat_amount * CAST(COALESCE(NULLIF(fx_rate_decimal, ''), '1') AS REAL)) ELSE 0 END), 0) AS in_vat,
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
          COALESCE(SUM(CASE WHEN direction = 'output' THEN ROUND(vat_amount * CAST(COALESCE(NULLIF(fx_rate_decimal, ''), '1') AS REAL)) ELSE 0 END), 0) AS vatOut,
          COALESCE(SUM(CASE WHEN direction != 'output' THEN ROUND(vat_amount * CAST(COALESCE(NULLIF(fx_rate_decimal, ''), '1') AS REAL)) ELSE 0 END), 0) AS vatIn
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
    const row = this.sqlite
      .prepare(
        `SELECT je.workspace_id AS workspaceId, je.voucher_date AS voucherDate, w.lock_date AS lockDate
         FROM journal_lines jl
         JOIN journal_entries je ON jl.entry_id = je.id
         JOIN workspaces w ON je.workspace_id = w.id
         WHERE jl.id = ?`
      )
      .get(lineId) as { workspaceId: string; voucherDate: string; lockDate: string | null } | undefined
    if (row) this.assertNotLocked(row.lockDate, row.voucherDate)
    this.db.update(schema.journalLines).set(patch).where(eq(schema.journalLines.id, lineId)).run()
  }

  createManualJournalEntry(
    workspaceId: string,
    input: {
      voucherNo?: string
      voucherDate: string
      description: string
      lines: Array<{ debitAccount: string; creditAccount: string; amountVnd: number; description?: string }>
    }
  ) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) throw new Error("Workspace không tồn tại.")
    this.assertNotLocked(ws.lockDate, input.voucherDate)
    if (!input.lines.length) throw new Error("Cần ít nhất 1 dòng định khoản.")

    const jeId = randomUUID()
    const voucherNo = (input.voucherNo?.trim() || `PKT-${jeId.slice(0, 6).toUpperCase()}`).slice(0, 32)
    this.db.transaction((tx) => {
      tx.insert(schema.journalEntries)
        .values({
          id: jeId,
          workspaceId,
          transactionId: null,
          voucherNo,
          voucherDate: input.voucherDate,
          description: input.description.trim() || "Phiếu kế toán thủ công",
          status: "posted",
          postedBy: "manual"
        })
        .run()
      for (const ln of input.lines) {
        const amt = Math.max(0, Math.round(Number(ln.amountVnd) || 0))
        if (!ln.debitAccount || !ln.creditAccount || amt <= 0) {
          throw new Error("Tài khoản Nợ, Tài khoản Có và Số tiền > 0 là bắt buộc.")
        }
        tx.insert(schema.journalLines)
          .values({
            id: randomUUID(),
            entryId: jeId,
            debitAccount: ln.debitAccount.trim(),
            creditAccount: ln.creditAccount.trim(),
            amountVnd: amt,
            description: ln.description ?? input.description
          })
          .run()
      }
    })
    return { id: jeId, voucherNo }
  }

  postVatClosingEntry(workspaceId: string, input: { dateFrom?: string; dateTo?: string; voucherDate: string }) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) throw new Error("Workspace không tồn tại.")
    this.assertNotLocked(ws.lockDate, input.voucherDate)

    const conds = ["je.workspace_id = ?"]
    const params: unknown[] = [workspaceId]
    if (input.dateFrom) {
      conds.push("je.voucher_date >= ?")
      params.push(input.dateFrom)
    }
    if (input.dateTo) {
      conds.push("je.voucher_date <= ?")
      params.push(input.dateTo)
    }
    const whereSql = conds.join(" AND ")

    const vatRow = this.sqlite
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN jl.debit_account = '1331' THEN jl.amount_vnd ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN jl.credit_account = '1331' THEN jl.amount_vnd ELSE 0 END), 0) AS inVatNet,
          COALESCE(SUM(CASE WHEN jl.credit_account = '33311' THEN jl.amount_vnd ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN jl.debit_account = '33311' THEN jl.amount_vnd ELSE 0 END), 0) AS outVatNet
        FROM journal_lines jl
        JOIN journal_entries je ON jl.entry_id = je.id
        WHERE ${whereSql}`
      )
      .get(...params) as { inVatNet: number; outVatNet: number }

    const deductible = Math.max(0, Math.min(Number(vatRow?.inVatNet ?? 0), Number(vatRow?.outVatNet ?? 0)))
    if (deductible <= 0) {
      return { posted: false, amountVnd: 0, message: "Không có số dư thuế GTGT đủ điều kiện khấu trừ kết chuyển trong kỳ." }
    }

    const res = this.createManualJournalEntry(workspaceId, {
      voucherNo: `KC-VAT-${input.voucherDate.slice(0, 7).replace("-", "")}`,
      voucherDate: input.voucherDate,
      description: `Kết chuyển khấu trừ thuế GTGT kỳ đến ${input.voucherDate}`,
      lines: [
        {
          debitAccount: "33311",
          creditAccount: "1331",
          amountVnd: deductible,
          description: "Khấu trừ thuế GTGT đầu vào sang đầu ra"
        }
      ]
    })
    return { posted: true, amountVnd: deductible, entryId: res.id, voucherNo: res.voucherNo }
  }

  getTrialBalance(workspaceId: string, opts: { dateFrom?: string; dateTo?: string } = {}) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
    if (!ws) return []
    const accounts = this.listAccounts(workspaceId, ws.accountingRegime as AccountingRegime)
    const accMap = new Map(
      accounts.map((a) => [
        a.code,
        {
          code: a.code,
          name: a.name,
          nature: a.nature,
          openingDebit: 0,
          openingCredit: 0,
          periodDebit: 0,
          periodCredit: 0,
          closingDebit: 0,
          closingCredit: 0
        }
      ])
    )

    const getOrCreate = (code: string) => {
      let row = accMap.get(code)
      if (!row) {
        row = {
          code,
          name: `Tài khoản ${code}`,
          nature: "dual",
          openingDebit: 0,
          openingCredit: 0,
          periodDebit: 0,
          periodCredit: 0,
          closingDebit: 0,
          closingCredit: 0
        }
        accMap.set(code, row)
      }
      return row
    }

    const rows = this.sqlite
      .prepare(
        `SELECT je.voucher_date AS voucherDate, jl.debit_account AS debitAccount, jl.credit_account AS creditAccount, jl.amount_vnd AS amountVnd
         FROM journal_lines jl
         JOIN journal_entries je ON jl.entry_id = je.id
         WHERE je.workspace_id = ?`
      )
      .all(workspaceId) as Array<{ voucherDate: string; debitAccount: string; creditAccount: string; amountVnd: number }>

    for (const r of rows) {
      if (opts.dateTo && r.voucherDate > opts.dateTo) continue
      const amt = Number(r.amountVnd ?? 0)
      const isOpening = Boolean(opts.dateFrom && r.voucherDate < opts.dateFrom)
      const dr = getOrCreate(r.debitAccount)
      const cr = getOrCreate(r.creditAccount)
      if (isOpening) {
        dr.openingDebit += amt
        cr.openingCredit += amt
      } else {
        dr.periodDebit += amt
        cr.periodCredit += amt
      }
    }

    const out = []
    for (const row of accMap.values()) {
      const openNet = row.openingDebit - row.openingCredit
      row.openingDebit = openNet > 0 ? openNet : 0
      row.openingCredit = openNet < 0 ? Math.abs(openNet) : 0

      const closeNet = openNet + row.periodDebit - row.periodCredit
      row.closingDebit = closeNet > 0 ? closeNet : 0
      row.closingCredit = closeNet < 0 ? Math.abs(closeNet) : 0

      if (row.openingDebit || row.openingCredit || row.periodDebit || row.periodCredit || row.closingDebit || row.closingCredit) {
        out.push(row)
      }
    }
    return out.sort((a, b) => a.code.localeCompare(b.code))
  }

  listCounterparties(workspaceId: string) {
    const cps = this.db.select().from(schema.counterparties).where(eq(schema.counterparties.workspaceId, workspaceId)).all()
    const stats = this.sqlite
      .prepare(
        `SELECT merchant_tax_code AS taxCode, COUNT(*) AS txCount, COALESCE(SUM(COALESCE(converted_total_vnd, total_amount)), 0) AS totalAmountVnd
         FROM transactions WHERE workspace_id = ? AND merchant_tax_code IS NOT NULL AND merchant_tax_code != ''
         GROUP BY merchant_tax_code`
      )
      .all(workspaceId) as Array<{ taxCode: string; txCount: number; totalAmountVnd: number }>
    const statMap = new Map(stats.map((s) => [s.taxCode, s]))
    return cps.map((cp) => {
      const s = statMap.get(cp.taxCode)
      return {
        ...cp,
        txCount: Number(s?.txCount ?? 0),
        totalAmountVnd: Number(s?.totalAmountVnd ?? 0)
      }
    })
  }

  updateCounterparty(
    workspaceId: string,
    id: string,
    patch: { defaultCategoryCode?: string | null; defaultAccountCode?: string | null; riskNotes?: string | null }
  ) {
    this.db
      .update(schema.counterparties)
      .set(patch)
      .where(and(eq(schema.counterparties.id, id), eq(schema.counterparties.workspaceId, workspaceId)))
      .run()
    return this.listCounterparties(workspaceId)
  }

  async batchRefreshCounterparties(workspaceId: string) {
    const cps = this.db
      .select()
      .from(schema.counterparties)
      .where(and(eq(schema.counterparties.workspaceId, workspaceId), eq(schema.counterparties.status, "unknown")))
      .all()
    let updated = 0
    for (const cp of cps.slice(0, 20)) {
      const res = await this.refreshCounterpartyRisk(workspaceId, cp.taxCode).catch(() => null)
      if (res?.found) updated++
    }
    return { checked: Math.min(cps.length, 20), updated }
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

  async quickPostBankStatement(
    workspaceId: string,
    statementId: string,
    input: { kind: "bank_fee" | "interest" | "custom"; name?: string; categoryCode?: string }
  ) {
    const stmt = this.db
      .select()
      .from(schema.bankStatements)
      .where(and(eq(schema.bankStatements.id, statementId), eq(schema.bankStatements.workspaceId, workspaceId)))
      .get()
    if (!stmt) throw new Error("Không tìm thấy dòng sao kê.")

    const isDebit = stmt.debitAmount > 0
    const amt = Math.max(stmt.debitAmount, stmt.creditAmount)
    const defaultName =
      input.name?.trim() ||
      (input.kind === "bank_fee"
        ? `Phí dịch vụ ngân hàng ${stmt.bankCode}`
        : input.kind === "interest"
          ? `Lãi tiền gửi ngân hàng ${stmt.bankCode}`
          : stmt.description.slice(0, 80))
    const categoryCode =
      input.categoryCode || (input.kind === "bank_fee" ? "fees" : input.kind === "interest" ? "other" : "other")

    const tx = await this.createManualTransaction(workspaceId, {
      name: defaultName,
      merchant: `Ngân hàng ${stmt.bankCode}`,
      direction: isDebit ? "input" : "output",
      preTaxAmount: amt,
      vatAmount: 0,
      totalAmount: amt,
      categoryCode,
      issuedAt: stmt.txDate,
      paymentMethod: "Chuyển khoản",
      paymentStatus: "paid",
      note: stmt.description
    })

    // For interest income, re-map credit revenue to 515 (Doanh thu tài chính) under enterprise regimes
    if (input.kind === "interest") {
      const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
      if (ws && ws.accountingRegime !== "HKD_2026") {
        const entry = this.db
          .select()
          .from(schema.journalEntries)
          .where(and(eq(schema.journalEntries.workspaceId, workspaceId), eq(schema.journalEntries.transactionId, tx.id)))
          .get()
        if (entry) {
          this.db.update(schema.journalLines).set({ creditAccount: "515" }).where(eq(schema.journalLines.entryId, entry.id)).run()
        }
      }
    }

    this.confirmBankMatch(workspaceId, statementId, tx.id)
    return tx
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
