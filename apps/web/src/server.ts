import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  authenticateGdtSession,
  downloadGdtInvoiceXmlZip,
  fetchGdtCaptcha,
  getHistoricalExchangeRate,
  queryGdtInvoices,
  testProviderVisionSupport,
  type AccountingRegime,
  type GdtInvoiceSummary,
  type LLMProviderConfig,
  type LineItemDTO,
  type OutgoingInvoiceTemplateData,
  type TransactionDirection
} from "@t-tax/core"
import { openTTaxDatabase, TTaxService, VaultStorage } from "@t-tax/db"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.TTAX_DATA_DIR || join(process.cwd(), "data")
const PORT = Number(process.env.PORT || 7331)

mkdirSync(DATA_DIR, { recursive: true })
const conn = openTTaxDatabase(join(DATA_DIR, "ttax.db"))
const vault = new VaultStorage(join(DATA_DIR, "vault"))
const service = new TTaxService(conn.db, conn.sqlite, vault)
service.ensureWorkspace()

function getEncryptionKey(): Buffer {
  const secretFile = join(DATA_DIR, ".ttax_secret")
  let raw = process.env.TTAX_SECRET
  if (!raw) {
    if (existsSync(secretFile)) {
      raw = readFileSync(secretFile, "utf8").trim()
    } else {
      raw = randomBytes(32).toString("hex")
      writeFileSync(secretFile, raw, { mode: 0o600 })
    }
  }
  return scryptSync(raw, "t-tax-web-secret", 32)
}

