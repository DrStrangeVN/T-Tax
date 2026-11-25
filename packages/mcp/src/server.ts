import {
  completable,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate
} from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { DEFAULT_VN_LEGAL_RULES } from "@t-tax/core"
import type { TTaxService } from "@t-tax/db"

export const TTAX_MCP_VERSION = "0.1.0"
const CHARACTER_LIMIT = 25_000

const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' cho trình bày dễ đọc hoặc 'json' cho dữ liệu có cấu trúc")

export interface TTaxMcpServerOptions {
  defaultWorkspaceId?: string
  readOnly?: boolean
  onAuditLog?: (entry: { method: string; tool?: string; ok: boolean; durationMs: number; error?: string }) => void
}

function fmtVnd(n: number | null | undefined): string {
  return `${Math.round(Number(n ?? 0)).toLocaleString("vi-VN")} đ`
}

function getDateContext() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const q = Math.ceil(m / 3)
  const qStartMonth = String((q - 1) * 3 + 1).padStart(2, "0")
  const iso = now.toISOString().slice(0, 10)
  return {
    date: iso,
    year: y,
    quarter: q,
    monthStart: `${y}-${String(m).padStart(2, "0")}-01`,
    quarterStart: `${y}-${qStartMonth}-01`,
    yearStart: `${y}-01-01`
  }
}

function buildServerInstructions(service: TTaxService, defaultWorkspaceId?: string): string {
  const d = getDateContext()
  const wss = service.listWorkspaces()
  const activeWs = (defaultWorkspaceId ? wss.find((w) => w.id === defaultWorkspaceId) : undefined) ?? wss[0]
  return [
    `T-Tax is a local-first Vietnam AI Accounting, E-Invoice (TT78/NĐ 70/2025) & VAS (TT99/2025, TT200, TT133, HKD 2026) platform.`,
    ``,
    `## Current Context`,
    `- Today: ${d.date} (Year ${d.year}, Quarter Q${d.quarter})`,
    `- This month: ${d.monthStart}..${d.date} | This quarter: ${d.quarterStart}..${d.date} | YTD: ${d.yearStart}..${d.date}`,
    activeWs
      ? `- Default Workspace: "${activeWs.name}" (id="${activeWs.id}", MST="${activeWs.taxCode}", regime="${activeWs.accountingRegime}", currency="${activeWs.baseCurrency}", lockDate="${activeWs.lockDate ?? "none"}")`
      : `- No workspace initialized yet.`,
    ``,
    `## Tool Domains`,
    `- ttax_list_workspaces: Discover workspaces (companies / MSTs). Optional workspace_id defaults to the active workspace.`,
    `- ttax_get_financial_overview: Pre-tax revenue/expense, operating profit, VAT payable/deductible, warning counts.`,
    `- ttax_list_transactions / ttax_get_transaction / ttax_search_global: Paginated ledger query, FTS5 search, full voucher & XML details.`,
    `- ttax_get_trial_balance / ttax_get_account_ledger: VAS Trial Balance and account-level General Ledger with running balance.`,
    `- ttax_run_tax_audit: Automated Vietnam tax risk & anomaly scanner (duplicate invoices, non-cash 5M/20M violations, vendor category drift, price spikes, MST risk).`,
    `- ttax_get_cashflow_forecast: Live cash position (TK 111+112), burn rate, runway, recurring bills & 3/6/12-month tax + cashflow forecast.`,
    `- ttax_get_ar_ap_aging: Accounts Receivable (131) & Accounts Payable (331) aging buckets (0-30, 31-60, 61-90, >90 days).`,
    `- ttax_list_assets_depreciation: Fixed Assets (TSCĐ 211) & Prepaid Tools (CCDC 242) depreciation schedule.`,
    `- ttax_list_counterparties / ttax_list_smart_rules: MST risk registry & auto-categorization rules.`,
    `- Write tools (enforcing lockDate & ∑Nợ=∑Có): ttax_create_transaction, ttax_create_journal_voucher, ttax_apply_smart_rule.`
  ].join("\n")
}

function resolveWorkspaceId(service: TTaxService, provided?: string, fallback?: string): string {
  const wss = service.listWorkspaces()
  if (provided) {
    const match = wss.find((w) => w.id === provided || w.taxCode === provided)
    if (!match) {
      throw new Error(
        `Không tìm thấy workspace "${provided}". Gọi ttax_list_workspaces để lấy danh sách workspace_id hoặc MST hợp lệ.`
      )
    }
    return match.id
  }
  if (fallback && wss.some((w) => w.id === fallback)) return fallback
  const first = wss[0] ?? service.ensureWorkspace()
  return first.id
}

function formatResult(
  format: "markdown" | "json",
  markdownText: string,
  structured: Record<string, unknown>
) {
  if (format === "json") {
    const jsonText = JSON.stringify(structured, null, 2)
    return {
      content: [{ type: "text" as const, text: jsonText }],
      structuredContent: structured
    }
  }
  return {
    content: [{ type: "text" as const, text: markdownText }]
  }
}

export interface TTaxMcpToolDescriptor {
  name: string
  title: string
  description: string
  readOnly: boolean
  category: "read" | "analytics" | "write"
  sampleArgs: Record<string, unknown>
}

