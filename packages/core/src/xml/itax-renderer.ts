import QRCode from "qrcode"
import type { ParsedEInvoice, XmlSignatureVerification } from "../types.js"

function esc(value: string | number | undefined | null): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fmtMoney(n: number | undefined, currency = "VND"): string {
  if (n === undefined || Number.isNaN(n)) return ""
  return new Intl.NumberFormat("vi-VN", {
    maximumFractionDigits: currency === "VND" ? 0 : 2
  }).format(n)
}

export async function renderEInvoiceHtml(
  invoice: ParsedEInvoice,
  signature?: XmlSignatureVerification
): Promise<string> {
  const qrText =
    invoice.qrContent ||
    `https://hoadondientu.gdt.gov.vn/?mst=${encodeURIComponent(invoice.seller.taxCode ?? "")}&khms=${encodeURIComponent(invoice.templateCode)}&kh=${encodeURIComponent(invoice.symbol)}&so=${encodeURIComponent(invoice.invoiceNumber)}`

  let qrDataUrl = ""
  try {
    qrDataUrl = await QRCode.toDataURL(qrText, { width: 120, margin: 1 })
  } catch {
    qrDataUrl = ""
  }

  const rowsHtml = invoice.items
    .map(
      (item, i) => `
      <tr>
        <td class="c tnum">${item.index || i + 1}</td>
        <td class="wrap-cell">${esc(item.name)}${item.code ? `<div class="muted">Mã: ${esc(item.code)}</div>` : ""}</td>
        <td class="c" style="white-space:nowrap">${esc(item.unit)}</td>
        <td class="r tnum">${esc(item.quantity ?? "")}</td>
        <td class="r tnum">${item.unitPrice ? fmtMoney(Number(item.unitPrice), invoice.currencyCode) : ""}</td>
        <td class="r tnum">${fmtMoney(item.preTaxAmount, invoice.currencyCode)}</td>
        <td class="c tnum">${esc(item.vatRate ?? "")}</td>
        <td class="r tnum">${item.vatAmount !== undefined ? fmtMoney(item.vatAmount, invoice.currencyCode) : ""}</td>
        <td class="r tnum b">${fmtMoney(item.amount, invoice.currencyCode)}</td>
      </tr>`
    )
    .join("")

  const sigBadgeColor =
    signature?.status === "valid"
      ? "#059669"
      : signature?.status === "invalid"
        ? "#E11D48"
        : "#B45309"

  const sigLabel =
    signature?.status === "valid"
      ? "Chữ ký số hợp lệ"
      : signature?.status === "invalid"
        ? "Chữ ký số không hợp lệ"
        : signature?.status === "unverified_ca"
          ? "Đã ký số (CA chưa đối chiếu)"
          : "Chưa có chữ ký số"

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<title>Hóa đơn ${esc(invoice.symbol)}-${esc(invoice.invoiceNumber)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 10px;
    background: #FFFFFF;
    color: #141622;
    font: 11px/1.38 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", Arial, sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .sheet {
    max-width: 820px;
    margin: 0 auto;
    border: 1.5px solid #1E293B;
    padding: 12px 13px;
    background: #FFFFFF;
  }
  .hdr {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr) 124px;
    gap: 8px;
    align-items: start;
    border-bottom: 1px solid #CBD5E1;
    padding-bottom: 10px;
  }
  .title { text-align: center; }
  .title h1 { margin: 0; font-size: 14px; line-height: 1.25; letter-spacing: 0.01em; text-transform: uppercase; color: #0F172A; }
  .title .sub { font-size: 11px; color: #475569; margin-top: 3px; }
  .meta-box { font-size: 11px; line-height: 1.55; }
  .meta-box b { color: #0F172A; }
  .party {
    padding: 9px 0;
    border-bottom: 1px solid #E2E8F0;
    display: grid;
    gap: 3px;
  }
  .party-row { display: flex; gap: 8px; }
  .party-row span:first-child { color: #475569; min-width: 126px; flex-shrink: 0; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
    font-size: 9.5px;
    line-height: 1.3;
    table-layout: auto;
  }
  th, td {
    border: 1px solid #CBD5E1;
    padding: 4px 3px;
    vertical-align: top;
    overflow-wrap: normal;
  }
  th {
    background: #F8FAFC;
    color: #0F172A;
    font-weight: 600;
    text-align: center;
    white-space: nowrap;
  }
  th.wrap-hdr, td.wrap-cell {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .r { text-align: right; }
  .c { text-align: center; }
  .b { font-weight: 600; }
  .tnum { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted { font-size: 9.5px; color: #64748B; }
  .totals {
    margin-top: 10px;
    display: flex;
    justify-content: flex-end;
  }
  .totals-table { width: 100%; max-width: 340px; margin-top: 0; }
  @media print {
    table { font-size: 10.5px; }
    th, td { padding: 5px 5px; }
  }
  .words {
    margin-top: 10px;
    padding: 8px 10px;
    background: #F8FAFC;
    border: 1px solid #E2E8F0;
    font-size: 12px;
  }
  .sigs {
    margin-top: 18px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  .sig-card {
    border: 1px solid ${sigBadgeColor};
    background: #FAFAFA;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 11px;
  }
  .sig-title { font-weight: 700; color: ${sigBadgeColor}; margin-bottom: 4px; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="hdr">
      <div>${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR" width="74" height="74" />` : ""}</div>
      <div class="title">
        <h1>${esc(invoice.invoiceTitle || invoice.decodedSymbol?.templateLabel || "HÓA ĐƠN GIÁ TRỊ GIA TĂNG")}</h1>
        <div class="sub">Ngày ${esc(invoice.issuedDate)} · ${invoice.mccqt ? `Mã CQT: <b>${esc(invoice.mccqt)}</b>` : "Không có mã CQT"}</div>
      </div>
      <div class="meta-box">
        <div>Mẫu số: <b>${esc(invoice.templateCode)}</b></div>
        <div>Ký hiệu: <b>${esc(invoice.symbol)}</b></div>
        <div>Số: <b class="tnum" style="color:#E11D48;font-size:13px">${esc(invoice.invoiceNumber)}</b></div>
        <div>Tiền tệ: <b>${esc(invoice.currencyCode)}</b> (TG: ${esc(invoice.exchangeRate)})</div>
      </div>
    </div>

    <div class="party">
      <div class="party-row"><span>Đơn vị bán hàng:</span><b>${esc(invoice.seller.name)}</b></div>
      <div class="party-row"><span>Mã số thuế:</span><b class="tnum">${esc(invoice.seller.taxCode)}</b></div>
      <div class="party-row"><span>Địa chỉ:</span><span>${esc(invoice.seller.address)}</span></div>
      ${invoice.seller.bankAccount ? `<div class="party-row"><span>Số tài khoản:</span><span>${esc(invoice.seller.bankAccount)} ${esc(invoice.seller.bankName)}</span></div>` : ""}
    </div>

    <div class="party">
      <div class="party-row"><span>Họ tên người mua:</span><span>${esc(invoice.buyer.contactName)}</span></div>
      <div class="party-row"><span>Tên đơn vị:</span><b>${esc(invoice.buyer.name)}</b></div>
      <div class="party-row"><span>Mã số thuế / CCCD:</span><b class="tnum">${esc(invoice.buyer.taxCode || invoice.buyer.citizenId)}</b></div>
      <div class="party-row"><span>Địa chỉ:</span><span>${esc(invoice.buyer.address)}</span></div>
      <div class="party-row"><span>Hình thức thanh toán:</span><span>${esc(invoice.paymentMethod)}</span></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>STT</th>
          <th class="wrap-hdr">Tên hàng hóa, dịch vụ</th>
          <th>ĐVT</th>
          <th>SL</th>
          <th>Đơn giá</th>
          <th>Thành tiền</th>
          <th>Thuế</th>
          <th>Tiền thuế</th>
          <th>Tổng cộng</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <div class="totals">
      <table class="totals-table">
        <tr><td>Tổng tiền chưa thuế:</td><td class="r b tnum">${fmtMoney(invoice.totals.totalBeforeVat, invoice.currencyCode)} ${esc(invoice.currencyCode)}</td></tr>
        ${invoice.totals.totalDiscount ? `<tr><td>Chiết khấu thương mại:</td><td class="r tnum">${fmtMoney(invoice.totals.totalDiscount, invoice.currencyCode)}</td></tr>` : ""}
        <tr><td>Tổng tiền thuế GTGT:</td><td class="r b tnum">${fmtMoney(invoice.totals.totalVat, invoice.currencyCode)} ${esc(invoice.currencyCode)}</td></tr>
        <tr><td><b>Tổng tiền thanh toán:</b></td><td class="r b tnum" style="font-size:13px">${fmtMoney(invoice.totals.totalPayable, invoice.currencyCode)} ${esc(invoice.currencyCode)}</td></tr>
      </table>
    </div>

    ${invoice.totals.totalPayableInWords ? `<div class="words">Số tiền viết bằng chữ: <b>${esc(invoice.totals.totalPayableInWords)}</b></div>` : ""}

    <div class="sigs">
      <div style="font-size:11px;color:#475569">
        <div><b>Người mua hàng</b></div>
        <div class="muted" style="margin-top:24px">${esc(invoice.buyer.contactName || "")}</div>
      </div>
      <div class="sig-card">
        <div class="sig-title">${esc(sigLabel)}</div>
        <div>Ký bởi: <b>${esc(signature?.signerCn || invoice.seller.name || "Chưa xác định")}</b></div>
        ${signature?.signerTaxCode ? `<div>MST chứng thư: <span class="tnum">${esc(signature.signerTaxCode)}</span></div>` : ""}
        ${signature?.signerIssuer ? `<div>Tổ chức CA: ${esc(signature.signerIssuer)}</div>` : ""}
        ${signature?.signingTime || invoice.signedDate ? `<div>Ngày ký: ${esc(signature?.signingTime || invoice.signedDate)}</div>` : ""}
      </div>
    </div>
  </div>
</body>
</html>`
}
