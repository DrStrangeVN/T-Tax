import ExcelJS from "exceljs"
import JSZip from "jszip"
import { format as formatCsv } from "@fast-csv/format"
import { safeAsciiFilename } from "./filename-ascii.js"
import { generateVietQrDataUrl } from "./vietqr.js"

export interface ExportInvoiceRow {
  id: string
  direction: "input" | "output"
  templateCode?: string | null
  symbol?: string | null
  invoiceNumber?: string | null
  issuedAt?: string | null
  merchant?: string | null
  merchantTaxCode?: string | null
  name?: string | null
  description?: string | null
  preTaxAmount: number
  vatRate?: string | null
  vatAmount: number
  totalAmount: number
  currencyCode?: string | null
  convertedTotalVnd?: number | null
  categoryCode?: string | null
  categoryName?: string | null
  projectCode?: string | null
  projectName?: string | null
  debitAccount?: string | null
  creditAccount?: string | null
  taxAccount?: string | null
  note?: string | null
  extra?: Record<string, unknown> | null
  attachments?: Array<{ filename: string; buffer: Buffer }>
}

function setTextCell(cell: ExcelJS.Cell, value: string | null | undefined) {
  cell.value = value ?? ""
  cell.numFmt = "@" // Strictly preserve leading zeros in MST & Invoice Number
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.font = { bold: true, size: 10, name: "Arial" }
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true }
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } }
  row.eachCell((cell) => {
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" }
    }
  })
}

/**
 * Generates HTKK Purchase/Sales VAT Schedule Excel workbook (.xlsx)
 * Preserves leading zeros on Tax Code (MST) & Invoice Number.
 */