const KEY = getEncryptionKey()
function encryptStr(plain: string): string {
  if (!plain) return ""
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", KEY, iv)
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`
}
function decryptStr(stored: string): string {
  if (!stored || !stored.startsWith("v1:")) return stored
  const [, ivB64, tagB64, dataB64] = stored.split(":")
  if (!ivB64 || !tagB64 || !dataB64) return ""
  const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"))
  d.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]).toString("utf8")
}

const app = new Hono()

app.get("/api/health", (c) => c.json({ ok: true, service: "t-tax-web" }))

app.post("/api/rpc", async (c) => {
  try {
    const body = (await c.req.json()) as { method: string; args?: unknown[] }
    const args = body.args ?? []
    switch (body.method) {
      case "listWorkspaces":
        return c.json(service.listWorkspaces())
      case "createWorkspace":
        return c.json(service.createWorkspace(args[0] as never))
      case "updateWorkspace":
        return c.json(service.updateWorkspace(args[0] as string, args[1] as never))
      case "getSettings":
        return c.json(service.getSettings(args[0] as string))
      case "setSetting":
        return c.json(service.setSetting(args[0] as string, args[1] as string, args[2] as string))
      case "getLLMProviders": {
        const data = service.getAppData<{ providers?: LLMProviderConfig[] }>(args[0] as string, "llm_providers")
        return c.json((data.providers ?? []).map((p) => ({ ...p, apiKey: decryptStr(p.apiKey) })))
      }
      case "saveLLMProviders": {
        const list = (args[1] as LLMProviderConfig[]).map((p) => ({ ...p, apiKey: encryptStr(p.apiKey) }))
        service.saveAppData(args[0] as string, "llm_providers", { providers: list })
        return c.json({ ok: true })
      }
      case "testLLMProvider":
        return c.json(await testProviderVisionSupport(args[0] as LLMProviderConfig))
      case "listCategories":
        return c.json(service.listCategories(args[0] as string))
      case "upsertCategory":
        return c.json(service.upsertCategory(args[0] as string, args[1] as never))
      case "deleteCategory":
        return c.json(service.deleteCategory(args[0] as string, args[1] as string))
      case "listProjects":
        return c.json(service.listProjects(args[0] as string))
      case "upsertProject":
        return c.json(service.upsertProject(args[0] as string, args[1] as never))
      case "deleteProject":
        return c.json(service.deleteProject(args[0] as string, args[1] as string))
      case "listFields":
        return c.json(service.listFields(args[0] as string))
      case "upsertField":
        return c.json(service.upsertField(args[0] as string, args[1] as never))
      case "deleteField":
        return c.json(service.deleteField(args[0] as string, args[1] as string))
      case "listCurrencies":
        return c.json(service.listCurrencies(args[0] as string))
      case "listAccounts":
        return c.json(service.listAccounts(args[0] as string, args[1] as AccountingRegime | undefined))
      case "listLegalRules":
        return c.json(service.listLegalRules())
      case "ingestFiles": {
        const raw = args[1] as Array<{ filename: string; mimetype?: string; base64: string }>
        return c.json(
          await service.ingestFiles(
            args[0] as string,
            raw.map((f) => ({ filename: f.filename, mimetype: f.mimetype, buffer: Buffer.from(f.base64, "base64") })),
            (args[2] as "upload") || "upload"
          )
        )
      }
      case "listFiles":
        return c.json(service.listFiles(args[0] as string, { unreviewedOnly: Boolean(args[1]) }))
      case "readFilePreview":
        return c.json(service.readFilePreviewData(args[0] as string, args[1] as string))
      case "renderXmlHtmlPreview":
        return c.json(await service.renderXmlHtmlPreview(args[0] as string, args[1] as string))
      case "analyzeFile": {
        const data = service.getAppData<{ providers?: LLMProviderConfig[] }>(args[0] as string, "llm_providers")
        const providers = (data.providers ?? []).map((p) => ({ ...p, apiKey: decryptStr(p.apiKey) }))
        return c.json(await service.analyzeFile(args[0] as string, args[1] as string, providers))
      }
      case "approveFileToTransaction":
        return c.json(await service.approveFileToTransaction(args[0] as string, args[1] as string, args[2] as never))
      case "splitFileItems":
        return c.json(await service.splitFileItemsToTransactions(args[0] as string, args[1] as string, args[2] as LineItemDTO[], args[3] as never))
      case "deleteFile":
        return c.json(service.deleteFile(args[0] as string, args[1] as string))
      case "batchProcessXml": {
        const raw = args[1] as Array<{ filename: string; mimetype?: string; base64: string }>
        return c.json(
          await service.batchProcessXmlFiles(
            args[0] as string,
            raw.map((f) => ({ filename: f.filename, mimetype: f.mimetype, buffer: Buffer.from(f.base64, "base64") })),
            Boolean(args[2])
          )
        )
      }
      case "listTransactions":
        return c.json(service.listTransactions(args[0] as string, args[1] as never))
      case "createTransaction":
        return c.json(service.createManualTransaction(args[0] as string, args[1] as never))
      case "updateTransaction":
        return c.json(service.updateTransaction(args[0] as string, args[1] as string, args[2] as never))
      case "bulkUpdateTransactions":
        return c.json(service.bulkUpdateTransactions(args[0] as string, args[1] as string[], args[2] as never))
      case "deleteTransactions":
        return c.json(service.deleteTransactions(args[0] as string, args[1] as string[]))
      case "getDashboardStats":
        return c.json(service.getDashboardStats(args[0] as string, args[1] as string | undefined, args[2] as string | undefined))
      case "lookupFxRate":
        return c.json(await getHistoricalExchangeRate(args[1] as string, args[2] as string, args[3] as string, service.createFxCacheAdapter()))
      case "listJournalEntries":
        return c.json(service.listJournalEntries(args[0] as string))
      case "updateJournalLine":
        service.updateJournalLine(args[0] as string, args[1] as never)
        return c.json({ ok: true })
      case "listCounterparties":
        return c.json(service.listCounterparties(args[0] as string))
      case "refreshCounterpartyRisk":
        return c.json(await service.refreshCounterpartyRisk(args[0] as string, args[1] as string))
      case "importBankStatement":
        return c.json(await service.importBankStatementAndMatch(args[0] as string, args[1] as string, Buffer.from(args[2] as string, "base64"), args[3] as string))
      case "listBankStatements":
        return c.json(service.listBankStatements(args[0] as string))
      case "confirmBankMatch":
        service.confirmBankMatch(args[0] as string, args[1] as string, args[2] as string)
        return c.json({ ok: true })
      case "getAppData":
        return c.json(service.getAppData(args[0] as string, args[1] as string))
      case "saveAppData":
        return c.json(service.saveAppData(args[0] as string, args[1] as string, args[2]))
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
          encryptedPassword: encryptStr(form.password),
          folder: form.folder || "INBOX",
          allowedExtensions: [".xml", ".pdf", ".zip", ".png", ".jpg", ".jpeg", ".webp"],
          lastProcessedUid: 0,
          status: "idle",
          isActive: true
        })
        return c.json(service.saveAppData(wsId, "email", { servers }))
      }
      case "syncEmailNow":
        return c.json(await service.syncEmailNow(args[0] as string, args[1] as string, decryptStr))
      case "fetchGdtCaptcha":
        return c.json(await fetchGdtCaptcha())
      case "gdtLoginAndQuery": {
        const p = args[0] as { username: string; password: string; captchaKey: string; captchaValue: string; direction: TransactionDirection; fromDateDmy: string; toDateDmy: string }
        const { token } = await authenticateGdtSession(p)
        const invoices = await queryGdtInvoices({ token, direction: p.direction, fromDateDmy: p.fromDateDmy, toDateDmy: p.toDateDmy })
        return c.json({ token, invoices })
      }
      case "gdtDownloadAndIngest": {
        const p = args[0] as { workspaceId: string; token: string; invoices: GdtInvoiceSummary[] }
        let imported = 0
        for (const inv of p.invoices.slice(0, 40)) {
          const zipBuf = await downloadGdtInvoiceXmlZip({ token: p.token, nbmst: inv.nbmst, khhdon: inv.khhdon, shdon: inv.shdon, khmshdon: inv.khmshdon })
          const res = await service.ingestFiles(p.workspaceId, [{ filename: `${inv.nbmst}_${inv.shdon}.zip`, mimetype: "application/zip", buffer: zipBuf }], "gdt")
          imported += res.createdFiles.length
        }
        return c.json({ imported })
      }
      case "previewTabularImport":
        return c.json(await service.previewTabularImport(args[0] as string, Buffer.from(args[1] as string, "base64")))
      case "commitTabularImport":
        return c.json(service.commitTabularImport(args[0] as string, args[1] as string[], args[2] as string[][], args[3] as Record<string, string>, args[4] as TransactionDirection))
      case "renderOutgoingInvoiceHtml":
        return c.json(await service.renderOutgoingInvoice(args[0] as OutgoingInvoiceTemplateData))
      default:
        return c.text(`Unsupported RPC method: ${body.method}`, 400)
    }
  } catch (err) {
    return c.text(err instanceof Error ? err.message : String(err), 500)
  }
})

app.post("/api/export", async (c) => {
  const { workspaceId, kind, filters } = (await c.req.json()) as { workspaceId: string; kind: never; filters?: never }
  const res = await service.exportReport(workspaceId, kind, filters)
  return new Response(new Uint8Array(res.buffer), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${res.filename}"`
    }
  })
})

app.post("/api/backup/export", async (c) => {
  const { workspaceId } = (await c.req.json()) as { workspaceId: string }
  const buf = await service.exportBackup(workspaceId)
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="t_tax_backup.zip"`
    }
  })
})

app.post("/api/backup/restore", async (c) => {
  const { base64 } = (await c.req.json()) as { base64: string }
  if (!base64) return c.text("Missing backup ZIP payload", 400)
  return c.json(await service.restoreBackup(Buffer.from(base64, "base64")))
})

const staticRoot = join(__dirname, "public")
if (existsSync(staticRoot)) {
  app.use("/*", serveStatic({ root: staticRoot }))
}

if (process.env.TTAX_NO_LISTEN !== "1") {
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`T-Tax Web running on http://localhost:${PORT}`)
  })
}

export function closeWebServer(): void {
  conn.close()
}

export { app }
