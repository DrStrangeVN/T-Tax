import React, { useEffect, useState, useCallback, useMemo, useRef } from "react"
import {
  Sparkles,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Split,
  Trash2,
  RefreshCw,
  FileCode2,
  Eye,
  PanelLeftClose,
  PanelLeftOpen,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Square,
  CheckSquare,
  X,
  ArrowLeftRight,
  Maximize2
} from "lucide-react"
import type {
  BatchAnalyzeProgressEvent,
  DocumentAnalysisOutcome,
  LineItemDTO,
  TransactionDirection,
  UiPreferences,
  WorkspaceDTO
} from "@t-tax/core"
import { suggestJournalLines, verifyJournalBalance } from "@t-tax/core/browser"
import { useTransport, smartIngestFileList } from "../transport/client.js"
import { MoneyInput } from "../components/MoneyInput.js"
import { formatMoney } from "../utils/format.js"

interface UnsortedProps {
  workspace: WorkspaceDTO
  onRefreshCounts: () => void
  onToast: (
    msg: string,
    tone?: "ok" | "warn" | "err",
    undo?: { label: string; onClick: () => void | Promise<void> }
  ) => void
}

interface UnsortedFileRow {
  id: string
  filename: string
  mimetype: string
  sizeBytes: number
  extractionMethod: string
  extractionConfidence?: number | null
  cachedParseResultJson?: string | null
  pairedFileId?: string | null
  createdAt: string
}

const UI_PREFS_KEY = "ttax:ui-prefs:v1"

function readSplitPct(): number {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as UiPreferences
      if (typeof parsed.unsortedSplitPct === "number" && parsed.unsortedSplitPct >= 34 && parsed.unsortedSplitPct <= 68) {
        return parsed.unsortedSplitPct
      }
    }
  } catch {
    // ignore
  }
  return 54
}

function saveSplitPct(pct: number) {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    const prev = raw ? (JSON.parse(raw) as UiPreferences) : {}
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...prev, unsortedSplitPct: pct }))
  } catch {
    // ignore
  }
}

