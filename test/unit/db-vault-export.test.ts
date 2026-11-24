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

  it("supports FX manual tx, repostJournal on update, batchApproveCleanXml, searchGlobal, badgeCounts, detail & bank unmatch", async () => {
    const conn = openTTaxDatabase(dbPath)
    const vault = new VaultStorage(vaultDir)
    const service = new TTaxService(conn.db, conn.sqlite, vault)
    const ws = service.ensureWorkspace()

    // Ingest & analyze clean XML then batch-approve
    await service.ingestFiles(ws.id, [
      { filename: "CLEAN_00000789.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML, "utf8") }
    ])
    const pending = service.listFiles(ws.id, { unreviewedOnly: true })
    expect(service.getSidebarBadgeCounts(ws.id).unreviewedCount).toBe(1)

    await service.analyzeFile(ws.id, pending[0]!.id, [])
    const batchRes = await service.batchApproveCleanXml(ws.id, [pending[0]!.id])
    expect(batchRes.approved).toBe(1)
    expect(service.getSidebarBadgeCounts(ws.id).unreviewedCount).toBe(0)

    // Create manual FX transaction with explicit FX rate -> convertedTotalVnd + VAS posting
    const fxTx = await service.createManualTransaction(ws.id, {
      name: "AWS Cloud USD",
      merchant: "Amazon Web Services",
      merchantTaxCode: "0109998888",
      direction: "input",
      preTaxAmount: 100,
      vatAmount: 0,
      totalAmount: 100,
      currencyCode: "USD",
      fxRateDecimal: "25400",
      categoryCode: "software",
      issuedAt: "2026-06-15",
      paymentMethod: "Chuyển khoản"
    })
    expect(fxTx.convertedTotalVnd).toBe(2_540_000)

    // Repost journal when category & amount updated
    service.updateTransaction(
      ws.id,
      fxTx.id,
      { categoryCode: "assets", preTaxAmount: 200, totalAmount: 200 },
      true
    )
    const detail = service.getTransactionDetail(ws.id, fxTx.id)
    expect(detail?.journalEntries.length).toBe(1)
    expect(detail?.journalEntries[0]?.lines?.some((l) => l.debitAccount === "211")).toBe(true)

    // FTS5 global search & SQL summary + sorting
    const globalRes = service.searchGlobal(ws.id, "AWS")
    expect(globalRes.transactions.length).toBeGreaterThanOrEqual(1)
    const listSummary = service.listTransactions(ws.id, { sortBy: "totalAmount", sortDir: "desc", lightweight: true })
    expect(listSummary.summary.totalSum).toBeGreaterThan(11_000_000)

    // Bank statement import -> confirm -> unmatch
    const bankCsv = "Ngày giao dịch,Nội dung,Ghi nợ,Ghi có\n2026-06-10,TT HOA DON 00000789 CLOUD VN,11000000,0\n"
    const bkRes = await service.importBankStatementAndMatch(ws.id, "vcb.csv", Buffer.from(bankCsv, "utf8"), "VCB")
    expect(bkRes.importedCount).toBe(1)
    const stmts = service.listBankStatements(ws.id)
    expect(stmts).toHaveLength(1)
    const xmlTxId = service.listTransactions(ws.id, { search: "00000789" }).rows[0]!.id
    service.confirmBankMatch(ws.id, stmts[0]!.id, xmlTxId)
    expect(service.listBankStatements(ws.id)[0]?.matchStatus).toBe("matched")
    expect(service.listBankStatements(ws.id)[0]?.matchedTransaction?.invoiceNumber).toBe("00000789")

    service.unmatchBankStatement(ws.id, stmts[0]!.id)
    expect(service.listBankStatements(ws.id)[0]?.matchStatus).toBe("unmatched")

    conn.close()
  })

  it("enforces P0 FX normalization, bulk VAS repost, cascade delete/reopen, trial balance, VAT closing & lockDate", async () => {
    const conn = openTTaxDatabase(dbPath)
    const vault = new VaultStorage(vaultDir)
    const service = new TTaxService(conn.db, conn.sqlite, vault)
    const ws = service.ensureWorkspace()

    // 1. P0 B1: Foreign currency preTax + vat must post to VAS & dashboard in VND
    const usdTx = await service.createManualTransaction(ws.id, {
      name: "SaaS Analytics USD",
      merchant: "Mixpanel Inc",
      direction: "input",
      preTaxAmount: 100,
      vatAmount: 10,
      totalAmount: 110,
      currencyCode: "USD",
      fxRateDecimal: "25000",
      categoryCode: "software",
      issuedAt: "2026-07-05",
      paymentMethod: "Chuyển khoản"
    })
    const usdDetail = service.getTransactionDetail(ws.id, usdTx.id)
    const totalDebitVnd = (usdDetail?.journalEntries[0]?.lines ?? []).reduce((s, l) => s + l.amountVnd, 0)
    expect(totalDebitVnd).toBe(2_750_000)

    const dash = service.getDashboardStats(ws.id)
    expect(dash.totalExpense).toBe(2_750_000)
    expect(dash.inputVat).toBe(250_000)

    // 2. P0 B3: Bulk category/paymentStatus update reposts auto_rule VAS journal entries
    service.bulkUpdateTransactions(ws.id, [usdTx.id], { categoryCode: "assets", paymentStatus: "paid" })
    const reposted = service.getTransactionDetail(ws.id, usdTx.id)
    expect(reposted?.journalEntries[0]?.lines?.some((l) => l.debitAccount === "211")).toBe(true)
    expect(reposted?.journalEntries[0]?.lines?.some((l) => l.creditAccount === "1121")).toBe(true)

    // 3. P0 B4 + B2: Companion PDF exclusion & cascade delete / reopen to inbox
    await service.ingestFiles(ws.id, [
      { filename: "INV_00000789.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML, "utf8") },
      { filename: "INV_00000789.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%fake\n") }
    ])
    const badgesBefore = service.getSidebarBadgeCounts(ws.id)
    expect(badgesBefore.unreviewedCount).toBe(1)

    const inboxXml = service.listFiles(ws.id, { unreviewedOnly: true }).find((f) => f.filename.endsWith(".xml"))!
    await service.analyzeFile(ws.id, inboxXml.id, [])
    await service.batchApproveCleanXml(ws.id, [inboxXml.id])
    expect(service.getSidebarBadgeCounts(ws.id).unreviewedCount).toBe(0)

    const xmlTxId = service.listTransactions(ws.id, { search: "00000789" }).rows[0]!.id
    const bk = await service.importBankStatementAndMatch(
      ws.id,
      "vcb.csv",
      Buffer.from("Ngày giao dịch,Nội dung,Ghi nợ,Ghi có\n2026-06-10,TT 00000789,11000000,0\n2026-06-11,PHI CHUYEN KHOAN,22000,0\n", "utf8"),
      "VCB"
    )
    expect(bk.importedCount).toBe(2)
    const stmts = service.listBankStatements(ws.id)
    service.confirmBankMatch(ws.id, stmts[0]!.id, xmlTxId)

    // Reopen returns linked XML back to inbox & resets bank match
    const reopened = service.reopenTransactionToInbox(ws.id, xmlTxId)
    expect(reopened.restoredFileIds.length).toBeGreaterThanOrEqual(1)
    expect(service.listTransactions(ws.id, { search: "00000789" }).total).toBe(0)
    expect(service.listBankStatements(ws.id)[0]?.matchStatus).toBe("unmatched")
    expect(service.getSidebarBadgeCounts(ws.id).unreviewedCount).toBe(1)

    // Quick-post unmatched bank fee -> TK 6425
    const feeRes = await service.quickPostBankStatement(ws.id, stmts[1]!.id, { kind: "bank_fee" })
    expect(feeRes.id).toBeTruthy()
    expect(service.listBankStatements(ws.id)[1]?.matchStatus).toBe("matched")

    // 4. Trial Balance, Manual Journal, VAT Closing & Counterparty default rule
    service.createManualJournalEntry(ws.id, {
      voucherDate: "2026-07-10",
      description: "Bút toán trích trước chi phí",
      lines: [{ debitAccount: "6422", creditAccount: "335", amountVnd: 1_500_000 }]
    })
    const tb = service.getTrialBalance(ws.id)
    expect(tb.length).toBeGreaterThan(0)
    const sumEndingDebit = tb.reduce((s, r) => s + r.closingDebit, 0)
    const sumEndingCredit = tb.reduce((s, r) => s + r.closingCredit, 0)
    expect(sumEndingDebit).toBe(sumEndingCredit)

    const vatClose = service.postVatClosingEntry(ws.id, {
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      voucherDate: "2026-07-31"
    })
    expect(vatClose).toBeTruthy()

    const cps = service.listCounterparties(ws.id)
    if (cps.length > 0) {
      service.updateCounterparty(ws.id, cps[0]!.id, { defaultCategoryCode: "software", defaultAccountCode: "6428" })
      expect(service.listCounterparties(ws.id)[0]?.defaultAccountCode).toBe("6428")
    }

    // 5. Accounting Period Lock Guard
    service.updateWorkspace(ws.id, { lockDate: "2026-06-30" })
    await expect(
      service.createManualTransaction(ws.id, {
        name: "Blocked Backdated Tx",
        direction: "input",
        totalAmount: 100_000,
        issuedAt: "2026-06-15"
      })
    ).rejects.toThrow(/khóa/i)

    // 6. P2 Lazy batch XML preview when >10 XML files + on-demand renderParsedXmlHtml
    const manyXmls = Array.from({ length: 12 }, (_, idx) => ({
      filename: `XML_${idx + 1}.xml`,
      buffer: Buffer.from(MINIMAL_XML.replace("00000789", String(1000 + idx)), "utf8")
    }))
    const batchRes = await service.batchProcessXmlFiles(ws.id, manyXmls)
    expect(batchRes).toHaveLength(12)
    expect(batchRes[0]!.htmlPreview).toBeFalsy()
    const onDemandHtml = await service.renderParsedXmlHtml(batchRes[0]!.parsed, batchRes[0]!.signature)
    expect(onDemandHtml).toContain("CÔNG TY CỔ PHẦN CLOUD VIỆT NAM")

    conn.close()
  })

  it("supports Round-3 Pre-Tax KPIs, Opening Balances, Account Ledger, 1-N Bank Match, Safe File Delete & Selective Batch Session", async () => {
    const conn = openTTaxDatabase(dbPath)
    const vault = new VaultStorage(vaultDir)
    const service = new TTaxService(conn.db, conn.sqlite, vault)
    const ws = service.ensureWorkspace()

    // 1. Pre-tax KPIs & Operating Profit
    await service.createManualTransaction(ws.id, {
      name: "Doanh thu SaaS",
      direction: "output",
      preTaxAmount: 20_000_000,
      vatAmount: 2_000_000,
      totalAmount: 22_000_000,
      issuedAt: "2026-07-05"
    })
    await service.createManualTransaction(ws.id, {
      name: "Chi phí máy chủ",
      direction: "input",
      preTaxAmount: 5_000_000,
      vatAmount: 500_000,
      totalAmount: 5_500_000,
      issuedAt: "2026-07-06"
    })
    const dash = service.getDashboardStats(ws.id)
    expect(dash.revenuePreTax).toBe(20_000_000)
    expect(dash.expensePreTax).toBe(5_000_000)
    expect(dash.operatingProfit).toBe(15_000_000)
    expect(dash.totalRevenue).toBe(22_000_000)
    expect(dash.netProfit).toBe(16_500_000)

    // 2. Opening Balances validation + folding into Trial Balance & Account Ledger
    expect(() =>
      service.saveOpeningBalances(ws.id, [{ accountCode: "1121", openingDebit: 100_000_000, openingCredit: 0 }])
    ).toThrow(/cân đối/i)

    service.saveOpeningBalances(ws.id, [
      { accountCode: "1121", openingDebit: 100_000_000, openingCredit: 0 },
      { accountCode: "4111", openingDebit: 0, openingCredit: 100_000_000 }
    ])
    const tb = service.getTrialBalance(ws.id)
    const row1121 = tb.find((r) => r.code === "1121")
    expect(row1121?.openingDebit).toBe(100_000_000)

    service.createManualJournalEntry(ws.id, {
      voucherDate: "2026-07-07",
      description: "Chi mua văn phòng phẩm bằng CK",
      lines: [{ debitAccount: "6427", creditAccount: "1121", amountVnd: 2_000_000 }]
    })
    const ledger1121 = service.getAccountLedger(ws.id, "1121")
    expect(ledger1121.openingBalance).toBe(100_000_000)
    expect(ledger1121.totalCredit).toBe(2_000_000)
    expect(ledger1121.closingBalance).toBe(98_000_000)
    const ledgerExport = await service.exportAccountLedgerExcel(ws.id, "1121")
    expect(ledgerExport.buffer.byteLength).toBeGreaterThan(1000)

    // 3. 1-N Bank Statement Matching + cash_transfer Quick Post
    const invA = await service.createManualTransaction(ws.id, {
      name: "Hóa đơn A",
      direction: "output",
      preTaxAmount: 3_000_000,
      vatAmount: 0,
      totalAmount: 3_000_000,
      issuedAt: "2026-07-08"
    })
    const invB = await service.createManualTransaction(ws.id, {
      name: "Hóa đơn B",
      direction: "output",
      preTaxAmount: 7_000_000,
      vatAmount: 0,
      totalAmount: 7_000_000,
      issuedAt: "2026-07-09"
    })
    await service.importBankStatementAndMatch(
      ws.id,
      "multi.csv",
      Buffer.from(
        "Ngày giao dịch,Nội dung,Ghi nợ,Ghi có\n2026-07-10,KH THANH TOAN GOP 2 HD,0,10000000\n2026-07-11,RUT TIEN NHAP QUY TM,5000000,0\n",
        "utf8"
      ),
      "VCB"
    )
    const stmts = service.listBankStatements(ws.id)
    const receiptStmt = stmts.find((s) => s.creditAmount === 10_000_000)!
    service.addBankMatch(ws.id, receiptStmt.id, invA.id, 3_000_000)
    service.addBankMatch(ws.id, receiptStmt.id, invB.id, 7_000_000)
    const updatedReceipt = service.listBankStatements(ws.id).find((s) => s.id === receiptStmt.id)!
    expect(updatedReceipt.matchStatus).toBe("matched")
    expect(updatedReceipt.matches).toHaveLength(2)

    service.removeBankMatch(ws.id, receiptStmt.id, invA.id)
    const partialReceipt = service.listBankStatements(ws.id).find((s) => s.id === receiptStmt.id)!
    expect(partialReceipt.matches).toHaveLength(1)

    const cashStmt = stmts.find((s) => s.debitAmount === 5_000_000)!
    const cashTx = await service.quickPostBankStatement(ws.id, cashStmt.id, { kind: "cash_transfer" })
    const cashDetail = service.getTransactionDetail(ws.id, cashTx.id)
    expect(cashDetail?.journalEntries[0]?.lines?.[0]).toMatchObject({ debitAccount: "1111", creditAccount: "1121" })

    // 4. Safe File Delete + Lock Period Guard
    const ingSafe = await service.ingestFiles(ws.id, [
      { filename: "SAFE_00000789.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML, "utf8") }
    ])
    const safeFileId = ingSafe.createdFiles[0]!.id
    await service.analyzeFile(ws.id, safeFileId, [])
    await service.approveFileToTransaction(ws.id, safeFileId, {
      name: "Cloud VN",
      direction: "input",
      preTaxAmount: 10_000_000,
      vatAmount: 1_000_000,
      totalAmount: 11_000_000,
      issuedAt: "2026-06-10"
    })
    expect(() => service.deleteFile(ws.id, safeFileId)).toThrow(/gắn với giao dịch/i)

    service.updateWorkspace(ws.id, { lockDate: "2026-06-30" })
    expect(() => service.deleteFile(ws.id, safeFileId, { force: true })).toThrow(/khóa sổ/i)

    service.updateWorkspace(ws.id, { lockDate: "" })
    expect(service.deleteFile(ws.id, safeFileId, { force: true })).toBe(true)

    // 5. Selective Batch XML Session
    const session = await service.batchProcessXmlSession(ws.id, [
      { filename: "B1.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML.replace("00000789", "00009001"), "utf8") },
      { filename: "B2.xml", mimetype: "application/xml", buffer: Buffer.from(MINIMAL_XML.replace("00000789", "00009002"), "utf8") }
    ])
    expect(session.items).toHaveLength(2)
    await service.commitBatchXmlSession(ws.id, session.batchId, [1])
    expect(service.listTransactions(ws.id, { search: "00009001" }).total).toBe(0)
    expect(service.listTransactions(ws.id, { search: "00009002" }).total).toBe(1)

    conn.close()
  })
})
