import JSZip from "jszip"
import { eq } from "drizzle-orm"
import * as schema from "./schema.js"
import type { TTaxDb } from "./client.js"
import type { VaultStorage } from "./vault.js"

const BACKUP_FORMAT_VERSION = "t-tax-backup-v1"

export async function exportWorkspaceBackupZip(
  db: TTaxDb,
  vault: VaultStorage,
  workspaceId: string
): Promise<Buffer> {
  const zip = new JSZip()

  const workspace = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
  if (!workspace) throw new Error("Không tìm thấy Workspace để sao lưu.")

  const settings = db.select().from(schema.settings).where(eq(schema.settings.workspaceId, workspaceId)).all()
  const currencies = db.select().from(schema.currencies).where(eq(schema.currencies.workspaceId, workspaceId)).all()
  const chartOfAccounts = db.select().from(schema.chartOfAccounts).where(eq(schema.chartOfAccounts.workspaceId, workspaceId)).all()
  const categories = db.select().from(schema.categories).where(eq(schema.categories.workspaceId, workspaceId)).all()
  const projects = db.select().from(schema.projects).where(eq(schema.projects.workspaceId, workspaceId)).all()
  const fields = db.select().from(schema.fields).where(eq(schema.fields.workspaceId, workspaceId)).all()
  const counterparties = db.select().from(schema.counterparties).where(eq(schema.counterparties.workspaceId, workspaceId)).all()
  const files = db.select().from(schema.files).where(eq(schema.files.workspaceId, workspaceId)).all()
  const transactions = db.select().from(schema.transactions).where(eq(schema.transactions.workspaceId, workspaceId)).all()
  const einvoices = db.select().from(schema.einvoiceRecords).where(eq(schema.einvoiceRecords.workspaceId, workspaceId)).all()
  const journalEntries = db.select().from(schema.journalEntries).where(eq(schema.journalEntries.workspaceId, workspaceId)).all()

  const einvoiceIds = new Set(einvoices.map((e) => e.id))
  const einvoiceItems = einvoiceIds.size
    ? db.select().from(schema.einvoiceLineItems).all().filter((it) => einvoiceIds.has(it.einvoiceId))
    : []

  const entryIds = new Set(journalEntries.map((e) => e.id))
  const journalLines = entryIds.size
    ? db.select().from(schema.journalLines).all().filter((ln) => entryIds.has(ln.entryId))
    : []

  const bankStatements = db.select().from(schema.bankStatements).where(eq(schema.bankStatements.workspaceId, workspaceId)).all()
  const appData = db.select().from(schema.appData).where(eq(schema.appData.workspaceId, workspaceId)).all()

  zip.file(
    "manifest.json",
    JSON.stringify({ format: BACKUP_FORMAT_VERSION, exportedAt: new Date().toISOString(), workspaceId }, null, 2)
  )
  zip.file("workspace.json", JSON.stringify(workspace, null, 2))
  zip.file("settings.json", JSON.stringify(settings, null, 2))
  zip.file("currencies.json", JSON.stringify(currencies, null, 2))
  zip.file("chart_of_accounts.json", JSON.stringify(chartOfAccounts, null, 2))
  zip.file("categories.json", JSON.stringify(categories, null, 2))
  zip.file("projects.json", JSON.stringify(projects, null, 2))
  zip.file("fields.json", JSON.stringify(fields, null, 2))
  zip.file("counterparties.json", JSON.stringify(counterparties, null, 2))
  zip.file("files.json", JSON.stringify(files, null, 2))
  zip.file("transactions.json", JSON.stringify(transactions, null, 2))
  zip.file("einvoice_records.json", JSON.stringify(einvoices, null, 2))
  zip.file("einvoice_line_items.json", JSON.stringify(einvoiceItems, null, 2))
  zip.file("journal_entries.json", JSON.stringify(journalEntries, null, 2))
  zip.file("journal_lines.json", JSON.stringify(journalLines, null, 2))
  zip.file("bank_statements.json", JSON.stringify(bankStatements, null, 2))
  zip.file("app_data.json", JSON.stringify(appData, null, 2))

  const vaultFolder = zip.folder("vault")
  for (const f of files) {
    if (vault.exists(f.relativePath)) {
      vaultFolder?.file(f.relativePath, vault.readFile(f.relativePath))
    }
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

export async function restoreWorkspaceBackupZip(
  db: TTaxDb,
  vault: VaultStorage,
  zipBuffer: Buffer
): Promise<{ workspaceId: string; restoredTransactions: number; restoredFiles: number }> {
  const zip = await JSZip.loadAsync(zipBuffer)
  const manifestText = await zip.file("manifest.json")?.async("string")
  if (!manifestText) throw new Error("Tệp sao lưu không hợp lệ (thiếu manifest.json).")
  const manifest = JSON.parse(manifestText) as { format: string; workspaceId: string }
  if (manifest.format !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Phiên bản sao lưu không tương thích: ${manifest.format}`)
  }

  const readTable = async <T>(name: string): Promise<T[]> => {
    const raw = await zip.file(name)?.async("string")
    return raw ? (JSON.parse(raw) as T[]) : []
  }

  const workspace = JSON.parse((await zip.file("workspace.json")?.async("string")) ?? "{}") as typeof schema.workspaces.$inferInsert
  if (!workspace.id) throw new Error("Thiếu thông tin workspace.json trong bản sao lưu.")

  // Restore files to disk first
  const fileRows = await readTable<typeof schema.files.$inferInsert>("files.json")
  for (const f of fileRows) {
    const fileEntry = zip.file(`vault/${f.relativePath}`)
    if (fileEntry) {
      const buf = await fileEntry.async("nodebuffer")
      const abs = vault.resolvePath(f.relativePath)
      const { mkdirSync, writeFileSync } = await import("node:fs")
      const { dirname } = await import("node:path")
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, buf)
    }
  }

  const settingsRows = await readTable<typeof schema.settings.$inferInsert>("settings.json")
  const currencyRows = await readTable<typeof schema.currencies.$inferInsert>("currencies.json")
  const coaRows = await readTable<typeof schema.chartOfAccounts.$inferInsert>("chart_of_accounts.json")
  const catRows = await readTable<typeof schema.categories.$inferInsert>("categories.json")
  const projRows = await readTable<typeof schema.projects.$inferInsert>("projects.json")
  const fieldRows = await readTable<typeof schema.fields.$inferInsert>("fields.json")
  const cpRows = await readTable<typeof schema.counterparties.$inferInsert>("counterparties.json")
  const txRows = await readTable<typeof schema.transactions.$inferInsert>("transactions.json")
  const einvRows = await readTable<typeof schema.einvoiceRecords.$inferInsert>("einvoice_records.json")
  const einvItemRows = await readTable<typeof schema.einvoiceLineItems.$inferInsert>("einvoice_line_items.json")
  const jeRows = await readTable<typeof schema.journalEntries.$inferInsert>("journal_entries.json")
  const jlRows = await readTable<typeof schema.journalLines.$inferInsert>("journal_lines.json")
  const bankRows = await readTable<typeof schema.bankStatements.$inferInsert>("bank_statements.json")
  const appRows = await readTable<typeof schema.appData.$inferInsert>("app_data.json")

  // Replace workspace cleanly inside single atomic SQLite transaction (FK cascade clears children)
  db.transaction((tx) => {
    tx.delete(schema.workspaces).where(eq(schema.workspaces.id, workspace.id)).run()
    tx.insert(schema.workspaces).values(workspace).run()
    if (settingsRows.length) tx.insert(schema.settings).values(settingsRows).run()
    if (currencyRows.length) tx.insert(schema.currencies).values(currencyRows).run()
    if (coaRows.length) tx.insert(schema.chartOfAccounts).values(coaRows).run()
    if (catRows.length) tx.insert(schema.categories).values(catRows).run()
    if (projRows.length) tx.insert(schema.projects).values(projRows).run()
    if (fieldRows.length) tx.insert(schema.fields).values(fieldRows).run()
    if (cpRows.length) tx.insert(schema.counterparties).values(cpRows).run()
    if (fileRows.length) tx.insert(schema.files).values(fileRows).run()
    if (txRows.length) tx.insert(schema.transactions).values(txRows).run()
    if (einvRows.length) tx.insert(schema.einvoiceRecords).values(einvRows).run()
    if (einvItemRows.length) tx.insert(schema.einvoiceLineItems).values(einvItemRows).run()
    if (jeRows.length) tx.insert(schema.journalEntries).values(jeRows).run()
    if (jlRows.length) tx.insert(schema.journalLines).values(jlRows).run()
    if (bankRows.length) tx.insert(schema.bankStatements).values(bankRows).run()
    if (appRows.length) tx.insert(schema.appData).values(appRows).run()
  })

  return {
    workspaceId: workspace.id,
    restoredTransactions: txRows.length,
    restoredFiles: fileRows.length
  }
}
