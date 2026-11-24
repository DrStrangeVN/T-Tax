import React, { useEffect, useState, useCallback, useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Trash2,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Search,
  ExternalLink,
  FolderOpen,
  Download,
  Eye,
  Link2
} from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"
import { formatDateVi } from "../utils/format.js"

interface VaultProps {
  workspace: WorkspaceDTO
  onOpenTransaction?: (txId: string) => void
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

interface VaultFileRow {
  id: string
  filename: string
  normalizedAsciiName: string
  relativePath: string
  mimetype: string
  sizeBytes: number
  source: string
  isReviewed: boolean
  pairedFileId: string | null
  extractionMethod: string
  createdAt: string
  linkedTransaction?: {
    id: string
    invoiceNumber: string | null
    merchant: string | null
    issuedAt: string | null
  } | null
}

export function VaultPage({ workspace, onOpenTransaction, onRefreshCounts, onToast }: VaultProps) {
  const transport = useTransport()
  const [files, setFiles] = useState<VaultFileRow[]>([])
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | "linked" | "unreviewed" | "orphan">("all")
  const [formatFilter, setFormatFilter] = useState<"all" | "xml" | "pdf" | "image">("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<{ xmlHtml?: string; rawUrl?: string; base64?: string }>({})
  const [confirmState, setConfirmState] = useState<{ id: string; forceUnlink: boolean } | null>(null)

  const listRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    const list = (await transport.listFiles(workspace.id, false)) as unknown as VaultFileRow[]
    setFiles(list)
    setSelectedId((prev) => (prev && list.some((f) => f.id === prev) ? prev : list[0]?.id ?? null))
  }, [workspace.id, transport])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return files.filter((f) => {
      const lowerName = f.filename.toLowerCase()
      const isXml = lowerName.endsWith(".xml") || f.mimetype.includes("xml")
      const isPdf = lowerName.endsWith(".pdf") || f.mimetype === "application/pdf"
      if (formatFilter === "xml" && !isXml) return false
      if (formatFilter === "pdf" && !isPdf) return false
      if (formatFilter === "image" && (isXml || isPdf)) return false

      const isOrphan = !f.linkedTransaction && f.isReviewed && !f.pairedFileId
      if (statusFilter === "linked" && !f.linkedTransaction) return false
      if (statusFilter === "unreviewed" && f.isReviewed) return false
      if (statusFilter === "orphan" && !isOrphan) return false

      if (q) {
        return (
          lowerName.includes(q) ||
          f.relativePath.toLowerCase().includes(q) ||
          f.source.toLowerCase().includes(q) ||
          String(f.linkedTransaction?.invoiceNumber ?? "").toLowerCase().includes(q) ||
          String(f.linkedTransaction?.merchant ?? "").toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [files, search, statusFilter, formatFilter])

  const selectedFile = filtered.find((f) => f.id === selectedId) ?? files.find((f) => f.id === selectedId) ?? null

  useEffect(() => {
    if (!selectedFile) {
      setPreviewData({})
      return
    }
    let active = true
    setConfirmState(null)
    setPreviewData({})
    const lowerName = selectedFile.filename.toLowerCase()
    if (lowerName.endsWith(".xml") || selectedFile.mimetype.includes("xml")) {
      transport
        .renderXmlHtmlPreview(workspace.id, selectedFile.id)
        .then((html) => {
          if (active) setPreviewData({ xmlHtml: html })
        })
        .catch(() => {})
    } else if (transport.getFileRawUrl) {
      setPreviewData({ rawUrl: transport.getFileRawUrl(workspace.id, selectedFile.id) })
    } else {
      transport
        .readFilePreview(workspace.id, selectedFile.id)
        .then((res) => {
          if (active) setPreviewData({ base64: res.base64 })
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [selectedFile, workspace.id, transport])

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 54,
    overscan: 12
  })

  const totalBytes = files.reduce((s, f) => s + Number(f.sizeBytes ?? 0), 0)

  const handleDelete = async (id: string, force = false) => {
    try {
      await transport.deleteFile(workspace.id, id, force ? { force: true } : undefined)
      setConfirmState(null)
      onRefreshCounts()
      onToast(force ? "Đã xóa tệp và gỡ liên kết khỏi giao dịch." : "Đã xóa tệp khỏi Vault.", "ok")
      await load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Không thể xóa tệp"
      if (msg.includes("Xác nhận xóa ép")) {
        setConfirmState({ id, forceUnlink: true })
        onToast(msg, "warn")
      } else {
        setConfirmState(null)
        onToast(msg, "err")
      }
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top Filter Toolbar */}
      <div className="px-4 py-2.5 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--sheet-bg)] shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm tên tệp, số HĐ, MST, nguồn..."
              className="h-[30px] w-[220px] xl:w-[250px] pl-8 pr-3 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none focus:border-[var(--cyan)]"
            />
          </div>

          <div className="seg">
            {[
              { id: "all", label: "Tất cả" },
              { id: "linked", label: "Đã gắn sổ" },
              { id: "unreviewed", label: "Chờ duyệt" },
              { id: "orphan", label: "Mồ côi" }
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                className={statusFilter === s.id ? "on" : ""}
                onClick={() => setStatusFilter(s.id as typeof statusFilter)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="seg">
            {[
              { id: "all", label: "Mọi loại" },
              { id: "xml", label: "XML" },
              { id: "pdf", label: "PDF" },
              { id: "image", label: "Ảnh" }
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                className={formatFilter === t.id ? "on" : ""}
                onClick={() => setFormatFilter(t.id as typeof formatFilter)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[12px] text-[var(--muted)] tnum">
          {filtered.length}/{files.length} tệp · {(totalBytes / 1024 / 1024).toFixed(2)} MB
        </div>
      </div>

      {/* 2-Pane Master-Detail Layout */}
      <div className="flex-1 min-h-0 flex">
        {/* Left Virtualized File List */}
        <div className="w-full lg:w-[48%] xl:w-[46%] border-r border-[var(--line)] flex flex-col min-h-0 bg-[var(--panel)]">
          <div className="px-3.5 py-2 border-b border-[var(--line)] bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] font-semibold flex items-center justify-between shrink-0">
            <span>Tệp chứng từ gốc trong Kho</span>
            <span>Dung lượng / Ngày</span>
          </div>

          {filtered.length === 0 ? (
            <div className="flex-1 grid place-items-center text-[12px] text-[var(--dim)] p-8 text-center">
              Không có tệp chứng từ nào khớp điều kiện lọc.
            </div>
          ) : (
            <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto">
              <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vr) => {
                  const f = filtered[vr.index]!
                  const lowerName = f.filename.toLowerCase()
                  const Icon = lowerName.endsWith(".xml") ? FileCode2 : lowerName.endsWith(".pdf") ? FileText : ImageIcon
                  const active = f.id === selectedFile?.id
                  const isOrphan = !f.linkedTransaction && f.isReviewed && !f.pairedFileId
                  return (
                    <div
                      key={f.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${vr.size}px`,
                        transform: `translateY(${vr.start}px)`
                      }}
                      onClick={() => setSelectedId(f.id)}
                      className={`px-3.5 flex items-center justify-between gap-2 border-b border-[var(--line)] cursor-pointer text-[12px] ${
                        active ? "bg-[var(--cyan-s)]" : "hover:bg-[var(--hover)]"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon size={15} className="text-[var(--cyan)] shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--text)] truncate">{f.filename}</div>
                          <div className="text-[10.5px] text-[var(--muted)] flex items-center gap-1.5 truncate tnum">
                            <span>{f.source}</span>
                            {f.linkedTransaction ? (
                              <span className="text-[var(--green)]">
                                · HĐ {f.linkedTransaction.invoiceNumber || f.linkedTransaction.merchant}
                              </span>
                            ) : isOrphan ? (
                              <span className="text-[var(--amber)]">· Tệp mồ côi</span>
                            ) : !f.isReviewed ? (
                              <span className="text-[var(--cyan)]">· Chờ duyệt</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0 text-[11px] tnum text-[var(--muted)]">
                        <div>{(Number(f.sizeBytes ?? 0) / 1024).toFixed(1)} KB</div>
                        <div className="text-[10px] text-[var(--dim)]">{formatDateVi(f.createdAt)}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right File Inspector & Live Preview */}
        <div className="hidden lg:flex flex-1 min-w-0 flex-col bg-[var(--outer-rail)]">
          {!selectedFile ? (
            <div className="flex-1 grid place-items-center text-[12px] text-[var(--dim)]">
              Chọn một tệp bên trái để xem trước nội dung và liên kết sổ kế toán.
            </div>
          ) : (
            <>
              <div className="px-4 py-2.5 border-b border-[var(--line)] bg-[var(--sheet-bg)] flex items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--text)] truncate">{selectedFile.filename}</div>
                  <div className="text-[10.5px] font-mono text-[var(--dim)] truncate">{selectedFile.relativePath}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {selectedFile.linkedTransaction && onOpenTransaction && (
                    <button
                      type="button"
                      onClick={() => onOpenTransaction(selectedFile.linkedTransaction!.id)}
                      className="gb hl"
                      title="Mở giao dịch trong Sổ giao dịch"
                    >
                      <Link2 size={12.5} />
                      <span>Mở giao dịch</span>
                      <ExternalLink size={11} />
                    </button>
                  )}
                  {transport.isDesktop && transport.revealFileInFolder && (
                    <button
                      type="button"
                      onClick={() => transport.revealFileInFolder!(workspace.id, selectedFile.id)}
                      className="gb"
                      title="Mở vị trí tệp trên máy"
                    >
                      <FolderOpen size={12.5} />
                      <span>Finder</span>
                    </button>
                  )}
                  {transport.getFileRawUrl && (
                    <a
                      href={`${transport.getFileRawUrl(workspace.id, selectedFile.id)}?download=1`}
                      download={selectedFile.filename}
                      className="gb"
                      title="Tải bản gốc"
                    >
                      <Download size={12.5} />
                    </a>
                  )}
                  {confirmState?.id === selectedFile.id ? (
                    <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--rose-s)] border border-[var(--rose)]/40 text-[11px]">
                      <button
                        type="button"
                        onClick={() => handleDelete(selectedFile.id, confirmState.forceUnlink)}
                        className="font-semibold text-[var(--rose)] hover:underline"
                      >
                        {confirmState.forceUnlink ? "Xóa & gỡ sổ" : "Xác nhận xóa"}
                      </button>
                      <button type="button" onClick={() => setConfirmState(null)} className="text-[var(--muted)] ml-1">
                        Hủy
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedFile.id, false)}
                      className="w-8 h-8 rounded-full grid place-items-center border border-[var(--line)] text-[var(--rose)] hover:bg-[var(--rose-s)]"
                      title="Xóa tệp khỏi Kho"
                    >
                      <Trash2 size={13.5} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto p-3">
                {previewData.xmlHtml ? (
                  <iframe
                    title="Vault XML Preview"
                    srcDoc={previewData.xmlHtml}
                    className="w-full h-full min-h-[540px] rounded-[10px] bg-white border border-[var(--line)]"
                  />
                ) : previewData.rawUrl || previewData.base64 ? (
                  selectedFile.filename.toLowerCase().endsWith(".pdf") || selectedFile.mimetype === "application/pdf" ? (
                    <embed
                      src={previewData.rawUrl || previewData.base64}
                      type="application/pdf"
                      className="w-full h-full min-h-[540px] rounded-[10px]"
                    />
                  ) : (
                    <img
                      src={previewData.rawUrl || previewData.base64}
                      alt={selectedFile.filename}
                      className="max-w-full mx-auto rounded-[10px] border border-[var(--line)]"
                    />
                  )
                ) : (
                  <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">
                    <Eye size={18} className="mb-1" /> Đang tải bản xem trước...
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
