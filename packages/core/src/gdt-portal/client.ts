export interface GdtCaptchaChallenge {
  key: string
  svgContent: string
}

export interface GdtInvoiceSummary {
  id: string
  nbmst: string
  khmshdon: number
  khhdon: string
  shdon: number
  tdlap: string
  nbten: string
  nmten?: string
  nmmst?: string
  tgtcthue: number
  tgtthue: number
  tgtttbso: number
  tthai: number
  ttxly: number
}

const GDT_BASE = "https://hoadondientu.gdt.gov.vn:30000"

/**
 * Human-in-the-loop client for Vietnam General Department of Taxation (GDT) portal.
 * Displays the official SVG CAPTCHA in UI so the taxpayer enters it manually.
 */
export async function fetchGdtCaptcha(): Promise<GdtCaptchaChallenge> {
  const res = await fetch(`${GDT_BASE}/captcha`, {
    headers: { Accept: "application/json" }
  })
  if (!res.ok) {
    throw new Error(`Không thể tải CAPTCHA từ cổng Thuế (${res.status})`)
  }
  const data = (await res.json()) as { key?: string; content?: string }
  if (!data.key || !data.content) {
    throw new Error("Phản hồi CAPTCHA từ cổng Thuế không hợp lệ.")
  }
  return { key: data.key, svgContent: data.content }
}

export async function authenticateGdtSession(params: {
  username: string
  password: string
  captchaKey: string
  captchaValue: string
}): Promise<{ token: string }> {
  const res = await fetch(`${GDT_BASE}/security-taxpayer/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: params.username.trim(),
      password: params.password,
      ckey: params.captchaKey,
      cvalue: params.captchaValue.trim()
    })
  })
  const body = (await res.json()) as { token?: string; message?: string }
  if (!res.ok || !body.token) {
    throw new Error(body.message || `Đăng nhập cổng Thuế thất bại (${res.status})`)
  }
  return { token: body.token }
}

export async function queryGdtInvoices(params: {
  token: string
  direction: "input" | "output"
  fromDateDmy: string // DD/MM/YYYY
  toDateDmy: string   // DD/MM/YYYY
  size?: number
  state?: string
}): Promise<GdtInvoiceSummary[]> {
  const endpoint =
    params.direction === "input"
      ? `${GDT_BASE}/query/invoices/purchase`
      : `${GDT_BASE}/query/invoices/sold`

  const search = `tdlap=ge=${params.fromDateDmy}T00:00:00;tdlap=le=${params.toDateDmy}T23:59:59`
  const url = `${endpoint}?sort=tdlap:desc,khmshdon:asc,shdon:desc&size=${params.size ?? 50}&search=${encodeURIComponent(search)}`

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/json"
    }
  })
  if (!res.ok) {
    throw new Error(`Lỗi truy vấn hóa đơn cổng Thuế (${res.status})`)
  }
  const json = (await res.json()) as { datas?: GdtInvoiceSummary[] }
  return json.datas ?? []
}

export async function downloadGdtInvoiceXmlZip(params: {
  token: string
  nbmst: string
  khhdon: string
  shdon: number | string
  khmshdon: number | string
}): Promise<Buffer> {
  const url = `${GDT_BASE}/query/invoices/export-xml?nbmst=${encodeURIComponent(params.nbmst)}&khhdon=${encodeURIComponent(params.khhdon)}&shdon=${encodeURIComponent(String(params.shdon))}&khmshdon=${encodeURIComponent(String(params.khmshdon))}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${params.token}` }
  })
  if (!res.ok) {
    throw new Error(`Không tải được XML từ cổng Thuế (${res.status})`)
  }
  return Buffer.from(await res.arrayBuffer())
}
