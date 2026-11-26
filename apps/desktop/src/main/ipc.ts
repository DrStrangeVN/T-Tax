import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron"
import { randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  authenticateGdtSession,
  discoverLocalOllamaModels,
  downloadGdtInvoiceXmlZip,
  fetchGdtCaptcha,
  getHistoricalExchangeRate,
  queryGdtInvoices,
  safeAsciiFilename,
  testProviderVisionSupport,
  type AccountingRegime,
  type GdtInvoiceSummary,
  type LLMProviderConfig,
  type LineItemDTO,
  type OutgoingInvoiceTemplateData,
  type ParsedEInvoice,
  type TransactionDirection,
  type XmlSignatureVerification
} from "@t-tax/core"
import type { TTaxService } from "@t-tax/db"
import {
  buildCopilotExternalMcpTools,
  callExternalMcpTool,
  invokeBuiltInMcpTool,
  testExternalMcpServer,
  TTAX_MCP_PROMPTS_CATALOG,
  TTAX_MCP_RESOURCES_CATALOG,
  TTAX_MCP_TOOL_CATALOG,
  TTAX_MCP_VERSION,
  type TTaxLocalMcpHttpHost
} from "@t-tax/mcp"
import type { SecretVault } from "./secrets.js"

async function renderHtmlListToPdfBuffers(htmlList: string[]): Promise<Buffer[]> {
  const win = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: { offscreen: true, sandbox: true }
  })
  const tmpDir = mkdtempSync(join(tmpdir(), "ttax-pdf-"))
  try {
    const out: Buffer[] = []
    for (let i = 0; i < htmlList.length; i++) {
      const htmlPath = join(tmpDir, `doc_${i}.html`)
      writeFileSync(htmlPath, htmlList[i]!, "utf8")
      await win.loadFile(htmlPath)
      const pdfBuf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
      })
      out.push(Buffer.from(pdfBuf))
    }
    return out
  } finally {
    if (!win.isDestroyed()) win.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function renderHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const [buf] = await renderHtmlListToPdfBuffers([html])
  return buf!
}

let batchCancelled = false

