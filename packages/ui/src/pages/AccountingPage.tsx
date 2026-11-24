import React, { useEffect, useState, useCallback, useMemo, useRef } from "react"
import { Upload, CheckCircle2, Download, Link2, Unlink, Search, ChevronDown } from "lucide-react"
import type { HkdTaxSectorCode, UiPreferences, WorkspaceDTO } from "@t-tax/core"
import { HKD_TAX_SECTORS } from "@t-tax/core/browser"
import { useTransport, fileToPayload } from "../transport/client.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

interface AccountingProps {
  workspace: WorkspaceDTO
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
  const [q, setQ] = useState("")
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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
            setOpen(true)
          }}
          onChange={(e) => {
            setOpen(true)
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
            setOpen(!open)
          }}
          className="text-[var(--dim)] hover:text-[var(--text)] shrink-0"
          tabIndex={-1}
        >
          <ChevronDown size={11} />
        </button>
      </div>

      {open && (
        <div className="menu absolute left-0 mt-1 w-[280px] p-2 z-40 space-y-1">
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
        </div>
      )}
    </div>
  )
}

export function AccountingPage({ workspace, onToast }: AccountingProps) {
  const transport = useTransport()
  const [tab, setTab] = useState<"journal" | "vat" | "hkd" | "bank">("journal")
  const [period, setPeriod] = useState<"all" | "month" | "quarter" | "year">("all")
  const [hkdSector, setHkdSector] = useState<HkdTaxSectorCode>(() => loadHkdSector())

  const [entries, setEntries] = useState<JournalEntryItem[]>([])
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [txRows, setTxRows] = useState<Array<Record<string, unknown>>>([])
  const [bankRows, setBankRows] = useState<BankStmtRow[]>([])
  const [bankCode, setBankCode] = useState("VCB")
  const [bankFilter, setBankFilter] = useState<"all" | "matched" | "suggested" | "unmatched">("all")
  const [selectedStmtId, setSelectedStmtId] = useState<string | null>(null)
  const [txMatchSearch, setTxMatchSearch] = useState("")

  const range = useMemo(() => getPeriodRange(period), [period])

  const loadAll = useCallback(async () => {
    const [je, tx, bk, accs] = await Promise.all([
      transport.listJournalEntries(workspace.id, range),
      transport.listTransactions(workspace.id, { ...range, limit: 2000 }),
      transport.listBankStatements(workspace.id),
      transport.listAccounts(workspace.id, workspace.accountingRegime)
    ])
    setEntries(je as unknown as JournalEntryItem[])
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
    await transport.updateJournalLine(lineId, { [field]: value })
    onToast("Đã cập nhật tài khoản định khoản.", "ok")
    loadAll()
  }

  const handleBankUpload = async (fileList: FileList | null) => {
    const f = fileList?.[0]
    if (!f) return
    try {
      const payload = await fileToPayload(f)
      const res = await transport.importBankStatement(workspace.id, payload.filename, payload.base64, bankCode)
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
    onToast("Đã xác nhận đối chiếu thanh toán 3 bên!", "ok")
    loadAll()
  }

  const handleUnmatch = async (stmtId: string) => {
    await transport.unmatchBankStatement(workspace.id, stmtId)
    onToast("Đã hủy ghép đối chiếu dòng sao kê.", "ok")
    loadAll()
  }

  // Compute Debit = Credit total across displayed journal entries
  const journalSum = useMemo(() => {
    let debit = 0
    let credit = 0
    for (const je of entries) {
      for (const ln of je.lines) {
        if (ln.debitAccount) debit += Number(ln.amountVnd ?? 0)
        if (ln.creditAccount) credit += Number(ln.amountVnd ?? 0)
      }
    }
    return { debit, credit, balanced: debit === credit }
  }, [entries])

  // Compute VAT summary by rate
  const vatGroups = useMemo(() => {
    const map = new Map<string, { inPre: number; inVat: number; outPre: number; outVat: number }>()
    for (const tx of txRows) {
      const rate = String(tx.vatRateCode || "Khác")
      const entry = map.get(rate) ?? { inPre: 0, inVat: 0, outPre: 0, outVat: 0 }
      if (tx.direction === "input") {
        entry.inPre += Number(tx.preTaxAmount ?? 0)
        entry.inVat += Number(tx.vatAmount ?? 0)
      } else {
        entry.outPre += Number(tx.preTaxAmount ?? 0)
        entry.outVat += Number(tx.vatAmount ?? 0)
      }
      map.set(rate, entry)
    }
    return map
  }, [txRows])

  // HKD 2026 calculation preview
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
      <div className="px-5 py-3 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--sheet-bg)] shrink-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="seg">
            {[
              { id: "journal", label: "Bút toán Nợ / Có" },
              { id: "vat", label: "Bảng kê Thuế GTGT" },
              { id: "hkd", label: "Sổ Hộ Kinh Doanh 2026" },
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
            <span className={`tag tnum ${journalSum.balanced ? "tag-ok" : "tag-warn"}`}>
              ∑Nợ = ∑Có: {formatMoney(journalSum.debit, "VND")}
            </span>
          )}
          <button
            type="button"
            onClick={() => transport.exportReport(workspace.id, "htkk_in", range)}
            className="gb"
          >
            <Download size={13} />
            <span>Xuất HTKK Mua vào</span>
          </button>
          <button
            type="button"
            onClick={() => transport.exportReport(workspace.id, "misa_in", range)}
            className="gb"
          >
            <Download size={13} />
            <span>Xuất MISA</span>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {tab === "journal" && (
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-visible">
            <table className="w-full text-left border-collapse text-[12px]">
              <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                <tr>
                  <th className="py-2.5 px-3">Số CT</th>
                  <th className="py-2.5 px-3">Ngày CT</th>
                  <th className="py-2.5 px-3">Diễn giải</th>
                  <th className="py-2.5 px-3">TK Nợ</th>
                  <th className="py-2.5 px-3">TK Có</th>
                  <th className="py-2.5 px-3 text-right">Số tiền (VND)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-[var(--dim)]">
                      Chưa có bút toán nào trong kỳ. Hãy duyệt chứng từ ở Hộp thư AI hoặc Quét XML.
                    </td>
                  </tr>
                ) : (
                  entries.flatMap((je) =>
                    je.lines.map((ln) => (
                      <tr key={ln.id} className="hover:bg-[var(--hover)]">
                        <td className="py-2 px-3 font-mono text-[11.5px] tnum">{je.voucherNo}</td>
                        <td className="py-2 px-3 tnum text-[var(--muted)]">{formatDateVi(je.voucherDate)}</td>
                        <td className="py-2 px-3">{ln.description || je.description}</td>
                        <td className="py-2 px-3">
                          <AccountCombobox
                            value={ln.debitAccount}
                            accounts={accounts}
                            onSelect={(code) => handleUpdateLine(ln.id, "debitAccount", code)}
                          />
                        </td>
                        <td className="py-2 px-3">
                          <AccountCombobox
                            value={ln.creditAccount}
                            accounts={accounts}
                            onSelect={(code) => handleUpdateLine(ln.id, "creditAccount", code)}
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-semibold tnum">{formatMoney(ln.amountVnd, "VND")}</td>
                      </tr>
                    ))
                  )
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "vat" && (
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
            <table className="w-full text-left border-collapse text-[12.5px]">
              <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                <tr>
                  <th className="py-2.5 px-4">Nhóm Thuế suất</th>
                  <th className="py-2.5 px-4 text-right">Doanh số Mua vào</th>
                  <th className="py-2.5 px-4 text-right">VAT Đầu vào</th>
                  <th className="py-2.5 px-4 text-right">Doanh số Bán ra</th>
                  <th className="py-2.5 px-4 text-right">VAT Đầu ra</th>
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
        )}

        {tab === "hkd" && (
          <div className="space-y-4">
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
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

            {/* 2-Pane Bank Reconciliation Workbench */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-7 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
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

              {/* Right Match Inspector */}
              <div className="lg:col-span-5 rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3.5 h-fit">
                {!selectedStmt ? (
                  <div className="py-10 text-center text-[12px] text-[var(--dim)]">
                    Chọn một dòng sao kê bên trái để xem hóa đơn đối chiếu hoặc ghép thủ công.
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
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

                    {selectedStmt.matchedTransaction && (
                      <div className="p-3 rounded-[11px] border border-[var(--line2)] bg-[var(--raised)] space-y-2">
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
                    )}

                    {/* Manual Candidate Search */}
                    <div className="space-y-2 pt-1 border-t border-[var(--line)]">
                      <div className="text-[11.5px] font-semibold text-[var(--text)]">Ghép thủ công với Hóa đơn / Giao dịch</div>
                      <div className="relative">
                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
                        <input
                          value={txMatchSearch}
                          onChange={(e) => setTxMatchSearch(e.target.value)}
                          placeholder="Tìm NCC, số hóa đơn..."
                          className="w-full h-8 pl-8 pr-3 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px] outline-none focus:border-[var(--cyan)]"
                        />
                      </div>

                      <div className="max-h-[260px] overflow-y-auto space-y-1.5">
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
    </div>
  )
}
