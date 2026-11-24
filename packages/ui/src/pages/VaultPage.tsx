import React, { useEffect, useState, useCallback } from "react"
import { Trash2, FileCode2, FileText, Image as ImageIcon } from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"
import { formatDateVi } from "../utils/format.js"

interface VaultProps {
  workspace: WorkspaceDTO
  onRefreshCounts: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

export function VaultPage({ workspace, onRefreshCounts, onToast }: VaultProps) {
  const transport = useTransport()
  const [files, setFiles] = useState<Array<Record<string, unknown>>>([])

  const load = useCallback(async () => {
    const list = await transport.listFiles(workspace.id, false)
    setFiles(list)
  }, [workspace.id, transport])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const totalBytes = files.reduce((s, f) => s + Number(f.sizeBytes ?? 0), 0)

  const handleDelete = async (id: string) => {
    await transport.deleteFile(workspace.id, id)
    onRefreshCounts()
    onToast("Đã xóa tệp khỏi Vault.", "ok")
    load()
  }

  return (
    <div className="p-5 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-[var(--muted)] tnum">
          {files.length} tệp lưu trữ · Tổng dung lượng {(totalBytes / 1024 / 1024).toFixed(2)} MB
        </div>
      </div>

      <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
        <table className="w-full text-left border-collapse text-[12px]">
          <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
            <tr>
              <th className="py-2.5 px-3">Tệp gốc / Đường dẫn ASCII</th>
              <th className="py-2.5 px-3">Nguồn</th>
              <th className="py-2.5 px-3">Trích xuất</th>
              <th className="py-2.5 px-3 text-right">Kích thước</th>
              <th className="py-2.5 px-3">Ngày nạp</th>
              <th className="py-2.5 px-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {files.map((f) => {
              const name = String(f.filename)
              const Icon = name.endsWith(".xml") ? FileCode2 : name.endsWith(".pdf") ? FileText : ImageIcon
              return (
                <tr key={String(f.id)} className="hover:bg-[var(--hover)]">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className="text-[var(--cyan)] shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium truncate max-w-[280px]">{name}</div>
                        <div className="text-[10.5px] font-mono text-[var(--dim)] truncate max-w-[300px]">
                          {String(f.relativePath)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-3"><span className="tag">{String(f.source)}</span></td>
                  <td className="py-2.5 px-3">
                    <span className={`tag ${f.isReviewed ? "tag-ok" : "tag-warn"}`}>
                      {f.isReviewed ? "Đã duyệt" : "Chờ duyệt"} · {String(f.extractionMethod)}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right tnum text-[var(--muted)]">
                    {(Number(f.sizeBytes ?? 0) / 1024).toFixed(1)} KB
                  </td>
                  <td className="py-2.5 px-3 tnum text-[var(--muted)]">{formatDateVi(String(f.createdAt))}</td>
                  <td className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(String(f.id))}
                      className="w-7 h-7 rounded-full inline-grid place-items-center text-[var(--rose)] hover:bg-[var(--rose-s)]"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
