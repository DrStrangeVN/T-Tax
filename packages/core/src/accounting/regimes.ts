import type { AccountingRegime, LegalRule } from "../types.js"

export interface AccountDefinition {
  code: string
  parentCode?: string
  name: string
  nature: "debit" | "credit" | "dual"
}

const CORE_VAS_ACCOUNTS: AccountDefinition[] = [
  { code: "111", name: "Tiền mặt", nature: "debit" },
  { code: "1111", parentCode: "111", name: "Tiền Việt Nam", nature: "debit" },
  { code: "1112", parentCode: "111", name: "Ngoại tệ", nature: "debit" },
  { code: "112", name: "Tiền gửi ngân hàng", nature: "debit" },
  { code: "1121", parentCode: "112", name: "Tiền Việt Nam tại ngân hàng", nature: "debit" },
  { code: "1122", parentCode: "112", name: "Ngoại tệ tại ngân hàng", nature: "debit" },
  { code: "131", name: "Phải thu của khách hàng", nature: "dual" },
  { code: "133", name: "Thuế GTGT được khấu trừ", nature: "debit" },
  { code: "1331", parentCode: "133", name: "Thuế GTGT được khấu trừ của hàng hóa, dịch vụ", nature: "debit" },
  { code: "1332", parentCode: "133", name: "Thuế GTGT được khấu trừ của TSCĐ", nature: "debit" },
  { code: "141", name: "Tạm ứng", nature: "debit" },
  { code: "152", name: "Nguyên liệu, vật liệu", nature: "debit" },
  { code: "153", name: "Công cụ, dụng cụ", nature: "debit" },
  { code: "156", name: "Hàng hóa", nature: "debit" },
  { code: "1561", parentCode: "156", name: "Giá mua hàng hóa", nature: "debit" },
  { code: "211", name: "Tài sản cố định hữu hình", nature: "debit" },
  { code: "213", name: "Tài sản cố định vô hình", nature: "debit" },
  { code: "242", name: "Chi phí trả trước", nature: "debit" },
  { code: "331", name: "Phải trả cho người bán", nature: "dual" },
  { code: "333", name: "Thuế và các khoản phải nộp Nhà nước", nature: "credit" },
  { code: "3331", parentCode: "333", name: "Thuế giá trị gia tăng phải nộp", nature: "credit" },
  { code: "33311", parentCode: "3331", name: "Thuế GTGT đầu ra", nature: "credit" },
  { code: "3334", parentCode: "333", name: "Thuế thu nhập doanh nghiệp", nature: "credit" },
  { code: "3335", parentCode: "333", name: "Thuế thu nhập cá nhân", nature: "credit" },
  { code: "334", name: "Phải trả người lao động", nature: "credit" },
  { code: "338", name: "Phải trả, phải nộp khác", nature: "dual" },
  { code: "411", name: "Vốn đầu tư của chủ sở hữu", nature: "credit" },
  { code: "421", name: "Lợi nhuận sau thuế chưa phân phối", nature: "dual" },
  { code: "511", name: "Doanh thu bán hàng và cung cấp dịch vụ", nature: "credit" },
  { code: "5111", parentCode: "511", name: "Doanh thu bán hàng hóa", nature: "credit" },
  { code: "5113", parentCode: "511", name: "Doanh thu cung cấp dịch vụ", nature: "credit" },
  { code: "515", name: "Doanh thu hoạt động tài chính", nature: "credit" },
  { code: "632", name: "Giá vốn hàng bán", nature: "debit" },
  { code: "635", name: "Chi phí tài chính", nature: "debit" },
  { code: "641", name: "Chi phí bán hàng", nature: "debit" },
  { code: "642", name: "Chi phí quản lý doanh nghiệp", nature: "debit" },
  { code: "6421", parentCode: "642", name: "Chi phí nhân viên quản lý", nature: "debit" },
  { code: "6422", parentCode: "642", name: "Chi phí vật liệu quản lý", nature: "debit" },
  { code: "6423", parentCode: "642", name: "Chi phí đồ dùng văn phòng", nature: "debit" },
  { code: "6425", parentCode: "642", name: "Thuế, phí và lệ phí", nature: "debit" },
  { code: "6427", parentCode: "642", name: "Chi phí dịch vụ mua ngoài", nature: "debit" },
  { code: "6428", parentCode: "642", name: "Chi phí bằng tiền khác", nature: "debit" },
  { code: "711", name: "Thu nhập khác", nature: "credit" },
  { code: "811", name: "Chi phí khác", nature: "debit" },
  { code: "821", name: "Chi phí thuế TNDN", nature: "debit" },
  { code: "911", name: "Xác định kết quả kinh doanh", nature: "dual" }
]

