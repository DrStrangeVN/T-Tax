import React, { useEffect, useState, useCallback } from "react"
import { Plus, Trash2, CheckCircle2, Download, Upload, TestTube2 } from "lucide-react"
import {
  LLM_PROVIDER_PRESETS,
  REGIME_METADATA,
  VIETNAM_BANKS,
  type AccountingRegime,
  type BankDetails,
  type GlassIntensity,
  type LLMProviderConfig,
  type WorkspaceDTO
} from "@t-tax/core/browser"
import { useTransport } from "../transport/client.js"

interface SettingsProps {
  workspace: WorkspaceDTO
  openNewWsSignal?: number
  onWorkspaceUpdated: () => void
  isLight: boolean
  setIsLight: (v: boolean) => void
  glassIntensity: GlassIntensity
  setGlassIntensity: (g: GlassIntensity) => void
  reduceTransparency: boolean
  setReduceTransparency: (r: boolean) => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

export function SettingsPage({
  workspace,
  openNewWsSignal,
  onWorkspaceUpdated,
  isLight,
  setIsLight,
  glassIntensity,
  setGlassIntensity,
  reduceTransparency,
  setReduceTransparency,
  onToast
}: SettingsProps) {
  const transport = useTransport()
  const [tab, setTab] = useState<"workspace" | "ai" | "categories" | "projects" | "fields" | "appearance" | "backup">(
    "workspace"
  )

  const [wsForm, setWsForm] = useState({
    name: workspace.name,
    taxCode: workspace.taxCode,
    entityType: workspace.entityType,
    accountingRegime: workspace.accountingRegime,
    baseCurrency: workspace.baseCurrency,
    address: workspace.address ?? "",
    lockDate: workspace.lockDate ?? ""
  })
  const [bankForm, setBankForm] = useState<BankDetails>({
    bankBin: workspace.bankDetails?.bankBin || "970436",
    bankName: workspace.bankDetails?.bankName || "Vietcombank",
    accountNo: workspace.bankDetails?.accountNo || "",
    accountName: workspace.bankDetails?.accountName || workspace.name
  })

  const [newWsModal, setNewWsModal] = useState(false)
  const [newWsForm, setNewWsForm] = useState({
    name: "",
    taxCode: "",
    entityType: "enterprise" as "enterprise" | "household" | "freelancer",
    accountingRegime: "TT99_2025" as AccountingRegime
  })

  const [providers, setProviders] = useState<LLMProviderConfig[]>([])
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({})
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([])
  const [projects, setProjects] = useState<Array<Record<string, unknown>>>([])
  const [fields, setFields] = useState<Array<Record<string, unknown>>>([])

  const [newCat, setNewCat] = useState({ code: "", name: "", color: "#2563EB", defaultDebitAccount: "6427", llmPrompt: "" })
  const [newProject, setNewProject] = useState({ code: "", name: "", color: "#0EA5E9", llmPrompt: "" })
  const [newField, setNewField] = useState({ code: "", name: "", type: "string", llmPrompt: "" })
  const [testingProvider, setTestingProvider] = useState<string | null>(null)
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null)

  useEffect(() => {
    if (openNewWsSignal && openNewWsSignal > 0) {
      setTab("workspace")
      setNewWsModal(true)
    }
  }, [openNewWsSignal])

  const loadAll = useCallback(async () => {
    const [s, p, cats, projs, flds] = await Promise.all([
      transport.getSettings(workspace.id),
      transport.getLLMProviders(workspace.id),
      transport.listCategories(workspace.id),
      transport.listProjects(workspace.id),
      transport.listFields(workspace.id)
    ])
    setSettingsMap(s)
    if (p.length > 0) {
      setProviders(p)
    } else {
      setProviders(
        LLM_PROVIDER_PRESETS.map((pr) => ({
          provider: pr.provider,
          apiKey: "",
          model: pr.defaultModel,
          baseUrl: pr.defaultBaseUrl,
          enabled: pr.provider === "google",
          maxConcurrency: 2
        }))
      )
    }
    setCategories(cats)
    setProjects(projs)
    setFields(flds)
  }, [workspace.id, transport])

