import ExcelJS from "exceljs"
import { parse as parseCsv } from "@fast-csv/parse"

export interface TabularPreview {
  headers: string[]
  rows: string[][]
  suggestedMapping: Record<string, string>
}

export interface ImportedTransactionRow {
  name: string
  merchant?: string
  merchantTaxCode?: string
  direction: "input" | "output"
  totalAmount: number
  preTaxAmount: number
  vatAmount: number
  currencyCode: string
  issuedAt: string
  categoryName?: string
  projectName?: string
  note?: string
}

const TARGET_HINTS: Record<string, string[]> = {
  name: ["tên", "diễn giải", "nội dung", "name", "description", "mặt hàng"],
  merchant: ["nhà cung cấp", "khách hàng", "đối tượng", "merchant", "vendor", "seller", "buyer"],
  merchantTaxCode: ["mst", "mã số thuế", "tax code", "vat id"],
  totalAmount: ["tổng tiền", "tổng thanh toán", "số tiền", "total", "amount"],
  preTaxAmount: ["chưa thuế", "tiền hàng", "subtotal", "pre_tax"],
  vatAmount: ["tiền thuế", "vat", "gtgt"],
  currencyCode: ["tiền tệ", "loại tiền", "currency", "dvtte"],
  issuedAt: ["ngày", "date", "issued", "ngày lập", "ngày hđ"],
  categoryName: ["danh mục", "loại chi phí", "category"],
  projectName: ["dự án", "công trình", "project"],
  note: ["ghi chú", "note", "memo"]
}

export async function parseTabularBuffer(filename: string, buffer: Buffer): Promise<TabularPreview> {
  const rawRows: string[][] = []

  if (filename.toLowerCase().endsWith(".xlsx") || filename.toLowerCase().endsWith(".xls")) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as never)
    const ws = wb.worksheets[0]
    ws?.eachRow((row) => {
      const arr = (row.values as unknown[]).slice(1).map((v) => String(v ?? "").trim())
      if (arr.some(Boolean)) rawRows.push(arr)
    })
  } else {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "")
    await new Promise<void>((resolve, reject) => {
      const s = parseCsv({ headers: false, trim: true, ignoreEmpty: true })
        .on("error", reject)
        .on("data", (r: string[]) => rawRows.push(r))
        .on("end", () => resolve())
      s.write(text)
      s.end()
    })
  }

  const headers = rawRows[0] ?? []
  const rows = rawRows.slice(1)
  const suggestedMapping: Record<string, string> = {}

  for (const header of headers) {
    const low = header.toLowerCase().trim()
    for (const [target, hints] of Object.entries(TARGET_HINTS)) {
      if (hints.some((h) => low.includes(h)) && !Object.values(suggestedMapping).includes(target)) {
        suggestedMapping[header] = target
        break
      }
    }
  }

  return { headers, rows, suggestedMapping }
}

function parseIntAmount(raw: string | undefined): number {
  if (!raw) return 0
  const cleaned = raw.replace(/[^\d.-]/g, "")
  const num = Number(cleaned)
  return Number.isFinite(num) ? Math.round(num) : 0
}

function normalizeDate(raw: string | undefined): string {
  const s = (raw ?? "").trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`
  return new Date().toISOString().slice(0, 10)
}

export function applyColumnMapping(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  defaultDirection: "input" | "output" = "input"
): ImportedTransactionRow[] {
  const indexByTarget: Record<string, number> = {}
  headers.forEach((h, i) => {
    const target = mapping[h]
    if (target) indexByTarget[target] = i
  })

  const get = (row: string[], field: string) => {
    const idx = indexByTarget[field]
    return idx !== undefined ? row[idx]?.trim() : undefined
  }

  return rows
    .filter((r) => r.some(Boolean))
    .map((r, i) => {
      const total = parseIntAmount(get(r, "totalAmount"))
      const vat = parseIntAmount(get(r, "vatAmount"))
      const preTaxRaw = get(r, "preTaxAmount")
      const preTax = preTaxRaw ? parseIntAmount(preTaxRaw) : Math.max(0, total - vat)

      return {
        name: get(r, "name") || `Dòng nhập #${i + 1}`,
        merchant: get(r, "merchant") || undefined,
        merchantTaxCode: get(r, "merchantTaxCode") || undefined,
        direction: defaultDirection,
        totalAmount: total || preTax + vat,
        preTaxAmount: preTax,
        vatAmount: vat,
        currencyCode: (get(r, "currencyCode") || "VND").toUpperCase(),
        issuedAt: normalizeDate(get(r, "issuedAt")),
        categoryName: get(r, "categoryName") || undefined,
        projectName: get(r, "projectName") || undefined,
        note: get(r, "note") || undefined
      }
    })
}
