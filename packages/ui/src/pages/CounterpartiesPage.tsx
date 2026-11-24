import React, { useEffect, useState, useCallback } from "react"
import { RefreshCw, ShieldAlert, ShieldCheck, Search } from "lucide-react"
import type { WorkspaceDTO } from "@t-tax/core"
import { useTransport } from "../transport/client.js"

interface CounterpartiesProps {
  workspace: WorkspaceDTO
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
}

export function CounterpartiesPage({ workspace, onToast }: CounterpartiesProps) {
  const transport = useTransport()
  const [list, setList] = useState<CounterpartyRow[]>([])
  const [search, setSearch] = useState("")
  const [lookupMst, setLookupMst] = useState("")
  const [checkingMst, setCheckingMst] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await transport.listCounterparties(workspace.id)
    setList(data as unknown as CounterpartyRow[])
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
        res.found ? `MST ${mst}: ${String(res.name)} (${String(res.status)})` : `Không tra cứu được MST ${mst} (hoặc ngoại tuyến).`,
        res.status === "closed" ? "err" : res.found ? "ok" : "warn"
      )
      await load()
    } finally {
      setCheckingMst(null)
    }
  }

  const filtered = list.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.taxCode.includes(search)
  )

  return (
    <div className="p-5 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative">
          <Search size={13.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Lọc đối tác theo tên hoặc MST..."
            className="h-8 w-[240px] pl-8 pr-3 rounded-full bg-[var(--panel)] border border-[var(--line)] text-[12px] outline-none"
          />
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

      <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
        <table className="w-full text-left border-collapse text-[12.5px]">
          <thead className="bg-[var(--raised)] text-[10.5px] uppercase text-[var(--muted)] border-b border-[var(--line)]">
            <tr>
              <th className="py-2.5 px-4">Mã số thuế</th>
              <th className="py-2.5 px-4">Tên doanh nghiệp / Đối tác</th>
              <th className="py-2.5 px-4">Địa chỉ</th>
              <th className="py-2.5 px-4">Trạng thái MST</th>
              <th className="py-2.5 px-4 text-right">Kiểm tra</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-[var(--dim)]">
                  Chưa có đối tác nào. Đối tác tự thêm khi duyệt XML hoặc tra cứu MST ở trên.
                </td>
              </tr>
            ) : (
              filtered.map((cp) => (
                <tr key={cp.id} className="hover:bg-[var(--hover)]">
                  <td className="py-2.5 px-4 font-mono text-[12px] tnum font-semibold">{cp.taxCode}</td>
                  <td className="py-2.5 px-4 font-medium">{cp.name}</td>
                  <td className="py-2.5 px-4 text-[var(--muted)] max-w-[300px] truncate">{cp.address || "—"}</td>
                  <td className="py-2.5 px-4">
                    <span
                      className={`tag ${
                        cp.status === "active"
                          ? "tag-ok"
                          : cp.status === "closed" || cp.status === "risk_flagged"
                            ? "tag-err"
                            : "tag-warn"
                      }`}
                    >
                      {cp.status === "active" ? (
                        <ShieldCheck size={10} />
                      ) : (
                        <ShieldAlert size={10} />
                      )}
                      <span>{cp.status}</span>
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-right">
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
