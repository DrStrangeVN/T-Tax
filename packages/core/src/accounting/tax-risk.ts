export interface TaxCodeLookupResult {
  taxCode: string
  found: boolean
  name?: string
  shortName?: string
  address?: string
  status: "active" | "inactive" | "closed" | "risk_flagged" | "unknown"
  source: string
  checkedAt: string
}

export function isValidVietnamTaxCodeFormat(mst: string): boolean {
  const clean = mst.trim()
  return /^\d{10}(?:-\d{3})?$/.test(clean)
}

/**
 * Looks up Vietnam enterprise info by tax code (MST) via public VietQR Business API.
 * Gracefully degrades to `unknown` when offline or rate-limited.
 */
export async function lookupVietnamTaxCode(taxCode: string): Promise<TaxCodeLookupResult> {
  const clean = taxCode.trim()
  const now = new Date().toISOString()

  if (!isValidVietnamTaxCodeFormat(clean)) {
    return {
      taxCode: clean,
      found: false,
      status: "unknown",
      source: "format-check",
      checkedAt: now
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`https://api.vietqr.io/v2/business/${encodeURIComponent(clean)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return { taxCode: clean, found: false, status: "unknown", source: "vietqr", checkedAt: now }
    }

    const json = (await res.json()) as {
      code?: string
      data?: { id?: string; name?: string; internationalName?: string; shortName?: string; address?: string; status?: string }
    }

    if (json.code !== "00" || !json.data) {
      return { taxCode: clean, found: false, status: "unknown", source: "vietqr", checkedAt: now }
    }

    const rawStatus = (json.data.status ?? "").toLowerCase()
    let status: TaxCodeLookupResult["status"] = "active"
    if (rawStatus.includes("ngừng") || rawStatus.includes("đóng") || rawStatus.includes("giải thể")) {
      status = "closed"
    } else if (rawStatus.includes("tạm nghỉ") || rawStatus.includes("không hoạt động")) {
      status = "inactive"
    }

    return {
      taxCode: clean,
      found: true,
      name: json.data.name,
      shortName: json.data.shortName,
      address: json.data.address,
      status,
      source: "vietqr",
      checkedAt: now
    }
  } catch {
    return { taxCode: clean, found: false, status: "unknown", source: "offline", checkedAt: now }
  }
}
