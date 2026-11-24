import React, { useEffect, useState, useCallback } from "react"
import {
  Sparkles,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Split,
  Trash2,
  RefreshCw,
  FileCode2,
  Eye
} from "lucide-react"
import type { DocumentAnalysisOutcome, LineItemDTO, TransactionDirection, WorkspaceDTO } from "@t-tax/core"
import { useTransport, fileToPayload } from "../transport/client.js"
import { formatMoney } from "../utils/format.js"

interface UnsortedProps {
  workspace: WorkspaceDTO
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
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

export function UnsortedPage({ workspace, onRefreshCounts, onToast }: UnsortedProps) {
  const transport = useTransport()
  const [files, setFiles] = useState<UnsortedFileRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<{ base64?: string; xmlHtml?: string }>({})
  const [analysis, setAnalysis] = useState<DocumentAnalysisOutcome | null>(null)
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([])
  const [projects, setProjects] = useState<Array<Record<string, unknown>>>([])
  const [extraFields, setExtraFields] = useState<Array<Record<string, unknown>>>([])
  const [currencies, setCurrencies] = useState<Array<Record<string, unknown>>>([])
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

  // Editable review form state
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

  const loadInbox = useCallback(async () => {
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
    if (typed.length > 0 && (!selectedId || !typed.some((x) => x.id === selectedId))) {
      setSelectedId(typed[0]!.id)
    } else if (typed.length === 0) {
      setSelectedId(null)
      setAnalysis(null)
    }
  }, [workspace.id, transport, selectedId])

  useEffect(() => {
    loadInbox().catch(() => {})
  }, [loadInbox])

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
        vatRateCode: String(f.vatRateCode ?? outcome.parsedEInvoice?.vatBreakdown[0]?.vatRate ?? "10%"),
        vatAmount: Number(f.vatAmount ?? 0) || 0,
        totalAmount: Number(f.total ?? 0) || 0,
        categoryCode: String(f.categoryCode ?? "other"),
        projectCode: String(f.projectCode ?? "general"),
        paymentMethod: String(f.paymentMethod ?? "Chuyển khoản"),
        note: "",
        extra: {}
      })
    },
    [workspace.baseCurrency]
  )

  useEffect(() => {
    if (!selectedId) return
    const file = files.find((f) => f.id === selectedId)
    if (!file) return

    transport
      .readFilePreview(workspace.id, selectedId)
      .then(async (res) => {
        if (file.filename.toLowerCase().endsWith(".xml")) {
          const html = await transport.renderXmlHtmlPreview(workspace.id, selectedId)
          setPreviewData({ xmlHtml: html })
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
        return
      } catch {
        // ignore
      }
    }
    setAnalysis(null)
    setForm((prev) => ({ ...prev, name: file.filename }))
  }, [selectedId, files, workspace.id, transport, applyOutcomeToForm])

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    try {
      const payloads = await Promise.all(Array.from(fileList).map(fileToPayload))
      const res = await transport.ingestFiles(workspace.id, payloads, "upload")
      onRefreshCounts()
      await loadInbox()
      if (res.createdFiles[0]?.id) {
        setSelectedId(String(res.createdFiles[0].id))
      }
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
      await loadInbox()
      if (fileId === selectedId) {
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
    const queue = targets.length > 0 ? targets : files
    if (!queue.length) return
    setBatchProgress({ done: 0, total: queue.length })
    let done = 0
    for (const f of queue) {
      await runAnalyzeSingle(f.id)
      done++
      setBatchProgress({ done, total: queue.length })
    }
    setBatchProgress(null)
  }

  const handleApprove = async () => {
    if (!selectedId) return
    try {
      await transport.approveFileToTransaction(workspace.id, selectedId, {
        ...form,
        items: analysis?.items ?? []
      })
      onRefreshCounts()
      onToast("Đã duyệt chứng từ và tự động định khoản vào sổ!", "ok")
      await loadInbox()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi duyệt chứng từ", "err")
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

  const handleDelete = async (fileId: string) => {
    await transport.deleteFile(workspace.id, fileId)
    onRefreshCounts()
    onToast("Đã xóa chứng từ khỏi hộp thư.", "ok")
    await loadInbox()
  }

  const selectedFile = files.find((f) => f.id === selectedId)
  const isAnalyzingSelected = selectedId ? analyzingIds.has(selectedId) : false

  const provBadge = (fieldCode: string) => {
    const p = analysis?.provenance?.[fieldCode]
    if (!p) return null
    const pct = Math.round(p.confidence * 100)
    if (p.source === "xml") return <span className="tag tag-ok tnum">XML 100%</span>
    if (p.confidence < 0.75) return <span className="tag tag-warn tnum">AI {pct}% · Kiểm tra</span>
    return <span className="tag tag-info tnum">AI {pct}%</span>
  }

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
      <div className="px-5 py-3 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2 bg-[var(--sheet-bg)]">
        <div className="flex items-center gap-2.5">
          <label className="pb cursor-pointer">
            <Upload size={13.5} strokeWidth={2} />
            <span>Tải lên XML / PDF / Ảnh</span>
            <input
              type="file"
              multiple
              accept=".xml,.pdf,.zip,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => handleUpload(e.target.files)}
            />
          </label>
          <button type="button" onClick={runAnalyzeAll} disabled={files.length === 0 || Boolean(batchProgress)} className="gb hl">
            <Sparkles size={13.5} strokeWidth={1.8} />
            <span>
              {batchProgress
                ? `Đang phân tích ${batchProgress.done}/${batchProgress.total}...`
                : `Phân tích tất cả (${files.length})`}
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2 text-[11.5px] text-[var(--muted)]">
          {dragging && <span className="tag tag-info">Thả tệp để nạp vào hàng đợi...</span>}
          <span className="tnum">{files.length} chứng từ chờ duyệt</span>
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
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
          {/* Left Queue + Document Viewer */}
          <div className="lg:col-span-6 border-r border-[var(--line)] flex flex-col min-h-0">
            {/* Horizontal Queue Strip */}
            <div className="p-2.5 border-b border-[var(--line)] flex gap-1.5 overflow-x-auto bg-[var(--raised)]">
              {files.map((f) => {
                const active = f.id === selectedId
                const busy = analyzingIds.has(f.id)
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSelectedId(f.id)}
                    className={`px-3 py-1.5 rounded-[9px] text-left shrink-0 max-w-[210px] border transition-colors ${
                      active
                        ? "bg-[var(--panel-solid)] border-[var(--cyan)] text-[var(--text)]"
                        : "bg-[var(--panel)] border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    <div className="text-[11.5px] font-medium truncate">{f.filename}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px]">
                      <span className={busy ? "text-[var(--cyan)]" : f.cachedParseResultJson ? "text-[var(--green)]" : "text-[var(--dim)]"}>
                        {busy ? "Đang bóc..." : f.cachedParseResultJson ? f.extractionMethod.toUpperCase() : "Chờ xử lý"}
                      </span>
                      {f.pairedFileId && <span className="tag">XML+PDF</span>}
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Document Preview Surface */}
            <div className="flex-1 min-h-[280px] overflow-auto p-3 bg-[var(--outer-rail)]">
              {previewData.xmlHtml ? (
                <iframe
                  title="XML Invoice Preview"
                  srcDoc={previewData.xmlHtml}
                  className="w-full h-full min-h-[480px] rounded-[10px] bg-white border border-[var(--line)]"
                />
              ) : previewData.base64 ? (
                selectedFile?.mimetype === "application/pdf" ? (
                  <embed
                    src={previewData.base64}
                    type="application/pdf"
                    className="w-full h-full min-h-[480px] rounded-[10px]"
                  />
                ) : (
                  <img
                    src={previewData.base64}
                    alt={selectedFile?.filename}
                    className="max-w-full mx-auto rounded-[10px] border border-[var(--line)]"
                  />
                )
              ) : (
                <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">
                  <Eye size={18} className="mb-1" /> Đang tải bản xem trước...
                </div>
              )}
            </div>
          </div>

          {/* Right Form & Provenance Review */}
          <div className="lg:col-span-6 overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[var(--text)] truncate">{selectedFile?.filename}</div>
                <div className="text-[11px] text-[var(--muted)]">
                  {analysis
                    ? `Trích xuất: ${analysis.extractionMethod.toUpperCase()} · Độ tin cậy ${Math.round(analysis.confidence * 100)}%`
                    : "Bấm Bóc tách ngay để tự động đọc XML hoặc gọi AI Vision"}
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
                <button
                  type="button"
                  onClick={() => selectedId && handleDelete(selectedId)}
                  className="w-8 h-8 rounded-full grid place-items-center border border-[var(--line)] text-[var(--rose)] hover:bg-[var(--rose-s)]"
                  title="Xóa chứng từ"
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                </button>
              </div>
            </div>

            {/* Audit / Compliance Alerts */}
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

            {/* Form Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[var(--muted)]">Tên giao dịch / Mặt hàng</label>
                  {provBadge("name")}
                </div>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none focus:border-[var(--cyan)]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[var(--muted)]">Nhà cung cấp / Khách hàng</label>
                  {provBadge("merchant")}
                </div>
                <input
                  value={form.merchant}
                  onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none focus:border-[var(--cyan)]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[var(--muted)]">Mã số thuế</label>
                  {provBadge("merchantTaxCode")}
                </div>
                <input
                  value={form.merchantTaxCode}
                  onChange={(e) => setForm({ ...form, merchantTaxCode: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none focus:border-[var(--cyan)]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Chiều giao dịch</label>
                <div className="seg w-full">
                  <button
                    type="button"
                    className={`flex-1 justify-center ${form.direction === "input" ? "on" : ""}`}
                    onClick={() => setForm({ ...form, direction: "input" })}
                  >
                    Mua vào (Chi)
                  </button>
                  <button
                    type="button"
                    className={`flex-1 justify-center ${form.direction === "output" ? "on" : ""}`}
                    onClick={() => setForm({ ...form, direction: "output" })}
                  >
                    Bán ra (Thu)
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[var(--muted)]">Ngày lập (YYYY-MM-DD)</label>
                  {provBadge("issuedAt")}
                </div>
                <input
                  type="date"
                  value={form.issuedAt}
                  onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none focus:border-[var(--cyan)]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Ký hiệu HĐ</label>
                <input
                  value={form.invoiceSymbol}
                  onChange={(e) => setForm({ ...form, invoiceSymbol: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Số hóa đơn</label>
                <input
                  value={form.invoiceNumber}
                  onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Tiền trước thuế</label>
                <input
                  type="number"
                  value={form.preTaxAmount}
                  onChange={(e) => {
                    const pre = Number(e.target.value) || 0
                    setForm({ ...form, preTaxAmount: pre, totalAmount: pre + form.vatAmount })
                  }}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Tiền thuế GTGT</label>
                <input
                  type="number"
                  value={form.vatAmount}
                  onChange={(e) => {
                    const vat = Number(e.target.value) || 0
                    setForm({ ...form, vatAmount: vat, totalAmount: form.preTaxAmount + vat })
                  }}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[var(--muted)]">Tổng thanh toán</label>
                  {provBadge("total")}
                </div>
                <input
                  type="number"
                  value={form.totalAmount}
                  onChange={(e) => setForm({ ...form, totalAmount: Number(e.target.value) || 0 })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] font-semibold tnum outline-none focus:border-[var(--cyan)]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Tiền tệ</label>
                <select
                  value={form.currencyCode}
                  onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
                >
                  {currencies.map((c) => (
                    <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                      {String(c.code)} ({String(c.name)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Danh mục</label>
                <select
                  value={form.categoryCode}
                  onChange={(e) => setForm({ ...form, categoryCode: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
                >
                  {categories.map((c) => (
                    <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                      {String(c.name)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">Dự án</label>
                <select
                  value={form.projectCode}
                  onChange={(e) => setForm({ ...form, projectCode: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
                >
                  {projects.map((p) => (
                    <option key={String(p.code)} value={String(p.code)} className="bg-[var(--panel-solid)]">
                      {String(p.name)}
                    </option>
                  ))}
                </select>
              </div>

              {extraFields.map((ef) => (
                <div key={String(ef.code)}>
                  <label className="block text-[11px] font-medium text-[var(--muted)] mb-1">{String(ef.name)}</label>
                  <input
                    value={form.extra[String(ef.code)] ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, extra: { ...form.extra, [String(ef.code)]: e.target.value } })
                    }
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] outline-none"
                  />
                </div>
              ))}
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

            <div className="pt-2 flex items-center justify-end gap-2">
              <button type="button" onClick={handleApprove} className="pb">
                <CheckCircle2 size={14} strokeWidth={2} />
                <span>Duyệt & Ghi sổ</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
