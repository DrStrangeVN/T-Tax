import React, { Suspense, lazy, useEffect, useRef, useState, useCallback } from "react"
import { Upload } from "lucide-react"
import type { GlassIntensity, SidebarMode, UiPreferences, WorkspaceDTO } from "@t-tax/core"
import { useTransport, smartIngestFileList } from "./transport/client.js"
import { LiquidShell, type NavPage } from "./components/LiquidShell.js"
import { CommandPalette } from "./components/CommandPalette.js"
import { DashboardPage } from "./pages/DashboardPage.js"
import { UnsortedPage } from "./pages/UnsortedPage.js"
import { TransactionsPage } from "./pages/TransactionsPage.js"

const BatchConverterPage = lazy(() => import("./pages/BatchConverterPage.js").then((m) => ({ default: m.BatchConverterPage })))
const AccountingPage = lazy(() => import("./pages/AccountingPage.js").then((m) => ({ default: m.AccountingPage })))
const CounterpartiesPage = lazy(() => import("./pages/CounterpartiesPage.js").then((m) => ({ default: m.CounterpartiesPage })))
const MiniAppsPage = lazy(() => import("./pages/MiniAppsPage.js").then((m) => ({ default: m.MiniAppsPage })))
const VaultPage = lazy(() => import("./pages/VaultPage.js").then((m) => ({ default: m.VaultPage })))
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })))

const NAV_ORDER: NavPage[] = [
  "dashboard",
  "unsorted",
  "transactions",
  "converter",
  "accounting",
  "counterparties",
  "apps",
  "vault",
  "settings"
]

const PREFS_KEY = "ttax:ui-prefs:v1"

function loadUiPrefs(): UiPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { isLight: false, glassIntensity: "balanced", sidebarMode: "expanded" }
    const p = JSON.parse(raw) as Partial<UiPreferences>
    return {
      isLight: Boolean(p.isLight),
      glassIntensity: p.glassIntensity === "clear" || p.glassIntensity === "solid" ? p.glassIntensity : "balanced",
      sidebarMode: p.sidebarMode === "rail" || p.sidebarMode === "collapsed" ? p.sidebarMode : "expanded",
      activeWorkspaceId: typeof p.activeWorkspaceId === "string" ? p.activeWorkspaceId : undefined,
      visibleCols: Array.isArray(p.visibleCols) ? p.visibleCols : undefined,
      unsortedSplitPct: typeof p.unsortedSplitPct === "number" ? p.unsortedSplitPct : undefined,
      hkdSector: p.hkdSector
    }
  } catch {
    return { isLight: false, glassIntensity: "balanced", sidebarMode: "expanded" }
  }
}

