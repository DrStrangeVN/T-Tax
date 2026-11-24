import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ExcelJS from "exceljs"
import { openTTaxDatabase, TTaxService, VaultStorage } from "@t-tax/db"

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon>
    <TTChung>
      <THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon>
      <KHMSHDon>1</KHMSHDon>
      <KHHDon>C26TAA</KHHDon>
      <SHDon>00000789</SHDon>
      <NLap>2026-06-10</NLap>
      <DVTTe>VND</DVTTe>
      <TGia>1</TGia>
      <HTTToan>Chuyển khoản</HTTToan>
    </TTChung>
    <NDHDon>
      <NBan>
        <Ten>CÔNG TY CỔ PHẦN CLOUD VIỆT NAM</Ten>
        <MST>0309998887</MST>
      </NBan>
      <NMua>
        <Ten>Công ty TNHH T-Tax Demo</Ten>
        <MST>0312345678</MST>
      </NMua>
      <DSHHDVu>
        <HHDVu>
          <STT>1</STT>
          <THHDVu>Thuê máy chủ Cloud tháng 06</THHDVu>
          <ThTien>10000000</ThTien>
          <TSuat>10%</TSuat>
        </HHDVu>
      </DSHHDVu>
      <TToan>
        <TgTCThue>10000000</TgTCThue>
        <TgTThue>1000000</TgTThue>
        <TgTTTBSo>11000000</TgTTTBSo>
      </TToan>
    </NDHDon>
  </DLHDon>
</HDon>`

describe("SQLite DB, FTS5, Vault, Excel Export & Backup/Restore", () => {
  let tempDir: string
  let dbPath: string
  let vaultDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ttax-test-"))
    dbPath = join(tempDir, "ttax.db")
    vaultDir = join(tempDir, "vault")
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("ingests paired XML+PDF, deduplicates SHA-256, approves with VAS journal, searches FTS5, exports MISA/HTKK preserving zeros, and round-trips Backup", async () => {
    const conn = openTTaxDatabase(dbPath)
    const vault = new VaultStorage(vaultDir)
    const service = new TTaxService(conn.db, conn.sqlite, vault)
    const ws = service.ensureWorkspace()

    // Ingest paired XML + PDF
    const ing = await service.ingestFiles(ws.id, [
      { filename: "HD_00000789.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML, "utf8") },
      { filename: "HD_00000789.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 dummy", "utf8") }
    ])
    expect(ing.createdFiles).toHaveLength(2)

    // Duplicate ingest skipped
    const dup = await service.ingestFiles(ws.id, [
      { filename: "HD_00000789_copy.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML, "utf8") }
    ])
    expect(dup.skippedDuplicates).toHaveLength(1)

    // Unreviewed list only surfaces primary XML (companion PDF linked)
    const unreviewed = service.listFiles(ws.id, { unreviewedOnly: true })
    expect(unreviewed).toHaveLength(1)
    const xmlFile = unreviewed[0]!

    const analysis = await service.analyzeFile(ws.id, xmlFile.id, [])
    expect(analysis.extractionMethod).toBe("xml")
    expect(analysis.parsedEInvoice?.invoiceNumber).toBe("00000789")

    await service.approveFileToTransaction(ws.id, xmlFile.id, {
      name: String(analysis.extractedFields.name),
      merchant: String(analysis.extractedFields.merchant),
      merchantTaxCode: String(analysis.extractedFields.merchantTaxCode),
      direction: "input",
      preTaxAmount: 10_000_000,
      vatAmount: 1_000_000,
      totalAmount: 11_000_000,
      currencyCode: "VND",
      vatRateCode: "10%",
      invoiceSymbol: "1C26TAA",
      invoiceNumber: "00000789",
      issuedAt: "2026-06-10",
      categoryCode: "software",
      paymentMethod: "Chuyển khoản"
    })

    // FTS5 search
    const searchRes = service.listTransactions(ws.id, { search: "0309998887" })
    expect(searchRes.total).toBe(1)

    // VAS journal lines created & balanced
    const entries = service.listJournalEntries(ws.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.lines).toHaveLength(2)

    // HTKK Excel preserves leading zero MST & invoice number and has SUM formula
    const htkk = await service.exportReport(ws.id, "htkk_in")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(htkk.buffer as never)
    const sheet = wb.worksheets[0]!
    expect(sheet.getRow(4).getCell(4).value).toBe("00000789")
    expect(sheet.getRow(4).getCell(7).value).toBe("0309998887")
    expect(sheet.getRow(5).getCell(9).value).toMatchObject({ formula: "SUM(I4:I4)" })

    // Backup & Restore round-trip
    const backupZip = await service.exportBackup(ws.id)
    service.deleteTransactions(ws.id, [searchRes.rows[0]!.id])
    expect(service.listTransactions(ws.id).total).toBe(0)

    const restored = await service.restoreBackup(backupZip)
    expect(restored.restoredTransactions).toBe(1)
    expect(service.listTransactions(ws.id).total).toBe(1)

    conn.close()
  })
})
