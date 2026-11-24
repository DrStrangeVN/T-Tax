export function formatMoney(amount: number | null | undefined, currency = "VND"): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—"
  const cur = currency.toUpperCase()
  const decimals = cur === "VND" || cur === "JPY" || cur === "KRW" ? 0 : 2
  const formatted = new Intl.NumberFormat("vi-VN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(amount)
  if (cur === "VND") return `${formatted} ₫`
  return `${formatted} ${cur}`
}

export function formatShortVnd(amount: number): string {
  const abs = Math.abs(amount)
  const sign = amount < 0 ? "-" : ""
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)} tỷ`
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)} tr`
  return `${sign}${new Intl.NumberFormat("vi-VN").format(abs)} ₫`
}

export function formatDateVi(iso: string | null | undefined): string {
  if (!iso) return "—"
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return iso
  return `${m[3]}/${m[2]}/${m[1]}`
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
