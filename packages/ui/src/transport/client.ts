import React, { createContext, useContext } from "react"
import type {
  AccountingRegime,
  AuditIssue,
  BatchAnalyzeProgressEvent,
  DocumentAnalysisOutcome,
  GdtCaptchaChallenge,
  GdtInvoiceSummary,
  LLMProviderConfig,
  LineItemDTO,
  OutgoingInvoiceTemplateData,
  ParsedEInvoice,
  TransactionDirection,
  WorkspaceBadgeCounts,
  WorkspaceDTO,
  XmlSignatureVerification
} from "@t-tax/core"

export interface IngestFilePayload {
  filename: string
  mimetype?: string
  base64: string
}

export interface BatchXmlResultItem {
  filename: string
  status: "valid" | "warning" | "error"
  parsed?: ParsedEInvoice
  signature?: XmlSignatureVerification
  issues: AuditIssue[]
  htmlPreview?: string
  error?: string
  savedTransactionId?: string
}

export interface TTaxTransport {
  platform: "macos" | "windows" | "linux" | "web"
  isDesktop: boolean
  setThemeSource?: (mode: "dark" | "light" | "system") => Promise<void>
  windowAction?: (action: "minimize" | "maximize" | "close" | "open-main") => Promise<void>
  onNativeThemeChange?: (cb: (info: { shouldUseDarkColors: boolean; reduceTransparency: boolean }) => void) => () => void
  onFilesDroppedFromTray?: (cb: () => void) => () => void
  onBatchAnalyzeProgress?: (cb: (ev: BatchAnalyzeProgressEvent) => void) => () => void
  onMenuCommand?: (cb: (cmd: string) => void) => () => void
  getNativeFilePaths?: (files: File[]) => string[]
  ingestFilePaths?: (
    workspaceId: string,
    filePaths: string[],
    source?: "upload" | "drop" | "email" | "gdt" | "tray"
  ) => Promise<{ createdFiles: Array<Record<string, unknown>>; skippedDuplicates: string[] }>

  // Workspaces
  listWorkspaces: () => Promise<WorkspaceDTO[]>
  createWorkspace: (input: {
    name: string
    taxCode: string
    entityType: "enterprise" | "household" | "freelancer"
    accountingRegime: AccountingRegime
    address?: string
  }) => Promise<WorkspaceDTO>
  updateWorkspace: (workspaceId: string, patch: Record<string, unknown>) => Promise<WorkspaceDTO>

  // Settings & Secrets
  getSettings: (workspaceId: string) => Promise<Record<string, string>>
  setSetting: (workspaceId: string, code: string, value: string) => Promise<Record<string, string>>
  getLLMProviders: (workspaceId: string) => Promise<LLMProviderConfig[]>
  saveLLMProviders: (workspaceId: string, providers: LLMProviderConfig[]) => Promise<void>
  testLLMProvider: (config: LLMProviderConfig) => Promise<{ success: boolean; supportsVision: boolean; message: string }>