export const TTAX_MCP_TOOL_CATALOG: TTaxMcpToolDescriptor[] = [
  {
    name: "ttax_list_workspaces",
    title: "Danh sách Công ty / MST",
    description: "Liệt kê toàn bộ workspace (doanh nghiệp/HKD), MST, chế độ kế toán và ngày khóa sổ.",
    readOnly: true,
    category: "read",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_get_financial_overview",
    title: "Tổng quan Tài chính & Thuế GTGT",
    description: "Lấy Doanh thu/Chi phí trước thuế, Lãi/Lỗ tạm tính, VAT đầu ra/vào và số cảnh báo tuân thủ.",
    readOnly: true,
    category: "analytics",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_list_transactions",
    title: "Danh sách Giao dịch & Hóa đơn",
    description: "Truy vấn sổ giao dịch có phân trang theo chiều mua/bán, kỳ, trạng thái tuân thủ hoặc từ khóa.",
    readOnly: true,
    category: "read",
    sampleArgs: { limit: 15, offset: 0, response_format: "markdown" }
  },
  {
    name: "ttax_get_transaction",
    title: "Chi tiết một Hóa đơn / Giao dịch",
    description: "Đọc đầy đủ chi tiết hóa đơn, mặt hàng, định khoản VAS Nợ/Có, cảnh báo tuân thủ và tệp đính kèm.",
    readOnly: true,
    category: "read",
    sampleArgs: { transaction_id: "", response_format: "json" }
  },
  {
    name: "ttax_search_global",
    title: "Tìm kiếm toàn văn FTS5",
    description: "Tìm nhanh giao dịch, số hóa đơn và đối tác MST trong toàn bộ cơ sở dữ liệu SQLite.",
    readOnly: true,
    category: "read",
    sampleArgs: { query: "0000", limit: 10, response_format: "markdown" }
  },
  {
    name: "ttax_get_trial_balance",
    title: "Bảng Cân đối Tài khoản VAS",
    description: "Tổng hợp Dư đầu kỳ, Phát sinh Nợ/Có và Dư cuối kỳ cho tất cả tài khoản VAS trong kỳ.",
    readOnly: true,
    category: "analytics",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_get_account_ledger",
    title: "Sổ chi tiết Tài khoản (General Ledger)",
    description: "Xem từng dòng phát sinh Nợ/Có và số dư lũy tiến của một tài khoản VAS (VD: 1121, 1331, 6428).",
    readOnly: true,
    category: "analytics",
    sampleArgs: { account_code: "1121", response_format: "markdown" }
  },
  {
    name: "ttax_run_tax_audit",
    title: "Kiểm toán Rủi ro Thuế & Bất thường",
    description: "Quét 100% sổ sách phát hiện trùng HĐ, tiền mặt vượt ngưỡng 5tr/20tr, MST rủi ro, lệch danh mục, tăng giá đột biến.",
    readOnly: true,
    category: "analytics",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_get_cashflow_forecast",
    title: "Dự báo Dòng tiền, Burn Rate & Runway",
    description: "Tính số dư tiền (TK 111+112), burn rate, runway, định phí tự phát hiện và dự báo dòng tiền + thuế 3–12 tháng.",
    readOnly: true,
    category: "analytics",
    sampleArgs: { months: 6, response_format: "markdown" }
  },
  {
    name: "ttax_get_ar_ap_aging",
    title: "Báo cáo Công nợ AR/AP & Tuổi nợ",
    description: "Phân tích công nợ Phải thu (131) & Phải trả (331) theo nhóm 0–30, 31–60, 61–90 và >90 ngày.",
    readOnly: true,
    category: "analytics",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_list_assets_depreciation",
    title: "Danh sách TSCĐ (211) & CCDC (242)",
    description: "Xem nguyên giá, khấu hao lũy kế, khấu hao tháng và giá trị còn lại của tài sản cố định & công cụ dụng cụ.",
    readOnly: true,
    category: "read",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_list_counterparties",
    title: "Danh sách Đối tác & Rủi ro MST",
    description: "Liệt kê nhà cung cấp, khách hàng, trạng thái hoạt động MST và tổng giá trị giao dịch.",
    readOnly: true,
    category: "read",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_list_smart_rules",
    title: "Danh sách Quy tắc Định khoản Tự động",
    description: "Liệt kê các quy tắc phân loại danh mục & tài khoản VAS tự động hiện hành.",
    readOnly: true,
    category: "read",
    sampleArgs: { response_format: "markdown" }
  },
  {
    name: "ttax_create_transaction",
    title: "Tạo Giao dịch / Hóa đơn mới",
    description: "Ghi sổ giao dịch mua vào hoặc bán ra mới kèm tự động định khoản VAS (kiểm tra khóa sổ kỳ kế toán).",
    readOnly: false,
    category: "write",
    sampleArgs: {
      name: "Chi phí phần mềm đám mây",
      direction: "input",
      pre_tax_amount: 1000000,
      vat_amount: 100000,
      total_amount: 1100000
    }
  },
  {
    name: "ttax_create_journal_voucher",
    title: "Lập Phiếu Kế toán Nợ/Có",
    description: "Tạo bút toán tổng hợp Nợ/Có cân đối (∑Nợ = ∑Có) có kiểm soát ngày khóa sổ.",
    readOnly: false,
    category: "write",
    sampleArgs: {
      voucher_date: new Date().toISOString().slice(0, 10),
      description: "Bút toán trích trước chi phí",
      lines: [{ debit_account: "6427", credit_account: "335", amount_vnd: 1000000 }]
    }
  },
  {
    name: "ttax_apply_smart_rule",
    title: "Tạo Quy tắc Phân loại Thông minh",
    description: "Lưu quy tắc tự động gán danh mục và tài khoản Nợ khi khớp tên đối tác/MST/diễn giải.",
    readOnly: false,
    category: "write",
    sampleArgs: {
      name: "Quy tắc Cloud",
      match_field: "merchant",
      pattern: "Amazon",
      assign_category_code: "software"
    }
  }
]

export const TTAX_MCP_RESOURCES_CATALOG = [
  { uri: "ttax://workspace/info", title: "Thông tin Workspace & Chế độ KT", mimeType: "application/json" },
  { uri: "ttax://tax/vat-summary", title: "Tổng hợp Thuế GTGT kỳ hiện tại", mimeType: "application/json" },
  { uri: "ttax://audit/anomalies", title: "Báo cáo Kiểm toán Rủi ro Thuế", mimeType: "application/json" },
  { uri: "ttax://reports/cashflow-forecast", title: "Phân tích Dòng tiền, Burn & Runway", mimeType: "application/json" },
  { uri: "ttax://legal/vn-tax-rules", title: "Bộ nhớ Pháp lý Thuế VN (TT99/NĐ70/Luật GTGT 48)", mimeType: "application/json" },
  { uri: "ttax://transactions/{transactionId}", title: "Chi tiết một giao dịch theo ID (Template)", mimeType: "application/json" }
]

