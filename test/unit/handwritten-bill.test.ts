import { describe, it, expect } from "vitest"
import {
  classifyVietnameseReceipt,
  extractJsonObjectFromText,
  normalizeCurrencyCode,
  parseFlexibleDate,
  parseFlexibleMoney,
  parseMoneyInWords,
  parseOfflineOcrReceiptText,
  reconcileHandwrittenBill
} from "@t-tax/core"

const WORKSPACE_CATS = [
  "goods",
  "materials",
  "tools",
  "assets",
  "office",
  "software",
  "communication",
  "utility_bills",
  "rental",
  "ads",
  "transport",
  "travel",
  "food",
  "salary",
  "fees",
  "education",
  "revenue_goods",
  "revenue_service",
  "other"
]

describe("Handwritten Bill OCR, Reconciler & Vietnamese Receipt Classifier", () => {
  it("parses Vietnamese Bằng chữ and English amount-in-words accurately", () => {
    expect(
      parseMoneyInWords("Năm trăm mười sáu triệu, chín trăm tám mươi sáu ngàn, bảy trăm tám mươi chín đồng")
    ).toBe(516_986_789)
    expect(parseMoneyInWords("Một triệu hai trăm năm mươi nghìn đồng chẵn")).toBe(1_250_000)
    expect(parseMoneyInWords("Bốn trăm lẻ năm nghìn đồng")).toBe(405_000)
    expect(parseMoneyInWords("Hai triệu rưỡi")).toBe(2_500_000)
    expect(parseMoneyInWords("Two Thousand Only")).toBe(2000)
    expect(parseMoneyInWords("Six Thousand Nine Hundred Fifty Rupees Only")).toBe(6950)
  })

  it("parses Vietnamese shorthand, cursive .w thousands, VND dots, and international currencies", () => {
    expect(parseFlexibleMoney("1.340.000 đ", "VND")).toBe(1_340_000)
    expect(parseFlexibleMoney("430.w", "VND")).toBe(430_000)
    expect(parseFlexibleMoney("1tr5", "VND")).toBe(1_500_000)
    expect(parseFlexibleMoney("150k", "VND")).toBe(150_000)
    expect(parseFlexibleMoney(362852.693, "VND")).toBe(362_852_693)
    expect(parseFlexibleMoney("$1,476.00", "USD")).toBe(1476)
    expect(parseFlexibleMoney("£6.26", "GBP")).toBe(6.26)
    expect(parseFlexibleMoney("2.430", "TRY")).toBe(2430)
    expect(parseFlexibleMoney("2000/-", "INR")).toBe(2000)
  })

  it("parses Vietnamese prose dates and international handwritten dates", () => {
    expect(parseFlexibleDate("Ngày 02 tháng 05 năm 2022")).toBe("2022-05-02")
    expect(parseFlexibleDate("15/07/26")).toBe("2026-07-15")
    expect(parseFlexibleDate("12/20/81")).toBe("1981-12-20")
    expect(parseFlexibleDate("24/5/24")).toBe("2024-05-24")
    expect(parseFlexibleDate("18.01.2026")).toBe("2026-01-18")
  })

  it("classifies Vietnamese & international handwritten bills accurately and respects Smart Rules", () => {
    // Even if VLM mistakenly guesses "goods", PGL Motor motorbike repair must resolve to "transport"
    const motor = classifyVietnameseReceipt({
      merchant: "TRUNG TÂM KỸ THUẬT XE MÁY PGL MOTOR",
      name: "Sửa chữa bảo dưỡng xe máy",
      items: [{ name: "3 búa côn" }, { name: "Dây Cu Roa" }, { name: "Dầu Láp" }],
      llmCategoryCode: "goods",
      validCategoryCodes: WORKSPACE_CATS
    })
    expect(motor.categoryCode).toBe("transport")

    const seafood = classifyVietnameseReceipt({
      merchant: "Nhà Hàng Mỹ Hạnh",
      items: [{ name: "Tôm Hùm" }, { name: "Cá Mú" }, { name: "Bia Tiger" }],
      llmCategoryCode: "other",
      validCategoryCodes: WORKSPACE_CATS
    })
    expect(seafood.categoryCode).toBe("food")

    const design = classifyVietnameseReceipt({
      merchant: "Stella Campbell Co.",
      items: [{ name: "Logo Design Package" }, { name: "Social Media Graphics" }],
      llmCategoryCode: "other",
      validCategoryCodes: WORKSPACE_CATS
    })
    expect(design.categoryCode).toBe("ads")

    const water = classifyVietnameseReceipt({
      merchant: "BENNY P.D. PURIFIED DRINKING WATER",
      items: [{ name: "20L Jar" }],
      llmCategoryCode: "other",
      validCategoryCodes: WORKSPACE_CATS
    })
    expect(water.categoryCode).toBe("utility_bills")

    // Smart Rule always takes highest priority
    const ruled = classifyVietnameseReceipt({
      merchant: "TRUNG TÂM KỸ THUẬT XE MÁY PGL MOTOR",
      llmCategoryCode: "transport",
      validCategoryCodes: WORKSPACE_CATS,
      smartRules: [
        {
          id: "r1",
          workspaceId: "ws1",
          name: "PGL Motor -> Tools",
          matchField: "merchant",
          matchType: "contains",
          pattern: "PGL MOTOR",
          direction: "input",
          assignCategoryCode: "tools",
          priority: 1,
          enabled: true,
          hitCount: 0,
          createdAt: "2026-01-01"
        }
      ]
    })
    expect(ruled.categoryCode).toBe("tools")
    expect(ruled.source).toBe("rule")
  })

  it("reconciles VND shorthand, blank total boxes, hand-addition errors, and non-VAT tax compliance", () => {
    // 1. Vietnamese handwritten bill with thousand-shorthand ("1340" instead of "1340000")
    const vnMotor = reconcileHandwrittenBill(
      {
        documentKind: "handwritten_bill",
        merchant: "TRUNG TÂM KỸ THUẬT XE MÁY PGL MOTOR",
        currencyCode: "VND",
        total: 1340,
        vatAmount: 0,
        items: [
          { name: "3 búa côn", total: 430 },
          { name: "Bộ bi văng", total: 260 },
          { name: "Dây cu roa", total: 450 },
          { name: "Gioăng côn", total: 50 },
          { name: "Dầu láp", total: 60 },
          { name: "Dây công tơ mét", total: 90 }
        ]
      },
      { filename: "01_vn_pgl_motor.jpg", method: "vlm", validCategoryCodes: WORKSPACE_CATS }
    )
    expect(vnMotor.cleanedFields.total).toBe(1_340_000)
    expect(vnMotor.cleanedFields.preTaxAmount).toBe(1_340_000)
    expect(vnMotor.cleanedFields.vatRateCode).toBe("KCT")
    expect(vnMotor.cleanedFields.paymentMethod).toBe("Tiền mặt")
    expect(vnMotor.cleanedFields.categoryCode).toBe("transport")
    expect(vnMotor.auditIssues.some((i) => i.code === "HANDWRITTEN_NO_EINVOICE")).toBe(true)
    expect(vnMotor.auditIssues.some((i) => i.code === "VND_THOUSANDS_NORMALIZED")).toBe(true)

    // 2. English Indian hardware receipt must NOT be falsely multiplied by 1000!
    const inrHardware = reconcileHandwrittenBill(
      {
        documentKind: "handwritten_bill",
        merchant: "FRESCO ELECTRICALS & HARDWARES, ALUVA",
        currencyCode: "VND", // Even if LLM defaulted to VND, geographic clues override to INR!
        total: 360,
        items: [{ name: "Kilcott with Handle", qty: 1, total: 360 }]
      },
      { filename: "fresco.jpg", method: "vlm", validCategoryCodes: WORKSPACE_CATS }
    )
    expect(inrHardware.cleanedFields.currencyCode).toBe("INR")
    expect(inrHardware.cleanedFields.total).toBe(360)
    expect(inrHardware.cleanedFields.categoryCode).toBe("materials")

    // 3. Blank TOTAL box -> auto-sum from line items (B&K Motorsports = 6950 INR)
    const blankTotal = reconcileHandwrittenBill(
      {
        documentKind: "handwritten_bill",
        merchant: "B&K MOTORSPORTS, PASIGHAT",
        currencyCode: "INR",
        total: null,
        items: [
          { name: "Headlight", qty: 1, price: 5500, total: 5500 },
          { name: "Fibre", qty: 1, price: 600, total: 600 },
          { name: "Brake", qty: 1, price: 300, total: 300 },
          { name: "Acceleration Cable", qty: 1, price: 250, total: 250 },
          { name: "Stand", qty: 1, price: 300, total: 300 }
        ]
      },
      { filename: "bk_motorsports.jpg", method: "vlm", validCategoryCodes: WORKSPACE_CATS }
    )
    expect(blankTotal.cleanedFields.total).toBe(6950)
    expect(blankTotal.cleanedFields.categoryCode).toBe("transport")
    expect(blankTotal.auditIssues.some((i) => i.code === "TOTAL_AUTO_SUMMED")).toBe(true)

    // 4. Shop hand-addition error detection (items sum 2,637,000 vs stated 3,970,000)
    const misAdded = reconcileHandwrittenBill(
      {
        documentKind: "handwritten_bill",
        merchant: "Quán Hải Sản Bàn 29",
        currencyCode: "VND",
        total: 3_970_000,
        items: [
          { name: "Ghẹ", total: 754_000 },
          { name: "Tu hài", total: 1_020_000 },
          { name: "Tôm sú", total: 313_000 },
          { name: "Rau muống", total: 80_000 },
          { name: "Thịt chưng", total: 160_000 },
          { name: "Bia Larue", total: 210_000 },
          { name: "Cơm + Canh", total: 100_000 }
        ]
      },
      { filename: "ban29.jpg", method: "vlm", validCategoryCodes: WORKSPACE_CATS }
    )
    expect(misAdded.auditIssues.some((i) => i.code === "HANDWRITTEN_ARITHMETIC_MISMATCH")).toBe(true)
  })

  it("extracts JSON cleanly from <think> tags, markdown fences, and truncated items arrays", () => {
    const fenced = `<think>Checking totals...</think>\n\`\`\`json\n{"merchant": "Quán Phở 24", "total": 120000,}\n\`\`\``
    expect(extractJsonObjectFromText(fenced)).toEqual({ merchant: "Quán Phở 24", total: 120000 })

    const truncated = `{"merchant":"Nhà Hàng Mỹ Hạnh","total":85300000,"categoryCode":"food","items":[{"name":"Tôm Hùm","total":22000000},{"name":"Cá Mú","tot`
    const salvaged = extractJsonObjectFromText(truncated)
    expect(salvaged.merchant).toBe("Nhà Hàng Mỹ Hạnh")
    expect(salvaged.total).toBe(85_300_000)
    expect(Array.isArray(salvaged.items)).toBe(true)
    expect((salvaged.items as Array<Record<string, unknown>>).length).toBe(1)

    expect(normalizeCurrencyCode("", "PALMIYE CAFE ISTANBUL")).toBe("TRY")
    const offline = parseOfflineOcrReceiptText(
      "CỬA HÀNG VLXD MINH PHÁT\nNgày 15/08/2026\nXi măng 10 bao\nTổng cộng: 1.850.000 đ\nBằng chữ: Một triệu tám trăm năm mươi nghìn đồng",
      "vlxd.jpg"
    )
    expect(offline.merchant).toBe("CỬA HÀNG VLXD MINH PHÁT")
    expect(offline.total).toBe(1_850_000)
  })
})
