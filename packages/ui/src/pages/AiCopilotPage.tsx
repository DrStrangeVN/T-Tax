import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Sparkles,
  ShieldAlert,
  TrendingUp,
  Plug,
  Send,
  Plus,
  Trash2,
  RefreshCw,
  Play,
  Square,
  Copy,
  Check,
  KeyRound,
  Terminal,
  Wrench,
  ArrowUpRight,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Paperclip,
  Image as ImageIcon,
  X,
  FilePlus2
} from "lucide-react"
import type {
  AiCopilotAction,
  AiCopilotMessage,
  AiCopilotSession,
  CashflowAnalytics,
  CopilotAttachmentInput,
  ExternalMcpServerConfig,
  LLMProviderType,
  McpHostStatus,
  TaxAuditReport,
  WorkspaceDTO
} from "@t-tax/core/browser"
import { useTransport, fileToPayload } from "../transport/client.js"
import { formatDateVi, formatMoney } from "../utils/format.js"

type CopilotTab = "chat" | "audit" | "forecast" | "mcp"
type SetupClientTab = "claude_desktop" | "cursor" | "antigravity" | "claude_code" | "gemini_cli"

interface AiCopilotPageProps {
  workspace: WorkspaceDTO
  initialTab?: CopilotTab
  onNavigatePage: (page: "dashboard" | "unsorted" | "transactions" | "converter" | "accounting" | "counterparties" | "apps" | "vault" | "settings") => void
  onOpenTransaction: (txId: string) => void
  onOpenAccountingTab: (tab: "journal" | "trial_balance" | "vat" | "hkd" | "bank" | "aging" | "assets") => void
  onToast: (msg: string, tone?: "ok" | "warn" | "err") => void
}

const QUICK_PROMPTS = [
  "Tổng hợp toàn diện tình hình tài chính, rủi ro thuế & đề xuất tối ưu chi phí",
  "Tra cứu: Hóa đơn viết tay không MST có được tính chi phí TNDN & cần hồ sơ gì?",
  "Kiểm toán rủi ro hóa đơn & thanh toán tiền mặt ≥ 5 triệu theo Luật 48/2024",
  "Dự báo dòng tiền, burn rate & runway 6 tháng tới",
  "Báo cáo công nợ phải thu / phải trả theo tuổi nợ & đề xuất thu hồi",
  "Xem Bảng Cân đối Tài khoản VAS & tổng hợp TSCĐ cần trích khấu hao"
]

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-[var(--text)] tnum">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code key={key++} className="px-1.5 py-0.5 rounded bg-[var(--raised)] font-mono text-[11.5px] text-[var(--cyan)]">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith("*") && token.endsWith("*")) {
      parts.push(
        <em key={key++} className="italic text-[var(--muted)]">
          {token.slice(1, -1)}
        </em>
      )
    }
    lastIndex = tokenRegex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

function CopilotRichText({ content }: { content: string }) {
  const lines = content.split("\n")
  return (
    <div className="space-y-1.5 break-words">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trimEnd()
        if (!line.trim()) return <div key={idx} className="h-1" />
        const h3 = line.match(/^#{2,4}\s+(.+)$/)
        if (h3) {
          return (
            <div key={idx} className="text-[13.5px] font-bold text-[var(--text)] pt-0.5">
              {renderInlineMarkdown(h3[1]!)}
            </div>
          )
        }
        const bullet = line.match(/^[-•*]\s+(.+)$/)
        if (bullet) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--cyan)] mt-2 shrink-0" />
              <div className="flex-1 min-w-0">{renderInlineMarkdown(bullet[1]!)}</div>
            </div>
          )
        }
        const numbered = line.match(/^(\d+)\.\s+(.+)$/)
        if (numbered) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="text-[11.5px] font-mono text-[var(--cyan)] tnum shrink-0 mt-0.5">{numbered[1]}.</span>
              <div className="flex-1 min-w-0">{renderInlineMarkdown(numbered[2]!)}</div>
            </div>
          )
        }
        return <p key={idx}>{renderInlineMarkdown(line)}</p>
      })}
    </div>
  )
}