export function UnsortedPage({ workspace, onRefreshCounts, onToast }: UnsortedProps) {
  const transport = useTransport()
  const [files, setFiles] = useState<UnsortedFileRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  const [queueFilter, setQueueFilter] = useState<"all" | "pending" | "analyzed" | "clean_xml">("all")
  const [queueSearch, setQueueSearch] = useState("")
  const [queueCollapsed, setQueueCollapsed] = useState(false)
  const [mobileTab, setMobileTab] = useState<"queue" | "preview" | "form">("form")
  const [isLg, setIsLg] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1024))
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())

  const [previewMode, setPreviewMode] = useState<"primary" | "paired_pdf">("primary")
  const [previewData, setPreviewData] = useState<{ base64?: string; xmlHtml?: string; pairedBase64?: string }>({})
  const [fitWidth, setFitWidth] = useState(true)
  const [zoomPct, setZoomPct] = useState(100)
  const [rotateDeg, setRotateDeg] = useState(0)
  const [viewerWidth, setViewerWidth] = useState(560)
  const viewerSurfaceRef = useRef<HTMLDivElement | null>(null)

  const [splitPct, setSplitPct] = useState<number>(() => readSplitPct())
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  const [analysis, setAnalysis] = useState<DocumentAnalysisOutcome | null>(null)
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([])
  const [projects, setProjects] = useState<Array<Record<string, unknown>>>([])
  const [extraFields, setExtraFields] = useState<Array<Record<string, unknown>>>([])
  const [currencies, setCurrencies] = useState<Array<Record<string, unknown>>>([])
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BatchAnalyzeProgressEvent | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [fxEstimate, setFxEstimate] = useState<{ rate: number; source: string; converted: number } | null>(null)

  const [form, setForm] = useState({
    name: "",
    merchant: "",
    merchantTaxCode: "",
    direction: "input" as TransactionDirection,
    invoiceSymbol: "",
    invoiceNumber: "",
    issuedAt: new Date().toISOString().slice(0, 10),
    currencyCode: workspace.baseCurrency || "VND",
    preTaxAmount: 0,
    vatRateCode: "10%",
    vatAmount: 0,
    totalAmount: 0,
    categoryCode: "other",
    projectCode: "general",
    paymentMethod: "Chuyển khoản",
    note: "",
    extra: {} as Record<string, string>
  })

  useEffect(() => {
    const el = viewerSurfaceRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 120) setViewerWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [files.length, queueCollapsed, splitPct, mobileTab])

  const loadInbox = useCallback(
    async (preferredId?: string | null) => {
      const [fList, cats, projs, flds, curs] = await Promise.all([
        transport.listFiles(workspace.id, true),
        transport.listCategories(workspace.id),
        transport.listProjects(workspace.id),
        transport.listFields(workspace.id),
        transport.listCurrencies(workspace.id)
      ])
      const typed = fList as unknown as UnsortedFileRow[]
      setFiles(typed)
      setCategories(cats)
      setProjects(projs)
      setExtraFields(flds.filter((f) => Boolean(f.isExtra)))
      setCurrencies(curs)

      const cur = preferredId ?? selectedIdRef.current
      if (typed.length > 0 && (!cur || !typed.some((x) => x.id === cur))) {
        setSelectedId(typed[0]!.id)
      } else if (preferredId && typed.some((x) => x.id === preferredId)) {
        setSelectedId(preferredId)
      } else if (typed.length === 0) {
        setSelectedId(null)
        setAnalysis(null)
      }
    },
    [workspace.id, transport]
  )

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    setIsLg(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setIsLg(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    loadInbox().catch(() => {})
  }, [loadInbox])

  useEffect(() => {
    const off = transport.onBatchAnalyzeProgress?.((ev) => {
      setBatchProgress(ev)
    })
    return () => {
      off?.()
    }
  }, [transport])

  const applyOutcomeToForm = useCallback(
    (outcome: DocumentAnalysisOutcome, filename: string) => {
      const f = outcome.extractedFields
      setForm({
        name: String(f.name ?? filename),
        merchant: String(f.merchant ?? ""),
        merchantTaxCode: String(f.merchantTaxCode ?? f.sellerTaxCode ?? ""),
        direction: (f.direction as TransactionDirection) || "input",
        invoiceSymbol: String(f.invoiceSymbol ?? ""),
        invoiceNumber: String(f.invoiceNumber ?? ""),
        issuedAt: String(f.issuedAt ?? new Date().toISOString().slice(0, 10)),
        currencyCode: String(f.currencyCode ?? workspace.baseCurrency ?? "VND"),
        preTaxAmount: Number(f.preTaxAmount ?? 0) || 0,
        vatRateCode: String(f.vatRateCode ?? outcome.parsedEInvoice?.vatBreakdown?.[0]?.vatRate ?? "10%"),
        vatAmount: Number(f.vatAmount ?? 0) || 0,
        totalAmount: Number(f.total ?? 0) || 0,
        categoryCode: String(f.categoryCode ?? "other"),
        projectCode: String(f.projectCode ?? "general"),
        paymentMethod: String(f.paymentMethod ?? "Chuyển khoản"),
        note: "",
        extra: {}
      })
      setFxEstimate(null)
    },
    [workspace.baseCurrency]
  )

  useEffect(() => {
    if (!selectedId) return
    const file = files.find((f) => f.id === selectedId)
    if (!file) return

    let active = true
    setPreviewMode("primary")
    setConfirmDeleteId(null)
    setFitWidth(true)
    setZoomPct(100)
    setRotateDeg(0)
    setPreviewData({})

    transport
      .readFilePreview(workspace.id, selectedId)
      .then(async (res) => {
        if (!active) return
        if (file.filename.toLowerCase().endsWith(".xml")) {
          const html = await transport.renderXmlHtmlPreview(workspace.id, selectedId)
          if (active) setPreviewData({ xmlHtml: html })
        } else {
          setPreviewData({ base64: res.base64 })
        }
      })
      .catch(() => {})

    if (file.cachedParseResultJson) {
      try {
        const parsed = JSON.parse(file.cachedParseResultJson) as DocumentAnalysisOutcome
        setAnalysis(parsed)
        applyOutcomeToForm(parsed, file.filename)
        return () => {
          active = false
        }
      } catch {
        // ignore invalid cache
      }
    }
    setAnalysis(null)
    setForm((prev) => ({ ...prev, name: file.filename }))
    return () => {
      active = false
    }
  }, [selectedId, files, workspace.id, transport, applyOutcomeToForm])

  const loadPairedPdf = async (pairedFileId: string) => {
    if (previewData.pairedBase64) {
      setPreviewMode("paired_pdf")
      return
    }
    try {
      const res = await transport.readFilePreview(workspace.id, pairedFileId)
      setPreviewData((prev) => ({ ...prev, pairedBase64: res.base64 }))
      setPreviewMode("paired_pdf")
    } catch {
      onToast("Không đọc được PDF gốc đi kèm.", "warn")
    }
  }

  const parsedCacheById = useMemo(() => {
    const map = new Map<string, DocumentAnalysisOutcome | null>()
    for (const f of files) {
      if (!f.cachedParseResultJson) {
        map.set(f.id, null)
        continue
      }
      try {
        map.set(f.id, JSON.parse(f.cachedParseResultJson) as DocumentAnalysisOutcome)
      } catch {
        map.set(f.id, null)
      }
    }
    return map
  }, [files])

  const cleanXmlIds = useMemo(() => {
    return files
      .filter((f) => {
        if (!f.filename.toLowerCase().endsWith(".xml")) return false
        const parsed = parsedCacheById.get(f.id)
        if (!parsed) return false
        return !parsed.auditIssues?.some((i) => i.severity === "error")
      })
      .map((f) => f.id)
  }, [files, parsedCacheById])

  const filteredFiles = useMemo(() => {
    const q = queueSearch.trim().toLowerCase()
    return files.filter((f) => {
      const parsed = parsedCacheById.get(f.id)
      if (queueFilter === "pending" && parsed) return false
      if (queueFilter === "analyzed" && !parsed) return false
      if (queueFilter === "clean_xml" && !cleanXmlIds.includes(f.id)) return false
      if (q) {
        const merchant = String(parsed?.extractedFields?.merchant ?? "").toLowerCase()
        const inv = String(parsed?.extractedFields?.invoiceNumber ?? "").toLowerCase()
        return f.filename.toLowerCase().includes(q) || merchant.includes(q) || inv.includes(q)
      }
      return true
    })
  }, [files, queueFilter, queueSearch, parsedCacheById, cleanXmlIds])

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    try {
      const res = await smartIngestFileList(transport, workspace.id, fileList, "upload")
      onRefreshCounts()
      await loadInbox(res.createdFiles[0]?.id ? String(res.createdFiles[0].id) : undefined)
      onToast(
        `Đã nạp ${res.createdFiles.length} tệp.${res.skippedDuplicates.length ? ` Bỏ qua ${res.skippedDuplicates.length} tệp trùng.` : ""}`,
        "ok"
      )
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi tải tệp", "err")
    }
  }

  const runAnalyzeSingle = async (fileId: string) => {
    setAnalyzingIds((prev) => new Set(prev).add(fileId))
    try {
      const outcome = await transport.analyzeFile(workspace.id, fileId)
      await loadInbox(fileId)
      if (fileId === selectedIdRef.current) {
        setAnalysis(outcome)
        const f = files.find((x) => x.id === fileId)
        applyOutcomeToForm(outcome, f?.filename ?? "Chứng từ")
      }
      onToast(`Phân tích xong (${outcome.extractionMethod.toUpperCase()})`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi phân tích AI", "err")
    } finally {
      setAnalyzingIds((prev) => {
        const next = new Set(prev)
        next.delete(fileId)
        return next
      })
    }
  }

  const runAnalyzeAll = async () => {
    const targets = files.filter((f) => !f.cachedParseResultJson)
    const queue = (targets.length > 0 ? targets : files).map((f) => f.id)
    if (!queue.length) return
    setBatchProgress({
      jobId: "pending",
      total: queue.length,
      done: 0,
      currentFileId: "",
      currentFilename: "",
      status: "running"
    })
    try {
      const res = await transport.analyzeFilesBatch(workspace.id, queue)
      await loadInbox()
      onRefreshCounts()
      if (res.cancelled) {
        onToast(`Đã dừng sau ${res.done}/${res.total} chứng từ.`, "warn")
      } else {
        onToast(`Hoàn tất bóc tách ${res.done}/${res.total} chứng từ.`, "ok")
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi chạy hàng loạt", "err")
    } finally {
      setBatchProgress(null)
    }
  }

  const handleApprove = useCallback(async () => {
    if (!selectedId) return
    try {
      const approvedFileId = selectedId
      const curIdx = filteredFiles.findIndex((f) => f.id === selectedId)
      const nextPreferred = filteredFiles[curIdx + 1]?.id ?? filteredFiles[curIdx - 1]?.id ?? null
      const createdTx = await transport.approveFileToTransaction(workspace.id, approvedFileId, {
        ...form,
        items: analysis?.items ?? []
      })
      onRefreshCounts()
      await loadInbox(nextPreferred)
      const createdId = createdTx?.id ? String(createdTx.id) : ""
      onToast(
        "Đã duyệt chứng từ và tự động định khoản vào sổ!",
        "ok",
        createdId
          ? {
              label: "Hoàn tác",
              onClick: async () => {
                await transport.reopenTransactionToInbox(workspace.id, createdId)
                onRefreshCounts()
                await loadInbox(approvedFileId)
                onToast("Đã hoàn tác — chứng từ quay lại Hộp thư AI.", "ok")
              }
            }
          : undefined
      )
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi duyệt chứng từ", "err")
    }
  }, [selectedId, filteredFiles, transport, workspace.id, form, analysis, onRefreshCounts, onToast, loadInbox])

  const handleBatchApproveCleanXml = async () => {
    const selectedClean = cleanXmlIds.filter((id) => checkedIds.size === 0 || checkedIds.has(id))
    if (selectedClean.length === 0) return
    try {
      const res = await transport.batchApproveCleanXml(workspace.id, selectedClean)
      setCheckedIds(new Set())
      onRefreshCounts()
      await loadInbox()
      onToast(`Đã duyệt tự động ${res.approved} hóa đơn XML sạch.`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi duyệt XML hàng loạt", "err")
    }
  }

  const handleSplitItems = async () => {
    if (!selectedId || !analysis?.items?.length) return
    try {
      const created = await transport.splitFileItems(workspace.id, selectedId, analysis.items as LineItemDTO[], {
        merchant: form.merchant,
        merchantTaxCode: form.merchantTaxCode,
        issuedAt: form.issuedAt,
        currencyCode: form.currencyCode,
        direction: form.direction
      })
      onRefreshCounts()
      onToast(`Đã tách thành ${created.length} giao dịch riêng lẻ.`, "ok")
      await loadInbox()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi tách dòng hàng", "err")
    }
  }

  const handleDeleteConfirmed = async (fileId: string) => {
    try {
      await transport.deleteFile(workspace.id, fileId)
      setConfirmDeleteId(null)
      onRefreshCounts()
      onToast("Đã xóa chứng từ khỏi hộp thư.", "ok")
      await loadInbox()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xóa tệp", "err")
    }
  }

  const handleLookupFx = async () => {
    if (form.currencyCode === workspace.baseCurrency) return
    try {
      const res = await transport.lookupFxRate(workspace.id, form.currencyCode, workspace.baseCurrency, form.issuedAt)
      const rateNum = Number(res.rate) || 1
      const converted = Math.round(form.totalAmount * rateNum)
      setFxEstimate({ rate: rateNum, source: res.source, converted })
      onToast(`Tỷ giá ${form.currencyCode}/${workspace.baseCurrency}: ${rateNum.toLocaleString("vi-VN")} (${res.source})`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Không tra cứu được tỷ giá", "warn")
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (selectedId) {
          e.preventDefault()
          handleApprove().catch(() => {})
        }
        return
      }
      const tag = (document.activeElement?.tagName ?? "").toUpperCase()
      const editable = (document.activeElement as HTMLElement | null)?.isContentEditable
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable) return
      if (filteredFiles.length === 0) return

      if (e.key === "j" || e.key === "J") {
        e.preventDefault()
        const idx = filteredFiles.findIndex((f) => f.id === selectedId)
        const next = filteredFiles[Math.min(filteredFiles.length - 1, idx + 1)]
        if (next) setSelectedId(next.id)
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault()
        const idx = filteredFiles.findIndex((f) => f.id === selectedId)
        const prev = filteredFiles[Math.max(0, idx - 1)]
        if (prev) setSelectedId(prev.id)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedId, filteredFiles, handleApprove])

  const startSplitResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const container = splitContainerRef.current
    if (!container) return
    let latestPct = splitPct
    const move = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0) return
      const pct = Math.min(68, Math.max(34, Math.round(((ev.clientX - rect.left) / rect.width) * 100)))
      latestPct = pct
      setSplitPct(pct)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      saveSplitPct(latestPct)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const selectedFile = files.find((f) => f.id === selectedId)
  const isAnalyzingSelected = selectedId ? analyzingIds.has(selectedId) : false

  const selectedCatObj = useMemo(
    () => categories.find((c) => String(c.code) === form.categoryCode),
    [categories, form.categoryCode]
  )

  const liveJournalPreview = useMemo(() => {
    const rate = fxEstimate?.rate ?? 1
    const lines = suggestJournalLines({
      regime: workspace.accountingRegime,
      direction: form.direction,
      categoryCode: form.categoryCode,
      categoryDefaultDebit: selectedCatObj?.defaultDebitAccount ? String(selectedCatObj.defaultDebitAccount) : undefined,
      paymentMethod: form.paymentMethod,
      preTaxAmount: Math.round(form.preTaxAmount * rate),
      vatAmount: Math.round(form.vatAmount * rate),
      totalAmount: Math.round(form.totalAmount * rate),
      merchant: form.merchant,
      merchantTaxCode: form.merchantTaxCode,
      invoiceNumber: form.invoiceNumber
    })
    return { lines, check: verifyJournalBalance(lines) }
  }, [workspace.accountingRegime, form, selectedCatObj, fxEstimate])

  const provBadge = (fieldCode: string) => {
    const p = analysis?.provenance?.[fieldCode]
    if (!p) return null
    const pct = Math.round(p.confidence * 100)
    if (p.source === "xml") return <span className="tag tag-ok tnum shrink-0">XML 100%</span>
    if (p.confidence < 0.75) return <span className="tag tag-warn tnum shrink-0">AI {pct}%</span>
    return <span className="tag tag-info tnum shrink-0">AI {pct}%</span>
  }

  const batchCleanTargetsCount =
    checkedIds.size > 0 ? cleanXmlIds.filter((id) => checkedIds.has(id)).length : cleanXmlIds.length

  const xmlScale = useMemo(() => {
    if (fitWidth) {
      return Math.min(1, Math.max(0.45, (viewerWidth - 28) / 840))
    }
    return zoomPct / 100
  }, [fitWidth, viewerWidth, zoomPct])

  const renderQueuePane = (fullMobile = false) => (
    <div className={`${fullMobile ? "w-full flex-1" : "w-[224px] shrink-0 border-r border-[var(--line)]"} flex flex-col min-h-0 bg-[var(--raised)]`}>
      <div className="p-2 border-b border-[var(--line)] space-y-2">
        <div className="flex items-center justify-between gap-1.5">
          <input
            value={queueSearch}
            onChange={(e) => setQueueSearch(e.target.value)}
            placeholder="Lọc tên tệp, NCC..."
            className="flex-1 min-w-0 h-7 px-2.5 rounded-[7px] bg-[var(--panel)] border border-[var(--line)] text-[11.5px] outline-none focus:border-[var(--cyan)]"
          />
          {!fullMobile && (
            <button
              type="button"
              onClick={() => setQueueCollapsed(true)}
              className="w-7 h-7 rounded-[7px] grid place-items-center border border-[var(--line)] bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--text)] shrink-0"
              title="Thu gọn hàng đợi"
            >
              <PanelLeftClose size={13.5} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1 text-[10.5px]">
          {[
            { id: "all", label: `Tất cả (${files.length})` },
            { id: "pending", label: "Chờ bóc" },
            { id: "analyzed", label: "Đã bóc" },
            { id: "clean_xml", label: `XML sạch (${cleanXmlIds.length})` }
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setQueueFilter(tab.id as typeof queueFilter)}
              className={`px-2 py-0.5 rounded-[6px] border ${
                queueFilter === tab.id
                  ? "bg-[var(--cyan-s)] border-[var(--cyan)] text-[var(--cyan)] font-semibold"
                  : "border-[var(--line)] text-[var(--muted)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {filteredFiles.map((f) => {
          const active = f.id === selectedId
          const busy = analyzingIds.has(f.id)
          const parsed = parsedCacheById.get(f.id)
          const isCleanXml = cleanXmlIds.includes(f.id)
          const isChecked = checkedIds.has(f.id)
          const totalNum = Number(parsed?.extractedFields?.total ?? 0)
          const merchant = String(parsed?.extractedFields?.merchant ?? "")
          return (
            <div
              key={f.id}
              className={`p-2 rounded-[9px] border transition-colors flex items-start gap-1.5 cursor-pointer ${
                active
                  ? "bg-[var(--panel-solid)] border-[var(--cyan)]"
                  : "bg-[var(--panel)] border-[var(--line)] hover:bg-[var(--row-h)]"
              }`}
              onClick={() => {
                setSelectedId(f.id)
                if (fullMobile) setMobileTab("form")
              }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setCheckedIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(f.id)) next.delete(f.id)
                    else next.add(f.id)
                    return next
                  })
                }}
                className="mt-0.5 text-[var(--muted)] hover:text-[var(--cyan)] shrink-0"
                title="Chọn nhiều"
              >
                {isChecked ? <CheckSquare size={13} className="text-[var(--cyan)]" /> : <Square size={13} />}
              </button>

              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] font-medium text-[var(--text)] truncate">{f.filename}</div>
                {merchant && <div className="text-[10.5px] text-[var(--muted)] truncate">{merchant}</div>}
                <div className="flex items-center justify-between gap-1 mt-1 text-[10px]">
                  <span
                    className={
                      busy
                        ? "text-[var(--cyan)]"
                        : isCleanXml
                          ? "text-[var(--green)] font-semibold"
                          : parsed
                            ? "text-[var(--amber)]"
                            : "text-[var(--dim)]"
                    }
                  >
                    {busy ? "Đang bóc..." : parsed ? f.extractionMethod.toUpperCase() : "Chờ xử lý"}
                  </span>
                  <div className="flex items-center gap-1">
                    {f.pairedFileId && <span className="tag text-[9px]">XML+PDF</span>}
                    {totalNum > 0 && (
                      <span className="tnum font-semibold text-[var(--text)]">
                        {formatMoney(totalNum, String(parsed?.extractedFields?.currencyCode ?? workspace.baseCurrency))}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const renderPreviewPane = (fullMobile = false) => (
    <div
      style={fullMobile ? undefined : { width: `${splitPct}%` }}
      className={`${fullMobile ? "w-full flex-1" : "min-w-[260px]"} flex flex-col min-h-0`}
    >
      <div className="px-3 py-1.5 border-b border-[var(--line)] bg-[var(--panel)] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5">
          {!fullMobile && queueCollapsed && (
            <button type="button" onClick={() => setQueueCollapsed(false)} className="gb" title="Mở hàng đợi">
              <PanelLeftOpen size={13} />
              <span>Hàng đợi ({files.length})</span>
            </button>
          )}

          {selectedFile?.pairedFileId && (
            <div className="seg">
              <button
                type="button"
                className={previewMode === "primary" ? "on" : ""}
                onClick={() => setPreviewMode("primary")}
              >
                XML
              </button>
              <button
                type="button"
                className={previewMode === "paired_pdf" ? "on" : ""}
                onClick={() => selectedFile.pairedFileId && loadPairedPdf(selectedFile.pairedFileId)}
              >
                PDF gốc
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <button
            type="button"
            onClick={() => {
              setFitWidth(true)
              setZoomPct(100)
            }}
            className={`px-2 h-7 rounded-[7px] border flex items-center gap-1 ${
              fitWidth ? "bg-[var(--cyan-s)] border-[var(--cyan)] text-[var(--cyan)] font-semibold" : "border-[var(--line)] hover:text-[var(--text)]"
            }`}
            title="Tự động co vừa khung"
          >
            <Maximize2 size={11.5} />
            <span className="hidden xl:inline">Vừa khung</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setFitWidth(false)
              setZoomPct((z) => Math.max(50, z - 20))
            }}
            className="w-7 h-7 rounded-[7px] grid place-items-center border border-[var(--line)] hover:text-[var(--text)]"
            title="Thu nhỏ"
          >
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            onClick={() => {
              setFitWidth(false)
              setZoomPct(100)
            }}
            className="px-2 h-7 rounded-[7px] border border-[var(--line)] tnum hover:text-[var(--text)]"
          >
            {Math.round(xmlScale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => {
              setFitWidth(false)
              setZoomPct((z) => Math.min(180, z + 20))
            }}
            className="w-7 h-7 rounded-[7px] grid place-items-center border border-[var(--line)] hover:text-[var(--text)]"
            title="Phóng to"
          >
            <ZoomIn size={13} />
          </button>
          <button
            type="button"
            onClick={() => setRotateDeg((d) => (d + 90) % 360)}
            className="w-7 h-7 rounded-[7px] grid place-items-center border border-[var(--line)] hover:text-[var(--text)]"
            title="Xoay 90°"
          >
            <RotateCw size={13} />
          </button>
        </div>
      </div>

      <div ref={viewerSurfaceRef} className="flex-1 min-h-0 overflow-auto p-3 bg-[var(--outer-rail)]">
        {previewMode === "paired_pdf" && previewData.pairedBase64 ? (
          <embed
            src={previewData.pairedBase64}
            type="application/pdf"
            className="w-full h-full min-h-[520px] rounded-[10px]"
          />
        ) : previewData.xmlHtml ? (
          <div
            style={{
              width: `${Math.round(840 * xmlScale)}px`,
              height: `${Math.round(760 * xmlScale)}px`
            }}
            className="relative mx-auto"
          >
            <iframe
              title="XML Invoice Preview"
              srcDoc={previewData.xmlHtml}
              style={{
                width: "840px",
                height: "760px",
                transform: `scale(${xmlScale}) rotate(${rotateDeg}deg)`,
                transformOrigin: "top left"
              }}
              className="rounded-[10px] bg-white border border-[var(--line)] block"
            />
          </div>
        ) : previewData.base64 ? (
          selectedFile?.mimetype === "application/pdf" ? (
            <embed
              src={previewData.base64}
              type="application/pdf"
              className="w-full h-full min-h-[520px] rounded-[10px]"
            />
          ) : (
            <img
              src={previewData.base64}
              alt={selectedFile?.filename}
              style={{
                width: fitWidth ? "100%" : `${zoomPct}%`,
                transform: rotateDeg ? `rotate(${rotateDeg}deg)` : undefined
              }}
              className="mx-auto rounded-[10px] border border-[var(--line)] transition-all"
            />
          )
        ) : (
          <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">
            <Eye size={18} className="mb-1" /> Đang tải bản xem trước...
          </div>
        )}
      </div>
    </div>
  )

  const renderInspectorPane = (fullMobile = false) => (
    <div
      style={fullMobile ? undefined : { width: `${100 - splitPct}%` }}
      className={`${fullMobile ? "w-full flex-1" : "min-w-[300px]"} flex flex-col min-h-0`}
    >
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-[var(--text)] truncate">{selectedFile?.filename}</div>
            <div className="text-[11px] text-[var(--muted)]">
              {analysis
                ? `Trích xuất: ${analysis.extractionMethod.toUpperCase()} · Tin cậy ${Math.round(analysis.confidence * 100)}%`
                : "Bấm Bóc tách ngay để đọc XML hoặc gọi AI Vision"}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => selectedId && runAnalyzeSingle(selectedId)}
              disabled={isAnalyzingSelected}
              className="gb"
            >
              <RefreshCw size={13} className={isAnalyzingSelected ? "animate-spin" : ""} />
              <span>{isAnalyzingSelected ? "Đang chạy..." : "Bóc tách ngay"}</span>
            </button>
            {confirmDeleteId === selectedId ? (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--rose-s)] border border-[var(--rose)]/40 text-[11px]">
                <button
                  type="button"
                  onClick={() => selectedId && handleDeleteConfirmed(selectedId)}
                  className="font-semibold text-[var(--rose)] hover:underline"
                >
                  Xóa
                </button>
                <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-[var(--muted)] ml-1">
                  Hủy
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => selectedId && setConfirmDeleteId(selectedId)}
                className="w-8 h-8 rounded-full grid place-items-center border border-[var(--line)] text-[var(--rose)] hover:bg-[var(--rose-s)]"
                title="Xóa chứng từ"
              >
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>

        {/* Audit Alerts */}
        {analysis && analysis.auditIssues.length > 0 && (
          <div className="space-y-1.5">
            {analysis.auditIssues.map((iss, idx) => (
              <div
                key={idx}
                className={`px-3 py-2 rounded-[10px] border text-[11.5px] flex items-start gap-2 ${
                  iss.severity === "error"
                    ? "bg-[var(--rose-s)] border-[var(--rose)]/30 text-[var(--rose)]"
                    : iss.severity === "warning"
                      ? "bg-[var(--amber-s)] border-[var(--amber)]/30 text-[var(--amber)]"
                      : "bg-[var(--cyan-s)] border-[var(--cyan)]/30 text-[var(--cyan)]"
                }`}
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{iss.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* Group 1: Định danh chứng từ (Full-width Tên & NCC) */}
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 space-y-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)]">Định danh chứng từ</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="sm:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-[11px] font-medium text-[var(--muted)]">Tên giao dịch / Mặt hàng</label>
                {provBadge("name")}
              </div>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none focus:border-[var(--cyan)]"
              />
            </div>

            <div className="sm:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-[11px] font-medium text-[var(--muted)]">Nhà cung cấp / Khách hàng</label>
                {provBadge("merchant")}
              </div>
              <input
                value={form.merchant}
                onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none focus:border-[var(--cyan)]"
              />
            </div>

            <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <label className="text-[11px] font-medium text-[var(--muted)] truncate">Mã số thuế</label>
                  {provBadge("merchantTaxCode")}
                </div>
                <input
                  value={form.merchantTaxCode}
                  onChange={(e) => setForm({ ...form, merchantTaxCode: e.target.value })}
                  className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none focus:border-[var(--cyan)]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Ký hiệu HĐ</label>
                <input
                  value={form.invoiceSymbol}
                  onChange={(e) => setForm({ ...form, invoiceSymbol: e.target.value })}
                  className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Số hóa đơn</label>
                <input
                  value={form.invoiceNumber}
                  onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })}
                  className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Chiều giao dịch</label>
              <div className="seg w-full">
                <button
                  type="button"
                  className={`flex-1 justify-center ${form.direction === "input" ? "on" : ""}`}
                  onClick={() => setForm({ ...form, direction: "input" })}
                >
                  Mua vào
                </button>
                <button
                  type="button"
                  className={`flex-1 justify-center ${form.direction === "output" ? "on" : ""}`}
                  onClick={() => setForm({ ...form, direction: "output" })}
                >
                  Bán ra
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-1 mb-1">
                <label className="text-[11px] font-medium text-[var(--muted)]">Ngày lập</label>
                {provBadge("issuedAt")}
              </div>
              <input
                type="date"
                value={form.issuedAt}
                onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none focus:border-[var(--cyan)]"
              />
            </div>
          </div>
        </div>

        {/* Group 2: Tiền tệ & Thuế */}
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 space-y-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)]">Tiền tệ & Thuế GTGT</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Thuế suất GTGT</label>
              <select
                value={form.vatRateCode}
                onChange={(e) => setForm({ ...form, vatRateCode: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
              >
                {["10%", "8%", "5%", "0%", "KCT", "KKKNT"].map((r) => (
                  <option key={r} value={r} className="bg-[var(--panel-solid)]">
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Tiền tệ</label>
              <div className="flex gap-1.5">
                <select
                  value={form.currencyCode}
                  onChange={(e) => {
                    setForm({ ...form, currencyCode: e.target.value })
                    setFxEstimate(null)
                  }}
                  className="flex-1 h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
                >
                  {currencies.map((c) => (
                    <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                      {String(c.code)}
                    </option>
                  ))}
                </select>
                {form.currencyCode !== workspace.baseCurrency && (
                  <button type="button" onClick={handleLookupFx} className="gb shrink-0" title="Tra cứu tỷ giá">
                    <ArrowLeftRight size={13} />
                    <span>Tỷ giá</span>
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Tiền trước thuế</label>
              <MoneyInput
                value={form.preTaxAmount}
                onChange={(pre) => setForm({ ...form, preTaxAmount: pre, totalAmount: pre + form.vatAmount })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none focus:border-[var(--cyan)]"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Tiền thuế GTGT</label>
              <MoneyInput
                value={form.vatAmount}
                onChange={(vat) => setForm({ ...form, vatAmount: vat, totalAmount: form.preTaxAmount + vat })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none focus:border-[var(--cyan)]"
              />
            </div>

            <div className="sm:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-[11px] font-medium text-[var(--muted)]">Tổng thanh toán</label>
                {provBadge("total")}
              </div>
              <MoneyInput
                value={form.totalAmount}
                onChange={(val) => setForm({ ...form, totalAmount: val })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[13px] font-semibold outline-none focus:border-[var(--cyan)]"
              />
              {fxEstimate && (
                <div className="mt-1 text-[11px] text-[var(--cyan)] tnum">
                  Quy đổi ước tính: {formatMoney(fxEstimate.converted, workspace.baseCurrency)} (Tỷ giá {fxEstimate.rate.toLocaleString("vi-VN")})
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Group 3: Phân bổ & Định khoản VAS */}
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 space-y-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)]">Phân bổ & Hạch toán</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Thanh toán</label>
              <select
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
              >
                {["Chuyển khoản", "Tiền mặt", "Công nợ", "Thẻ / Ví điện tử"].map((pm) => (
                  <option key={pm} value={pm} className="bg-[var(--panel-solid)]">
                    {pm}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Danh mục</label>
              <select
                value={form.categoryCode}
                onChange={(e) => setForm({ ...form, categoryCode: e.target.value })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
              >
                {categories.map((c) => (
                  <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                    {String(c.name)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Dự án / Bộ phận</label>
              <select
                value={form.projectCode}
                onChange={(e) => setForm({ ...form, projectCode: e.target.value })}
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
              >
                {projects.map((p) => (
                  <option key={String(p.code)} value={String(p.code)} className="bg-[var(--panel-solid)]">
                    {String(p.name)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Ghi chú kế toán</label>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Diễn giải bổ sung..."
                className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
              />
            </div>

            {extraFields.map((ef) => (
              <div key={String(ef.code)}>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">{String(ef.name)}</label>
                <input
                  value={form.extra[String(ef.code)] ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, extra: { ...form.extra, [String(ef.code)]: e.target.value } })
                  }
                  className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
                />
              </div>
            ))}
          </div>

          {liveJournalPreview.lines.length > 0 && (
            <div className="pt-2 border-t border-[var(--line)] space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-[var(--muted)]">Định khoản dự kiến ({workspace.accountingRegime})</span>
                <span className={liveJournalPreview.check.balanced ? "text-[var(--green)] tnum" : "text-[var(--amber)] tnum"}>
                  ∑ {formatMoney(liveJournalPreview.check.totalAmountVnd, workspace.baseCurrency)}
                </span>
              </div>
              {liveJournalPreview.lines.map((ln, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2 text-[11px] py-0.5 text-[var(--text)]">
                  <span className="truncate">
                    <span className="font-semibold text-[var(--cyan)]">Nợ {ln.debitAccount}</span> /{" "}
                    <span className="font-semibold text-[var(--amber)]">Có {ln.creditAccount}</span> · {ln.description}
                  </span>
                  <span className="tnum shrink-0">{formatMoney(ln.amountVnd, workspace.baseCurrency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Extracted Line Items + Split Items Button */}
        {analysis && analysis.items.length > 0 && (
          <div className="rounded-[12px] border border-[var(--line)] bg-[var(--raised)] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[var(--text)] tnum">
                Chi tiết dòng hàng ({analysis.items.length})
              </span>
              {analysis.items.length > 1 && (
                <button type="button" onClick={handleSplitItems} className="gb">
                  <Split size={13} strokeWidth={1.8} />
                  <span>Tách thành {analysis.items.length} giao dịch</span>
                </button>
              )}
            </div>
            <div className="max-h-[160px] overflow-y-auto divide-y divide-[var(--line)]">
              {analysis.items.map((it, idx) => (
                <div key={idx} className="py-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                  <span className="truncate text-[var(--text)]">{it.name}</span>
                  <span className="shrink-0 tnum font-medium text-[var(--muted)]">
                    {formatMoney(it.amount, form.currencyCode)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sticky Bottom Action Footer */}
      <div className="px-4 py-3 border-t border-[var(--line)] bg-[var(--sheet-bg)] flex items-center justify-between gap-2 shrink-0">
        <div className="text-[11px] text-[var(--muted)] tnum">
          Tổng ghi sổ: <strong className="text-[var(--text)]">{formatMoney(form.totalAmount, form.currencyCode)}</strong>
        </div>
        <button type="button" onClick={handleApprove} className="pb">
          <CheckCircle2 size={14} strokeWidth={2} />
          <span>Duyệt & Ghi sổ</span>
        </button>
      </div>
    </div>
  )

  return (
    <div
      className="h-full flex flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleUpload(e.dataTransfer.files)
      }}
    >
      {/* Top Action Strip */}
      <div className="px-4 py-2.5 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2 bg-[var(--sheet-bg)] shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <label className="pb cursor-pointer">
            <Upload size={13.5} strokeWidth={2} />
            <span>Tải lên XML / PDF / Ảnh</span>
            <input
              type="file"
              multiple
              accept=".xml,.pdf,.zip,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => {
                handleUpload(e.target.files)
                e.target.value = ""
              }}
            />
          </label>
          <button
            type="button"
            onClick={runAnalyzeAll}
            disabled={files.length === 0 || Boolean(batchProgress)}
            className="gb hl"
          >
            <Sparkles size={13.5} strokeWidth={1.8} />
            <span>
              {batchProgress
                ? `Đang bóc ${batchProgress.done}/${batchProgress.total}...`
                : `Phân tích tất cả (${files.length})`}
            </span>
          </button>
          {batchProgress && (
            <button type="button" onClick={() => transport.cancelBatchAnalyze()} className="gb text-[var(--rose)]">
              <X size={13} />
              <span>Dừng</span>
            </button>
          )}
          {batchCleanTargetsCount > 0 && (
            <button type="button" onClick={handleBatchApproveCleanXml} className="gb">
              <CheckCircle2 size={13.5} className="text-[var(--green)]" />
              <span className="tnum">Duyệt {batchCleanTargetsCount} XML sạch</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11.5px] text-[var(--muted)]">
          {dragging && <span className="tag tag-info">Thả tệp để nạp vào hàng đợi...</span>}
          <span className="hidden md:inline text-[11px] text-[var(--dim)]">J / K chuyển · ⌘↵ duyệt</span>
          <span className="tag tnum">{files.length} chứng từ chờ duyệt</span>
        </div>
      </div>

      {files.length === 0 ? (
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div className="max-w-[380px]">
            <div className="w-12 h-12 rounded-[14px] mx-auto grid place-items-center bg-[var(--raised)] border border-[var(--line)] text-[var(--cyan)] mb-3">
              <FileCode2 size={22} strokeWidth={1.8} />
            </div>
            <h2 className="text-[15px] font-semibold text-[var(--text)]">Hộp thư chứng từ đang sạch</h2>
            <p className="text-[12px] text-[var(--muted)] mt-1">
              Kéo thả hóa đơn XML chuẩn Thông tư 78 / NĐ 70, PDF, file ZIP hoặc ảnh hóa đơn vào bất kỳ đâu để tự động bóc tách.
            </p>
          </div>
        </div>
      ) : !isLg ? (
        <>
          {/* Compact switcher under 1024px */}
          <div className="px-3 py-2 border-b border-[var(--line)] bg-[var(--sheet-bg)] shrink-0">
            <div className="seg w-full">
              <button type="button" className={`flex-1 justify-center ${mobileTab === "queue" ? "on" : ""}`} onClick={() => setMobileTab("queue")}>
                Hàng đợi ({files.length})
              </button>
              <button type="button" className={`flex-1 justify-center ${mobileTab === "preview" ? "on" : ""}`} onClick={() => setMobileTab("preview")}>
                Chứng từ
              </button>
              <button type="button" className={`flex-1 justify-center ${mobileTab === "form" ? "on" : ""}`} onClick={() => setMobileTab("form")}>
                Hạch toán
              </button>
            </div>
          </div>

          <div className="flex flex-1 min-h-0 flex-col">
            {mobileTab === "queue" && renderQueuePane(true)}
            {mobileTab === "preview" && renderPreviewPane(true)}
            {mobileTab === "form" && renderInspectorPane(true)}
          </div>
        </>
      ) : (
        <div className="flex flex-1 min-h-0">
          {!queueCollapsed && renderQueuePane(false)}
          <div ref={splitContainerRef} className="flex-1 min-w-0 flex min-h-0">
            {renderPreviewPane(false)}
            <div
              onPointerDown={startSplitResize}
              className="w-1.5 shrink-0 bg-[var(--line)] hover:bg-[var(--cyan)] cursor-col-resize transition-colors"
              title="Kéo để thay đổi kích thước vùng xem"
            />
            {renderInspectorPane(false)}
          </div>
        </div>
      )}
    </div>
  )
}