export const TTAX_MCP_PROMPTS_CATALOG = [
  { name: "vn_tax_audit_briefing", title: "Kiểm toán Rủi ro Thuế Việt Nam", description: "Rà soát toàn bộ rủi ro thuế GTGT/TNDN và lập kế hoạch xử lý." },
  { name: "vat_period_closing_review", title: "Rà soát Khóa sổ & Tờ khai GTGT", description: "Đối chiếu Bảng kê GTGT, TK 1331/3331 và chuẩn bị kết chuyển cuối kỳ." },
  { name: "cashflow_runway_forecast", title: "Dự báo Dòng tiền & Nghĩa vụ Thuế", description: "Phân tích burn rate, runway, chi phí định kỳ và dự báo 3/6/12 tháng." },
  { name: "ar_ap_debt_followup", title: "Kế hoạch Thu hồi Công nợ AR/AP", description: "Phân tích tuổi nợ quá hạn và soạn mẫu nhắc nợ đối tác." },
  { name: "expense_optimization_review", title: "Tối ưu Chi phí & Định phí", description: "Phát hiện định phí lặp, biến động giá NCC và tối ưu chi phí được trừ TNDN." }
]

/**
 * Factory returning a fresh McpServer instance per stdio connection or HTTP request (MCP SDK v2 best practice).
 */
