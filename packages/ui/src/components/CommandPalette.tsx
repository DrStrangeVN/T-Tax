import React, { useEffect, useState } from "react"
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
  ArrowRightLeft
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
  workspaceId: string
  workspaces: WorkspaceDTO[]
  onSwitchWorkspace: (id: string) => void
  onToggleTheme: () => void
  onQuickExport: (kind: "htkk_in" | "misa_in") => void
  isLight: boolean
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onOpenTransaction,
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
        <Command label="T-Tax Command Palette" className="w-full" shouldFilter={query.trim().length < 2}>
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
            <Command.Empty className="py-8 text-center text-[12px] text-[var(--muted)]">
              Không tìm thấy kết quả phù hợp.
            </Command.Empty>

            {searchRes.transactions.length > 0 && (
              <Command.Group
                heading="Giao dịch & Hóa đơn khớp (FTS5)"
                className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {searchRes.transactions.map((tx) => (
                  <Command.Item
                    key={String(tx.id)}
                    value={`tx ${String(tx.invoiceNumber ?? "")} ${String(tx.merchant ?? "")} ${String(tx.name ?? "")}`}
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
                    value={`cp ${String(cp.taxCode)} ${String(cp.name)}`}
                    onSelect={() => run(() => onNavigate("counterparties"))}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
                  >
                    <Building2 size={14.5} strokeWidth={1.8} className="text-[var(--green)] shrink-0" />
                    <span className="flex-1 truncate">{String(cp.name)}</span>
                    <span className="tag tnum">{String(cp.taxCode)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group
              heading="Điều hướng nhanh"
              className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
            >
              {[
                { id: "dashboard", label: "Tổng quan & Thuế (Dashboard)", icon: LayoutDashboard, kbd: "⌘1" },
                { id: "unsorted", label: "Hộp thư Chứng từ AI (Unsorted)", icon: Inbox, kbd: "⌘2" },
                { id: "transactions", label: "Sổ Giao dịch & Hóa đơn", icon: ReceiptText, kbd: "⌘3" },
                { id: "converter", label: "Chuyển đổi & Kiểm toán XML hàng loạt", icon: FileCode2, kbd: "⌘4" },
                { id: "accounting", label: "Kế toán VAS & Đối chiếu Sao kê", icon: BookOpenCheck, kbd: "⌘5" },
                { id: "counterparties", label: "Đối tác & Rủi ro MST", icon: Building2, kbd: "⌘6" },
                { id: "apps", label: "Ứng dụng (Email IMAP, Tạo HĐ, Cổng Thuế)", icon: Blocks, kbd: "⌘7" },
                { id: "vault", label: "Kho Chứng từ gốc (Vault)", icon: FolderArchive, kbd: "⌘8" },
                { id: "settings", label: "Cài đặt hệ thống & Sao lưu", icon: Settings, kbd: "⌘9" }
              ].map((item) => {
                const Icon = item.icon
                return (
                  <Command.Item
                    key={item.id}
                    value={item.label}
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

            {workspaces.length > 1 && (
              <Command.Group
                heading="Đổi Công ty / MST"
                className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {workspaces.map((ws) => (
                  <Command.Item
                    key={ws.id}
                    value={`workspace ${ws.name} ${ws.taxCode}`}
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

            <Command.Group
              heading="Thao tác nhanh"
              className="mt-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--dim)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
            >
              <Command.Item
                value="Xuất bảng kê hóa đơn mua vào Excel HTKK"
                onSelect={() => run(() => onQuickExport("htkk_in"))}
                className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
              >
                <Download size={15} strokeWidth={1.8} className="text-[var(--green)]" />
                <span>Xuất Bảng kê Mua vào Excel (HTKK)</span>
              </Command.Item>
              <Command.Item
                value="Xuất Excel Import MISA SME AMIS"
                onSelect={() => run(() => onQuickExport("misa_in"))}
                className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
              >
                <Download size={15} strokeWidth={1.8} className="text-[var(--cyan)]" />
                <span>Xuất Mẫu Excel Import MISA SME / AMIS</span>
              </Command.Item>
              <Command.Item
                value="Đổi chế độ Sáng / Tối Dark Light Theme"
                onSelect={() => run(onToggleTheme)}
                className="flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[12.5px] text-[var(--text)] cursor-pointer aria-selected:bg-[var(--sel)]"
              >
                {isLight ? <Moon size={15} strokeWidth={1.8} /> : <Sun size={15} strokeWidth={1.8} />}
                <span>Chuyển sang giao diện {isLight ? "Tối (Dark)" : "Sáng (Light)"}</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
