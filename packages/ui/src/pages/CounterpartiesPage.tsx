import React, { useEffect, useState, useCallback } from "react"
import { RefreshCw, ShieldAlert, ShieldCheck, Search } from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"
import { formatMoney } from "../utils/format.js"

interface CounterpartiesProps {
  workspace: WorkspaceDTO
  initialSearch?: string
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

interface CounterpartyRow {
  id: string
  taxCode: string
  name: string
  address: string | null
  status: string
  defaultCategoryCode: string | null
  defaultAccountCode: string | null
  lastCheckedAt: string | null
  txCount?: number
  totalAmountVnd?: number
}

const STATUS_LABELS: Record<string, string> = {
  active: "Đang hoạt động",
  closed: "Ngừng hoạt động",
  risk_flagged: "Rủi ro thuế",
  unknown: "Chưa tra cứu"
}

export function CounterpartiesPage({ workspace, initialSearch, onToast }: CounterpartiesProps) {
  const transport = useTransport()
  const [list, setList] = useState<CounterpartyRow[]>([])
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([])
  const [search, setSearch] = useState(initialSearch ?? "")
  const [lookupMst, setLookupMst] = useState("")
  const [checkingMst, setCheckingMst] = useState<string | null>(null)
  const [batchChecking, setBatchChecking] = useState(false)

  useEffect(() => {
    if (initialSearch !== undefined) setSearch(initialSearch)
  }, [initialSearch])

  const load = useCallback(async () => {
    const [data, cats] = await Promise.all([
      transport.listCounterparties(workspace.id),
      transport.listCategories(workspace.id)
    ])
    setList(data as unknown as CounterpartyRow[])
    setCategories(cats)
  }, [workspace.id, transport])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const checkMst = async (mst: string) => {
    if (!mst.trim()) return
    setCheckingMst(mst)
    try {
      const res = await transport.refreshCounterpartyRisk(workspace.id, mst.trim())
      onToast(
        res.found ? `MST ${mst}: ${String(res.name)} (${STATUS_LABELS[String(res.status)] ?? String(res.status)})` : `Không tra cứu được MST ${mst} (hoặc ngoại tuyến).`,
        res.status === "closed" ? "err" : res.found ? "ok" : "warn"
      )
      await load()
    } finally {
      setCheckingMst(null)
    }
  }

  const handleBatchRefresh = async () => {
    setBatchChecking(true)
    try {
      const res = await transport.batchRefreshCounterparties(workspace.id)
      onToast(`Đã kiểm tra ${res.checked} MST chưa tra cứu (${res.updated} cập nhật mới).`, "ok")
      await load()
    } finally {
      setBatchChecking(false)
    }
  }

  const handleUpdateDefaults = async (id: string, patch: { defaultCategoryCode?: string | null; defaultAccountCode?: string | null }) => {
    await transport.updateCounterparty(workspace.id, id, patch)
    onToast("Đã lưu quy tắc định khoản mặc định theo MST.", "ok")
    await load()
  }

  const filtered = list.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.taxCode.includes(search)
  )

