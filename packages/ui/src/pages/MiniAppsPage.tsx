import React, { useEffect, useState, useCallback } from "react"
import { Mail, FilePlus2, Landmark, FileSpreadsheet, RefreshCw, Download, X } from "lucide-react"
import {
  EMAIL_PROVIDER_PRESETS,
  VIETNAM_BANKS,
  type GdtCaptchaChallenge,
  type GdtInvoiceSummary,
  type OutgoingInvoiceTemplateData,
  type TransactionDirection,
  type WorkspaceDTO
} from "@t-tax/core/browser"
import { useTransport, fileToPayload } from "../transport/client.js"
import { formatMoney } from "../utils/format.js"

interface MiniAppsProps {
  workspace: WorkspaceDTO
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

export function MiniAppsPage({ workspace, onRefreshCounts, onToast }: MiniAppsProps) {
  const transport = useTransport()
  const [activeApp, setActiveApp] = useState<"hub" | "email" | "invoice" | "gdt" | "import">("hub")

  // Email IMAP State
  const [emailServers, setEmailServers] = useState<Array<Record<string, unknown>>>([])
  const [emailForm, setEmailForm] = useState({
    name: "Hóa đơn Gmail",
    provider: "gmail" as keyof typeof EMAIL_PROVIDER_PRESETS,
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    username: "",
    password: "",
    folder: "INBOX"
  })
  const [syncingId, setSyncingId] = useState<string | null>(null)

  // Invoice Generator State
  const [invData, setInvData] = useState<OutgoingInvoiceTemplateData>({
    templateCode: "VN",
    title: "HÓA ĐƠN BÁN HÀNG / ĐỀ NGHỊ THANH TOÁN",
    invoiceNumber: "INV-2026-001",
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
    currency: workspace.baseCurrency || "VND",
    sellerDetails: `${workspace.name}\nMST: ${workspace.taxCode}\n${workspace.address ?? ""}`,
    buyerDetails: "Công ty Khách hàng\nMST: \nĐịa chỉ: ",
    items: [{ name: "Dịch vụ tư vấn & triển khai phần mềm", quantity: 1, unitPrice: 15_000_000, vatRate: 8 }],
    notes: "Vui lòng thanh toán qua chuyển khoản VietQR theo nội dung mã hóa đơn.",
    bankBin: "970436",
    bankAccountNo: "",
    bankAccountName: workspace.name
  })
  const [invHtml, setInvHtml] = useState("")

  // GDT Portal State
  const [captcha, setCaptcha] = useState<GdtCaptchaChallenge | null>(null)
  const [gdtCreds, setGdtCreds] = useState({
    username: workspace.taxCode,
    password: "",
    captchaValue: "",
    direction: "input" as TransactionDirection,
    fromDateDmy: "01/01/2026",
    toDateDmy: new Date().toLocaleDateString("en-GB")
  })
  const [gdtToken, setGdtToken] = useState("")
  const [gdtInvoices, setGdtInvoices] = useState<GdtInvoiceSummary[]>([])
  const [gdtBusy, setGdtBusy] = useState(false)

  // Tabular Import State
  const [tabPreview, setTabPreview] = useState<{
    headers: string[]
    rows: string[][]
    mapping: Record<string, string>
    direction: TransactionDirection
  } | null>(null)

  const loadEmailServers = useCallback(async () => {
    const data = await transport.getAppData(workspace.id, "email")
    setEmailServers((data.servers as Array<Record<string, unknown>>) ?? [])
  }, [workspace.id, transport])

  useEffect(() => {
    if (activeApp === "email") loadEmailServers().catch(() => {})
  }, [activeApp, loadEmailServers])

  useEffect(() => {
    if (activeApp === "invoice") {
      transport.renderOutgoingInvoiceHtml(invData).then(setInvHtml).catch(() => {})
    }
  }, [activeApp, invData, transport])

  const handleSaveEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    await transport.saveEmailServer(workspace.id, emailForm)
    setEmailForm({ ...emailForm, password: "" })
    onToast("Đã lưu cấu hình hộp thư IMAP an toàn.", "ok")
    loadEmailServers()
  }

