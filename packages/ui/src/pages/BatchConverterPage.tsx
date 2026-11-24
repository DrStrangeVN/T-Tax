import React, { useEffect, useMemo, useRef, useState } from "react"
import { Upload, FileCheck2, AlertTriangle, FileDown, Database, Eye, X } from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport, fileToPayload, type BatchXmlResultItem } from "../transport/client.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

interface BatchConverterProps {
  workspace: WorkspaceDTO
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

export function BatchConverterPage({ workspace, onRefreshCounts, onToast }: BatchConverterProps) {
  const transport = useTransport()
  const [results, setResults] = useState<BatchXmlResultItem[]>([])
  const [busy, setBusy] = useState(false)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string>("")
  const [lastPayloads, setLastPayloads] = useState<Awaited<ReturnType<typeof fileToPayload>>[]>([])
  const [splitPct, setSplitPct] = useState(55)
  const [previewWidth, setPreviewWidth] = useState(520)

  const splitRef = useRef<HTMLDivElement | null>(null)
  const viewerBoxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = viewerBoxRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 120) setPreviewWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [previewIdx, splitPct])

  const previewItem = previewIdx !== null ? results[previewIdx] ?? null : null
  const previewScale = useMemo(() => Math.min(1, Math.max(0.45, (previewWidth - 24) / 840)), [previewWidth])

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

  const runFiles = async (fileList: FileList | null, saveToLedger = false) => {
    if (!fileList?.length) return
    setBusy(true)
    setPreviewIdx(null)
    try {
      const payloads = await Promise.all(Array.from(fileList).map(fileToPayload))
      setLastPayloads(payloads)
      const res = await transport.batchProcessXml(workspace.id, payloads, saveToLedger)
      setResults(res)
      if (saveToLedger) onRefreshCounts()
      onToast(`Đã quét ${res.length} tệp XML.`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xử lý XML", "err")
    } finally {
      setBusy(false)
    }
  }

  const handleCommitAllToLedger = async () => {
    if (!lastPayloads.length) return
    setBusy(true)
    try {
      const res = await transport.batchProcessXml(workspace.id, lastPayloads, true)
      setResults(res)
      onRefreshCounts()
      const savedCount = res.filter((r) => Boolean(r.savedTransactionId)).length
      onToast(`Đã đẩy ${savedCount} hóa đơn hợp lệ vào Sổ giao dịch & hạch toán Nợ/Có.`, "ok")
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi ghi sổ hàng loạt", "err")
    } finally {
      setBusy(false)
    }
  }

  const handleExportBatchPdf = async () => {
    const candidates = results.filter((r) => Boolean(r.parsed))
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
    const move = (ev: PointerEvent) => {
      const rect = box.getBoundingClientRect()
      if (rect.width <= 0) return
      const pct = Math.min(72, Math.max(38, Math.round(((ev.clientX - rect.left) / rect.width) * 100)))
      setSplitPct(pct)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const validCount = results.filter((r) => r.status === "valid").length
  const warnCount = results.filter((r) => r.status === "warning").length
  const errCount = results.filter((r) => r.status === "error").length

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--sheet-bg)] shrink-0">
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
                runFiles(e.target.files, false)
                e.target.value = ""
              }}
            />
          </label>
          <button type="button" disabled={!results.length || busy} onClick={handleCommitAllToLedger} className="gb hl">
            <Database size={13.5} />
            <span>Ghi sổ & Định khoản tất cả</span>
          </button>
          <button
            type="button"
            disabled={!results.some((r) => Boolean(r.parsed)) || busy}
            onClick={handleExportBatchPdf}
            className="gb"
          >
            <FileDown size={13.5} />
            <span>Chuyển XML → PDF hàng loạt</span>
          </button>
        </div>

        {results.length > 0 && (
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="tag tag-ok tnum">{validCount} Hợp lệ</span>
            <span className="tag tag-warn tnum">{warnCount} Cảnh báo</span>
            <span className="tag tag-err tnum">{errCount} Lỗi</span>
          </div>
        )}
      </div>

      {results.length === 0 ? (
        <div className="flex-1 p-6 grid place-items-center">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              runFiles(e.dataTransfer.files, false)
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
                runFiles(e.target.files, false)
                e.target.value = ""
              }}
            />
          </label>
        </div>
      ) : (
        <div ref={splitRef} className="flex-1 min-h-0 flex">
          <div
            style={previewItem ? { width: `${splitPct}%` } : undefined}
            className={`${previewItem ? "min-w-[300px]" : "w-full"} overflow-auto`}
          >
            <table className="w-full text-left border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                <tr>
                  <th className="py-2.5 px-2.5">Số HĐ</th>
                  {!previewItem && <th className="py-2.5 px-2">Ngày</th>}
                  <th className="py-2.5 px-2.5">Người bán / MST</th>
                  <th className="py-2.5 px-2.5 text-right">Tổng tiền</th>
                  <th className="py-2.5 px-2.5">Audit</th>
                  <th className="py-2.5 px-2.5 text-right">Xem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {results.map((r, idx) => (
                  <tr key={idx} className={previewIdx === idx ? "bg-[var(--cyan-s)]" : "hover:bg-[var(--hover)]"}>
                    <td className="py-2.5 px-2.5 tnum whitespace-nowrap">
                      {r.parsed ? (
                        <>
                          <div className="font-semibold text-[var(--text)]">{r.parsed.invoiceNumber}</div>
                          <div className="text-[10.5px] text-[var(--dim)]">
                            {r.parsed.templateCode}{r.parsed.symbol}
                          </div>
                        </>
                      ) : (
                        <span className="text-[var(--rose)]">{r.filename}</span>
                      )}
                    </td>
                    {!previewItem && (
                      <td className="py-2.5 px-2 tnum text-[var(--muted)] whitespace-nowrap">{formatDateVi(r.parsed?.issuedDate)}</td>
                    )}
                    <td className="py-2.5 px-2.5 max-w-[160px]">
                      <div className="truncate font-medium text-[var(--text)]">{r.parsed?.seller.name ?? "—"}</div>
                      <div className="text-[10.5px] text-[var(--dim)] tnum">{r.parsed?.seller.taxCode ?? ""}</div>
                    </td>
                    <td className="py-2.5 px-2.5 text-right tnum font-semibold text-[var(--text)] whitespace-nowrap">
                      {r.parsed ? formatMoney(r.parsed.totals.totalPayable, r.parsed.currencyCode) : "—"}
                    </td>
                    <td className="py-2.5 px-2.5">
                      {r.error ? (
                        <span className="tag tag-err">{r.error}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <span
                            className={`tag ${
                              r.signature?.status === "valid"
                                ? "tag-ok"
                                : r.signature?.status === "invalid"
                                  ? "tag-err"
                                  : "tag-warn"
                            }`}
                          >
                            {r.signature?.status === "valid"
                              ? "CKS hợp lệ"
                              : r.signature?.status === "invalid"
                                ? "CKS lỗi"
                                : r.signature?.status === "unverified_ca"
                                  ? "CKS chưa CA"
                                  : "Chưa ký"}
                          </span>
                          {r.issues.length > 0 && (
                            <span className="tag tag-warn">
                              <AlertTriangle size={10} /> {r.issues.length} lưu ý
                            </span>
                          )}
                          {r.savedTransactionId && <span className="tag tag-ok">Đã ghi sổ</span>}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {r.parsed && (
                        <button type="button" onClick={() => openItemPreview(idx)} className="gb">
                          <Eye size={12.5} />
                          <span>Xem</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {previewItem && (
            <>
              <div
                onPointerDown={startSplitDrag}
                className="w-1.5 shrink-0 bg-[var(--line)] hover:bg-[var(--cyan)] cursor-col-resize transition-colors"
                title="Kéo để thay đổi kích thước vùng xem"
              />
              <div style={{ width: `${100 - splitPct}%` }} className="min-w-[280px] flex flex-col min-h-0 bg-[var(--outer-rail)]">
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
                        transport.savePdfFromHtml(
                          `${previewItem.parsed?.symbol}_${previewItem.parsed?.invoiceNumber}.pdf`,
                          previewHtml
                        )
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
                    <div
                      style={{
                        width: `${Math.round(840 * previewScale)}px`,
                        height: `${Math.round(760 * previewScale)}px`
                      }}
                      className="mx-auto"
                    >
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
