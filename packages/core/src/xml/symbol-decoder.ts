import type { DecodedInvoiceSymbol } from "../types.js"

const TEMPLATE_LABELS: Record<string, string> = {
  "1": "Hóa đơn giá trị gia tăng (GTGT)",
  "2": "Hóa đơn bán hàng",
  "3": "Hóa đơn điện tử bán tài sản công",
  "4": "Hóa đơn điện tử bán hàng dự trữ quốc gia",
  "5": "Tem điện tử / Vé điện tử / Thẻ điện tử / Phiếu thu",
  "6": "Phiếu xuất kho kiêm vận chuyển nội bộ / gửi bán đại lý"
}

const KIND_LABELS: Record<string, string> = {
  T: "Hóa đơn do tổ chức, cá nhân đăng ký sử dụng",
  D: "Hóa đơn bán tài sản công / dự trữ quốc gia / đặc thù",
  L: "Hóa đơn cấp theo từng lần phát sinh của CQT",
  M: "Hóa đơn khởi tạo từ máy tính tiền (NĐ 70/2025)",
  N: "Phiếu xuất kho kiêm vận chuyển nội bộ",
  B: "Phiếu xuất kho hàng gửi bán đại lý",
  G: "Tem, vé, thẻ điện tử là hóa đơn GTGT",
  H: "Tem, vé, thẻ điện tử là hóa đơn bán hàng"
}

export function decodeTemplateCode(code: string): string {
  const clean = code.trim()
  return TEMPLATE_LABELS[clean] ?? `Mẫu số ${clean || "không xác định"}`
}

/**
 * Decodes Circular 78 / Circular 32 / Decree 70 symbol (`1C26TAA` or `C26TAA`).
 */
export function decodeInvoiceSymbol(rawSymbol: string, rawTemplateCode?: string): DecodedInvoiceSymbol | undefined {
  const cleaned = rawSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
  let templateCode = rawTemplateCode?.trim() || ""
  let symbol6 = cleaned

  if (cleaned.length === 7 && /^[1-6]/.test(cleaned)) {
    templateCode = templateCode || cleaned[0]!
    symbol6 = cleaned.slice(1)
  } else if (cleaned.length === 6) {
    templateCode = templateCode || "1"
  } else {
    return undefined
  }

  const codeFlag = symbol6[0]
  const yearDigits = symbol6.slice(1, 3)
  const kindCode = symbol6[3]
  const managementCode = symbol6.slice(4, 6)

  if ((codeFlag !== "C" && codeFlag !== "K") || !/^\d{2}$/.test(yearDigits) || !kindCode) {
    return undefined
  }

  return {
    templateCode,
    templateLabel: decodeTemplateCode(templateCode),
    fullSymbol: symbol6,
    hasTaxAuthorityCode: codeFlag === "C",
    year: 2000 + Number(yearDigits),
    kindCode,
    kindLabel: KIND_LABELS[kindCode] ?? `Ký hiệu loại ${kindCode}`,
    managementCode,
    isCashRegister: kindCode === "M"
  }
}
