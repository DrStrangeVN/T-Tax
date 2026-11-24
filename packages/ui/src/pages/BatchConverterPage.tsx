import React, { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Upload, FileCheck2, AlertTriangle, FileDown, Database, Eye, X, Search, FileSpreadsheet } from "lucide-react"
import type { UiPreferences, WorkspaceDTO } from "@t-tax/core"
import { useTransport, fileToPayload, type BatchXmlResultItem } from "../transport/client.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

interface BatchConverterProps {
  workspace: WorkspaceDTO
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

const UI_PREFS_KEY = "ttax:ui-prefs:v1"

function loadBatchSplitPct(): number {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as UiPreferences
      if (typeof p.batchSplitPct === "number" && p.batchSplitPct >= 38 && p.batchSplitPct <= 72) {
        return p.batchSplitPct
      }
    }
  } catch {
    // ignore
  }
  return 55
}

function saveBatchSplitPct(pct: number) {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    const prev = raw ? (JSON.parse(raw) as UiPreferences) : {}
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...prev, batchSplitPct: pct }))
  } catch {
    // ignore
  }
}

export function BatchConverterPage({ workspace, onRefreshCounts, onToast }: BatchConverterProps) {
  const transport = useTransport()
  const [results, setResults] = useState<BatchXmlResultItem[]>([])
  const [batchId, setBatchId] = useState<string | null>(null)
  const [selectedSet, setSelectedSet] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "warning" | "error">("all")
  const [search, setSearch] = useState("")

  const [busy, setBusy] = useState(false)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string>("")
  const [splitPct, setSplitPct] = useState(() => loadBatchSplitPct())
  const [previewWidth, setPreviewWidth] = useState(520)
  const [isLg, setIsLg] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1024))

  const splitRef = useRef<HTMLDivElement | null>(null)
  const viewerBoxRef = useRef<HTMLDivElement | null>(null)
  const tableScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    setIsLg(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setIsLg(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    const el = viewerBoxRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 120) setPreviewWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [previewIdx, splitPct, isLg])

  const previewItem = previewIdx !== null ? results[previewIdx] ?? null : null
  const previewScale = useMemo(() => Math.min(1, Math.max(0.45, (previewWidth - 24) / 840)), [previewWidth])

  const indexedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: Array<{ origIdx: number; item: BatchXmlResultItem }> = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      if (statusFilter !== "all" && r.status !== statusFilter) continue
      if (q) {
        const hay = `${r.filename} ${r.parsed?.invoiceNumber ?? ""} ${r.parsed?.seller.taxCode ?? ""} ${r.parsed?.seller.name ?? ""}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      out.push({ origIdx: i, item: r })
    }
    return out
  }, [results, statusFilter, search])

  const rowVirtualizer = useVirtualizer({
    count: indexedFiltered.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 52,
    overscan: 12
  })

  const openItemPreview = async (idx: number) => {
    const item = results[idx]
    if (!item?.parsed) return
    setPreviewIdx(idx)
    if (item.htmlPreview) {
      setPreviewHtml(item.htmlPreview)
      return
    }
    setPreviewHtml("")
    try {
      const html = await transport.renderParsedXmlHtml(item.parsed, item.signature)
      setPreviewHtml(html)
      setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, htmlPreview: html } : r)))
    } catch {
      onToast("Không tạo được bản thể hiện hóa đơn.", "warn")
    }
  }

  const runFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    setBusy(true)
    setPreviewIdx(null)
    try {
      const payloads = await Promise.all(Array.from(fileList).map(fileToPayload))
      if (transport.batchProcessXmlSession) {
        const sessionRes = await transport.batchProcessXmlSession(workspace.id, payloads)
        setBatchId(sessionRes.batchId)
        setResults(sessionRes.items)
        const autoChecked = new Set<number>()
        sessionRes.items.forEach((r, i) => {
          if (r.parsed && r.status !== "error") autoChecked.add(i)
        })
        setSelectedSet(autoChecked)
        onToast(`Đã quét ${sessionRes.items.length} tệp XML.`, "ok")
      } else {
        const res = await transport.batchProcessXml(workspace.id, payloads, false)
        setBatchId(null)
        setResults(res)
        onToast(`Đã quét ${res.length} tệp XML.`, "ok")
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xử lý XML", "err")
    } finally {
      setBusy(false)
    }
  }

  const handleCommitSelectedToLedger = async () => {
    const picked = [...selectedSet].sort((a, b) => a - b)
    if (!picked.length) return
    setBusy(true)
    try {
      if (batchId && transport.commitBatchXmlSession) {
        const committed = await transport.commitBatchXmlSession(workspace.id, batchId, picked)
        setResults((prev) =>
          prev.map((r, idx) => {
            const pos = picked.indexOf(idx)
            return pos >= 0 && committed.items[pos] ? committed.items[pos]! : r
          })
        )
        onRefreshCounts()
        const savedCount = committed.items.filter((r) => Boolean(r.savedTransactionId)).length
        onToast(`Đã đẩy ${savedCount} hóa đơn hợp lệ vào Sổ giao dịch & hạch toán Nợ/Có.`, "ok")
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi ghi sổ hàng loạt", "err")
    } finally {
      setBusy(false)
    }
  }

  const handleExportBatchExcel = async () => {
    if (!results.length || !transport.exportBatchXmlExcel) return
    try {
      const payload = results.map((r) => ({
        filename: r.filename,
        status: r.status,
        parsed: r.parsed,
        signature: r.signature,
        issueSummary: r.error || r.issues.map((i) => i.message).join("; ")
      }))
      const res = await transport.exportBatchXmlExcel(payload)
      if (!res.canceled && res.savedPath) onToast(`Đã xuất Excel bảng kê XML: ${res.savedPath}`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xuất Excel lô XML", "err")
    }
  }

  const handleExportBatchPdf = async () => {
    const candidates = results.filter((r, i) => Boolean(r.parsed) && (selectedSet.size === 0 || selectedSet.has(i)))
    if (!candidates.length) return
    setBusy(true)
    try {
      const htmlItems = await Promise.all(
        candidates.map(async (r) => ({
          filename: `${r.parsed?.seller.taxCode ?? "inv"}_${r.parsed?.symbol ?? ""}_${r.parsed?.invoiceNumber ?? r.filename}.pdf`,
          html: r.htmlPreview || (await transport.renderParsedXmlHtml(r.parsed!, r.signature))
        }))
      )
      const res = await transport.saveBatchPdfsFromHtml(htmlItems)
      if (!res.canceled) {
        onToast(`Đã chuyển đổi ${res.count} hóa đơn XML sang PDF tại ${res.folderPath}.`, "ok")
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xuất PDF hàng loạt", "err")
    } finally {
      setBusy(false)
    }
  }

  const startSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const box = splitRef.current
    if (!box) return
    let latest = splitPct
    const move = (ev: PointerEvent) => {
      const rect = box.getBoundingClientRect()
      if (rect.width <= 0) return
      const pct = Math.min(72, Math.max(38, Math.round(((ev.clientX - rect.left) / rect.width) * 100)))
      latest = pct
      setSplitPct(pct)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      saveBatchSplitPct(latest)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const validCount = results.filter((r) => r.status === "valid").length
  const warnCount = results.filter((r) => r.status === "warning").length
  const errCount = results.filter((r) => r.status === "error").length

  const previewNode = previewItem && (
    <div style={isLg ? { width: `${100 - splitPct}%` } : undefined} className="min-w-[280px] flex-1 flex flex-col min-h-0 bg-[var(--outer-rail)]">
      <div className="px-4 py-2 border-b border-[var(--line)] bg-[var(--sheet-bg)] flex items-center justify-between gap-2 shrink-0">
        <span className="text-[12.5px] font-semibold truncate">
          Bản thể hiện HĐ {previewItem.parsed?.symbol}-{previewItem.parsed?.invoiceNumber}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={!previewHtml}
            onClick={() =>
              previewHtml &&
              transport.savePdfFromHtml(`${previewItem.parsed?.symbol}_${previewItem.parsed?.invoiceNumber}.pdf`, previewHtml)
            }
            className="pb"
          >
            <FileDown size={13} />
            <span>Lưu PDF</span>
          </button>
          <button
            type="button"
            onClick={() => setPreviewIdx(null)}
            className="w-7 h-7 rounded-full grid place-items-center hover:bg-[var(--hover)]"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div ref={viewerBoxRef} className="flex-1 min-h-0 overflow-auto p-3">
        {previewHtml ? (
          <div style={{ width: `${Math.round(840 * previewScale)}px`, height: `${Math.round(760 * previewScale)}px` }} className="mx-auto">
            <iframe
              title="iTaxViewer Preview"
              srcDoc={previewHtml}
              style={{
                width: "840px",
                height: "760px",
                transform: `scale(${previewScale})`,
                transformOrigin: "top left"
              }}
              className="bg-white rounded-[8px] border border-[var(--line)] block"
            />
          </div>
        ) : (
          <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">Đang dựng bản thể hiện...</div>
        )}
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2 bg-[var(--sheet-bg)] shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <label className="pb cursor-pointer">
            <Upload size={13.5} strokeWidth={2} />
            <span>{busy ? "Đang xử lý..." : "Chọn nhiều XML / ZIP"}</span>
            <input
              type="file"
              multiple
              accept=".xml,.zip"
              className="hidden"
              onChange={(e) => {
                runFiles(e.target.files)
                e.target.value = ""
              }}
            />
          </label>
          <button
            type="button"
            disabled={!selectedSet.size || !batchId || busy}
            onClick={handleCommitSelectedToLedger}
            className="gb hl"
          >
            <Database size={13.5} />
            <span className="tnum">Ghi sổ {selectedSet.size > 0 ? `(${selectedSet.size}) ` : ""}dòng chọn</span>
          </button>
          <button
            type="button"
            disabled={!results.some((r) => Boolean(r.parsed)) || busy}
            onClick={handleExportBatchPdf}
            className="gb"
          >
            <FileDown size={13.5} />
            <span>Xuất PDF</span>
          </button>
          {results.length > 0 && transport.exportBatchXmlExcel && (
            <button type="button" onClick={handleExportBatchExcel} className="gb">
              <FileSpreadsheet size={13.5} />
              <span>Xuất Excel bảng kê</span>
            </button>
          )}
        </div>

        {results.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <div className="relative">
              <Search size={12.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Lọc số HĐ, MST..."
                className="h-7 w-[145px] pl-7 pr-2.5 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[11.5px] outline-none focus:border-[var(--cyan)]"
              />
            </div>
            <button
              type="button"
              onClick={() => setStatusFilter((s) => (s === "valid" ? "all" : "valid"))}
              className={`tag tag-ok tnum ${statusFilter === "valid" ? "ring-2 ring-[var(--green)]" : ""}`}
            >
              {validCount} Hợp lệ
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter((s) => (s === "warning" ? "all" : "warning"))}
              className={`tag tag-warn tnum ${statusFilter === "warning" ? "ring-2 ring-[var(--amber)]" : ""}`}
            >
              {warnCount} Cảnh báo
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter((s) => (s === "error" ? "all" : "error"))}
              className={`tag tag-err tnum ${statusFilter === "error" ? "ring-2 ring-[var(--rose)]" : ""}`}
            >
              {errCount} Lỗi
            </button>
          </div>
        )}
      </div>

      {results.length === 0 ? (
        <div className="flex-1 p-6 grid place-items-center">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              runFiles(e.dataTransfer.files)
            }}
            className="w-full max-w-[540px] rounded-[16px] border border-dashed border-[var(--line2)] bg-[var(--panel)] p-10 text-center cursor-pointer hover:border-[var(--cyan)]"
          >
            <FileCheck2 size={28} strokeWidth={1.7} className="mx-auto text-[var(--cyan)] mb-3" />
            <div className="text-[14px] font-semibold text-[var(--text)]">
              Trình Quét, Kiểm toán Chữ ký số & Chuyển đổi XML (iTaxViewer)
            </div>
            <p className="text-[12px] text-[var(--muted)] mt-1.5">
              Thả hàng trăm tệp XML hoặc gói ZIP hóa đơn điện tử chuẩn TT78 / NĐ 70/2025. Kiểm tra chữ ký XMLDSig, số học và giữ nguyên số 0 đầu MST/Số HĐ.
            </p>
            <input
              type="file"
              multiple
              accept=".xml,.zip"
              className="hidden"
              onChange={(e) => {
                runFiles(e.target.files)
                e.target.value = ""
              }}
            />
          </label>
        </div>
      ) : !isLg && previewItem ? (
        previewNode
      ) : (
        <div ref={splitRef} className="flex-1 min-h-0 flex">
          <div
            style={previewItem ? { width: `${splitPct}%` } : undefined}
            className={`${previewItem ? "min-w-[300px]" : "w-full"} flex flex-col min-h-0`}
          >
            <div
              style={{
                gridTemplateColumns: previewItem ? "28px 94px minmax(110px,1fr) 110px 140px 78px" : "28px 94px 86px minmax(140px,1fr) 114px 160px 78px"
              }}
              className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)] grid gap-2 px-3 py-2.5 shrink-0 font-semibold items-center"
            >
              <div>
                <input
                  type="checkbox"
                  checked={indexedFiltered.length > 0 && indexedFiltered.every((x) => selectedSet.has(x.origIdx))}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedSet(new Set(indexedFiltered.filter((x) => x.item.parsed).map((x) => x.origIdx)))
                    else setSelectedSet(new Set())
                  }}
                />
              </div>
              <div>Số HĐ</div>
              {!previewItem && <div>Ngày</div>}
              <div>Người bán / MST</div>
              <div className="text-right">Tổng tiền</div>
              <div>Audit</div>
              <div className="text-right">Xem</div>
            </div>

            <div ref={tableScrollRef} className="flex-1 min-h-0 overflow-y-auto">
              <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vr) => {
                  const { origIdx, item: r } = indexedFiltered[vr.index]!
                  const checked = selectedSet.has(origIdx)
                  return (
                    <div
                      key={origIdx}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${vr.size}px`,
                        transform: `translateY(${vr.start}px)`,
                        gridTemplateColumns: previewItem ? "28px 94px minmax(110px,1fr) 110px 140px 78px" : "28px 94px 86px minmax(140px,1fr) 114px 160px 78px"
                      }}
                      className={`grid gap-2 items-center px-3 border-b border-[var(--line)] text-[12px] ${
                        previewIdx === origIdx ? "bg-[var(--cyan-s)]" : "hover:bg-[var(--hover)]"
                      }`}
                    >
                      <div>
                        <input
                          type="checkbox"
                          disabled={!r.parsed}
                          checked={checked}
                          onChange={() =>
                            setSelectedSet((prev) => {
                              const next = new Set(prev)
                              if (next.has(origIdx)) next.delete(origIdx)
                              else next.add(origIdx)
                              return next
                            })
                          }
                        />
                      </div>
                      <div className="tnum whitespace-nowrap min-w-0">
                        {r.parsed ? (
                          <>
                            <div className="font-semibold text-[var(--text)] truncate">{r.parsed.invoiceNumber}</div>
                            <div className="text-[10.5px] text-[var(--dim)] truncate">
                              {r.parsed.templateCode}
                              {r.parsed.symbol}
                            </div>
                          </>
                        ) : (
                          <span className="text-[var(--rose)] truncate block">{r.filename}</span>
                        )}
                      </div>
                      {!previewItem && <div className="tnum text-[var(--muted)] whitespace-nowrap">{formatDateVi(r.parsed?.issuedDate)}</div>}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[var(--text)]">{r.parsed?.seller.name ?? "—"}</div>
                        <div className="text-[10.5px] text-[var(--dim)] tnum truncate">{r.parsed?.seller.taxCode ?? ""}</div>
                      </div>
                      <div className="text-right tnum font-semibold text-[var(--text)] whitespace-nowrap">
                        {r.parsed ? formatMoney(r.parsed.totals.totalPayable, r.parsed.currencyCode) : "—"}
                      </div>
                      <div className="flex flex-wrap gap-1 items-center min-w-0">
                        {r.error ? (
                          <span className="tag tag-err truncate">{r.error}</span>
                        ) : (
                          <>
                            <span
                              className={`tag ${
                                r.signature?.status === "valid"
                                  ? "tag-ok"
                                  : r.signature?.status === "invalid"
                                    ? "tag-err"
                                    : "tag-warn"
                              }`}
                            >
                              {r.signature?.status === "valid" ? "CKS ✓" : r.signature?.status === "invalid" ? "CKS lỗi" : "Chưa ký"}
                            </span>
                            {r.issues.length > 0 && (
                              <span className="tag tag-warn">
                                <AlertTriangle size={10} /> {r.issues.length}
                              </span>
                            )}
                            {r.savedTransactionId && <span className="tag tag-ok">Đã sổ</span>}
                          </>
                        )}
                      </div>
                      <div className="text-right">
                        {r.parsed && (
                          <button type="button" onClick={() => openItemPreview(origIdx)} className="gb">
                            <Eye size={12.5} />
                            <span>Xem</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {previewItem && (
            <>
              <div
                onPointerDown={startSplitDrag}
                className="w-1.5 shrink-0 bg-[var(--line)] hover:bg-[var(--cyan)] cursor-col-resize transition-colors"
                title="Kéo để thay đổi kích thước vùng xem"
              />
              {previewNode}
            </>
          )}
        </div>
      )}
    </div>
  )
}
