import type {
  AgingBucketSummary,
  ArApAgingReport,
  CashflowAnalytics,
  CashflowForecastMonth,
  CounterpartyAgingRow,
  RecurringExpenseItem,
  SmartRuleDTO,
  TaxAuditAnomaly,
  TaxAuditReport
} from "../types.js"

export interface AuditTxInput {
  id: string
  name?: string | null
  description?: string | null
  merchant?: string | null
  merchantTaxCode?: string | null
  direction: string
  preTaxAmount: number
  vatAmount: number
  totalAmount: number
  convertedTotalVnd?: number | null
  currencyCode?: string | null
  invoiceSymbol?: string | null
  invoiceNumber?: string | null
  categoryCode?: string | null
  issuedAt?: string | null
  paymentMethod?: string | null
  paymentStatus?: string | null
  complianceStatus?: string | null
  complianceIssuesJson?: string | null
}

export interface AuditCounterpartyInput {
  taxCode: string
  name: string
  riskStatus: string
}

function normText(v: string | null | undefined): string {
  return (v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
}

function txVnd(tx: AuditTxInput): number {
  return Math.round(Number(tx.convertedTotalVnd ?? tx.totalAmount ?? 0))
}

function isCashPayment(method: string | null | undefined): boolean {
  const n = normText(method)
  if (!n) return false
  if (n.includes("chuyen khoan") || n.includes("ck") || n.includes("bank") || n.includes("the") || n.includes("card")) {
    return false
  }
  return n.includes("tien mat") || n === "tm" || n.includes("cash")
}

function daysBetween(dateA: string, dateB: string): number {
  const a = Date.parse(dateA)
  const b = Date.parse(dateB)
  if (Number.isNaN(a) || Number.isNaN(b)) return 9999
  return Math.round((b - a) / 86_400_000)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Deep Vietnam Tax & Ledger Anomaly Scanner (inspired by MISA AVA, Puzzle Accuracy Review & Ramp AP Audit).
 */
export function runLedgerTaxAudit(params: {
  transactions: AuditTxInput[]
  counterparties: AuditCounterpartyInput[]
  nonCashThresholdVnd?: number
}): TaxAuditReport {
  const anomalies: TaxAuditAnomaly[] = []
  const txs = params.transactions
  const cpRiskMap = new Map(params.counterparties.map((c) => [c.taxCode.trim(), c]))

  // 1. Duplicate invoice numbers per seller MST + symbol
  const invKeyMap = new Map<string, AuditTxInput[]>()
  for (const tx of txs) {
    const invNo = (tx.invoiceNumber ?? "").trim()
    if (!invNo) continue
    const key = `${tx.direction}|${(tx.merchantTaxCode ?? normText(tx.merchant)).trim()}|${(tx.invoiceSymbol ?? "").trim()}|${invNo}`
    const arr = invKeyMap.get(key) ?? []
    arr.push(tx)
    invKeyMap.set(key, arr)
  }
  for (const [, dupes] of invKeyMap) {
    if (dupes.length > 1) {
      const sample = dupes[0]!
      const extraCount = dupes.length - 1
      const totalAmt = dupes.reduce((s, t) => s + txVnd(t), 0)
      const vatRisk = dupes.slice(1).reduce((s, t) => s + Math.round(Number(t.vatAmount ?? 0)), 0)
      const citRisk = Math.round(dupes.slice(1).reduce((s, t) => s + Math.round(Number(t.preTaxAmount ?? 0)), 0) * 0.2)
      anomalies.push({
        id: `dup-inv-${sample.id}`,
        code: "DUPLICATE_INVOICE_NO",
        severity: "critical",
        title: `Trùng số hóa đơn ${sample.invoiceNumber} (${dupes.length} bản ghi)`,
        description: `Đối tác ${sample.merchant || sample.merchantTaxCode || "không rõ"} xuất hiện ${dupes.length} giao dịch cùng số hóa đơn ${sample.invoiceNumber}. Có nguy cơ kê khai trùng ${extraCount} lần.`,
        recommendation: "Kiểm tra lại chứng từ gốc trong Kho và xóa hoặc gộp bản ghi bị trùng trước khi nộp tờ khai GTGT.",
        transactionIds: dupes.map((d) => d.id),
        merchant: sample.merchant ?? undefined,
        merchantTaxCode: sample.merchantTaxCode ?? undefined,
        vatAtRiskVnd: sample.direction === "input" ? vatRisk : 0,
        citAtRiskVnd: sample.direction === "input" ? citRisk : 0,
        amountVnd: totalAmt
      })
    }
  }

  // 2. Duplicate payment suspect (same vendor + exact amount within 1 day, without invoice numbers matching above)
  const sortedByVendor = [...txs].sort((a, b) => (a.issuedAt ?? "").localeCompare(b.issuedAt ?? ""))
  const seenSuspectPairs = new Set<string>()
  for (let i = 0; i < sortedByVendor.length; i++) {
    const a = sortedByVendor[i]!
    const amtA = txVnd(a)
    if (amtA <= 0 || !a.issuedAt) continue
    for (let j = i + 1; j < sortedByVendor.length; j++) {
      const b = sortedByVendor[j]!
      if (!b.issuedAt) continue
      const diffDays = Math.abs(daysBetween(a.issuedAt, b.issuedAt))
      if (diffDays > 1) break
      if (
        a.direction === b.direction &&
        amtA === txVnd(b) &&
        normText(a.merchant) &&
        normText(a.merchant) === normText(b.merchant) &&
        (!a.invoiceNumber || !b.invoiceNumber || a.invoiceNumber !== b.invoiceNumber)
      ) {
        const pairKey = [a.id, b.id].sort().join("|")
        if (!seenSuspectPairs.has(pairKey)) {
          seenSuspectPairs.add(pairKey)
          anomalies.push({
            id: `dup-pay-${a.id}-${b.id}`,
            code: "DUPLICATE_PAYMENT_SUSPECT",
            severity: "high",
            title: `Nghi ngờ thanh toán trùng — ${a.merchant}`,
            description: `Hai giao dịch cùng đối tác và cùng số tiền ${amtA.toLocaleString("vi-VN")} đ trong vòng ${diffDays} ngày (${a.issuedAt} & ${b.issuedAt}).`,
            recommendation: "Xác nhận lại với sao kê ngân hàng xem có chuyển khoản hoặc hạch toán hai lần hay không.",
            transactionIds: [a.id, b.id],
            merchant: a.merchant ?? undefined,
            merchantTaxCode: a.merchantTaxCode ?? undefined,
            vatAtRiskVnd: a.direction === "input" ? Math.round(Number(b.vatAmount ?? 0)) : 0,
            citAtRiskVnd: a.direction === "input" ? Math.round(Number(b.preTaxAmount ?? 0) * 0.2) : 0,
            amountVnd: amtA
          })
        }
      }
    }
  }

  // 3. Per-transaction Vietnam tax rules: Non-cash threshold, arithmetic mismatch, MST risk, missing MST
  const vendorAmounts = new Map<string, AuditTxInput[]>()
  const vendorCategories = new Map<string, Map<string, AuditTxInput[]>>()

  for (const tx of txs) {
    const vnd = txVnd(tx)
    const issued = tx.issuedAt ?? ""
    // Luật Thuế GTGT 48/2024/QH15 hiệu lực từ 01/07/2025: ngưỡng chứng từ thanh toán không dùng tiền mặt 5.000.000 đ (trước đó 20.000.000 đ)
    const threshold = params.nonCashThresholdVnd ?? (issued >= "2025-07-01" ? 5_000_000 : 20_000_000)

    if (tx.direction === "input" && vnd >= threshold && isCashPayment(tx.paymentMethod)) {
      const vatRisk = Math.round(Number(tx.vatAmount ?? 0))
      const citRisk = Math.round(Number(tx.preTaxAmount ?? 0) * 0.2)
      anomalies.push({
        id: `cash-${tx.id}`,
        code: "NON_CASH_THRESHOLD_VIOLATION",
        severity: "critical",
        title: `Thanh toán tiền mặt vượt ngưỡng ${threshold.toLocaleString("vi-VN")} đ`,
        description: `HĐ ${tx.invoiceNumber || tx.name || tx.id} (${tx.merchant || "NCC"}) trị giá ${vnd.toLocaleString("vi-VN")} đ ghi nhận hình thức "${tx.paymentMethod}". Theo Luật GTGT 48/2024/QH15 & NĐ 181/2025, hóa đơn từ 5 triệu đồng trở lên cần chứng từ thanh toán không dùng tiền mặt để được khấu trừ VAT và tính chi phí được trừ TNDN.`,
        recommendation: "Kiểm tra lại ủy nhiệm chi ngân hàng; nếu thực tế đã chuyển khoản hãy cập nhật hình thức thanh toán và gắn khớp sao kê.",
        transactionIds: [tx.id],
        merchant: tx.merchant ?? undefined,
        merchantTaxCode: tx.merchantTaxCode ?? undefined,
        vatAtRiskVnd: vatRisk,
        citAtRiskVnd: citRisk,
        amountVnd: vnd
      })
    }

    // Arithmetic check
    if (tx.currencyCode === "VND" || !tx.currencyCode) {
      const diff = Math.abs(Math.round(tx.preTaxAmount + tx.vatAmount) - Math.round(tx.totalAmount))
      if (diff > 2 && tx.totalAmount > 0) {
        anomalies.push({
          id: `math-${tx.id}`,
          code: "ARITHMETIC_MISMATCH",
          severity: "high",
          title: `Lệch số học Trước thuế + VAT ≠ Tổng (${diff.toLocaleString("vi-VN")} đ)`,
          description: `Giao dịch ${tx.invoiceNumber || tx.name || tx.id}: ${tx.preTaxAmount.toLocaleString("vi-VN")} + ${tx.vatAmount.toLocaleString("vi-VN")} ≠ ${tx.totalAmount.toLocaleString("vi-VN")} đ.`,
          recommendation: "Mở Inspector giao dịch để điều chỉnh lại Tiền trước thuế hoặc Thuế GTGT khớp với hóa đơn gốc.",
          transactionIds: [tx.id],
          merchant: tx.merchant ?? undefined,
          merchantTaxCode: tx.merchantTaxCode ?? undefined,
          vatAtRiskVnd: diff,
          citAtRiskVnd: 0,
          amountVnd: vnd
        })
      }
    }

    // Counterparty MST risk
    const mst = (tx.merchantTaxCode ?? "").trim()
    if (mst) {
      const cp = cpRiskMap.get(mst)
      if (cp && (cp.riskStatus === "closed" || cp.riskStatus === "inactive" || cp.riskStatus === "risk_flagged")) {
        anomalies.push({
          id: `mst-risk-${tx.id}`,
          code: "COUNTERPARTY_MST_RISK",
          severity: "critical",
          title: `Đối tác MST rủi ro (${cp.riskStatus}): ${cp.name}`,
          description: `Hóa đơn ${tx.invoiceNumber || tx.id} phát sinh với MST ${mst} đang có trạng thái "${cp.riskStatus}". Cơ quan thuế có thể loại chi phí và truy thu VAT.`,
          recommendation: "Xác minh tình trạng hoạt động của người bán tại thời điểm xuất hóa đơn và lưu hồ sơ giải trình (hợp đồng, biên bản giao nhận, UNC).",
          transactionIds: [tx.id],
          merchant: tx.merchant ?? cp.name,
          merchantTaxCode: mst,
          vatAtRiskVnd: tx.direction === "input" ? Math.round(Number(tx.vatAmount ?? 0)) : 0,
          citAtRiskVnd: tx.direction === "input" ? Math.round(Number(tx.preTaxAmount ?? 0) * 0.2) : 0,
          amountVnd: vnd
        })
      }
    } else if (tx.direction === "input" && vnd >= 2_000_000 && Number(tx.vatAmount ?? 0) > 0) {
      anomalies.push({
        id: `missing-mst-${tx.id}`,
        code: "MISSING_MST_HIGH_VALUE",
        severity: "medium",
        title: `Hóa đơn có VAT thiếu Mã số thuế người bán`,
        description: `Chứng từ "${tx.name || tx.merchant || tx.id}" trị giá ${vnd.toLocaleString("vi-VN")} đ có thuế GTGT ${Number(tx.vatAmount).toLocaleString("vi-VN")} đ nhưng chưa nhập MST nhà cung cấp.`,
        recommendation: "Bổ sung MST người bán để đảm bảo hợp lệ khi kết xuất Bảng kê HTKK / MISA.",
        transactionIds: [tx.id],
        merchant: tx.merchant ?? undefined,
        vatAtRiskVnd: Math.round(Number(tx.vatAmount ?? 0)),
        citAtRiskVnd: 0,
        amountVnd: vnd
      })
    }

    // Existing compliance error/warning from XMLDSig / MCCQT audit
    if (tx.complianceStatus === "error" || tx.complianceStatus === "warning") {
      let issuesCount = 1
      let firstMsg = "Cảnh báo tuân thủ hóa đơn điện tử."
      if (tx.complianceIssuesJson) {
        try {
          const parsed = JSON.parse(tx.complianceIssuesJson) as Array<{ message?: string }>
          if (Array.isArray(parsed) && parsed.length > 0) {
            issuesCount = parsed.length
            firstMsg = parsed[0]?.message || firstMsg
          }
        } catch {
          // ignore
        }
      }
      anomalies.push({
        id: `comp-${tx.id}`,
        code: "COMPLIANCE_FLAGGED",
        severity: tx.complianceStatus === "error" ? "high" : "medium",
        title: `${tx.complianceStatus === "error" ? "Lỗi" : "Cảnh báo"} tuân thủ HĐ ${tx.invoiceNumber || tx.name || tx.id}`,
        description: `${firstMsg}${issuesCount > 1 ? ` (+${issuesCount - 1} lưu ý khác)` : ""}`,
        recommendation: "Kiểm tra tab Mặt hàng & Cảnh báo trong Sổ giao dịch và đối chiếu chữ ký số / MCCQT trên Cổng Tổng cục Thuế.",
        transactionIds: [tx.id],
        merchant: tx.merchant ?? undefined,
        merchantTaxCode: tx.merchantTaxCode ?? undefined,
        vatAtRiskVnd: tx.complianceStatus === "error" && tx.direction === "input" ? Math.round(Number(tx.vatAmount ?? 0)) : 0,
        citAtRiskVnd: 0,
        amountVnd: vnd
      })
    }

    // Group by vendor for category drift & amount spikes
    const vendorKey = mst || normText(tx.merchant)
    if (vendorKey) {
      const list = vendorAmounts.get(vendorKey) ?? []
      list.push(tx)
      vendorAmounts.set(vendorKey, list)

      if (tx.direction === "input" && tx.categoryCode) {
        const cMap = vendorCategories.get(vendorKey) ?? new Map<string, AuditTxInput[]>()
        const cArr = cMap.get(tx.categoryCode) ?? []
        cArr.push(tx)
        cMap.set(tx.categoryCode, cArr)
        vendorCategories.set(vendorKey, cMap)
      }
    }
  }

  // 4. Puzzle.io Accuracy Review: Vendor Category Drift
  for (const [, cMap] of vendorCategories) {
    if (cMap.size >= 2) {
      const allVendorTx = [...cMap.values()].flat()
      const sample = allVendorTx[0]!
      const cats = [...cMap.keys()]
      anomalies.push({
        id: `drift-${sample.merchantTaxCode || normText(sample.merchant)}`,
        code: "VENDOR_CATEGORY_DRIFT",
        severity: "info",
        title: `Phân loại danh mục không đồng nhất — ${sample.merchant || sample.merchantTaxCode}`,
        description: `Cùng đối tác nhưng đang hạch toán vào ${cats.length} danh mục khác nhau (${cats.join(", ")}).`,
        recommendation: "Tạo Quy tắc tự động (Smart Rule) hoặc đặt danh mục mặc định trong mục Đối tác MST để thống nhất định khoản VAS.",
        transactionIds: allVendorTx.map((t) => t.id),
        merchant: sample.merchant ?? undefined,
        merchantTaxCode: sample.merchantTaxCode ?? undefined,
        vatAtRiskVnd: 0,
        citAtRiskVnd: 0,
        amountVnd: allVendorTx.reduce((s, t) => s + txVnd(t), 0)
      })
    }
  }

  // 5. Ramp AP Audit: Unusual Amount Spike (> 2.5x historical median for same vendor with >= 3 invoices)
  for (const [, vTxs] of vendorAmounts) {
    if (vTxs.length < 3) continue
    const amounts = vTxs.map(txVnd).filter((n) => n > 0)
    const med = median(amounts)
    if (med <= 0) continue
    for (const tx of vTxs) {
      const amt = txVnd(tx)
      if (amt >= 3_000_000 && amt > med * 2.5) {
        anomalies.push({
          id: `spike-${tx.id}`,
          code: "AMOUNT_SPIKE_ANOMALY",
          severity: "medium",
          title: `Giá trị tăng đột biến (${(amt / med).toFixed(1)}× trung vị) — ${tx.merchant || tx.merchantTaxCode}`,
          description: `HĐ ${tx.invoiceNumber || tx.id} trị giá ${amt.toLocaleString("vi-VN")} đ so với mức trung vị ${Math.round(med).toLocaleString("vi-VN")} đ của nhà cung cấp này.`,
          recommendation: "Xác nhận lại đơn giá, số lượng hoặc hợp đồng phụ lục phát sinh bất thường.",
          transactionIds: [tx.id],
          merchant: tx.merchant ?? undefined,
          merchantTaxCode: tx.merchantTaxCode ?? undefined,
          vatAtRiskVnd: 0,
          citAtRiskVnd: 0,
          amountVnd: amt
        })
      }
    }
  }

  const severityOrder: Record<TaxAuditAnomaly["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    info: 3
  }
  anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.amountVnd - a.amountVnd)

  const summary = {
    critical: anomalies.filter((a) => a.severity === "critical").length,
    high: anomalies.filter((a) => a.severity === "high").length,
    medium: anomalies.filter((a) => a.severity === "medium").length,
    info: anomalies.filter((a) => a.severity === "info").length,
    totalVatAtRiskVnd: anomalies.reduce((s, a) => s + a.vatAtRiskVnd, 0),
    totalCitAtRiskVnd: anomalies.reduce((s, a) => s + a.citAtRiskVnd, 0)
  }

  const penalty = summary.critical * 14 + summary.high * 7 + summary.medium * 3 + summary.info * 1
  const healthScore = Math.max(0, Math.min(100, 100 - penalty))

  return {
    scannedAt: new Date().toISOString(),
    totalTransactions: txs.length,
    healthScore,
    summary,
    anomalies
  }
}

/**
 * Midday / Puzzle inspired Cashflow Forecast, Burn Rate, Runway & Recurring Expense Intelligence.
 */
export function computeCashflowAnalytics(params: {
  currentCashVnd: number
  monthlySeries: Array<{ period: string; revenue: number; expense: number; vatOut: number; vatIn: number }>
  transactions: AuditTxInput[]
  forecastMonthsCount?: number
  asOfDate?: string
}): CashflowAnalytics {
  const count = Math.max(1, Math.min(12, params.forecastMonthsCount ?? 6))
  const series = params.monthlySeries.slice(-6)
  const monthsObserved = Math.max(1, series.length)

  const avgRev = Math.round(series.reduce((s, m) => s + m.revenue, 0) / monthsObserved)
  const avgBurn = Math.round(series.reduce((s, m) => s + m.expense, 0) / monthsObserved)
  const avgVatOut = Math.round(series.reduce((s, m) => s + m.vatOut, 0) / monthsObserved)
  const avgVatIn = Math.round(series.reduce((s, m) => s + m.vatIn, 0) / monthsObserved)
  const netMonthly = avgRev - avgBurn

  const runwayMonths =
    netMonthly >= 0 ? null : params.currentCashVnd <= 0 ? 0 : Number((params.currentCashVnd / Math.abs(netMonthly)).toFixed(1))

  // Detect recurring expenses (same vendor billed >= 2 times with periodic cadence or tight amount variance)
  const byVendor = new Map<string, AuditTxInput[]>()
  for (const tx of params.transactions) {
    if (tx.direction === "output" || !tx.issuedAt) continue
    const key = (tx.merchantTaxCode ?? "").trim() || normText(tx.merchant)
    if (!key) continue
    const arr = byVendor.get(key) ?? []
    arr.push(tx)
    byVendor.set(key, arr)
  }

  const recurringExpenses: RecurringExpenseItem[] = []
  for (const [, list] of byVendor) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => (a.issuedAt ?? "").localeCompare(b.issuedAt ?? ""))
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      const g = daysBetween(sorted[i - 1]!.issuedAt!, sorted[i]!.issuedAt!)
      if (g >= 5 && g <= 100) gaps.push(g)
    }
    if (gaps.length === 0) continue
    const avgGap = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
    const amts = sorted.map(txVnd).filter((v) => v > 0)
    if (amts.length === 0) continue
    const avgAmt = Math.round(amts.reduce((s, v) => s + v, 0) / amts.length)
    const maxDev = Math.max(...amts.map((v) => Math.abs(v - avgAmt) / Math.max(1, avgAmt)))
    const isMonthlyLike = avgGap >= 20 && avgGap <= 42
    if (!isMonthlyLike && maxDev > 0.35) continue

    const lastDate = sorted[sorted.length - 1]!.issuedAt!
    const nextTs = Date.parse(lastDate) + avgGap * 86_400_000
    const nextExpectedAt = Number.isNaN(nextTs) ? lastDate : new Date(nextTs).toISOString().slice(0, 10)
    const monthlyEst = Math.round((avgAmt * 30) / Math.max(7, avgGap))
    const sample = sorted[sorted.length - 1]!
    recurringExpenses.push({
      merchant: sample.merchant || sample.name || "Chi phí định kỳ",
      merchantTaxCode: sample.merchantTaxCode ?? undefined,
      categoryCode: sample.categoryCode ?? undefined,
      occurrences: sorted.length,
      averageAmountVnd: avgAmt,
      estimatedMonthlyVnd: monthlyEst,
      intervalDays: avgGap,
      lastIssuedAt: lastDate,
      nextExpectedAt,
      confidence: isMonthlyLike && maxDev <= 0.2 ? "high" : "medium"
    })
  }
  recurringExpenses.sort((a, b) => b.estimatedMonthlyVnd - a.estimatedMonthlyVnd)
  const recurringMonthlyTotalVnd = recurringExpenses.reduce((s, r) => s + r.estimatedMonthlyVnd, 0)

  // Forward projection
  const baseDate = params.asOfDate ? new Date(params.asOfDate) : new Date()
  let runningCash = params.currentCashVnd
  const forecastMonths: CashflowForecastMonth[] = []
  const projExpenseMonthly = Math.max(avgBurn, recurringMonthlyTotalVnd)
  const projVatMonthly = Math.max(0, avgVatOut - avgVatIn)
  const monthlyOperatingPreTax = Math.max(0, (avgRev - avgVatOut) - (projExpenseMonthly - avgVatIn))
  const monthlyCitReserve = Math.round(monthlyOperatingPreTax * 0.2)

  for (let i = 1; i <= count; i++) {
    const dt = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, 1)
    const period = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`
    const isQuarterTaxMonth = [1, 4, 7, 10].includes(dt.getMonth() + 1)
    const citOut = isQuarterTaxMonth ? monthlyCitReserve * 3 : 0
    const net = avgRev - projExpenseMonthly - projVatMonthly - citOut
    runningCash += net
    forecastMonths.push({
      period,
      projectedRevenueVnd: avgRev,
      projectedExpenseVnd: projExpenseMonthly,
      projectedVatPayableVnd: projVatMonthly,
      projectedCitEstimateVnd: citOut,
      netCashflowVnd: net,
      endingCashBalanceVnd: runningCash
    })
  }

  return {
    currentCashVnd: params.currentCashVnd,
    averageMonthlyRevenueVnd: avgRev,
    averageMonthlyBurnVnd: avgBurn,
    netMonthlyCashflowVnd: netMonthly,
    runwayMonths,
    recurringMonthlyTotalVnd,
    recurringExpenses: recurringExpenses.slice(0, 20),
    forecastMonths,
    estimatedQuarterlyCitVnd: monthlyCitReserve * 3,
    estimatedVatPayableVnd: Math.max(0, avgVatOut - avgVatIn)
  }
}

function emptyBuckets(): AgingBucketSummary {
  return { current0To30: 0, days31To60: 0, days61To90: 0, over90: 0, total: 0 }
}

function addBucket(target: AgingBucketSummary, ageDays: number, amt: number) {
  if (ageDays <= 30) target.current0To30 += amt
  else if (ageDays <= 60) target.days31To60 += amt
  else if (ageDays <= 90) target.days61To90 += amt
  else target.over90 += amt
  target.total += amt
}

/**
 * MISA AMIS / Fast Accounting style AR (Phải thu 131) & AP (Phải trả 331) Aging Analysis.
 */
export function computeArApAging(params: {
  transactions: AuditTxInput[]
  asOfDate?: string
}): ArApAgingReport {
  const asOfDate = params.asOfDate || new Date().toISOString().slice(0, 10)
  const receivableBuckets = emptyBuckets()
  const payableBuckets = emptyBuckets()
  const rowMap = new Map<string, CounterpartyAgingRow>()

  for (const tx of params.transactions) {
    if (tx.paymentStatus === "paid") continue
    const amt = txVnd(tx)
    if (amt <= 0) continue
    const isAr = tx.direction === "output"
    const dir: "receivable" | "payable" = isAr ? "receivable" : "payable"
    const issued = tx.issuedAt || asOfDate
    const age = Math.max(0, daysBetween(issued, asOfDate))

    addBucket(isAr ? receivableBuckets : payableBuckets, age, amt)

    const taxCode = (tx.merchantTaxCode ?? "").trim()
    const name = (tx.merchant || tx.name || "Đối tác lẻ").trim()
    const key = `${dir}|${taxCode || normText(name)}`
    let row = rowMap.get(key)
    if (!row) {
      row = {
        counterpartyKey: key,
        name,
        taxCode,
        direction: dir,
        invoiceCount: 0,
        oldestDate: issued,
        buckets: emptyBuckets(),
        transactionIds: []
      }
      rowMap.set(key, row)
    }
    row.invoiceCount += 1
    if (issued < row.oldestDate) row.oldestDate = issued
    addBucket(row.buckets, age, amt)
    row.transactionIds.push(tx.id)
  }

  const rows = [...rowMap.values()].sort((a, b) => b.buckets.total - a.buckets.total)

  return {
    asOfDate,
    receivableTotal: receivableBuckets.total,
    payableTotal: payableBuckets.total,
    receivableBuckets,
    payableBuckets,
    rows
  }
}

/**
 * Actual Budget / MISA AVA inspired Smart Rule matching engine.
 */
export function matchSmartRule(
  rules: SmartRuleDTO[],
  candidate: {
    direction?: string
    merchant?: string | null
    merchantTaxCode?: string | null
    name?: string | null
    description?: string | null
  }
): SmartRuleDTO | null {
  const active = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority)
  for (const rule of active) {
    if (rule.direction !== "all" && candidate.direction && rule.direction !== candidate.direction) {
      continue
    }
    const patternRaw = rule.pattern.trim()
    if (!patternRaw) continue
    const haystacks: string[] = []
    if (rule.matchField === "merchant" || rule.matchField === "any") haystacks.push(candidate.merchant ?? "")
    if (rule.matchField === "merchantTaxCode" || rule.matchField === "any") haystacks.push(candidate.merchantTaxCode ?? "")
    if (rule.matchField === "name" || rule.matchField === "any") haystacks.push(candidate.name ?? "")
    if (rule.matchField === "description" || rule.matchField === "any") haystacks.push(candidate.description ?? "")

    const matched = haystacks.some((h) => {
      if (!h) return false
      if (rule.matchType === "equals") {
        return normText(h) === normText(patternRaw)
      }
      if (rule.matchType === "regex") {
        try {
          return new RegExp(patternRaw, "i").test(h)
        } catch {
          return false
        }
      }
      return normText(h).includes(normText(patternRaw))
    })

    if (matched) return rule
  }
  return null
}

/**
 * Proposes new Smart Rules by analyzing consistent past categorizations.
 */
export function proposeSmartRulesFromHistory(
  transactions: AuditTxInput[],
  existingRules: SmartRuleDTO[]
): Array<{
  name: string
  matchField: "merchantTaxCode" | "merchant"
  pattern: string
  direction: "input" | "output"
  assignCategoryCode: string
  occurrences: number
}> {
  const existingPatterns = new Set(existingRules.map((r) => normText(r.pattern)))
  const groups = new Map<
    string,
    { label: string; field: "merchantTaxCode" | "merchant"; pattern: string; direction: "input" | "output"; cats: Map<string, number> }
  >()

  for (const tx of transactions) {
    if (!tx.categoryCode) continue
    const mst = (tx.merchantTaxCode ?? "").trim()
    const merch = (tx.merchant ?? "").trim()
    const pattern = mst || merch
    if (!pattern || existingPatterns.has(normText(pattern))) continue
    const dir: "input" | "output" = tx.direction === "output" ? "output" : "input"
    const key = `${dir}|${normText(pattern)}`
    let g = groups.get(key)
    if (!g) {
      g = {
        label: merch || mst,
        field: mst ? "merchantTaxCode" : "merchant",
        pattern,
        direction: dir,
        cats: new Map()
      }
      groups.set(key, g)
    }
    g.cats.set(tx.categoryCode, (g.cats.get(tx.categoryCode) ?? 0) + 1)
  }

  const proposals: Array<{
    name: string
    matchField: "merchantTaxCode" | "merchant"
    pattern: string
    direction: "input" | "output"
    assignCategoryCode: string
    occurrences: number
  }> = []

  for (const [, g] of groups) {
    const entries = [...g.cats.entries()].sort((a, b) => b[1] - a[1])
    const top = entries[0]
    if (!top) continue
    const total = entries.reduce((s, [, c]) => s + c, 0)
    if (total >= 2 && top[1] / total >= 0.75) {
      proposals.push({
        name: `Tự động: ${g.label.slice(0, 40)}`,
        matchField: g.field,
        pattern: g.pattern,
        direction: g.direction,
        assignCategoryCode: top[0],
        occurrences: total
      })
    }
  }

  return proposals.sort((a, b) => b.occurrences - a.occurrences).slice(0, 10)
}
