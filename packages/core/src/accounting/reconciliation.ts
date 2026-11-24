import ExcelJS from "exceljs"
import { parse as parseCsvString } from "@fast-csv/parse"
import { differenceInCalendarDays, parseISO } from "date-fns"

export interface ParsedBankRow {
  txDate: string
  refNo?: string
  description: string
  debitAmount: number // Money out
  creditAmount: number // Money in
  balanceAmount?: number
}

export interface TransactionCandidate {
  id: string
  merchant?: string | null
  merchantTaxCode?: string | null
  invoiceNumber?: string | null
  direction: "input" | "output"
  totalAmount: number
  issuedAt?: string | null
  paymentStatus?: string | null
}

export interface BankMatchSuggestion {
  bankRowIndex: number
  transactionId: string
  confidence: number
  reason: string
}

function normalizeDateCell(raw: string): string {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/)
  if (dmy) {
    return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`
  }
  return s
}

function parseMoneyCell(raw: unknown): number {
  if (typeof raw === "number") return Math.round(Math.abs(raw))
  const s = String(raw ?? "").replace(/[^\d.-]/g, "")
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(Math.abs(n)) : 0
}

function detectColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) => h.toLowerCase().trim())
  return normalized.findIndex((h) => candidates.some((c) => h.includes(c)))
}

export async function parseBankStatementBuffer(
  filename: string,
  buffer: Buffer
): Promise<ParsedBankRow[]> {
  const rows: string[][] = []

  if (filename.toLowerCase().endsWith(".xlsx") || filename.toLowerCase().endsWith(".xls")) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as never)
    const sheet = wb.worksheets[0]
    if (!sheet) return []
    sheet.eachRow((row) => {
      const vals = (row.values as unknown[]).slice(1).map((v) => String(v ?? "").trim())
      if (vals.some(Boolean)) rows.push(vals)
    })
  } else {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "")
    await new Promise<void>((resolve, reject) => {
      const stream = parseCsvString({ headers: false, trim: true, ignoreEmpty: true })
        .on("error", reject)
        .on("data", (row: string[]) => rows.push(row))
        .on("end", () => resolve())
      stream.write(text)
      stream.end()
    })
  }

  // Locate header row (handles bank banners at top of VCB/TCB/MB exports)
  let headerIdx = -1
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const joined = rows[i]!.join(" ").toLowerCase()
    if (
      (joined.includes("ngày") || joined.includes("date")) &&
      (joined.includes("nội dung") || joined.includes("diễn giải") || joined.includes("description") || joined.includes("debit") || joined.includes("nợ"))
    ) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0 || headerIdx >= rows.length - 1) return []

  const headers = rows[headerIdx]!
  const dateCol = detectColumn(headers, ["ngày giao dịch", "ngày hiệu lực", "tx date", "date", "ngày"])
  const refCol = detectColumn(headers, ["số tham chiếu", "mã gd", "ref", "doc no", "số ct"])
  const descCol = detectColumn(headers, ["nội dung", "diễn giải", "description", "details", "remark"])
  const debitCol = detectColumn(headers, ["ghi nợ", "phát sinh nợ", "tiền ra", "debit", "rút tiền"])
  const creditCol = detectColumn(headers, ["ghi có", "phát sinh có", "tiền vào", "credit", "nộp tiền"])
  const amountCol = detectColumn(headers, ["số tiền", "amount"])
  const balCol = detectColumn(headers, ["số dư", "balance"])

  if (dateCol < 0 || descCol < 0) return []

  const parsed: ParsedBankRow[] = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!
    const dateVal = normalizeDateCell(r[dateCol] ?? "")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) continue

    let debitAmount = debitCol >= 0 ? parseMoneyCell(r[debitCol]) : 0
    let creditAmount = creditCol >= 0 ? parseMoneyCell(r[creditCol]) : 0

    if (debitCol < 0 && creditCol < 0 && amountCol >= 0) {
      const raw = String(r[amountCol] ?? "").trim()
      const num = parseMoneyCell(raw)
      if (raw.startsWith("-")) debitAmount = num
      else creditAmount = num
    }

    if (debitAmount === 0 && creditAmount === 0) continue

    parsed.push({
      txDate: dateVal,
      refNo: refCol >= 0 ? r[refCol] || undefined : undefined,
      description: r[descCol] ?? "",
      debitAmount,
      creditAmount,
      balanceAmount: balCol >= 0 ? parseMoneyCell(r[balCol]) : undefined
    })
  }

  return parsed
}

/**
 * 3-Way Match: Matches bank statement movements against invoices/transactions
 * using amount tolerance, date proximity (+/- 10 days), and invoice number / MST / merchant tokens.
 */
export function matchBankRowsToTransactions(
  bankRows: ParsedBankRow[],
  transactions: TransactionCandidate[]
): BankMatchSuggestion[] {
  const suggestions: BankMatchSuggestion[] = []
  const usedTxIds = new Set<string>()

  for (let idx = 0; idx < bankRows.length; idx++) {
    const row = bankRows[idx]!
    const descUpper = row.description.toUpperCase()
    let best: BankMatchSuggestion | undefined

    for (const tx of transactions) {
      if (usedTxIds.has(tx.id)) continue
      const expectedDirectionMatch =
        (tx.direction === "input" && row.debitAmount > 0) ||
        (tx.direction === "output" && row.creditAmount > 0)
      if (!expectedDirectionMatch) continue

      const bankAmt = tx.direction === "input" ? row.debitAmount : row.creditAmount
      const amtDiff = Math.abs(bankAmt - tx.totalAmount)
      // Allow small bank fee difference up to 55,000 VND
      if (amtDiff > 55_000) continue

      let score = amtDiff === 0 ? 0.65 : 0.4
      const reasons: string[] = [amtDiff === 0 ? "Khớp chính xác số tiền" : `Lệch ${amtDiff.toLocaleString("vi-VN")}₫`]

      if (tx.invoiceNumber && tx.invoiceNumber.length >= 3) {
        const cleanInv = tx.invoiceNumber.replace(/^0+/, "")
        if (descUpper.includes(tx.invoiceNumber.toUpperCase()) || (cleanInv.length >= 3 && descUpper.includes(cleanInv))) {
          score += 0.25
          reasons.push(`Khớp số HĐ ${tx.invoiceNumber}`)
        }
      }

      if (tx.merchantTaxCode && descUpper.includes(tx.merchantTaxCode.toUpperCase())) {
        score += 0.2
        reasons.push(`Khớp MST ${tx.merchantTaxCode}`)
      }

      if (tx.issuedAt) {
        try {
          const days = Math.abs(differenceInCalendarDays(parseISO(row.txDate), parseISO(tx.issuedAt)))
          if (days <= 3) score += 0.1
          else if (days <= 14) score += 0.05
          else score -= 0.15
        } catch {
          // Ignore date parse failure
        }
      }

      if (score >= 0.6 && (!best || score > best.confidence)) {
        best = {
          bankRowIndex: idx,
          transactionId: tx.id,
          confidence: Number(Math.min(1, score).toFixed(2)),
          reason: reasons.join(" · ")
        }
      }
    }

    if (best) {
      usedTxIds.add(best.transactionId)
      suggestions.push(best)
    }
  }

  return suggestions
}
