import React, { useEffect, useMemo, useState } from "react"
import {
  ArrowDownLeft,
  ArrowUpRight,
  Scale,
  AlertTriangle,
  Upload,
  Sparkles,
  ShieldCheck,
  Clock,
  CalendarClock,
  Inbox,
  ChevronRight
} from "lucide-react"
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport, smartIngestFileList } from "../transport/client.js"
import { formatMoney, formatShortVnd } from "../utils/format.js"
import type { NavPage } from "../components/LiquidShell.js"

interface DashboardProps {
  workspace: WorkspaceDTO
  onNavigate: (page: NavPage) => void
  onOpenTransaction?: (txId: string) => void
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

interface ActionItemRow {
  id: string
  name: string | null
  merchant: string | null
  invoiceNumber: string | null
  issuedAt: string | null
  totalAmount: number
  complianceStatus: string
}

interface DashboardStats {
  totalRevenue: number
  totalExpense: number
  netProfit: number
  outputVat: number
  inputVat: number
  vatPayable: number
  transactionCount: number
  unreviewedCount: number
  complianceWarnings: number
  monthlySeries: Array<{ period: string; revenue: number; expense: number; vatOut: number; vatIn: number }>
  categoryBreakdown: Array<{ code: string; name: string; color: string; total: number }>
  actionItems?: ActionItemRow[]
}

function getNextVatDeadline(taxPeriod: string): { label: string; dueText: string; daysLeft: number; urgent: boolean } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (taxPeriod === "monthly") {
    const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth()
    const due =
      now.getDate() <= 20
        ? new Date(now.getFullYear(), now.getMonth(), 20)
        : new Date(now.getFullYear(), now.getMonth() + 1, 20)
    const daysLeft = Math.ceil((due.getTime() - today.getTime()) / 86_400_000)
    return {
      label: `Tờ khai GTGT Tháng ${String(now.getDate() <= 20 ? prevMonth : now.getMonth() + 1).padStart(2, "0")}`,
      dueText: `${String(due.getDate()).padStart(2, "0")}/${String(due.getMonth() + 1).padStart(2, "0")}/${due.getFullYear()}`,
      daysLeft,
      urgent: daysLeft <= 7
    }
  }
  const currentQ = Math.floor(now.getMonth() / 3) + 1
  const qStartMonth = (currentQ - 1) * 3
  const inGraceWindow = now.getMonth() === qStartMonth
  const targetQ = inGraceWindow ? (currentQ === 1 ? 4 : currentQ - 1) : currentQ
  const due = inGraceWindow
    ? new Date(now.getFullYear(), qStartMonth + 1, 0)
    : new Date(now.getFullYear(), qStartMonth + 4, 0)
  const daysLeft = Math.ceil((due.getTime() - today.getTime()) / 86_400_000)
  return {
    label: `Tờ khai GTGT Quý ${targetQ}`,
    dueText: `${String(due.getDate()).padStart(2, "0")}/${String(due.getMonth() + 1).padStart(2, "0")}/${due.getFullYear()}`,
    daysLeft,
    urgent: daysLeft <= 10
  }
}

