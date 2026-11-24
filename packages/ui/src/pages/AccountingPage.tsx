import React, { useEffect, useState, useCallback } from "react"
import { Upload, CheckCircle2, Download } from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
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
}

export function AccountingPage({ workspace, onToast }: AccountingProps) {
  const transport = useTransport()
  const [tab, setTab] = useState<"journal" | "vat" | "hkd" | "bank">("journal")
  const [entries, setEntries] = useState<JournalEntryItem[]>([])
  const [txRows, setTxRows] = useState<Array<Record<string, unknown>>>([])
  const [bankRows, setBankRows] = useState<BankStmtRow[]>([])
  const [bankCode, setBankCode] = useState("VCB")

  const loadAll = useCallback(async () => {
    const [je, tx, bk] = await Promise.all([
      transport.listJournalEntries(workspace.id),
      transport.listTransactions(workspace.id, { limit: 2000 }),
      transport.listBankStatements(workspace.id)
    ])
    setEntries(je as unknown as JournalEntryItem[])
    setTxRows(tx.rows)
    setBankRows(bk as unknown as BankStmtRow[])
  }, [workspace.id, transport])

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

  // Compute VAT summary by rate
  const vatGroups = new Map<string, { inPre: number; inVat: number; outPre: number; outVat: number }>()
  for (const tx of txRows) {
    const rate = String(tx.vatRateCode || "Khác")
    const entry = vatGroups.get(rate) ?? { inPre: 0, inVat: 0, outPre: 0, outVat: 0 }
    if (tx.direction === "input") {
      entry.inPre += Number(tx.preTaxAmount ?? 0)
      entry.inVat += Number(tx.vatAmount ?? 0)
    } else {
      entry.outPre += Number(tx.preTaxAmount ?? 0)
      entry.outVat += Number(tx.vatAmount ?? 0)
    }
    vatGroups.set(rate, entry)
  }

  // HKD 2026 calculation preview
  const hkdRevenue = txRows.filter((t) => t.direction === "output").reduce((s, t) => s + Number(t.convertedTotalVnd ?? t.totalAmount ?? 0), 0)
  const hkdExpense = txRows.filter((t) => t.direction === "input").reduce((s, t) => s + Number(t.convertedTotalVnd ?? t.totalAmount ?? 0), 0)

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--line)] flex flex-wrap items-center justify-between gap-2 bg-[var(--sheet-bg)]">
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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => transport.exportReport(workspace.id, "htkk_in")}
            className="gb"
          >
            <Download size={13} />
            <span>Xuất HTKK Mua vào</span>
          </button>
          <button
            type="button"
            onClick={() => transport.exportReport(workspace.id, "misa_in")}
            className="gb"
          >
            <Download size={13} />
            <span>Xuất MISA</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {tab === "journal" && (
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
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
                      Chưa có bút toán nào. Hãy duyệt chứng từ ở Hộp thư AI hoặc Quét XML.
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
                          <input
                            defaultValue={ln.debitAccount}
                            onBlur={(e) => {
                              if (e.target.value !== ln.debitAccount) handleUpdateLine(ln.id, "debitAccount", e.target.value)
                            }}
                            className="w-20 h-7 px-2 rounded-[7px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px] tnum"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            defaultValue={ln.creditAccount}
                            onBlur={(e) => {
                              if (e.target.value !== ln.creditAccount) handleUpdateLine(ln.id, "creditAccount", e.target.value)
                            }}
                            className="w-20 h-7 px-2 rounded-[7px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px] tnum"
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-semibold tnum">
                          {formatMoney(ln.amountVnd, "VND")}
                        </td>
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
                {[...vatGroups.entries()].map(([rate, g]) => (
                  <tr key={rate} className="hover:bg-[var(--hover)]">
                    <td className="py-2.5 px-4 font-semibold">{rate}</td>
                    <td className="py-2.5 px-4 text-right tnum">{formatMoney(g.inPre)}</td>
                    <td className="py-2.5 px-4 text-right tnum text-[var(--cyan)]">{formatMoney(g.inVat)}</td>
                    <td className="py-2.5 px-4 text-right tnum">{formatMoney(g.outPre)}</td>
                    <td className="py-2.5 px-4 text-right tnum text-[var(--amber)]">{formatMoney(g.outVat)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "hkd" && (
          <div className="space-y-4">
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
                <div className="text-[11px] text-[var(--muted)]">Ước tính Thuế (1% GTGT + 0.5% TNCN)</div>
                <div className="text-[20px] font-bold tnum mt-1 text-[var(--amber)]">
                  {formatMoney(Math.round(hkdRevenue * 0.015))}
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
              <div className="flex items-center gap-2">
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
                  <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => handleBankUpload(e.target.files)} />
                </label>
              </div>
              <span className="text-[11.5px] text-[var(--muted)] tnum">{bankRows.length} giao dịch ngân hàng</span>
            </div>

            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
              <table className="w-full text-left border-collapse text-[12px]">
                <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
                  <tr>
                    <th className="py-2.5 px-3">Ngày GD</th>
                    <th className="py-2.5 px-3">Nội dung chuyển khoản</th>
                    <th className="py-2.5 px-3 text-right">Tiền ra (Nợ)</th>
                    <th className="py-2.5 px-3 text-right">Tiền vào (Có)</th>
                    <th className="py-2.5 px-3">Đối chiếu Hóa đơn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {bankRows.map((b) => (
                    <tr key={b.id} className="hover:bg-[var(--hover)]">
                      <td className="py-2.5 px-3 tnum">{formatDateVi(b.txDate)}</td>
                      <td className="py-2.5 px-3 max-w-[340px] truncate">{b.description}</td>
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
                          <button
                            type="button"
                            onClick={() => handleConfirmMatch(b.id, b.matchedTransactionId!)}
                            className="gb hl"
                          >
                            <span>Xác nhận khớp ({Math.round((b.matchConfidence ?? 0.8) * 100)}%)</span>
                          </button>
                        ) : (
                          <span className="tag">Chưa khớp</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