const TT99_EXTRA: AccountDefinition[] = [
  { code: "215", name: "Tài sản sinh học (TT 99/2025)", nature: "debit" },
  { code: "332", name: "Phải trả cổ tức, lợi nhuận (TT 99/2025)", nature: "credit" },
  { code: "138", name: "Phải thu khác", nature: "dual" },
  { code: "229", name: "Dự phòng tổn thất tài sản", nature: "credit" }
]

const TT133_ACCOUNTS: AccountDefinition[] = CORE_VAS_ACCOUNTS
  .filter((a) => !a.code.startsWith("641"))
  .concat([
    { code: "6421", parentCode: "642", name: "Chi phí bán hàng (TT 133)", nature: "debit" },
    { code: "6422", parentCode: "642", name: "Chi phí quản lý kinh doanh (TT 133)", nature: "debit" }
  ])

const HKD_ACCOUNTS: AccountDefinition[] = [
  { code: "S1-DT-PP", name: "Doanh thu phân phối, cung cấp hàng hóa (1% GTGT + 0.5% TNCN)", nature: "credit" },
  { code: "S1-DT-DV", name: "Doanh thu dịch vụ, xây dựng không bao thầu NVL (5% GTGT + 2% TNCN)", nature: "credit" },
  { code: "S1-DT-SX", name: "Doanh thu sản xuất, vận tải, ăn uống, DV gắn hàng hóa (3% GTGT + 1.5% TNCN)", nature: "credit" },
  { code: "S1-DT-KHAC", name: "Doanh thu hoạt động kinh doanh khác (2% GTGT + 1% TNCN)", nature: "credit" },
  { code: "S2-CP-NVL", name: "Chi phí nguyên vật liệu, hàng hóa (HKD)", nature: "debit" },
  { code: "S2-CP-NC", name: "Chi phí nhân công (HKD)", nature: "debit" },
  { code: "S2-CP-DV", name: "Chi phí điện, nước, thuê mặt bằng, dịch vụ mua ngoài (HKD)", nature: "debit" },
  { code: "S4-TM", name: "Sổ quỹ tiền mặt (HKD)", nature: "debit" },
  { code: "S4-NH", name: "Sổ tiền gửi ngân hàng (HKD)", nature: "debit" }
]

export function getAccountsForRegime(regime: AccountingRegime): AccountDefinition[] {
  switch (regime) {
    case "TT99_2025":
      return [...CORE_VAS_ACCOUNTS, ...TT99_EXTRA]
    case "TT200_2014":
      return CORE_VAS_ACCOUNTS
    case "TT133_2016":
      return TT133_ACCOUNTS
    case "HKD_2026":
      return HKD_ACCOUNTS
  }
}

export const HKD_TAX_SECTORS: Array<{
  code: "pp" | "dv" | "sx" | "khac"
  label: string
  vatRatePct: number
  pitRatePct: number
  accountCode: string
}> = [
  { code: "pp", label: "Phân phối, cung cấp hàng hóa (1% GTGT + 0.5% TNCN)", vatRatePct: 1, pitRatePct: 0.5, accountCode: "S1-DT-PP" },
  { code: "dv", label: "Dịch vụ, xây dựng không bao thầu NVL (5% GTGT + 2% TNCN)", vatRatePct: 5, pitRatePct: 2, accountCode: "S1-DT-DV" },
  { code: "sx", label: "Sản xuất, vận tải, ăn uống, DV gắn HH (3% GTGT + 1.5% TNCN)", vatRatePct: 3, pitRatePct: 1.5, accountCode: "S1-DT-SX" },
  { code: "khac", label: "Hoạt động kinh doanh khác (2% GTGT + 1% TNCN)", vatRatePct: 2, pitRatePct: 1, accountCode: "S1-DT-KHAC" }
]

