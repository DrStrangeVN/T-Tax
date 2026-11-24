import React, { useEffect, useMemo, useState } from "react"
import { Command } from "cmdk"
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
  Sun,
  Moon,
  Search,
  Download,
  FileText,
  ArrowRightLeft,
  Plus,
  Scale
} from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"
import { formatMoney } from "../utils/format.js"
import type { NavPage } from "./LiquidShell.js"

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onNavigate: (page: NavPage) => void
  onOpenTransaction: (txId: string) => void
  onOpenCounterparty?: (taxCode: string) => void
  onCreateTransaction?: () => void
  onCreateJournalVoucher?: () => void
  onOpenAccountingTab?: (tab: "journal" | "trial_balance" | "vat" | "hkd" | "bank") => void
  workspaceId: string
  workspaces: WorkspaceDTO[]
  onSwitchWorkspace: (id: string) => void
  onToggleTheme: () => void
  onQuickExport: (kind: "htkk_in" | "misa_in") => void
  isLight: boolean
}

function stripAccents(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onOpenTransaction,
  onOpenCounterparty,
  onCreateTransaction,
  onCreateJournalVoucher,
  onOpenAccountingTab,
  workspaceId,
  workspaces,
  onSwitchWorkspace,
  onToggleTheme,
  onQuickExport,
  isLight
}: CommandPaletteProps) {
  const transport = useTransport()
  const [query, setQuery] = useState("")
  const [searchRes, setSearchRes] = useState<{
    transactions: Array<Record<string, unknown>>
    counterparties: Array<Record<string, unknown>>
  }>({ transactions: [], counterparties: [] })

  useEffect(() => {
    if (!open) {
      setQuery("")
      setSearchRes({ transactions: [], counterparties: [] })
    }
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (!open || q.length < 2) {
      setSearchRes({ transactions: [], counterparties: [] })
      return
    }
    const timer = setTimeout(() => {
      transport.searchGlobal(workspaceId, q).then(setSearchRes).catch(() => {})
    }, 140)
    return () => clearTimeout(timer)
  }, [open, query, workspaceId, transport])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        if (open) onClose()
      } else if (e.key === "Escape" && open) {
        onClose()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose])

  const navItems = useMemo(
    () => [
      { id: "dashboard", label: "Tổng quan & Thuế (Dashboard)", keywords: "tong quan thue kpi bieu do", icon: LayoutDashboard, kbd: "⌘1" },
      { id: "unsorted", label: "Hộp thư Chứng từ AI (Unsorted)", keywords: "hop thu chung tu duyet ai ocr xml", icon: Inbox, kbd: "⌘2" },
      { id: "transactions", label: "Sổ Giao dịch & Hóa đơn", keywords: "so giao dich hoa don mua ban", icon: ReceiptText, kbd: "⌘3" },
      { id: "converter", label: "Chuyển đổi & Kiểm toán XML hàng loạt", keywords: "xml batch hang loat pdf excel", icon: FileCode2, kbd: "⌘4" },
      { id: "accounting", label: "Kế toán VAS & Đối chiếu Sao kê", keywords: "ke toan vas so cai sao ke ngan hang", icon: BookOpenCheck, kbd: "⌘5" },
      { id: "counterparties", label: "Đối tác & Rủi ro MST", keywords: "doi tac nha cung cap khach hang mst rui ro", icon: Building2, kbd: "⌘6" },
      { id: "apps", label: "Ứng dụng (Email IMAP, Tạo HĐ, Cổng Thuế)", keywords: "ung dung email imap cong thue", icon: Blocks, kbd: "⌘7" },
      { id: "vault", label: "Kho Chứng từ gốc (Vault)", keywords: "kho luu tru file goc pdf xml anh", icon: FolderArchive, kbd: "⌘8" },
      { id: "settings", label: "Cài đặt hệ thống & Sao lưu", keywords: "cai dat sao luu backup theme", icon: Settings, kbd: "⌘9" }
    ],
    []
  )

  const quickActions = useMemo(() => {
    const items: Array<{
      id: string
      label: string
      keywords: string
      icon: typeof Plus
      iconClass: string
      action: () => void
    }> = []
    if (onCreateTransaction) {
      items.push({
        id: "new-tx",
        label: "Tạo giao dịch / Hóa đơn mới",
        keywords: "tao giao dich hoa don moi them chung tu",
        icon: Plus,
        iconClass: "text-[var(--cyan)]",
        action: onCreateTransaction
      })
    }
    if (onCreateJournalVoucher) {
      items.push({
        id: "new-voucher",
        label: "Tạo phiếu kế toán / Bút toán mới",
        keywords: "tao phieu ke toan but toan no co moi",
        icon: Plus,
        iconClass: "text-[var(--indigo)]",
        action: onCreateJournalVoucher
      })
    }
    if (onOpenAccountingTab) {
      items.push(
        {
          id: "tab-tb",
          label: "Mở Bảng Cân đối Tài khoản (Trial Balance)",
          keywords: "bang can doi tai khoan phat sinh so du",
          icon: Scale,
          iconClass: "text-[var(--cyan)]",
          action: () => onOpenAccountingTab("trial_balance")
        },
        {
          id: "tab-vat",
          label: "Mở Tờ khai Thuế GTGT & Kết chuyển thuế",
          keywords: "to khai thue gtgt vat ket chuyen",
          icon: FileText,
          iconClass: "text-[var(--amber)]",
          action: () => onOpenAccountingTab("vat")
        },
        {
          id: "tab-hkd",
          label: "Mở Sổ Doanh thu & Chi phí HKD (S1/S2-HKD)",
          keywords: "so ho kinh doanh s1 hkd s2 hkd thong tu 88",
          icon: BookOpenCheck,
          iconClass: "text-[var(--green)]",
          action: () => onOpenAccountingTab("hkd")
        },
        {
          id: "tab-bank",
          label: "Mở Đối chiếu Sao kê Ngân hàng",
          keywords: "doi chieu sao ke ngan hang khop lenh",
          icon: ArrowRightLeft,
          iconClass: "text-[var(--cyan)]",
          action: () => onOpenAccountingTab("bank")
        }
      )
    }
    items.push(
      {
        id: "export-htkk",
        label: "Xuất Bảng kê Mua vào Excel (HTKK)",
        keywords: "xuat bang ke hoa don mua vao excel htkk",
        icon: Download,
        iconClass: "text-[var(--green)]",
        action: () => onQuickExport("htkk_in")
      },
      {
        id: "export-misa",
        label: "Xuất Mẫu Excel Import MISA SME / AMIS",
        keywords: "xuat excel import misa sme amis",
        icon: Download,
        iconClass: "text-[var(--cyan)]",
        action: () => onQuickExport("misa_in")
      },
      {
        id: "toggle-theme",
        label: `Chuyển sang giao diện ${isLight ? "Tối (Dark)" : "Sáng (Light)"}`,
        keywords: "doi che do sang toi dark light theme giao dien",
        icon: isLight ? Moon : Sun,
        iconClass: "text-[var(--muted)]",
        action: onToggleTheme
      }
    )
    return items
  }, [
    isLight,
    onCreateJournalVoucher,
    onCreateTransaction,
    onOpenAccountingTab,
    onQuickExport,
    onToggleTheme
  ])

  const queryTokens = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return []
    return stripAccents(trimmed).split(/\s+/).filter(Boolean)
  }, [query])

  const matchesQuery = (text: string) => {
    if (queryTokens.length === 0) return true
    const norm = stripAccents(text)
    return queryTokens.every((t) => norm.includes(t))
  }

  const filteredNav = navItems.filter((item) => matchesQuery(`${item.label} ${item.keywords}`))
  const filteredWorkspaces =
    workspaces.length > 1
      ? workspaces.filter((ws) => matchesQuery(`workspace cong ty ${ws.name} ${ws.taxCode}`))
      : []
  const filteredActions = quickActions.filter((a) => matchesQuery(`${a.label} ${a.keywords}`))

  if (!open) return null

  const run = (fn: () => void) => {
    fn()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center pt-[12vh] bg-black/35"
      onClick={onClose}
    >
      <div
        className="pal w-full max-w-[590px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="T-Tax Command Palette" className="w-full" shouldFilter={false}>
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--line)]">
            <Search size={15} strokeWidth={1.8} className="text-[var(--muted)]" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Tìm số hóa đơn, MST, đối tác, màn hình hoặc lệnh nhanh..."
              className="w-full bg-transparent outline-none text-[13.5px] text-[var(--text)] placeholder:text-[var(--dim)]"
            />
            <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--raised)] border border-[var(--line)] text-[var(--dim)]">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[440px] overflow-y-auto p-2 space-y-1.5">
            {searchRes.transactions.length === 0 &&
              searchRes.counterparties.length === 0 &&
              filteredNav.length === 0 &&
              filteredWorkspaces.length === 0 &&
              filteredActions.length === 0 && (
                <div className="py-8 text-center text-[12px] text-[var(--muted)]">
                  Không tìm thấy kết quả phù hợp.
                </div>
              )}

            {searchRes.transactions.length > 0 && (
              <Command.Group
                heading="Giao dịch & Hóa đơn khớp (FTS5)"
                className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {searchRes.transactions.map((tx) => (
                  <Command.Item
                    key={String(tx.id)}
                    value={`tx ${String(tx.id)} ${String(tx.invoiceNumber ?? "")} ${String(tx.merchant ?? "")} ${String(tx.name ?? "")}`}
                    onSelect={() => run(() => onOpenTransaction(String(tx.id)))}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
                  >
                    <FileText size={14.5} strokeWidth={1.8} className="text-[var(--cyan)] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {tx.invoiceNumber ? `HĐ ${String(tx.invoiceNumber)} · ` : ""}
                        {String(tx.merchant || tx.name || "Chứng từ")}
                      </div>
                      <div className="text-[10.5px] text-[var(--dim)] truncate tnum">
                        {String(tx.merchantTaxCode ?? "")} · {String(tx.issuedAt ?? "")}
                      </div>
                    </div>
                    <span className="tnum font-semibold text-[12px] shrink-0">
                      {formatMoney(Number(tx.totalAmount ?? 0), String(tx.currencyCode ?? "VND"))}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {searchRes.counterparties.length > 0 && (
              <Command.Group
                heading="Đối tác MST"
                className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {searchRes.counterparties.map((cp) => (
                  <Command.Item
                    key={String(cp.id)}
                    value={`cp ${String(cp.id)} ${String(cp.taxCode)} ${String(cp.name)}`}
                    onSelect={() =>
                      run(() => {
                        if (onOpenCounterparty) {
                          onOpenCounterparty(String(cp.taxCode ?? ""))
                        } else {
                          onNavigate("counterparties")
                        }
                      })
                    }
                    className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
                  >
                    <Building2 size={14.5} strokeWidth={1.8} className="text-[var(--green)] shrink-0" />
                    <span className="flex-1 truncate">{String(cp.name)}</span>
                    <span className="tag tnum">{String(cp.taxCode)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {filteredActions.length > 0 && (
              <Command.Group
                heading="Thao tác nhanh"
                className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {filteredActions.map((act) => {
                  const Icon = act.icon
                  return (
                    <Command.Item
                      key={act.id}
                      value={act.id}
                      onSelect={() => run(act.action)}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
                    >
                      <Icon size={15} strokeWidth={1.8} className={act.iconClass} />
                      <span>{act.label}</span>
                    </Command.Item>
                  )
                })}
              </Command.Group>
            )}

            {filteredNav.length > 0 && (
              <Command.Group
                heading="Điều hướng nhanh"
                className="mt-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {filteredNav.map((item) => {
                  const Icon = item.icon
                  return (
                    <Command.Item
                      key={item.id}
                      value={`nav-${item.id}`}
                      onSelect={() => run(() => onNavigate(item.id as NavPage))}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
                    >
                      <Icon size={15} strokeWidth={1.8} className="text-[var(--cyan)]" />
                      <span className="flex-1">{item.label}</span>
                      <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--raised)] border border-[var(--line)] text-[var(--dim)]">
                        {item.kbd}
                      </kbd>
                    </Command.Item>
                  )
                })}
              </Command.Group>
            )}

            {filteredWorkspaces.length > 0 && (
              <Command.Group
                heading="Đổi Công ty / MST"
                className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {filteredWorkspaces.map((ws) => (
                  <Command.Item
                    key={ws.id}
                    value={`workspace-${ws.id}`}
                    onSelect={() => run(() => onSwitchWorkspace(ws.id))}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
                  >
                    <ArrowRightLeft size={14} strokeWidth={1.8} className="text-[var(--indigo)]" />
                    <span className="flex-1 truncate">{ws.name}</span>
                    <span className="tag tnum">{ws.taxCode}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
