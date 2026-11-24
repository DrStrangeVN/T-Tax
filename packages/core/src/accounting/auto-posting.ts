import type { AccountingRegime, TransactionDirection } from "../types.js"

export interface JournalLineSuggestion {
  debitAccount: string
  creditAccount: string
  amountVnd: number
  description: string
  taxCode?: string
}

export interface AutoPostingInput {
  regime: AccountingRegime
  direction: TransactionDirection
  categoryCode?: string | null
  categoryDefaultDebit?: string | null
  counterpartyDefaultAccount?: string | null
  paymentMethod?: string | null
  paymentStatus?: string | null
  preTaxAmount: number
  vatAmount: number
  totalAmount: number
  merchant?: string | null
  merchantTaxCode?: string | null
  invoiceNumber?: string | null
}

const CATEGORY_TO_DEBIT_ACCOUNT: Record<string, string> = {
  goods: "1561",
  materials: "152",
  tools: "153",
  ads: "641",
  events: "641",
  food: "6428",
  travel: "6427",
  communication: "6427",
  utility_bills: "6427",
  online: "6427",
  software: "6427",
  rental: "6427",
  office: "6423",
  salary: "6421",
  fees: "6425",
  education: "6428",
  transport: "6427",
  assets: "211",
  other: "6428"
}

function resolveSettlementAccount(paymentMethod?: string | null, paymentStatus?: string | null, direction: TransactionDirection = "input"): string {
  const pm = (paymentMethod ?? "").toLowerCase()
  if (paymentStatus === "unpaid" || pm.includes("công nợ") || pm.includes("chưa thanh toán")) {
    return direction === "input" ? "331" : "131"
  }
  if (pm.includes("tiền mặt") || pm === "tm" || pm === "cash") {
    return "1111"
  }
  if (pm.includes("ck") || pm.includes("chuyển khoản") || pm.includes("ngân hàng") || pm.includes("bank")) {
    return "1121"
  }
  return direction === "input" ? "331" : "131"
}

export function suggestJournalLines(input: AutoPostingInput): JournalLineSuggestion[] {
  const preTax = Math.max(0, Math.round(input.preTaxAmount || 0))
  const vat = Math.max(0, Math.round(input.vatAmount || 0))
  const total = Math.max(0, Math.round(input.totalAmount || preTax + vat))
  const docLabel = input.invoiceNumber ? `HĐ ${input.invoiceNumber}` : (input.merchant || "Chứng từ")

  if (input.regime === "HKD_2026") {
    const settle = (input.paymentMethod ?? "").toLowerCase().includes("tiền mặt") ? "S4-TM" : "S4-NH"
    if (input.direction === "output") {
      return [
        {
          debitAccount: settle,
          creditAccount: "S1-DT-PP",
          amountVnd: total,
          description: `Doanh thu bán hàng ${docLabel}`,
          taxCode: input.merchantTaxCode ?? undefined
        }
      ]
    }
    return [
      {
        debitAccount: "S2-CP-DV",
        creditAccount: settle,
        amountVnd: total,
        description: `Chi phí ${docLabel}`,
        taxCode: input.merchantTaxCode ?? undefined
      }
    ]
  }

  const settleAccount = resolveSettlementAccount(input.paymentMethod, input.paymentStatus, input.direction)
  const lines: JournalLineSuggestion[] = []

  if (input.direction === "input") {
    let debitAcc =
      input.counterpartyDefaultAccount ||
      input.categoryDefaultDebit ||
      CATEGORY_TO_DEBIT_ACCOUNT[input.categoryCode ?? "other"] ||
      "6428"

    // Under TT133, 641 is merged into 6421
    if (input.regime === "TT133_2016" && debitAcc === "641") {
      debitAcc = "6421"
    }

    const baseAmt = vat > 0 ? preTax : total
    if (baseAmt > 0) {
      lines.push({
        debitAccount: debitAcc,
        creditAccount: settleAccount,
        amountVnd: baseAmt,
        description: `Mua hàng/DV ${docLabel}`,
        taxCode: input.merchantTaxCode ?? undefined
      })
    }
    if (vat > 0) {
      lines.push({
        debitAccount: debitAcc === "211" ? "1332" : "1331",
        creditAccount: settleAccount,
        amountVnd: vat,
        description: `Thuế GTGT đầu vào được khấu trừ (${docLabel})`,
        taxCode: input.merchantTaxCode ?? undefined
      })
    }
  } else {
    const creditRevenueAcc = input.categoryCode === "goods" ? "5111" : "5113"
    const baseAmt = vat > 0 ? preTax : total
    if (baseAmt > 0) {
      lines.push({
        debitAccount: settleAccount,
        creditAccount: creditRevenueAcc,
        amountVnd: baseAmt,
        description: `Doanh thu ${docLabel}`,
        taxCode: input.merchantTaxCode ?? undefined
      })
    }
    if (vat > 0) {
      lines.push({
        debitAccount: settleAccount,
        creditAccount: "33311",
        amountVnd: vat,
        description: `Thuế GTGT đầu ra phải nộp (${docLabel})`,
        taxCode: input.merchantTaxCode ?? undefined
      })
    }
  }

  return lines
}

export function verifyJournalBalance(lines: Array<{ debitAccount: string; creditAccount: string; amountVnd: number }>): {
  balanced: boolean
  totalAmountVnd: number
} {
  let total = 0
  for (const line of lines) {
    if (!line.debitAccount || !line.creditAccount || line.amountVnd < 0) {
      return { balanced: false, totalAmountVnd: total }
    }
    total += line.amountVnd
  }
  return { balanced: lines.length > 0 && total >= 0, totalAmountVnd: total }
}