  const handleSyncEmail = async (serverId: string) => {
    setSyncingId(serverId)
    try {
      const res = await transport.syncEmailNow(workspace.id, serverId)
      onRefreshCounts()
      onToast(`Đồng bộ Email xong: đã nạp ${res.imported} chứng từ mới.`, "ok")
      loadEmailServers()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi đồng bộ Email", "err")
    } finally {
      setSyncingId(null)
    }
  }

  const handleLoadCaptcha = async () => {
    setGdtBusy(true)
    try {
      const c = await transport.fetchGdtCaptcha()
      setCaptcha(c)
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Không tải được CAPTCHA Cổng Thuế", "err")
    } finally {
      setGdtBusy(false)
    }
  }

  const handleGdtQuery = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!captcha) return
    setGdtBusy(true)
    try {
      const res = await transport.gdtLoginAndQuery({
        username: gdtCreds.username,
        password: gdtCreds.password,
        captchaKey: captcha.key,
        captchaValue: gdtCreds.captchaValue,
        direction: gdtCreds.direction,
        fromDateDmy: gdtCreds.fromDateDmy,
        toDateDmy: gdtCreds.toDateDmy
      })
      setGdtToken(res.token)
      setGdtInvoices(res.invoices)
      onToast(`Đã tải ${res.invoices.length} hóa đơn từ Cổng Thuế.`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Đăng nhập Cổng Thuế thất bại", "err")
      handleLoadCaptcha()
    } finally {
      setGdtBusy(false)
    }
  }

  const handleGdtDownloadAll = async () => {
    if (!gdtToken || !gdtInvoices.length) return
    setGdtBusy(true)
    try {
      const res = await transport.gdtDownloadAndIngest({
        workspaceId: workspace.id,
        token: gdtToken,
        invoices: gdtInvoices
      })
      onRefreshCounts()
      onToast(`Đã tải và nạp ${res.imported} hóa đơn XML từ Tổng cục Thuế.`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi tải XML Cổng Thuế", "err")
    } finally {
      setGdtBusy(false)
    }
  }

  const handleImportFile = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    const p = await fileToPayload(f)
    const prev = await transport.previewTabularImport(p.filename, p.base64)
    setTabPreview({
      headers: prev.headers,
      rows: prev.rows,
      mapping: prev.suggestedMapping,
      direction: "input"
    })
  }

  const handleCommitImport = async () => {
    if (!tabPreview) return
    const res = await transport.commitTabularImport(
      workspace.id,
      tabPreview.headers,
      tabPreview.rows,
      tabPreview.mapping,
      tabPreview.direction
    )
    setTabPreview(null)
    onRefreshCounts()
    onToast(`Đã nhập ${res.imported} giao dịch vào sổ.`, "ok")
  }

  if (activeApp === "hub") {
    const apps = [
      {
        id: "email",
        title: "Giám sát Email Hóa đơn (IMAP)",
        desc: "Tự động đọc Gmail, Outlook, iCloud, mail doanh nghiệp để tải cặp XML + PDF + ZIP về Hộp thư AI.",
        icon: Mail,
        tag: "Tự động"
      },
      {
        id: "invoice",
        title: "Trình Tạo Hóa đơn & VietQR",
        desc: "Tạo nhanh hóa đơn bán hàng / đề nghị thanh toán PDF chuẩn VN/EN/DE nhúng mã VietQR NAPAS 247.",
        icon: FilePlus2,
        tag: "PDF + QR"
      },
      {
        id: "gdt",
        title: "Đồng bộ Cổng HĐĐT Tổng cục Thuế",
        desc: "Kết nối hoadondientu.gdt.gov.vn với CAPTCHA người dùng nhập trực tiếp để tải hàng loạt XML gốc.",
        icon: Landmark,
        tag: "GDT Portal"
      },
      {
        id: "import",
        title: "Nhập Bảng kê CSV / Excel thông minh",
        desc: "Ánh xạ cột tự động từ file Excel kế toán cũ hoặc TaxHacker CSV, tự tạo danh mục & dự án còn thiếu.",
        icon: FileSpreadsheet,
        tag: "CSV / XLSX"
      }
    ] as const

    return (
      <div className="p-5 sm:p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {apps.map((a) => {
          const Icon = a.icon
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setActiveApp(a.id)}
              className="text-left rounded-[16px] border border-[var(--line)] bg-[var(--panel)] p-5 hover:border-[var(--line2)] hover:bg-[var(--hover)] transition-colors space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-[11px] grid place-items-center bg-[var(--raised)] border border-[var(--line)] text-[var(--cyan)]">
                  <Icon size={19} strokeWidth={1.8} />
                </div>
                <span className="tag">{a.tag}</span>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-[var(--text)]">{a.title}</div>
                <p className="text-[12px] text-[var(--muted)] mt-1">{a.desc}</p>
              </div>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--line)] flex items-center justify-between bg-[var(--sheet-bg)]">
        <button type="button" onClick={() => setActiveApp("hub")} className="gb">
          <X size={13} />
          <span>Quay lại Danh sách Tiện ích</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 sm:p-6">
        {activeApp === "email" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <form onSubmit={handleSaveEmail} className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
              <h3 className="text-[14px] font-semibold">Thêm Hộp thư nhận Hóa đơn</h3>
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={emailForm.provider}
                  onChange={(e) => {
                    const key = e.target.value as keyof typeof EMAIL_PROVIDER_PRESETS
                    const p = EMAIL_PROVIDER_PRESETS[key]
                    setEmailForm({ ...emailForm, provider: key, host: p.host, port: p.port, secure: p.secure })
                  }}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                >
                  {Object.entries(EMAIL_PROVIDER_PRESETS).map(([k, v]) => (
                    <option key={k} value={k} className="bg-[var(--panel-solid)]">{v.label}</option>
                  ))}
                </select>
                <input
                  required
                  placeholder="Tên gợi nhớ"
                  value={emailForm.name}
                  onChange={(e) => setEmailForm({ ...emailForm, name: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <input
                  required
                  placeholder="IMAP Host"
                  value={emailForm.host}
                  onChange={(e) => setEmailForm({ ...emailForm, host: e.target.value })}
                  className="col-span-2 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
                <input
                  type="number"
                  value={emailForm.port}
                  onChange={(e) => setEmailForm({ ...emailForm, port: Number(e.target.value) || 993 })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                />
              </div>
              <input
                required
                placeholder="Email đăng nhập"
                value={emailForm.username}
                onChange={(e) => setEmailForm({ ...emailForm, username: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                required
                type="password"
                placeholder="Mật khẩu ứng dụng (App Password)"
                value={emailForm.password}
                onChange={(e) => setEmailForm({ ...emailForm, password: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <button type="submit" className="pb">Lưu cấu hình IMAP</button>
            </form>

            <div className="space-y-3">
              {emailServers.map((srv) => (
                <div key={String(srv.id)} className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-[13px]">{String(srv.name)}</div>
                    <div className="text-[11.5px] text-[var(--muted)] truncate">{String(srv.username)} · {String(srv.host)}</div>
                    <div className="text-[10.5px] text-[var(--dim)] mt-0.5">
                      Trạng thái: {String(srv.status ?? "idle")} · UID {String(srv.lastProcessedUid ?? 0)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={syncingId === String(srv.id)}
                    onClick={() => handleSyncEmail(String(srv.id))}
                    className="gb hl shrink-0"
                  >
                    <RefreshCw size={13} className={syncingId === String(srv.id) ? "animate-spin" : ""} />
                    <span>Đồng bộ ngay</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeApp === "invoice" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-5 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={invData.templateCode}
                  onChange={(e) => setInvData({ ...invData, templateCode: e.target.value as "VN" | "EN" | "DE" })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                >
                  <option value="VN" className="bg-[var(--panel-solid)]">Mẫu Tiếng Việt</option>
                  <option value="EN" className="bg-[var(--panel-solid)]">Mẫu English</option>
                  <option value="DE" className="bg-[var(--panel-solid)]">Mẫu Deutsch</option>
                </select>
                <input
                  value={invData.invoiceNumber}
                  onChange={(e) => setInvData({ ...invData, invoiceNumber: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
                <input
                  value={invData.currency}
                  onChange={(e) => setInvData({ ...invData, currency: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
              </div>

              <textarea
                rows={3}
                value={invData.buyerDetails}
                onChange={(e) => setInvData({ ...invData, buyerDetails: e.target.value })}
                placeholder="Thông tin khách hàng"
                className="w-full p-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />

              <div className="grid grid-cols-2 gap-2">
                <select
                  value={invData.bankBin}
                  onChange={(e) => setInvData({ ...invData, bankBin: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                >
                  {VIETNAM_BANKS.map((b) => (
                    <option key={b.bin} value={b.bin} className="bg-[var(--panel-solid)]">{b.shortName}</option>
                  ))}
                </select>
                <input
                  placeholder="Số tài khoản nhận VietQR"
                  value={invData.bankAccountNo ?? ""}
                  onChange={(e) => setInvData({ ...invData, bankAccountNo: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                />
              </div>

              <div className="space-y-2">
                {invData.items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-1.5">
                    <input
                      value={it.name}
                      onChange={(e) => {
                        const next = [...invData.items]
                        next[idx] = { ...it, name: e.target.value }
                        setInvData({ ...invData, items: next })
                      }}
                      className="col-span-6 h-8 px-2 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                    />
                    <input
                      type="number"
                      value={it.quantity}
                      onChange={(e) => {
                        const next = [...invData.items]
                        next[idx] = { ...it, quantity: Number(e.target.value) || 1 }
                        setInvData({ ...invData, items: next })
                      }}
                      className="col-span-2 h-8 px-2 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                    />
                    <input
                      type="number"
                      value={it.unitPrice}
                      onChange={(e) => {
                        const next = [...invData.items]
                        next[idx] = { ...it, unitPrice: Number(e.target.value) || 0 }
                        setInvData({ ...invData, items: next })
                      }}
                      className="col-span-4 h-8 px-2 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => transport.savePdfFromHtml(`${invData.invoiceNumber}.pdf`, invHtml)}
                className="pb"
              >
                <Download size={13.5} />
                <span>Xuất PDF Hóa đơn</span>
              </button>
            </div>

            <div className="lg:col-span-7">
              <iframe title="Outgoing Invoice Preview" srcDoc={invHtml} className="w-full h-[540px] rounded-[12px] bg-white border border-[var(--line)]" />
            </div>
          </div>
        )}

        {activeApp === "gdt" && (
          <div className="max-w-[780px] space-y-4">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold">Đăng nhập Cổng Hóa đơn Điện tử (hoadondientu.gdt.gov.vn)</h3>
                <button type="button" onClick={handleLoadCaptcha} disabled={gdtBusy} className="gb">
                  <RefreshCw size={12.5} className={gdtBusy ? "animate-spin" : ""} />
                  <span>Tải mã CAPTCHA</span>
                </button>
              </div>
              <form onSubmit={handleGdtQuery} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  required
                  placeholder="Tên đăng nhập (MST)"
                  value={gdtCreds.username}
                  onChange={(e) => setGdtCreds({ ...gdtCreds, username: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
                <input
                  required
                  type="password"
                  placeholder="Mật khẩu Cổng Thuế"
                  value={gdtCreds.password}
                  onChange={(e) => setGdtCreds({ ...gdtCreds, password: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
                <input
                  placeholder="Từ ngày (DD/MM/YYYY)"
                  value={gdtCreds.fromDateDmy}
                  onChange={(e) => setGdtCreds({ ...gdtCreds, fromDateDmy: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                />
                <input
                  placeholder="Đến ngày (DD/MM/YYYY)"
                  value={gdtCreds.toDateDmy}
                  onChange={(e) => setGdtCreds({ ...gdtCreds, toDateDmy: e.target.value })}
                  className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                />

                {captcha && (
                  <div className="sm:col-span-2 flex items-center gap-3 p-3 rounded-[10px] bg-[var(--raised)] border border-[var(--line)]">
                    <div
                      className="bg-white rounded p-1 shrink-0"
                      dangerouslySetInnerHTML={{ __html: captcha.svgContent }}
                    />
                    <input
                      required
                      placeholder="Nhập chính xác mã CAPTCHA hiển thị bên trái"
                      value={gdtCreds.captchaValue}
                      onChange={(e) => setGdtCreds({ ...gdtCreds, captchaValue: e.target.value })}
                      className="flex-1 h-9 px-3 rounded-[9px] bg-[var(--panel)] border border-[var(--line)] text-[13px]"
                    />
                    <button type="submit" disabled={gdtBusy} className="pb">
                      <span>Truy vấn Hóa đơn</span>
                    </button>
                  </div>
                )}
              </form>
            </div>

            {gdtInvoices.length > 0 && (
              <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[13px] tnum">Tìm thấy {gdtInvoices.length} hóa đơn</span>
                  <button type="button" onClick={handleGdtDownloadAll} disabled={gdtBusy} className="pb">
                    <Download size={13} />
                    <span>Tải toàn bộ XML về Hộp thư</span>
                  </button>
                </div>
                <div className="max-h-[300px] overflow-auto divide-y divide-[var(--line)] text-[12px]">
                  {gdtInvoices.map((inv) => (
                    <div key={inv.id} className="py-2 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{inv.nbten} ({inv.nbmst})</div>
                        <div className="text-[11px] text-[var(--dim)] tnum">{inv.khmshdon}{inv.khhdon} · Số {inv.shdon}</div>
                      </div>
                      <span className="font-semibold tnum">{formatMoney(inv.tgtttbso)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeApp === "import" && (
          <div className="max-w-[760px] space-y-4">
            <label className="block rounded-[14px] border border-dashed border-[var(--line2)] bg-[var(--panel)] p-6 text-center cursor-pointer">
              <div className="text-[13.5px] font-semibold">Chọn tệp CSV hoặc Excel (.xlsx) cần nhập</div>
              <p className="text-[11.5px] text-[var(--muted)] mt-1">Tự động nhận diện cột & tạo danh mục mới nếu chưa có.</p>
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => handleImportFile(e.target.files)} />
            </label>

            {tabPreview && (
              <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold tnum">Xem trước {tabPreview.rows.length} dòng</span>
                  <button type="button" onClick={handleCommitImport} className="pb">Nhập tất cả vào Sổ</button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {tabPreview.headers.map((h) => (
                    <div key={h} className="p-2 rounded-[9px] bg-[var(--raised)] border border-[var(--line)]">
                      <div className="text-[11px] text-[var(--muted)] truncate mb-1">{h}</div>
                      <select
                        value={tabPreview.mapping[h] ?? ""}
                        onChange={(e) =>
                          setTabPreview({ ...tabPreview, mapping: { ...tabPreview.mapping, [h]: e.target.value } })
                        }
                        className="w-full h-7 px-2 rounded bg-[var(--panel-solid)] border border-[var(--line)] text-[11.5px]"
                      >
                        <option value="">Bỏ qua</option>
                        <option value="name">Nội dung</option>
                        <option value="merchant">Đối tác</option>
                        <option value="merchantTaxCode">MST</option>
                        <option value="totalAmount">Tổng tiền</option>
                        <option value="preTaxAmount">Trước thuế</option>
                        <option value="vatAmount">Thuế GTGT</option>
                        <option value="issuedAt">Ngày lập</option>
                        <option value="categoryName">Danh mục</option>
                        <option value="projectName">Dự án</option>
                        <option value="currencyCode">Tiền tệ</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