export function DashboardPage({ workspace, onNavigate, onOpenTransaction, onRefreshCounts, onToast }: DashboardProps) {
  const transport = useTransport()
  const [period, setPeriod] = useState<"month" | "quarter" | "year" | "all">("year")
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [legalRules, setLegalRules] = useState<Array<Record<string, unknown>>>([])
  const [taxPeriod, setTaxPeriod] = useState<string>("quarterly")
  const [dragging, setDragging] = useState(false)

  const computeDateRange = (p: typeof period): { from?: string; to?: string } => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    if (p === "month") {
      return { from: `${y}-${String(m + 1).padStart(2, "0")}-01` }
    }
    if (p === "quarter") {
      const qStart = Math.floor(m / 3) * 3 + 1
      return { from: `${y}-${String(qStart).padStart(2, "0")}-01` }
    }
    if (p === "year") {
      return { from: `${y}-01-01` }
    }
    return {}
  }

  useEffect(() => {
    let active = true
    const { from, to } = computeDateRange(period)
    transport
      .getDashboardStats(workspace.id, from, to)
      .then((d) => {
        if (active) setStats(d as unknown as DashboardStats)
      })
      .catch(() => {})
    transport
      .listLegalRules()
      .then((r) => {
        if (active) setLegalRules(r)
      })
      .catch(() => {})
    transport
      .getSettings(workspace.id)
      .then((cfg) => {
        if (active && cfg.tax_period) setTaxPeriod(cfg.tax_period)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [workspace.id, period, transport])

  const handleQuickDrop = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    try {
      const res = await smartIngestFileList(transport, workspace.id, fileList, "drop")
      onRefreshCounts()
      onToast(`Đã nạp ${res.createdFiles.length} chứng từ vào Hộp thư AI.`, "ok")
      onNavigate("unsorted")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi nạp tệp", "err")
    }
  }

  const s: DashboardStats = stats ?? {
    totalRevenue: 0,
    totalExpense: 0,
    netProfit: 0,
    outputVat: 0,
    inputVat: 0,
    vatPayable: 0,
    transactionCount: 0,
    unreviewedCount: 0,
    complianceWarnings: 0,
    monthlySeries: [],
    categoryBreakdown: [],
    actionItems: []
  }

  const deadline = useMemo(() => getNextVatDeadline(taxPeriod), [taxPeriod])
  const actionItems = s.actionItems ?? []
  const maxCat = s.categoryBreakdown[0]?.total || 1

  return (
    <div className="flex flex-col">
      {/* Geist 1px Structural Grid KPI Strip */}
      <div className="sgrid sgrid-4">
        <div className="sgrid-cell">
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--muted)]">
            <span>Doanh thu bán ra</span>
            <ArrowUpRight size={14} strokeWidth={1.8} className="text-[var(--green)]" />
          </div>
          <div className="mt-2 text-[22px] font-bold tracking-tight text-[var(--text)] tnum">
            {formatMoney(s.totalRevenue, workspace.baseCurrency)}
          </div>
          <div className="mt-1 text-[11px] text-[var(--dim)] tnum">
            VAT đầu ra: {formatMoney(s.outputVat, workspace.baseCurrency)}
          </div>
        </div>

        <div className="sgrid-cell">
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--muted)]">
            <span>Chi phí & Mua vào</span>
            <ArrowDownLeft size={14} strokeWidth={1.8} className="text-[var(--rose)]" />
          </div>
          <div className="mt-2 text-[22px] font-bold tracking-tight text-[var(--text)] tnum">
            {formatMoney(s.totalExpense, workspace.baseCurrency)}
          </div>
          <div className="mt-1 text-[11px] text-[var(--dim)] tnum">
            VAT khấu trừ: {formatMoney(s.inputVat, workspace.baseCurrency)}
          </div>
        </div>

        <div className="sgrid-cell">
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--muted)]">
            <span>{s.vatPayable >= 0 ? "Thuế GTGT dự kiến nộp" : "Thuế GTGT còn khấu trừ"}</span>
            <Scale size={14} strokeWidth={1.8} className="text-[var(--cyan)]" />
          </div>
          <div
            className={`mt-2 text-[22px] font-bold tracking-tight tnum ${
              s.vatPayable >= 0 ? "text-[var(--amber)]" : "text-[var(--green)]"
            }`}
          >
            {formatMoney(Math.abs(s.vatPayable), workspace.baseCurrency)}
          </div>
          <div className="mt-1 text-[11px] text-[var(--dim)] tnum">
            Lợi nhuận gộp: {formatShortVnd(s.netProfit)}
          </div>
        </div>

        <div className="sgrid-cell">
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--muted)]">
            <span>Hộp thư & Cảnh báo</span>
            <AlertTriangle
              size={14}
              strokeWidth={1.8}
              className={s.complianceWarnings > 0 ? "text-[var(--amber)]" : "text-[var(--green)]"}
            />
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <button
              type="button"
              onClick={() => onNavigate("unsorted")}
              className="text-[22px] font-bold tracking-tight text-[var(--cyan)] hover:underline tnum"
            >
              {s.unreviewedCount}
            </button>
            <span className="text-[12px] text-[var(--muted)]">chờ duyệt</span>
          </div>
          <div className="mt-1 text-[11px] text-[var(--dim)] tnum">
            {s.complianceWarnings} cảnh báo · {s.transactionCount} chứng từ
          </div>
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-5">
        {/* Period Filter + Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="seg">
            {[
              { id: "month", label: "Tháng này" },
              { id: "quarter", label: "Quý này" },
              { id: "year", label: "Năm nay" },
              { id: "all", label: "Tất cả" }
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                className={period === item.id ? "on" : ""}
                onClick={() => setPeriod(item.id as typeof period)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onNavigate("converter")} className="gb">
              <Sparkles size={13.5} strokeWidth={1.8} />
              <span>Quét lô XML</span>
            </button>
            <button type="button" onClick={() => onNavigate("transactions")} className="gb">
              <span>Mở Sổ giao dịch</span>
            </button>
          </div>
        </div>

        {/* Main 2-Col Analytics + Actionable Queue */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-[13.5px] font-semibold text-[var(--text)]">Dòng tiền Doanh thu & Chi phí theo tháng</h2>
                <p className="text-[11px] text-[var(--muted)]">
                  Quy đổi về {workspace.baseCurrency} theo tỷ giá ngày lập chứng từ
                </p>
              </div>
              <span className="tag tnum">{s.monthlySeries.length} kỳ</span>
            </div>

            <div className="h-[250px] w-full">
              {s.monthlySeries.length === 0 ? (
                <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">
                  Chưa có dữ liệu giao dịch trong kỳ. Thả hóa đơn XML/PDF vào cửa sổ để bắt đầu.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={s.monthlySeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                    <XAxis dataKey="period" stroke="var(--dim)" fontSize={11} />
                    <YAxis stroke="var(--dim)" fontSize={11} tickFormatter={(v) => formatShortVnd(Number(v))} width={68} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--menu-bg)",
                        border: "1px solid var(--line2)",
                        borderRadius: "10px",
                        fontSize: "12px",
                        color: "var(--text)"
                      }}
                    />
                    <Bar dataKey="revenue" name="Doanh thu" fill="#34D399" radius={[4, 4, 0, 0]} maxBarSize={42} />
                    <Bar dataKey="expense" name="Chi phí" fill="#FB7185" radius={[4, 4, 0, 0]} maxBarSize={42} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Actionable Queue */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              handleQuickDrop(e.dataTransfer.files)
            }}
            className={`rounded-[14px] border p-4 flex flex-col justify-between gap-3 transition-colors ${
              dragging ? "border-[var(--cyan)] bg-[var(--cyan-s)]" : "border-[var(--line)] bg-[var(--panel)]"
            }`}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[13.5px] font-semibold text-[var(--text)]">Hàng đợi cần xử lý</h2>
                <button
                  type="button"
                  onClick={() => onNavigate("unsorted")}
                  className="text-[11px] font-medium text-[var(--cyan)] hover:underline"
                >
                  Tới Hộp thư
                </button>
              </div>

              {/* VAT Deadline Banner */}
              <div className="p-2.5 rounded-[10px] border border-[var(--line)] bg-[var(--raised)] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CalendarClock
                    size={15}
                    strokeWidth={1.8}
                    className={deadline.urgent ? "text-[var(--amber)] shrink-0" : "text-[var(--cyan)] shrink-0"}
                  />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-[var(--text)] truncate">{deadline.label}</div>
                    <div className="text-[11px] text-[var(--muted)] tnum">Hạn nộp {deadline.dueText}</div>
                  </div>
                </div>
                <span className={`tag tnum shrink-0 ${deadline.urgent ? "tag-warn" : "tag-info"}`}>
                  {deadline.daysLeft >= 0 ? `Còn ${deadline.daysLeft} ngày` : `Quá hạn ${Math.abs(deadline.daysLeft)}n`}
                </span>
              </div>

              {/* Unreviewed shortcut */}
              {s.unreviewedCount > 0 && (
                <button
                  type="button"
                  onClick={() => onNavigate("unsorted")}
                  className="w-full p-2.5 rounded-[10px] border border-[var(--line2)] bg-[var(--cyan-s)] flex items-center justify-between gap-2 text-left hover:brightness-105"
                >
                  <span className="flex items-center gap-2 text-[12px] font-semibold text-[var(--cyan)]">
                    <Inbox size={14} strokeWidth={1.9} />
                    <span className="tnum">{s.unreviewedCount} chứng từ chờ bóc tách / ghi sổ</span>
                  </span>
                  <ChevronRight size={14} className="text-[var(--cyan)] shrink-0" />
                </button>
              )}

              {/* Compliance warning items */}
              <div className="space-y-1.5">
                {actionItems.length === 0 ? (
                  <div className="py-3 text-center text-[11.5px] text-[var(--dim)] rounded-[10px] border border-[var(--line)] bg-[var(--raised)]">
                    Không có giao dịch lỗi/cảnh báo chờ xử lý.
                  </div>
                ) : (
                  actionItems.slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (onOpenTransaction) onOpenTransaction(item.id)
                        else onNavigate("transactions")
                      }}
                      className="w-full p-2 rounded-[9px] border border-[var(--line)] bg-[var(--raised)] hover:bg-[var(--row-h)] flex items-center justify-between gap-2 text-left"
                    >
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-[var(--text)] truncate">
                          {item.merchant || item.name || item.invoiceNumber || "Chứng từ"}
                        </div>
                        <div className="text-[10.5px] text-[var(--muted)] tnum">
                          {item.invoiceNumber ? `Số ${item.invoiceNumber} · ` : ""}
                          {item.issuedAt ?? "—"}
                        </div>
                      </div>
                      <span className={`tag shrink-0 tnum ${item.complianceStatus === "error" ? "tag-err" : "tag-warn"}`}>
                        {formatShortVnd(item.totalAmount)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Compact Upload Strip */}
            <label className="mt-1 px-3 py-2.5 rounded-[10px] border border-dashed border-[var(--line2)] bg-[var(--raised)] hover:border-[var(--cyan)] cursor-pointer flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[12px] font-medium text-[var(--text)] min-w-0 truncate">
                <Upload size={14} strokeWidth={1.8} className="text-[var(--cyan)] shrink-0" />
                <span className="truncate">Nạp nhanh XML, PDF, ZIP, Ảnh</span>
              </span>
              <span className="text-[11px] font-semibold text-[var(--cyan)] shrink-0 whitespace-nowrap">Chọn tệp</span>
              <input
                type="file"
                multiple
                accept=".xml,.pdf,.zip,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={(e) => {
                  handleQuickDrop(e.target.files)
                  e.target.value = ""
                }}
              />
            </label>
          </div>
        </div>

        {/* Category Breakdown + Vietnam Tax Legal Rule Radar */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4">
            <h2 className="text-[13.5px] font-semibold text-[var(--text)] mb-3">Cơ cấu chi phí theo danh mục</h2>
            {s.categoryBreakdown.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[var(--dim)]">Chưa có chi phí được hạch toán.</div>
            ) : (
              <div className="space-y-2.5">
                {s.categoryBreakdown.slice(0, 6).map((cat) => (
                  <div key={cat.code} className="space-y-1">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-2 text-[var(--text)] font-medium">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                        {cat.name}
                      </span>
                      <span className="tnum text-[var(--muted)]">{formatMoney(cat.total, workspace.baseCurrency)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[var(--track)] overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.round((cat.total / maxCat) * 100)}%`, backgroundColor: cat.color }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13.5px] font-semibold text-[var(--text)] flex items-center gap-2">
                <ShieldCheck size={15} strokeWidth={1.8} className="text-[var(--green)]" />
                <span>Bộ nhớ Pháp lý Thuế VN (TTL)</span>
              </h2>
              <button type="button" onClick={() => onNavigate("settings")} className="text-[11.5px] text-[var(--cyan)] hover:underline">
                Chi tiết
              </button>
            </div>
            <div className="space-y-2">
              {legalRules.map((rule) => {
                const exp = new Date(String(rule.expiresAt ?? ""))
                const expired = Number.isNaN(exp.getTime()) ? true : new Date() > exp
                return (
                  <div
                    key={String(rule.ruleKey)}
                    className="p-2.5 rounded-[10px] border border-[var(--line)] bg-[var(--raised)] flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-[var(--text)] truncate">{String(rule.title)}</div>
                      <div className="text-[11px] text-[var(--muted)] truncate">
                        {String(rule.documentRef)} · Hiệu lực {String(rule.effectiveFrom)}
                      </div>
                    </div>
                    <span className={`tag shrink-0 ${expired ? "tag-warn" : "tag-ok"}`}>
                      <Clock size={10} strokeWidth={2} />
                      <span>{expired ? "Cần rà soát" : `Hạn ${String(rule.expiresAt)}`}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
