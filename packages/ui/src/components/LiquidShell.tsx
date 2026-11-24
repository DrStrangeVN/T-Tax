import React, { useEffect, useRef, useState } from "react"
import {
  LayoutDashboard,
  Inbox,
  ReceiptText,
  FileCode2,
  BookOpenCheck,
  Building2,
  Blocks,
  FolderArchive,
  Settings,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  PanelLeft,
  Plus,
  Sun,
  Moon,
  Menu,
  Minus,
  Square,
  X,
  ChevronsUpDown,
  Check
} from "lucide-react"
import type { SidebarMode, WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"

export type NavPage =
  | "dashboard"
  | "unsorted"
  | "transactions"
  | "converter"
  | "accounting"
  | "counterparties"
  | "apps"
  | "vault"
  | "settings"

interface LiquidShellProps {
  activePage: NavPage
  onNavigate: (page: NavPage) => void
  onOpenComplianceAlerts: () => void
  workspaces: WorkspaceDTO[]
  activeWorkspace: WorkspaceDTO
  onSwitchWorkspace: (id: string) => void
  onCreateWorkspaceRequest: () => void
  unreviewedCount: number
  complianceWarnings: number
  isLight: boolean
  onToggleTheme: () => void
  sidebarMode: SidebarMode
  onChangeSidebarMode: (mode: SidebarMode) => void
  onOpenCommandPalette: () => void
  onQuickUploadClick: () => void
  mobileNavOpen: boolean
  setMobileNavOpen: (v: boolean) => void
  children: React.ReactNode
}

const NAV_ITEMS: Array<{ id: NavPage; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }> = [
  { id: "dashboard", label: "Tổng quan", icon: LayoutDashboard },
  { id: "unsorted", label: "Hộp thư AI", icon: Inbox },
  { id: "transactions", label: "Sổ giao dịch", icon: ReceiptText },
  { id: "converter", label: "Quét & XML", icon: FileCode2 },
  { id: "accounting", label: "Kế toán VAS", icon: BookOpenCheck },
  { id: "counterparties", label: "Đối tác MST", icon: Building2 },
  { id: "apps", label: "Tiện ích", icon: Blocks },
  { id: "vault", label: "Kho chứng từ", icon: FolderArchive },
  { id: "settings", label: "Cài đặt", icon: Settings }
]

const PAGE_TITLES: Record<NavPage, { title: string; subtitle: string }> = {
  dashboard: { title: "Tổng quan tài chính & Thuế", subtitle: "Doanh thu, chi phí, VAT & cảnh báo tuân thủ" },
  unsorted: { title: "Hộp thư Chứng từ", subtitle: "Kéo thả XML, PDF, ZIP hoặc ảnh hóa đơn — duyệt ⌘↵" },
  transactions: { title: "Sổ Giao dịch & Hóa đơn", subtitle: "Bảng kê ảo hóa, lọc kỳ & hạch toán hàng loạt" },
  converter: { title: "Chuyển đổi & Kiểm toán XML", subtitle: "Parse QĐ 1450/1510, XMLDSig, iTaxViewer PDF & HTKK/MISA" },
  accounting: { title: "Kế toán & Đối chiếu Sao kê", subtitle: "Bút toán Nợ/Có, bảng kê GTGT, sổ HKD & khớp ngân hàng" },
  counterparties: { title: "Đối tác & Rủi ro MST", subtitle: "Trạng thái hoạt động mã số thuế người bán / mua" },
  apps: { title: "Ứng dụng Mở rộng", subtitle: "Email IMAP, Hóa đơn VietQR, Cổng HĐĐT & Nhập Excel" },
  vault: { title: "Kho Chứng từ gốc", subtitle: "Lưu trữ bất biến theo tháng, ghép cặp XML ↔ PDF & SHA-256" },
  settings: { title: "Cài đặt Hệ thống", subtitle: "Đa MST, TT99/TT200/TT133/HKD, AI Prompt & Liquid Glass" }
}

export function LiquidShell({
  activePage,
  onNavigate,
  onOpenComplianceAlerts,
  workspaces,
  activeWorkspace,
  onSwitchWorkspace,
  onCreateWorkspaceRequest,
  unreviewedCount,
  complianceWarnings,
  isLight,
  onToggleTheme,
  sidebarMode,
  onChangeSidebarMode,
  onOpenCommandPalette,
  onQuickUploadClick,
  mobileNavOpen,
  setMobileNavOpen,
  children
}: LiquidShellProps) {
  const transport = useTransport()
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  const wsMenuRef = useRef<HTMLDivElement>(null)
  const meta = PAGE_TITLES[activePage]
  const activeNav = NAV_ITEMS.find((n) => n.id === activePage)
  const HeroIcon = activeNav?.icon ?? LayoutDashboard
  const isRail = sidebarMode === "rail"

  const slaRatio = Math.max(0, Math.min(100, 100 - complianceWarnings * 5))

  useEffect(() => {
    if (!wsMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false)
      }
    }
    window.addEventListener("mousedown", onDocClick)
    return () => window.removeEventListener("mousedown", onDocClick)
  }, [wsMenuOpen])

  const cycleRailOrExpanded = () => {
    onChangeSidebarMode(isRail ? "expanded" : "rail")
  }

  return (
    <>
      <div className="lg-wallpaper" />
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-[130] bg-black/45 backdrop-blur-sm md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <div className="ttax-shell">
        <aside className="side">
          {/* Brand Row */}
          <div className={`flex items-center gap-2 pb-2.5 ${isRail ? "flex-col px-0" : "px-1.5"}`}>
            <div className="w-7 h-7 rounded-[8.5px] grid place-items-center bg-[#161A24] border border-white/20 text-white shrink-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16" />
                <path d="M12 6v13" />
                <path d="M5 13h4" />
                <path d="M15 13h4" />
              </svg>
            </div>
            {!isRail && (
              <>
                <span className="font-bold text-[14px] tracking-tight text-[var(--text)]">T-Tax</span>
                <span className="tag">0.1</span>
              </>
            )}
            <button
              type="button"
              onClick={cycleRailOrExpanded}
              title={isRail ? "Mở rộng thanh bên" : "Thu gọn thành dải biểu tượng (⌘\\ ẩn hẳn)"}
              className={`${isRail ? "" : "ml-auto"} w-7 h-7 rounded-[7px] grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]`}
            >
              {isRail ? <PanelLeftOpen size={15} strokeWidth={1.8} /> : <PanelLeftClose size={15} strokeWidth={1.8} />}
            </button>
          </div>

          {/* Workspace Switcher Popover */}
          {!isRail && (
            <div ref={wsMenuRef} className="relative px-1 pb-2">
              <button
                type="button"
                aria-label="Chọn Công ty / MST"
                onClick={() => setWsMenuOpen((v) => !v)}
                className="w-full px-2.5 py-1.5 rounded-[10px] bg-[var(--raised)] border border-[var(--line)] hover:border-[var(--line2)] flex items-center gap-2 text-left transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-[var(--text)] truncate">{activeWorkspace.name}</div>
                  <div className="text-[10.5px] text-[var(--muted)] tnum truncate">
                    MST {activeWorkspace.taxCode} · {activeWorkspace.accountingRegime.replace("_", " ")}
                  </div>
                </div>
                <ChevronsUpDown size={13.5} className="text-[var(--dim)] shrink-0" />
              </button>

              {wsMenuOpen && (
                <div className="menu absolute left-1 right-1 top-full mt-1 space-y-0.5">
                  {workspaces.map((ws) => {
                    const selected = ws.id === activeWorkspace.id
                    return (
                      <button
                        key={ws.id}
                        type="button"
                        onClick={() => {
                          onSwitchWorkspace(ws.id)
                          setWsMenuOpen(false)
                        }}
                        className={`w-full px-2.5 py-1.5 rounded-[8px] flex items-center gap-2 text-left hover:bg-[var(--sel)] ${
                          selected ? "bg-[var(--sel)]" : ""
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium text-[var(--text)] truncate">{ws.name}</div>
                          <div className="text-[10px] text-[var(--dim)] tnum">
                            MST {ws.taxCode} · {ws.accountingRegime.replace("_", " ")}
                          </div>
                        </div>
                        {selected && <Check size={13} className="text-[var(--cyan)] shrink-0" />}
                      </button>
                    )
                  })}
                  <div className="border-t border-[var(--line)] pt-1 mt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setWsMenuOpen(false)
                        onCreateWorkspaceRequest()
                      }}
                      className="w-full px-2.5 py-1.5 rounded-[8px] flex items-center gap-2 text-[12px] text-[var(--cyan)] hover:bg-[var(--sel)]"
                    >
                      <Plus size={13} />
                      <span>Thêm Công ty / MST mới</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isRail && (
            <div className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--dim)] px-2.5 pt-1.5 pb-1">
              Nghiệp vụ
            </div>
          )}

          <nav className={`flex flex-col gap-0.5 ${isRail ? "w-full items-center" : ""}`}>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isOn = activePage === item.id
              const badge =
                item.id === "unsorted" && unreviewedCount > 0
                  ? unreviewedCount
                  : item.id === "accounting" && complianceWarnings > 0
                    ? complianceWarnings
                    : null
              return (
                <button
                  key={item.id}
                  type="button"
                  data-nav={item.id}
                  title={item.label}
                  onClick={() => {
                    onNavigate(item.id)
                    setMobileNavOpen(false)
                  }}
                  className={`relative h-8 rounded-[9px] flex items-center transition-colors ${
                    isRail ? "w-10 justify-center px-0" : "px-2.5 gap-2.5 w-full text-[12.5px]"
                  } ${
                    isOn
                      ? "bg-[var(--sel)] text-[var(--text)] font-semibold shadow-[var(--specular-subtle)]"
                      : "text-[var(--muted)] font-medium hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  }`}
                >
                  <Icon size={15} strokeWidth={1.8} />
                  {!isRail && <span className="truncate">{item.label}</span>}
                  {badge !== null && !isRail && (
                    <span
                      className={`ml-auto text-[10.5px] px-1.5 py-0.2 rounded-full tnum ${
                        isOn
                          ? "text-[var(--cyan)] bg-[var(--cyan-s)]"
                          : item.id === "accounting"
                            ? "text-[var(--amber)] bg-[var(--amber-s)]"
                            : "text-[var(--muted)] bg-[var(--hover)]"
                      }`}
                    >
                      {badge}
                    </span>
                  )}
                  {badge !== null && isRail && (
                    <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[var(--cyan)]" />
                  )}
                </button>
              )
            })}
          </nav>

          {/* Interactive Footer Compliance Ring */}
          <button
            type="button"
            onClick={onOpenComplianceAlerts}
            title="Xem danh sách chứng từ có cảnh báo tuân thủ"
            className={`mt-auto pt-3 border-t border-[var(--line)] flex items-center text-left hover:bg-[var(--hover)] rounded-[9px] transition-colors ${
              isRail ? "justify-center p-1.5 w-full" : "px-2 pb-1.5 gap-2.5 w-full"
            }`}
          >
            <svg width="30" height="30" viewBox="0 0 36 36" className="shrink-0">
              <circle cx="18" cy="18" r="14" fill="none" stroke="var(--track)" strokeWidth="3.2" />
              <circle
                cx="18"
                cy="18"
                r="14"
                fill="none"
                stroke={complianceWarnings > 0 ? "var(--amber)" : "var(--green)"}
                strokeWidth="3.2"
                strokeDasharray={`${(slaRatio / 100) * 88} 88`}
                strokeLinecap="round"
                transform="rotate(-90 18 18)"
              />
            </svg>
            {!isRail && (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[12px] font-semibold text-[var(--text)] tnum">{slaRatio}% Tuân thủ</div>
                <div className="text-[10.5px] text-[var(--muted)] truncate">
                  {complianceWarnings > 0 ? `${complianceWarnings} cảnh báo cần xem` : activeWorkspace.accountingRegime.replace("_", " ")}
                </div>
              </div>
            )}
          </button>
        </aside>

        {/* Matte Inset Sheet */}
        <div className="inset-sheet-wrap">
          <div className="inset-sheet">
            <header className="top">
              <div className="flex items-center gap-2.5 min-w-0 flex-1 no-drag">
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(!mobileNavOpen)}
                  className="md:hidden w-7 h-7 rounded-[8px] grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)]"
                  aria-label="Menu"
                >
                  <Menu size={16} strokeWidth={1.8} />
                </button>

                {sidebarMode === "collapsed" && (
                  <button
                    type="button"
                    onClick={() => onChangeSidebarMode("expanded")}
                    title="Hiện thanh bên (⌘\)"
                    className="hidden md:grid w-7 h-7 rounded-[8px] place-items-center text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <PanelLeft size={16} strokeWidth={1.8} />
                  </button>
                )}

                <div className="hidden sm:grid w-7 h-7 rounded-[8px] place-items-center bg-[var(--panel)] border border-[var(--line2)] shadow-[var(--specular-subtle)] shrink-0 text-[var(--cyan)]">
                  <HeroIcon size={14} strokeWidth={1.8} />
                </div>

                <div className="min-w-0 flex items-center gap-2">
                  <h1 className="text-[15px] sm:text-[16px] font-bold tracking-tight text-[var(--text)] truncate">
                    {meta.title}
                  </h1>
                  <span className="hidden lg:inline-flex tag tnum">MST {activeWorkspace.taxCode}</span>
                  <span className="hidden xl:inline text-[11.5px] text-[var(--dim)] truncate">· {meta.subtitle}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 no-drag">
                <button
                  type="button"
                  onClick={onOpenCommandPalette}
                  className="h-[30px] w-9 sm:w-[192px] px-2.5 rounded-full border border-[var(--line)] bg-[var(--panel)] hover:border-[var(--line2)] flex items-center gap-2 text-[12px] text-[var(--dim)] shadow-[var(--specular-subtle)]"
                >
                  <Search size={13.5} strokeWidth={1.8} className="shrink-0" />
                  <span className="hidden sm:inline flex-1 text-left truncate">Tìm MST, HĐ...</span>
                  <kbd className="hidden sm:inline text-[10px] px-1.5 py-0.2 rounded bg-[var(--raised)] border border-[var(--line)]">
                    ⌘K
                  </kbd>
                </button>

                <button
                  type="button"
                  onClick={onToggleTheme}
                  title="Đổi Sáng / Tối"
                  className="w-[30px] h-[30px] rounded-full grid place-items-center border border-[var(--line)] bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--line2)]"
                >
                  {isLight ? <Moon size={14} strokeWidth={1.8} /> : <Sun size={14} strokeWidth={1.8} />}
                </button>

                <button type="button" onClick={onQuickUploadClick} className="pb">
                  <Plus size={14} strokeWidth={2.2} />
                  <span className="hidden sm:inline">Nạp chứng từ</span>
                </button>

                {transport.isDesktop && transport.platform === "windows" && (
                  <div className="flex items-center gap-1 pl-2 ml-1 border-l border-[var(--line)]">
                    <button
                      type="button"
                      onClick={() => transport.windowAction?.("minimize")}
                      className="w-7 h-7 rounded-[7px] grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)]"
                    >
                      <Minus size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => transport.windowAction?.("maximize")}
                      className="w-7 h-7 rounded-[7px] grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)]"
                    >
                      <Square size={11} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => transport.windowAction?.("close")}
                      className="w-7 h-7 rounded-[7px] grid place-items-center text-[var(--muted)] hover:bg-[var(--rose-s)] hover:text-[var(--rose)]"
                    >
                      <X size={13} strokeWidth={1.8} />
                    </button>
                  </div>
                )}
              </div>
            </header>

            <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
          </div>
        </div>
      </div>
    </>
  )
}
