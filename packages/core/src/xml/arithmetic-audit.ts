import { Decimal } from "decimal.js"
import type { AuditIssue, ParsedEInvoice, XmlSignatureVerification } from "../types.js"

export interface AuditOptions {
  toleranceVnd?: number
  nonCashThresholdVnd?: number
  existingUniqueKeys?: Set<string>
  sellerRiskStatus?: "active" | "inactive" | "closed" | "risk_flagged" | "unknown"
  signatureVerification?: XmlSignatureVerification
}

export function auditParsedEInvoice(invoice: ParsedEInvoice, opts: AuditOptions = {}): {
  arithmeticValid: boolean
  arithmeticDiffVnd: number
  issues: AuditIssue[]
} {
  const tolerance = opts.toleranceVnd ?? 5
  const nonCashThreshold = opts.nonCashThresholdVnd ?? 20_000_000
  const issues: AuditIssue[] = []

  // 1. Check duplicate uniqueKey
  if (opts.existingUniqueKeys?.has(invoice.uniqueKey)) {
    issues.push({
      code: "DUPLICATE_INVOICE",
      severity: "error",
      message: `Hóa đơn trùng lặp (${invoice.uniqueKey}). Đã tồn tại trong sổ sách.`
    })
  }

  // 2. Check each line item arithmetic (SLuong * DGia - STCKhau ~= ThTien)
  for (const item of invoice.items) {
    if (item.nature === 4 || item.nature === 2) continue // Note or promotion line
    if (item.quantity !== undefined && item.unitPrice !== undefined) {
      try {
        const expectedRaw = new Decimal(item.quantity)
          .mul(item.unitPrice)
          .sub(item.discountAmount ?? 0)
        const expected = expectedRaw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
        const diff = Math.abs(expected - item.preTaxAmount)
        if (diff > tolerance && item.nature !== 3) {
          issues.push({
            code: "LINE_ARITHMETIC_MISMATCH",
            severity: "warning",
            field: `items[${item.index}]`,
            expected,
            actual: item.preTaxAmount,
            message: `Dòng #${item.index} (${item.name}): SL×ĐG − CK = ${expected.toLocaleString("vi-VN")} khác Thành tiền ${item.preTaxAmount.toLocaleString("vi-VN")}.`
          })
        }
      } catch {
        // Ignore unparseable decimals
      }
    }
  }

  // 3. Check sum of line items vs TgTCThue
  const computedSubtotal = invoice.items.reduce((acc, it) => {
    if (it.nature === 3) return acc - Math.abs(it.preTaxAmount)
    if (it.nature === 4 || it.nature === 2) return acc
    return acc + it.preTaxAmount
  }, 0)

  if (invoice.items.length > 0) {
    const subtotalDiff = Math.abs(computedSubtotal - invoice.totals.totalBeforeVat)
    if (subtotalDiff > tolerance) {
      issues.push({
        code: "SUBTOTAL_MISMATCH",
        severity: "error",
        field: "totalBeforeVat",
        expected: computedSubtotal,
        actual: invoice.totals.totalBeforeVat,
        message: `Tổng tiền hàng (${computedSubtotal.toLocaleString("vi-VN")}) lệch với TgTCThue (${invoice.totals.totalBeforeVat.toLocaleString("vi-VN")}).`
      })
    }
  }

  // 4. Check TgTCThue + TgTThue - TgCKTMai? vs TgTTTBSo
  const expectedPayable = invoice.totals.totalBeforeVat + invoice.totals.totalVat
  const payableDiff = Math.abs(expectedPayable - invoice.totals.totalPayable)
  if (payableDiff > tolerance) {
    issues.push({
      code: "TOTAL_PAYABLE_MISMATCH",
      severity: "error",
      field: "totalPayable",
      expected: expectedPayable,
      actual: invoice.totals.totalPayable,
      message: `Tiền trước thuế + VAT (${expectedPayable.toLocaleString("vi-VN")}) không khớp Tổng thanh toán (${invoice.totals.totalPayable.toLocaleString("vi-VN")}).`
    })
  }

  // 5. Coded invoice missing MCCQT
  if (invoice.decodedSymbol?.hasTaxAuthorityCode && !invoice.mccqt) {
    issues.push({
      code: "MISSING_MCCQT_FOR_CODED",
      severity: "warning",
      field: "mccqt",
      message: "Ký hiệu hóa đơn có mã CQT (C) nhưng XML chưa có thẻ MCCQT."
    })
  }

  // 6. Adjusted / replaced invoice notice
  if (invoice.relatedInvoice?.nature) {
    const kind = invoice.relatedInvoice.nature === 1 ? "thay thế" : "điều chỉnh"
    const refLabel = [invoice.relatedInvoice.templateCode, invoice.relatedInvoice.symbol, invoice.relatedInvoice.number]
      .filter(Boolean)
      .join("/")
    issues.push({
      code: "ADJUSTED_OR_REPLACED_INVOICE",
      severity: "warning",
      message: `Hóa đơn ${kind}${refLabel ? ` cho ${refLabel}` : ""}${invoice.relatedInvoice.issuedDate ? ` (${invoice.relatedInvoice.issuedDate})` : ""} — kiểm tra đối trừ tờ khai gốc để tránh cộng trùng.`
    })
  }

  // 7. Non-cash payment threshold warning (Decree 70/2025 / VAT deduction threshold)
  const pm = (invoice.paymentMethod ?? "").toLowerCase()
  const isCash = pm.includes("tiền mặt") || pm === "tm" || pm === "cash"
  const totalVnd =
    invoice.currencyCode === "VND"
      ? invoice.totals.totalPayable
      : new Decimal(invoice.totals.totalPayable).mul(invoice.exchangeRate || "1").toNumber()

  if (isCash && totalVnd >= nonCashThreshold) {
    issues.push({
      code: "NON_CASH_THRESHOLD_CASH",
      severity: "warning",
      field: "paymentMethod",
      message: `Hóa đơn ghi hình thức Tiền mặt từ ${nonCashThreshold.toLocaleString("vi-VN")} VND trở lên — cần chứng từ thanh toán không dùng tiền mặt để đủ điều kiện khấu trừ VAT.`
    })
  }

  // 8. Digital signature verification
  if (opts.signatureVerification) {
    if (opts.signatureVerification.status === "unsigned") {
      issues.push({
        code: "UNSIGNED_XML",
        severity: "warning",
        message: "Hóa đơn XML chưa được ký số."
      })
    } else if (opts.signatureVerification.status === "invalid") {
      issues.push({
        code: "INVALID_SIGNATURE",
        severity: "error",
        message: opts.signatureVerification.issues[0] ?? "Chữ ký số XML không hợp lệ."
      })
    }
  }

  // 9. Seller MST risk check
  if (opts.sellerRiskStatus && opts.sellerRiskStatus !== "active" && opts.sellerRiskStatus !== "unknown") {
    issues.push({
      code: "SELLER_MST_RISK",
      severity: "error",
      field: "sellerTaxCode",
      message: `Mã số thuế người bán (${invoice.seller.taxCode}) đang ở trạng thái rủi ro: ${opts.sellerRiskStatus}.`
    })
  }

  const arithmeticErrors = issues.filter(
    (i) => i.code === "SUBTOTAL_MISMATCH" || i.code === "TOTAL_PAYABLE_MISMATCH"
  )

  return {
    arithmeticValid: arithmeticErrors.length === 0,
    arithmeticDiffVnd: payableDiff,
    issues
  }
}