export function AiCopilotPage({
  workspace,
  initialTab = "chat",
  onNavigatePage,
  onOpenTransaction,
  onOpenAccountingTab,
  onToast
}: AiCopilotPageProps) {
  const transport = useTransport()
  const [tab, setTab] = useState<CopilotTab>(initialTab)

  // Chat state
  const [sessions, setSessions] = useState<AiCopilotSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiCopilotMessage[]>([])
  const [promptInput, setPromptInput] = useState("")
  const [pendingAttachment, setPendingAttachment] = useState<{
    filename: string
    mediaType: string
    base64: string
    previewUrl?: string
  } | null>(null)
  const [preferredProvider, setPreferredProvider] = useState<LLMProviderType | "auto">("auto")
  const [hasMuse2Api, setHasMuse2Api] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Audit state
  const [auditReport, setAuditReport] = useState<TaxAuditReport | null>(null)
  const [auditSeverity, setAuditSeverity] = useState<"all" | "critical" | "high" | "medium" | "info">("all")
  const [auditBusy, setAuditBusy] = useState(false)

  // Forecast state
  const [forecastMonths, setForecastMonths] = useState<3 | 6 | 12>(6)
  const [cashflow, setCashflow] = useState<CashflowAnalytics | null>(null)
  const [forecastBusy, setForecastBusy] = useState(false)

  // MCP Hub state
  const [mcpCatalog, setMcpCatalog] = useState<Awaited<ReturnType<typeof transport.getMcpCatalog>> | null>(null)
  const [mcpStatus, setMcpStatus] = useState<McpHostStatus | null>(null)
  const [mcpPort, setMcpPort] = useState("3939")
  const [mcpBusy, setMcpBusy] = useState(false)
  const [setupClient, setSetupClient] = useState<SetupClientTab>("claude_desktop")
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Playground state
  const [selectedToolName, setSelectedToolName] = useState("ttax_get_financial_overview")
  const [playgroundArgsJson, setPlaygroundArgsJson] = useState('{\n  "response_format": "markdown"\n}')
  const [playgroundOut, setPlaygroundOut] = useState<{ isError: boolean; text: string; durationMs: number } | null>(null)
  const [playgroundBusy, setPlaygroundBusy] = useState(false)

  // External MCP Clients state
  const [extServers, setExtServers] = useState<ExternalMcpServerConfig[]>([])
  const [newExt, setNewExt] = useState<{
    name: string
    transport: "stdio" | "http"
    command: string
    argsText: string
    url: string
    bearerToken: string
  }>({
    name: "",
    transport: "http",
    command: "npx",
    argsText: "-y @modelcontextprotocol/server-filesystem /tmp",
    url: "http://127.0.0.1:3939/mcp",
    bearerToken: ""
  })
  const [testingExtId, setTestingExtId] = useState<string | null>(null)

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1800)
      onToast("Đã sao chép vào Clipboard.", "ok")
    } catch {
      onToast("Không thể sao chép tự động.", "warn")
    }
  }

  const loadSessions = useCallback(async () => {
    const list = await transport.listAiSessions(workspace.id)
    setSessions(list)
    if (list.length > 0 && (!activeSessionId || !list.some((s) => s.id === activeSessionId))) {
      setActiveSessionId(list[0]!.id)
    } else if (list.length === 0) {
      setActiveSessionId(null)
      setMessages([])
    }
  }, [workspace.id, transport, activeSessionId])

  useEffect(() => {
    if (tab === "chat") {
      loadSessions().catch(() => {})
      transport
        .getLLMProviders(workspace.id)
        .then((list) => setHasMuse2Api(list.some((p) => p.provider === "muse2api" && p.enabled !== false)))
        .catch(() => {})
    }
  }, [tab, loadSessions, transport, workspace.id])

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([])
      return
    }
    transport.listAiMessages(activeSessionId).then(setMessages).catch(() => {})
  }, [activeSessionId, transport])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length])

  const loadAudit = useCallback(async () => {
    setAuditBusy(true)
    try {
      setAuditReport(await transport.runTaxAudit(workspace.id))
    } finally {
      setAuditBusy(false)
    }
  }, [workspace.id, transport])

  const loadForecast = useCallback(async () => {
    setForecastBusy(true)
    try {
      setCashflow(await transport.getCashflowAnalytics(workspace.id, forecastMonths))
    } finally {
      setForecastBusy(false)
    }
  }, [workspace.id, forecastMonths, transport])

  const loadMcp = useCallback(async () => {
    const [cat, st, exts] = await Promise.all([
      transport.getMcpCatalog(),
      transport.getMcpHostStatus(),
      transport.listExternalMcpServers(workspace.id)
    ])
    setMcpCatalog(cat)
    setMcpStatus(st)
    setMcpPort(String(st.port || 3939))
    setExtServers(exts)
  }, [workspace.id, transport])

  useEffect(() => {
    if (tab === "audit") loadAudit().catch(() => {})
    else if (tab === "forecast") loadForecast().catch(() => {})
    else if (tab === "mcp") loadMcp().catch(() => {})
  }, [tab, loadAudit, loadForecast, loadMcp])

  const attachFileToChat = async (file: File) => {
    if (!/\.(png|jpe?g|webp|heic|pdf)$/i.test(file.name) && !file.type.startsWith("image/") && file.type !== "application/pdf") {
      onToast("Chỉ hỗ trợ ảnh hóa đơn (JPG, PNG, WebP, HEIC) hoặc PDF.", "warn")
      return
    }
    const payload = await fileToPayload(file)
    const mime = payload.mimetype || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg")
    setPendingAttachment({
      filename: payload.filename,
      mediaType: mime,
      base64: payload.base64,
      previewUrl: mime.startsWith("image/") ? `data:${mime};base64,${payload.base64}` : undefined
    })
  }

  const sendPrompt = async (textOverride?: string) => {
    const text = (textOverride ?? promptInput).trim()
    const att = pendingAttachment
    if ((!text && !att) || chatBusy) return
    setPromptInput("")
    setPendingAttachment(null)
    setChatBusy(true)
    try {
      const attachments: CopilotAttachmentInput[] | undefined = att
        ? [{ filename: att.filename, mediaType: att.mediaType, base64: att.base64 }]
        : undefined
      const res = await transport.chatWithCopilot(workspace.id, {
        sessionId: activeSessionId ?? undefined,
        prompt: text || "Đọc chính xác ảnh hóa đơn đính kèm, trích xuất các giá trị để nhập liệu và hướng dẫn hạch toán thuế.",
        attachments,
        preferredProvider: preferredProvider === "auto" ? undefined : preferredProvider
      })
      setActiveSessionId(res.session.id)
      setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)])
      setMessages((prev) => [...prev, res.userMessage, res.assistantMessage])
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Lỗi gọi Trợ lý AI", "err")
    } finally {
      setChatBusy(false)
    }
  }

  const handleCopilotAction = async (act: AiCopilotAction) => {
    if (act.kind === "ingest_bill_draft" && act.payload) {
      try {
        const p = act.payload as Record<string, unknown>
        const savedFileId = typeof p.savedFileId === "string" ? p.savedFileId : ""
        const totalAmount = Number(p.totalAmount ?? 0) || 0
        const vatAmount = Number(p.vatAmount ?? 0) || 0
        const preTaxAmount = Number(p.preTaxAmount ?? Math.max(0, totalAmount - vatAmount)) || 0
        const isHandwritten = p.documentKind === "handwritten_bill" || p.documentKind === "printed_receipt"
        const input = {
          name: String(p.name ?? "Chứng từ từ Trợ lý AI"),
          merchant: p.merchant ? String(p.merchant) : "",
          merchantTaxCode: p.merchantTaxCode ? String(p.merchantTaxCode) : "",
          direction: "input" as const,
          invoiceSymbol: p.invoiceSymbol ? String(p.invoiceSymbol) : "",
          invoiceNumber: p.invoiceNumber ? String(p.invoiceNumber) : "",
          issuedAt: p.issuedAt ? String(p.issuedAt) : new Date().toISOString().slice(0, 10),
          currencyCode: String(p.currencyCode ?? workspace.baseCurrency ?? "VND"),
          preTaxAmount,
          vatRateCode: vatAmount === 0 && isHandwritten ? "KCT" : "10%",
          vatAmount,
          totalAmount,
          categoryCode: String(p.categoryCode ?? "other"),
          projectCode: "general",
          paymentMethod: String(p.paymentMethod ?? (isHandwritten ? "Tiền mặt" : "Chuyển khoản")),
          note: p.amountInWords ? `Bằng chữ: ${String(p.amountInWords)}` : "Tạo từ ảnh bóc tách AI Copilot",
          items: Array.isArray(p.items) ? p.items : []
        }
        const created = savedFileId
          ? await transport.approveFileToTransaction(workspace.id, savedFileId, input)
          : await transport.createTransaction(workspace.id, input)
        onToast("Đã ghi chứng từ vào Sổ giao dịch & tự động hạch toán VAS!", "ok")
        if (created && created.id) {
          onOpenTransaction(String(created.id))
        }
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Không ghi được chứng từ vào sổ", "err")
      }
      return
    }
    if (act.kind === "open_tx") onOpenTransaction(act.target)
    else if (act.kind === "open_accounting") {
      onOpenAccountingTab(act.target as "journal" | "trial_balance" | "vat" | "hkd" | "bank" | "aging" | "assets")
    } else if (act.kind === "navigate") {
      onNavigatePage(act.target as Parameters<typeof onNavigatePage>[0])
    }
  }

  const filteredAnomalies = useMemo(() => {
    if (!auditReport) return []
    if (auditSeverity === "all") return auditReport.anomalies
    return auditReport.anomalies.filter((a) => a.severity === auditSeverity)
  }, [auditReport, auditSeverity])

  const setupSnippet = useMemo(() => {
    const url = mcpStatus?.url || "http://127.0.0.1:3939/mcp"
    const token = mcpStatus?.bearerToken || "YOUR_TOKEN"
    const dataDirMatch = mcpCatalog?.stdioCliHint?.match(/TTAX_DATA_DIR="([^"]+)"/)
    const dataDir = dataDirMatch?.[1] || "~/Library/Application Support/T-Tax"

    if (setupClient === "claude_desktop") {
      return JSON.stringify(
        {
          mcpServers: {
            "t-tax": {
              command: "npx",
              args: ["-y", "t-tax-mcp"],
              env: { TTAX_DATA_DIR: dataDir }
            }
          }
        },
        null,
        2
      )
    }
    if (setupClient === "cursor") {
      return JSON.stringify(
        {
          mcpServers: {
            "t-tax": {
              url,
              headers: { Authorization: `Bearer ${token}` }
            }
          }
        },
        null,
        2
      )
    }
    if (setupClient === "antigravity") {
      return JSON.stringify(
        {
          mcpServers: {
            "t-tax": {
              serverUrl: url,
              headers: { Authorization: `Bearer ${token}` }
            }
          }
        },
        null,
        2
      )
    }
    if (setupClient === "claude_code") {
      return `claude mcp add --transport http t-tax ${url} --header "Authorization: Bearer ${token}"`
    }
    return `gemini mcp add --transport http t-tax ${url} --header "Authorization: Bearer ${token}"`
  }, [setupClient, mcpStatus, mcpCatalog])

  const runPlayground = async () => {
    setPlaygroundBusy(true)
    try {
      const parsedArgs = playgroundArgsJson.trim() ? (JSON.parse(playgroundArgsJson) as Record<string, unknown>) : {}
      const res = await transport.invokeBuiltInMcpTool(workspace.id, selectedToolName, parsedArgs)
      setPlaygroundOut({ isError: res.isError, text: res.text, durationMs: res.durationMs })
    } catch (err) {
      setPlaygroundOut({
        isError: true,
        text: err instanceof Error ? err.message : String(err),
        durationMs: 0
      })
    } finally {
      setPlaygroundBusy(false)
    }
  }

  const handleAddExternalMcp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newExt.name.trim()) {
      onToast("Nhập tên kết nối MCP bên ngoài.", "warn")
      return
    }
    const cfg: ExternalMcpServerConfig = {
      id: "",
      name: newExt.name.trim(),
      transport: newExt.transport,
      enabled: true,
      ...(newExt.transport === "http"
        ? { url: newExt.url.trim(), bearerToken: newExt.bearerToken.trim() || undefined }
        : { command: newExt.command.trim(), args: newExt.argsText.trim().split(/\s+/).filter(Boolean) })
    }
    const updated = await transport.saveExternalMcpServer(workspace.id, cfg)
    setExtServers(updated)
    setNewExt({ ...newExt, name: "" })
    onToast("Đã lưu cấu hình MCP Client. Bấm Kiểm tra & Quét Tools để đồng bộ.", "ok")
  }

  const handleTestExternal = async (srv: ExternalMcpServerConfig) => {
    setTestingExtId(srv.id)
    try {
      const res = await transport.testExternalMcpServer(workspace.id, srv)
      onToast(res.message, res.ok ? "ok" : "err")
      setExtServers(await transport.listExternalMcpServers(workspace.id))
    } finally {
      setTestingExtId(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Sub-navigation bar */}
      <div className="px-4 py-2.5 border-b border-[var(--line)] bg-[var(--sheet-bg)] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="seg">
          <button type="button" className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
            <Sparkles size={13} />
            <span>Hội thoại AI</span>
          </button>
          <button type="button" className={tab === "audit" ? "on" : ""} onClick={() => setTab("audit")}>
            <ShieldAlert size={13} />
            <span>Kiểm toán Rủi ro</span>
            {auditReport && auditReport.summary.critical + auditReport.summary.high > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--rose-s)] text-[var(--rose)] tnum">
                {auditReport.summary.critical + auditReport.summary.high}
              </span>
            )}
          </button>
          <button type="button" className={tab === "forecast" ? "on" : ""} onClick={() => setTab("forecast")}>
            <TrendingUp size={13} />
            <span>Dự báo & Dòng tiền</span>
          </button>
          <button type="button" className={tab === "mcp" ? "on" : ""} onClick={() => setTab("mcp")}>
            <Plug size={13} />
            <span>MCP Hub</span>
            {mcpStatus?.running && <span className="ml-1 w-2 h-2 rounded-full bg-[var(--green)]" />}
          </button>
        </div>

        <div className="flex items-center gap-2 text-[11.5px] text-[var(--muted)]">
          <span className="tag">
            {workspace.accountingRegime.replace("_", " ")} · MST {workspace.taxCode}
          </span>
        </div>
      </div>

      {/* TAB 1: AI COPILOT CHAT */}
      {tab === "chat" && (
        <div className="flex-1 min-h-0 flex">
          {/* Session Rail */}
          <div className="hidden md:flex w-[240px] border-r border-[var(--line)] flex-col min-h-0 bg-[var(--panel)] shrink-0">
            <div className="p-2.5 border-b border-[var(--line)]">
              <button
                type="button"
                onClick={() => {
                  setActiveSessionId(null)
                  setMessages([])
                }}
                className="gb gb-p w-full justify-center"
              >
                <Plus size={13.5} />
                <span>Hội thoại mới</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {sessions.length === 0 ? (
                <div className="p-3 text-[11.5px] text-[var(--dim)] text-center">
                  Chưa có lịch sử hỏi đáp AI cho công ty này.
                </div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setActiveSessionId(s.id)}
                    className={`group flex items-center gap-1.5 px-2.5 py-2 rounded-[9px] text-[12px] cursor-pointer ${
                      activeSessionId === s.id ? "bg-[var(--sel)] text-[var(--text)] font-medium" : "text-[var(--muted)] hover:bg-[var(--hover)]"
                    }`}
                  >
                    <Sparkles size={12.5} className="text-[var(--cyan)] shrink-0" />
                    <span className="flex-1 truncate">{s.title}</span>
                    <button
                      type="button"
                      title="Xóa hội thoại"
                      onClick={async (e) => {
                        e.stopPropagation()
                        await transport.deleteAiSession(workspace.id, s.id)
                        if (activeSessionId === s.id) {
                          setActiveSessionId(null)
                          setMessages([])
                        }
                        loadSessions()
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[var(--rose)] p-0.5"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Main Conversation Pane */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {messages.length === 0 ? (
                <div className="max-w-[680px] mx-auto pt-6 space-y-5">
                  <div className="text-center space-y-1.5">
                    <div className="w-11 h-11 rounded-[14px] mx-auto grid place-items-center bg-[var(--cyan-s)] text-[var(--cyan)] border border-[var(--cyan)]/30">
                      <Sparkles size={20} />
                    </div>
                    <h2 className="text-[16px] font-bold">Trợ lý Kế toán & Thuế T-Tax AI</h2>
                    <p className="text-[12.5px] text-[var(--muted)]">
                      Tải ảnh/PDF hóa đơn viết tay để bóc tách giá trị nhập sổ ngay, tra cứu luật thuế VN, tổng hợp báo cáo & đề xuất từ sổ sách SQLite (hỗ trợ Muse2API, Ollama cục bộ & MCP).
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {QUICK_PROMPTS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => void sendPrompt(q)}
                        className="text-left p-3 rounded-[12px] border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--hover)] hover:border-[var(--cyan)]/40 transition-colors text-[12px] text-[var(--text)] flex items-start gap-2"
                      >
                        <Sparkles size={13.5} className="text-[var(--cyan)] shrink-0 mt-0.5" />
                        <span>{q}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="max-w-[780px] mx-auto space-y-4">
                  {messages.map((m) => (
                    <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[88%] rounded-[14px] px-4 py-3 text-[12.5px] leading-relaxed space-y-2 ${
                          m.role === "user"
                            ? "bg-[var(--accent)] text-white"
                            : "bg-[var(--panel)] border border-[var(--line)] text-[var(--text)]"
                        }`}
                      >
                        {m.role === "assistant" && m.toolTraces && m.toolTraces.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pb-1.5 border-b border-[var(--line)]">
                            {m.toolTraces.map((tr, i) => (
                              <span
                                key={`${tr.toolName}-${i}`}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] border ${
                                  tr.source === "mcp"
                                    ? "bg-[var(--indigo-s)] border-[var(--indigo)]/30 text-[var(--indigo)]"
                                    : "bg-[var(--raised)] border-[var(--line)] text-[var(--muted)]"
                                }`}
                                title={tr.summary}
                              >
                                <Wrench size={10} />
                                <span className="font-mono">{tr.toolName}</span>
                                <span className="text-[var(--dim)] tnum">{tr.durationMs}ms</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {m.role === "assistant" ? (
                          <CopilotRichText content={m.content} />
                        ) : (
                          <div className="whitespace-pre-wrap break-words">{m.content}</div>
                        )}

                        {m.role === "assistant" && m.actions && m.actions.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {m.actions.map((act, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => void handleCopilotAction(act)}
                                className={act.kind === "ingest_bill_draft" ? "pb text-[11.5px] h-7 px-3" : "gb text-[11.5px]"}
                              >
                                {act.kind === "ingest_bill_draft" && <FilePlus2 size={12.5} />}
                                <span>{act.label}</span>
                                <ArrowUpRight size={12} />
                              </button>
                            ))}
                          </div>
                        )}

                        {m.role === "assistant" && m.providerUsed && (
                          <div className="text-[10px] text-[var(--dim)] flex items-center justify-between pt-0.5">
                            <span>Nguồn: {m.providerUsed}</span>
                            <span className="tnum">{formatDateVi(m.createdAt.slice(0, 10))}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {chatBusy && (
                    <div className="text-[12px] text-[var(--muted)] flex items-center gap-2">
                      <RefreshCw size={13} className="animate-spin text-[var(--cyan)]" />
                      <span>Đang truy vấn sổ sách SQLite & phân tích...</span>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                void sendPrompt()
              }}
              className="p-3.5 border-t border-[var(--line)] bg-[var(--sheet-bg)] shrink-0 space-y-2"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void attachFileToChat(f)
                  e.target.value = ""
                }}
              />
              {pendingAttachment && (
                <div className="max-w-[780px] mx-auto flex items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-[var(--panel)] border border-[var(--cyan)]/40 text-[12px]">
                  <div className="flex items-center gap-2 min-w-0">
                    {pendingAttachment.previewUrl ? (
                      <img
                        src={pendingAttachment.previewUrl}
                        alt={pendingAttachment.filename}
                        className="w-8 h-8 rounded-[6px] object-cover border border-[var(--line)] shrink-0"
                      />
                    ) : (
                      <ImageIcon size={16} className="text-[var(--cyan)] shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate">{pendingAttachment.filename}</div>
                      <div className="text-[10.5px] text-[var(--muted)]">Sẽ bóc tách giá trị, lưu vào Hộp thư AI & tư vấn hạch toán</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingAttachment(null)}
                    className="w-6 h-6 rounded-full grid place-items-center text-[var(--muted)] hover:bg-[var(--hover)] shrink-0"
                    title="Gỡ tệp đính kèm"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              <div className="max-w-[780px] mx-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={chatBusy}
                  title="Tải ảnh hoặc PDF hóa đơn để đọc & nhập liệu"
                  className="gb h-10 px-3 shrink-0"
                >
                  <Paperclip size={14} />
                  <span className="hidden sm:inline">Ảnh HĐ</span>
                </button>
                <input
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  onPaste={(e) => {
                    const imgFile = Array.from(e.clipboardData?.files ?? []).find(
                      (f) => f.type.startsWith("image/") || f.type === "application/pdf"
                    )
                    if (imgFile) {
                      e.preventDefault()
                      void attachFileToChat(imgFile)
                    }
                  }}
                  placeholder={
                    pendingAttachment
                      ? "Hỏi thêm về hóa đơn này (hoặc bấm Gửi để tự bóc tách & tư vấn hạch toán)..."
                      : "Hỏi luật thuế VN, tổng hợp báo cáo, đề xuất, hoặc dán/tải ảnh hóa đơn viết tay..."
                  }
                  className="flex-1 h-10 px-3.5 rounded-[11px] bg-[var(--raised)] border border-[var(--line)] text-[13px] outline-none focus:border-[var(--cyan)]"
                />
                {hasMuse2Api && (
                  <select
                    value={preferredProvider}
                    onChange={(e) => setPreferredProvider(e.target.value as LLMProviderType | "auto")}
                    title="Chọn bộ máy AI xử lý"
                    className="h-10 px-2.5 rounded-[11px] bg-[var(--raised)] border border-[var(--line)] text-[11.5px] shrink-0"
                  >
                    <option value="auto" className="bg-[var(--panel-solid)]">AI Tự động</option>
                    <option value="muse2api" className="bg-[var(--panel-solid)]">Muse2API</option>
                    <option value="openai_compatible" className="bg-[var(--panel-solid)]">Ollama cục bộ</option>
                  </select>
                )}
                <button type="submit" disabled={chatBusy || (!promptInput.trim() && !pendingAttachment)} className="gb gb-p h-10 px-4 shrink-0">
                  <Send size={14} />
                  <span>Gửi</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 2: AI TAX RISK & ANOMALY AUDIT */}
      {tab === "audit" && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-bold">Kiểm toán Rủi ro Thuế & Phát hiện Bất thường (AI + Luật VN)</h2>
              <p className="text-[12px] text-[var(--muted)]">
                Quét 100% hóa đơn theo Luật Thuế GTGT 48/2024/QH15 (ngưỡng tiền mặt 5 triệu từ 01/07/2025), trùng số HĐ, lệch danh mục và tăng giá đột biến.
              </p>
            </div>
            <button type="button" onClick={() => void loadAudit()} disabled={auditBusy} className="gb gb-p shrink-0">
              <RefreshCw size={13} className={auditBusy ? "animate-spin" : ""} />
              <span>Quét lại sổ sách</span>
            </button>
          </div>

          {auditReport && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                  <div className="text-[11px] text-[var(--muted)]">Điểm sức khỏe Tuân thủ</div>
                  <div
                    className={`text-[24px] font-bold tnum mt-1 ${
                      auditReport.healthScore >= 85
                        ? "text-[var(--green)]"
                        : auditReport.healthScore >= 60
                          ? "text-[var(--amber)]"
                          : "text-[var(--rose)]"
                    }`}
                  >
                    {auditReport.healthScore}/100
                  </div>
                  <div className="text-[11px] text-[var(--dim)] tnum">Quét {auditReport.totalTransactions} giao dịch</div>
                </div>

                <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                  <div className="text-[11px] text-[var(--muted)]">Cảnh báo phát hiện</div>
                  <div
                    className={`text-[24px] font-bold tnum mt-1 ${
                      auditReport.summary.critical + auditReport.summary.high > 0
                        ? "text-[var(--rose)]"
                        : auditReport.anomalies.length > 0
                          ? "text-[var(--amber)]"
                          : "text-[var(--green)]"
                    }`}
                  >
                    {auditReport.anomalies.length}
                  </div>
                  <div className="text-[11px] text-[var(--dim)] tnum">
                    {auditReport.summary.critical} nghiêm trọng · {auditReport.summary.high} cao · {auditReport.summary.medium} TB
                  </div>
                </div>

                <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                  <div className="text-[11px] text-[var(--muted)]">Thuế GTGT có rủi ro loại</div>
                  <div className="text-[22px] font-bold tnum mt-1 text-[var(--amber)]">
                    {formatMoney(auditReport.summary.totalVatAtRiskVnd)}
                  </div>
                  <div className="text-[11px] text-[var(--dim)]">Ước tính từ HĐ vi phạm</div>
                </div>

                <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                  <div className="text-[11px] text-[var(--muted)]">Thuế TNDN (20%) rủi ro</div>
                  <div className="text-[22px] font-bold tnum mt-1 text-[var(--rose)]">
                    {formatMoney(auditReport.summary.totalCitAtRiskVnd)}
                  </div>
                  <div className="text-[11px] text-[var(--dim)]">Chi phí có nguy cơ xuất toán</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="seg">
                  {(
                    [
                      { id: "all", label: `Tất cả (${auditReport.anomalies.length})` },
                      { id: "critical", label: `Nghiêm trọng (${auditReport.summary.critical})` },
                      { id: "high", label: `Cao (${auditReport.summary.high})` },
                      { id: "medium", label: `Trung bình (${auditReport.summary.medium})` },
                      { id: "info", label: `Lưu ý (${auditReport.summary.info})` }
                    ] as const
                  ).map((f) => (
                    <button key={f.id} type="button" className={auditSeverity === f.id ? "on" : ""} onClick={() => setAuditSeverity(f.id)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {filteredAnomalies.length === 0 ? (
                <div className="rounded-[14px] border border-[var(--green)]/30 bg-[var(--green-s)] p-6 text-center space-y-1.5">
                  <CheckCircle2 size={24} className="mx-auto text-[var(--green)]" />
                  <div className="font-semibold text-[13.5px]">Sổ sách sạch — Không có phát hiện rủi ro ở bộ lọc này</div>
                  <div className="text-[12px] text-[var(--muted)]">Tất cả chứng từ đều đạt chuẩn đối chiếu số học, ngưỡng thanh toán và MST.</div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredAnomalies.map((a) => (
                    <div key={a.id} className="rounded-[13px] border border-[var(--line)] bg-[var(--panel)] p-3.5 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <AlertTriangle
                            size={15}
                            className={
                              a.severity === "critical"
                                ? "text-[var(--rose)] shrink-0"
                                : a.severity === "high"
                                  ? "text-[var(--amber)] shrink-0"
                                  : "text-[var(--cyan)] shrink-0"
                            }
                          />
                          <span className="font-semibold text-[13px]">{a.title}</span>
                          <span
                            className={`tag ${
                              a.severity === "critical" ? "tag-err" : a.severity === "high" || a.severity === "medium" ? "tag-warn" : ""
                            }`}
                          >
                            {a.severity.toUpperCase()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold tnum">{formatMoney(a.amountVnd)}</span>
                          {a.transactionIds[0] && (
                            <button
                              type="button"
                              onClick={() => onOpenTransaction(a.transactionIds[0]!)}
                              className="gb text-[11.5px]"
                            >
                              <span>Mở chứng từ</span>
                              <ArrowUpRight size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-[12px] text-[var(--muted)]">{a.description}</div>
                      <div className="text-[11.5px] text-[var(--cyan)] bg-[var(--cyan-s)] px-2.5 py-1.5 rounded-[8px]">
                        <strong>Khuyến nghị:</strong> {a.recommendation}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 3: CASHFLOW FORECAST, BURN RATE, RUNWAY & RECURRING */}
      {tab === "forecast" && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-bold">Dự báo Dòng tiền, Burn Rate, Runway & Định phí</h2>
              <p className="text-[12px] text-[var(--muted)]">
                Tự động tính từ số dư tiền mặt/ngân hàng (TK 111 + 112), lịch sử thu chi và nghĩa vụ thuế GTGT + TNDN tạm nộp quý.
              </p>
            </div>
            <div className="seg">
              {([3, 6, 12] as const).map((m) => (
                <button key={m} type="button" className={forecastMonths === m ? "on" : ""} onClick={() => setForecastMonths(m)}>
                  {m} tháng
                </button>
              ))}
            </div>
          </div>

          {forecastBusy && !cashflow ? (
            <div className="text-[12.5px] text-[var(--muted)] py-10 text-center">Đang tính toán mô hình dòng tiền...</div>
          ) : (
            cashflow && (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                    <div className="text-[11px] text-[var(--muted)]">Số dư tiền hiện tại (111+112)</div>
                    <div className="text-[22px] font-bold tnum mt-1 text-[var(--cyan)]">
                      {formatMoney(cashflow.currentCashVnd)}
                    </div>
                    <div className="text-[11px] text-[var(--dim)]">Từ Bảng Cân đối Tài khoản</div>
                  </div>
                  <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                    <div className="text-[11px] text-[var(--muted)]">Burn Rate TB / tháng</div>
                    <div className="text-[22px] font-bold tnum mt-1 text-[var(--rose)]">
                      {formatMoney(cashflow.averageMonthlyBurnVnd)}
                    </div>
                    <div className="text-[11px] text-[var(--dim)] tnum">
                      Thu TB: {formatMoney(cashflow.averageMonthlyRevenueVnd)}
                    </div>
                  </div>
                  <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                    <div className="text-[11px] text-[var(--muted)]">Cash Runway ước tính</div>
                    <div
                      className={`text-[22px] font-bold tnum mt-1 ${
                        cashflow.runwayMonths === null || cashflow.runwayMonths >= 6
                          ? "text-[var(--green)]"
                          : cashflow.runwayMonths >= 3
                            ? "text-[var(--amber)]"
                            : "text-[var(--rose)]"
                      }`}
                    >
                      {cashflow.runwayMonths === null ? "Dương (∞)" : `${cashflow.runwayMonths} tháng`}
                    </div>
                    <div className="text-[11px] text-[var(--dim)] tnum">
                      Ròng/tháng: {formatMoney(cashflow.netMonthlyCashflowVnd)}
                    </div>
                  </div>
                  <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                    <div className="text-[11px] text-[var(--muted)]">Định phí lặp tự phát hiện</div>
                    <div className="text-[22px] font-bold tnum mt-1 text-[var(--amber)]">
                      {formatMoney(cashflow.recurringMonthlyTotalVnd)}
                    </div>
                    <div className="text-[11px] text-[var(--dim)] tnum">
                      TNDN quý ước tính: {formatMoney(cashflow.estimatedQuarterlyCitVnd)}
                    </div>
                  </div>
                </div>

                {/* Projection Table */}
                <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-[var(--line)] text-[12.5px] font-semibold">
                    Bảng dự báo dòng tiền & nghĩa vụ thuế {forecastMonths} tháng tới
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-[12px]">
                      <thead>
                        <tr className="bg-[var(--raised)] border-b border-[var(--line)] text-[10.5px] uppercase tracking-wider text-[var(--muted)]">
                          <th className="py-2 px-3">Kỳ (Tháng)</th>
                          <th className="py-2 px-3 text-right">Thu dự kiến</th>
                          <th className="py-2 px-3 text-right">Chi dự kiến</th>
                          <th className="py-2 px-3 text-right">VAT nộp DK</th>
                          <th className="py-2 px-3 text-right">TNDN tạm nộp</th>
                          <th className="py-2 px-3 text-right">Dòng tiền ròng</th>
                          <th className="py-2 px-3 text-right">Tiền cuối kỳ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--line)] tnum">
                        {cashflow.forecastMonths.map((m) => (
                          <tr key={m.period} className="hover:bg-[var(--hover)]">
                            <td className="py-2 px-3 font-mono font-semibold">{m.period}</td>
                            <td className="py-2 px-3 text-right text-[var(--green)]">{formatMoney(m.projectedRevenueVnd)}</td>
                            <td className="py-2 px-3 text-right">{formatMoney(m.projectedExpenseVnd)}</td>
                            <td className="py-2 px-3 text-right text-[var(--amber)]">{formatMoney(m.projectedVatPayableVnd)}</td>
                            <td className="py-2 px-3 text-right text-[var(--amber)]">{formatMoney(m.projectedCitEstimateVnd)}</td>
                            <td
                              className={`py-2 px-3 text-right font-semibold ${
                                m.netCashflowVnd >= 0 ? "text-[var(--green)]" : "text-[var(--rose)]"
                              }`}
                            >
                              {m.netCashflowVnd >= 0 ? "+" : ""}
                              {formatMoney(m.netCashflowVnd)}
                            </td>
                            <td
                              className={`py-2 px-3 text-right font-bold ${
                                m.endingCashBalanceVnd >= 0 ? "text-[var(--cyan)]" : "text-[var(--rose)]"
                              }`}
                            >
                              {formatMoney(m.endingCashBalanceVnd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Recurring Expenses */}
                <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-semibold flex items-center gap-1.5">
                      <Clock size={14} className="text-[var(--cyan)]" />
                      <span>Chi phí định kỳ / Thuê bao tự phát hiện ({cashflow.recurringExpenses.length})</span>
                    </div>
                  </div>
                  {cashflow.recurringExpenses.length === 0 ? (
                    <div className="text-[12px] text-[var(--dim)]">
                      Cần tối thiểu 2 kỳ hóa đơn cùng nhà cung cấp để nhận diện định phí lặp lại.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {cashflow.recurringExpenses.map((r, i) => (
                        <div key={i} className="rounded-[10px] border border-[var(--line)] bg-[var(--raised)] p-3 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-[12.5px] truncate">{r.merchant}</div>
                            <div className="text-[11px] text-[var(--muted)] tnum">
                              {r.occurrences} kỳ · Chu kỳ ~{r.intervalDays} ngày · Dự kiến kế tiếp: {formatDateVi(r.nextExpectedAt)}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-semibold text-[12.5px] tnum text-[var(--amber)]">
                              {formatMoney(r.estimatedMonthlyVnd)}/th
                            </div>
                            <span className={`tag ${r.confidence === "high" ? "tag-ok" : ""}`}>
                              {r.confidence === "high" ? "Tin cậy cao" : "Gợi ý"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )
          )}
        </div>
      )}

      {/* TAB 4: MCP HUB (SERVER + PLAYGROUND + EXTERNAL CLIENTS) */}
      {tab === "mcp" && (
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Section 1: T-Tax MCP Server Host + Setup Snippets */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-[14px] font-bold flex items-center gap-2">
                    <Plug size={15} className="text-[var(--cyan)]" />
                    <span>T-Tax MCP Server (SDK v2)</span>
                  </h2>
                  <p className="text-[11.5px] text-[var(--muted)]">
                    Cho phép Claude Desktop, Cursor, Antigravity, Windsurf & Gemini CLI truy vấn trực tiếp sổ sách SQLite cục bộ.
                  </p>
                </div>
                <span className={`tag ${mcpStatus?.running ? "tag-ok" : ""}`}>
                  {mcpStatus?.running ? "Đang chạy" : "Đang dừng"}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <label className="block text-[10.5px] text-[var(--muted)] mb-1">Streamable HTTP Endpoint</label>
                  <div className="flex gap-1.5">
                    <input
                      readOnly
                      value={mcpStatus?.url || `http://127.0.0.1:${mcpPort}/mcp`}
                      className="flex-1 h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px]"
                    />
                    <button
                      type="button"
                      onClick={() => void copyText("mcp-url", mcpStatus?.url || `http://127.0.0.1:${mcpPort}/mcp`)}
                      className="gb"
                      title="Sao chép URL"
                    >
                      {copiedKey === "mcp-url" ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10.5px] text-[var(--muted)] mb-1">Cổng (Port)</label>
                  <input
                    value={mcpPort}
                    onChange={(e) => setMcpPort(e.target.value)}
                    disabled={!transport.isDesktop || Boolean(mcpStatus?.running)}
                    className="w-full h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[12px] tnum"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10.5px] text-[var(--muted)] mb-1">Bearer Token xác thực (Localhost Only)</label>
                <div className="flex gap-1.5">
                  <input
                    readOnly
                    value={mcpStatus?.bearerToken || "(Chưa thiết lập token — chế độ Web mở cục bộ)"}
                    className="flex-1 h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11px]"
                  />
                  {mcpStatus?.bearerToken && (
                    <button type="button" onClick={() => void copyText("mcp-tok", mcpStatus.bearerToken)} className="gb" title="Sao chép Token">
                      {copiedKey === "mcp-tok" ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  )}
                  {transport.isDesktop && (
                    <button
                      type="button"
                      onClick={async () => {
                        setMcpBusy(true)
                        try {
                          setMcpStatus(await transport.rotateMcpToken())
                          onToast("Đã tạo Bearer Token mới.", "ok")
                        } finally {
                          setMcpBusy(false)
                        }
                      }}
                      className="gb"
                      title="Đổi Token mới"
                    >
                      <KeyRound size={13} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {transport.isDesktop ? (
                  <button
                    type="button"
                    disabled={mcpBusy}
                    onClick={async () => {
                      setMcpBusy(true)
                      try {
                        if (mcpStatus?.running) {
                          setMcpStatus(await transport.stopMcpHost())
                          onToast("Đã dừng T-Tax Local MCP Server.", "ok")
                        } else {
                          const p = Number(mcpPort) || 3939
                          setMcpStatus(await transport.startMcpHost(p))
                          onToast(`T-Tax MCP Server đang chạy tại http://127.0.0.1:${p}/mcp`, "ok")
                        }
                      } catch (err) {
                        onToast(err instanceof Error ? err.message : "Lỗi điều khiển MCP Server", "err")
                      } finally {
                        setMcpBusy(false)
                      }
                    }}
                    className={`gb ${mcpStatus?.running ? "" : "gb-p"}`}
                  >
                    {mcpStatus?.running ? <Square size={12.5} /> : <Play size={12.5} />}
                    <span>{mcpStatus?.running ? "Dừng MCP Server" : "Khởi chạy MCP HTTP Server"}</span>
                  </button>
                ) : (
                  <span className="text-[11.5px] text-[var(--green)]">Đang phục vụ tự động tại /mcp trên Web Server</span>
                )}
                <span className="text-[11px] text-[var(--dim)] tnum">
                  {mcpCatalog ? `${mcpCatalog.tools.length} tools · ${mcpCatalog.resources.length} resources · ${mcpCatalog.prompts.length} prompts` : ""} · {mcpStatus?.requestCount ?? 0} yêu cầu
                </span>
              </div>
            </div>

            {/* Setup Instructions cloned from Midday.ai */}
            <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13px] font-semibold flex items-center gap-1.5">
                  <Terminal size={14} className="text-[var(--cyan)]" />
                  <span>Cấu hình kết nối nhanh (1-Click Copy)</span>
                </div>
                <button type="button" onClick={() => void copyText("snippet", setupSnippet)} className="gb">
                  {copiedKey === "snippet" ? <Check size={12.5} /> : <Copy size={12.5} />}
                  <span>Sao chép</span>
                </button>
              </div>
              <div className="seg overflow-x-auto">
                {(
                  [
                    { id: "claude_desktop", label: "Claude Desktop" },
                    { id: "cursor", label: "Cursor" },
                    { id: "antigravity", label: "Antigravity" },
                    { id: "claude_code", label: "Claude Code" },
                    { id: "gemini_cli", label: "Gemini CLI" }
                  ] as const
                ).map((c) => (
                  <button key={c.id} type="button" className={setupClient === c.id ? "on" : ""} onClick={() => setSetupClient(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
              <pre className="p-3 rounded-[10px] bg-[var(--raised)] border border-[var(--line)] text-[11px] font-mono overflow-x-auto max-h-[168px]">
                <code>{setupSnippet}</code>
              </pre>
            </div>
          </div>

          {/* Section 2: Interactive Live MCP Tool Playground */}
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-[13.5px] font-bold">MCP Tool Playground (Chạy thử trực tiếp qua giao thức MCP v2)</h3>
                <p className="text-[11.5px] text-[var(--muted)]">
                  Kiểm thử toàn bộ {mcpCatalog?.tools.length ?? 16} công cụ MCP, xem dữ liệu JSON/Markdown trả về chuẩn xác trước khi nối agent ngoài.
                </p>
              </div>
              <button type="button" disabled={playgroundBusy} onClick={() => void runPlayground()} className="gb gb-p">
                <Play size={13} />
                <span>{playgroundBusy ? "Đang chạy..." : "Chạy MCP Tool"}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
              <div className="lg:col-span-5 space-y-2">
                <select
                  value={selectedToolName}
                  onChange={(e) => {
                    const name = e.target.value
                    setSelectedToolName(name)
                    const meta = mcpCatalog?.tools.find((t) => t.name === name)
                    if (meta) setPlaygroundArgsJson(JSON.stringify(meta.sampleArgs, null, 2))
                  }}
                  className="w-full h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[12px]"
                >
                  {(mcpCatalog?.tools ?? []).map((t) => (
                    <option key={t.name} value={t.name} className="bg-[var(--panel-solid)]">
                      {t.name} ({t.readOnly ? "RO" : "WRITE"})
                    </option>
                  ))}
                </select>
                <div className="text-[11.5px] text-[var(--muted)]">
                  {mcpCatalog?.tools.find((t) => t.name === selectedToolName)?.description}
                </div>
                <textarea
                  rows={5}
                  value={playgroundArgsJson}
                  onChange={(e) => setPlaygroundArgsJson(e.target.value)}
                  className="w-full p-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px] outline-none"
                />
              </div>

              <div className="lg:col-span-7 flex flex-col">
                <div className="flex items-center justify-between text-[11px] text-[var(--muted)] mb-1">
                  <span>Kết quả MCP Response</span>
                  {playgroundOut && (
                    <span className={`tnum ${playgroundOut.isError ? "text-[var(--rose)]" : "text-[var(--green)]"}`}>
                      {playgroundOut.isError ? "isError: true" : "OK"} · {playgroundOut.durationMs}ms
                    </span>
                  )}
                </div>
                <pre className="flex-1 min-h-[155px] max-h-[260px] p-3 rounded-[10px] bg-[var(--raised)] border border-[var(--line)] text-[11.5px] font-mono overflow-auto whitespace-pre-wrap">
                  {playgroundOut ? playgroundOut.text : "Chọn một tool bên trái và nhấn 'Chạy MCP Tool' để kiểm tra kết quả trực tiếp."}
                </pre>
              </div>
            </div>
          </div>

          {/* Section 3: External MCP Client Hub */}
          <div className="rounded-[14px] border border-[var(--line)] bg-[var(--panel)] p-4 space-y-3">
            <div>
              <h3 className="text-[13.5px] font-bold">Kết nối MCP Server bên ngoài (MCP Client cho Trợ lý AI T-Tax)</h3>
              <p className="text-[11.5px] text-[var(--muted)]">
                Thêm MCP server ngoài (stdio hoặc Streamable HTTP) để Trợ lý AI của T-Tax tự động gọi thêm công cụ ERP, ngân hàng, email hoặc kho dữ liệu.
              </p>
            </div>

            <form onSubmit={handleAddExternalMcp} className="grid grid-cols-1 md:grid-cols-12 gap-2">
              <input
                value={newExt.name}
                onChange={(e) => setNewExt({ ...newExt, name: e.target.value })}
                placeholder="Tên server (VD: ERP Nội bộ)"
                className="md:col-span-3 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              />
              <select
                value={newExt.transport}
                onChange={(e) => setNewExt({ ...newExt, transport: e.target.value as "stdio" | "http" })}
                className="md:col-span-2 h-9 px-2.5 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] text-[12px]"
              >
                <option value="http" className="bg-[var(--panel-solid)]">Streamable HTTP</option>
                <option value="stdio" className="bg-[var(--panel-solid)]">Local stdio</option>
              </select>
              {newExt.transport === "http" ? (
                <>
                  <input
                    value={newExt.url}
                    onChange={(e) => setNewExt({ ...newExt, url: e.target.value })}
                    placeholder="https://.../mcp"
                    className="md:col-span-4 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px]"
                  />
                  <input
                    value={newExt.bearerToken}
                    onChange={(e) => setNewExt({ ...newExt, bearerToken: e.target.value })}
                    placeholder="Bearer Token (tùy chọn)"
                    className="md:col-span-2 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px]"
                  />
                </>
              ) : (
                <>
                  <input
                    value={newExt.command}
                    onChange={(e) => setNewExt({ ...newExt, command: e.target.value })}
                    placeholder="Command (VD: npx)"
                    className="md:col-span-2 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px]"
                  />
                  <input
                    value={newExt.argsText}
                    onChange={(e) => setNewExt({ ...newExt, argsText: e.target.value })}
                    placeholder="Args cách nhau bằng dấu cách"
                    className="md:col-span-4 h-9 px-3 rounded-[9px] bg-[var(--raised)] border border-[var(--line)] font-mono text-[11.5px]"
                  />
                </>
              )}
              <button type="submit" className="md:col-span-1 gb gb-p justify-center h-9">
                <Plus size={14} />
              </button>
            </form>

            {extServers.length > 0 && (
              <div className="space-y-2">
                {extServers.map((s) => (
                  <div key={s.id} className="rounded-[10px] border border-[var(--line)] bg-[var(--raised)] p-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[12.5px]">{s.name}</span>
                        <span className="tag">{s.transport.toUpperCase()}</span>
                        {s.cachedTools && <span className="tag tag-ok">{s.cachedTools.length} tools</span>}
                        {s.lastError && <span className="tag tag-err truncate max-w-[220px]">{s.lastError}</span>}
                      </div>
                      <div className="text-[11px] text-[var(--muted)] font-mono truncate">
                        {s.transport === "http" ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={testingExtId === s.id}
                        onClick={() => void handleTestExternal(s)}
                        className="gb text-[11.5px]"
                      >
                        <RefreshCw size={12} className={testingExtId === s.id ? "animate-spin" : ""} />
                        <span>Kiểm tra & Quét Tools</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          setExtServers(await transport.deleteExternalMcpServer(workspace.id, s.id))
                          onToast(`Đã xóa MCP server ${s.name}.`, "ok")
                        }}
                        className="gb text-[var(--rose)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