export function registerIpcHandlers(params: {
  service: TTaxService
  secrets: SecretVault
  mcpHost: TTaxLocalMcpHttpHost
  getMainWindow: () => BrowserWindow | null
  onCountsChanged: () => void
  onWorkspaceChanged?: (workspaceId: string) => void
  onBeforeDbRestore?: () => void
  onAfterDbRestore?: () => void
}) {
  const { service, secrets, mcpHost } = params

  const getDecryptedProviders = (workspaceId: string): LLMProviderConfig[] => {
    const data = service.getAppData<{ providers?: LLMProviderConfig[] }>(workspaceId, "llm_providers")
    return (data.providers ?? []).map((p) => ({
      ...p,
      apiKey: p.apiKey ? secrets.decrypt(p.apiKey) : ""
    }))
  }

  ipcMain.handle("ttax:platform", () => {
    if (process.platform === "darwin") return "macos"
    if (process.platform === "win32") return "windows"
    return "linux"
  })

  ipcMain.handle("ttax:set-theme-source", (_ev, mode: "dark" | "light" | "system") => {
    nativeTheme.themeSource = mode
  })

  ipcMain.handle("ttax:window-action", (_ev, action: "minimize" | "maximize" | "close" | "open-main") => {
    const win = params.getMainWindow()
    if (!win) return
    if (action === "minimize") win.minimize()
    else if (action === "maximize") {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === "close") win.close()
    else if (action === "open-main") {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  ipcMain.handle("ttax:rpc", async (_ev, method: string, args: unknown[] = []) => {
    switch (method) {
      case "listWorkspaces":
        service.ensureWorkspace()
        return service.listWorkspaces()
      case "setActiveWorkspace":
        params.onWorkspaceChanged?.(String(args[0] || ""))
        return
      case "createWorkspace":
        return service.createWorkspace(args[0] as Parameters<TTaxService["createWorkspace"]>[0])
      case "updateWorkspace":
        return service.updateWorkspace(args[0] as string, args[1] as Record<string, unknown>)

      case "getSettings":
        return service.getSettings(args[0] as string)
      case "setSetting":
        return service.setSetting(args[0] as string, args[1] as string, args[2] as string)
      case "getLLMProviders":
        return getDecryptedProviders(args[0] as string)
      case "saveLLMProviders": {
        const wsId = args[0] as string
        const list = args[1] as LLMProviderConfig[]
        const encrypted = list.map((p) => ({
          ...p,
          apiKey: p.apiKey ? secrets.encrypt(p.apiKey) : ""
        }))
        service.saveAppData(wsId, "llm_providers", { providers: encrypted })
        return
      }
      case "testLLMProvider":
        return testProviderVisionSupport(args[0] as LLMProviderConfig)
      case "discoverOllamaModels":
        return discoverLocalOllamaModels(args[0] as string | undefined)

      case "listCategories":
        return service.listCategories(args[0] as string)
      case "upsertCategory":
        return service.upsertCategory(args[0] as string, args[1] as never)
      case "deleteCategory":
        return service.deleteCategory(args[0] as string, args[1] as string)
      case "listProjects":
        return service.listProjects(args[0] as string)
      case "upsertProject":
        return service.upsertProject(args[0] as string, args[1] as never)
      case "deleteProject":
        return service.deleteProject(args[0] as string, args[1] as string)
      case "listFields":
        return service.listFields(args[0] as string)
      case "upsertField":
        return service.upsertField(args[0] as string, args[1] as never)
      case "deleteField":
        return service.deleteField(args[0] as string, args[1] as string)
      case "listCurrencies":
        return service.listCurrencies(args[0] as string)
      case "listAccounts":
        return service.listAccounts(args[0] as string, args[1] as AccountingRegime | undefined)
      case "listLegalRules":
        return service.listLegalRules()

      case "ingestFiles": {
        const wsId = args[0] as string
        const rawFiles = args[1] as Array<{ filename: string; mimetype?: string; base64: string }>
        const src = (args[2] as "upload" | "drop" | "email" | "gdt" | "tray") || "upload"
        const res = await service.ingestFiles(
          wsId,
          rawFiles.map((f) => ({ filename: f.filename, mimetype: f.mimetype, buffer: Buffer.from(f.base64, "base64") })),
          src
        )
        params.onCountsChanged()
        return res
      }
      case "ingestFilePaths": {
        const wsId = args[0] as string
        const paths = args[1] as string[]
        const src = (args[2] as "upload" | "drop" | "email" | "gdt" | "tray") || "upload"
        const inputs = await Promise.all(paths.map(async (fp) => ({ filename: basename(fp), buffer: await readFile(fp) })))
        const res = await service.ingestFiles(wsId, inputs, src)
        params.onCountsChanged()
        return res
      }
      case "listFiles":
        return service.listFiles(args[0] as string, { unreviewedOnly: Boolean(args[1]) })
      case "readFilePreview":
        return service.readFilePreviewData(args[0] as string, args[1] as string)
      case "renderXmlHtmlPreview":
        return service.renderXmlHtmlPreview(args[0] as string, args[1] as string)
      case "analyzeFile": {
        const wsId = args[0] as string
        const fileId = args[1] as string
        const providers = getDecryptedProviders(wsId)
        return service.analyzeFile(wsId, fileId, providers)
      }
      case "analyzeFilesBatch": {
        const wsId = args[0] as string
        const fileIds = args[1] as string[]
        const providers = getDecryptedProviders(wsId)
        batchCancelled = false
        return service.analyzeFilesBatch(
          wsId,
          fileIds,
          providers,
          (ev) => {
            const win = params.getMainWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send("ttax:batch-progress", ev)
            }
          },
          () => batchCancelled
        )
      }
      case "cancelBatchAnalyze": {
        batchCancelled = true
        return { ok: true }
      }
      case "batchApproveCleanXml": {
        const res = await service.batchApproveCleanXml(args[0] as string, args[1] as string[])
        params.onCountsChanged()
        return res
      }
      case "approveFileToTransaction": {
        const res = await service.approveFileToTransaction(args[0] as string, args[1] as string, args[2] as never)
        params.onCountsChanged()
        return res
      }
      case "splitFileItems": {
        const res = await service.splitFileItemsToTransactions(
          args[0] as string,
          args[1] as string,
          args[2] as LineItemDTO[],
          args[3] as never
        )
        params.onCountsChanged()
        return res
      }
      case "deleteFile": {
        const ok = service.deleteFile(args[0] as string, args[1] as string, args[2] as never)
        params.onCountsChanged()
        return ok
      }
      case "revealFileInFolder": {
        const info = service.getVaultFilePath(args[0] as string, args[1] as string)
        shell.showItemInFolder(info.absPath)
        return true
      }

      case "batchProcessXml": {
        const wsId = args[0] as string
        const rawFiles = args[1] as Array<{ filename: string; mimetype?: string; base64: string }>
        const save = Boolean(args[2])
        const res = await service.batchProcessXmlFiles(
          wsId,
          rawFiles.map((f) => ({ filename: f.filename, mimetype: f.mimetype, buffer: Buffer.from(f.base64, "base64") })),
          save
        )
        if (save) params.onCountsChanged()
        return res
      }
      case "batchProcessXmlSession": {
        const wsId = args[0] as string
        const rawFiles = args[1] as Array<{ filename: string; mimetype?: string; base64: string }>
        return service.batchProcessXmlSession(
          wsId,
          rawFiles.map((f) => ({ filename: f.filename, mimetype: f.mimetype, buffer: Buffer.from(f.base64, "base64") }))
        )
      }
      case "commitBatchXmlSession": {
        const res = await service.commitBatchXmlSession(args[0] as string, args[1] as string, args[2] as number[] | undefined)
        params.onCountsChanged()
        return res
      }
      case "renderParsedXmlHtml":
        return service.renderParsedXmlHtml(args[0] as ParsedEInvoice, args[1] as XmlSignatureVerification | undefined)
      case "savePdfFromHtml": {
        const defaultName = safeAsciiFilename(String(args[0] || "invoice.pdf"))
        const html = String(args[1] || "")
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), defaultName),
          filters: [{ name: "PDF Document", extensions: ["pdf"] }]
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        const buf = await renderHtmlToPdfBuffer(html)
        await writeFile(saveRes.filePath, buf)
        return { savedPath: saveRes.filePath }
      }
      case "saveBatchPdfsFromHtml": {
        const items = args[0] as Array<{ filename: string; html: string }>
        const folderRes = await dialog.showOpenDialog({
          title: "Chọn thư mục lưu các tệp PDF",
          properties: ["openDirectory", "createDirectory"]
        })
        if (folderRes.canceled || !folderRes.filePaths[0]) return { count: 0, canceled: true }
        const outDir = folderRes.filePaths[0]
        mkdirSync(outDir, { recursive: true })
        const bufs = await renderHtmlListToPdfBuffers(items.map((i) => i.html))
        await Promise.all(
          items.map(async (item, idx) => {
            const b = bufs[idx]
            if (b) await writeFile(join(outDir, safeAsciiFilename(item.filename)), b)
          })
        )
        return { folderPath: outDir, count: items.length }
      }

      case "listTransactions":
        return service.listTransactions(args[0] as string, args[1] as never)
      case "getTransactionDetail":
        return service.getTransactionDetail(args[0] as string, args[1] as string)
      case "createTransaction": {
        const tx = await service.createManualTransaction(args[0] as string, args[1] as never)
        params.onCountsChanged()
        return tx
      }
      case "updateTransaction": {
        const tx = service.updateTransaction(args[0] as string, args[1] as string, args[2] as never, {
          repostJournal: args[3] !== false
        })
        params.onCountsChanged()
        return tx
      }
      case "bulkUpdateTransactions": {
        const n = service.bulkUpdateTransactions(args[0] as string, args[1] as string[], args[2] as never)
        params.onCountsChanged()
        return n
      }
      case "deleteTransactions": {
        const n = service.deleteTransactions(args[0] as string, args[1] as string[], args[2] as never)
        params.onCountsChanged()
        return n
      }
      case "reopenTransactionToInbox": {
        const res = service.reopenTransactionToInbox(args[0] as string, args[1] as string)
        params.onCountsChanged()
        return res
      }
      case "getDashboardStats":
        return service.getDashboardStats(args[0] as string, args[1] as string | undefined, args[2] as string | undefined)
      case "getSidebarBadgeCounts":
        return service.getSidebarBadgeCounts(args[0] as string)
      case "searchGlobal":
        return service.searchGlobal(args[0] as string, args[1] as string)
      case "lookupFxRate":
        return getHistoricalExchangeRate(
          args[1] as string,
          args[2] as string,
          args[3] as string,
          service.createFxCacheAdapter()
        )

      case "listJournalEntries":
        return service.listJournalEntries(args[0] as string, args[1] as never)
      case "updateJournalLine":
        service.updateJournalLine(args[0] as string, args[1] as never)
        return
      case "createManualJournalEntry":
        return service.createManualJournalEntry(args[0] as string, args[1] as never)
      case "postVatClosingEntry":
        return service.postVatClosingEntry(args[0] as string, args[1] as never)
      case "getTrialBalance":
        return service.getTrialBalance(args[0] as string, args[1] as never)
      case "listOpeningBalances":
        return service.listOpeningBalances(args[0] as string)
      case "saveOpeningBalances":
        return service.saveOpeningBalances(args[0] as string, args[1] as never)
      case "getAccountLedger":
        return service.getAccountLedger(args[0] as string, args[1] as string, args[2] as never)
      case "listCounterparties":
        return service.listCounterparties(args[0] as string)
      case "updateCounterparty":
        return service.updateCounterparty(args[0] as string, args[1] as string, args[2] as never)
      case "batchRefreshCounterparties":
        return service.batchRefreshCounterparties(args[0] as string)
      case "refreshCounterpartyRisk":
        return service.refreshCounterpartyRisk(args[0] as string, args[1] as string)
      case "importBankStatement": {
        const res = await service.importBankStatementAndMatch(
          args[0] as string,
          args[1] as string,
          Buffer.from(args[2] as string, "base64"),
          args[3] as string
        )
        params.onCountsChanged()
        return res
      }
      case "listBankStatements":
        return service.listBankStatements(args[0] as string)
      case "addBankMatch":
        service.addBankMatch(args[0] as string, args[1] as string, args[2] as string, args[3] as number | undefined)
        params.onCountsChanged()
        return
      case "removeBankMatch":
        service.removeBankMatch(args[0] as string, args[1] as string, args[2] as string | undefined)
        params.onCountsChanged()
        return
      case "confirmBankMatch":
        service.confirmBankMatch(args[0] as string, args[1] as string, args[2] as string)
        params.onCountsChanged()
        return
      case "unmatchBankStatement":
        service.unmatchBankStatement(args[0] as string, args[1] as string)
        params.onCountsChanged()
        return
      case "quickPostBankStatement": {
        const tx = await service.quickPostBankStatement(args[0] as string, args[1] as string, args[2] as never)
        params.onCountsChanged()
        return tx
      }

      case "getAppData":
        return service.getAppData(args[0] as string, args[1] as string)
      case "saveAppData":
        return service.saveAppData(args[0] as string, args[1] as string, args[2])
      case "saveEmailServer": {
        const wsId = args[0] as string
        const form = args[1] as {
          name: string
          provider: string
          host: string
          port: number
          secure: boolean
          username: string
          password: string
          folder: string
        }
        const curr = service.getAppData<{ servers?: Array<Record<string, unknown>> }>(wsId, "email")
        const servers = curr.servers ?? []
        servers.push({
          id: randomUUID(),
          name: form.name,
          provider: form.provider,
          host: form.host,
          port: form.port,
          secure: form.secure,
          username: form.username,
          encryptedPassword: secrets.encrypt(form.password),
          folder: form.folder || "INBOX",
          allowedExtensions: [".xml", ".pdf", ".zip", ".png", ".jpg", ".jpeg", ".webp"],
          lastProcessedUid: 0,
          status: "idle",
          isActive: true
        })
        return service.saveAppData(wsId, "email", { servers })
      }
      case "syncEmailNow": {
        const res = await service.syncEmailNow(args[0] as string, args[1] as string, (enc) => secrets.decrypt(enc))
        params.onCountsChanged()
        return res
      }

      case "fetchGdtCaptcha":
        return fetchGdtCaptcha()
      case "gdtLoginAndQuery": {
        const p = args[0] as {
          username: string
          password: string
          captchaKey: string
          captchaValue: string
          direction: TransactionDirection
          fromDateDmy: string
          toDateDmy: string
        }
        const { token } = await authenticateGdtSession({
          username: p.username,
          password: p.password,
          captchaKey: p.captchaKey,
          captchaValue: p.captchaValue
        })
        const invoices = await queryGdtInvoices({
          token,
          direction: p.direction,
          fromDateDmy: p.fromDateDmy,
          toDateDmy: p.toDateDmy
        })
        return { token, invoices }
      }
      case "gdtDownloadAndIngest": {
        const p = args[0] as { workspaceId: string; token: string; invoices: GdtInvoiceSummary[] }
        let imported = 0
        for (const inv of p.invoices.slice(0, 40)) {
          try {
            const zipBuf = await downloadGdtInvoiceXmlZip({
              token: p.token,
              nbmst: inv.nbmst,
              khhdon: inv.khhdon,
              shdon: inv.shdon,
              khmshdon: inv.khmshdon
            })
            const ing = await service.ingestFiles(
              p.workspaceId,
              [{ filename: `${inv.nbmst}_${inv.khhdon}_${inv.shdon}.zip`, mimetype: "application/zip", buffer: zipBuf }],
              "gdt"
            )
            imported += ing.createdFiles.length
          } catch {
            // Skip individual failed download without aborting batch
          }
        }
        params.onCountsChanged()
        return { imported }
      }

      case "exportReport": {
        const wsId = args[0] as string
        const kind = args[1] as "htkk_in" | "htkk_out" | "misa_in" | "misa_out" | "fast_bravo" | "csv" | "zip"
        const filters = args[2] as Record<string, unknown> | undefined
        const res = await service.exportReport(wsId, kind, filters as never)
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), safeAsciiFilename(res.filename))
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        writeFileSync(saveRes.filePath, res.buffer)
        return { savedPath: saveRes.filePath }
      }
      case "exportAccountLedgerExcel": {
        const res = await service.exportAccountLedgerExcel(args[0] as string, args[1] as string, args[2] as never)
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), safeAsciiFilename(res.filename))
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        await writeFile(saveRes.filePath, res.buffer)
        return { savedPath: saveRes.filePath }
      }
      case "exportHkdBookExcel": {
        const res = await service.exportHkdBookExcel(args[0] as string, args[1] as never, args[2] as never)
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), safeAsciiFilename(res.filename))
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        await writeFile(saveRes.filePath, res.buffer)
        return { savedPath: saveRes.filePath }
      }
      case "exportBatchXmlExcel": {
        const res = await service.exportBatchXmlExcel(args[0] as never)
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), safeAsciiFilename(res.filename))
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        await writeFile(saveRes.filePath, res.buffer)
        return { savedPath: saveRes.filePath }
      }
      case "previewTabularImport":
        return service.previewTabularImport(args[0] as string, Buffer.from(args[1] as string, "base64"))
      case "commitTabularImport": {
        const res = service.commitTabularImport(
          args[0] as string,
          args[1] as string[],
          args[2] as string[][],
          args[3] as Record<string, string>,
          args[4] as TransactionDirection
        )
        params.onCountsChanged()
        return res
      }
      case "renderOutgoingInvoiceHtml":
        return service.renderOutgoingInvoice(args[0] as OutgoingInvoiceTemplateData)

      case "exportBackupZip": {
        const buf = await service.exportBackup(args[0] as string)
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), `t_tax_backup_${new Date().toISOString().slice(0, 10)}.zip`),
          filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        writeFileSync(saveRes.filePath, buf)
        return { savedPath: saveRes.filePath }
      }
      case "restoreBackupZip": {
        const openRes = await dialog.showOpenDialog({
          title: "Chọn tệp sao lưu T-Tax (.zip)",
          filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
          properties: ["openFile"]
        })
        if (openRes.canceled || !openRes.filePaths[0]) return { canceled: true }
        const zipBuf = await readFile(openRes.filePaths[0])
        const res = await service.restoreBackup(zipBuf)
        params.onCountsChanged()
        return res
      }

      // Round 4: AI Copilot, Tax Audit, Cashflow Forecast, AR/AP Aging, Fixed Assets, Smart Rules & MCP Hub
      case "runTaxAudit":
        return service.runTaxAudit(args[0] as string)
      case "getCashflowAnalytics":
        return service.getCashflowAnalytics(args[0] as string, args[1] as number | undefined)
      case "getArApAging":
        return service.getArApAging(args[0] as string, args[1] as string | undefined)
      case "exportArApAgingExcel": {
        const res = await service.exportArApAgingExcel(args[0] as string, args[1] as string | undefined)
        const saveRes = await dialog.showSaveDialog({
          defaultPath: join(app.getPath("downloads"), safeAsciiFilename(res.filename))
        })
        if (saveRes.canceled || !saveRes.filePath) return { canceled: true }
        await writeFile(saveRes.filePath, res.buffer)
        return { savedPath: saveRes.filePath }
      }
      case "listSmartRules":
        return service.listSmartRules(args[0] as string)
      case "upsertSmartRule":
        return service.upsertSmartRule(args[0] as string, args[1] as never)
      case "deleteSmartRule":
        return service.deleteSmartRule(args[0] as string, args[1] as string)
      case "proposeSmartRules":
        return service.proposeSmartRules(args[0] as string)
      case "applySmartRulesToLedger": {
        const res = service.applySmartRulesToLedger(args[0] as string)
        params.onCountsChanged()
        return res
      }
      case "listFixedAssets":
        return service.listFixedAssets(args[0] as string)
      case "createFixedAsset":
        return service.createFixedAsset(args[0] as string, args[1] as never)
      case "deleteFixedAsset":
        return service.deleteFixedAsset(args[0] as string, args[1] as string)
      case "runMonthlyDepreciation": {
        const res = service.runMonthlyDepreciation(args[0] as string, args[1] as string)
        params.onCountsChanged()
        return res
      }
      case "listAiSessions":
        return service.listAiSessions(args[0] as string)
      case "listAiMessages":
        return service.listAiMessages(args[0] as string)
      case "deleteAiSession":
        return service.deleteAiSession(args[0] as string, args[1] as string)
      case "chatWithCopilot": {
        const wsId = args[0] as string
        const payload = args[1] as { sessionId?: string; prompt: string }
        const providers = getDecryptedProviders(wsId)
        const externalServers = service.listExternalMcpServers(wsId)
        const externalMcpTools = buildCopilotExternalMcpTools(externalServers)
        return service.chatWithCopilot(wsId, {
          sessionId: payload.sessionId,
          prompt: payload.prompt,
          providers,
          externalMcpTools
        })
      }
      case "getMcpCatalog":
        return {
          version: TTAX_MCP_VERSION,
          tools: TTAX_MCP_TOOL_CATALOG,
          resources: TTAX_MCP_RESOURCES_CATALOG,
          prompts: TTAX_MCP_PROMPTS_CATALOG,
          stdioCliHint: `TTAX_DATA_DIR="${app.getPath("userData")}" npx t-tax-mcp`
        }
      case "getMcpHostStatus":
        return mcpHost.getStatus()
      case "startMcpHost":
        return mcpHost.start(args[0] as number | undefined)
      case "stopMcpHost":
        return mcpHost.stop()
      case "rotateMcpToken": {
        const token = mcpHost.rotateToken()
        const ws = service.ensureWorkspace()
        service.saveAppData(ws.id, "mcp_host", { bearerToken: token })
        if (mcpHost.getStatus().running) {
          const port = mcpHost.getStatus().port
          await mcpHost.stop()
          return mcpHost.start(port)
        }
        return mcpHost.getStatus()
      }
      case "invokeBuiltInMcpTool":
        return invokeBuiltInMcpTool(
          service,
          args[0] as string,
          args[1] as string,
          (args[2] as Record<string, unknown>) ?? {}
        )
      case "listExternalMcpServers":
        return service.listExternalMcpServers(args[0] as string)
      case "saveExternalMcpServer":
        return service.saveExternalMcpServer(args[0] as string, args[1] as never)
      case "deleteExternalMcpServer":
        return service.deleteExternalMcpServer(args[0] as string, args[1] as string)
      case "testExternalMcpServer": {
        const wsId = args[0] as string
        const cfg = args[1] as Parameters<typeof testExternalMcpServer>[0]
        const res = await testExternalMcpServer(cfg)
        if (cfg.id) {
          service.saveExternalMcpServer(wsId, {
            ...cfg,
            cachedTools: res.ok ? res.tools : cfg.cachedTools,
            lastConnectedAt: res.ok ? new Date().toISOString() : cfg.lastConnectedAt,
            lastError: res.ok ? undefined : res.message
          })
        }
        return res
      }
      case "callExternalMcpTool":
        return callExternalMcpTool(args[0] as never, args[1] as string, (args[2] as Record<string, unknown>) ?? {})

      default:
        throw new Error(`Unknown IPC method: ${method}`)
    }
  })
}
