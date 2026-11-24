import React, { useEffect, useState, useCallback, useMemo, useRef } from "react"
import { createPortal } from "react-dom"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Upload,
  CheckCircle2,
  Download,
  Link2,
  Unlink,
  Search,
  ChevronDown,
  Plus,
  X,
  ArrowRightLeft,
  Landmark
} from "lucide-react"
import type { HkdTaxSectorCode, TrialBalanceRow, UiPreferences, WorkspaceDTO } from "@t-tax/core"
import { HKD_TAX_SECTORS } from "@t-tax/core/browser"
import { useTransport, fileToPayload } from "../transport/client.js"
import { MoneyInput } from "../components/MoneyInput.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

interface AccountingProps {
  workspace: WorkspaceDTO
  onRefreshCounts?: () => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

interface JournalEntryItem {
  id: string
  voucherNo: string
  voucherDate: string
  description: string
  status: string
  postedBy: string
  lines: Array<{
    id: string
    debitAccount: string
    creditAccount: string
    amountVnd: number
    description: string | null
  }>
}

interface FlatJournalLine {
  lineId: string
  voucherNo: string
  voucherDate: string
  description: string
  debitAccount: string
  creditAccount: string
  amountVnd: number
}

interface BankStmtRow {
  id: string
  bankCode: string
  txDate: string
  description: string
  debitAmount: number
  creditAmount: number
  matchedTransactionId: string | null
  matchConfidence: number | null
  matchStatus: string
  matchedTransaction?: {
    id: string
    merchant: string | null
    invoiceNumber: string | null
    issuedAt: string | null
    totalAmount: number
  } | null
}

interface AccountOption {
  code: string
  name: string
}

const UI_PREFS_KEY = "ttax:ui-prefs:v1"

function loadHkdSector(): HkdTaxSectorCode {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as UiPreferences
      if (parsed.hkdSector && HKD_TAX_SECTORS.some((s) => s.code === parsed.hkdSector)) {
        return parsed.hkdSector
      }
    }
  } catch {
    // ignore
  }
  return "pp"
}

function saveHkdSector(code: HkdTaxSectorCode) {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    const prev = raw ? (JSON.parse(raw) as UiPreferences) : {}
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...prev, hkdSector: code }))
  } catch {
    // ignore
  }
}

function getPeriodRange(period: "all" | "month" | "quarter" | "year"): { dateFrom?: string; dateTo?: string } {
  if (period === "all") return {}
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  if (period === "month") return { dateFrom: `${y}-${String(m + 1).padStart(2, "0")}-01` }
  if (period === "quarter") {
    const qStart = Math.floor(m / 3) * 3 + 1
    return { dateFrom: `${y}-${String(qStart).padStart(2, "0")}-01` }
  }
  return { dateFrom: `${y}-01-01` }
}

function AccountCombobox({
  value,
  accounts,
  onSelect
}: {
  value: string
  accounts: AccountOption[]
  onSelect: (code: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0, top: 0 })
  const [q, setQ] = useState("")
  const boxRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const toggleOpen = (next: boolean) => {
    if (next && boxRef.current) {
      const rect = boxRef.current.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 302))
      if (rect.bottom > window.innerHeight - 240) {
        setMenuPos({ left, bottom: window.innerHeight - rect.top + 4 })
      } else {
        setMenuPos({ left, top: rect.bottom + 4 })
      }
    }
    setOpen(next)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (boxRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [open])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return accounts
    return accounts.filter((a) => a.code.toLowerCase().includes(term) || a.name.toLowerCase().includes(term))
  }, [accounts, q])

  const currentAccount = accounts.find((a) => a.code === value)

  return (
    <div ref={boxRef} className="relative inline-block">
      <div className="h-7 px-2 min-w-[92px] rounded-[7px] bg-[var(--raised)] border border-[var(--line)] focus-within:border-[var(--cyan)] flex items-center gap-1">
        <input
          value={open ? q : value}
          title={currentAccount ? `${currentAccount.code} — ${currentAccount.name}` : value}
          onFocus={() => {
            setQ("")
            toggleOpen(true)
          }}
          onChange={(e) => {
            toggleOpen(true)
            setQ(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && q.trim()) {
              e.preventDefault()
              setOpen(false)
              onSelect(filtered[0]?.code ?? q.trim())
            } else if (e.key === "Escape") {
              setOpen(false)
            }
          }}
          className="w-16 bg-transparent font-mono text-[11.5px] tnum text-[var(--text)] outline-none"
        />
        <button
          type="button"
          onClick={() => {
            setQ("")
            toggleOpen(!open)
          }}
          className="text-[var(--dim)] hover:text-[var(--text)] shrink-0"
          tabIndex={-1}
        >
          <ChevronDown size={11} />
        </button>
      </div>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", left: menuPos.left, top: menuPos.top, bottom: menuPos.bottom }}
            className="menu w-[290px] p-2 z-[260] space-y-1 shadow-xl"
          >
            <div className="max-h-[210px] overflow-y-auto space-y-0.5">
              {filtered.map((acc) => (
                <button
                  key={acc.code}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    if (acc.code !== value) onSelect(acc.code)
                  }}
                  className={`w-full text-left px-2 py-1 rounded-[7px] text-[11.5px] flex items-center gap-2 hover:bg-[var(--sel)] ${
                    acc.code === value ? "bg-[var(--cyan-s)] text-[var(--cyan)] font-semibold" : "text-[var(--text)]"
                  }`}
                >
                  <span className="font-mono tnum shrink-0 font-semibold w-16">{acc.code}</span>
                  <span className="truncate text-[var(--muted)]">{acc.name}</span>
                </button>
              ))}
              {q.trim() && !accounts.some((a) => a.code.toLowerCase() === q.trim().toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onSelect(q.trim())
                  }}
                  className="w-full text-left px-2 py-1 rounded-[7px] text-[11.5px] text-[var(--cyan)] hover:bg-[var(--sel)]"
                >
                  Dùng mã tùy chỉnh: <strong>{q.trim()}</strong>
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

