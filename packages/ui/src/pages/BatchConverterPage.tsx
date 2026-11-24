import React, { useState } from "react"
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
  const [previewItem, setPreviewItem] = useState<BatchXmlResultItem | null>(null)
  const [lastPayloads, setLastPayloads] = useState<Awaited<ReturnType<typeof fileToPayload>>[]>([])

  const runFiles = async (fileList: FileList | null, saveToLedger = false) => {
    if (!fileList?.length) return
    setBusy(true)
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
    const htmlItems = results
      .filter((r) => Boolean(r.htmlPreview))
      .map((r) => ({
        filename: `${r.parsed?.seller.taxCode ?? "inv"}_${r.parsed?.symbol ?? ""}_${r.parsed?.invoiceNumber ?? r.filename}.pdf`,
        html: r.htmlPreview!
      }))
    if (!htmlItems.length) return
    try {
      const res = await transport.saveBatchPdfsFromHtml(htmlItems)
      if (!res.canceled) {
        onToast(`Đã chuyển đổi ${res.count} hóa đơn XML sang PDF tại ${res.folderPath}.`, "ok")
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi xuất PDF hàng loạt", "err")
    }
  }

  const validCount = results.filter((r) => r.status === "valid").length
  const warnCount = results.filter((r) => r.status === "warning").length
  const errCount = results.filter((r) => r.status === "error").length

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--sheet-bg)]">
        <div className="flex flex-wrap items-center gap-2">
          <label className="pb cursor-pointer">
            <Upload size={13.5} strokeWidth={2} />
            <span>{busy ? "Đang quét..." : "Chọn nhiều XML / ZIP"}</span>
            <input
              type="file"
              multiple
              accept=".xml,.zip"
              className="hidden"
              onChange={(e) => runFiles(e.target.files, false)}
            />
          </label>
          <button
            type="button"
            disabled={!results.length || busy}
            onClick={handleCommitAllToLedger}
            className="gb hl"
          >
            <Database size={13.5} />
            <span>Ghi sổ & Định khoản tất cả</span>
          </button>
          <button
            type="button"
            disabled={!results.some((r) => r.htmlPreview)}
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
              onChange={(e) => runFiles(e.target.files, false)}
            />
          </label>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
          <div className={`${previewItem ? "lg:col-span-7" : "lg:col-span-12"} overflow-auto border-r border-[var(--line)]`}>
            <table className="w-full text-left border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                <tr>
                  <th className="py-2.5 px-3">Số HĐ / Ký hiệu</th>
                  <th className="py-2.5 px-3">Ngày</th>
                  <th className="py-2.5 px-3">Người bán / MST</th>
                  <th className="py-2.5 px-3 text-right">Tổng tiền</th>
                  <th className="py-2.5 px-3">Chữ ký & Audit</th>
                  <th className="py-2.5 px-3 text-right">Xem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {results.map((r, idx) => (
                  <tr key={idx} className="hover:bg-[var(--hover)]">
                    <td className="py-2.5 px-3 tnum">
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
                    <td className="py-2.5 px-3 tnum text-[var(--muted)]">{formatDateVi(r.parsed?.issuedDate)}</td>
                    <td className="py-2.5 px-3 max-w-[230px]">
                      <div className="truncate font-medium text-[var(--text)]">{r.parsed?.seller.name ?? "—"}</div>
                      <div className="text-[10.5px] text-[var(--dim)] tnum">{r.parsed?.seller.taxCode ?? ""}</div>
                    </td>
                    <td className="py-2.5 px-3 text-right tnum font-semibold text-[var(--text)]">
                      {r.parsed ? formatMoney(r.parsed.totals.totalPayable, r.parsed.currencyCode) : "—"}
                    </td>
                    <td className="py-2.5 px-3">
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
                      {r.htmlPreview && (
                        <button type="button" onClick={() => setPreviewItem(r)} className="gb">
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
            <div className="lg:col-span-5 flex flex-col min-h-0 bg-[var(--outer-rail)]">
              <div className="px-4 py-2.5 border-b border-[var(--line)] bg-[var(--sheet-bg)] flex items-center justify-between">
                <span className="text-[12.5px] font-semibold truncate">
                  Bản thể hiện HĐ {previewItem.parsed?.symbol}-{previewItem.parsed?.invoiceNumber}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      previewItem.htmlPreview &&
                      transport.savePdfFromHtml(
                        `${previewItem.parsed?.symbol}_${previewItem.parsed?.invoiceNumber}.pdf`,
                        previewItem.htmlPreview
                      )
                    }
                    className="pb"
                  >
                    <FileDown size={13} />
                    <span>Lưu PDF</span>
                  </button>
                  <button type="button" onClick={() => setPreviewItem(null)} className="w-7 h-7 rounded-full grid place-items-center hover:bg-[var(--hover)]">
                    <X size={14} />
                  </button>
                </div>
              </div>
              <iframe
                title="iTaxViewer Preview"
                srcDoc={previewItem.htmlPreview}
                className="flex-1 w-full bg-white"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
