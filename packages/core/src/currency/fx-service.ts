import { Decimal } from "decimal.js"
import { format, isSameDay, subDays } from "date-fns"

export interface ExchangeRateResult {
  rate: string
  source: string
  rateDate: string
  cached: boolean
}

async function fetchFromVietcombankToday(fromCurrency: string, toCurrency: string): Promise<string | null> {
  const from = fromCurrency.toUpperCase()
  const to = toCurrency.toUpperCase()
  if (from !== "VND" && to !== "VND") return null

  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 4500)
    const res = await fetch("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx", {
      signal: controller.signal
    })
    clearTimeout(t)
    if (!res.ok) return null
    const xml = await res.text()
    const targetCode = from === "VND" ? to : from
    const re = new RegExp(`CurrencyCode="${targetCode}"[^>]*Transfer="([\\d,.]+)"`, "i")
    const m = xml.match(re)
    if (!m?.[1]) return null
    const rateToVnd = new Decimal(m[1].replace(/,/g, ""))
    if (!rateToVnd.isFinite() || rateToVnd.lte(0)) return null
    if (to === "VND") return rateToVnd.toString()
    return new Decimal(1).div(rateToVnd).toSignificantDigits(8).toString()
  } catch {
    return null
  }
}

async function fetchFromCurrencyApi(fromCurrency: string, toCurrency: string, dateStr: string): Promise<string | null> {
  const from = fromCurrency.toLowerCase()
  const to = toCurrency.toLowerCase()
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${from}.min.json`,
    `https://${dateStr}.currency-api.pages.dev/v1/currencies/${from}.min.json`
  ]

  for (const url of urls) {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(t)
      if (!res.ok) continue
      const data = (await res.json()) as Record<string, Record<string, number>>
      const val = data?.[from]?.[to]
      if (typeof val === "number" && Number.isFinite(val)) {
        return new Decimal(val).toString()
      }
    } catch {
      // try next mirror
    }
  }
  return null
}

async function fetchFromFrankfurter(fromCurrency: string, toCurrency: string, dateStr: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(
      `https://api.frankfurter.dev/v1/${dateStr}?base=${encodeURIComponent(fromCurrency.toUpperCase())}&symbols=${encodeURIComponent(toCurrency.toUpperCase())}`,
      { signal: controller.signal }
    )
    clearTimeout(t)
    if (!res.ok) return null
    const data = (await res.json()) as { rates?: Record<string, number> }
    const val = data?.rates?.[toCurrency.toUpperCase()]
    return typeof val === "number" ? new Decimal(val).toString() : null
  } catch {
    return null
  }
}

export interface FxCacheAdapter {
  get(from: string, to: string, dateStr: string): Promise<ExchangeRateResult | null>
  set(from: string, to: string, dateStr: string, rate: string, source: string): Promise<void>
}

export async function getHistoricalExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  dateInput: string | Date,
  cache?: FxCacheAdapter
): Promise<ExchangeRateResult> {
  const from = fromCurrency.trim().toUpperCase()
  const to = toCurrency.trim().toUpperCase()

  let dt = typeof dateInput === "string" ? new Date(dateInput) : dateInput
  if (Number.isNaN(dt.getTime())) dt = new Date()
  if (isSameDay(dt, new Date())) {
    // Today's historical EOD rate often not finalized yet; check VCB live or fallback to yesterday
    const vcbLive = await fetchFromVietcombankToday(from, to)
    const todayStr = format(dt, "yyyy-MM-dd")
    if (vcbLive) {
      await cache?.set(from, to, todayStr, vcbLive, "vietcombank")
      return { rate: vcbLive, source: "vietcombank", rateDate: todayStr, cached: false }
    }
    dt = subDays(dt, 1)
  }

  const dateStr = format(dt, "yyyy-MM-dd")
  if (from === to) {
    return { rate: "1", source: "identity", rateDate: dateStr, cached: true }
  }

  const cached = await cache?.get(from, to, dateStr)
  if (cached) return cached

  const apiRate = await fetchFromCurrencyApi(from, to, dateStr)
  if (apiRate) {
    await cache?.set(from, to, dateStr, apiRate, "currency-api")
    return { rate: apiRate, source: "currency-api", rateDate: dateStr, cached: false }
  }

  const frankRate = await fetchFromFrankfurter(from, to, dateStr)
  if (frankRate) {
    await cache?.set(from, to, dateStr, frankRate, "frankfurter")
    return { rate: frankRate, source: "frankfurter", rateDate: dateStr, cached: false }
  }

  throw new Error(`Không tìm thấy tỷ giá ${from} → ${to} cho ngày ${dateStr}`)
}

export function convertAmount(amount: number, rateDecimal: string, toCurrency: string): number {
  const d = new Decimal(amount || 0).mul(rateDecimal || "1")
  if (toCurrency.toUpperCase() === "VND" || toCurrency.toUpperCase() === "JPY") {
    return d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  }
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()
}
