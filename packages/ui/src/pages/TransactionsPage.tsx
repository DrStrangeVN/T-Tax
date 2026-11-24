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
  Check,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  FileText,
  BookOpen,
  ListChecks,
  Calendar,
  ChevronDown
} from "lucide-react"
import type { TransactionDirection, UiPreferences, WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"
import { MoneyInput } from "../components/MoneyInput.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

interface TransactionsProps {
  workspace: WorkspaceDTO
  initialComplianceFilter?: string
  initialFocusTxId?: string | null
  onClearPreset?: () => void
  onRefreshCounts?: () => void
  onToast: (
    msg: string,
    tone?: "ok" | "warn" | "err",
    undo?: { label: string; onClick: () => void | Promise<void> }
  ) => void
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

interface TxDetailPayload {
  transaction: TxRow
  items: Array<Record<string, unknown>>
  complianceIssues: Array<{ code?: string; severity?: string; message?: string }>
  files: Array<{ id: string; filename: string; mimetype: string; pairedFileId?: string | null }>
  einvoice: Record<string, unknown> | null
  journalEntries: Array<{
    id: string
    voucherNumber?: string | null
    voucherDate?: string | null
    description?: string | null
    totalAmountVnd: number
    lines?: Array<{ debitAccount: string; creditAccount: string; amountVnd: number; description?: string | null }>
  }>
}

const UI_PREFS_KEY = "ttax:ui-prefs:v1"
const PAGE_SIZE = 500
const DEFAULT_COLS = [
  "issuedAt",
  "invoiceNumber",
  "merchant",
  "name",
  "categoryCode",
  "preTaxAmount",
  "vatAmount",
  "totalAmount",
  "complianceStatus"
]

function loadVisibleCols(): string[] {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as UiPreferences
      if (Array.isArray(parsed.visibleCols) && parsed.visibleCols.length > 0) {
        return parsed.visibleCols
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_COLS
}

function saveVisibleCols(cols: string[]) {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    const prev = raw ? (JSON.parse(raw) as UiPreferences) : {}
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...prev, visibleCols: cols }))
  } catch {
    // ignore
  }
}

function getDatePresetRange(preset: "all" | "month" | "quarter" | "year"): { from?: string; to?: string } {
  if (preset === "all") return {}
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  if (preset === "month") return { from: `${y}-${String(m + 1).padStart(2, "0")}-01` }
  if (preset === "quarter") {
    const qStart = Math.floor(m / 3) * 3 + 1
    return { from: `${y}-${String(qStart).padStart(2, "0")}-01` }
  }
  return { from: `${y}-01-01` }
}

const PRESET_LABELS: Record<"all" | "month" | "quarter" | "year" | "custom", string> = {
  all: "Mọi kỳ",
  month: "Tháng này",
  quarter: "Quý này",
  year: "Năm nay",
  custom: "Tùy chỉnh"
}