  // Metadata
  listCategories: (workspaceId: string) => Promise<Array<Record<string, unknown>>>
  upsertCategory: (workspaceId: string, data: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  deleteCategory: (workspaceId: string, id: string) => Promise<Array<Record<string, unknown>>>
  listProjects: (workspaceId: string) => Promise<Array<Record<string, unknown>>>
  upsertProject: (workspaceId: string, data: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  deleteProject: (workspaceId: string, id: string) => Promise<Array<Record<string, unknown>>>
  listFields: (workspaceId: string) => Promise<Array<Record<string, unknown>>>
  upsertField: (workspaceId: string, data: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  deleteField: (workspaceId: string, id: string) => Promise<Array<Record<string, unknown>>>
  listCurrencies: (workspaceId: string) => Promise<Array<Record<string, unknown>>>
  listAccounts: (workspaceId: string, regime?: AccountingRegime) => Promise<Array<Record<string, unknown>>>
  listLegalRules: () => Promise<Array<Record<string, unknown>>>

  // Files & AI Unsorted
  ingestFiles: (
    workspaceId: string,
    files: IngestFilePayload[],
    source?: "upload" | "drop" | "email" | "gdt" | "tray"
  ) => Promise<{ createdFiles: Array<Record<string, unknown>>; skippedDuplicates: string[] }>
  listFiles: (workspaceId: string, unreviewedOnly?: boolean) => Promise<Array<Record<string, unknown>>>
  readFilePreview: (workspaceId: string, fileId: string) => Promise<{
    file: Record<string, unknown>
    base64?: string
    parsedEInvoice?: ParsedEInvoice
    signatureVerification?: XmlSignatureVerification
  }>
  renderXmlHtmlPreview: (workspaceId: string, fileId: string) => Promise<string>
  analyzeFile: (workspaceId: string, fileId: string) => Promise<DocumentAnalysisOutcome>
  analyzeFilesBatch: (workspaceId: string, fileIds: string[]) => Promise<{ jobId: string; done: number; total: number; cancelled: boolean }>
  cancelBatchAnalyze: () => Promise<void>
  batchApproveCleanXml: (workspaceId: string, fileIds: string[]) => Promise<{ approved: number; skipped: number }>
  approveFileToTransaction: (workspaceId: string, fileId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>
  splitFileItems: (workspaceId: string, fileId: string, items: LineItemDTO[], baseMeta: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  deleteFile: (workspaceId: string, fileId: string) => Promise<boolean>

  // Batch Converter
  batchProcessXml: (workspaceId: string, files: IngestFilePayload[], saveToLedger: boolean) => Promise<BatchXmlResultItem[]>
  savePdfFromHtml: (defaultFilename: string, html: string) => Promise<{ savedPath?: string; canceled?: boolean }>
  saveBatchPdfsFromHtml: (items: Array<{ filename: string; html: string }>) => Promise<{ folderPath?: string; count: number; canceled?: boolean }>

  // Transactions & Dashboard
  listTransactions: (workspaceId: string, filters?: Record<string, unknown>) => Promise<{
    rows: Array<Record<string, unknown>>
    total: number
    summary?: { preTaxSum: number; vatSum: number; totalSum: number }
  }>
  getTransactionDetail: (workspaceId: string, id: string) => Promise<Record<string, unknown> | null>
  createTransaction: (workspaceId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>
  updateTransaction: (workspaceId: string, id: string, patch: Record<string, unknown>, repostJournal?: boolean) => Promise<Record<string, unknown>>
  bulkUpdateTransactions: (workspaceId: string, ids: string[], patch: Record<string, unknown>) => Promise<number>
  deleteTransactions: (workspaceId: string, ids: string[]) => Promise<number>
  getDashboardStats: (workspaceId: string, dateFrom?: string, dateTo?: string) => Promise<Record<string, unknown>>
  getSidebarBadgeCounts: (workspaceId: string) => Promise<WorkspaceBadgeCounts>
  searchGlobal: (workspaceId: string, query: string) => Promise<{
    transactions: Array<Record<string, unknown>>
    counterparties: Array<Record<string, unknown>>
  }>
  lookupFxRate: (workspaceId: string, from: string, to: string, date: string) => Promise<{ rate: string; source: string; rateDate: string; cached: boolean }>

  // Accounting, Counterparties & Bank
  listJournalEntries: (workspaceId: string, opts?: { dateFrom?: string; dateTo?: string; limit?: number }) => Promise<Array<Record<string, unknown>>>
  updateJournalLine: (lineId: string, patch: Record<string, unknown>) => Promise<void>
  listCounterparties: (workspaceId: string) => Promise<Array<Record<string, unknown>>>
  refreshCounterpartyRisk: (workspaceId: string, taxCode: string) => Promise<Record<string, unknown>>
  importBankStatement: (workspaceId: string, filename: string, base64: string, bankCode: string) => Promise<Record<string, unknown>>
  listBankStatements: (workspaceId: string) => Promise<Array<Record<string, unknown>>>
  confirmBankMatch: (workspaceId: string, statementId: string, transactionId: string) => Promise<void>
  unmatchBankStatement: (workspaceId: string, statementId: string) => Promise<void>

  // Mini-Apps & Import/Export/Backup
  getAppData: (workspaceId: string, app: string) => Promise<Record<string, unknown>>
  saveAppData: (workspaceId: string, app: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>
  saveEmailServer: (workspaceId: string, serverInput: Record<string, unknown>) => Promise<Record<string, unknown>>
  syncEmailNow: (workspaceId: string, serverId: string) => Promise<{ imported: number; maxUid: number }>
  fetchGdtCaptcha: () => Promise<GdtCaptchaChallenge>
  gdtLoginAndQuery: (params: {
    username: string
    password: string
    captchaKey: string
    captchaValue: string
    direction: TransactionDirection
    fromDateDmy: string
    toDateDmy: string
  }) => Promise<{ token: string; invoices: GdtInvoiceSummary[] }>
  gdtDownloadAndIngest: (params: {
    workspaceId: string
    token: string
    invoices: GdtInvoiceSummary[]
  }) => Promise<{ imported: number }>
  exportReport: (
    workspaceId: string,
    kind: "htkk_in" | "htkk_out" | "misa_in" | "misa_out" | "fast_bravo" | "csv" | "zip",
    filters?: Record<string, unknown>
  ) => Promise<{ savedPath?: string; canceled?: boolean }>
  previewTabularImport: (filename: string, base64: string) => Promise<{ headers: string[]; rows: string[][]; suggestedMapping: Record<string, string> }>
  commitTabularImport: (
    workspaceId: string,
    headers: string[],
    rows: string[][],
    mapping: Record<string, string>,
    direction: TransactionDirection
  ) => Promise<{ imported: number }>
  renderOutgoingInvoiceHtml: (data: OutgoingInvoiceTemplateData) => Promise<string>
  exportBackupZip: (workspaceId: string) => Promise<{ savedPath?: string; canceled?: boolean }>
  restoreBackupZip: () => Promise<{ workspaceId: string; restoredTransactions: number; restoredFiles: number } | { canceled: true }>
}

const TransportContext = createContext<TTaxTransport | null>(null)

export function TransportProvider({ transport, children }: { transport: TTaxTransport; children: React.ReactNode }) {
  return React.createElement(TransportContext.Provider, { value: transport }, children)
}

export function useTransport(): TTaxTransport {
  const ctx = useContext(TransportContext)
  if (!ctx) throw new Error("useTransport must be used inside TransportProvider")
  return ctx
}

export async function smartIngestFileList(
  transport: TTaxTransport,
  workspaceId: string,
  fileList: FileList | File[],
  source: "upload" | "drop" | "email" | "gdt" | "tray" = "upload"
) {
  const arr = Array.from(fileList)
  const paths = transport.getNativeFilePaths?.(arr) ?? []
  if (transport.ingestFilePaths && paths.length === arr.length && paths.every((p) => Boolean(p))) {
    return transport.ingestFilePaths(workspaceId, paths, source)
  }
  const payloads = await Promise.all(arr.map(fileToPayload))
  return transport.ingestFiles(workspaceId, payloads, source)
}

export async function fileToPayload(file: File): Promise<IngestFilePayload> {
  const buf = await file.arrayBuffer()
  let binary = ""
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return {
    filename: file.name,
    mimetype: file.type || "application/octet-stream",
    base64: btoa(binary)
  }
}

export function createHttpTransport(baseUrl = "/api"): TTaxTransport {
  const post = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {})
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(errText || `HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  const downloadFile = async (path: string, body: unknown, fallbackName: string) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(await res.text())
    const blob = await res.blob()
    const disp = res.headers.get("Content-Disposition") || ""
    const match = disp.match(/filename="?([^"]+)"?/)
    const filename = match?.[1] || fallbackName
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    return { savedPath: filename }
  }

  return {
    platform: "web",
    isDesktop: false,
    listWorkspaces: () => post("/rpc", { method: "listWorkspaces" }),
    createWorkspace: (input) => post("/rpc", { method: "createWorkspace", args: [input] }),
    updateWorkspace: (wsId, patch) => post("/rpc", { method: "updateWorkspace", args: [wsId, patch] }),
    getSettings: (wsId) => post("/rpc", { method: "getSettings", args: [wsId] }),
    setSetting: (wsId, code, value) => post("/rpc", { method: "setSetting", args: [wsId, code, value] }),
    getLLMProviders: (wsId) => post("/rpc", { method: "getLLMProviders", args: [wsId] }),
    saveLLMProviders: (wsId, providers) => post("/rpc", { method: "saveLLMProviders", args: [wsId, providers] }),
    testLLMProvider: (config) => post("/rpc", { method: "testLLMProvider", args: [config] }),
    listCategories: (wsId) => post("/rpc", { method: "listCategories", args: [wsId] }),
    upsertCategory: (wsId, d) => post("/rpc", { method: "upsertCategory", args: [wsId, d] }),
    deleteCategory: (wsId, id) => post("/rpc", { method: "deleteCategory", args: [wsId, id] }),
    listProjects: (wsId) => post("/rpc", { method: "listProjects", args: [wsId] }),
    upsertProject: (wsId, d) => post("/rpc", { method: "upsertProject", args: [wsId, d] }),
    deleteProject: (wsId, id) => post("/rpc", { method: "deleteProject", args: [wsId, id] }),
    listFields: (wsId) => post("/rpc", { method: "listFields", args: [wsId] }),
    upsertField: (wsId, d) => post("/rpc", { method: "upsertField", args: [wsId, d] }),
    deleteField: (wsId, id) => post("/rpc", { method: "deleteField", args: [wsId, id] }),
    listCurrencies: (wsId) => post("/rpc", { method: "listCurrencies", args: [wsId] }),
    listAccounts: (wsId, reg) => post("/rpc", { method: "listAccounts", args: [wsId, reg] }),
    listLegalRules: () => post("/rpc", { method: "listLegalRules", args: [] }),
    ingestFiles: (wsId, files, source) => post("/rpc", { method: "ingestFiles", args: [wsId, files, source] }),
    listFiles: (wsId, unreviewedOnly) => post("/rpc", { method: "listFiles", args: [wsId, unreviewedOnly] }),
    readFilePreview: (wsId, fileId) => post("/rpc", { method: "readFilePreview", args: [wsId, fileId] }),
    renderXmlHtmlPreview: (wsId, fileId) => post("/rpc", { method: "renderXmlHtmlPreview", args: [wsId, fileId] }),
    analyzeFile: (wsId, fileId) => post("/rpc", { method: "analyzeFile", args: [wsId, fileId] }),
    analyzeFilesBatch: (wsId, fileIds) => post("/rpc", { method: "analyzeFilesBatch", args: [wsId, fileIds] }),
    cancelBatchAnalyze: async () => {
      await post("/rpc", { method: "cancelBatchAnalyze", args: [] })
    },
    batchApproveCleanXml: (wsId, fileIds) => post("/rpc", { method: "batchApproveCleanXml", args: [wsId, fileIds] }),
    approveFileToTransaction: (wsId, fileId, input) => post("/rpc", { method: "approveFileToTransaction", args: [wsId, fileId, input] }),
    splitFileItems: (wsId, fileId, items, meta) => post("/rpc", { method: "splitFileItems", args: [wsId, fileId, items, meta] }),
    deleteFile: (wsId, fileId) => post("/rpc", { method: "deleteFile", args: [wsId, fileId] }),
    batchProcessXml: (wsId, files, save) => post("/rpc", { method: "batchProcessXml", args: [wsId, files, save] }),
    savePdfFromHtml: async (filename, html) => {
      const w = window.open("", "_blank")
      if (w) {
        w.document.write(html)
        w.document.close()
        w.print()
      }
      return { savedPath: filename }
    },
    saveBatchPdfsFromHtml: async (items) => {
      if (!items.length) return { count: 0, canceled: true }
      const combinedBodies = items
        .map((it) => {
          const match = it.html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
          return `<div class="t-print-page">${match ? match[1] : it.html}</div>`
        })
        .join("")
      const styleMatch = items[0]?.html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)
      const w = window.open("", "_blank")
      if (w) {
        w.document.write(
          `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><style>${styleMatch?.[1] ?? ""}\n.t-print-page{page-break-after:always;margin-bottom:24px}.t-print-page:last-child{page-break-after:auto}</style></head><body>${combinedBodies}</body></html>`
        )
        w.document.close()
        w.print()
      }
      return { folderPath: "Trình duyệt In PDF", count: items.length }
    },
    listTransactions: (wsId, filters) => post("/rpc", { method: "listTransactions", args: [wsId, filters] }),
    getTransactionDetail: (wsId, id) => post("/rpc", { method: "getTransactionDetail", args: [wsId, id] }),
    createTransaction: (wsId, input) => post("/rpc", { method: "createTransaction", args: [wsId, input] }),
    updateTransaction: (wsId, id, patch, repost) => post("/rpc", { method: "updateTransaction", args: [wsId, id, patch, repost] }),
    bulkUpdateTransactions: (wsId, ids, patch) => post("/rpc", { method: "bulkUpdateTransactions", args: [wsId, ids, patch] }),
    deleteTransactions: (wsId, ids) => post("/rpc", { method: "deleteTransactions", args: [wsId, ids] }),
    getDashboardStats: (wsId, from, to) => post("/rpc", { method: "getDashboardStats", args: [wsId, from, to] }),
    getSidebarBadgeCounts: (wsId) => post("/rpc", { method: "getSidebarBadgeCounts", args: [wsId] }),
    searchGlobal: (wsId, q) => post("/rpc", { method: "searchGlobal", args: [wsId, q] }),
    lookupFxRate: (wsId, from, to, date) => post("/rpc", { method: "lookupFxRate", args: [wsId, from, to, date] }),
    listJournalEntries: (wsId, opts) => post("/rpc", { method: "listJournalEntries", args: [wsId, opts] }),
    updateJournalLine: (id, patch) => post("/rpc", { method: "updateJournalLine", args: [id, patch] }),
    listCounterparties: (wsId) => post("/rpc", { method: "listCounterparties", args: [wsId] }),
    refreshCounterpartyRisk: (wsId, mst) => post("/rpc", { method: "refreshCounterpartyRisk", args: [wsId, mst] }),
    importBankStatement: (wsId, fname, b64, code) => post("/rpc", { method: "importBankStatement", args: [wsId, fname, b64, code] }),
    listBankStatements: (wsId) => post("/rpc", { method: "listBankStatements", args: [wsId] }),
    confirmBankMatch: (wsId, sid, tid) => post("/rpc", { method: "confirmBankMatch", args: [wsId, sid, tid] }),
    unmatchBankStatement: (wsId, sid) => post("/rpc", { method: "unmatchBankStatement", args: [wsId, sid] }),
    getAppData: (wsId, app) => post("/rpc", { method: "getAppData", args: [wsId, app] }),
    saveAppData: (wsId, app, d) => post("/rpc", { method: "saveAppData", args: [wsId, app, d] }),
    saveEmailServer: (wsId, srv) => post("/rpc", { method: "saveEmailServer", args: [wsId, srv] }),
    syncEmailNow: (wsId, srvId) => post("/rpc", { method: "syncEmailNow", args: [wsId, srvId] }),
    fetchGdtCaptcha: () => post("/rpc", { method: "fetchGdtCaptcha", args: [] }),
    gdtLoginAndQuery: (p) => post("/rpc", { method: "gdtLoginAndQuery", args: [p] }),
    gdtDownloadAndIngest: (p) => post("/rpc", { method: "gdtDownloadAndIngest", args: [p] }),
    exportReport: (wsId, kind, filters) => downloadFile("/export", { workspaceId: wsId, kind, filters }, `t_tax_${kind}.xlsx`),
    previewTabularImport: (fname, b64) => post("/rpc", { method: "previewTabularImport", args: [fname, b64] }),
    commitTabularImport: (wsId, h, r, m, dir) => post("/rpc", { method: "commitTabularImport", args: [wsId, h, r, m, dir] }),
    renderOutgoingInvoiceHtml: (d) => post("/rpc", { method: "renderOutgoingInvoiceHtml", args: [d] }),
    exportBackupZip: (wsId) => downloadFile("/backup/export", { workspaceId: wsId }, "t_tax_backup.zip"),
    restoreBackupZip: async () =>
      new Promise((resolve, reject) => {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = ".zip,application/zip"
        input.addEventListener("cancel", () => resolve({ canceled: true }))
        input.addEventListener("change", async () => {
          const file = input.files?.[0]
          if (!file) {
            resolve({ canceled: true })
            return
          }
          try {
            const payload = await fileToPayload(file)
            const res = await post<{ workspaceId: string; restoredTransactions: number; restoredFiles: number }>(
              "/backup/restore",
              { base64: payload.base64 }
            )
            resolve(res)
          } catch (err) {
            reject(err)
          }
        })
        input.click()
      })
  }
}