export async function exportHtkkExcelBuffer(params: {
  workspaceName: string
  workspaceTaxCode: string
  periodLabel: string
  direction: "input" | "output"
  rows: ExportInvoiceRow[]
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "T-Tax"
  const title = params.direction === "input" ? "Bang ke Mua vao" : "Bang ke Ban ra"
  const ws = wb.addWorksheet(title)

  ws.mergeCells("A1:J1")
  ws.getCell("A1").value =
    params.direction === "input"
      ? `BẢNG KÊ HÓA ĐƠN, CHỨNG TỪ HÀNG HÓA, DỊCH VỤ MUA VÀO (${params.periodLabel})`
      : `BẢNG KÊ HÓA ĐƠN, CHỨNG TỪ HÀNG HÓA, DỊCH VỤ BÁN RA (${params.periodLabel})`
  ws.getCell("A1").font = { bold: true, size: 13, name: "Arial" }
  ws.getCell("A1").alignment = { horizontal: "center" }

  ws.mergeCells("A2:J2")
  ws.getCell("A2").value = `Người nộp thuế: ${params.workspaceName} — MST: ${params.workspaceTaxCode}`
  ws.getCell("A2").font = { size: 10, italic: true, name: "Arial" }

  const headerRow = ws.addRow([
    "STT",
    "Ký hiệu mẫu số",
    "Ký hiệu hóa đơn",
    "Số hóa đơn",
    "Ngày lập",
    params.direction === "input" ? "Tên người bán" : "Tên người mua",
    params.direction === "input" ? "MST người bán" : "MST người mua",
    "Mặt hàng / Diễn giải",
    "Doanh số chưa thuế",
    "Thuế suất",
    "Thuế GTGT",
    "Ghi chú"
  ])
  styleHeaderRow(headerRow)

  const filtered = params.rows.filter((r) => r.direction === params.direction)
  const firstDataRow = headerRow.number + 1

  filtered.forEach((r, idx) => {
    const row = ws.addRow([
      idx + 1,
      r.templateCode ?? "",
      r.symbol ?? "",
      r.invoiceNumber ?? "",
      r.issuedAt ?? "",
      r.merchant ?? "",
      r.merchantTaxCode ?? "",
      r.name ?? r.description ?? "",
      r.preTaxAmount,
      r.vatRate ?? "",
      r.vatAmount,
      r.note ?? ""
    ])
    setTextCell(row.getCell(2), r.templateCode ?? "")
    setTextCell(row.getCell(3), r.symbol ?? "")
    setTextCell(row.getCell(4), r.invoiceNumber ?? "")
    setTextCell(row.getCell(7), r.merchantTaxCode ?? "")
    row.getCell(9).numFmt = "#,##0"
    row.getCell(11).numFmt = "#,##0"
  })

  if (filtered.length > 0) {
    const lastDataRow = firstDataRow + filtered.length - 1
    const totalRow = ws.addRow([
      "",
      "",
      "",
      "",
      "",
      "TỔNG CỘNG",
      "",
      "",
      { formula: `SUM(I${firstDataRow}:I${lastDataRow})` },
      "",
      { formula: `SUM(K${firstDataRow}:K${lastDataRow})` },
      ""
    ])
    totalRow.font = { bold: true, name: "Arial" }
    totalRow.getCell(9).numFmt = "#,##0"
    totalRow.getCell(11).numFmt = "#,##0"
  }

  ws.columns = [
    { width: 6 },
    { width: 12 },
    { width: 14 },
    { width: 14 },
    { width: 13 },
    { width: 32 },
    { width: 16 },
    { width: 34 },
    { width: 18 },
    { width: 11 },
    { width: 16 },
    { width: 22 }
  ]

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

/**
 * Generates MISA SME / AMIS Excel import template workbook.
 */
export async function exportMisaImportExcelBuffer(params: {
  direction: "input" | "output"
  rows: ExportInvoiceRow[]
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "T-Tax"
  const sheetName = params.direction === "input" ? "ChungTuMuaHang" : "ChungTuBanHang"
  const ws = wb.addWorksheet(sheetName)

  const header = ws.addRow([
    "Ngày hạch toán",
    "Ngày chứng từ",
    "Số chứng từ",
    "Mẫu số HĐ",
    "Ký hiệu HĐ",
    "Số hóa đơn",
    "Mã đối tượng (MST)",
    "Tên đối tượng",
    "Diễn giải",
    "TK Nợ",
    "TK Có",
    "Thành tiền",
    "Thuế suất GTGT",
    "Tiền thuế GTGT",
    "TK Thuế GTGT",
    "Tổng thanh toán"
  ])
  styleHeaderRow(header)

  const list = params.rows.filter((r) => r.direction === params.direction)
  list.forEach((r, idx) => {
    const voucherNo = `${params.direction === "input" ? "MH" : "BH"}${String(idx + 1).padStart(5, "0")}`
    const row = ws.addRow([
      r.issuedAt ?? "",
      r.issuedAt ?? "",
      voucherNo,
      r.templateCode ?? "",
      r.symbol ?? "",
      r.invoiceNumber ?? "",
      r.merchantTaxCode ?? "",
      r.merchant ?? "",
      r.name ?? r.description ?? "",
      r.debitAccount ?? (params.direction === "input" ? "6427" : "131"),
      r.creditAccount ?? (params.direction === "input" ? "331" : "5111"),
      r.preTaxAmount,
      r.vatRate ?? "",
      r.vatAmount,
      r.taxAccount ?? (params.direction === "input" ? "1331" : "33311"),
      r.totalAmount
    ])
    setTextCell(row.getCell(4), r.templateCode ?? "")
    setTextCell(row.getCell(5), r.symbol ?? "")
    setTextCell(row.getCell(6), r.invoiceNumber ?? "")
    setTextCell(row.getCell(7), r.merchantTaxCode ?? "")
    row.getCell(12).numFmt = "#,##0"
    row.getCell(14).numFmt = "#,##0"
    row.getCell(16).numFmt = "#,##0"
  })

  ws.columns.forEach((c) => {
    c.width = 18
  })
  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

/**
 * Generates Fast Accounting / Bravo compatible flat ledger Excel import.
 */
export async function exportFastBravoExcelBuffer(rows: ExportInvoiceRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("Import_ChungTu")
  const header = ws.addRow([
    "ngay_ct",
    "so_ct",
    "ma_kh",
    "ten_kh",
    "mst",
    "mau_so",
    "ky_hieu",
    "so_hd",
    "dien_giai",
    "tk_no",
    "tk_co",
    "tien_hang",
    "thue_suat",
    "tien_thue",
    "tk_thue",
    "tong_tt"
  ])
  styleHeaderRow(header)

  rows.forEach((r, idx) => {
    const row = ws.addRow([
      r.issuedAt ?? "",
      `CT${String(idx + 1).padStart(5, "0")}`,
      r.merchantTaxCode ?? "",
      r.merchant ?? "",
      r.merchantTaxCode ?? "",
      r.templateCode ?? "",
      r.symbol ?? "",
      r.invoiceNumber ?? "",
      r.name ?? "",
      r.debitAccount ?? "6428",
      r.creditAccount ?? "331",
      r.preTaxAmount,
      r.vatRate ?? "",
      r.vatAmount,
      r.taxAccount ?? "1331",
      r.totalAmount
    ])
    setTextCell(row.getCell(3), r.merchantTaxCode ?? "")
    setTextCell(row.getCell(5), r.merchantTaxCode ?? "")
    setTextCell(row.getCell(6), r.templateCode ?? "")
    setTextCell(row.getCell(7), r.symbol ?? "")
    setTextCell(row.getCell(8), r.invoiceNumber ?? "")
    row.getCell(12).numFmt = "#,##0"
    row.getCell(14).numFmt = "#,##0"
    row.getCell(16).numFmt = "#,##0"
  })

  ws.columns.forEach((c) => {
    c.width = 16
  })
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * Generates TaxHacker-compatible CSV + ZIP Archive with ASCII filenames.
 */
export async function exportTransactionsCsvAndZip(params: {
  rows: ExportInvoiceRow[]
  fields: Array<{ code: string; name: string; isExtra?: boolean }>
  includeAttachments: boolean
}): Promise<{ filename: string; mimeType: string; buffer: Buffer }> {
  const csvStream = formatCsv({ writeBOM: true })
  const chunks: string[] = []
  const donePromise = new Promise<string>((resolve, reject) => {
    csvStream.on("data", (d) => chunks.push(d.toString()))
    csvStream.on("error", reject)
    csvStream.on("end", () => resolve(chunks.join("")))
  })

  csvStream.write(params.fields.map((f) => f.name))
  const zip = params.includeAttachments ? new JSZip() : null
  const filesFolder = zip?.folder("files")

  for (const row of params.rows) {
    const attachmentPaths: string[] = []
    if (params.includeAttachments && filesFolder && row.attachments?.length) {
      const monthFolder = (row.issuedAt ?? new Date().toISOString()).slice(0, 7) || "undated"
      for (const att of row.attachments) {
        const asciiName = safeAsciiFilename(`${row.issuedAt ?? "doc"}_${row.merchant ?? "tx"}_${att.filename}`)
        const relPath = `${monthFolder}/${asciiName}`
        filesFolder.file(relPath, att.buffer)
        attachmentPaths.push(`files/${relPath}`)
      }
    }

    const line = params.fields.map((f) => {
      if (f.code === "files") return attachmentPaths.join(";")
      if (f.isExtra) return String(row.extra?.[f.code] ?? "")
      const val = (row as unknown as Record<string, unknown>)[f.code]
      return val === null || val === undefined ? "" : String(val)
    })
    csvStream.write(line)
  }

  csvStream.end()
  const csvContent = await donePromise

  if (!zip) {
    return {
      filename: "transactions.csv",
      mimeType: "text/csv; charset=utf-8",
      buffer: Buffer.from(csvContent, "utf8")
    }
  }

  zip.file("transactions.csv", csvContent)
  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  return {
    filename: "t_tax_export.zip",
    mimeType: "application/zip",
    buffer: zipBuf
  }
}

export interface OutgoingInvoiceTemplateData {
  templateCode: "EN" | "DE" | "VN"
  title: string
  invoiceNumber: string
  issueDate: string
  dueDate: string
  currency: string
  sellerDetails: string
  buyerDetails: string
  items: Array<{ name: string; subtitle?: string; quantity: number; unitPrice: number; vatRate: number }>
  notes?: string
  bankBin?: string
  bankAccountNo?: string
  bankAccountName?: string
}

export async function renderOutgoingInvoiceHtml(data: OutgoingInvoiceTemplateData): Promise<string> {
  const rows = data.items.map((it) => {
    const sub = it.quantity * it.unitPrice
    const vat = Math.round((sub * it.vatRate) / 100)
    return { ...it, sub, vat, total: sub + vat }
  })
  const subTotal = rows.reduce((s, r) => s + r.sub, 0)
  const vatTotal = rows.reduce((s, r) => s + r.vat, 0)
  const grandTotal = subTotal + vatTotal

  let qrImg = ""
  if (data.bankBin && data.bankAccountNo && data.currency.toUpperCase() === "VND") {
    qrImg = await generateVietQrDataUrl({
      bankBin: data.bankBin,
      accountNo: data.bankAccountNo,
      amountVnd: grandTotal,
      description: `TT ${data.invoiceNumber}`
    })
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat(data.templateCode === "VN" ? "vi-VN" : "en-US", {
      maximumFractionDigits: data.currency === "VND" ? 0 : 2
    }).format(n)

  const lbl =
    data.templateCode === "DE"
      ? { from: "Rechnungssteller", to: "Rechnungsempfänger", issue: "Rechnungsdatum", due: "Fällig am", item: "Position", qty: "Menge", price: "Einzelpreis", sub: "Summe", total: "Gesamtbetrag" }
      : data.templateCode === "VN"
        ? { from: "Đơn vị phát hành", to: "Khách hàng", issue: "Ngày lập", due: "Hạn thanh toán", item: "Hàng hóa / Dịch vụ", qty: "SL", price: "Đơn giá", sub: "Thành tiền", total: "Tổng thanh toán" }
        : { from: "Bill From", to: "Bill To", issue: "Issue Date", due: "Due Date", item: "Item", qty: "Qty", price: "Unit Price", sub: "Subtotal", total: "Total" }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Inter", Arial, sans-serif; color: #141622; margin: 0; padding: 28px; background: #fff; font-variant-numeric: tabular-nums; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1.5px solid #141622; padding-bottom: 16px; margin-bottom: 18px; }
  .top-dates { text-align: right; white-space: nowrap; flex-shrink: 0; font-size: 11.5px; }
  h1 { margin: 0; font-size: 20px; line-height: 1.25; letter-spacing: -0.02em; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 20px; }
  .box { border: 1px solid #E2E8F0; border-radius: 8px; padding: 12px 14px; white-space: pre-line; }
  .box-lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748B; font-weight: 600; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #E2E8F0; padding: 9px 8px; text-align: left; }
  th { font-size: 11px; text-transform: uppercase; color: #475569; background: #F8FAFC; }
  .r { text-align: right; white-space: nowrap; }
  .sum-wrap { margin-top: 18px; display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .sum-box { width: 280px; margin-left: auto; border: 1px solid #CBD5E1; border-radius: 8px; padding: 12px 14px; }
  .sum-row { display: flex; justify-content: space-between; padding: 3px 0; }
  .sum-grand { border-top: 1px solid #CBD5E1; margin-top: 6px; padding-top: 8px; font-weight: 700; font-size: 14px; }
</style>
</head>
<body>
  <div class="top">
    <div>
      <h1>${data.title}</h1>
      <div style="color:#475569">#${data.invoiceNumber}</div>
    </div>
    <div class="top-dates">
      <div>${lbl.issue}: <b>${data.issueDate}</b></div>
      <div>${lbl.due}: <b>${data.dueDate}</b></div>
    </div>
  </div>
  <div class="grid2">
    <div class="box"><div class="box-lbl">${lbl.from}</div>${data.sellerDetails}</div>
    <div class="box"><div class="box-lbl">${lbl.to}</div>${data.buyerDetails}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>${lbl.item}</th>
        <th class="r">${lbl.qty}</th>
        <th class="r">${lbl.price}</th>
        <th class="r">VAT %</th>
        <th class="r">${lbl.sub}</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `<tr><td><b>${r.name}</b>${r.subtitle ? `<div style="font-size:11px;color:#64748B">${r.subtitle}</div>` : ""}</td><td class="r">${r.quantity}</td><td class="r">${fmt(r.unitPrice)}</td><td class="r">${r.vatRate}%</td><td class="r"><b>${fmt(r.total)} ${data.currency}</b></td></tr>`).join("")}
    </tbody>
  </table>
  <div class="sum-wrap">
    ${qrImg ? `<div style="display:flex;align-items:center;gap:12px;border:1px solid #E2E8F0;border-radius:8px;padding:10px 14px"><img src="${qrImg}" width="92" height="92" /><div><div style="font-weight:600">VietQR NAPAS 247</div><div style="font-size:11px;color:#475569">STK: ${data.bankAccountNo}<br/>${data.bankAccountName ?? ""}</div></div></div>` : "<div></div>"}
    <div class="sum-box">
      <div class="sum-row"><span>${lbl.sub}</span><span>${fmt(subTotal)} ${data.currency}</span></div>
      <div class="sum-row"><span>VAT</span><span>${fmt(vatTotal)} ${data.currency}</span></div>
      <div class="sum-row sum-grand"><span>${lbl.total}</span><span>${fmt(grandTotal)} ${data.currency}</span></div>
    </div>
  </div>
  ${data.notes ? `<div style="margin-top:20px;font-size:11.5px;color:#475569"><b>Notes:</b> ${data.notes}</div>` : ""}
</body>
</html>`
}
