import React from "react"
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
  Plus,
  Sun,
  Moon,
  Menu,
  Minus,
  Square,
  X
} from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
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
  workspaces: WorkspaceDTO[]
  activeWorkspace: WorkspaceDTO
  onSwitchWorkspace: (id: string) => void
  unreviewedCount: number
  complianceWarnings: number
  isLight: boolean
  onToggleTheme: () => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
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
  dashboard: { title: "Tổng quan tài chính & Thuế", subtitle: "Doanh thu, chi phí, thuế GTGT và cảnh báo tuân thủ Việt Nam" },
  unsorted: { title: "Hộp thư Chứng từ (Unsorted)", subtitle: "Kéo thả XML, PDF, ZIP hoặc ảnh chụp hóa đơn để bóc tách 3 tầng" },
  transactions: { title: "Sổ Giao dịch & Hóa đơn", subtitle: "Bảng kê ảo hóa 60fps, lọc đa chiều và hạch toán hàng loạt" },
  converter: { title: "Chuyển đổi & Kiểm toán XML", subtitle: "Parse QĐ 1450/1510, xác thực XMLDSig, iTaxViewer PDF & xuất HTKK/MISA" },
  accounting: { title: "Kế toán & Đối chiếu Sao kê", subtitle: "Định khoản Nợ/Có tự động, bảng kê GTGT, sổ HKD & khớp ngân hàng 3 bên" },
  counterparties: { title: "Danh bạ Đối tác & Rủi ro MST", subtitle: "Kiểm tra trạng thái hoạt động mã số thuế người bán / người mua" },
  apps: { title: "Ứng dụng Mở rộng", subtitle: "Đồng bộ Email IMAP, Hóa đơn VietQR, Cổng HĐĐT & Nhập Excel" },
  vault: { title: "Kho Chứng từ gốc (Vault)", subtitle: "Lưu trữ bất biến theo tháng, ghép cặp XML ↔ PDF và chống trùng SHA-256" },
  settings: { title: "Cài đặt Hệ thống", subtitle: "Đa MST, Chế độ kế toán TT99/TT200/TT133/HKD, AI Prompt & Liquid Glass" }
}

export function LiquidShell({
  activePage,
  onNavigate,
  workspaces,
  activeWorkspace,
  onSwitchWorkspace,
  unreviewedCount,
  complianceWarnings,
  isLight,
  onToggleTheme,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenCommandPalette,
  onQuickUploadClick,
  mobileNavOpen,
  setMobileNavOpen,
  children
}: LiquidShellProps) {
  const transport = useTransport()
  const meta = PAGE_TITLES[activePage]
  const activeNav = NAV_ITEMS.find((n) => n.id === activePage)
  const HeroIcon = activeNav?.icon ?? LayoutDashboard

  const slaRatio = Math.max(0, Math.min(100, 100 - complianceWarnings * 5))

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
          <div className="flex items-center gap-2.5 px-2 pb-3">
            <div className="w-7 h-7 rounded-[8.5px] grid place-items-center bg-[#161A24] border border-white/20 text-white shrink-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16" />
                <path d="M12 6v13" />
                <path d="M5 13h4" />
                <path d="M15 13h4" />
              </svg>
            </div>
            <span className="font-bold text-[14px] tracking-tight text-[var(--text)]">T-Tax</span>
            <span className="tag">0.1</span>
            <button
              type="button"
              onClick={onToggleSidebar}
              title="Thu gọn thanh bên (⌘\)"
              className="ml-auto w-7 h-7 rounded-[7px] grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <PanelLeftClose size={15} strokeWidth={1.8} />
            </button>
          </div>

          {/* Workspace Switcher */}
          <div className="px-1.5 pb-2">
            <select
              aria-label="Chọn Công ty / MST"
              value={activeWorkspace.id}
              onChange={(e) => onSwitchWorkspace(e.target.value)}
              className="w-full h-8 px-2.5 rounded-[9px] text-[12px] font-medium bg-[var(--raised)] border border-[var(--line)] text-[var(--text)] outline-none focus:border-[var(--cyan)]"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id} className="bg-[var(--panel-solid)] text-[var(--text)]">
                  {ws.name} ({ws.taxCode})
                </option>
              ))}
            </select>
          </div>

          <div className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--dim)] px-2.5 pt-2 pb-1">
            Nghiệp vụ
          </div>

          <nav className="flex flex-col gap-0.5">
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
                  onClick={() => {
                    onNavigate(item.id)
                    setMobileNavOpen(false)
                  }}
                  className={`h-8 px-2.5 rounded-[9px] flex items-center gap-2.5 text-[12.5px] transition-colors ${
                    isOn
                      ? "bg-[var(--sel)] text-[var(--text)] font-semibold shadow-[var(--specular-subtle)]"
                      : "text-[var(--muted)] font-medium hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  }`}
                >
                  <Icon size={15} strokeWidth={1.8} />
                  <span className="truncate">{item.label}</span>
                  {badge !== null && (
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
                </button>
              )
            })}
          </nav>

          {/* Footer Compliance Ring */}
          <div className="mt-auto pt-3 px-2 border-t border-[var(--line)] flex items-center gap-2.5">
            <svg width="32" height="32" viewBox="0 0 36 36" className="shrink-0">
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
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[12px] font-semibold text-[var(--text)] tnum">{slaRatio}% Tuân thủ</div>
              <div className="text-[10.5px] text-[var(--muted)] truncate">
                {activeWorkspace.accountingRegime.replace("_", " ")}
              </div>
            </div>
          </div>
        </aside>

        {/* Matte Inset Sheet */}
        <div className="inset-sheet-wrap">
          <div className="inset-sheet">
            <header className="top">
              <div className="flex items-center gap-3 min-w-0 flex-1 no-drag">
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(!mobileNavOpen)}
                  className="md:hidden w-8 h-8 rounded-[8px] grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)]"
                  aria-label="Menu"
                >
                  <Menu size={16} strokeWidth={1.8} />
                </button>

                {sidebarCollapsed && (
                  <button
                    type="button"
                    onClick={onToggleSidebar}
                    title="Hiện thanh bên (⌘\)"
                    className="hidden md:grid w-8 h-8 rounded-[8px] place-items-center text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <PanelLeftOpen size={16} strokeWidth={1.8} />
                  </button>
                )}

                <div className="hidden sm:grid w-9 h-9 rounded-[11px] place-items-center bg-[var(--panel)] border border-[var(--line2)] shadow-[var(--specular)] shrink-0 text-[var(--cyan)]">
                  <HeroIcon size={17} strokeWidth={1.8} />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-[16px] sm:text-[18px] font-bold tracking-tight text-[var(--text)] truncate">
                      {meta.title}
                    </h1>
                    <span className="hidden lg:inline-flex tag tnum">MST {activeWorkspace.taxCode}</span>
                  </div>
                  <p className="hidden sm:block text-[11.5px] text-[var(--muted)] truncate">{meta.subtitle}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 no-drag">
                <button
                  type="button"
                  onClick={onOpenCommandPalette}
                  className="h-[30px] w-9 sm:w-[196px] px-2.5 rounded-full border border-[var(--line)] bg-[var(--panel)] hover:border-[var(--line2)] flex items-center gap-2 text-[12px] text-[var(--dim)] shadow-[var(--specular-subtle)]"
                >
                  <Search size={13.5} strokeWidth={1.8} className="shrink-0" />
                  <span className="hidden sm:inline flex-1 text-left truncate">Tìm nhanh...</span>
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