  useEffect(() => {
    loadAll().catch(() => {})
    setWsForm({
      name: workspace.name,
      taxCode: workspace.taxCode,
      entityType: workspace.entityType,
      accountingRegime: workspace.accountingRegime,
      baseCurrency: workspace.baseCurrency,
      address: workspace.address ?? "",
      lockDate: workspace.lockDate ?? ""
    })
    setBankForm({
      bankBin: workspace.bankDetails?.bankBin || "970436",
      bankName: workspace.bankDetails?.bankName || "Vietcombank",
      accountNo: workspace.bankDetails?.accountNo || "",
      accountName: workspace.bankDetails?.accountName || workspace.name
    })
  }, [workspace, loadAll])

  const saveWorkspace = async () => {
    await transport.updateWorkspace(workspace.id, {
      ...wsForm,
      lockDate: wsForm.lockDate?.trim() || null,
      bankDetails: (bankForm.accountNo ?? "").trim() ? bankForm : null
    })
    onWorkspaceUpdated()
    onToast("Đã cập nhật thông tin Công ty, Chế độ KT, Khóa sổ & VietQR.", "ok")
  }

  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault()
    await transport.createWorkspace(newWsForm)
    setNewWsModal(false)
    onWorkspaceUpdated()
    onToast("Đã tạo Workspace MST mới.", "ok")
  }

  const saveAiConfig = async () => {
    await transport.saveLLMProviders(workspace.id, providers)
    await transport.setSetting(workspace.id, "prompt_analyse_new_file", settingsMap.prompt_analyse_new_file ?? "")
    await transport.setSetting(workspace.id, "llm_attachment_format", settingsMap.llm_attachment_format ?? "webp")
    onToast("Đã lưu khóa API AI (mã hóa Keychain/DPAPI) và Prompt.", "ok")
  }

  const testVision = async (cfg: LLMProviderConfig) => {
    setTestingProvider(cfg.provider)
    try {
      const res = await transport.testLLMProvider(cfg)
      onToast(res.message, res.success ? "ok" : "warn")
    } finally {
      setTestingProvider(null)
    }
  }

  const renderDeleteGuard = (key: string, onConfirmed: () => Promise<void>) => {
    if (confirmDeleteKey === key) {
      return (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--rose-s)] border border-[var(--rose)]/35 text-[11px]">
          <button
            type="button"
            onClick={async () => {
              await onConfirmed()
              setConfirmDeleteKey(null)
            }}
            className="font-semibold text-[var(--rose)] hover:underline"
          >
            Xóa
          </button>
          <button type="button" onClick={() => setConfirmDeleteKey(null)} className="text-[var(--muted)]">
            Hủy
          </button>
        </div>
      )
    }
    return (
      <button type="button" onClick={() => setConfirmDeleteKey(key)} className="text-[var(--rose)] hover:opacity-80">
        <Trash2 size={13.5} />
      </button>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--line)] bg-[var(--sheet-bg)] overflow-x-auto shrink-0">
        <div className="seg">
          {[
            { id: "workspace", label: "Công ty & Chế độ KT" },
            { id: "ai", label: "AI & Prompt" },
            { id: "categories", label: "Danh mục" },
            { id: "projects", label: "Dự án" },
            { id: "fields", label: "Trường tùy chỉnh" },
            { id: "appearance", label: "Liquid Glass" },
            { id: "backup", label: "Sao lưu ZIP" }
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "on" : ""}
              onClick={() => {
                setTab(t.id as typeof tab)
                setConfirmDeleteKey(null)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 sm:p-6 max-w-[920px] space-y-5">
        {tab === "workspace" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-semibold">Thông tin Pháp nhân & Chế độ Kế toán</h2>
              <button type="button" onClick={() => setNewWsModal(true)} className="gb">
                <Plus size={13} />
                <span>Thêm MST mới</span>
              </button>
            </div>

            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Tên doanh nghiệp / Hộ kinh doanh</label>
                <input
                  value={wsForm.name}
                  onChange={(e) => setWsForm({ ...wsForm, name: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Mã số thuế</label>
                <input
                  value={wsForm.taxCode}
                  onChange={(e) => setWsForm({ ...wsForm, taxCode: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Mô hình</label>
                <select
                  value={wsForm.entityType}
                  onChange={(e) => setWsForm({ ...wsForm, entityType: e.target.value as typeof wsForm.entityType })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                >
                  <option value="enterprise" className="bg-[var(--panel-solid)]">Doanh nghiệp</option>
                  <option value="household" className="bg-[var(--panel-solid)]">Hộ kinh doanh (Lộ trình 2026)</option>
                  <option value="freelancer" className="bg-[var(--panel-solid)]">Cá nhân / Freelancer</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Chế độ kế toán áp dụng</label>
                <select
                  value={wsForm.accountingRegime}
                  onChange={(e) => setWsForm({ ...wsForm, accountingRegime: e.target.value as AccountingRegime })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                >
                  {Object.entries(REGIME_METADATA).map(([k, v]) => (
                    <option key={k} value={k} className="bg-[var(--panel-solid)]">{v.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Địa chỉ</label>
                <input
                  value={wsForm.address}
                  onChange={(e) => setWsForm({ ...wsForm, address: e.target.value })}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--muted)] mb-1">Khóa sổ Kỳ kế toán đến hết ngày (Lock Date)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={wsForm.lockDate}
                    onChange={(e) => setWsForm({ ...wsForm, lockDate: e.target.value })}
                    className="flex-1 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
                  />
                  {wsForm.lockDate && (
                    <button
                      type="button"
                      onClick={() => setWsForm({ ...wsForm, lockDate: "" })}
                      className="gb shrink-0"
                    >
                      Mở khóa
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* VietQR Default Bank Details */}
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
              <div>
                <div className="text-[13px] font-semibold">Tài khoản Ngân hàng mặc định (VietQR)</div>
                <div className="text-[11px] text-[var(--muted)]">Tự động điền vào Trình tạo Hóa đơn & QR thanh toán của công ty</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Ngân hàng (NAPAS BIN)</label>
                  <select
                    value={bankForm.bankBin}
                    onChange={(e) => {
                      const bank = VIETNAM_BANKS.find((b) => b.bin === e.target.value)
                      setBankForm({
                        ...bankForm,
                        bankBin: e.target.value,
                        bankName: bank?.shortName ?? ""
                      })
                    }}
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                  >
                    {VIETNAM_BANKS.map((b) => (
                      <option key={b.bin} value={b.bin} className="bg-[var(--panel-solid)]">
                        {b.shortName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Số tài khoản</label>
                  <input
                    value={bankForm.accountNo}
                    onChange={(e) => setBankForm({ ...bankForm, accountNo: e.target.value })}
                    placeholder="VD: 1018889999"
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--muted)] mb-1">Chủ tài khoản</label>
                  <input
                    value={bankForm.accountName}
                    onChange={(e) => setBankForm({ ...bankForm, accountName: e.target.value })}
                    className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
                  />
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <button type="button" onClick={saveWorkspace} className="pb">
                  <CheckCircle2 size={13.5} />
                  <span>Lưu thay đổi</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div className="space-y-4">
            <div className="space-y-2.5">
              {providers.map((cfg, idx) => {
                const preset = LLM_PROVIDER_PRESETS.find((p) => p.provider === cfg.provider)
                return (
                  <div key={cfg.provider} className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <label className="sw">
                          <input
                            type="checkbox"
                            checked={cfg.enabled !== false}
                            onChange={(e) => {
                              const next = [...providers]
                              next[idx] = { ...cfg, enabled: e.target.checked }
                              setProviders(next)
                            }}
                          />
                          <i />
                        </label>
                        <span className="font-semibold text-[13px]">{preset?.label ?? cfg.provider}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => testVision(cfg)}
                        disabled={testingProvider === cfg.provider}
                        className="gb"
                      >
                        <TestTube2 size={12.5} />
                        <span>{testingProvider === cfg.provider ? "Đang test..." : "Test Vision"}</span>
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        type="password"
                        placeholder={preset?.requiresApiKey ? "API Key" : "API Key (tùy chọn cho Local)"}
                        value={cfg.apiKey}
                        onChange={(e) => {
                          const next = [...providers]
                          next[idx] = { ...cfg, apiKey: e.target.value }
                          setProviders(next)
                        }}
                        className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                      />
                      <input
                        placeholder="Model ID"
                        value={cfg.model}
                        onChange={(e) => {
                          const next = [...providers]
                          next[idx] = { ...cfg, model: e.target.value }
                          setProviders(next)
                        }}
                        className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                      />
                      {cfg.provider === "openai_compatible" && (
                        <input
                          placeholder="Base URL (VD: http://localhost:11434/v1)"
                          value={cfg.baseUrl ?? ""}
                          onChange={(e) => {
                            const next = [...providers]
                            next[idx] = { ...cfg, baseUrl: e.target.value }
                            setProviders(next)
                          }}
                          className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[12.5px] font-semibold">System Prompt Bóc tách Chứng từ</label>
                <select
                  value={settingsMap.llm_attachment_format ?? "webp"}
                  onChange={(e) => setSettingsMap({ ...settingsMap, llm_attachment_format: e.target.value })}
                  className="h-7 px-2.5 rounded-full bg-[var(--raised)] border border-[var(--line)] text-[11.5px]"
                >
                  <option value="webp" className="bg-[var(--panel-solid)]">WebP (Cloud LLM)</option>
                  <option value="png" className="bg-[var(--panel-solid)]">PNG (Ollama / Local)</option>
                  <option value="jpeg" className="bg-[var(--panel-solid)]">JPEG</option>
                </select>
              </div>
              <textarea
                rows={8}
                value={settingsMap.prompt_analyse_new_file ?? ""}
                onChange={(e) => setSettingsMap({ ...settingsMap, prompt_analyse_new_file: e.target.value })}
                className="w-full p-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px]"
              />
              <div className="flex justify-end">
                <button type="button" onClick={saveAiConfig} className="pb">Lưu cấu hình AI</button>
              </div>
            </div>
          </div>
        )}

        {tab === "categories" && (
          <div className="space-y-4">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 grid grid-cols-1 sm:grid-cols-5 gap-2">
              <input
                placeholder="Mã (vd: marketing)"
                value={newCat.code}
                onChange={(e) => setNewCat({ ...newCat, code: e.target.value })}
                className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                placeholder="Tên danh mục"
                value={newCat.name}
                onChange={(e) => setNewCat({ ...newCat, name: e.target.value })}
                className="sm:col-span-2 h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                placeholder="TK Nợ mặc định"
                value={newCat.defaultDebitAccount}
                onChange={(e) => setNewCat({ ...newCat, defaultDebitAccount: e.target.value })}
                className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px] tnum"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!newCat.code || !newCat.name) return
                  const next = await transport.upsertCategory(workspace.id, newCat)
                  setCategories(next)
                  setNewCat({ code: "", name: "", color: "#2563EB", defaultDebitAccount: "6427", llmPrompt: "" })
                }}
                className="pb justify-center"
              >
                Thêm
              </button>
            </div>
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] divide-y divide-[var(--line)]">
              {categories.map((c) => {
                const cid = String(c.id)
                return (
                  <div key={cid} className="px-4 py-2.5 flex items-center justify-between text-[12.5px]">
                    <div className="flex items-center gap-2.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: String(c.color) }} />
                      <span className="font-medium">{String(c.name)}</span>
                      <span className="tag font-mono">{String(c.code)}</span>
                      <span className="tag tnum">TK {String(c.defaultDebitAccount ?? "6428")}</span>
                    </div>
                    {renderDeleteGuard(`cat:${cid}`, async () => {
                      setCategories(await transport.deleteCategory(workspace.id, cid))
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === "projects" && (
          <div className="space-y-4">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 grid grid-cols-1 sm:grid-cols-5 gap-2">
              <input
                placeholder="Mã dự án (vd: hn_2026)"
                value={newProject.code}
                onChange={(e) => setNewProject({ ...newProject, code: e.target.value })}
                className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                placeholder="Tên dự án / Bộ phận"
                value={newProject.name}
                onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                className="sm:col-span-2 h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                placeholder="Gợi ý phân loại AI..."
                value={newProject.llmPrompt}
                onChange={(e) => setNewProject({ ...newProject, llmPrompt: e.target.value })}
                className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!newProject.code || !newProject.name) return
                  const next = await transport.upsertProject(workspace.id, newProject)
                  setProjects(next)
                  setNewProject({ code: "", name: "", color: "#0EA5E9", llmPrompt: "" })
                }}
                className="pb justify-center"
              >
                Thêm dự án
              </button>
            </div>

            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] divide-y divide-[var(--line)]">
              {projects.map((p) => {
                const pid = String(p.id)
                return (
                  <div key={pid} className="px-4 py-2.5 flex items-center justify-between text-[12.5px]">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: String(p.color ?? "#0EA5E9") }} />
                      <span className="font-medium truncate">{String(p.name)}</span>
                      <span className="tag font-mono shrink-0">{String(p.code)}</span>
                    </div>
                    {renderDeleteGuard(`proj:${pid}`, async () => {
                      setProjects(await transport.deleteProject(workspace.id, pid))
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === "fields" && (
          <div className="space-y-4">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 grid grid-cols-1 sm:grid-cols-5 gap-2">
              <input
                placeholder="Mã trường (vd: so_hop_dong)"
                value={newField.code}
                onChange={(e) => setNewField({ ...newField, code: e.target.value })}
                className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                placeholder="Tên hiển thị"
                value={newField.name}
                onChange={(e) => setNewField({ ...newField, name: e.target.value })}
                className="h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <input
                placeholder="Prompt cho AI trích xuất..."
                value={newField.llmPrompt}
                onChange={(e) => setNewField({ ...newField, llmPrompt: e.target.value })}
                className="sm:col-span-2 h-8 px-2.5 rounded-[8px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!newField.code || !newField.name) return
                  const next = await transport.upsertField(workspace.id, {
                    ...newField,
                    isExtra: true,
                    isVisibleInList: true,
                    isVisibleInAnalysis: true
                  })
                  setFields(next)
                  setNewField({ code: "", name: "", type: "string", llmPrompt: "" })
                }}
                className="pb justify-center"
              >
                Thêm trường
              </button>
            </div>
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] divide-y divide-[var(--line)]">
              {fields.map((f) => {
                const fid = String(f.id)
                return (
                  <div key={fid} className="px-4 py-2.5 flex items-center justify-between gap-2 text-[12px]">
                    <div className="min-w-0">
                      <span className="font-semibold">{String(f.name)}</span>{" "}
                      <span className="tag font-mono">{String(f.code)}</span>{" "}
                      <span className="tag">{String(f.type)}</span>
                      {Boolean(f.llmPrompt) && <div className="text-[11px] text-[var(--muted)] truncate">{String(f.llmPrompt)}</div>}
                    </div>
                    {Boolean(f.isExtra) &&
                      renderDeleteGuard(`fld:${fid}`, async () => {
                        setFields(await transport.deleteField(workspace.id, fid))
                      })}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === "appearance" && (
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-[13px]">Chế độ Sáng / Tối</div>
                <div className="text-[11.5px] text-[var(--muted)]">Minimal Specular Liquid Glass Light (#F4F5F8) / Dark (#0C0E14)</div>
              </div>
              <div className="seg">
                <button type="button" className={!isLight ? "on" : ""} onClick={() => setIsLight(false)}>Dark</button>
                <button type="button" className={isLight ? "on" : ""} onClick={() => setIsLight(true)}>Light</button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-[13px]">Cường độ Kính mờ</div>
                <div className="text-[11.5px] text-[var(--muted)]">Chỉ áp dụng lên lớp điều hướng & chrome nổi (Tahoe 26)</div>
              </div>
              <div className="seg">
                {(["clear", "balanced", "solid"] as const).map((g) => (
                  <button key={g} type="button" className={glassIntensity === g ? "on" : ""} onClick={() => setGlassIntensity(g)}>
                    {g === "clear" ? "Trong" : g === "balanced" ? "Cân bằng" : "Đặc"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-[13px]">Giảm độ trong suốt (Reduce Transparency)</div>
                <div className="text-[11.5px] text-[var(--muted)]">Tự đồng bộ với Accessibility của macOS</div>
              </div>
              <label className="sw">
                <input
                  type="checkbox"
                  checked={reduceTransparency}
                  onChange={(e) => setReduceTransparency(e.target.checked)}
                />
                <i />
              </label>
            </div>
          </div>
        )}

        {tab === "backup" && (
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-5 space-y-4">
            <div>
              <h3 className="text-[14px] font-semibold">Sao lưu & Phục hồi Toàn bộ Workspace</h3>
              <p className="text-[12px] text-[var(--muted)] mt-1">
                Đóng gói toàn bộ cơ sở dữ liệu kế toán, XML, bút toán và tệp chứng từ gốc vào 1 tệp ZIP chuẩn.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={async () => {
                  const res = await transport.exportBackupZip(workspace.id)
                  if (!res.canceled) onToast(`Đã lưu bản sao lưu tại ${res.savedPath}`, "ok")
                }}
                className="pb"
              >
                <Download size={13.5} />
                <span>Xuất Sao lưu (.zip)</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const res = await transport.restoreBackupZip()
                  if (!("canceled" in res)) {
                    onWorkspaceUpdated()
                    onToast(`Đã khôi phục ${res.restoredTransactions} giao dịch & ${res.restoredFiles} tệp.`, "ok")
                  }
                }}
                className="gb"
              >
                <Upload size={13.5} />
                <span>Khôi phục từ tệp (.zip)</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {newWsModal && (
        <div className="fixed inset-0 z-[110] grid place-items-center bg-black/45 p-4" onClick={() => setNewWsModal(false)}>
          <form onSubmit={createWorkspace} onClick={(e) => e.stopPropagation()} className="glass-overlay w-full max-w-[420px] rounded-[16px] p-5 space-y-3">
            <h3 className="text-[15px] font-bold">Thêm Công ty / MST mới</h3>
            <input
              required
              placeholder="Tên công ty / Hộ kinh doanh"
              value={newWsForm.name}
              onChange={(e) => setNewWsForm({ ...newWsForm, name: e.target.value })}
              className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
            />
            <input
              required
              placeholder="Mã số thuế"
              value={newWsForm.taxCode}
              onChange={(e) => setNewWsForm({ ...newWsForm, taxCode: e.target.value })}
              className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px] tnum"
            />
            <select
              value={newWsForm.accountingRegime}
              onChange={(e) => setNewWsForm({ ...newWsForm, accountingRegime: e.target.value as AccountingRegime })}
              className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12.5px]"
            >
              {Object.entries(REGIME_METADATA).map(([k, v]) => (
                <option key={k} value={k} className="bg-[var(--panel-solid)]">{v.label}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setNewWsModal(false)} className="gb">Hủy</button>
              <button type="submit" className="pb">Tạo Workspace</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