export function createTTaxMcpServer(service: TTaxService, opts: TTaxMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "t-tax-mcp-server",
      version: TTAX_MCP_VERSION,
      title: "T-Tax Vietnam AI Accounting & Tax",
      description:
        "Local-first Vietnam accounting, TT78/ND70 e-invoice, VAS ledger, tax risk audit, cashflow forecast & AR/AP MCP server."
    },
    {
      instructions: buildServerInstructions(service, opts.defaultWorkspaceId)
    }
  )

  const wrap = <Args, Res>(toolName: string, fn: (args: Args) => Promise<Res> | Res) => {
    return async (args: Args) => {
      const started = Date.now()
      try {
        const res = await fn(args)
        opts.onAuditLog?.({ method: "tools/call", tool: toolName, ok: true, durationMs: Date.now() - started })
        return res
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        opts.onAuditLog?.({ method: "tools/call", tool: toolName, ok: false, durationMs: Date.now() - started, error: msg })
        throw err
      }
    }
  }

  // ---- 1. ttax_list_workspaces ----
  server.registerTool(
    "ttax_list_workspaces",
    {
      title: "List Workspaces",
      description:
        "List all T-Tax company/household workspaces with ID, tax code (MST), accounting regime (TT99_2025/TT200_2014/TT133_2016/HKD_2026), base currency, and period lock date.",
      inputSchema: z.strictObject({
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_list_workspaces", ({ response_format }) => {
      const workspaces = service.listWorkspaces()
      const md = [
        `# Workspaces (${workspaces.length})`,
        ...workspaces.map(
          (w) =>
            `- **${w.name}** (id: \`${w.id}\`) · MST: \`${w.taxCode}\` · Chế độ: ${w.accountingRegime} · Tiền tệ: ${w.baseCurrency}${w.lockDate ? ` · Khóa sổ đến ${w.lockDate}` : ""}`
        )
      ].join("\n")
      return formatResult(response_format, md, { count: workspaces.length, workspaces })
    })
  )

  // ---- 2. ttax_get_financial_overview ----
  server.registerTool(
    "ttax_get_financial_overview",
    {
      title: "Get Financial & Tax Overview",
      description:
        "Get pre-tax revenue, pre-tax expenses, operating profit, VAT output/input/payable, compliance warnings, and monthly series for a workspace and optional YYYY-MM-DD date range.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional().describe("Workspace ID or MST. Defaults to active workspace."),
        date_from: z.string().optional().describe("Start date YYYY-MM-DD"),
        date_to: z.string().optional().describe("End date YYYY-MM-DD"),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_get_financial_overview", ({ workspace_id, date_from, date_to, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const stats = service.getDashboardStats(wsId, date_from, date_to)
      const md = [
        `# Tổng quan Tài chính & Thuế (${date_from || "Đầu kỳ"} → ${date_to || "Hiện tại"})`,
        `- **Doanh thu trước thuế:** ${fmtVnd(stats.revenuePreTax)} (Tổng có VAT: ${fmtVnd(stats.totalRevenue)})`,
        `- **Chi phí trước thuế:** ${fmtVnd(stats.expensePreTax)} (Tổng có VAT: ${fmtVnd(stats.totalExpense)})`,
        `- **Lãi / Lỗ tạm tính (trước thuế):** ${fmtVnd(stats.operatingProfit)}`,
        `- **Thuế GTGT đầu ra:** ${fmtVnd(stats.outputVat)} · **GTGT đầu vào:** ${fmtVnd(stats.inputVat)} · **Chênh lệch GTGT:** ${fmtVnd(stats.vatPayable)}`,
        `- **Giao dịch:** ${stats.transactionCount} · **Chờ duyệt:** ${stats.unreviewedCount} · **Cảnh báo tuân thủ:** ${stats.complianceWarnings}`
      ].join("\n")
      return formatResult(response_format, md, stats as unknown as Record<string, unknown>)
    })
  )

  // ---- 3. ttax_list_transactions ----
  server.registerTool(
    "ttax_list_transactions",
    {
      title: "List Transactions & Invoices",
      description:
        "Query transactions/invoices with filters (search, direction input/output, category_code, compliance_status, date_from/date_to) and pagination (limit/offset).",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional().describe("Workspace ID or MST"),
        search: z.string().optional().describe("Search invoice number, merchant, MST or description"),
        direction: z.enum(["input", "output"]).optional().describe("'input' (mua vào) or 'output' (bán ra)"),
        category_code: z.string().optional(),
        compliance_status: z.enum(["valid", "warning", "error", "pending"]).optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD"),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_list_transactions", (args) => {
      const wsId = resolveWorkspaceId(service, args.workspace_id, opts.defaultWorkspaceId)
      const res = service.listTransactions(wsId, {
        search: args.search,
        direction: args.direction,
        categoryCode: args.category_code,
        complianceStatus: args.compliance_status,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        limit: args.limit,
        offset: args.offset
      })

      let rows = res.rows
      const build = (slice: typeof rows) => {
        const nextOffset = args.offset + slice.length
        const hasMore = res.total > nextOffset
        const page = {
          total: res.total,
          count: slice.length,
          offset: args.offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {}),
          summary: res.summary,
          transactions: slice
        }
        const mdLines = [
          `# Sổ Giao dịch (${slice.length}/${res.total})`,
          ...slice.map(
            (r) =>
              `- \`${r.id}\` | ${r.issuedAt || "—"} | ${r.direction === "output" ? "Bán ra" : "Mua vào"} | HĐ ${r.invoiceNumber || "—"} | ${r.merchant || r.name || "—"} (${r.merchantTaxCode || "—"}) | **${fmtVnd(r.totalAmount)}** [${r.complianceStatus}]`
          )
        ]
        if (hasMore) mdLines.push("", `Còn dữ liệu: gọi lại với offset=${nextOffset}.`)
        const text = args.response_format === "json" ? JSON.stringify(page, null, 2) : mdLines.join("\n")
        return { page, text }
      }

      let rendered = build(rows)
      while (rows.length > 1 && rendered.text.length > CHARACTER_LIMIT) {
        rows = rows.slice(0, Math.ceil(rows.length / 2))
        rendered = build(rows)
      }
      return formatResult(args.response_format, rendered.text, rendered.page)
    })
  )

  // ---- 4. ttax_get_transaction ----
  server.registerTool(
    "ttax_get_transaction",
    {
      title: "Get Transaction Detail",
      description:
        "Get full details of one transaction by ID, including line items, VAS double-entry journal lines, linked Vault files, and compliance issues.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        transaction_id: z.string().min(1).describe("Transaction UUID from ttax_list_transactions or ttax_search_global"),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_get_transaction", ({ workspace_id, transaction_id, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const detail = service.getTransactionDetail(wsId, transaction_id)
      if (!detail) {
        throw new Error(`Không tìm thấy giao dịch ID "${transaction_id}". Hãy dùng ttax_list_transactions để tìm ID hợp lệ.`)
      }
      const tx = detail.transaction
      const md = [
        `# Chi tiết Giao dịch: ${tx.name || tx.invoiceNumber || tx.id}`,
        `- **ID:** \`${tx.id}\` · **Chiều:** ${tx.direction} · **Ngày lập:** ${tx.issuedAt || "—"}`,
        `- **Đối tác:** ${tx.merchant || "—"} (MST: ${tx.merchantTaxCode || "—"})`,
        `- **Số hóa đơn:** ${tx.invoiceSymbol || ""} ${tx.invoiceNumber || "—"} · **Thanh toán:** ${tx.paymentMethod || "—"} (${tx.paymentStatus})`,
        `- **Trước thuế:** ${fmtVnd(tx.preTaxAmount)} · **VAT:** ${fmtVnd(tx.vatAmount)} · **Tổng cộng:** **${fmtVnd(tx.totalAmount)}**`,
        `- **Định khoản VAS (${detail.journalEntries.length} chứng từ):**`,
        ...detail.journalEntries.flatMap((je) =>
          je.lines.map((l) => `  - ${je.voucherNo}: Nợ **${l.debitAccount}** / Có **${l.creditAccount}** — ${fmtVnd(l.amountVnd)}`)
        )
      ].join("\n")
      return formatResult(response_format, md, detail as unknown as Record<string, unknown>)
    })
  )

  // ---- 5. ttax_search_global ----
  server.registerTool(
    "ttax_search_global",
    {
      title: "Global FTS5 Search",
      description:
        "Fast full-text search across transactions, invoice numbers, descriptions, and counterparties (MST/names).",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        query: z.string().min(1).max(200).describe("Keyword, invoice number, MST, or company name"),
        limit: z.number().int().min(1).max(50).default(15),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_search_global", ({ workspace_id, query, limit, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const raw = service.searchGlobal(wsId, query)
      const res = {
        transactions: raw.transactions.slice(0, limit),
        counterparties: raw.counterparties.slice(0, limit)
      }
      const md = [
        `# Tìm kiếm "${query}"`,
        `## Giao dịch (${res.transactions.length})`,
        ...res.transactions.map(
          (t) => `- \`${t.id}\` | HĐ ${t.invoiceNumber || "—"} | ${t.merchant || t.name || "—"} | ${fmtVnd(t.totalAmount)}`
        ),
        `## Đối tác MST (${res.counterparties.length})`,
        ...res.counterparties.map((c) => `- **${c.name}** (MST \`${c.taxCode}\`) [${c.status}]`)
      ].join("\n")
      return formatResult(response_format, md, res as unknown as Record<string, unknown>)
    })
  )

  // ---- 6. ttax_get_trial_balance ----
  server.registerTool(
    "ttax_get_trial_balance",
    {
      title: "Get VAS Trial Balance",
      description:
        "Get Bảng Cân đối Tài khoản VAS (opening debit/credit, period debit/credit, closing debit/credit) for an optional date range.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_get_trial_balance", ({ workspace_id, date_from, date_to, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const rows = service.getTrialBalance(wsId, { dateFrom: date_from, dateTo: date_to })
      const totals = rows.reduce(
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
      const md = [
        `# Bảng Cân đối Tài khoản (${rows.length} TK)`,
        `- Tổng PS Nợ: ${fmtVnd(totals.pd)} · Tổng PS Có: ${fmtVnd(totals.pc)}`,
        `- Tổng Dư Nợ CK: ${fmtVnd(totals.cd)} · Tổng Dư Có CK: ${fmtVnd(totals.cc)}`,
        "",
        ...rows.map(
          (r) =>
            `- **${r.code}** ${r.name}: ĐK(${fmtVnd(r.openingDebit)}/${fmtVnd(r.openingCredit)}) · PS(${fmtVnd(r.periodDebit)}/${fmtVnd(r.periodCredit)}) · CK(${fmtVnd(r.closingDebit)}/${fmtVnd(r.closingCredit)})`
        )
      ].join("\n")
      return formatResult(response_format, md, { rows, totals, balanced: totals.cd === totals.cc })
    })
  )

  // ---- 7. ttax_get_account_ledger ----
  server.registerTool(
    "ttax_get_account_ledger",
    {
      title: "Get Account General Ledger",
      description:
        "Get Sổ chi tiết Tài khoản (General Ledger) for a specific VAS account code (e.g. '1121', '1331', '33311', '6428') with running balance.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        account_code: z.string().min(2).max(16).describe("VAS account code, e.g. '1121', '1331', '6428'"),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_get_account_ledger", ({ workspace_id, account_code, date_from, date_to, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const ledger = service.getAccountLedger(wsId, account_code, { dateFrom: date_from, dateTo: date_to })
      const md = [
        `# Sổ chi tiết TK ${ledger.accountCode} — ${ledger.accountName}`,
        `- Dư đầu kỳ: ${fmtVnd(ledger.openingBalance)} · Tổng Nợ: ${fmtVnd(ledger.totalDebit)} · Tổng Có: ${fmtVnd(ledger.totalCredit)} · **Dư cuối kỳ: ${fmtVnd(ledger.closingBalance)}**`,
        "",
        ...ledger.rows.slice(0, 60).map(
          (r) =>
            `- ${r.voucherDate} | ${r.voucherNo} | TK ĐƯ ${r.counterAccount} | ${r.description} | Nợ ${fmtVnd(r.debitAmount)} | Có ${fmtVnd(r.creditAmount)} | Dư ${fmtVnd(r.runningBalance)}`
        )
      ].join("\n")
      return formatResult(response_format, md, ledger as unknown as Record<string, unknown>)
    })
  )

  // ---- 8. ttax_run_tax_audit ----
  server.registerTool(
    "ttax_run_tax_audit",
    {
      title: "Run Vietnam Tax Risk & Anomaly Audit",
      description:
        "Scan 100% of ledger transactions for duplicate invoices, duplicate payments, Vietnam non-cash threshold violations (5M/20M VND), vendor category drift, price spikes, arithmetic mismatches, and high-risk MST counterparties.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_run_tax_audit", ({ workspace_id, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const report = service.runTaxAudit(wsId)
      const md = [
        `# Báo cáo Kiểm toán Rủi ro Thuế (Điểm tuân thủ: ${report.healthScore}/100)`,
        `- Quét ${report.totalTransactions} giao dịch · Nghiêm trọng: ${report.summary.critical} · Cao: ${report.summary.high} · TB: ${report.summary.medium} · Lưu ý: ${report.summary.info}`,
        `- **Thuế GTGT có rủi ro:** ${fmtVnd(report.summary.totalVatAtRiskVnd)} · **Thuế TNDN rủi ro:** ${fmtVnd(report.summary.totalCitAtRiskVnd)}`,
        "",
        ...report.anomalies.slice(0, 30).map(
          (a) => `- **[${a.severity.toUpperCase()}] ${a.title}**: ${a.description}\n  - *Khuyến nghị:* ${a.recommendation}`
        )
      ].join("\n")
      return formatResult(response_format, md, report as unknown as Record<string, unknown>)
    })
  )

  // ---- 9. ttax_get_cashflow_forecast ----
  server.registerTool(
    "ttax_get_cashflow_forecast",
    {
      title: "Get Cashflow Forecast, Burn Rate & Runway",
      description:
        "Compute live cash balance (TK 111+112), monthly burn rate, cash runway in months, auto-detected recurring expenses, and forward monthly cashflow & tax obligation projections.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        months: z.number().int().min(1).max(12).default(6).describe("Months to project forward (1–12)"),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_get_cashflow_forecast", ({ workspace_id, months, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const cf = service.getCashflowAnalytics(wsId, months)
      const md = [
        `# Phân tích Dòng tiền & Dự báo ${months} tháng`,
        `- **Tiền hiện có (TK 111+112):** ${fmtVnd(cf.currentCashVnd)}`,
        `- **Doanh thu TB/tháng:** ${fmtVnd(cf.averageMonthlyRevenueVnd)} · **Burn TB/tháng:** ${fmtVnd(cf.averageMonthlyBurnVnd)}`,
        `- **Runway:** ${cf.runwayMonths === null ? "Dòng tiền dương" : `${cf.runwayMonths} tháng`} · **Định phí lặp:** ${fmtVnd(cf.recurringMonthlyTotalVnd)}/tháng`,
        `- **Dự phòng TNDN quý:** ${fmtVnd(cf.estimatedQuarterlyCitVnd)} · **VAT dự kiến/tháng:** ${fmtVnd(cf.estimatedVatPayableVnd)}`,
        "",
        `## Dự báo từng tháng`,
        ...cf.forecastMonths.map(
          (m) =>
            `- **${m.period}**: Thu ${fmtVnd(m.projectedRevenueVnd)} | Chi ${fmtVnd(m.projectedExpenseVnd)} | VAT ${fmtVnd(m.projectedVatPayableVnd)} | TNDN ${fmtVnd(m.projectedCitEstimateVnd)} | Dư cuối **${fmtVnd(m.endingCashBalanceVnd)}**`
        )
      ].join("\n")
      return formatResult(response_format, md, cf as unknown as Record<string, unknown>)
    })
  )

  // ---- 10. ttax_get_ar_ap_aging ----
  server.registerTool(
    "ttax_get_ar_ap_aging",
    {
      title: "Get AR/AP Aging Report",
      description:
        "Analyze unpaid/partial Accounts Receivable (131) and Accounts Payable (331) by counterparty MST across 0-30, 31-60, 61-90, and >90 day aging buckets.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        as_of_date: z.string().optional().describe("Reference date YYYY-MM-DD (default today)"),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_get_ar_ap_aging", ({ workspace_id, as_of_date, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const report = service.getArApAging(wsId, as_of_date)
      const md = [
        `# Báo cáo Công nợ AR/AP (tính đến ${report.asOfDate})`,
        `- **Tổng Phải thu (AR 131):** ${fmtVnd(report.receivableTotal)} (0-30d: ${fmtVnd(report.receivableBuckets.current0To30)} · >90d: ${fmtVnd(report.receivableBuckets.over90)})`,
        `- **Tổng Phải trả (AP 331):** ${fmtVnd(report.payableTotal)} (0-30d: ${fmtVnd(report.payableBuckets.current0To30)} · >90d: ${fmtVnd(report.payableBuckets.over90)})`,
        "",
        ...report.rows.slice(0, 30).map(
          (r) =>
            `- [${r.direction === "receivable" ? "AR" : "AP"}] **${r.name}** (${r.taxCode || "—"}): **${fmtVnd(r.buckets.total)}** (${r.invoiceCount} HĐ, lâu nhất ${r.oldestDate})`
        )
      ].join("\n")
      return formatResult(response_format, md, report as unknown as Record<string, unknown>)
    })
  )

  // ---- 11. ttax_list_assets_depreciation ----
  server.registerTool(
    "ttax_list_assets_depreciation",
    {
      title: "List Fixed Assets & Prepaid Tools",
      description: "List all Fixed Assets (TSCĐ 211) and Prepaid Tools (CCDC 242) with monthly depreciation/allocation and remaining book value.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_list_assets_depreciation", ({ workspace_id, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const assets = service.listFixedAssets(wsId)
      const md = [
        `# Danh mục TSCĐ & CCDC (${assets.length})`,
        ...assets.map(
          (a) =>
            `- **${a.code}** ${a.name} (${a.assetType.toUpperCase()}) | Nguyên giá: ${fmtVnd(a.originalCostVnd)} | Trích/tháng: ${fmtVnd(a.monthlyDepreciationVnd)} | Còn lại: **${fmtVnd(a.remainingValueVnd)}** [${a.status}]`
        )
      ].join("\n")
      return formatResult(response_format, md, { count: assets.length, assets })
    })
  )

  // ---- 12. ttax_list_counterparties ----
  server.registerTool(
    "ttax_list_counterparties",
    {
      title: "List Counterparties & MST Risk",
      description: "List vendors and customers with MST risk status, default category/account, and transaction volume.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_list_counterparties", ({ workspace_id, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const counterparties = service.listCounterparties(wsId)
      const md = [
        `# Đối tác MST (${counterparties.length})`,
        ...counterparties.slice(0, 60).map(
          (c) =>
            `- **${c.name}** (MST \`${c.taxCode}\`) · Trạng thái: ${c.status} · ${c.txCount} chứng từ · Tổng: ${fmtVnd(c.totalAmountVnd)}`
        )
      ].join("\n")
      return formatResult(response_format, md, { count: counterparties.length, counterparties })
    })
  )

  // ---- 13. ttax_list_smart_rules ----
  server.registerTool(
    "ttax_list_smart_rules",
    {
      title: "List Smart Categorization Rules",
      description: "List auto-categorization and VAS debit-account mapping rules configured for the workspace.",
      inputSchema: z.strictObject({
        workspace_id: z.string().optional(),
        response_format: ResponseFormatSchema
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    wrap("ttax_list_smart_rules", ({ workspace_id, response_format }) => {
      const wsId = resolveWorkspaceId(service, workspace_id, opts.defaultWorkspaceId)
      const rules = service.listSmartRules(wsId)
      const md = [
        `# Quy tắc Định khoản Tự động (${rules.length})`,
        ...rules.map(
          (r) =>
            `- **${r.name}** [${r.enabled ? "Bật" : "Tắt"}] | Nếu ${r.matchField} ${r.matchType} "${r.pattern}" → Danh mục: ${r.assignCategoryCode || "—"}, TK Nợ: ${r.assignDebitAccount || "—"} (${r.hitCount} lần áp dụng)`
        )
      ].join("\n")
      return formatResult(response_format, md, { count: rules.length, rules })
    })
  )

  // ---- Write Tools (guarded by opts.readOnly) ----
  if (!opts.readOnly) {
    // 14. ttax_create_transaction
    server.registerTool(
      "ttax_create_transaction",
      {
        title: "Create Transaction & Auto VAS Journal",
        description:
          "Create a new input (purchase/expense) or output (sales/revenue) transaction in T-Tax and automatically post balanced VAS journal entries. Enforces workspace lockDate.",
        inputSchema: z.strictObject({
          workspace_id: z.string().optional(),
          name: z.string().min(1).describe("Transaction title / description"),
          direction: z.enum(["input", "output"]).describe("'input' (mua vào) or 'output' (bán ra)"),
          merchant: z.string().optional(),
          merchant_tax_code: z.string().optional(),
          invoice_symbol: z.string().optional(),
          invoice_number: z.string().optional(),
          pre_tax_amount: z.number().min(0),
          vat_amount: z.number().min(0).default(0),
          total_amount: z.number().min(0).optional(),
          currency_code: z.string().default("VND"),
          category_code: z.string().optional(),
          issued_at: z.string().optional().describe("YYYY-MM-DD"),
          payment_method: z.string().optional(),
          payment_status: z.enum(["paid", "unpaid", "partial"]).default("paid"),
          note: z.string().optional()
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      wrap("ttax_create_transaction", async (args) => {
        const wsId = resolveWorkspaceId(service, args.workspace_id, opts.defaultWorkspaceId)
        const total = args.total_amount ?? args.pre_tax_amount + args.vat_amount
        const created = await service.createManualTransaction(wsId, {
          name: args.name,
          direction: args.direction,
          merchant: args.merchant,
          merchantTaxCode: args.merchant_tax_code,
          invoiceSymbol: args.invoice_symbol,
          invoiceNumber: args.invoice_number,
          preTaxAmount: args.pre_tax_amount,
          vatAmount: args.vat_amount,
          totalAmount: total,
          currencyCode: args.currency_code,
          categoryCode: args.category_code,
          issuedAt: args.issued_at,
          paymentMethod: args.payment_method,
          paymentStatus: args.payment_status,
          note: args.note
        })
        return formatResult(
          "json",
          `Đã tạo giao dịch ${created.id}`,
          created as unknown as Record<string, unknown>
        )
      })
    )

    // 15. ttax_create_journal_voucher
    server.registerTool(
      "ttax_create_journal_voucher",
      {
        title: "Create Manual VAS Journal Voucher",
        description:
          "Post a manual double-entry VAS journal voucher (∑Nợ = ∑Có). Enforces workspace lockDate.",
        inputSchema: z.strictObject({
          workspace_id: z.string().optional(),
          voucher_no: z.string().optional(),
          voucher_date: z.string().describe("YYYY-MM-DD"),
          description: z.string().min(1),
          lines: z
            .array(
              z.strictObject({
                debit_account: z.string().min(2),
                credit_account: z.string().min(2),
                amount_vnd: z.number().positive(),
                description: z.string().optional()
              })
            )
            .min(1)
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      wrap("ttax_create_journal_voucher", (args) => {
        const wsId = resolveWorkspaceId(service, args.workspace_id, opts.defaultWorkspaceId)
        const entry = service.createManualJournalEntry(wsId, {
          voucherNo: args.voucher_no,
          voucherDate: args.voucher_date,
          description: args.description,
          lines: args.lines.map((l) => ({
            debitAccount: l.debit_account,
            creditAccount: l.credit_account,
            amountVnd: l.amount_vnd,
            description: l.description
          }))
        })
        return formatResult("json", `Đã lập phiếu kế toán ${entry.voucherNo}`, entry as unknown as Record<string, unknown>)
      })
    )

    // 16. ttax_apply_smart_rule
    server.registerTool(
      "ttax_apply_smart_rule",
      {
        title: "Create Smart Categorization Rule",
        description:
          "Save a reusable auto-categorization & VAS account mapping rule and optionally apply it to existing unlocked ledger rows.",
        inputSchema: z.strictObject({
          workspace_id: z.string().optional(),
          name: z.string().min(1),
          match_field: z.enum(["merchant", "merchantTaxCode", "name", "description", "any"]).default("any"),
          match_type: z.enum(["contains", "equals", "regex"]).default("contains"),
          pattern: z.string().min(1),
          direction: z.enum(["all", "input", "output"]).default("all"),
          assign_category_code: z.string().optional(),
          assign_debit_account: z.string().optional(),
          apply_retroactively: z.boolean().default(false)
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      wrap("ttax_apply_smart_rule", (args) => {
        const wsId = resolveWorkspaceId(service, args.workspace_id, opts.defaultWorkspaceId)
        const rule = service.upsertSmartRule(wsId, {
          name: args.name,
          matchField: args.match_field,
          matchType: args.match_type,
          pattern: args.pattern,
          direction: args.direction,
          assignCategoryCode: args.assign_category_code,
          assignDebitAccount: args.assign_debit_account
        })
        const applied = args.apply_retroactively ? service.applySmartRulesToLedger(wsId) : { updatedCount: 0 }
        return formatResult("json", `Đã tạo quy tắc ${rule.name}`, { rule, updatedCount: applied.updatedCount })
      })
    )
  }

  // ---- Resources (6 static & template resources) ----
  server.registerResource(
    "workspace-info",
    "ttax://workspace/info",
    { title: "Workspace Info", description: "Active T-Tax workspace metadata, MST, regime and lockDate", mimeType: "application/json" },
    async (uri) => {
      const wsId = resolveWorkspaceId(service, undefined, opts.defaultWorkspaceId)
      const ws = service.listWorkspaces().find((w) => w.id === wsId)
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ws ?? {}, null, 2) }] }
    }
  )

  server.registerResource(
    "vat-summary",
    "ttax://tax/vat-summary",
    { title: "VAT Summary", description: "Current workspace VAT output, input and net payable summary", mimeType: "application/json" },
    async (uri) => {
      const wsId = resolveWorkspaceId(service, undefined, opts.defaultWorkspaceId)
      const s = service.getDashboardStats(wsId)
      const payload = { outputVat: s.outputVat, inputVat: s.inputVat, vatPayable: s.vatPayable, revenuePreTax: s.revenuePreTax, expensePreTax: s.expensePreTax }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] }
    }
  )

  server.registerResource(
    "audit-anomalies",
    "ttax://audit/anomalies",
    { title: "Tax Risk Audit Report", description: "Live Vietnam tax risk & anomaly findings for active workspace", mimeType: "application/json" },
    async (uri) => {
      const wsId = resolveWorkspaceId(service, undefined, opts.defaultWorkspaceId)
      const report = service.runTaxAudit(wsId)
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }] }
    }
  )

  server.registerResource(
    "cashflow-forecast",
    "ttax://reports/cashflow-forecast",
    { title: "Cashflow Forecast", description: "Live cash balance, burn rate, runway and 6-month forecast", mimeType: "application/json" },
    async (uri) => {
      const wsId = resolveWorkspaceId(service, undefined, opts.defaultWorkspaceId)
      const cf = service.getCashflowAnalytics(wsId, 6)
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(cf, null, 2) }] }
    }
  )

  server.registerResource(
    "vn-tax-rules",
    "ttax://legal/vn-tax-rules",
    { title: "Vietnam Tax Legal Rules", description: "Built-in Vietnam legal knowledge base (TT99/2025, ND 70/2025, Law 48/2024)", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(DEFAULT_VN_LEGAL_RULES, null, 2) }]
    })
  )

  server.registerResource(
    "transaction-by-id",
    new ResourceTemplate("ttax://transactions/{transactionId}", {
      list: async () => {
        const wsId = resolveWorkspaceId(service, undefined, opts.defaultWorkspaceId)
        const { rows } = service.listTransactions(wsId, { limit: 15, offset: 0 })
        return {
          resources: rows.map((r) => ({
            uri: `ttax://transactions/${r.id}`,
            name: `${r.invoiceNumber ? `HĐ ${r.invoiceNumber} · ` : ""}${r.merchant || r.name || r.id}`,
            mimeType: "application/json" as const
          }))
        }
      }
    }),
    { title: "Transaction Detail", description: "Full details of a single transaction by UUID", mimeType: "application/json" },
    async (uri, { transactionId }) => {
      const id = String(transactionId ?? "").trim()
      if (!id) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "transactionId is required")
      const wsId = resolveWorkspaceId(service, undefined, opts.defaultWorkspaceId)
      const detail = service.getTransactionDetail(wsId, id)
      if (!detail) throw new ResourceNotFoundError(uri.href)
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(detail, null, 2) }] }
    }
  )

  // ---- Prompts (5 Vietnam Accounting & Tax Workflows) ----
  server.registerPrompt(
    "vn_tax_audit_briefing",
    {
      title: "Kiểm toán Rủi ro Thuế Việt Nam",
      description: "Chạy kiểm toán rủi ro hóa đơn & thuế GTGT/TNDN và lập kế hoạch khắc phục ưu tiên."
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Hãy chạy ttax_run_tax_audit và ttax_get_financial_overview cho doanh nghiệp hiện tại. Tổng hợp điểm tuân thủ, tổng giá trị VAT & TNDN đang có rủi ro bị loại, liệt kê top 5 chứng từ cần xử lý ngay theo mức độ nghiêm trọng và đề xuất cách khắc phục cụ thể theo Luật Thuế GTGT 48/2024 và NĐ 70/2025."
          }
        }
      ]
    })
  )

  server.registerPrompt(
    "vat_period_closing_review",
    {
      title: "Rà soát Khóa sổ & Tờ khai GTGT",
      description: "Kiểm tra Bảng cân đối TK 1331/3331, tổng VAT kỳ và chuẩn bị kết chuyển cuối kỳ.",
      argsSchema: z.object({
        date_from: z.string().optional().describe("Ngày đầu kỳ YYYY-MM-DD"),
        date_to: z.string().optional().describe("Ngày cuối kỳ YYYY-MM-DD")
      })
    },
    async ({ date_from, date_to }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hãy rà soát khóa sổ thuế GTGT giai đoạn ${date_from || "đầu kỳ"} đến ${date_to || "hiện tại"}: gọi ttax_get_financial_overview, ttax_get_trial_balance, ttax_get_account_ledger cho TK 1331 và 33311, và ttax_run_tax_audit. Đối chiếu chênh lệch giữa bảng kê hóa đơn và sổ cái, sau đó nêu rõ số thuế phải nộp hoặc còn khấu trừ kỳ sau.`
          }
        }
      ]
    })
  )

  server.registerPrompt(
    "cashflow_runway_forecast",
    {
      title: "Dự báo Dòng tiền & Nghĩa vụ Thuế",
      description: "Phân tích burn rate, runway, chi phí định kỳ và dự báo dòng tiền 3/6/12 tháng.",
      argsSchema: z.object({
        months: completable(
          z.enum(["3", "6", "12"]).optional().describe("Số tháng dự báo (3, 6 hoặc 12)"),
          (v) => (["3", "6", "12"] as const).filter((x) => x.startsWith(v ?? ""))
        )
      })
    },
    async ({ months }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Gọi ttax_get_cashflow_forecast với months=${months ?? "6"} và ttax_get_ar_ap_aging. Lập bảng dự báo dòng tiền theo tháng gồm dòng tiền vào/ra, dự phòng thuế GTGT/TNDN, danh sách định phí lớn nhất và cảnh báo tháng có rủi ro thiếu hụt tiền mặt.`
          }
        }
      ]
    })
  )

  server.registerPrompt(
    "ar_ap_debt_followup",
    {
      title: "Kế hoạch Thu hồi Công nợ AR/AP",
      description: "Phân tích tuổi nợ quá hạn và soạn thông điệp nhắc nợ khách hàng."
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Gọi ttax_get_ar_ap_aging và ttax_list_counterparties. Lập danh sách ưu tiên thu hồi công nợ Phải thu (AR 131) theo tuổi nợ từ cao xuống thấp (>90 ngày trước), đối chiếu Phải trả (AP 331) đến hạn, và soạn 2 mẫu email nhắc thanh toán lịch sự bằng tiếng Việt."
          }
        }
      ]
    })
  )

  server.registerPrompt(
    "expense_optimization_review",
    {
      title: "Tối ưu Chi phí & Định phí",
      description: "Phân tích cơ cấu chi phí, định phí lặp và cơ hội tiết kiệm chi phí được trừ TNDN."
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Gọi ttax_get_financial_overview, ttax_get_cashflow_forecast và ttax_list_assets_depreciation. Đánh giá các nhóm chi phí chiếm tỷ trọng cao nhất, liệt kê chi phí định kỳ có thể tối ưu và kiểm tra lịch trích khấu hao TSCĐ/CCDC để đảm bảo ghi nhận đầy đủ chi phí hợp lý."
          }
        }
      ]
    })
  )

  return server
}