  return (
    <div className="p-5 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Lọc đối tác theo tên hoặc MST..."
              className="h-8 w-[240px] pl-8 pr-3 rounded-full bg-[var(--panel)] border border-[var(--line)] text-[12px] outline-none"
            />
          </div>
          {list.some((c) => c.status === "unknown") && (
            <button type="button" onClick={handleBatchRefresh} disabled={batchChecking} className="gb">
              <RefreshCw size={12.5} className={batchChecking ? "animate-spin" : ""} />
              <span>Kiểm tra các MST chưa tra cứu</span>
            </button>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            checkMst(lookupMst)
          }}
          className="flex items-center gap-2"
        >
          <input
            value={lookupMst}
            onChange={(e) => setLookupMst(e.target.value)}
            placeholder="Tra cứu nhanh MST (VD: 0312...)"
            className="h-8 w-[220px] px-3 rounded-full bg-[var(--panel)] border border-[var(--line)] text-[12px] tnum outline-none"
          />
          <button type="submit" disabled={Boolean(checkingMst)} className="pb">
            <RefreshCw size={13} className={checkingMst === lookupMst ? "animate-spin" : ""} />
            <span>Tra cứu MST</span>
          </button>
        </form>
      </div>

      <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full text-left border-collapse text-[12px]">
          <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
            <tr>
              <th className="py-2.5 px-2.5 whitespace-nowrap">Mã số thuế</th>
              <th className="py-2.5 px-2.5">Tên doanh nghiệp / Đối tác</th>
              <th className="py-2.5 px-2.5 whitespace-nowrap">Danh mục mặc định</th>
              <th className="py-2.5 px-2.5 whitespace-nowrap">TK Nợ riêng</th>
              <th className="py-2.5 px-2.5 text-right whitespace-nowrap">Tổng giao dịch</th>
              <th className="py-2.5 px-2.5 whitespace-nowrap">Trạng thái MST</th>
              <th className="py-2.5 px-2.5 text-right whitespace-nowrap">Kiểm tra</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-[var(--dim)]">
                  Chưa có đối tác nào. Đối tác tự thêm khi duyệt XML hoặc tra cứu MST ở trên.
                </td>
              </tr>
            ) : (
              filtered.map((cp) => (
                <tr key={cp.id} className="hover:bg-[var(--hover)]">
                  <td className="py-2.5 px-2.5 font-mono text-[12px] tnum font-semibold whitespace-nowrap">{cp.taxCode}</td>
                  <td className="py-2.5 px-2.5">
                    <div className="font-medium max-w-[205px] truncate" title={cp.name}>{cp.name}</div>
                    {cp.address && <div className="text-[11px] text-[var(--muted)] max-w-[205px] truncate">{cp.address}</div>}
                  </td>
                  <td className="py-2.5 px-2.5">
                    <select
                      value={cp.defaultCategoryCode ?? ""}
                      onChange={(e) => handleUpdateDefaults(cp.id, { defaultCategoryCode: e.target.value || null })}
                      className="h-7 px-2 rounded-[7px] bg-[var(--raised)] border border-[var(--line)] text-[11.5px] max-w-[140px]"
                    >
                      <option value="" className="bg-[var(--panel-solid)]">Theo mặc định</option>
                      {categories.map((c) => (
                        <option key={String(c.code)} value={String(c.code)} className="bg-[var(--panel-solid)]">
                          {String(c.name)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5 px-2.5">
                    <input
                      defaultValue={cp.defaultAccountCode ?? ""}
                      placeholder="VD: 6427"
                      onBlur={(e) => {
                        const val = e.target.value.trim() || null
                        if (val !== (cp.defaultAccountCode ?? null)) {
                          handleUpdateDefaults(cp.id, { defaultAccountCode: val })
                        }
                      }}
                      className="w-16 h-7 px-2 rounded-[7px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px] tnum"
                    />
                  </td>
                  <td className="py-2.5 px-2.5 text-right tnum whitespace-nowrap">
                    <div className="font-semibold">{formatMoney(cp.totalAmountVnd ?? 0, workspace.baseCurrency)}</div>
                    <div className="text-[10.5px] text-[var(--dim)]">{cp.txCount ?? 0} chứng từ</div>
                  </td>
                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    <span
                      className={`tag ${
                        cp.status === "active"
                          ? "tag-ok"
                          : cp.status === "closed" || cp.status === "risk_flagged"
                            ? "tag-err"
                            : "tag-warn"
                      }`}
                    >
                      {cp.status === "active" ? <ShieldCheck size={10} /> : <ShieldAlert size={10} />}
                      <span>{STATUS_LABELS[cp.status] ?? cp.status}</span>
                    </span>
                  </td>
                  <td className="py-2.5 px-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      disabled={checkingMst === cp.taxCode}
                      onClick={() => checkMst(cp.taxCode)}
                      className="gb"
                    >
                      <RefreshCw size={12} className={checkingMst === cp.taxCode ? "animate-spin" : ""} />
                      <span>Cập nhật</span>
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
