import React, { useEffect, useRef, useState, useCallback } from "react"
import type { GlassIntensity, WorkspaceDTO } from "@t-tax/core"
import { useTransport, fileToPayload } from "./transport/client.js"
import { LiquidShell, type NavPage } from "./components/LiquidShell.js"
import { CommandPalette } from "./components/CommandPalette.js"
import { DashboardPage } from "./pages/DashboardPage.js"
import { UnsortedPage } from "./pages/UnsortedPage.js"
import { TransactionsPage } from "./pages/TransactionsPage.js"
import { BatchConverterPage } from "./pages/BatchConverterPage.js"
import { AccountingPage } from "./pages/AccountingPage.js"
import { CounterpartiesPage } from "./pages/CounterpartiesPage.js"
import { MiniAppsPage } from "./pages/MiniAppsPage.js"
import { VaultPage } from "./pages/VaultPage.js"
import { SettingsPage } from "./pages/SettingsPage.js"

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

export function TTaxApp() {
  const transport = useTransport()
  const [workspaces, setWorkspaces] = useState<WorkspaceDTO[]>([])
  const [activeWsId, setActiveWsId] = useState<string>("")
  const [activePage, setActivePage] = useState<NavPage>("dashboard")
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [complianceWarnings, setComplianceWarnings] = useState(0)

  const [isLight, setIsLight] = useState(false)
  const [glassIntensity, setGlassIntensity] = useState<GlassIntensity>("balanced")
  const [reduceTransparency, setReduceTransparency] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "warn" | "err" } | null>(null)
  const quickFileInputRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((msg: string, tone: "ok" | "warn" | "err" = "ok") => {
    setToast({ msg, tone })
    setTimeout(() => setToast((curr) => (curr?.msg === msg ? null : curr)), 3600)
  }, [])

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
      const stats = (await transport.getDashboardStats(activeWorkspace.id)) as {
        unreviewedCount?: number
        complianceWarnings?: number
      }
      setUnreviewedCount(stats.unreviewedCount ?? 0)
      setComplianceWarnings(stats.complianceWarnings ?? 0)
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

  // Sync body classes for Liquid Glass theme, intensity, accessibility, platform & collapsed rail
  useEffect(() => {
    const b = document.body
    const root = document.documentElement
    root.classList.toggle("light", isLight)
    b.classList.toggle("light", isLight)
    b.classList.toggle("glass-clear", glassIntensity === "clear")
    b.classList.toggle("glass-solid", glassIntensity === "solid")
    b.classList.toggle("reduce-transparency", reduceTransparency)
    b.classList.toggle("sb-off", sidebarCollapsed)
    b.classList.toggle("mobile-nav-open", mobileNavOpen)
    b.classList.toggle("platform-macos", transport.platform === "macos")
    b.classList.toggle("desktop-vibrancy", transport.isDesktop && transport.platform === "macos")
    b.classList.toggle("web-mode", !transport.isDesktop)
    transport.setThemeSource?.(isLight ? "light" : "dark")
  }, [isLight, glassIntensity, reduceTransparency, sidebarCollapsed, mobileNavOpen, transport])

  useEffect(() => {
    const offTheme = transport.onNativeThemeChange?.((info) => {
      setReduceTransparency(info.reduceTransparency)
    })
    const offDrop = transport.onFilesDroppedFromTray?.(() => {
      refreshCounts()
      setActivePage("unsorted")
    })
    return () => {
      offTheme?.()
      offDrop?.()
    }
  }, [transport, refreshCounts])

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
        setSidebarCollapsed((v) => !v)
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
    const payloads = await Promise.all(Array.from(fileList).map(fileToPayload))
    const res = await transport.ingestFiles(activeWorkspace.id, payloads, "upload")
    refreshCounts()
    setActivePage("unsorted")
    showToast(`Đã nạp ${res.createdFiles.length} chứng từ vào Hộp thư AI.`, "ok")
  }

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
        onNavigate={setActivePage}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onSwitchWorkspace={setActiveWsId}
        unreviewedCount={unreviewedCount}
        complianceWarnings={complianceWarnings}
        isLight={isLight}
        onToggleTheme={() => setIsLight((v) => !v)}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onOpenCommandPalette={() => setCmdOpen(true)}
        onQuickUploadClick={() => quickFileInputRef.current?.click()}
        mobileNavOpen={mobileNavOpen}
        setMobileNavOpen={setMobileNavOpen}
      >
        {activePage === "dashboard" && (
          <DashboardPage workspace={activeWorkspace} onNavigate={setActivePage} onRefreshCounts={refreshCounts} onToast={showToast} />
        )}
        {activePage === "unsorted" && (
          <UnsortedPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
        )}
        {activePage === "transactions" && (
          <TransactionsPage workspace={activeWorkspace} onToast={showToast} />
        )}
        {activePage === "converter" && (
          <BatchConverterPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
        )}
        {activePage === "accounting" && (
          <AccountingPage workspace={activeWorkspace} onToast={showToast} />
        )}
        {activePage === "counterparties" && (
          <CounterpartiesPage workspace={activeWorkspace} onToast={showToast} />
        )}
        {activePage === "apps" && (
          <MiniAppsPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
        )}
        {activePage === "vault" && (
          <VaultPage workspace={activeWorkspace} onRefreshCounts={refreshCounts} onToast={showToast} />
        )}
        {activePage === "settings" && (
          <SettingsPage
            workspace={activeWorkspace}
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
      </LiquidShell>

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigate={setActivePage}
        onToggleTheme={() => setIsLight((v) => !v)}
        onQuickExport={async (kind) => {
          const res = await transport.exportReport(activeWorkspace.id, kind)
          if (!res.canceled) showToast(`Đã xuất tệp: ${res.savedPath}`, "ok")
        }}
        isLight={isLight}
      />

      {toast && (
        <div
          className="fixed bottom-5 right-5 z-[150] px-4 py-2 rounded-full glass-overlay text-[12.5px] font-medium flex items-center gap-2"
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
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor:
                toast.tone === "ok"
                  ? "var(--green)"
                  : toast.tone === "warn"
                    ? "var(--amber)"
                    : "var(--rose)"
            }}
          />
          <span>{toast.msg}</span>
        </div>
      )}
    </>
  )
}
