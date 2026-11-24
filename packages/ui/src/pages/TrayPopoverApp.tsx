import React, { useEffect, useState, useCallback } from "react"
import { Upload, ExternalLink, FileCheck2 } from "lucide-react"
import type { UiPreferences, WorkspaceDTO } from "@t-tax/core"
import { useTransport, smartIngestFileList } from "../transport/client.js"

const PREFS_KEY = "ttax:ui-prefs:v1"

function readTrayPrefs(): Partial<UiPreferences> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as Partial<UiPreferences>) : {}
  } catch {
    return {}
  }
}

export function TrayPopoverApp() {
  const transport = useTransport()
  const [tab, setTab] = useState<"drop" | "queue">("drop")
  const [unreviewed, setUnreviewed] = useState<Array<Record<string, unknown>>>([])
  const [activeWs, setActiveWs] = useState<WorkspaceDTO | null>(null)
  const [statusMsg, setStatusMsg] = useState("")
  const [dragging, setDragging] = useState(false)

  const syncThemeFromPrefs = useCallback(() => {
    const prefs = readTrayPrefs()
    if (typeof prefs.isLight === "boolean") {
      document.documentElement.classList.toggle("light", prefs.isLight)
      document.body.classList.toggle("light", prefs.isLight)
    }
  }, [])

  const refresh = useCallback(async () => {
    syncThemeFromPrefs()
    const wss = await transport.listWorkspaces()
    const prefId = readTrayPrefs().activeWorkspaceId
    const ws = (prefId ? wss.find((w) => w.id === prefId) : undefined) ?? wss[0] ?? null
    if (!ws) return
    setActiveWs(ws)
    const files = await transport.listFiles(ws.id, true)
    setUnreviewed(files)
  }, [transport, syncThemeFromPrefs])

  useEffect(() => {
    refresh().catch(() => {})
    const offDrop = transport.onFilesDroppedFromTray?.(() => {
      refresh().catch(() => {})
    })
    const offTheme = transport.onNativeThemeChange?.((info) => {
      const prefs = readTrayPrefs()
      const light = typeof prefs.isLight === "boolean" ? prefs.isLight : !info.shouldUseDarkColors
      document.documentElement.classList.toggle("light", light)
      document.body.classList.toggle("light", light)
    })
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_KEY) refresh().catch(() => {})
    }
    window.addEventListener("storage", onStorage)
    document.body.classList.toggle("platform-macos", transport.platform === "macos")
    return () => {
      offDrop?.()
      offTheme?.()
      window.removeEventListener("storage", onStorage)
    }
  }, [transport, refresh])

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList?.length || !activeWs) return
    const res = await smartIngestFileList(transport, activeWs.id, fileList, "tray")
    setStatusMsg(`Đã nạp ${res.createdFiles.length} chứng từ`)
    refresh()
  }

  return (
    <div
      className="h-[100dvh] w-[364px] p-[12px_13px_11px] flex flex-col gap-2.5 bg-[var(--menu-bg)] text-[var(--text)] select-none"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[13.5px]">T-Tax Quick Drop</span>
            <span className="tag tnum">{unreviewed.length} chờ</span>
          </div>
          {activeWs && (
            <div className="text-[10.5px] text-[var(--muted)] truncate tnum">
              {activeWs.name} · MST {activeWs.taxCode}
            </div>
          )}
        </div>
        <button type="button" onClick={() => transport.windowAction?.("open-main")} className="gb shrink-0">
          <ExternalLink size={12} />
          <span>Mở App</span>
        </button>
      </div>

      <div className="seg w-full">
        <button type="button" className={`flex-1 justify-center ${tab === "drop" ? "on" : ""}`} onClick={() => setTab("drop")}>
          Thả chứng từ
        </button>
        <button type="button" className={`flex-1 justify-center ${tab === "queue" ? "on" : ""}`} onClick={() => setTab("queue")}>
          Hàng đợi ({unreviewed.length})
        </button>
      </div>

      {tab === "drop" ? (
        <label
          className={`flex-1 rounded-[12px] border border-dashed p-4 grid place-items-center text-center cursor-pointer transition-colors ${
            dragging ? "border-[var(--cyan)] bg-[var(--cyan-s)]" : "border-[var(--line2)] bg-[var(--panel)]"
          }`}
        >
          <div>
            <Upload size={22} className="mx-auto text-[var(--cyan)] mb-2" />
            <div className="text-[12.5px] font-semibold">Thả XML / PDF / ZIP vào đây</div>
            <div className="text-[11px] text-[var(--muted)] mt-0.5">Tự động ghép cặp & đẩy vào Hộp thư AI</div>
            {statusMsg && <div className="mt-2 tag tag-ok">{statusMsg}</div>}
          </div>
          <input
            type="file"
            multiple
            accept=".xml,.pdf,.zip,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files)
              e.target.value = ""
            }}
          />
        </label>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-1.5 pr-0.5">
          {unreviewed.length === 0 ? (
            <div className="h-full grid place-items-center text-[11.5px] text-[var(--dim)]">Không có chứng từ tồn đọng.</div>
          ) : (
            unreviewed.map((f) => (
              <div key={String(f.id)} className="px-3 py-2 rounded-[10px] bg-[var(--panel)] border border-[var(--line)] flex items-center gap-2">
                <FileCheck2 size={14} className="text-[var(--cyan)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium truncate">{String(f.filename)}</div>
                  <div className="text-[10.5px] text-[var(--dim)]">{String(f.extractionMethod)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