export const REGIME_METADATA: Record<AccountingRegime, { label: string; circular: string; description: string }> = {
  TT99_2025: {
    label: "Thông tư 99/2025/TT-BTC",
    circular: "TT 99/2025/TT-BTC (hiệu lực từ năm TC 2026)",
    description: "Chế độ kế toán doanh nghiệp mới thay thế TT 200/2014."
  },
  TT200_2014: {
    label: "Thông tư 200/2014/TT-BTC",
    circular: "TT 200/2014/TT-BTC (kỳ chuyển tiếp / cũ)",
    description: "Chế độ kế toán doanh nghiệp áp dụng cho các kỳ trước 2026."
  },
  TT133_2016: {
    label: "Thông tư 133/2016/TT-BTC",
    circular: "TT 133/2016/TT-BTC",
    description: "Chế độ kế toán doanh nghiệp nhỏ và vừa."
  },
  HKD_2026: {
    label: "Hộ kinh doanh (Lộ trình kê khai 2026)",
    circular: "TT 88/2021 + NĐ 70/2025/NĐ-CP",
    description: "Sổ sách S1/S2/S4-HKD và hóa đơn máy tính tiền cho hộ kinh doanh."
  }
}

export const DEFAULT_VN_LEGAL_RULES: LegalRule[] = [
  {
    ruleKey: "einvoice_decree_70_2025",
    title: "Chuẩn Hóa đơn điện tử NĐ 70/2025 & TT 32/2025",
    documentRef: "70/2025/NĐ-CP & 32/2025/TT-BTC",
    effectiveFrom: "2025-06-01",
    expiresAt: "2027-03-01",
    replacedBy: null,
    payload: {
      cashRegisterThresholdVnd: 1_000_000_000,
      supportsBuyerCitizenId: true,
      supportsBudgetUnitCode: true
    }
  },
  {
    ruleKey: "accounting_regime_tt99_2025",
    title: "Chế độ kế toán doanh nghiệp TT 99/2025/TT-BTC",
    documentRef: "99/2025/TT-BTC",
    effectiveFrom: "2026-01-01",
    expiresAt: "2027-05-24",
    replacedBy: null,
    payload: {
      replaces: "200/2014/TT-BTC"
    }
  },
  {
    ruleKey: "vat_non_cash_threshold",
    title: "Ngưỡng chứng từ thanh toán không dùng tiền mặt",
    documentRef: "Luật Thuế GTGT 48/2024/QH15 & NĐ hướng dẫn",
    effectiveFrom: "2025-07-01",
    expiresAt: "2027-01-31",
    replacedBy: null,
    payload: {
      thresholdVnd: 20_000_000,
      note: "Có thể cấu hình lại theo ngưỡng thực tế của văn bản hướng dẫn hiệu lực hiện hành (ví dụ 5.000.000 hoặc 20.000.000 VND)."
    }
  },
  {
    ruleKey: "hkd_vat_exempt_threshold",
    title: "Ngưỡng doanh thu không chịu thuế GTGT/TNCN hộ kinh doanh",
    documentRef: "Luật 48/2024 -> Luật 149/2025 -> NĐ 141/2026 (TTL 60 ngày)",
    effectiveFrom: "2026-01-01",
    expiresAt: "2027-01-24",
    replacedBy: null,
    payload: {
      annualRevenueThresholdVnd: 500_000_000,
      note: "Ngưỡng HKD thay đổi thường xuyên; kiểm tra cập nhật định kỳ mỗi 60 ngày."
    }
  }
]

export function isLegalRuleExpired(rule: LegalRule, now = new Date()): boolean {
  const exp = new Date(rule.expiresAt)
  return Number.isNaN(exp.getTime()) ? true : now > exp
}
