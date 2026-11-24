import React, { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Download,
  Plus,
  Search,
  LayoutList,
  LayoutGrid,
  SlidersHorizontal,
  Trash2,
  X,
  Check
} from "lucide-react"
import type { TransactionDirection, WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

interface TransactionsProps {
  workspace: WorkspaceDTO
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

interface TxRow {
  id: string
  name: string | null
  merchant: string | null
  merchantTaxCode: string | null
  direction: TransactionDirection
  preTaxAmount: number
  vatAmount: number
  totalAmount: number
  currencyCode: string
  convertedTotalVnd: number | null
  vatRateCode: string | null
  invoiceSymbol: string | null
  invoiceNumber: string | null
  categoryCode: string | null
  projectCode: string | null
  issuedAt: string | null
  paymentMethod: string | null
  paymentStatus: string
  complianceStatus: string
  note: string | null
  extraJson: string | null
}

export function TransactionsPage({ workspace, onToast }: TransactionsProps) {
  const transport = useTransport()
  const [rows, setRows] = useState<TxRow[]>([])
  const [total, setTotal] = useState(0)
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([])
  const [projects, setProjects] = useState<Array<Record<string, unknown>>>([])
  const [fields, setFields] = useState<Array<Record<string, unknown>>>([])
  const [visibleCols, setVisibleCols] = useState<string[]>([
    "issuedAt",
    "invoiceNumber",
    "merchant",
    "name",
    "categoryCode",
    "preTaxAmount",
    "vatAmount",
    "totalAmount",
    "complianceStatus"
  ])

  const [search, setSearch] = useState("")
  const [direction, setDirection] = useState<"all" | "input" | "output">("all")
  const [categoryCode, setCategoryCode] = useState("")
  const [complianceFilter, setComplianceFilter] = useState("")
  const [viewMode, setViewMode] = useState<"list" | "grid">("list")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showColPicker, setShowColPicker] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [editingTx, setEditingTx] = useState<TxRow | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)

  const [newForm, setNewForm] = useState({
    name: "",
    merchant: "",
    merchantTaxCode: "",
    direction: "input" as TransactionDirection,
    preTaxAmount: 0,
    vatAmount: 0,
    totalAmount: 0,
    currencyCode: workspace.baseCurrency || "VND",
    categoryCode: "other",
    projectCode: "general",
    issuedAt: new Date().toISOString().slice(0, 10)
  })

  const loadData = useCallback(async () => {
    const [txRes, cats, projs, flds] = await Promise.all([
      transport.listTransactions(workspace.id, {
        search: search || undefined,
        direction,
        categoryCode: categoryCode || undefined,
        complianceStatus: complianceFilter || undefined,
        limit: 10000
      }),
      transport.listCategories(workspace.id),
      transport.listProjects(workspace.id),
      transport.listFields(workspace.id)
    ])
    setRows(txRes.rows as unknown as TxRow[])
    setTotal(txRes.total)
    setCategories(cats)
    setProjects(projs)
    setFields(flds)
  }, [workspace.id, search, direction, categoryCode, complianceFilter, transport])

  useEffect(() => {
    const t = setTimeout(() => {
      loadData().catch(() => {})
    }, 120)
    return () => clearTimeout(t)
  }, [loadData])

  const catMap = useMemo(() => new Map(categories.map((c) => [String(c.code), c])), [categories])

  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 14
  })

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkCategory = async (code: string) => {
    await transport.bulkUpdateTransactions(workspace.id, [...selectedIds], { categoryCode: code })
    onToast(`Đã cập nhật danh mục cho ${selectedIds.size} giao dịch.`, "ok")
    setSelectedIds(new Set())
    loadData()
  }

  const handleBulkDelete = async () => {
    await transport.deleteTransactions(workspace.id, [...selectedIds])
    onToast(`Đã xóa ${selectedIds.size} giao dịch.`, "ok")
    setSelectedIds(new Set())
    loadData()
  }

  const handleExport = async (kind: "htkk_in" | "htkk_out" | "misa_in" | "misa_out" | "fast_bravo" | "csv" | "zip") => {
    setShowExportMenu(false)
    try {
      const res = await transport.exportReport(workspace.id, kind, {
        search: search || undefined,
        direction,
        categoryCode: categoryCode || undefined
      })
      if (!res.canceled) {
        onToast(`Đã xuất tệp: ${res.savedPath}`, "ok")
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xuất báo cáo", "err")
    }
  }

  const handleCreateManual = async (e: React.FormEvent) => {
    e.preventDefault()
    await transport.createTransaction(workspace.id, newForm)
    setShowNewModal(false)
    onToast("Đã tạo giao dịch mới.", "ok")
    loadData()
  }

  const handleSaveEdit = async () => {
    if (!editingTx) return
    await transport.updateTransaction(workspace.id, editingTx.id, {
      name: editingTx.name,
      merchant: editingTx.merchant,
      merchantTaxCode: editingTx.merchantTaxCode,
      preTaxAmount: editingTx.preTaxAmount,
      vatAmount: editingTx.vatAmount,
      totalAmount: editingTx.totalAmount,
      categoryCode: editingTx.categoryCode,
      projectCode: editingTx.projectCode,
      note: editingTx.note
    })
    setEditingTx(null)
    onToast("Đã lưu thay đổi giao dịch.", "ok")
    loadData()
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* Filter Pill Bar */}
      <div className="px-5 py-3 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--sheet-bg)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm MST, tên NCC, số HĐ, mặt hàng..."
              className="h-[30px] w-[220px] pl-8 pr-3 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none focus:border-[var(--cyan)]"
            />
          </div>

          <div className="seg">
            {[
              { id: "all", label: "Tất cả" },
              { id: "input", label: "Mua vào" },
              { id: "output", label: "Bán ra" }
            ].map((d) => (
              <button
                key={d.id}
                type="button"
                className={direction === d.id ? "on" : ""}
                onClick={() => setDirection(d.id as typeof direction)}
              >
                {d.label}
              </button>
            ))}
          </div>

          <select
            value={categoryCode}
            onChange={(e) => setCategoryCode(e.target.value)}
            className="h-[30px] px-3 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none"
          >
            <option value="" className="bg-[var(--panel-solid)]">Mọi danh mục</option>
            {categories.map((c) => (
              <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                {String(c.name)}
              </option>
            ))}
          </select>

          <select
            value={complianceFilter}
            onChange={(e) => setComplianceFilter(e.target.value)}
            className="h-[30px] px-3 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none"
          >
            <option value="" className="bg-[var(--panel-solid)]">Mọi trạng thái</option>
            <option value="valid" className="bg-[var(--panel-solid)]">Hợp lệ</option>
            <option value="warning" className="bg-[var(--panel-solid)]">Cảnh báo</option>
            <option value="error" className="bg-[var(--panel-solid)]">Lỗi</option>
          </select>
        </div>

        <div className="flex items-center gap-2 relative">
          <span className="text-[11.5px] text-[var(--muted)] tnum">{total} dòng</span>

          <div className="seg">
            <button type="button" className={viewMode === "list" ? "on" : ""} onClick={() => setViewMode("list")}>
              <LayoutList size={13} />
            </button>
            <button type="button" className={viewMode === "grid" ? "on" : ""} onClick={() => setViewMode("grid")}>
              <LayoutGrid size={13} />
            </button>
          </div>

          <button type="button" onClick={() => setShowColPicker(!showColPicker)} className="gb">
            <SlidersHorizontal size={13} />
            <span>Cột</span>
          </button>

          <div className="relative">
            <button type="button" onClick={() => setShowExportMenu(!showExportMenu)} className="gb">
              <Download size={13} />
              <span>Xuất Excel / ZIP</span>
            </button>
            {showExportMenu && (
              <div className="menu absolute right-0 mt-1.5 w-[240px]">
                {[
                  { id: "htkk_in", label: "Bảng kê Mua vào (HTKK .xlsx)" },
                  { id: "htkk_out", label: "Bảng kê Bán ra (HTKK .xlsx)" },
                  { id: "misa_in", label: "Import MISA Mua hàng (.xlsx)" },
                  { id: "misa_out", label: "Import MISA Bán hàng (.xlsx)" },
                  { id: "fast_bravo", label: "Import Fast / Bravo (.xlsx)" },
                  { id: "csv", label: "CSV chuẩn TaxHacker (.csv)" },
                  { id: "zip", label: "CSV + Chứng từ gốc (.zip)" }
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleExport(opt.id as Parameters<typeof handleExport>[0])}
                    className="w-full text-left px-3 py-1.5 rounded-[9px] text-[12px] text-[var(--text)] hover:bg-[var(--sel)]"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button type="button" onClick={() => setShowNewModal(true)} className="pb">
            <Plus size={13.5} strokeWidth={2.2} />
            <span>Thêm</span>
          </button>

          {showColPicker && (
            <div className="menu absolute right-0 top-10 w-[230px] max-h-[290px] overflow-y-auto p-2 space-y-1">
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--dim)] px-2 py-1">Chọn cột hiển thị</div>
              {[
                { code: "issuedAt", name: "Ngày lập" },
                { code: "invoiceNumber", name: "Số hóa đơn" },
                { code: "merchant", name: "Đối tác" },
                { code: "name", name: "Nội dung" },
                { code: "categoryCode", name: "Danh mục" },
                { code: "preTaxAmount", name: "Trước thuế" },
                { code: "vatAmount", name: "Thuế GTGT" },
                { code: "totalAmount", name: "Tổng tiền" },
                { code: "complianceStatus", name: "Tuân thủ" },
                ...fields.filter((f) => Boolean(f.isExtra)).map((f) => ({ code: String(f.code), name: String(f.name) }))
              ].map((col) => {
                const on = visibleCols.includes(col.code)
                return (
                  <button
                    key={col.code}
                    type="button"
                    onClick={() =>
                      setVisibleCols((prev) =>
                        prev.includes(col.code) ? prev.filter((c) => c !== col.code) : [...prev, col.code]
                      )
                    }
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-[8px] text-[12px] hover:bg-[var(--sel)]"
                  >
                    <span>{col.name}</span>
                    {on && <Check size={13} className="text-[var(--cyan)]" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Main Table or Grid */}
      {viewMode === "list" ? (
        <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
          <div className="min-w-[920px]">
          <div className="sticky top-0 z-10 flex items-center px-3.5 h-9 bg-[var(--raised)] border-b border-[var(--line)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            <div className="w-7 shrink-0">
              <input
                type="checkbox"
                checked={rows.length > 0 && selectedIds.size === rows.length}
                onChange={(e) => setSelectedIds(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
              />
            </div>
            {visibleCols.includes("issuedAt") && <div className="w-[82px] shrink-0">Ngày</div>}
            {visibleCols.includes("invoiceNumber") && <div className="w-[78px] shrink-0">Số HĐ</div>}
            {visibleCols.includes("merchant") && <div className="w-[155px] shrink-0">Đối tác / MST</div>}
            {visibleCols.includes("name") && <div className="flex-1 min-w-[140px]">Nội dung</div>}
            {visibleCols.includes("categoryCode") && <div className="w-[118px] shrink-0">Danh mục</div>}
            {visibleCols.includes("preTaxAmount") && <div className="w-[95px] text-right shrink-0">Trước thuế</div>}
            {visibleCols.includes("vatAmount") && <div className="w-[80px] text-right shrink-0">VAT</div>}
            {visibleCols.includes("totalAmount") && <div className="w-[108px] text-right shrink-0">Tổng cộng</div>}
            {visibleCols.includes("complianceStatus") && <div className="w-[84px] text-right shrink-0">Trạng thái</div>}
          </div>

          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const r = rows[vr.index]!
              const cat = catMap.get(r.categoryCode ?? "")
              const checked = selectedIds.has(r.id)
              return (
                <div
                  key={r.id}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${vr.size}px`, transform: `translateY(${vr.start}px)` }}
                  className="flex items-center px-3.5 border-b border-[var(--line)] hover:bg-[var(--hover)] text-[12px] cursor-pointer"
                  onClick={() => setEditingTx(r)}
                >
                  <div className="w-7 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked} onChange={() => toggleSelect(r.id)} />
                  </div>
                  {visibleCols.includes("issuedAt") && (
                    <div className="w-[82px] shrink-0 tnum text-[var(--muted)]">{formatDateVi(r.issuedAt)}</div>
                  )}
                  {visibleCols.includes("invoiceNumber") && (
                    <div className="w-[78px] shrink-0 tnum font-mono text-[11.5px] text-[var(--text)]">
                      {r.invoiceNumber || "—"}
                    </div>
                  )}
                  {visibleCols.includes("merchant") && (
                    <div className="w-[155px] shrink-0 pr-2 min-w-0">
                      <div className="truncate font-medium text-[var(--text)]">{r.merchant || "—"}</div>
                      <div className="truncate text-[10.5px] text-[var(--dim)] tnum">{r.merchantTaxCode || ""}</div>
                    </div>
                  )}
                  {visibleCols.includes("name") && (
                    <div className="flex-1 min-w-[140px] pr-2 truncate text-[var(--text)]">{r.name || "—"}</div>
                  )}
                  {visibleCols.includes("categoryCode") && (
                    <div className="w-[118px] shrink-0">
                      <span className="tag">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: String(cat?.color ?? "#64748B") }} />
                        <span className="truncate max-w-[85px]">{String(cat?.name ?? r.categoryCode ?? "Khác")}</span>
                      </span>
                    </div>
                  )}
                  {visibleCols.includes("preTaxAmount") && (
                    <div className="w-[95px] text-right shrink-0 tnum text-[var(--muted)]">
                      {formatMoney(r.preTaxAmount, r.currencyCode)}
                    </div>
                  )}
                  {visibleCols.includes("vatAmount") && (
                    <div className="w-[80px] text-right shrink-0 tnum text-[var(--muted)]">
                      {formatMoney(r.vatAmount, r.currencyCode)}
                    </div>
                  )}
                  {visibleCols.includes("totalAmount") && (
                    <div
                      className={`w-[108px] text-right shrink-0 tnum font-semibold ${
                        r.direction === "output" ? "text-[var(--green)]" : "text-[var(--text)]"
                      }`}
                    >
                      {r.direction === "output" ? "+" : ""}
                      {formatMoney(r.totalAmount, r.currencyCode)}
                    </div>
                  )}
                  {visibleCols.includes("complianceStatus") && (
                    <div className="w-[84px] text-right shrink-0">
                      <span
                        className={`tag ${
                          r.complianceStatus === "valid"
                            ? "tag-ok"
                            : r.complianceStatus === "warning"
                              ? "tag-warn"
                              : "tag-err"
                        }`}
                      >
                        {r.complianceStatus === "valid" ? "Hợp lệ" : r.complianceStatus === "warning" ? "Cảnh báo" : "Lỗi"}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-3.5 content-start">
          {rows.slice(0, 200).map((r) => {
            const cat = catMap.get(r.categoryCode ?? "")
            return (
              <div
                key={r.id}
                onClick={() => setEditingTx(r)}
                className="rounded-[16px] border border-[var(--line)] bg-[var(--panel)] p-4 hover:border-[var(--line2)] cursor-pointer space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[13px] text-[var(--text)] truncate">{r.name || "—"}</div>
                    <div className="text-[11.5px] text-[var(--muted)] truncate">
                      {r.merchant || "—"} {r.merchantTaxCode ? `· MST ${r.merchantTaxCode}` : ""}
                    </div>
                  </div>
                  <span className={`font-bold text-[13.5px] tnum shrink-0 ${r.direction === "output" ? "text-[var(--green)]" : "text-[var(--text)]"}`}>
                    {formatMoney(r.totalAmount, r.currencyCode)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-[var(--dim)]">
                  <span className="tag">{String(cat?.name ?? r.categoryCode ?? "Khác")}</span>
                  <span className="tnum">{formatDateVi(r.issuedAt)} · HĐ {r.invoiceNumber || "—"}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Floating Batch Bar */}
      {selectedIds.size > 0 && (
        <div className="batch-bar">
          <span className="text-[12px] font-semibold text-[var(--text)] tnum pl-1">
            Đã chọn {selectedIds.size}
          </span>
          <select
            defaultValue=""
            onChange={(e) => e.target.value && handleBulkCategory(e.target.value)}
            className="h-7 px-2.5 rounded-full bg-[var(--raised)] border border-[var(--line)] text-[11.5px] outline-none"
          >
            <option value="" className="bg-[var(--panel-solid)]">Gán danh mục...</option>
            {categories.map((c) => (
              <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                {String(c.name)}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleBulkDelete} className="gb text-[var(--rose)]">
            <Trash2 size={12.5} />
            <span>Xóa</span>
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="w-7 h-7 rounded-full grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)]">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Edit Drawer */}
      {editingTx && (
        <div className="fixed inset-0 z-[100] flex justify-end bg-black/35" onClick={() => setEditingTx(null)}>
          <div
            className="glass-overlay w-full max-w-[440px] h-full p-5 overflow-y-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-[var(--text)]">Chi tiết Giao dịch</h3>
              <button type="button" onClick={() => setEditingTx(null)} className="w-8 h-8 rounded-full grid place-items-center hover:bg-[var(--hover)]">
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Nội dung</label>
                <input
                  value={editingTx.name ?? ""}
                  onChange={(e) => setEditingTx({ ...editingTx, name: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Đối tác</label>
                <input
                  value={editingTx.merchant ?? ""}
                  onChange={(e) => setEditingTx({ ...editingTx, merchant: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">MST</label>
                  <input
                    value={editingTx.merchantTaxCode ?? ""}
                    onChange={(e) => setEditingTx({ ...editingTx, merchantTaxCode: e.target.value })}
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Tổng tiền</label>
                  <input
                    type="number"
                    value={editingTx.totalAmount}
                    onChange={(e) => setEditingTx({ ...editingTx, totalAmount: Number(e.target.value) || 0 })}
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Danh mục</label>
                  <select
                    value={editingTx.categoryCode ?? "other"}
                    onChange={(e) => setEditingTx({ ...editingTx, categoryCode: e.target.value })}
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                  >
                    {categories.map((c) => (
                      <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                        {String(c.name)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Dự án</label>
                  <select
                    value={editingTx.projectCode ?? "general"}
                    onChange={(e) => setEditingTx({ ...editingTx, projectCode: e.target.value })}
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                  >
                    {projects.map((p) => (
                      <option key={String(p.code)} value={String(p.code)} className="bg-[var(--panel-solid)]">
                        {String(p.name)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Ghi chú</label>
                <textarea
                  rows={3}
                  value={editingTx.note ?? ""}
                  onChange={(e) => setEditingTx({ ...editingTx, note: e.target.value })}
                  className="w-full p-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditingTx(null)} className="gb">Hủy</button>
              <button type="button" onClick={handleSaveEdit} className="pb">Lưu thay đổi</button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Create Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-[110] grid place-items-center bg-black/45 p-4" onClick={() => setShowNewModal(false)}>
          <form
            onSubmit={handleCreateManual}
            onClick={(e) => e.stopPropagation()}
            className="glass-overlay w-full max-w-[460px] rounded-[16px] p-5 space-y-3.5"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold">Thêm giao dịch thủ công</h3>
              <button type="button" onClick={() => setShowNewModal(false)}><X size={15} /></button>
            </div>
            <input
              required
              placeholder="Nội dung chi tiêu / doanh thu"
              value={newForm.name}
              onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
              className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
            />
            <div className="grid grid-cols-2 gap-2.5">
              <input
                placeholder="Đối tác (NCC / KH)"
                value={newForm.merchant}
                onChange={(e) => setNewForm({ ...newForm, merchant: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
              />
              <input
                placeholder="Mã số thuế"
                value={newForm.merchantTaxCode}
                onChange={(e) => setNewForm({ ...newForm, merchantTaxCode: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
              />
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <input
                type="number"
                placeholder="Trước thuế"
                value={newForm.preTaxAmount}
                onChange={(e) => {
                  const p = Number(e.target.value) || 0
                  setNewForm({ ...newForm, preTaxAmount: p, totalAmount: p + newForm.vatAmount })
                }}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
              />
              <input
                type="number"
                placeholder="VAT"
                value={newForm.vatAmount}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0
                  setNewForm({ ...newForm, vatAmount: v, totalAmount: newForm.preTaxAmount + v })
                }}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
              />
              <input
                type="number"
                placeholder="Tổng"
                value={newForm.totalAmount}
                onChange={(e) => setNewForm({ ...newForm, totalAmount: Number(e.target.value) || 0 })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] font-semibold tnum"
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <select
                value={newForm.direction}
                onChange={(e) => setNewForm({ ...newForm, direction: e.target.value as TransactionDirection })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
              >
                <option value="input" className="bg-[var(--panel-solid)]">Mua vào (Chi)</option>
                <option value="output" className="bg-[var(--panel-solid)]">Bán ra (Thu)</option>
              </select>
              <input
                type="date"
                value={newForm.issuedAt}
                onChange={(e) => setNewForm({ ...newForm, issuedAt: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowNewModal(false)} className="gb">Hủy</button>
              <button type="submit" className="pb">Tạo giao dịch</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
