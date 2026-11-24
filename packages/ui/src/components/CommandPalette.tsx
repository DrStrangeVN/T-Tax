import React, { useEffect } from "react"
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
  Download
} from "lucide-react"
import type { NavPage } from "./LiquidShell.js"

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onNavigate: (page: NavPage) => void
  onToggleTheme: () => void
  onQuickExport: (kind: "htkk_in" | "misa_in") => void
  isLight: boolean
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onToggleTheme,
  onQuickExport,
  isLight
}: CommandPaletteProps) {
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
      className="fixed inset-0 z-[120] flex items-start justify-center pt-[14vh] bg-black/35"
      onClick={onClose}
    >
      <div
        className="pal w-full max-w-[560px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="T-Tax Command Palette" className="w-full">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--line)]">
            <Search size={15} strokeWidth={1.8} className="text-[var(--muted)]" />
            <Command.Input
              autoFocus
              placeholder="Tìm màn hình, lệnh kế toán, xuất HTKK/MISA, đổi giao diện..."
              className="w-full bg-transparent outline-none text-[13.5px] text-[var(--text)] placeholder:text-[var(--dim)]"
            />
            <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--raised)] border border-[var(--line)] text-[var(--dim)]">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[410px] overflow-y-auto p-2 space-y-1">
            <Command.Empty className="py-8 text-center text-[12px] text-[var(--muted)]">
              Không tìm thấy lệnh phù hợp.
            </Command.Empty>

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
