import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Download, CheckCircle2, Copy, Plus, Trash2, Calculator } from "lucide-react"
import type { ArApAgingReport, FixedAssetDTO, WorkspaceDTO } from "@t-tax/core/browser"
import { useTransport } from "../transport/client.js"
import { formatDateVi, formatMoney } from "../utils/format.js"
import { MoneyInput } from "../components/MoneyInput.js"

interface SubTabProps {
  workspace: WorkspaceDTO
  onChanged: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

export function ArApAgingTab({ workspace, onChanged, onToast }: SubTabProps) {
  const transport = useTransport()
  const [report, setReport] = useState<ArApAgingReport | null>(null)
  const [filterDir, setFilterDir] = useState<"all" | "receivable" | "payable">("all")
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setReport(await transport.getArApAging(workspace.id))
  }, [workspace.id, transport])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const rows = useMemo(() => {
    if (!report) return []
    if (filterDir === "all") return report.rows
    return report.rows.filter((r) => r.direction === filterDir)
  }, [report, filterDir])

  const markRowPaid = async (counterpartyKey: string, txIds: string[]) => {
    setBusyId(counterpartyKey)
    try {
      await transport.bulkUpdateTransactions(workspace.id, txIds, { paymentStatus: "paid" })
      onToast(`Đã đánh dấu thanh toán ${txIds.length} hóa đơn công nợ.`, "ok")
      await load()
      onChanged()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Không thể cập nhật trạng thái thanh toán", "err")
    } finally {
      setBusyId(null)
    }
  }

  const copyReminder = async (r: ArApAgingReport["rows"][number]) => {
    const msg = `Kính gửi ${r.name}${r.taxCode ? ` (MST: ${r.taxCode})` : ""},\n\n${workspace.name} xin gửi thông báo đối chiếu công nợ tính đến ngày ${report?.asOfDate ?? ""}:\n- Tổng số dư chưa thanh toán (${r.invoiceCount} hóa đơn): ${formatMoney(r.buckets.total)}\n- Hóa đơn lâu nhất từ ngày: ${formatDateVi(r.oldestDate)}\n\nKính mong Quý đối tác sắp xếp thanh toán sớm. Trân trọng!`
    try {
      await navigator.clipboard.writeText(msg)
      onToast("Đã sao chép mẫu thông báo nhắc công nợ.", "ok")
    } catch {
      onToast("Không thể sao chép tự động.", "warn")
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-3 overflow-hidden">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="text-[11px] text-[var(--muted)]">Tổng Phải thu (AR 131)</div>
          <div className="text-[18px] font-bold tnum text-[var(--green)] mt-0.5">
            {formatMoney(report?.receivableTotal ?? 0)}
          </div>
          <div className="text-[10.5px] text-[var(--dim)] tnum">
            &gt;90 ngày: {formatMoney(report?.receivableBuckets.over90 ?? 0)}
          </div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="text-[11px] text-[var(--muted)]">Tổng Phải trả (AP 331)</div>
          <div className="text-[18px] font-bold tnum text-[var(--rose)] mt-0.5">
            {formatMoney(report?.payableTotal ?? 0)}
          </div>
          <div className="text-[10.5px] text-[var(--dim)] tnum">
            &gt;90 ngày: {formatMoney(report?.payableBuckets.over90 ?? 0)}
          </div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="text-[11px] text-[var(--muted)]">Chênh lệch Công nợ ròng</div>
          <div className="text-[18px] font-bold tnum text-[var(--cyan)] mt-0.5">
            {formatMoney((report?.receivableTotal ?? 0) - (report?.payableTotal ?? 0))}
          </div>
          <div className="text-[10.5px] text-[var(--dim)]">Phải thu − Phải trả</div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 flex flex-col justify-between">
          <div className="text-[11px] text-[var(--muted)]">Xuất báo cáo Tuổi nợ</div>
          <button
            type="button"
            onClick={async () => {
              if (!transport.exportArApAgingExcel) return
              const res = await transport.exportArApAgingExcel(workspace.id)
              if (!res.canceled && res.savedPath) onToast(`Đã xuất Excel Công nợ: ${res.savedPath}`, "ok")
            }}
            className="gb mt-1 justify-center"
          >
            <Download size={13} />
            <span>Xuất Excel AR/AP</span>
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="seg">
          <button type="button" className={filterDir === "all" ? "on" : ""} onClick={() => setFilterDir("all")}>
            Tất cả ({report?.rows.length ?? 0})
          </button>
          <button type="button" className={filterDir === "receivable" ? "on" : ""} onClick={() => setFilterDir("receivable")}>
            Phải thu (131)
          </button>
          <button type="button" className={filterDir === "payable" ? "on" : ""} onClick={() => setFilterDir("payable")}>
            Phải trả (331)
          </button>
        </div>
        <span className="text-[11.5px] text-[var(--dim)] tnum">Tính đến ngày {formatDateVi(report?.asOfDate)}</span>
      </div>

      <div className="flex-1 min-h-0 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-auto">
        <table className="w-full text-left border-collapse text-[12px]">
          <thead className="sticky top-0 bg-[var(--panel-solid)] border-b border-[var(--line)] text-[10.5px] uppercase tracking-wider text-[var(--muted)]">
            <tr>
              <th className="py-2.5 px-3">Loại</th>
              <th className="py-2.5 px-3">Đối tác / MST</th>
              <th className="py-2.5 px-3 text-right">0–30 ngày</th>
              <th className="py-2.5 px-3 text-right">31–60 ngày</th>
              <th className="py-2.5 px-3 text-right">61–90 ngày</th>
              <th className="py-2.5 px-3 text-right">&gt; 90 ngày</th>
              <th className="py-2.5 px-3 text-right">Tổng công nợ</th>
              <th className="py-2.5 px-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-[var(--dim)]">
                  Không có hóa đơn chưa thanh toán (unpaid/partial) trong kỳ.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.counterpartyKey} className="hover:bg-[var(--hover)]">
                  <td className="py-2 px-3">
                    <span className={`tag ${r.direction === "receivable" ? "tag-ok" : "tag-warn"}`}>
                      {r.direction === "receivable" ? "Phải thu" : "Phải trả"}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-[10.5px] text-[var(--dim)] tnum">
                      {r.taxCode || "Không có MST"} · {r.invoiceCount} HĐ · Cũ nhất {formatDateVi(r.oldestDate)}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right tnum">{formatMoney(r.buckets.current0To30)}</td>
                  <td className="py-2 px-3 text-right tnum text-[var(--amber)]">{formatMoney(r.buckets.days31To60)}</td>
                  <td className="py-2 px-3 text-right tnum text-[var(--amber)]">{formatMoney(r.buckets.days61To90)}</td>
                  <td className="py-2 px-3 text-right tnum text-[var(--rose)] font-semibold">{formatMoney(r.buckets.over90)}</td>
                  <td className="py-2 px-3 text-right tnum font-bold">{formatMoney(r.buckets.total)}</td>
                  <td className="py-2 px-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button type="button" onClick={() => void copyReminder(r)} className="gb text-[11px]" title="Copy mẫu nhắc nợ">
                        <Copy size={12} />
                      </button>
                      <button
                        type="button"
                        disabled={busyId === r.counterpartyKey}
                        onClick={() => void markRowPaid(r.counterpartyKey, r.transactionIds)}
                        className="gb text-[11px]"
                        title="Đánh dấu đã thanh toán tất cả HĐ"
                      >
                        <CheckCircle2 size={12} className="text-[var(--green)]" />
                        <span>Đã TT</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function FixedAssetsTab({ workspace, onChanged, onToast }: SubTabProps) {
  const transport = useTransport()
  const [assets, setAssets] = useState<FixedAssetDTO[]>([])
  const [periodYm, setPeriodYm] = useState(() => new Date().toISOString().slice(0, 7))
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    code: "",
    name: "",
    assetType: "tscd" as "tscd" | "ccdc",
    purchaseDate: new Date().toISOString().slice(0, 10),
    originalCostVnd: 0,
    usefulLifeMonths: 36,
    department: "Văn phòng"
  })

  const load = useCallback(async () => {
    setAssets(await transport.listFixedAssets(workspace.id))
  }, [workspace.id, transport])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const totals = useMemo(() => {
    return assets.reduce(
      (acc, a) => ({
        cost: acc.cost + a.originalCostVnd,
        accDep: acc.accDep + a.accumulatedDepreciationVnd,
        remain: acc.remain + a.remainingValueVnd,
        monthly: acc.monthly + (a.status === "active" ? a.monthlyDepreciationVnd : 0)
      }),
      { cost: 0, accDep: 0, remain: 0, monthly: 0 }
    )
  }, [assets])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || form.originalCostVnd <= 0) {
      onToast("Nhập tên tài sản và nguyên giá > 0.", "warn")
      return
    }
    try {
      await transport.createFixedAsset(workspace.id, form)
      setForm({ ...form, code: "", name: "", originalCostVnd: 0 })
      onToast("Đã ghi tăng TSCĐ / CCDC mới.", "ok")
      await load()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi thêm tài sản", "err")
    }
  }

  const handleRunDepreciation = async () => {
    setBusy(true)
    try {
      const res = await transport.runMonthlyDepreciation(workspace.id, periodYm)
      if (res.postedCount === 0) {
        onToast(`Không có tài sản cần trích khấu hao / phân bổ cho kỳ ${periodYm}.`, "warn")
      } else {
        onToast(
          `Đã trích khấu hao ${res.postedCount} tài sản (${formatMoney(res.totalAmountVnd)}) — Phiếu ${res.voucherNo}.`,
          "ok"
        )
        await load()
        onChanged()
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi trích khấu hao", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-3 overflow-y-auto">
      <div className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.45fr] gap-3 shrink-0">
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="text-[11px] text-[var(--muted)]">Tổng Nguyên giá</div>
          <div className="text-[18px] font-bold tnum mt-0.5">{formatMoney(totals.cost)}</div>
          <div className="text-[10.5px] text-[var(--dim)]">{assets.length} tài sản / CCDC</div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="text-[11px] text-[var(--muted)]">Khấu hao / Phân bổ lũy kế</div>
          <div className="text-[18px] font-bold tnum text-[var(--amber)] mt-0.5">{formatMoney(totals.accDep)}</div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="text-[11px] text-[var(--muted)]">Giá trị còn lại</div>
          <div className="text-[18px] font-bold tnum text-[var(--cyan)] mt-0.5">{formatMoney(totals.remain)}</div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 space-y-1.5">
          <div className="text-[11px] text-[var(--muted)]">Trích khấu hao kỳ (Nợ 642 / Có 214,242)</div>
          <div className="flex items-center gap-1.5">
            <input
              type="month"
              value={periodYm}
              onChange={(e) => setPeriodYm(e.target.value)}
              className="h-8 px-2 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[11.5px] tnum flex-1 min-w-0"
            />
            <button type="button" disabled={busy} onClick={() => void handleRunDepreciation()} className="gb gb-p h-8">
              <Calculator size={12.5} />
              <span>Trích</span>
            </button>
          </div>
        </div>
      </div>

      {/* Add Fixed Asset / CCDC form */}
      <form
        onSubmit={handleCreate}
        className="rounded-[13px] border border-[var(--line)] bg-[var(--panel)] p-3.5 grid grid-cols-1 md:grid-cols-12 gap-2.5 items-end shrink-0"
      >
        <div className="md:col-span-2">
          <label className="block text-[10.5px] text-[var(--muted)] mb-1">Loại</label>
          <select
            value={form.assetType}
            onChange={(e) => {
              const t = e.target.value as "tscd" | "ccdc"
              setForm({ ...form, assetType: t, usefulLifeMonths: t === "tscd" ? 36 : 12 })
            }}
            className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
          >
            <option value="tscd" className="bg-[var(--panel-solid)]">TSCĐ (TK 211)</option>
            <option value="ccdc" className="bg-[var(--panel-solid)]">CCDC (TK 242)</option>
          </select>
        </div>
        <div className="md:col-span-3">
          <label className="block text-[10.5px] text-[var(--muted)] mb-1">Tên tài sản / CCDC</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="VD: MacBook Pro M4 / Bàn làm việc"
            className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10.5px] text-[var(--muted)] mb-1">Ngày ghi tăng</label>
          <input
            type="date"
            value={form.purchaseDate}
            onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })}
            className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10.5px] text-[var(--muted)] mb-1">Nguyên giá (VND)</label>
          <MoneyInput
            value={form.originalCostVnd}
            onChange={(v) => setForm({ ...form, originalCostVnd: v })}
            className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
          />
        </div>
        <div className="md:col-span-1">
          <label className="block text-[10.5px] text-[var(--muted)] mb-1">Số tháng</label>
          <input
            type="number"
            min={1}
            max={360}
            value={form.usefulLifeMonths}
            onChange={(e) => setForm({ ...form, usefulLifeMonths: Number(e.target.value) || 12 })}
            className="w-full h-9 px-2 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
          />
        </div>
        <div className="md:col-span-2">
          <button type="submit" className="gb gb-p w-full justify-center h-9">
            <Plus size={13.5} />
            <span>Ghi tăng</span>
          </button>
        </div>
      </form>

      {/* Asset Table */}
      <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full text-left border-collapse text-[12px]">
          <thead>
            <tr className="bg-[var(--raised)] border-b border-[var(--line)] text-[10.5px] uppercase tracking-wider text-[var(--muted)]">
              <th className="py-2.5 px-3">Mã / Loại</th>
              <th className="py-2.5 px-3">Tên tài sản</th>
              <th className="py-2.5 px-3">TK Nợ / Có</th>
              <th className="py-2.5 px-3 text-right">Nguyên giá</th>
              <th className="py-2.5 px-3 text-right">Trích/tháng</th>
              <th className="py-2.5 px-3 text-right">Còn lại</th>
              <th className="py-2.5 px-3 text-right">Kỳ trích gần nhất</th>
              <th className="py-2.5 px-3 text-right">Xóa</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {assets.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-[var(--dim)]">
                  Chưa có TSCĐ (TK 211) hoặc CCDC (TK 242). Thêm tài sản phía trên để trích khấu hao tự động hàng tháng.
                </td>
              </tr>
            ) : (
              assets.map((a) => (
                <tr key={a.id} className="hover:bg-[var(--hover)]">
                  <td className="py-2 px-3">
                    <div className="font-mono font-semibold text-[11.5px]">{a.code}</div>
                    <span className={`tag ${a.assetType === "tscd" ? "tag-ok" : ""}`}>
                      {a.assetType === "tscd" ? "TSCĐ" : "CCDC"}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-[10.5px] text-[var(--dim)] tnum">
                      Mua {formatDateVi(a.purchaseDate)} · {a.usefulLifeMonths} tháng
                    </div>
                  </td>
                  <td className="py-2 px-3 font-mono text-[11.5px] text-[var(--cyan)]">
                    {a.expenseAccount} / {a.depreciationAccount}
                  </td>
                  <td className="py-2 px-3 text-right tnum">{formatMoney(a.originalCostVnd)}</td>
                  <td className="py-2 px-3 text-right tnum text-[var(--amber)]">{formatMoney(a.monthlyDepreciationVnd)}</td>
                  <td className="py-2 px-3 text-right tnum font-semibold">{formatMoney(a.remainingValueVnd)}</td>
                  <td className="py-2 px-3 text-right tnum text-[var(--muted)]">{a.lastDepreciatedPeriod || "Chưa trích"}</td>
                  <td className="py-2 px-3 text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        await transport.deleteFixedAsset(workspace.id, a.id)
                        await load()
                        onToast(`Đã xóa tài sản ${a.code}.`, "ok")
                      }}
                      className="text-[var(--rose)] hover:opacity-80"
                    >
                      <Trash2 size={13.5} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