export function AccountingPage({ workspace, onRefreshCounts, onToast }: AccountingProps) {
  const transport = useTransport()
  const [tab, setTab] = useState<"journal" | "trial_balance" | "vat" | "hkd" | "bank">("journal")
  const [period, setPeriod] = useState<"all" | "month" | "quarter" | "year">("all")
  const [hkdSector, setHkdSector] = useState<HkdTaxSectorCode>(() => loadHkdSector())

  const [entries, setEntries] = useState<JournalEntryItem[]>([])
  const [journalSearch, setJournalSearch] = useState("")
  const [trialRows, setTrialRows] = useState<TrialBalanceRow[]>([])
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [txRows, setTxRows] = useState<Array<Record<string, unknown>>>([])
  const [bankRows, setBankRows] = useState<BankStmtRow[]>([])
  const [bankCode, setBankCode] = useState("VCB")
  const [bankFilter, setBankFilter] = useState<"all" | "matched" | "suggested" | "unmatched">("all")
  const [selectedStmtId, setSelectedStmtId] = useState<string | null>(null)
  const [txMatchSearch, setTxMatchSearch] = useState("")

  const [showManualJeModal, setShowManualJeModal] = useState(false)
  const [manualJe, setManualJe] = useState({
    voucherNo: "",
    voucherDate: new Date().toISOString().slice(0, 10),
    description: "",
    debitAccount: "6427",
    creditAccount: "1121",
    amountVnd: 0
  })

  const range = useMemo(() => {
    const r = getPeriodRange(period)
    return { dateFrom: r.dateFrom, dateTo: r.dateTo }
  }, [period])

  const loadAll = useCallback(async () => {
    const [je, tb, tx, bk, accs] = await Promise.all([
      transport.listJournalEntries(workspace.id, range),
      transport.getTrialBalance(workspace.id, range),
      transport.listTransactions(workspace.id, { ...range, limit: 2000 }),
      transport.listBankStatements(workspace.id),
      transport.listAccounts(workspace.id, workspace.accountingRegime)
    ])
    setEntries(je as unknown as JournalEntryItem[])
    setTrialRows(tb)
    setTxRows(tx.rows)
    const typedBank = bk as unknown as BankStmtRow[]
    setBankRows(typedBank)
    setAccounts(accs.map((a) => ({ code: String(a.code ?? ""), name: String(a.name ?? "") })))
    if (typedBank.length > 0 && (!selectedStmtId || !typedBank.some((b) => b.id === selectedStmtId))) {
      setSelectedStmtId(typedBank[0]!.id)
    } else if (typedBank.length === 0) {
      setSelectedStmtId(null)
    }
  }, [workspace.id, workspace.accountingRegime, range, transport, selectedStmtId])

  useEffect(() => {
    loadAll().catch(() => {})
  }, [loadAll])

  const handleUpdateLine = async (lineId: string, field: "debitAccount" | "creditAccount", value: string) => {
    try {
      await transport.updateJournalLine(lineId, { [field]: value })
      onToast("Đã cập nhật tài khoản định khoản.", "ok")
      loadAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Không thể cập nhật bút toán", "err")
    }
  }

  const handleCreateManualJe = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await transport.createManualJournalEntry(workspace.id, {
        voucherNo: manualJe.voucherNo || undefined,
        voucherDate: manualJe.voucherDate,
        description: manualJe.description || "Phiếu kế toán thủ công",
        lines: [
          {
            debitAccount: manualJe.debitAccount,
            creditAccount: manualJe.creditAccount,
            amountVnd: manualJe.amountVnd,
            description: manualJe.description
          }
        ]
      })
      setShowManualJeModal(false)
      setManualJe((p) => ({ ...p, voucherNo: "", description: "", amountVnd: 0 }))
      onToast(`Đã ghi sổ phiếu ${res.voucherNo}.`, "ok")
      loadAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi lập phiếu kế toán", "err")
    }
  }

  const handleVatClosing = async () => {
    try {
      const voucherDate = range.dateTo || new Date().toISOString().slice(0, 10)
      const res = await transport.postVatClosingEntry(workspace.id, { ...range, voucherDate })
      if (!res.posted) {
        onToast(res.message || "Không có số dư VAT đủ điều kiện kết chuyển.", "warn")
        return
      }
      onToast(`Đã kết chuyển VAT ${formatMoney(res.amountVnd, "VND")} (${res.voucherNo}).`, "ok")
      loadAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi kết chuyển VAT", "err")
    }
  }

  const handleBankUpload = async (fileList: FileList | null) => {
    const f = fileList?.[0]
    if (!f) return
    try {
      const payload = await fileToPayload(f)
      const res = await transport.importBankStatement(workspace.id, payload.filename, payload.base64, bankCode)
      onRefreshCounts?.()
      onToast(
        `Đã nhập ${String(res.importedCount)} dòng sao kê — Gợi ý khớp ${String(res.suggestedMatches)} hóa đơn.`,
        "ok"
      )
      loadAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi đọc sao kê", "err")
    }
  }

  const handleConfirmMatch = async (stmtId: string, txId: string) => {
    await transport.confirmBankMatch(workspace.id, stmtId, txId)
    onRefreshCounts?.()
    onToast("Đã xác nhận đối chiếu thanh toán 3 bên!", "ok")
    loadAll()
  }

  const handleUnmatch = async (stmtId: string) => {
    await transport.unmatchBankStatement(workspace.id, stmtId)
    onRefreshCounts?.()
    onToast("Đã hủy ghép đối chiếu dòng sao kê.", "ok")
    loadAll()
  }

  const handleQuickPostBank = async (stmtId: string, kind: "bank_fee" | "interest") => {
    try {
      await transport.quickPostBankStatement(workspace.id, stmtId, { kind })
      onRefreshCounts?.()
      onToast(
        kind === "bank_fee"
          ? "Đã hạch toán Phí NH (Nợ 6425 / Có 1121) & khớp sao kê."
          : "Đã hạch toán Lãi tiền gửi (Nợ 1121 / Có 515) & khớp sao kê.",
        "ok"
      )
      loadAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi hạch toán nhanh sao kê", "err")
    }
  }

  const flatJournalLines = useMemo<FlatJournalLine[]>(() => {
    const q = journalSearch.trim().toLowerCase()
    const out: FlatJournalLine[] = []
    for (const je of entries) {
      for (const ln of je.lines) {
        const desc = ln.description || je.description || ""
        if (
          q &&
          !je.voucherNo.toLowerCase().includes(q) &&
          !desc.toLowerCase().includes(q) &&
          !ln.debitAccount.toLowerCase().includes(q) &&
          !ln.creditAccount.toLowerCase().includes(q)
        ) {
          continue
        }
        out.push({
          lineId: ln.id,
          voucherNo: je.voucherNo,
          voucherDate: je.voucherDate,
          description: desc,
          debitAccount: ln.debitAccount,
          creditAccount: ln.creditAccount,
          amountVnd: ln.amountVnd
        })
      }
    }
    return out
  }, [entries, journalSearch])

  const journalScrollRef = useRef<HTMLDivElement | null>(null)
  const journalVirtualizer = useVirtualizer({
    count: flatJournalLines.length,
    getScrollElement: () => journalScrollRef.current,
    estimateSize: () => 44,
    overscan: 16
  })

  const journalSum = useMemo(() => {
    let debit = 0
    for (const ln of flatJournalLines) {
      debit += Number(ln.amountVnd ?? 0)
    }
    return { debit, balanced: true }
  }, [flatJournalLines])

  // FX-normalized VAT table
  const vatGroups = useMemo(() => {
    const map = new Map<string, { inPre: number; inVat: number; outPre: number; outVat: number }>()
    for (const tx of txRows) {
      const rate = String(tx.vatRateCode || "Khác")
      const fx = Number(tx.fxRateDecimal ?? 1) || 1
      const preVnd = Math.round(Number(tx.preTaxAmount ?? 0) * fx)
      const vatVnd = Math.round(Number(tx.vatAmount ?? 0) * fx)
      const entry = map.get(rate) ?? { inPre: 0, inVat: 0, outPre: 0, outVat: 0 }
      if (tx.direction === "input") {
        entry.inPre += preVnd
        entry.inVat += vatVnd
      } else {
        entry.outPre += preVnd
        entry.outVat += vatVnd
      }
      map.set(rate, entry)
    }
    return map
  }, [txRows])

  const trialTotals = useMemo(() => {
    return trialRows.reduce(
      (acc, r) => ({
        od: acc.od + r.openingDebit,
        oc: acc.oc + r.openingCredit,
        pd: acc.pd + r.periodDebit,
        pc: acc.pc + r.periodCredit,
        cd: acc.cd + r.closingDebit,
        cc: acc.cc + r.closingCredit
      }),
      { od: 0, oc: 0, pd: 0, pc: 0, cd: 0, cc: 0 }
    )
  }, [trialRows])

  const hkdRevenue = txRows
    .filter((t) => t.direction === "output")
    .reduce((s, t) => s + Number(t.convertedTotalVnd ?? t.totalAmount ?? 0), 0)
  const hkdExpense = txRows
    .filter((t) => t.direction === "input")
    .reduce((s, t) => s + Number(t.convertedTotalVnd ?? t.totalAmount ?? 0), 0)
  const activeSector = HKD_TAX_SECTORS.find((s) => s.code === hkdSector) ?? HKD_TAX_SECTORS[0]!
  const hkdVatTax = Math.round((hkdRevenue * activeSector.vatRatePct) / 100)
  const hkdPitTax = Math.round((hkdRevenue * activeSector.pitRatePct) / 100)

  const filteredBankRows = useMemo(() => {
    if (bankFilter === "all") return bankRows
    if (bankFilter === "matched") return bankRows.filter((b) => b.matchStatus === "matched")
    if (bankFilter === "suggested") return bankRows.filter((b) => b.matchStatus === "suggested")
    return bankRows.filter((b) => b.matchStatus !== "matched" && b.matchStatus !== "suggested")
  }, [bankRows, bankFilter])

  const selectedStmt = bankRows.find((b) => b.id === selectedStmtId) ?? null

  const candidateInvoices = useMemo(() => {
    if (!selectedStmt) return []
    const stmtAmt = Math.max(selectedStmt.debitAmount, selectedStmt.creditAmount)
    const desiredDir = selectedStmt.debitAmount > 0 ? "input" : "output"
    const q = txMatchSearch.trim().toLowerCase()
    return txRows
      .filter((t) => {
        if (q) {
          const m = String(t.merchant ?? "").toLowerCase()
          const inv = String(t.invoiceNumber ?? "").toLowerCase()
          const nm = String(t.name ?? "").toLowerCase()
          return m.includes(q) || inv.includes(q) || nm.includes(q)
        }
        return t.direction === desiredDir
      })
      .sort((a, b) => {
        const diffA = Math.abs(Number(a.convertedTotalVnd ?? a.totalAmount ?? 0) - stmtAmt)
        const diffB = Math.abs(Number(b.convertedTotalVnd ?? b.totalAmount ?? 0) - stmtAmt)
        return diffA - diffB
      })
      .slice(0, 12)
  }, [selectedStmt, txRows, txMatchSearch])

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2 bg-[var(--sheet-bg)] shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg">
            {[
              { id: "journal", label: "Bút toán Nợ / Có" },
              { id: "trial_balance", label: "Cân đối Tài khoản" },
              { id: "vat", label: "Bảng kê GTGT" },
              { id: "hkd", label: "Sổ HKD 2026" },
              { id: "bank", label: "Đối chiếu Sao kê" }
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? "on" : ""}
                onClick={() => setTab(t.id as typeof tab)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="seg">
            {[
              { id: "all", label: "Mọi kỳ" },
              { id: "month", label: "Tháng này" },
              { id: "quarter", label: "Quý này" },
              { id: "year", label: "Năm nay" }
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                className={period === p.id ? "on" : ""}
                onClick={() => setPeriod(p.id as typeof period)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {tab === "journal" && (
            <>
              <span className="tag tag-ok tnum">∑Nợ = ∑Có: {formatMoney(journalSum.debit, "VND")}</span>
              <button type="button" onClick={() => setShowManualJeModal(true)} className="pb">
                <Plus size={13} />
                <span>Phiếu kế toán</span>
              </button>
            </>
          )}
          {tab === "vat" && (
            <button type="button" onClick={handleVatClosing} className="pb">
              <ArrowRightLeft size={13} />
              <span>Kết chuyển GTGT cuối kỳ</span>
            </button>
          )}
          <button type="button" onClick={() => transport.exportReport(workspace.id, "htkk_in", range)} className="gb">
            <Download size={13} />
            <span className="hidden xl:inline">HTKK Mua vào</span>
          </button>
          <button type="button" onClick={() => transport.exportReport(workspace.id, "misa_in", range)} className="gb">
            <Download size={13} />
            <span className="hidden xl:inline">Xuất MISA</span>
          </button>
        </div>
      </div>

      {/* Main Content Container */}
      <div className="flex-1 min-h-0 flex flex-col p-4 sm:p-5 overflow-hidden">
        {tab === "journal" && (
          <div className="flex-1 min-h-0 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 shrink-0">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
                <input
                  value={journalSearch}
                  onChange={(e) => setJournalSearch(e.target.value)}
                  placeholder="Lọc số CT, diễn giải hoặc mã TK (1331, 642...)..."
                  className="h-8 w-[290px] pl-8 pr-3 rounded-full border border-[var(--line)] bg-[var(--panel)] text-[12px] outline-none focus:border-[var(--cyan)]"
                />
              </div>
              <span className="text-[11.5px] text-[var(--muted)] tnum">{flatJournalLines.length} dòng định khoản</span>
            </div>

            <div className="flex-1 min-h-0 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] flex flex-col overflow-hidden">
              <div
                style={{ gridTemplateColumns: "126px 88px minmax(180px, 1fr) 118px 118px 144px" }}
                className="bg-[var(--raised)] text-[10.5px] uppercase font-semibold text-[var(--muted)] border-b border-[var(--line)] grid gap-2.5 px-3.5 py-2.5 shrink-0"
              >
                <div>Số CT</div>
                <div>Ngày</div>
                <div>Diễn giải</div>
                <div>TK Nợ</div>
                <div>TK Có</div>
                <div className="text-right">Số tiền (VND)</div>
              </div>

              {flatJournalLines.length === 0 ? (
                <div className="flex-1 grid place-items-center text-[12px] text-[var(--dim)] p-8">
                  Chưa có bút toán nào trong kỳ. Hãy duyệt chứng từ ở Hộp thư AI hoặc lập Phiếu kế toán.
                </div>
              ) : (
                <div ref={journalScrollRef} className="flex-1 min-h-0 overflow-y-auto">
                  <div style={{ height: `${journalVirtualizer.getTotalSize()}px`, position: "relative" }}>
                    {journalVirtualizer.getVirtualItems().map((vr) => {
                      const ln = flatJournalLines[vr.index]!
                      return (
                        <div
                          key={ln.lineId}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: `${vr.size}px`,
                            transform: `translateY(${vr.start}px)`,
                            gridTemplateColumns: "126px 88px minmax(180px, 1fr) 118px 118px 144px"
                          }}
                          className="grid gap-2.5 items-center px-3.5 border-b border-[var(--line)] hover:bg-[var(--hover)] text-[12px]"
                        >
                          <div className="font-mono text-[11.5px] tnum truncate">{ln.voucherNo}</div>
                          <div className="tnum text-[var(--muted)] text-[11.5px]">{formatDateVi(ln.voucherDate)}</div>
                          <div className="truncate">{ln.description}</div>
                          <div>
                            <AccountCombobox
                              value={ln.debitAccount}
                              accounts={accounts}
                              onSelect={(code) => handleUpdateLine(ln.lineId, "debitAccount", code)}
                            />
                          </div>
                          <div>
                            <AccountCombobox
                              value={ln.creditAccount}
                              accounts={accounts}
                              onSelect={(code) => handleUpdateLine(ln.lineId, "creditAccount", code)}
                            />
                          </div>
                          <div className="text-right font-semibold tnum">{formatMoney(ln.amountVnd, "VND")}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "trial_balance" && (
          <div className="flex-1 min-h-0 flex flex-col rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-left border-collapse text-[12px] min-w-[820px]">
                <thead className="sticky top-0 bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                  <tr>
                    <th className="py-2.5 px-3">Số hiệu TK</th>
                    <th className="py-2.5 px-3">Tên tài khoản</th>
                    <th className="py-2.5 px-3 text-right">Dư Nợ ĐK</th>
                    <th className="py-2.5 px-3 text-right">Dư Có ĐK</th>
                    <th className="py-2.5 px-3 text-right">Phát sinh Nợ</th>
                    <th className="py-2.5 px-3 text-right">Phát sinh Có</th>
                    <th className="py-2.5 px-3 text-right">Dư Nợ CK</th>
                    <th className="py-2.5 px-3 text-right">Dư Có CK</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {trialRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-[var(--dim)]">
                        Chưa có số liệu phát sinh tài khoản trong kỳ.
                      </td>
                    </tr>
                  ) : (
                    trialRows.map((row) => (
                      <tr key={row.code} className="hover:bg-[var(--hover)]">
                        <td className="py-2 px-3 font-mono font-semibold text-[var(--cyan)] tnum">{row.code}</td>
                        <td className="py-2 px-3">{row.name}</td>
                        <td className="py-2 px-3 text-right tnum text-[var(--muted)]">{formatMoney(row.openingDebit)}</td>
                        <td className="py-2 px-3 text-right tnum text-[var(--muted)]">{formatMoney(row.openingCredit)}</td>
                        <td className="py-2 px-3 text-right tnum font-medium">{formatMoney(row.periodDebit)}</td>
                        <td className="py-2 px-3 text-right tnum font-medium">{formatMoney(row.periodCredit)}</td>
                        <td className="py-2 px-3 text-right tnum font-semibold text-[var(--text)]">
                          {formatMoney(row.closingDebit)}
                        </td>
                        <td className="py-2 px-3 text-right tnum font-semibold text-[var(--text)]">
                          {formatMoney(row.closingCredit)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2.5 border-t border-[var(--line)] bg-[var(--sheet-bg)] grid grid-cols-8 text-[11.5px] font-semibold tnum shrink-0">
              <div className="col-span-2 text-[var(--muted)]">Tổng Cân đối Tài khoản ({trialRows.length} TK)</div>
              <div className="text-right">{formatMoney(trialTotals.od)}</div>
              <div className="text-right">{formatMoney(trialTotals.oc)}</div>
              <div className="text-right text-[var(--cyan)]">{formatMoney(trialTotals.pd)}</div>
              <div className="text-right text-[var(--cyan)]">{formatMoney(trialTotals.pc)}</div>
              <div className="text-right text-[var(--green)]">{formatMoney(trialTotals.cd)}</div>
              <div className="text-right text-[var(--green)]">{formatMoney(trialTotals.cc)}</div>
            </div>
          </div>
        )}

        {tab === "vat" && (
          <div className="flex-1 overflow-y-auto">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
              <table className="w-full text-left border-collapse text-[12.5px]">
                <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                  <tr>
                    <th className="py-2.5 px-4">Nhóm Thuế suất</th>
                    <th className="py-2.5 px-4 text-right">Doanh số Mua vào (VND)</th>
                    <th className="py-2.5 px-4 text-right">VAT Đầu vào (VND)</th>
                    <th className="py-2.5 px-4 text-right">Doanh số Bán ra (VND)</th>
                    <th className="py-2.5 px-4 text-right">VAT Đầu ra (VND)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {vatGroups.size === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-[var(--dim)]">
                        Không có chứng từ thuế GTGT trong kỳ đã chọn.
                      </td>
                    </tr>
                  ) : (
                    [...vatGroups.entries()].map(([rate, g]) => (
                      <tr key={rate} className="hover:bg-[var(--hover)]">
                        <td className="py-2.5 px-4 font-semibold">{rate}</td>
                        <td className="py-2.5 px-4 text-right tnum">{formatMoney(g.inPre)}</td>
                        <td className="py-2.5 px-4 text-right tnum text-[var(--cyan)]">{formatMoney(g.inVat)}</td>
                        <td className="py-2.5 px-4 text-right tnum">{formatMoney(g.outPre)}</td>
                        <td className="py-2.5 px-4 text-right tnum text-[var(--amber)]">{formatMoney(g.outVat)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "hkd" && (
          <div className="flex-1 overflow-y-auto space-y-4">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold text-[var(--text)]">Ngành nghề tính thuế Khoán / Kê khai (TT 40)</div>
                <div className="text-[11.5px] text-[var(--muted)]">
                  Tài khoản S1 áp dụng: <span className="font-mono text-[var(--cyan)]">{activeSector.accountCode}</span>
                </div>
              </div>
              <select
                value={hkdSector}
                onChange={(e) => {
                  const code = e.target.value as HkdTaxSectorCode
                  setHkdSector(code)
                  saveHkdSector(code)
                }}
                className="h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] max-w-[420px]"
              >
                {HKD_TAX_SECTORS.map((sec) => (
                  <option key={sec.code} value={sec.code} className="bg-[var(--panel-solid)]">
                    {sec.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sgrid sgrid-3 rounded-[14px] border border-[var(--line)] overflow-hidden">
              <div className="sgrid-cell">
                <div className="text-[11px] text-[var(--muted)]">Tổng Doanh thu (S1-HKD)</div>
                <div className="text-[20px] font-bold tnum mt-1 text-[var(--green)]">{formatMoney(hkdRevenue)}</div>
              </div>
              <div className="sgrid-cell">
                <div className="text-[11px] text-[var(--muted)]">Tổng Chi phí (S2-HKD)</div>
                <div className="text-[20px] font-bold tnum mt-1 text-[var(--rose)]">{formatMoney(hkdExpense)}</div>
              </div>
              <div className="sgrid-cell">
                <div className="text-[11px] text-[var(--muted)]">
                  Ước tính Thuế ({activeSector.vatRatePct}% GTGT + {activeSector.pitRatePct}% TNCN)
                </div>
                <div className="text-[20px] font-bold tnum mt-1 text-[var(--amber)]">{formatMoney(hkdVatTax + hkdPitTax)}</div>
                <div className="text-[11px] text-[var(--dim)] tnum mt-0.5">
                  GTGT {formatMoney(hkdVatTax)} · TNCN {formatMoney(hkdPitTax)}
                </div>
              </div>
            </div>
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 text-[12px] text-[var(--muted)]">
              Chế độ Hộ kinh doanh (lộ trình bỏ thuế khoán 2026): tự động phân tách chứng từ đầu ra từ máy tính tiền (`1C26M...`) vào Sổ doanh thu S1-HKD và chi phí hợp lệ vào S2-HKD.
            </div>
          </div>
        )}

        {tab === "bank" && (
          <div className="flex-1 min-h-0 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5 shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={bankCode}
                  onChange={(e) => setBankCode(e.target.value)}
                  className="h-8 px-3 rounded-full bg-[var(--panel)] border border-[var(--line)] text-[12px]"
                >
                  {["VCB", "TCB", "MB", "BIDV", "ACB", "VPB", "TPB"].map((b) => (
                    <option key={b} value={b} className="bg-[var(--panel-solid)]">
                      Ngân hàng {b}
                    </option>
                  ))}
                </select>
                <label className="pb cursor-pointer">
                  <Upload size={13.5} />
                  <span>Nạp Sao kê CSV / XLSX</span>
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => {
                      handleBankUpload(e.target.files)
                      e.target.value = ""
                    }}
                  />
                </label>

                <div className="seg">
                  {[
                    { id: "all", label: `Tất cả (${bankRows.length})` },
                    { id: "matched", label: "Đã khớp" },
                    { id: "suggested", label: "Gợi ý" },
                    { id: "unmatched", label: "Chưa khớp" }
                  ].map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={bankFilter === f.id ? "on" : ""}
                      onClick={() => setBankFilter(f.id as typeof bankFilter)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <span className="text-[11.5px] text-[var(--muted)] tnum">{filteredBankRows.length} giao dịch</span>
            </div>

            {/* Independent Scroll 2-Pane Bank Reconciliation Workbench */}
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-7 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-y-auto min-h-0">
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                    <tr>
                      <th className="py-2.5 px-3">Ngày GD</th>
                      <th className="py-2.5 px-3">Nội dung chuyển khoản</th>
                      <th className="py-2.5 px-3 text-right">Tiền ra</th>
                      <th className="py-2.5 px-3 text-right">Tiền vào</th>
                      <th className="py-2.5 px-3">Đối chiếu</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {filteredBankRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-10 text-center text-[var(--dim)]">
                          Chưa có dòng sao kê ngân hàng nào.
                        </td>
                      </tr>
                    ) : (
                      filteredBankRows.map((b) => {
                        const active = b.id === selectedStmtId
                        return (
                          <tr
                            key={b.id}
                            onClick={() => setSelectedStmtId(b.id)}
                            className={`cursor-pointer ${active ? "bg-[var(--cyan-s)]" : "hover:bg-[var(--hover)]"}`}
                          >
                            <td className="py-2.5 px-3 tnum whitespace-nowrap">{formatDateVi(b.txDate)}</td>
                            <td className="py-2.5 px-3 max-w-[230px] truncate">{b.description}</td>
                            <td className="py-2.5 px-3 text-right tnum text-[var(--rose)]">
                              {b.debitAmount > 0 ? formatMoney(b.debitAmount) : "—"}
                            </td>
                            <td className="py-2.5 px-3 text-right tnum text-[var(--green)]">
                              {b.creditAmount > 0 ? formatMoney(b.creditAmount) : "—"}
                            </td>
                            <td className="py-2.5 px-3">
                              {b.matchStatus === "matched" ? (
                                <span className="tag tag-ok">
                                  <CheckCircle2 size={10} /> Đã khớp
                                </span>
                              ) : b.matchStatus === "suggested" && b.matchedTransactionId ? (
                                <span className="tag tag-warn tnum">
                                  Gợi ý {Math.round((b.matchConfidence ?? 0.8) * 100)}%
                                </span>
                              ) : (
                                <span className="tag">Chưa khớp</span>
                              )}
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Independent Scroll Right Match Inspector */}
              <div className="lg:col-span-5 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 flex flex-col gap-3 min-h-0 overflow-y-auto">
                {!selectedStmt ? (
                  <div className="py-10 text-center text-[12px] text-[var(--dim)]">
                    Chọn một dòng sao kê bên trái để xem hóa đơn đối chiếu hoặc hạch toán nhanh phí ngân hàng.
                  </div>
                ) : (
                  <>
                    <div className="space-y-1 shrink-0">
                      <div className="flex items-center justify-between">
                        <span className="tag">{selectedStmt.bankCode}</span>
                        <span className="text-[11.5px] text-[var(--muted)] tnum">{formatDateVi(selectedStmt.txDate)}</span>
                      </div>
                      <div className="text-[18px] font-bold tnum text-[var(--text)]">
                        {selectedStmt.debitAmount > 0
                          ? `-${formatMoney(selectedStmt.debitAmount)}`
                          : `+${formatMoney(selectedStmt.creditAmount)}`}
                      </div>
                      <p className="text-[12px] text-[var(--muted)] leading-relaxed">{selectedStmt.description}</p>
                    </div>

                    {selectedStmt.matchedTransaction ? (
                      <div className="p-3 rounded-[11px] border border-[var(--line2)] bg-[var(--raised)] space-y-2 shrink-0">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-[var(--text)]">
                            {selectedStmt.matchStatus === "matched" ? "Hóa đơn đã khớp" : "Gợi ý khớp tự động"}
                          </span>
                          <span className="tnum text-[var(--cyan)] font-semibold">
                            {formatMoney(selectedStmt.matchedTransaction.totalAmount)}
                          </span>
                        </div>
                        <div className="text-[12px] font-medium text-[var(--text)]">
                          {selectedStmt.matchedTransaction.merchant || "—"}
                        </div>
                        <div className="text-[11px] text-[var(--muted)] tnum">
                          HĐ {selectedStmt.matchedTransaction.invoiceNumber || "—"} ·{" "}
                          {formatDateVi(selectedStmt.matchedTransaction.issuedAt)}
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          {selectedStmt.matchStatus === "suggested" && (
                            <button
                              type="button"
                              onClick={() => handleConfirmMatch(selectedStmt.id, selectedStmt.matchedTransaction!.id)}
                              className="pb"
                            >
                              <CheckCircle2 size={13} />
                              <span>Xác nhận khớp</span>
                            </button>
                          )}
                          <button type="button" onClick={() => handleUnmatch(selectedStmt.id)} className="gb text-[var(--rose)]">
                            <Unlink size={13} />
                            <span>Hủy ghép</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3 rounded-[11px] border border-[var(--line)] bg-[var(--raised)] space-y-2 shrink-0">
                        <div className="text-[11.5px] font-semibold text-[var(--text)] flex items-center gap-1.5">
                          <Landmark size={13} className="text-[var(--cyan)]" />
                          <span>Không có hóa đơn? Hạch toán nhanh giao dịch ngân hàng</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {selectedStmt.debitAmount > 0 ? (
                            <button
                              type="button"
                              onClick={() => handleQuickPostBank(selectedStmt.id, "bank_fee")}
                              className="gb hl"
                            >
                              <Plus size={12.5} />
                              <span>Tạo Phiếu chi Phí NH (TK 6425)</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleQuickPostBank(selectedStmt.id, "interest")}
                              className="gb hl"
                            >
                              <Plus size={12.5} />
                              <span>Ghi nhận Lãi tiền gửi (TK 515)</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Manual Candidate Search */}
                    <div className="space-y-2 pt-2 border-t border-[var(--line)] flex-1 min-h-0 flex flex-col">
                      <div className="text-[11.5px] font-semibold text-[var(--text)] shrink-0">Ghép thủ công với Hóa đơn / Giao dịch</div>
                      <div className="relative shrink-0">
                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
                        <input
                          value={txMatchSearch}
                          onChange={(e) => setTxMatchSearch(e.target.value)}
                          placeholder="Tìm NCC, số hóa đơn..."
                          className="w-full h-8 pl-8 pr-3 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px] outline-none focus:border-[var(--cyan)]"
                        />
                      </div>

                      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5">
                        {candidateInvoices.map((cand) => {
                          const cid = String(cand.id)
                          const isSame = selectedStmt.matchedTransactionId === cid && selectedStmt.matchStatus === "matched"
                          return (
                            <div
                              key={cid}
                              className="p-2 rounded-[9px] border border-[var(--line)] bg-[var(--raised)] flex items-center justify-between gap-2 text-[11.5px]"
                            >
                              <div className="min-w-0">
                                <div className="font-medium text-[var(--text)] truncate">
                                  {String(cand.merchant || cand.name || "—")}
                                </div>
                                <div className="text-[10.5px] text-[var(--muted)] tnum">
                                  HĐ {String(cand.invoiceNumber || "—")} · {formatDateVi(String(cand.issuedAt ?? ""))} ·{" "}
                                  {formatMoney(Number(cand.convertedTotalVnd ?? cand.totalAmount ?? 0))}
                                </div>
                              </div>
                              <button
                                type="button"
                                disabled={isSame}
                                onClick={() => handleConfirmMatch(selectedStmt.id, cid)}
                                className="gb shrink-0"
                              >
                                <Link2 size={12} />
                                <span>{isSame ? "Đang khớp" : "Khớp"}</span>
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Manual Journal Entry Modal */}
      {showManualJeModal && (
        <div
          className="fixed inset-0 z-[110] grid place-items-center bg-black/45 p-4"
          onClick={() => setShowManualJeModal(false)}
        >
          <form
            onSubmit={handleCreateManualJe}
            onClick={(e) => e.stopPropagation()}
            className="glass-overlay w-full max-w-[460px] rounded-[16px] p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold">Lập Phiếu kế toán thủ công</h3>
              <button type="button" onClick={() => setShowManualJeModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Số chứng từ (tùy chọn)</label>
                <input
                  placeholder="VD: PKT-2026-01"
                  value={manualJe.voucherNo}
                  onChange={(e) => setManualJe({ ...manualJe, voucherNo: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Ngày chứng từ</label>
                <input
                  required
                  type="date"
                  value={manualJe.voucherDate}
                  onChange={(e) => setManualJe({ ...manualJe, voucherDate: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-[var(--muted)] mb-1">Diễn giải</label>
              <input
                required
                placeholder="VD: Bút toán điều chỉnh, kết chuyển, trích khấu hao..."
                value={manualJe.description}
                onChange={(e) => setManualJe({ ...manualJe, description: e.target.value })}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
              />
            </div>
            <div className="grid grid-cols-3 gap-2.5 items-end">
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">TK Nợ</label>
                <input
                  required
                  value={manualJe.debitAccount}
                  onChange={(e) => setManualJe({ ...manualJe, debitAccount: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">TK Có</label>
                <input
                  required
                  value={manualJe.creditAccount}
                  onChange={(e) => setManualJe({ ...manualJe, creditAccount: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Số tiền (VND)</label>
                <MoneyInput
                  value={manualJe.amountVnd}
                  onChange={(v) => setManualJe({ ...manualJe, amountVnd: v })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] font-semibold"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowManualJeModal(false)} className="gb">
                Hủy
              </button>
              <button type="submit" className="pb">
                Ghi sổ Nhật ký
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
