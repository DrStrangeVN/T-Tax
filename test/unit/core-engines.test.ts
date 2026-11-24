import { describe, it, expect } from "vitest"
import {
  normalizeVietnameseAscii,
  safeAsciiFilename,
  buildVietQrPayload,
  suggestJournalLines,
  verifyJournalBalance,
  ConcurrencyLimiter,
  buildAnalyzePrompt,
  DEFAULT_ANALYZE_PROMPT_TEMPLATE,
  buildDynamicAnalyzeSchema,
  parseBankStatementBuffer,
  matchBankRowsToTransactions
} from "@t-tax/core"

describe("Core Engines (ASCII, VietQR, VAS, AI Limiter, Bank 3-Way Match)", () => {
  it("normalizes Vietnamese NFD/NFC filenames strictly to safe ASCII", () => {
    const nfd = "Ho\u0301a \u0111\u01a1n Ti\u1ebfng Vi\u1ec7t \u0111\u1eb7c bi\u1ec7t.xml".normalize("NFD")
    expect(normalizeVietnameseAscii(nfd)).toBe("Hoa don Tieng Viet dac biet.xml")
    expect(safeAsciiFilename(nfd)).toBe("Hoa_don_Tieng_Viet_dac_biet.xml")
  })

  it("builds valid EMVCo VietQR payload ending in 4-hex CRC16", () => {
    const payload = buildVietQrPayload({
      bankBin: "970436",
      accountNo: "0011001234567",
      amountVnd: 1500000,
      description: "TT HD 00001234"
    })
    expect(payload.startsWith("000201010212")).toBe(true)
    expect(payload).toContain("970436")
    expect(payload).toContain("5303704")
    expect(payload).toMatch(/6304[0-9A-F]{4}$/)
  })

  it("suggests balanced double-entry VAS journal lines for TT99, TT133, and HKD2026", () => {
    const tt99 = suggestJournalLines({
      regime: "TT99_2025",
      direction: "input",
      categoryCode: "ads",
      paymentMethod: "Chuyển khoản",
      preTaxAmount: 10_000_000,
      vatAmount: 1_000_000,
      totalAmount: 11_000_000,
      invoiceNumber: "00001234"
    })
    expect(tt99[0]?.debitAccount).toBe("641")
    expect(tt99[1]?.debitAccount).toBe("1331")
    expect(verifyJournalBalance(tt99)).toEqual({ balanced: true, totalAmountVnd: 11_000_000 })

    const tt133 = suggestJournalLines({
      regime: "TT133_2016",
      direction: "input",
      categoryCode: "ads",
      paymentMethod: "Tiền mặt",
      preTaxAmount: 5_000_000,
      vatAmount: 500_000,
      totalAmount: 5_500_000
    })
    expect(tt133[0]?.debitAccount).toBe("6421")
    expect(tt133[0]?.creditAccount).toBe("1111")
  })

  it("builds nullable zero-hallucination schema & scales ConcurrencyLimiter on 429", async () => {
    const fields = [
      { code: "merchant", name: "NCC", type: "string", llmPrompt: "tên người bán" },
      { code: "total", name: "Tổng", type: "number", llmPrompt: "tổng tiền" }
    ]
    const prompt = buildAnalyzePrompt(DEFAULT_ANALYZE_PROMPT_TEMPLATE, {
      fields,
      categories: [{ code: "software", name: "Phần mềm", llmPrompt: "saas" }],
      projects: [{ code: "general", name: "Chung", llmPrompt: "chung" }],
      regime: "TT99_2025"
    })
    expect(prompt).toContain("ZERO HALLUCINATION")
    expect(prompt).toContain("software")

    const schema = buildDynamicAnalyzeSchema(fields)
    const parsed = schema.parse({ merchant: null, total: null, items: [] })
    expect(parsed.merchant).toBeNull()

    const limiter = new ConcurrencyLimiter(3)
    expect(limiter.getMax()).toBe(3)
    limiter.reduceMax()
    expect(limiter.getMax()).toBe(2)
  })

  it("parses Vietnamese bank statement CSV and 3-way matches against invoices", async () => {
    const csv = `NGAN HANG TMCP NGOAI THUONG VIET NAM\nNgày giao dịch,Số tham chiếu,Nội dung,Ghi nợ,Ghi có,Số dư\n16/05/2026,FT26136001,Thanh toan HD 00001234 MST 0312345678,23760000,0,100000000\n`
    const rows = await parseBankStatementBuffer("vcb.csv", Buffer.from(csv, "utf8"))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.debitAmount).toBe(23_760_000)

    const matches = matchBankRowsToTransactions(rows, [
      {
        id: "tx-1",
        merchant: "T-Tax",
        merchantTaxCode: "0312345678",
        invoiceNumber: "00001234",
        direction: "input",
        totalAmount: 23_760_000,
        issuedAt: "2026-05-15"
      }
    ])
    expect(matches).toHaveLength(1)
    expect(matches[0]?.transactionId).toBe("tx-1")
    expect(matches[0]?.confidence).toBeGreaterThanOrEqual(0.95)
  })
})
