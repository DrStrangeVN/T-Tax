import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { TransportProvider, TTaxApp, TrayPopoverApp, type TTaxTransport } from "@t-tax/ui"
import "./index.css"

interface DesktopBridge {
  getPlatform: () => Promise<"macos" | "windows" | "linux">
  setThemeSource: (mode: "dark" | "light" | "system") => Promise<void>
  windowAction: (action: "minimize" | "maximize" | "close" | "open-main") => Promise<void>
  onNativeThemeChange: (cb: (info: { shouldUseDarkColors: boolean; reduceTransparency: boolean }) => void) => () => void
  onFilesDroppedFromTray: (cb: () => void) => () => void
  rpc: <T = unknown>(method: string, ...args: unknown[]) => Promise<T>
}

declare global {
  interface Window {
    ttaxDesktop: DesktopBridge
  }
}

function buildDesktopTransport(platform: "macos" | "windows" | "linux"): TTaxTransport {
  const b = window.ttaxDesktop
  return {
    platform,
    isDesktop: true,
    setThemeSource: (m) => b.setThemeSource(m),
    windowAction: (a) => b.windowAction(a),
    onNativeThemeChange: (cb) => b.onNativeThemeChange(cb),
    onFilesDroppedFromTray: (cb) => b.onFilesDroppedFromTray(cb),

    listWorkspaces: () => b.rpc("listWorkspaces"),
    createWorkspace: (i) => b.rpc("createWorkspace", i),
    updateWorkspace: (id, p) => b.rpc("updateWorkspace", id, p),
    getSettings: (id) => b.rpc("getSettings", id),
    setSetting: (id, c, v) => b.rpc("setSetting", id, c, v),
    getLLMProviders: (id) => b.rpc("getLLMProviders", id),
    saveLLMProviders: (id, p) => b.rpc("saveLLMProviders", id, p),
    testLLMProvider: (c) => b.rpc("testLLMProvider", c),
    listCategories: (id) => b.rpc("listCategories", id),
    upsertCategory: (id, d) => b.rpc("upsertCategory", id, d),
    deleteCategory: (id, cid) => b.rpc("deleteCategory", id, cid),
    listProjects: (id) => b.rpc("listProjects", id),
    upsertProject: (id, d) => b.rpc("upsertProject", id, d),
    deleteProject: (id, pid) => b.rpc("deleteProject", id, pid),
    listFields: (id) => b.rpc("listFields", id),
    upsertField: (id, d) => b.rpc("upsertField", id, d),
    deleteField: (id, fid) => b.rpc("deleteField", id, fid),
    listCurrencies: (id) => b.rpc("listCurrencies", id),
    listAccounts: (id, reg) => b.rpc("listAccounts", id, reg),
    listLegalRules: () => b.rpc("listLegalRules"),
    ingestFiles: (id, files, src) => b.rpc("ingestFiles", id, files, src),
    listFiles: (id, unrev) => b.rpc("listFiles", id, unrev),
    readFilePreview: (id, fid) => b.rpc("readFilePreview", id, fid),
    renderXmlHtmlPreview: (id, fid) => b.rpc("renderXmlHtmlPreview", id, fid),
    analyzeFile: (id, fid) => b.rpc("analyzeFile", id, fid),
    approveFileToTransaction: (id, fid, inp) => b.rpc("approveFileToTransaction", id, fid, inp),
    splitFileItems: (id, fid, items, meta) => b.rpc("splitFileItems", id, fid, items, meta),
    deleteFile: (id, fid) => b.rpc("deleteFile", id, fid),
    batchProcessXml: (id, files, save) => b.rpc("batchProcessXml", id, files, save),
    savePdfFromHtml: (fname, html) => b.rpc("savePdfFromHtml", fname, html),
    saveBatchPdfsFromHtml: (items) => b.rpc("saveBatchPdfsFromHtml", items),
    listTransactions: (id, filters) => b.rpc("listTransactions", id, filters),
    createTransaction: (id, inp) => b.rpc("createTransaction", id, inp),
    updateTransaction: (id, tid, patch) => b.rpc("updateTransaction", id, tid, patch),
    bulkUpdateTransactions: (id, ids, patch) => b.rpc("bulkUpdateTransactions", id, ids, patch),
    deleteTransactions: (id, ids) => b.rpc("deleteTransactions", id, ids),
    getDashboardStats: (id, from, to) => b.rpc("getDashboardStats", id, from, to),
    lookupFxRate: (id, from, to, date) => b.rpc("lookupFxRate", id, from, to, date),
    listJournalEntries: (id) => b.rpc("listJournalEntries", id),
    updateJournalLine: (lid, patch) => b.rpc("updateJournalLine", lid, patch),
    listCounterparties: (id) => b.rpc("listCounterparties", id),
    refreshCounterpartyRisk: (id, mst) => b.rpc("refreshCounterpartyRisk", id, mst),
    importBankStatement: (id, fname, b64, code) => b.rpc("importBankStatement", id, fname, b64, code),
    listBankStatements: (id) => b.rpc("listBankStatements", id),
    confirmBankMatch: (id, sid, tid) => b.rpc("confirmBankMatch", id, sid, tid),
    getAppData: (id, app) => b.rpc("getAppData", id, app),
    saveAppData: (id, app, data) => b.rpc("saveAppData", id, app, data),
    saveEmailServer: (id, srv) => b.rpc("saveEmailServer", id, srv),
    syncEmailNow: (id, sid) => b.rpc("syncEmailNow", id, sid),
    fetchGdtCaptcha: () => b.rpc("fetchGdtCaptcha"),
    gdtLoginAndQuery: (p) => b.rpc("gdtLoginAndQuery", p),
    gdtDownloadAndIngest: (p) => b.rpc("gdtDownloadAndIngest", p),
    exportReport: (id, kind, filters) => b.rpc("exportReport", id, kind, filters),
    previewTabularImport: (fname, b64) => b.rpc("previewTabularImport", fname, b64),
    commitTabularImport: (id, h, r, m, d) => b.rpc("commitTabularImport", id, h, r, m, d),
    renderOutgoingInvoiceHtml: (d) => b.rpc("renderOutgoingInvoiceHtml", d),
    exportBackupZip: (id) => b.rpc("exportBackupZip", id),
    restoreBackupZip: () => b.rpc("restoreBackupZip")
  }
}

function Bootstrap() {
  const [transport, setTransport] = useState<TTaxTransport | null>(null)
  const isTray = new URLSearchParams(window.location.search).get("view") === "tray"

  useEffect(() => {
    window.ttaxDesktop.getPlatform().then((p) => {
      setTransport(buildDesktopTransport(p))
    })
  }, [])

  if (!transport) return null

  return (
    <TransportProvider transport={transport}>
      {isTray ? <TrayPopoverApp /> : <TTaxApp />}
    </TransportProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Bootstrap />)