export function TransactionsPage({
  workspace,
  initialComplianceFilter,
  initialFocusTxId,
  onClearPreset,
  onRefreshCounts,
  onToast
}: TransactionsProps) {
  const transport = useTransport()
  const [rows, setRows] = useState<TxRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState({ preTaxSum: 0, vatSum: 0, totalSum: 0 })
  const [loadingMore, setLoadingMore] = useState(false)
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([])
  const [projects, setProjects] = useState<Array<Record<string, unknown>>>([])
  const [fields, setFields] = useState<Array<Record<string, unknown>>>([])
  const [currencies, setCurrencies] = useState<Array<Record<string, unknown>>>([])
  const [visibleCols, setVisibleCols] = useState<string[]>(() => loadVisibleCols())

  const [search, setSearch] = useState("")
  const [direction, setDirection] = useState<"all" | "input" | "output">("all")
  const [categoryCode, setCategoryCode] = useState("")
  const [complianceFilter, setComplianceFilter] = useState(initialComplianceFilter ?? "")
  const [datePreset, setDatePreset] = useState<"all" | "month" | "quarter" | "year" | "custom">("all")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [sortBy, setSortBy] = useState<"issuedAt" | "invoiceNumber" | "merchant" | "totalAmount">("issuedAt")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  const [viewMode, setViewMode] = useState<"list" | "grid">("list")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)

  const [editingTx, setEditingTx] = useState<TxRow | null>(null)
  const [isLg, setIsLg] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1024))
  const [editExtra, setEditExtra] = useState<Record<string, string>>({})
  const [drawerTab, setDrawerTab] = useState<"detail" | "source" | "items">("detail")
  const [txDetail, setTxDetail] = useState<TxDetailPayload | null>(null)
  const [docPreview, setDocPreview] = useState<{ xmlHtml?: string; base64?: string; mimetype?: string; filename?: string } | null>(
    null
  )

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

  const datePickerRef = useRef<HTMLDivElement | null>(null)
  const colPickerRef = useRef<HTMLDivElement | null>(null)
  const exportMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    setIsLg(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setIsLg(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    saveVisibleCols(visibleCols)
  }, [visibleCols])

  useEffect(() => {
    if (initialComplianceFilter) {
      setComplianceFilter(initialComplianceFilter)
      onClearPreset?.()
    }
  }, [initialComplianceFilter, onClearPreset])

  const effectiveRange = useMemo(() => {
    if (datePreset === "custom") {
      return { from: customFrom || undefined, to: customTo || undefined }
    }
    return getDatePresetRange(datePreset)
  }, [datePreset, customFrom, customTo])

  const loadData = useCallback(async () => {
    const [txRes, cats, projs, flds, curs] = await Promise.all([
      transport.listTransactions(workspace.id, {
        search: search || undefined,
        direction,
        categoryCode: categoryCode || undefined,
        complianceStatus: complianceFilter || undefined,
        dateFrom: effectiveRange.from,
        dateTo: effectiveRange.to,
        sortBy,
        sortDir,
        lightweight: true,
        limit: PAGE_SIZE,
        offset: 0
      }),
      transport.listCategories(workspace.id),
      transport.listProjects(workspace.id),
      transport.listFields(workspace.id),
      transport.listCurrencies(workspace.id)
    ])
    setRows(txRes.rows as unknown as TxRow[])
    setTotal(txRes.total)
    setSummary(txRes.summary ?? { preTaxSum: 0, vatSum: 0, totalSum: 0 })
    setCategories(cats)
    setProjects(projs)
    setFields(flds)
    setCurrencies(curs)
  }, [workspace.id, search, direction, categoryCode, complianceFilter, effectiveRange.from, effectiveRange.to, sortBy, sortDir, transport])

  const loadMoreRows = useCallback(async () => {
    if (loadingMore || rows.length >= total) return
    setLoadingMore(true)
    try {
      const txRes = await transport.listTransactions(workspace.id, {
        search: search || undefined,
        direction,
        categoryCode: categoryCode || undefined,
        complianceStatus: complianceFilter || undefined,
        dateFrom: effectiveRange.from,
        dateTo: effectiveRange.to,
        sortBy,
        sortDir,
        lightweight: true,
        limit: PAGE_SIZE,
        offset: rows.length
      })
      const extra = txRes.rows as unknown as TxRow[]
      if (extra.length > 0) {
        setRows((prev) => [...prev, ...extra])
      }
    } finally {
      setLoadingMore(false)
    }
  }, [
    loadingMore,
    rows.length,
    total,
    transport,
    workspace.id,
    search,
    direction,
    categoryCode,
    complianceFilter,
    effectiveRange.from,
    effectiveRange.to,
    sortBy,
    sortDir
  ])

  useEffect(() => {
    const t = setTimeout(() => {
      loadData().catch(() => {})
    }, 100)
    return () => clearTimeout(t)
  }, [loadData])

  const openDetail = useCallback(
    async (txId: string, fallbackRow?: TxRow) => {
      setDrawerTab("detail")
      setDocPreview(null)
      if (fallbackRow) {
        setEditingTx(fallbackRow)
        try {
          setEditExtra(fallbackRow.extraJson ? (JSON.parse(fallbackRow.extraJson) as Record<string, string>) : {})
        } catch {
          setEditExtra({})
        }
      }
      try {
        const detail = (await transport.getTransactionDetail(workspace.id, txId)) as unknown as TxDetailPayload
        setTxDetail(detail)
        setEditingTx(detail.transaction)
        try {
          setEditExtra(detail.transaction.extraJson ? (JSON.parse(detail.transaction.extraJson) as Record<string, string>) : {})
        } catch {
          setEditExtra({})
        }
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Không tải được chi tiết giao dịch", "warn")
      }
    },
    [transport, workspace.id, onToast]
  )

  useEffect(() => {
    if (initialFocusTxId) {
      openDetail(initialFocusTxId).catch(() => {})
      onClearPreset?.()
    }
  }, [initialFocusTxId, openDetail, onClearPreset])

  // Keyboard navigation across docked list & popover dismissal
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (showDatePicker && datePickerRef.current && !datePickerRef.current.contains(target)) {
        setShowDatePicker(false)
      }
      if (showColPicker && colPickerRef.current && !colPickerRef.current.contains(target)) {
        setShowColPicker(false)
      }
      if (showExportMenu && exportMenuRef.current && !exportMenuRef.current.contains(target)) {
        setShowExportMenu(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowDatePicker(false)
        setShowColPicker(false)
        setShowExportMenu(false)
        if (editingTx) {
          setEditingTx(null)
          setTxDetail(null)
        }
        if (showNewModal) setShowNewModal(false)
        return
      }
      if (!editingTx || showNewModal || rows.length === 0) return
      const tag = (document.activeElement?.tagName ?? "").toUpperCase()
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") {
        e.preventDefault()
        const idx = rows.findIndex((r) => r.id === editingTx.id)
        const next = rows[Math.min(rows.length - 1, idx + 1)]
        if (next && next.id !== editingTx.id) openDetail(next.id, next).catch(() => {})
      } else if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") {
        e.preventDefault()
        const idx = rows.findIndex((r) => r.id === editingTx.id)
        const prev = rows[Math.max(0, idx - 1)]
        if (prev && prev.id !== editingTx.id) openDetail(prev.id, prev).catch(() => {})
      }
    }
    window.addEventListener("mousedown", onMouseDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [showDatePicker, showColPicker, showExportMenu, editingTx, showNewModal, rows, openDetail])

  const loadAttachedFilePreview = async (file: { id: string; filename: string; mimetype: string }) => {
    try {
      const res = await transport.readFilePreview(workspace.id, file.id)
      if (file.filename.toLowerCase().endsWith(".xml")) {
        const html = await transport.renderXmlHtmlPreview(workspace.id, file.id)
        setDocPreview({ xmlHtml: html, mimetype: file.mimetype, filename: file.filename })
      } else {
        setDocPreview({ base64: res.base64, mimetype: file.mimetype, filename: file.filename })
      }
    } catch {
      onToast("Không mở được bản xem trước chứng từ gốc.", "warn")
    }
  }

  useEffect(() => {
    if (drawerTab === "source" && txDetail?.files?.[0] && !docPreview) {
      loadAttachedFilePreview(txDetail.files[0]).catch(() => {})
    }
  }, [drawerTab, txDetail, docPreview])

  const catMap = useMemo(() => new Map(categories.map((c) => [String(c.code), c])), [categories])
  const extraFieldsVisible = useMemo(
    () => fields.filter((f) => Boolean(f.isExtra) && visibleCols.includes(String(f.code))),
    [fields, visibleCols]
  )

  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 46,
    overscan: 14
  })

  const toggleSelect = (id: string) => {
    setConfirmBulkDelete(false)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(col)
      setSortDir(col === "issuedAt" || col === "totalAmount" ? "desc" : "asc")
    }
  }

  const SortIcon = ({ col }: { col: typeof sortBy }) => {
    if (sortBy !== col) return <ArrowUpDown size={11} className="opacity-45" />
    return sortDir === "asc" ? <ArrowUp size={11} className="text-[var(--cyan)]" /> : <ArrowDown size={11} className="text-[var(--cyan)]" />
  }

  const handleBulkCategory = async (code: string) => {
    try {
      await transport.bulkUpdateTransactions(workspace.id, [...selectedIds], { categoryCode: code })
      onToast(`Đã cập nhật danh mục & định khoản lại ${selectedIds.size} giao dịch.`, "ok")
      setSelectedIds(new Set())
      loadData()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi cập nhật hàng loạt", "err")
    }
  }

  const handleBulkDelete = async () => {
    if (!confirmBulkDelete) {
      setConfirmBulkDelete(true)
      return
    }
    try {
      await transport.deleteTransactions(workspace.id, [...selectedIds], { restoreFilesToInbox: true })
      onToast(`Đã xóa ${selectedIds.size} giao dịch & trả tệp gốc về Hộp thư AI (nếu có).`, "ok")
      if (editingTx && selectedIds.has(editingTx.id)) {
        setEditingTx(null)
        setTxDetail(null)
      }
      setSelectedIds(new Set())
      setConfirmBulkDelete(false)
      onRefreshCounts?.()
      loadData()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xóa giao dịch", "err")
    }
  }

  const handleExport = async (kind: "htkk_in" | "htkk_out" | "misa_in" | "misa_out" | "fast_bravo" | "csv" | "zip") => {
    setShowExportMenu(false)
    try {
      const res = await transport.exportReport(workspace.id, kind, {
        search: search || undefined,
        direction,
        categoryCode: categoryCode || undefined,
        dateFrom: effectiveRange.from,
        dateTo: effectiveRange.to
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
    try {
      await transport.createTransaction(workspace.id, newForm)
      setShowNewModal(false)
      onToast("Đã tạo giao dịch mới & hạch toán tự động.", "ok")
      onRefreshCounts?.()
      loadData()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Không thể tạo giao dịch", "err")
    }
  }

  const handleSaveEdit = async () => {
    if (!editingTx) return
    try {
      await transport.updateTransaction(
        workspace.id,
        editingTx.id,
        {
          name: editingTx.name,
          merchant: editingTx.merchant,
          merchantTaxCode: editingTx.merchantTaxCode,
          preTaxAmount: editingTx.preTaxAmount,
          vatAmount: editingTx.vatAmount,
          totalAmount: editingTx.totalAmount,
          categoryCode: editingTx.categoryCode,
          projectCode: editingTx.projectCode,
          paymentMethod: editingTx.paymentMethod,
          note: editingTx.note,
          extraJson: Object.keys(editExtra).length > 0 ? JSON.stringify(editExtra) : null
        },
        true
      )
      onRefreshCounts?.()
      onToast("Đã lưu thay đổi & định khoản lại sổ Nhật ký.", "ok")
      await loadData()
      await openDetail(editingTx.id)
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Không thể lưu thay đổi", "err")
    }
  }

  const minTableWidth = 900 + extraFieldsVisible.length * 120

  const inspectorBody = editingTx && (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3.5 border-b border-[var(--line)] space-y-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-[var(--text)] truncate">{editingTx.name || "Chi tiết Giao dịch"}</h3>
            <div className="text-[11px] text-[var(--muted)] tnum truncate">
              {editingTx.merchant || "—"} {editingTx.invoiceNumber ? `· HĐ ${editingTx.invoiceNumber}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingTx(null)
              setTxDetail(null)
            }}
            className="w-7 h-7 rounded-full grid place-items-center hover:bg-[var(--hover)] shrink-0"
            title="Đóng (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div className="seg w-full">
          <button
            type="button"
            className={`flex-1 justify-center whitespace-nowrap text-[11px] px-1.5 ${drawerTab === "detail" ? "on" : ""}`}
            onClick={() => setDrawerTab("detail")}
          >
            <BookOpen size={12} className="shrink-0" />
            <span>Định khoản</span>
          </button>
          <button
            type="button"
            className={`flex-1 justify-center whitespace-nowrap text-[11px] px-1.5 ${drawerTab === "source" ? "on" : ""}`}
            onClick={() => setDrawerTab("source")}
          >
            <FileText size={12} className="shrink-0" />
            <span>Chứng từ ({txDetail?.files.length ?? 0})</span>
          </button>
          <button
            type="button"
            className={`flex-1 justify-center whitespace-nowrap text-[11px] px-1.5 ${drawerTab === "items" ? "on" : ""}`}
            onClick={() => setDrawerTab("items")}
          >
            <ListChecks size={12} className="shrink-0" />
            <span>Mặt hàng & Cảnh báo</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5">
        {drawerTab === "detail" && (
          <>
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Nội dung</label>
                <input
                  value={editingTx.name ?? ""}
                  onChange={(e) => setEditingTx({ ...editingTx, name: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Đối tác</label>
                  <input
                    value={editingTx.merchant ?? ""}
                    onChange={(e) => setEditingTx({ ...editingTx, merchant: e.target.value })}
                    className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">MST</label>
                  <input
                    value={editingTx.merchantTaxCode ?? ""}
                    onChange={(e) => setEditingTx({ ...editingTx, merchantTaxCode: e.target.value })}
                    className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Trước thuế</label>
                  <MoneyInput
                    value={editingTx.preTaxAmount}
                    onChange={(pre) =>
                      setEditingTx({ ...editingTx, preTaxAmount: pre, totalAmount: pre + editingTx.vatAmount })
                    }
                    className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Thuế GTGT</label>
                  <MoneyInput
                    value={editingTx.vatAmount}
                    onChange={(vat) =>
                      setEditingTx({ ...editingTx, vatAmount: vat, totalAmount: editingTx.preTaxAmount + vat })
                    }
                    className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Tổng tiền</label>
                  <MoneyInput
                    value={editingTx.totalAmount}
                    onChange={(val) => setEditingTx({ ...editingTx, totalAmount: val })}
                    className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] font-semibold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Danh mục</label>
                  <select
                    value={editingTx.categoryCode ?? "other"}
                    onChange={(e) => setEditingTx({ ...editingTx, categoryCode: e.target.value })}
                    className="w-full h-9 px-2 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
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
                    className="w-full h-9 px-2 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                  >
                    {projects.map((p) => (
                      <option key={String(p.code)} value={String(p.code)} className="bg-[var(--panel-solid)]">
                        {String(p.name)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Thanh toán</label>
                  <select
                    value={editingTx.paymentMethod ?? "Chuyển khoản"}
                    onChange={(e) => setEditingTx({ ...editingTx, paymentMethod: e.target.value })}
                    className="w-full h-9 px-2 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                  >
                    {["Chuyển khoản", "Tiền mặt", "Công nợ", "Thẻ / Ví điện tử"].map((pm) => (
                      <option key={pm} value={pm} className="bg-[var(--panel-solid)]">
                        {pm}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {fields
                .filter((f) => Boolean(f.isExtra))
                .map((ef) => (
                  <div key={String(ef.code)}>
                    <label className="block text-[11px] text-[var(--muted)] mb-1">{String(ef.name)}</label>
                    <input
                      value={editExtra[String(ef.code)] ?? ""}
                      onChange={(e) => setEditExtra({ ...editExtra, [String(ef.code)]: e.target.value })}
                      className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                    />
                  </div>
                ))}

              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Ghi chú</label>
                <textarea
                  rows={2}
                  value={editingTx.note ?? ""}
                  onChange={(e) => setEditingTx({ ...editingTx, note: e.target.value })}
                  className="w-full p-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                />
              </div>
            </div>

            <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 space-y-2">
              <div className="text-[11.5px] font-semibold text-[var(--text)]">Bút toán Sổ Nhật ký hiện tại</div>
              {!txDetail || txDetail.journalEntries.length === 0 ? (
                <div className="text-[11.5px] text-[var(--dim)]">Chưa có bút toán hoặc đang tải...</div>
              ) : (
                txDetail.journalEntries.map((je) => (
                  <div key={je.id} className="space-y-1 text-[11.5px] border-t border-[var(--line)] pt-2 first:border-t-0 first:pt-0">
                    <div className="flex items-center justify-between text-[var(--muted)] tnum">
                      <span>{je.voucherNumber || "CT-AUTO"} · {formatDateVi(je.voucherDate)}</span>
                      <span>{formatMoney(je.totalAmountVnd, workspace.baseCurrency)}</span>
                    </div>
                    {(je.lines ?? []).map((ln, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          <span className="font-semibold text-[var(--cyan)]">Nợ {ln.debitAccount}</span> /{" "}
                          <span className="font-semibold text-[var(--amber)]">Có {ln.creditAccount}</span>
                        </span>
                        <span className="tnum shrink-0">{formatMoney(ln.amountVnd, workspace.baseCurrency)}</span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {drawerTab === "source" && (
          <div className="space-y-3 h-full flex flex-col">
            {!txDetail || txDetail.files.length === 0 ? (
              <div className="py-12 text-center text-[12px] text-[var(--dim)] rounded-[12px] border border-[var(--line)] bg-[var(--panel)]">
                Giao dịch nhập thủ công hoặc tách dòng — không có tệp chứng từ gốc đính kèm trực tiếp.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {txDetail.files.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => loadAttachedFilePreview(f)}
                      className={`gb ${docPreview?.filename === f.filename ? "hl" : ""}`}
                    >
                      {f.filename}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-[360px] rounded-[12px] border border-[var(--line)] bg-[var(--outer-rail)] overflow-hidden p-2">
                  {docPreview?.xmlHtml ? (
                    <iframe title="Source XML" srcDoc={docPreview.xmlHtml} className="w-full h-full min-h-[340px] bg-white rounded-[8px]" />
                  ) : docPreview?.base64 ? (
                    docPreview.mimetype === "application/pdf" ? (
                      <embed src={docPreview.base64} type="application/pdf" className="w-full h-full min-h-[340px] rounded-[8px]" />
                    ) : (
                      <img src={docPreview.base64} alt={docPreview.filename} className="max-w-full mx-auto rounded-[8px]" />
                    )
                  ) : (
                    <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">Đang tải chứng từ...</div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {drawerTab === "items" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-[12px] font-semibold text-[var(--text)]">Kiểm tra tuân thủ & Hạch toán</div>
              {!txDetail || txDetail.complianceIssues.length === 0 ? (
                <div className="px-3 py-2 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] text-[11.5px] text-[var(--green)]">
                  Không ghi nhận cảnh báo kiểm tra hóa đơn nào.
                </div>
              ) : (
                txDetail.complianceIssues.map((iss, idx) => (
                  <div
                    key={idx}
                    className={`px-3 py-2 rounded-[10px] border text-[11.5px] flex items-start gap-2 ${
                      iss.severity === "error"
                        ? "bg-[var(--rose-s)] border-[var(--rose)]/30 text-[var(--rose)]"
                        : "bg-[var(--amber-s)] border-[var(--amber)]/30 text-[var(--amber)]"
                    }`}
                  >
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>{iss.message}</span>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-2">
              <div className="text-[12px] font-semibold text-[var(--text)] tnum">
                Chi tiết dòng hàng ({txDetail?.items.length ?? 0})
              </div>
              {!txDetail || txDetail.items.length === 0 ? (
                <div className="py-6 text-center text-[11.5px] text-[var(--dim)] rounded-[12px] border border-[var(--line)] bg-[var(--panel)]">
                  Không có chi tiết dòng hàng riêng.
                </div>
              ) : (
                <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] divide-y divide-[var(--line)]">
                  {txDetail.items.map((it, idx) => (
                    <div key={idx} className="p-2.5 flex items-center justify-between gap-2 text-[11.5px]">
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--text)] truncate">{String(it.name ?? "Mặt hàng")}</div>
                        <div className="text-[10.5px] text-[var(--muted)] tnum">
                          SL {String(it.quantity ?? 1)} · ĐG {formatMoney(Number(it.unitPrice ?? 0), editingTx.currencyCode)} · VAT{" "}
                          {String(it.vatRate ?? "—")}
                        </div>
                      </div>
                      <span className="tnum font-semibold text-[var(--text)] shrink-0">
                        {formatMoney(Number(it.amount ?? 0), editingTx.currencyCode)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="p-3.5 border-t border-[var(--line)] flex items-center justify-between gap-2 shrink-0 bg-[var(--sheet-bg)]">
        <span className="text-[10.5px] text-[var(--dim)] hidden xl:inline">↑/↓ đổi dòng · Esc đóng</span>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={() => {
              setEditingTx(null)
              setTxDetail(null)
            }}
            className="gb"
          >
            Đóng
          </button>
          <button type="button" onClick={handleSaveEdit} className="pb">
            Lưu & Định khoản lại
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col relative">
      {/* Compact Single-Row Toolbar */}
      <div className="px-4 py-2.5 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2 bg-[var(--sheet-bg)] shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm MST, NCC, số HĐ..."
              className="h-[30px] w-[180px] xl:w-[215px] pl-8 pr-2.5 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none focus:border-[var(--cyan)]"
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

          {/* Period Preset Popover */}
          <div className="relative" ref={datePickerRef}>
            <button
              type="button"
              onClick={() => setShowDatePicker((v) => !v)}
              className={`gb ${datePreset !== "all" ? "hl" : ""}`}
            >
              <Calendar size={12.5} />
              <span>Kỳ: {PRESET_LABELS[datePreset]}</span>
              <ChevronDown size={11.5} />
            </button>
            {showDatePicker && (
              <div className="menu absolute left-0 top-9 w-[240px] p-2 space-y-1.5 z-40">
                {(["all", "month", "quarter", "year", "custom"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setDatePreset(p)
                      if (p !== "custom") setShowDatePicker(false)
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded-[8px] text-[12px] flex items-center justify-between hover:bg-[var(--sel)] ${
                      datePreset === p ? "bg-[var(--cyan-s)] text-[var(--cyan)] font-semibold" : ""
                    }`}
                  >
                    <span>{PRESET_LABELS[p]}</span>
                    {datePreset === p && <Check size={12.5} />}
                  </button>
                ))}
                {datePreset === "custom" && (
                  <div className="pt-1.5 border-t border-[var(--line)] space-y-1.5">
                    <input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="w-full h-7 px-2 rounded-[7px] border border-[var(--line)] bg-[var(--raised)] text-[11.5px] tnum"
                    />
                    <input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="w-full h-7 px-2 rounded-[7px] border border-[var(--line)] bg-[var(--raised)] text-[11.5px] tnum"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <select
            value={categoryCode}
            onChange={(e) => setCategoryCode(e.target.value)}
            className="h-[30px] px-2.5 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none max-w-[135px]"
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
            className="h-[30px] px-2.5 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none max-w-[130px]"
          >
            <option value="" className="bg-[var(--panel-solid)]">Mọi trạng thái</option>
            <option value="valid" className="bg-[var(--panel-solid)]">Hợp lệ</option>
            <option value="warning" className="bg-[var(--panel-solid)]">Cảnh báo</option>
            <option value="error" className="bg-[var(--panel-solid)]">Lỗi</option>
            <option value="warning_or_error" className="bg-[var(--panel-solid)]">Cảnh báo / Lỗi</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="seg">
            <button type="button" className={viewMode === "list" ? "on" : ""} onClick={() => setViewMode("list")}>
              <LayoutList size={13} />
            </button>
            <button type="button" className={viewMode === "grid" ? "on" : ""} onClick={() => setViewMode("grid")}>
              <LayoutGrid size={13} />
            </button>
          </div>

          <div className="relative" ref={colPickerRef}>
            <button type="button" onClick={() => setShowColPicker(!showColPicker)} className="gb">
              <SlidersHorizontal size={13} />
              <span>Cột</span>
            </button>
            {showColPicker && (
              <div className="menu absolute right-0 top-9 w-[235px] max-h-[300px] overflow-y-auto p-2 space-y-1 z-30">
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

          <div className="relative" ref={exportMenuRef}>
            <button type="button" onClick={() => setShowExportMenu(!showExportMenu)} className="gb">
              <Download size={13} />
              <span className="hidden xl:inline">Xuất Excel / ZIP</span>
            </button>
            {showExportMenu && (
              <div className="menu absolute right-0 mt-1.5 w-[240px] z-30">
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
        </div>
      </div>

      {/* Main Split Body: Table/Grid + Docked Right Inspector */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {viewMode === "list" ? (
            <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
              <div style={{ minWidth: `${minTableWidth}px` }}>
                <div className="sticky top-0 z-10 flex items-center px-3.5 h-9 bg-[var(--raised)] border-b border-[var(--line)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  <div className="w-7 shrink-0">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selectedIds.size === rows.length}
                      onChange={(e) => {
                        setConfirmBulkDelete(false)
                        setSelectedIds(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }}
                    />
                  </div>
                  {visibleCols.includes("issuedAt") && (
                    <button
                      type="button"
                      onClick={() => toggleSort("issuedAt")}
                      className="w-[86px] shrink-0 flex items-center gap-1 hover:text-[var(--text)]"
                    >
                      <span>Ngày</span>
                      <SortIcon col="issuedAt" />
                    </button>
                  )}
                  {visibleCols.includes("invoiceNumber") && (
                    <button
                      type="button"
                      onClick={() => toggleSort("invoiceNumber")}
                      className="w-[80px] shrink-0 flex items-center gap-1 hover:text-[var(--text)]"
                    >
                      <span>Số HĐ</span>
                      <SortIcon col="invoiceNumber" />
                    </button>
                  )}
                  {visibleCols.includes("merchant") && (
                    <button
                      type="button"
                      onClick={() => toggleSort("merchant")}
                      className="w-[155px] shrink-0 flex items-center gap-1 hover:text-[var(--text)]"
                    >
                      <span>Đối tác / MST</span>
                      <SortIcon col="merchant" />
                    </button>
                  )}
                  {visibleCols.includes("name") && <div className="flex-1 min-w-[140px]">Nội dung</div>}
                  {visibleCols.includes("categoryCode") && <div className="w-[118px] shrink-0">Danh mục</div>}
                  {extraFieldsVisible.map((ef) => (
                    <div key={String(ef.code)} className="w-[115px] shrink-0 truncate pr-2">
                      {String(ef.name)}
                    </div>
                  ))}
                  {visibleCols.includes("preTaxAmount") && <div className="w-[95px] text-right shrink-0">Trước thuế</div>}
                  {visibleCols.includes("vatAmount") && <div className="w-[80px] text-right shrink-0">VAT</div>}
                  {visibleCols.includes("totalAmount") && (
                    <button
                      type="button"
                      onClick={() => toggleSort("totalAmount")}
                      className="w-[110px] shrink-0 flex items-center justify-end gap-1 hover:text-[var(--text)]"
                    >
                      <SortIcon col="totalAmount" />
                      <span>Tổng cộng</span>
                    </button>
                  )}
                  {visibleCols.includes("complianceStatus") && (
                    <div className="w-[92px] pr-1 text-right shrink-0">Tuân thủ</div>
                  )}
                </div>

                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                  {rowVirtualizer.getVirtualItems().map((vr) => {
                    const r = rows[vr.index]!
                    const cat = catMap.get(r.categoryCode ?? "")
                    const checked = selectedIds.has(r.id)
                    const active = editingTx?.id === r.id
                    let extraParsed: Record<string, string> = {}
                    if (extraFieldsVisible.length > 0 && r.extraJson) {
                      try {
                        extraParsed = JSON.parse(r.extraJson) as Record<string, string>
                      } catch {
                        extraParsed = {}
                      }
                    }
                    return (
                      <div
                        key={r.id}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${vr.size}px`,
                          transform: `translateY(${vr.start}px)`
                        }}
                        className={`flex items-center px-3.5 border-b border-[var(--line)] text-[12px] cursor-pointer ${
                          active ? "bg-[var(--cyan-s)]" : "hover:bg-[var(--hover)]"
                        }`}
                        onClick={() => openDetail(r.id, r)}
                      >
                        <div className="w-7 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={checked} onChange={() => toggleSelect(r.id)} />
                        </div>
                        {visibleCols.includes("issuedAt") && (
                          <div className="w-[86px] shrink-0 tnum text-[var(--muted)]">{formatDateVi(r.issuedAt)}</div>
                        )}
                        {visibleCols.includes("invoiceNumber") && (
                          <div className="w-[80px] shrink-0 tnum font-mono text-[11.5px] text-[var(--text)]">
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
                        {extraFieldsVisible.map((ef) => (
                          <div key={String(ef.code)} className="w-[115px] shrink-0 truncate pr-2 text-[11.5px] text-[var(--muted)]">
                            {extraParsed[String(ef.code)] || "—"}
                          </div>
                        ))}
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
                            className={`w-[110px] text-right shrink-0 tnum font-semibold ${
                              r.direction === "output" ? "text-[var(--green)]" : "text-[var(--text)]"
                            }`}
                          >
                            {r.direction === "output" ? "+" : ""}
                            {formatMoney(r.totalAmount, r.currencyCode)}
                          </div>
                        )}
                        {visibleCols.includes("complianceStatus") && (
                          <div className="w-[92px] pr-1 text-right shrink-0">
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

                {rows.length < total && (
                  <div className="p-3 text-center border-t border-[var(--line)]">
                    <button type="button" disabled={loadingMore} onClick={loadMoreRows} className="gb">
                      <span>{loadingMore ? "Đang tải thêm..." : `Nạp thêm (${rows.length}/${total})`}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {rows.length > 200 && (
                <div className="px-3.5 py-2 rounded-[10px] border border-[var(--line2)] bg-[var(--amber-s)] text-[var(--amber)] text-[11.5px]">
                  Đang hiển thị 200 / {total} giao dịch ở chế độ Lưới. Chuyển sang Danh sách để xem toàn bộ.
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 content-start">
                {rows.slice(0, 200).map((r) => {
                  const cat = catMap.get(r.categoryCode ?? "")
                  const active = editingTx?.id === r.id
                  return (
                    <div
                      key={r.id}
                      onClick={() => openDetail(r.id, r)}
                      className={`rounded-[16px] border p-4 cursor-pointer space-y-2 ${
                        active ? "border-[var(--cyan)] bg-[var(--cyan-s)]" : "border-[var(--line)] bg-[var(--panel)] hover:border-[var(--line2)]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-[13px] text-[var(--text)] truncate">{r.name || "—"}</div>
                          <div className="text-[11.5px] text-[var(--muted)] truncate">
                            {r.merchant || "—"} {r.merchantTaxCode ? `· MST ${r.merchantTaxCode}` : ""}
                          </div>
                        </div>
                        <span
                          className={`font-bold text-[13.5px] tnum shrink-0 ${
                            r.direction === "output" ? "text-[var(--green)]" : "text-[var(--text)]"
                          }`}
                        >
                          {formatMoney(r.totalAmount, r.currencyCode)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-[var(--dim)]">
                        <span className="tag">{String(cat?.name ?? r.categoryCode ?? "Khác")}</span>
                        <span className="tnum">
                          {formatDateVi(r.issuedAt)} · HĐ {r.invoiceNumber || "—"}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* SQL Sticky Totals Footer */}
          <div className="px-4 py-2 border-t border-[var(--line)] bg-[var(--sheet-bg)] flex flex-wrap items-center justify-between gap-3 text-[11.5px] shrink-0">
            <span className="text-[var(--muted)] tnum">
              Tổng bộ lọc: <strong className="text-[var(--text)]">{total}</strong> giao dịch
              {total > rows.length ? ` (đang hiển thị ${rows.length})` : ""}
            </span>
            <div className="flex items-center gap-4 tnum">
              <span className="text-[var(--muted)]">
                Trước thuế: <strong className="text-[var(--text)]">{formatMoney(summary.preTaxSum, workspace.baseCurrency)}</strong>
              </span>
              <span className="text-[var(--muted)]">
                VAT: <strong className="text-[var(--text)]">{formatMoney(summary.vatSum, workspace.baseCurrency)}</strong>
              </span>
              <span className="text-[var(--muted)]">
                Tổng cộng: <strong className="text-[var(--cyan)]">{formatMoney(summary.totalSum, workspace.baseCurrency)}</strong>
              </span>
            </div>
          </div>
        </div>

        {/* Desktop Docked Split-Pane Inspector (no full-screen backdrop!) */}
        {editingTx && isLg && (
          <aside className="flex w-[420px] xl:w-[460px] shrink-0 border-l border-[var(--line)] bg-[var(--sheet-bg)] flex-col min-h-0">
            {inspectorBody}
          </aside>
        )}
      </div>

      {/* Narrow Screen Fallback Sheet */}
      {editingTx && !isLg && (
        <div
          className="fixed inset-0 z-[100] flex justify-end bg-black/35"
          onClick={() => {
            setEditingTx(null)
            setTxDetail(null)
          }}
        >
          <div className="glass-overlay w-full max-w-[480px] h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
            {inspectorBody}
          </div>
        </div>
      )}

      {/* Floating Batch Bar */}
      {selectedIds.size > 0 && (
        <div className="batch-bar">
          <span className="text-[12px] font-semibold text-[var(--text)] tnum pl-1">Đã chọn {selectedIds.size}</span>
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
            <span>{confirmBulkDelete ? `Xác nhận xóa ${selectedIds.size}?` : "Xóa"}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedIds(new Set())
              setConfirmBulkDelete(false)
            }}
            className="w-7 h-7 rounded-full grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Manual Create Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-[110] grid place-items-center bg-black/45 p-4" onClick={() => setShowNewModal(false)}>
          <form
            onSubmit={handleCreateManual}
            onClick={(e) => e.stopPropagation()}
            className="glass-overlay w-full max-w-[480px] rounded-[16px] p-5 space-y-3.5"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold">Thêm giao dịch thủ công</h3>
              <button type="button" onClick={() => setShowNewModal(false)}>
                <X size={15} />
              </button>
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
              <div>
                <label className="block text-[10.5px] text-[var(--muted)] mb-1">Trước thuế</label>
                <MoneyInput
                  value={newForm.preTaxAmount}
                  onChange={(p) => setNewForm({ ...newForm, preTaxAmount: p, totalAmount: p + newForm.vatAmount })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div>
                <label className="block text-[10.5px] text-[var(--muted)] mb-1">VAT</label>
                <MoneyInput
                  value={newForm.vatAmount}
                  onChange={(v) => setNewForm({ ...newForm, vatAmount: v, totalAmount: newForm.preTaxAmount + v })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div>
                <label className="block text-[10.5px] text-[var(--muted)] mb-1">Tổng</label>
                <MoneyInput
                  value={newForm.totalAmount}
                  onChange={(val) => setNewForm({ ...newForm, totalAmount: val })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] font-semibold"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <select
                value={newForm.direction}
                onChange={(e) => setNewForm({ ...newForm, direction: e.target.value as TransactionDirection })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              >
                <option value="input" className="bg-[var(--panel-solid)]">Mua vào (Chi)</option>
                <option value="output" className="bg-[var(--panel-solid)]">Bán ra (Thu)</option>
              </select>
              <select
                value={newForm.currencyCode}
                onChange={(e) => setNewForm({ ...newForm, currencyCode: e.target.value })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              >
                {currencies.map((c) => (
                  <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                    {String(c.code)}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={newForm.issuedAt}
                onChange={(e) => setNewForm({ ...newForm, issuedAt: e.target.value })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowNewModal(false)} className="gb">
                Hủy
              </button>
              <button type="submit" className="pb">
                Tạo giao dịch
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
