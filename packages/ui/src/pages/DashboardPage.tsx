import React, { useEffect, useState } from "react"
import {
  ArrowDownLeft,
  ArrowUpRight,
  Scale,
  AlertTriangle,
  Upload,
  Sparkles,
  ShieldCheck,
  Clock
} from "lucide-react"
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport, fileToPayload } from "../transport/client.js"
import { formatMoney, formatShortVnd } from "../utils/format.js"
import type { NavPage } from "../components/LiquidShell.js"

interface DashboardProps {
  workspace: WorkspaceDTO
  onNavigate: (page: NavPage) => void
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
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
}

export function DashboardPage({ workspace, onNavigate, onRefreshCounts, onToast }: DashboardProps) {
  const transport = useTransport()
  const [period, setPeriod] = useState<"month" | "quarter" | "year" | "all">("year")
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [legalRules, setLegalRules] = useState<Array<Record<string, unknown>>>([])
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
    const { from, to } = computeDateRange(period)
    transport
      .getDashboardStats(workspace.id, from, to)
      .then((d) => setStats(d as unknown as DashboardStats))
      .catch(() => {})
    transport
      .listLegalRules()
      .then((r) => setLegalRules(r))
      .catch(() => {})
  }, [workspace.id, period, transport])

  const handleQuickDrop = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    try {
      const payloads = await Promise.all(Array.from(fileList).map(fileToPayload))
      const res = await transport.ingestFiles(workspace.id, payloads, "drop")
      onRefreshCounts()
      onToast(`Đã nạp ${res.createdFiles.length} chứng từ vào Hộp thư AI.`, "ok")
      onNavigate("unsorted")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi nạp tệp", "err")
    }
  }

  const s = stats ?? {
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
    categoryBreakdown: []
  }

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
        {/* Period Filter + Quick Drop Strip */}
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

        {/* Main 2-Col Analytics + Dropzone */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-[13.5px] font-semibold text-[var(--text)]">Dòng tiền Doanh thu & Chi phí theo tháng</h2>
                <p className="text-[11px] text-[var(--muted)]">Quy đổi về {workspace.baseCurrency} theo tỷ giá ngày lập chứng từ</p>
              </div>
              <span className="tag tnum">{s.monthlySeries.length} kỳ</span>
            </div>

            <div className="h-[240px] w-full">
              {s.monthlySeries.length === 0 ? (
                <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">
                  Chưa có dữ liệu giao dịch trong kỳ. Thả hóa đơn XML/PDF để bắt đầu.
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
                    <Bar dataKey="revenue" name="Doanh thu" fill="#34D399" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="expense" name="Chi phí" fill="#FB7185" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Drop Zone Widget */}
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
            className={`rounded-[14px] border border-dashed p-5 flex flex-col items-center justify-center text-center transition-colors ${
              dragging
                ? "border-[var(--cyan)] bg-[var(--cyan-s)]"
                : "border-[var(--line2)] bg-[var(--panel)]"
            }`}
          >
            <div className="w-11 h-11 rounded-[12px] grid place-items-center bg-[var(--raised)] border border-[var(--line)] text-[var(--cyan)] mb-3">
              <Upload size={20} strokeWidth={1.8} />
            </div>
            <div className="text-[13.5px] font-semibold text-[var(--text)]">Thả nhanh Hóa đơn & Chứng từ</div>
            <p className="text-[11.5px] text-[var(--muted)] mt-1 max-w-[230px]">
              Hỗ trợ XML (QĐ 1450/1510), PDF, ZIP cặp hóa đơn, hoặc ảnh chụp hóa đơn giấy.
            </p>
            <label className="pb mt-4 cursor-pointer">
              <span>Chọn tệp từ máy</span>
              <input
                type="file"
                multiple
                accept=".xml,.pdf,.zip,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={(e) => handleQuickDrop(e.target.files)}
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