export function TTaxApp() {
  const transport = useTransport()
  const initialPrefs = useRef(loadUiPrefs()).current

  const [workspaces, setWorkspaces] = useState<WorkspaceDTO[]>([])
  const [activeWsId, setActiveWsId] = useState<string>(initialPrefs.activeWorkspaceId ?? "")
  const [activePage, setActivePage] = useState<NavPage>("dashboard")
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [complianceWarnings, setComplianceWarnings] = useState(0)
  const [unmatchedBankCount, setUnmatchedBankCount] = useState(0)

  const [isLight, setIsLight] = useState(initialPrefs.isLight)
  const [glassIntensity, setGlassIntensity] = useState<GlassIntensity>(initialPrefs.glassIntensity)
  const [reduceTransparency, setReduceTransparency] = useState(false)
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialPrefs.sidebarMode)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [globalDragOver, setGlobalDragOver] = useState(false)
  const [toast, setToast] = useState<{
    id: number
    msg: string
    tone: "ok" | "warn" | "err"
    undo?: { label: string; onClick: () => void | Promise<void> }
  } | null>(null)

  const [txCompliancePreset, setTxCompliancePreset] = useState<string>("")
  const [focusTxId, setFocusTxId] = useState<string | null>(null)
  const [openNewWsSignal, setOpenNewWsSignal] = useState(0)

  const quickFileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const userPinnedSidebarRef = useRef(false)
  const autoRailAppliedRef = useRef(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback(
    (msg: string, tone: "ok" | "warn" | "err" = "ok", undo?: { label: string; onClick: () => void | Promise<void> }) => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      const id = Date.now()
      setToast({ id, msg, tone, undo })
      toastTimerRef.current = setTimeout(
        () => setToast((curr) => (curr?.id === id ? null : curr)),
        undo ? 6500 : 3600
      )
    },
    []
  )

  const savePrefsPatch = useCallback((patch: Partial<UiPreferences>) => {
    try {
      const curr = loadUiPrefs()
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...curr, ...patch }))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    savePrefsPatch({ isLight, glassIntensity, sidebarMode, activeWorkspaceId: activeWsId || undefined })
  }, [isLight, glassIntensity, sidebarMode, activeWsId, savePrefsPatch])

  useEffect(() => {
    if (activeWsId) {
      transport.setActiveWorkspace?.(activeWsId).catch(() => {})
    }
  }, [activeWsId, transport])

  // Auto Focus Rail (< 1440px) when opening multi-pane invoice/XML workbenches
  useEffect(() => {
    if (userPinnedSidebarRef.current || sidebarMode === "collapsed") return
    const isDenseWorkbench = activePage === "unsorted" || activePage === "converter"
    if (isDenseWorkbench && window.innerWidth < 1440 && sidebarMode === "expanded") {
      autoRailAppliedRef.current = true
      setSidebarMode("rail")
    } else if (!isDenseWorkbench && autoRailAppliedRef.current) {
      autoRailAppliedRef.current = false
      setSidebarMode("expanded")
    }
  }, [activePage, sidebarMode])

  const loadWorkspaces = useCallback(async () => {
    const list = await transport.listWorkspaces()
    setWorkspaces(list)
    if (list.length > 0 && (!activeWsId || !list.some((w) => w.id === activeWsId))) {
      setActiveWsId(list[0]!.id)
    }
  }, [transport, activeWsId])

  const activeWorkspace = workspaces.find((w) => w.id === activeWsId) ?? workspaces[0]

  const refreshCounts = useCallback(async () => {
    if (!activeWorkspace) return
    try {
      const counts = await transport.getSidebarBadgeCounts(activeWorkspace.id)
      setUnreviewedCount(counts.unreviewedCount ?? 0)
      setComplianceWarnings(counts.complianceWarnings ?? 0)
      setUnmatchedBankCount(counts.unmatchedBankCount ?? 0)
    } catch {
      // ignore
    }
  }, [activeWorkspace, transport])

  useEffect(() => {
    loadWorkspaces().catch(() => {})
  }, [loadWorkspaces])

  useEffect(() => {
    refreshCounts()
  }, [refreshCounts])

  // Sync body & html classes for Liquid Glass theme, intensity, accessibility & sidebar rail/collapsed
  useEffect(() => {
    const b = document.body
    const root = document.documentElement
    root.classList.toggle("light", isLight)
    b.classList.toggle("light", isLight)
    b.classList.toggle("glass-clear", glassIntensity === "clear")
    b.classList.toggle("glass-solid", glassIntensity === "solid")
    b.classList.toggle("reduce-transparency", reduceTransparency)
    b.classList.toggle("sb-rail", sidebarMode === "rail")
    b.classList.toggle("sb-off", sidebarMode === "collapsed")
    b.classList.toggle("mobile-nav-open", mobileNavOpen)
    b.classList.toggle("platform-macos", transport.platform === "macos")
    b.classList.toggle("desktop-vibrancy", transport.isDesktop && transport.platform === "macos")
    b.classList.toggle("web-mode", !transport.isDesktop)
    transport.setThemeSource?.(isLight ? "light" : "dark")
  }, [isLight, glassIntensity, reduceTransparency, sidebarMode, mobileNavOpen, transport])

  useEffect(() => {
    const offTheme = transport.onNativeThemeChange?.((info) => {
      setReduceTransparency(info.reduceTransparency)
    })
    const offDrop = transport.onFilesDroppedFromTray?.(() => {
      refreshCounts()
      setActivePage("unsorted")
    })
    const offMenu = transport.onMenuCommand?.(async (cmd) => {
      if (cmd === "open-upload") quickFileInputRef.current?.click()
      else if (cmd === "toggle-sidebar") {
        setSidebarMode((prev) => (prev === "collapsed" ? "expanded" : "collapsed"))
      } else if (cmd === "export-htkk" && activeWorkspace) {
        const res = await transport.exportReport(activeWorkspace.id, "htkk_in")
        if (!res.canceled) showToast(`Đã xuất tệp: ${res.savedPath}`, "ok")
      }
    })
    return () => {
      offTheme?.()
      offDrop?.()
      offMenu?.()
    }
  }, [transport, refreshCounts, activeWorkspace, showToast])

  // Global keyboard shortcuts (⌘K, ⌘\, ⌘1..9)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === "k") {
        e.preventDefault()
        setCmdOpen((v) => !v)
      } else if (e.key === "\\") {
        e.preventDefault()
        setSidebarMode((prev) => (prev === "collapsed" ? "expanded" : "collapsed"))
      } else if (/^[1-9]$/.test(k)) {
        const idx = Number(k) - 1
        const target = NAV_ORDER[idx]
        if (target) {
          e.preventDefault()
          setActivePage(target)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const handleQuickUploadFiles = async (fileList: FileList | null) => {
    if (!fileList?.length || !activeWorkspace) return
    const res = await smartIngestFileList(transport, activeWorkspace.id, fileList, "upload")
    refreshCounts()
    setActivePage("unsorted")
    showToast(
      `Đã nạp ${res.createdFiles.length} chứng từ.${res.skippedDuplicates.length ? ` Bỏ qua ${res.skippedDuplicates.length} tệp trùng.` : ""}`,
      "ok"
    )
  }

  // Global drag-drop across the entire window
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault()
        dragDepthRef.current++
        setGlobalDragOver(true)
      }
    }
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault()
    }
    const onDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setGlobalDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      dragDepthRef.current = 0
      setGlobalDragOver(false)
      if (!e.dataTransfer?.files?.length) return
      // Pages with explicit drop handlers (Unsorted, BatchConverter) call stopPropagation
      if (e.defaultPrevented) return
      e.preventDefault()
      handleQuickUploadFiles(e.dataTransfer.files)
    }
    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragenter", onDragEnter)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("dragleave", onDragLeave)
      window.removeEventListener("drop", onDrop)
    }
  })

  if (!activeWorkspace) {
    return (
      <div className="h-[100dvh] grid place-items-center bg-[#0C0E14] text-[#F3F5F9] text-[13px]">
        Đang khởi tạo không gian kế toán T-Tax...
      </div>
    )
  }

  return (
    <>
      <input
        ref={quickFileInputRef}
        type="file"
        multiple
        accept=".xml,.pdf,.zip,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          handleQuickUploadFiles(e.target.files)
          e.target.value = ""
        }}
      />

      <LiquidShell
        activePage={activePage}
        onNavigate={(p) => {
          if (p !== "transactions") {
            setTxCompliancePreset("")
            setFocusTxId(null)
          }
          setActivePage(p)
        }}
        onOpenComplianceAlerts={() => {
          setTxCompliancePreset("warning_or_error")
          setFocusTxId(null)
          setActivePage("transactions")
        }}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onSwitchWorkspace={setActiveWsId}
        onCreateWorkspaceRequest={() => {
          setOpenNewWsSignal((n) => n + 1)
          setActivePage("settings")
        }}
        unreviewedCount={unreviewedCount}
        complianceWarnings={complianceWarnings}
        unmatchedBankCount={unmatchedBankCount}
        isLight={isLight}
        onToggleTheme={() => setIsLight((v) => !v)}
        sidebarMode={sidebarMode}
        onChangeSidebarMode={(mode) => {
          userPinnedSidebarRef.current = true
          autoRailAppliedRef.current = false
          setSidebarMode(mode)
        }}
        onOpenCommandPalette={() => setCmdOpen(true)}
        onQuickUploadClick={() => quickFileInputRef.current?.click()}
        mobileNavOpen={mobileNavOpen}
        setMobileNavOpen={setMobileNavOpen}
      >
        <Suspense
          fallback={
            <div className="h-full grid place-items-center text-[12px] text-[var(--dim)]">Đang tải phân hệ...</div>
          }
        >
          {activePage === "dashboard" && (
            <DashboardPage
              workspace={activeWorkspace}
              onNavigate={setActivePage}
              onOpenTransaction={(id) => {
                setFocusTxId(id)
                setActivePage("transactions")
              }}
              onRefreshCounts={refreshCounts}
              onToast={showToast}
            />
          )}
          {activePage === "unsorted" && (
            <UnsortedPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
          )}
          {activePage === "transactions" && (
            <TransactionsPage
              workspace={activeWorkspace}
              initialComplianceFilter={txCompliancePreset}
              initialFocusTxId={focusTxId}
              onClearPreset={() => {
                setTxCompliancePreset("")
                setFocusTxId(null)
              }}
              onRefreshCounts={refreshCounts}
              onToast={showToast}
            />
          )}
          {activePage === "converter" && (
            <BatchConverterPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
          )}
          {activePage === "accounting" && (
            <AccountingPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
          )}
          {activePage === "counterparties" && <CounterpartiesPage workspace={activeWorkspace} onToast={showToast} />}
          {activePage === "apps" && (
            <MiniAppsPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
          )}
          {activePage === "vault" && (
            <VaultPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
          )}
          {activePage === "settings" && (
            <SettingsPage
              workspace={activeWorkspace}
              openNewWsSignal={openNewWsSignal}
              onWorkspaceUpdated={loadWorkspaces}
              isLight={isLight}
              setIsLight={setIsLight}
              glassIntensity={glassIntensity}
              setGlassIntensity={setGlassIntensity}
              reduceTransparency={reduceTransparency}
              setReduceTransparency={setReduceTransparency}
              onToast={showToast}
            />
          )}
        </Suspense>
      </LiquidShell>

      {globalDragOver && activePage !== "unsorted" && activePage !== "converter" && (
        <div className="fixed inset-0 z-[140] pointer-events-none bg-black/45 grid place-items-center p-6">
          <div className="glass-overlay rounded-[18px] px-10 py-8 text-center border-2 border-dashed border-[var(--cyan)]">
            <Upload size={28} className="mx-auto text-[var(--cyan)] mb-2" />
            <div className="text-[15px] font-bold text-[var(--text)]">Thả chứng từ XML, PDF, ZIP hoặc ảnh vào đây</div>
            <div className="text-[12px] text-[var(--muted)] mt-1">Tự động ghép cặp XML ↔ PDF và đẩy vào Hộp thư AI</div>
          </div>
        </div>
      )}

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigate={setActivePage}
        onOpenTransaction={(id) => {
          setFocusTxId(id)
          setActivePage("transactions")
        }}
        workspaceId={activeWorkspace.id}
        workspaces={workspaces}
        onSwitchWorkspace={setActiveWsId}
        onToggleTheme={() => setIsLight((v) => !v)}
        onQuickExport={async (kind) => {
          const res = await transport.exportReport(activeWorkspace.id, kind)
          if (!res.canceled) showToast(`Đã xuất tệp: ${res.savedPath}`, "ok")
        }}
        isLight={isLight}
      />

      {toast && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[150] px-4 py-2 rounded-full glass-overlay text-[12.5px] font-medium flex items-center gap-2.5 shadow-lg"
          style={{
            borderColor:
              toast.tone === "ok"
                ? "var(--green)"
                : toast.tone === "warn"
                  ? "var(--amber)"
                  : "var(--rose)"
          }}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor:
                toast.tone === "ok"
                  ? "var(--green)"
                  : toast.tone === "warn"
                    ? "var(--amber)"
                    : "var(--rose)"
            }}
          />
          <span className="cursor-pointer" onClick={() => setToast(null)}>
            {toast.msg}
          </span>
          {toast.undo && (
            <button
              type="button"
              onClick={async () => {
                const action = toast.undo
                setToast(null)
                await action?.onClick()
              }}
              className="ml-1 px-2.5 py-0.5 rounded-full bg-[var(--cyan-s)] text-[var(--cyan)] text-[11.5px] font-semibold hover:brightness-110"
            >
              {toast.undo.label}
            </button>
          )}
        </div>
      )}
    </>
  )
}
