import { generateText, stepCountIs, tool, type ToolSet } from "ai"
import { z } from "zod"
import { callMuse2ApiChat, createLanguageModel, isProviderUsable } from "./providers.js"
import type { DocumentAnalysisOutcome } from "./pipeline.js"
import type {
  AiCopilotAction,
  AiCopilotToolTrace,
  ArApAgingReport,
  CashflowAnalytics,
  CopilotAttachmentInput,
  CopilotExtractedBillDraft,
  FixedAssetDTO,
  LLMProviderConfig,
  LLMProviderType,
  TaxAuditReport,
  TrialBalanceRow,
  WorkspaceDTO
} from "../types.js"

export interface CopilotExternalToolDef {
  serverId: string
  serverName: string
  name: string
  description: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

export interface CopilotToolBackend {
  getOverview: (dateFrom?: string, dateTo?: string) => Promise<Record<string, unknown>>
  searchTransactions: (query: string, limit?: number) => Promise<Record<string, unknown>>
  getTrialBalance: (dateFrom?: string, dateTo?: string) => Promise<TrialBalanceRow[]>
  runTaxAudit: () => Promise<TaxAuditReport>
  getCashflowForecast: (months?: number) => Promise<CashflowAnalytics>
  getArApAging: () => Promise<ArApAgingReport>
  listFixedAssets: () => Promise<FixedAssetDTO[]>
  listCounterparties: () => Promise<Array<Record<string, unknown>>>
  analyzeAttachment?: (
    att: CopilotAttachmentInput,
    preferredProvider?: LLMProviderType
  ) => Promise<{ outcome: DocumentAnalysisOutcome; savedFileId?: string }>
  externalMcpTools?: CopilotExternalToolDef[]
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
}

function fmtVnd(n: number): string {
  return `${Math.round(n).toLocaleString("vi-VN")} đ`
}

function outcomeToBillDraft(outcome: DocumentAnalysisOutcome, fallbackName: string): CopilotExtractedBillDraft {
  const f = outcome.extractedFields
  const totalAmount = Number(f.total ?? 0) || 0
  const vatAmount = Number(f.vatAmount ?? 0) || 0
  const preTaxRaw = Number(f.preTaxAmount ?? 0) || 0
  const preTaxAmount = preTaxRaw > 0 ? preTaxRaw : Math.max(0, totalAmount - vatAmount)
  return {
    documentKind: outcome.documentKind,
    name: String(f.name ?? fallbackName),
    merchant: f.merchant ? String(f.merchant) : null,
    merchantTaxCode: f.merchantTaxCode ? String(f.merchantTaxCode) : f.sellerTaxCode ? String(f.sellerTaxCode) : null,
    issuedAt: f.issuedAt ? String(f.issuedAt) : null,
    currencyCode: String(f.currencyCode ?? "VND"),
    preTaxAmount,
    vatAmount,
    totalAmount,
    categoryCode: String(f.categoryCode ?? "other"),
    paymentMethod: f.paymentMethod ? String(f.paymentMethod) : null,
    invoiceSymbol: f.invoiceSymbol ? String(f.invoiceSymbol) : null,
    invoiceNumber: f.invoiceNumber ? String(f.invoiceNumber) : null,
    amountInWords: outcome.amountInWords ?? null,
    items: outcome.items,
    auditIssues: outcome.auditIssues
  }
}

function formatBillExtractionMarkdown(draft: CopilotExtractedBillDraft, providerUsed?: string): string {
  const cur = draft.currencyCode || "VND"
  const fmtAmt = (v: number) =>
    cur === "VND" ? fmtVnd(v) : `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${cur}`
  const lines: string[] = [
    `### Kết quả bóc tách chứng từ${draft.documentKind === "handwritten_bill" ? " (Hóa đơn viết tay)" : ""}`,
    `- **Nội dung / Mặt hàng:** **${draft.name}**`,
    `- **Đơn vị bán / Cửa hàng:** ${draft.merchant || "*(Chưa ghi trên phiếu)*"}${draft.merchantTaxCode ? ` · MST \`${draft.merchantTaxCode}\`` : ""}`,
    `- **Ngày chứng từ:** ${draft.issuedAt || "*(Chưa rõ ngày)*"} · **Hình thức TT:** ${draft.paymentMethod || "Tiền mặt"}`,
    `- **Tiền trước thuế:** ${fmtAmt(draft.preTaxAmount ?? 0)} · **VAT:** ${fmtAmt(draft.vatAmount ?? 0)} · **Tổng thanh toán:** **${fmtAmt(draft.totalAmount)}**`,
    `- **Phân loại đề xuất:** \`${draft.categoryCode || "other"}\`${providerUsed ? ` · *Nguồn: ${providerUsed}*` : ""}`
  ]
  if (draft.amountInWords) {
    lines.push(`- **Bằng chữ:** *${draft.amountInWords}*`)
  }
  if (draft.items && draft.items.length > 0) {
    lines.push(`\n**Chi tiết dòng hàng (${draft.items.length} mục):**`)
    for (const it of draft.items.slice(0, 12)) {
      lines.push(`- ${it.name}${it.quantity ? ` (SL: ${it.quantity})` : ""}: **${fmtAmt(it.amount)}**`)
    }
    if (draft.items.length > 12) {
      lines.push(`- *... và ${draft.items.length - 12} dòng hàng khác.*`)
    }
  }
  if (draft.auditIssues && draft.auditIssues.length > 0) {
    lines.push(`\n**Lưu ý tuân thủ & đối soát:**`)
    for (const iss of draft.auditIssues) {
      lines.push(`- **[${iss.severity.toUpperCase()}]** ${iss.message}`)
    }
  }
  return lines.join("\n")
}

export function buildDeterministicBillAdvice(
  workspace: WorkspaceDTO,
  draft: CopilotExtractedBillDraft
): string {
  const isHandwritten = draft.documentKind === "handwritten_bill" || draft.documentKind === "printed_receipt"
  const isCashOver5m =
    (draft.currencyCode || "VND") === "VND" &&
    draft.totalAmount >= 5_000_000 &&
    (!draft.paymentMethod || /tien mat|tiền mặt|cash/i.test(draft.paymentMethod))

  const lines: string[] = [
    `### Hướng dẫn Hạch toán & Tuân thủ Thuế (${workspace.accountingRegime.replace("_", " ")})`,
    `- **Phân loại & TK chi phí gợi ý:** Danh mục \`${draft.categoryCode || "other"}\` → Nợ TK chi phí tương ứng (${workspace.accountingRegime === "TT133_2016" ? "6422/154" : "6427/6428/156"})${draft.vatAmount && draft.vatAmount > 0 ? " + Nợ TK 1331 (Thuế GTGT được khấu trừ)" : ""} / Có TK ${isHandwritten ? "1111 (Tiền mặt)" : "1121 hoặc 331"}.`
  ]

  if (isHandwritten && (!draft.merchantTaxCode || (draft.vatAmount ?? 0) === 0)) {
    lines.push(
      `- **Khấu trừ thuế GTGT:** Không có hóa đơn điện tử GTGT nên đặt thuế suất \`KCT\`, không khấu trừ thuế GTGT đầu vào.`
    )
    lines.push(
      `- **Chi phí được trừ TNDN (NĐ 70/2025 & TT 78/96):** Nếu mua hàng/dịch vụ của cá nhân/hộ kinh doanh không xuất HĐĐT, cần lập **Bảng kê thu mua hàng hóa, dịch vụ không có hóa đơn (Mẫu 01/TNDN)** kèm CCCD người bán và chứng từ thanh toán.`
    )
  }
  if (isCashOver5m) {
    lines.push(
      `- **Cảnh báo ngưỡng thanh toán không dùng tiền mặt (Luật Thuế GTGT 48/2024/QH15 từ 01/07/2025):** Giá trị **${fmtVnd(draft.totalAmount)}** ≥ 5.000.000 đ — cần ủy nhiệm chi / sao kê chuyển khoản ngân hàng để bảo vệ quyền khấu trừ GTGT và chi phí TNDN.`
    )
  }
  lines.push(
    `- **Bước tiếp theo:** Kiểm tra lại tên NCC, ngày chứng từ, số tiền rồi bấm **Đưa vào Sổ giao dịch** hoặc mở **Hộp thư AI** để đối chiếu trực tiếp cạnh ảnh gốc.`
  )
  return lines.join("\n")
}

export async function adviseOnDocumentWithAi(params: {
  workspace: WorkspaceDTO
  draft: CopilotExtractedBillDraft
  providers: LLMProviderConfig[]
  question?: string
}): Promise<{ advice: string; providerUsed: string }> {
  const usable = params.providers.filter(isProviderUsable)
  const q =
    params.question?.trim() ||
    "Hãy kiểm tra chứng từ này, hướng dẫn cách hạch toán Nợ/Có chuẩn chế độ kế toán của công ty, tư vấn điều kiện khấu trừ thuế GTGT & chi phí được trừ TNDN, và nêu rõ các rủi ro cần kế toán rà soát."

  const systemPrompt = [
    `Bạn là Chuyên gia Kế toán trưởng & Tư vấn Thuế Việt Nam (Thông tư 99/2025/TT-BTC, TT200, TT133, Hộ kinh doanh TT88/2026, Luật Thuế GTGT 48/2024/QH15 ngưỡng không dùng tiền mặt 5 triệu từ 01/07/2025, Nghị định 70/2025/NĐ-CP).`,
    `Đơn vị: ${params.workspace.name} | MST: ${params.workspace.taxCode} | Chế độ KT: ${params.workspace.accountingRegime}.`,
    `Trả lời ngắn gọn, thực chiến, bằng tiếng Việt, chia rõ 3 mục: (1) Định khoản Nợ/Có đề xuất, (2) Quy định thuế GTGT & TNDN áp dụng, (3) Checklist cần kế toán kiểm tra/bổ sung hồ sơ.`
  ].join("\n")

  const docContext = JSON.stringify(params.draft, null, 2)

  // Prefer muse2api first if enabled (fast, deep Vietnamese tax reasoning), else follow priority order
  const ordered = [
    ...usable.filter((p) => p.provider === "muse2api"),
    ...usable.filter((p) => p.provider !== "muse2api")
  ]

  for (const cfg of ordered) {
    try {
      if (cfg.provider === "muse2api") {
        const res = await callMuse2ApiChat({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model || "muse-spark",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Thông tin chứng từ đã bóc tách:\n\`\`\`json\n${docContext}\n\`\`\`\n\nYêu cầu: ${q}` }
          ],
          timeoutMs: 90_000
        })
        return { advice: res.text, providerUsed: `muse2api/${res.model}` }
      }
      const model = createLanguageModel(cfg)
      const res = await generateText({
        model,
        system: systemPrompt,
        prompt: `Thông tin chứng từ đã bóc tách:\n\`\`\`json\n${docContext}\n\`\`\`\n\nYêu cầu: ${q}`
      })
      if (res.text.trim()) {
        return { advice: res.text.trim(), providerUsed: `${cfg.provider}/${cfg.model}` }
      }
    } catch {
      // Try next configured provider
    }
  }

  return {
    advice: buildDeterministicBillAdvice(params.workspace, params.draft),
    providerUsed: "local-deterministic-engine"
  }
}

export async function runTTaxCopilot(params: {
  workspace: WorkspaceDTO
  prompt: string
  history: Array<{ role: "user" | "assistant"; content: string }>
  providers: LLMProviderConfig[]
  backend: CopilotToolBackend
  attachments?: CopilotAttachmentInput[]
  preferredProvider?: LLMProviderType
}): Promise<{
  content: string
  toolTraces: AiCopilotToolTrace[]
  actions: AiCopilotAction[]
  extractedBill?: CopilotExtractedBillDraft
  providerUsed: string
}> {
  const toolTraces: AiCopilotToolTrace[] = []
  const actions: AiCopilotAction[] = []

  const track = async <T>(
    toolName: string,
    source: "ttax" | "mcp",
    args: Record<string, unknown>,
    fn: () => Promise<T>,
    summarize: (res: T) => string,
    serverName?: string
  ): Promise<T> => {
    const start = Date.now()
    try {
      const res = await fn()
      toolTraces.push({
        toolName,
        source,
        serverName,
        args,
        summary: summarize(res),
        ok: true,
        durationMs: Date.now() - start
      })
      return res
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toolTraces.push({
        toolName,
        source,
        serverName,
        args,
        summary: `Lỗi: ${msg}`,
        ok: false,
        durationMs: Date.now() - start
      })
      throw err
    }
  }

  let enabledProviders = params.providers.filter(isProviderUsable)
  if (params.preferredProvider) {
    const pref = enabledProviders.filter((p) => p.provider === params.preferredProvider)
    const rest = enabledProviders.filter((p) => p.provider !== params.preferredProvider)
    if (pref.length > 0) enabledProviders = [...pref, ...rest]
  }

  // 0. MULTIMODAL BILL/IMAGE ATTACHMENT FLOW:
  // User uploaded an invoice/receipt image or PDF directly inside Copilot -> extract verified values + give Vietnamese tax guidance + 1-click entry!
  if (params.attachments && params.attachments.length > 0) {
    const primaryAtt = params.attachments[0]!
    if (params.backend.analyzeAttachment) {
      const analyzed = await track(
        "ttax_analyze_bill_attachment",
        "ttax",
        { filename: primaryAtt.filename, mediaType: primaryAtt.mediaType, preferredProvider: params.preferredProvider },
        () => params.backend.analyzeAttachment!(primaryAtt, params.preferredProvider),
        (r) =>
          `${r.outcome.extractionMethod.toUpperCase()}${r.outcome.providerUsed ? ` (${r.outcome.providerUsed})` : ""} · Tổng: ${fmtVnd(Number(r.outcome.extractedFields.total ?? 0))}`
      )
      const draft = outcomeToBillDraft(analyzed.outcome, primaryAtt.filename)
      const extractionMd = formatBillExtractionMarkdown(draft, analyzed.outcome.providerUsed)

      // Ask Muse2API / active LLM for tailored accounting & tax guidance on this extracted bill
      const advisor = await adviseOnDocumentWithAi({
        workspace: params.workspace,
        draft,
        providers: enabledProviders,
        question: params.prompt
      })

      actions.push({
        label: `Ghi nhanh vào Sổ giao dịch (${fmtVnd(draft.totalAmount)})`,
        kind: "ingest_bill_draft",
        target: analyzed.savedFileId ? `file:${analyzed.savedFileId}` : "create_tx",
        payload: {
          ...draft,
          savedFileId: analyzed.savedFileId
        } as unknown as Record<string, unknown>
      })
      if (analyzed.savedFileId) {
        actions.push({
          label: "Mở trong Hộp thư AI để đối chiếu ảnh",
          kind: "navigate",
          target: "unsorted"
        })
      }

      return {
        content: `${extractionMd}\n\n---\n\n${advisor.advice}`,
        toolTraces,
        actions,
        extractedBill: draft,
        providerUsed: analyzed.outcome.providerUsed || advisor.providerUsed
      }
    }

    // Fallback direct Muse2API multimodal chat if no analyzeAttachment hook was wired
    const museCfg = enabledProviders.find((p) => p.provider === "muse2api")
    if (museCfg) {
      try {
        const cleanB64 = primaryAtt.base64.includes(",") ? primaryAtt.base64.split(",")[1]! : primaryAtt.base64
        const res = await callMuse2ApiChat({
          baseUrl: museCfg.baseUrl,
          apiKey: museCfg.apiKey,
          model: museCfg.model || "muse-spark",
          messages: [
            {
              role: "system",
              content: `Bạn là Trợ lý Kế toán Thuế T-Tax (${params.workspace.accountingRegime}). Hãy đọc ảnh hóa đơn/chứng từ đính kèm, trích xuất chính xác số tiền, nhà cung cấp, ngày, danh mục và tư vấn hạch toán bằng tiếng Việt.`
            },
            {
              role: "user",
              content: params.prompt,
              attachments: [
                {
                  filename: primaryAtt.filename,
                  mediaType: primaryAtt.mediaType,
                  buffer: Buffer.from(cleanB64, "base64")
                }
              ]
            }
          ]
        })
        return {
          content: res.text,
          toolTraces,
          actions,
          providerUsed: `muse2api/${res.model}`
        }
      } catch {
        // Fall through to text handling
      }
    }
  }

  // Helper to collect grounded real SQLite data for providers without native function calling (e.g. Muse2API)
  const collectGroundedSnapshot = async (): Promise<Record<string, unknown>> => {
    const qNorm = norm(params.prompt)
    const wantComprehensive =
      /tong hop|bao cao|toan dien|de xuat|khuyen nghi|toi uu|ke hoach|danh gia|hieu qua|tinh hinh|phan tich|tat ca/.test(qNorm)
    const wantAudit = wantComprehensive || /rui ro|kiem toan|bat thuong|trung|tien mat|canh bao|audit|loi|sai sot/.test(qNorm)
    const wantCashflow = wantComprehensive || /dong tien|du bao|runway|burn|dinh ky|forecast|chi phi lap|tndn|du kien/.test(qNorm)
    const wantAging = wantComprehensive || /cong no|phai thu|phai tra|qua han|tuoi no|ar|ap|nhac no/.test(qNorm)
    const wantTrial = wantComprehensive || /can doi|tai khoan|so cai|trial|but toan|1331|1121|331|131|511|642/.test(qNorm)
    const wantAssets = wantComprehensive || /tai san|tscd|ccdc|khau hao|phan bo|211|242/.test(qNorm)
    const wantCounterparties = wantComprehensive || /doi tac|nha cung cap|khach hang|mst/.test(qNorm)
    const wantSearch = /tim |hoa don |hd |so hd|tra cuu /.test(qNorm)

    const snapshot: Record<string, unknown> = {}
    const tasks: Array<Promise<void>> = [
      track(
        "ttax_get_financial_overview",
        "ttax",
        {},
        () => params.backend.getOverview(),
        (r) => `DT TT: ${fmtVnd(Number(r.revenuePreTax ?? 0))} · CP TT: ${fmtVnd(Number(r.expensePreTax ?? 0))}`
      ).then((r) => {
        snapshot.financialOverview = r
      })
    ]

    if (wantAudit) {
      tasks.push(
        track(
          "ttax_run_tax_audit",
          "ttax",
          {},
          () => params.backend.runTaxAudit(),
          (r) => `Điểm tuân thủ ${r.healthScore}/100 · ${r.anomalies.length} phát hiện`
        ).then((r) => {
          snapshot.taxAudit = {
            healthScore: r.healthScore,
            totalTransactions: r.totalTransactions,
            summary: r.summary,
            topAnomalies: r.anomalies.slice(0, 8)
          }
          actions.push({ label: "Mở Kiểm toán Rủi ro", kind: "navigate", target: "transactions" })
        })
      )
    }
    if (wantCashflow) {
      tasks.push(
        track(
          "ttax_get_cashflow_forecast",
          "ttax",
          { months: 6 },
          () => params.backend.getCashflowForecast(6),
          (r) => `Tiền hiện có: ${fmtVnd(r.currentCashVnd)} · Burn: ${fmtVnd(r.averageMonthlyBurnVnd)}/tháng`
        ).then((r) => {
          snapshot.cashflowForecast = r
        })
      )
    }
    if (wantAging) {
      tasks.push(
        track(
          "ttax_get_ar_ap_aging",
          "ttax",
          {},
          () => params.backend.getArApAging(),
          (r) => `Phải thu: ${fmtVnd(r.receivableTotal)} · Phải trả: ${fmtVnd(r.payableTotal)}`
        ).then((r) => {
          snapshot.arApAging = r
          actions.push({ label: "Mở Công nợ AR/AP", kind: "open_accounting", target: "aging" })
        })
      )
    }
    if (wantTrial) {
      tasks.push(
        track(
          "ttax_get_trial_balance",
          "ttax",
          {},
          () => params.backend.getTrialBalance(),
          (r) => `${r.length} tài khoản phát sinh`
        ).then((r) => {
          snapshot.trialBalance = r.slice(0, 20)
          actions.push({ label: "Mở Bảng Cân đối TK", kind: "open_accounting", target: "trial_balance" })
        })
      )
    }
    if (wantAssets) {
      tasks.push(
        track(
          "ttax_list_fixed_assets",
          "ttax",
          {},
          () => params.backend.listFixedAssets(),
          (r) => `${r.length} TSCĐ/CCDC`
        ).then((r) => {
          snapshot.fixedAssets = r.slice(0, 15)
        })
      )
    }
    if (wantCounterparties) {
      tasks.push(
        track(
          "ttax_list_counterparties",
          "ttax",
          {},
          () => params.backend.listCounterparties(),
          (r) => `${r.length} đối tác MST`
        ).then((r) => {
          snapshot.counterparties = r.slice(0, 15)
        })
      )
    }
    if (wantSearch) {
      const cleaned = params.prompt.replace(/^(tim|tìm|tra cuu|tra cứu|hoa don|hóa đơn|hd|hđ)\s+/i, "").trim().slice(0, 60)
      if (cleaned) {
        tasks.push(
          track(
            "ttax_search_transactions",
            "ttax",
            { query: cleaned, limit: 10 },
            () => params.backend.searchTransactions(cleaned, 10),
            (r) => `Tìm thấy ${Array.isArray(r.rows) ? r.rows.length : 0} giao dịch`
          ).then((r) => {
            snapshot.searchMatches = r
          })
        )
      }
    }

    await Promise.all(tasks)
    if (actions.length === 0) {
      actions.push(
        { label: "Mở Sổ Giao dịch", kind: "navigate", target: "transactions" },
        { label: "Mở Bảng kê GTGT", kind: "open_accounting", target: "vat" }
      )
    }
    return snapshot
  }

  // 1. Try configured LLM Providers (Muse2API grounded path OR Vercel AI SDK v7 multi-step Tool Calling)
  if (enabledProviders.length > 0) {
    const tools: ToolSet = {
      ttax_get_financial_overview: tool({
        description: "Lấy tổng quan tài chính, doanh thu/chi phí trước thuế, lãi/lỗ và thuế GTGT dự kiến nộp của doanh nghiệp.",
        inputSchema: z.object({
          dateFrom: z.string().optional().describe("Ngày bắt đầu YYYY-MM-DD"),
          dateTo: z.string().optional().describe("Ngày kết thúc YYYY-MM-DD")
        }),
        execute: async ({ dateFrom, dateTo }) =>
          track(
            "ttax_get_financial_overview",
            "ttax",
            { dateFrom, dateTo },
            () => params.backend.getOverview(dateFrom, dateTo),
            (r) => `DT TT: ${fmtVnd(Number(r.revenuePreTax ?? 0))} · CP TT: ${fmtVnd(Number(r.expensePreTax ?? 0))}`
          )
      }),
      ttax_run_tax_audit: tool({
        description: "Chạy kiểm toán rủi ro thuế GTGT/TNDN: phát hiện trùng hóa đơn, tiền mặt >= 5tr/20tr, lệch danh mục, tăng giá đột biến, MST rủi ro.",
        inputSchema: z.object({}),
        execute: async () =>
          track(
            "ttax_run_tax_audit",
            "ttax",
            {},
            () => params.backend.runTaxAudit(),
            (r) => `Điểm tuân thủ ${r.healthScore}/100 · ${r.anomalies.length} phát hiện`
          )
      }),
      ttax_get_cashflow_forecast: tool({
        description: "Phân tích dòng tiền, số dư tiền mặt/ngân hàng, burn rate, runway, chi phí định kỳ và dự báo 6 tháng tới.",
        inputSchema: z.object({
          months: z.number().int().min(1).max(12).optional()
        }),
        execute: async ({ months }) =>
          track(
            "ttax_get_cashflow_forecast",
            "ttax",
            { months },
            () => params.backend.getCashflowForecast(months ?? 6),
            (r) => `Tiền hiện có: ${fmtVnd(r.currentCashVnd)} · Burn: ${fmtVnd(r.averageMonthlyBurnVnd)}/tháng`
          )
      }),
      ttax_get_ar_ap_aging: tool({
        description: "Báo cáo tuổi nợ Công nợ Phải thu (AR 131) và Phải trả (AP 331) theo nhóm 0-30, 31-60, 61-90, >90 ngày.",
        inputSchema: z.object({}),
        execute: async () =>
          track(
            "ttax_get_ar_ap_aging",
            "ttax",
            {},
            () => params.backend.getArApAging(),
            (r) => `Phải thu: ${fmtVnd(r.receivableTotal)} · Phải trả: ${fmtVnd(r.payableTotal)}`
          )
      }),
      ttax_get_trial_balance: tool({
        description: "Lấy Bảng Cân đối Tài khoản VAS (Dư ĐK, Phát sinh Nợ/Có, Dư CK).",
        inputSchema: z.object({
          dateFrom: z.string().optional(),
          dateTo: z.string().optional()
        }),
        execute: async ({ dateFrom, dateTo }) =>
          track(
            "ttax_get_trial_balance",
            "ttax",
            { dateFrom, dateTo },
            () => params.backend.getTrialBalance(dateFrom, dateTo),
            (r) => `${r.length} tài khoản phát sinh`
          )
      }),
      ttax_search_transactions: tool({
        description: "Tìm kiếm hóa đơn, giao dịch theo số hóa đơn, tên đối tác, MST hoặc nội dung.",
        inputSchema: z.object({
          query: z.string().describe("Từ khóa tìm kiếm"),
          limit: z.number().int().min(1).max(30).optional()
        }),
        execute: async ({ query, limit }) =>
          track(
            "ttax_search_transactions",
            "ttax",
            { query, limit },
            () => params.backend.searchTransactions(query, limit ?? 10),
            (r) => `Tìm thấy ${Array.isArray(r.rows) ? r.rows.length : 0} giao dịch`
          )
      }),
      ttax_list_fixed_assets: tool({
        description: "Liệt kê danh sách Tài sản cố định (TSCĐ 211) và Công cụ dụng cụ (CCDC 242) kèm khấu hao tháng & giá trị còn lại.",
        inputSchema: z.object({}),
        execute: async () =>
          track(
            "ttax_list_fixed_assets",
            "ttax",
            {},
            () => params.backend.listFixedAssets(),
            (r) => `${r.length} TSCĐ/CCDC`
          )
      }),
      ttax_list_counterparties: tool({
        description: "Liệt kê đối tác (nhà cung cấp / khách hàng) kèm trạng thái rủi ro MST.",
        inputSchema: z.object({}),
        execute: async () =>
          track(
            "ttax_list_counterparties",
            "ttax",
            {},
            () => params.backend.listCounterparties(),
            (r) => `${r.length} đối tác MST`
          )
      })
    }

    // Attach enabled External MCP Server Tools dynamically
    for (const ext of params.backend.externalMcpTools ?? []) {
      const safeKey = `mcp_${ext.serverId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 12)}_${ext.name.replace(/[^a-zA-Z0-9_]/g, "_")}`
      tools[safeKey] = tool({
        description: `[MCP: ${ext.serverName}] ${ext.description || ext.name}`,
        inputSchema: z.record(z.string(), z.unknown()),
        execute: async (inputArgs) =>
          track(
            ext.name,
            "mcp",
            inputArgs,
            () => ext.execute(inputArgs),
            () => `Gọi MCP ${ext.serverName}/${ext.name} thành công`,
            ext.serverName
          )
      })
    }

    const systemPrompt = [
      `Bạn là T-Tax AI Copilot — Trợ lý Kế toán trưởng & Chuyên gia Thuế Việt Nam (Thông tư 99/2025/TT-BTC, TT200, TT133, Hộ kinh doanh TT88/2026, Luật Thuế GTGT 48/2024/QH15, Nghị định 70/2025/NĐ-CP).`,
      `Đơn vị đang làm việc: ${params.workspace.name} | MST: ${params.workspace.taxCode} | Chế độ KT: ${params.workspace.accountingRegime} | Ngày hiện tại: ${new Date().toISOString().slice(0, 10)}.`,
      `LUÔN dựa trên số liệu thật từ sổ sách SQLite (tuyệt đối không bịa số liệu). Nếu câu hỏi yêu cầu tra cứu quy định thuế/hướng dẫn nghiệp vụ, trả lời đầy đủ, trích dẫn đúng văn bản hiện hành và gắn với chế độ kế toán của đơn vị.`,
      `Trình bày câu trả lời bằng tiếng Việt rõ ràng, mạch lạc, định dạng số tiền chuẩn Việt Nam (ví dụ 12.000.000 đ) và kết thúc bằng đề xuất hành động cụ thể.`
    ].join("\n")

    let groundedSnapshot: Record<string, unknown> | null = null

    for (const cfg of enabledProviders) {
      try {
        if (cfg.provider === "muse2api") {
          // Grounding-first Muse2API path (muse.ai does not emit OpenAI function calls, so we inject real SQLite data directly!)
          if (!groundedSnapshot) {
            groundedSnapshot = await collectGroundedSnapshot()
          }
          const res = await callMuse2ApiChat({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model || "muse-spark",
            messages: [
              { role: "system", content: systemPrompt },
              ...params.history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
              {
                role: "user",
                content:
                  `DỮ LIỆU SỔ SÁCH THẬT TỪ T-TAX SQLITE (${params.workspace.name}, MST ${params.workspace.taxCode}):\n` +
                  `\`\`\`json\n${JSON.stringify(groundedSnapshot).slice(0, 14_000)}\n\`\`\`\n\n` +
                  `CÂU HỎI / YÊU CẦU CỦA NGƯỜI DÙNG:\n${params.prompt}`
              }
            ],
            timeoutMs: 120_000
          })
          return {
            content: res.text,
            toolTraces,
            actions,
            providerUsed: `muse2api/${res.model}`
          }
        }

        const model = createLanguageModel(cfg)
        const result = await generateText({
          model,
          system: systemPrompt,
          messages: [
            ...params.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content: params.prompt }
          ],
          tools,
          stopWhen: stepCountIs(6)
        })
        return {
          content: result.text || "Đã hoàn tất truy vấn sổ sách.",
          toolTraces,
          actions,
          providerUsed: `${cfg.provider}/${cfg.model}`
        }
      } catch {
        // Fallback to next provider (e.g. local Ollama -> Muse2API backup!) or deterministic local engine
      }
    }
  }

  // 2. Deterministic Local Vietnamese AI Copilot Engine (Zero API Key required — real SQLite queries!)
  const q = norm(params.prompt)
  const lines: string[] = []

  const wantExecutiveSummary = /tong hop toan dien|tom tat tai chinh|tinh hinh tai chinh/.test(q)
  const wantAudit = !wantExecutiveSummary && /rui ro|kiem toan|bat thuong|trung|tien mat|canh bao|audit|loi|sai sot/.test(q)
  const wantCashflow = !wantExecutiveSummary && /dong tien|du bao|runway|burn|dinh ky|forecast|chi phi lap|tndn|du kien/.test(q)
  const wantAging = !wantExecutiveSummary && /cong no|phai thu|phai tra|qua han|tuoi no|ar|ap|nhac no/.test(q)
  const wantTrial = !wantExecutiveSummary && /can doi|tai khoan|so cai|trial|but toan|1331|1121|331|131|511|642/.test(q)
  const wantAssets = !wantExecutiveSummary && /tai san|tscd|ccdc|khau hao|phan bo|211|242/.test(q)
  const wantCounterparties = !wantExecutiveSummary && /doi tac|nha cung cap|khach hang|mst/.test(q)
  const wantSearch = !wantExecutiveSummary && /tim |hoa don |hd |so hd|tra cuu /.test(q)

  if (wantAudit) {
    const audit = await track(
      "ttax_run_tax_audit",
      "ttax",
      {},
      () => params.backend.runTaxAudit(),
      (r) => `Điểm tuân thủ ${r.healthScore}/100 · ${r.anomalies.length} phát hiện`
    )
    lines.push(`### Kết quả Kiểm toán Rủi ro Thuế — ${params.workspace.name}`)
    lines.push(`- **Điểm sức khỏe tuân thủ:** **${audit.healthScore}/100** (quét ${audit.totalTransactions} giao dịch)`)
    lines.push(
      `- **Phân loại:** ${audit.summary.critical} Nghiêm trọng · ${audit.summary.high} Cao · ${audit.summary.medium} Trung bình · ${audit.summary.info} Lưu ý`
    )
    if (audit.summary.totalVatAtRiskVnd > 0 || audit.summary.totalCitAtRiskVnd > 0) {
      lines.push(
        `- **Giá trị thuế có rủi ro:** VAT có thể bị loại **${fmtVnd(audit.summary.totalVatAtRiskVnd)}** · Thuế TNDN rủi ro **${fmtVnd(audit.summary.totalCitAtRiskVnd)}**`
      )
    }
    if (audit.anomalies.length === 0) {
      lines.push(`\nKhông phát hiện rủi ro thuế hay giao dịch bất thường nào trong sổ hiện tại.`)
    } else {
      lines.push("")
      for (const a of audit.anomalies.slice(0, 6)) {
        lines.push(`- **[${a.severity.toUpperCase()}] ${a.title}** — ${a.description}`)
        lines.push(`  - *Khuyến nghị:* ${a.recommendation}`)
      }
      if (audit.anomalies[0]?.transactionIds[0]) {
        actions.push({ label: "Mở chứng từ rủi ro đầu tiên", kind: "open_tx", target: audit.anomalies[0].transactionIds[0] })
      }
    }
    actions.push({ label: "Mở Sổ giao dịch có cảnh báo", kind: "navigate", target: "transactions" })
  } else if (wantCashflow) {
    const cf = await track(
      "ttax_get_cashflow_forecast",
      "ttax",
      { months: 6 },
      () => params.backend.getCashflowForecast(6),
      (r) => `Tiền hiện có: ${fmtVnd(r.currentCashVnd)} · Burn: ${fmtVnd(r.averageMonthlyBurnVnd)}/tháng`
    )
    lines.push(`### Phân tích Dòng tiền & Dự báo 6 tháng tới`)
    lines.push(`- **Số dư tiền hiện tại (TK 111 + 112):** **${fmtVnd(cf.currentCashVnd)}**`)
    lines.push(`- **Doanh thu TB/tháng:** ${fmtVnd(cf.averageMonthlyRevenueVnd)} · **Chi tiêu (Burn) TB/tháng:** ${fmtVnd(cf.averageMonthlyBurnVnd)}`)
    lines.push(
      `- **Dòng tiền ròng/tháng:** **${fmtVnd(cf.netMonthlyCashflowVnd)}** · **Runway:** ${cf.runwayMonths === null ? "Dương (tự chủ dòng tiền)" : `${cf.runwayMonths} tháng`}`
    )
    lines.push(`- **Dự phòng Thuế TNDN quý (ước tính 20%):** ${fmtVnd(cf.estimatedQuarterlyCitVnd)} · **VAT dự kiến/tháng:** ${fmtVnd(cf.estimatedVatPayableVnd)}`)
    if (cf.recurringExpenses.length > 0) {
      lines.push(`\n**Định phí / Chi phí lặp tự phát hiện (${fmtVnd(cf.recurringMonthlyTotalVnd)}/tháng):**`)
      for (const r of cf.recurringExpenses.slice(0, 5)) {
        lines.push(`- ${r.merchant}: ~${fmtVnd(r.estimatedMonthlyVnd)}/tháng (${r.occurrences} kỳ, chu kỳ ~${r.intervalDays} ngày)`)
      }
    }
    actions.push({ label: "Xem Dashboard tổng quan", kind: "navigate", target: "dashboard" })
  } else if (wantAging) {
    const aging = await track(
      "ttax_get_ar_ap_aging",
      "ttax",
      {},
      () => params.backend.getArApAging(),
      (r) => `Phải thu: ${fmtVnd(r.receivableTotal)} · Phải trả: ${fmtVnd(r.payableTotal)}`
    )
    lines.push(`### Báo cáo Công nợ AR/AP & Tuổi nợ (tính đến ${aging.asOfDate})`)
    lines.push(
      `- **Tổng Phải thu khách hàng (AR 131):** **${fmtVnd(aging.receivableTotal)}** (0–30d: ${fmtVnd(aging.receivableBuckets.current0To30)} · >90d: ${fmtVnd(aging.receivableBuckets.over90)})`
    )
    lines.push(
      `- **Tổng Phải trả NCC (AP 331):** **${fmtVnd(aging.payableTotal)}** (0–30d: ${fmtVnd(aging.payableBuckets.current0To30)} · >90d: ${fmtVnd(aging.payableBuckets.over90)})`
    )
    if (aging.rows.length === 0) {
      lines.push(`\nHiện không có hóa đơn nào ở trạng thái chưa thanh toán hoặc thanh toán một phần.`)
    } else {
      lines.push("")
      for (const r of aging.rows.slice(0, 6)) {
        lines.push(
          `- **${r.direction === "receivable" ? "Phải thu" : "Phải trả"} · ${r.name}**${r.taxCode ? ` (MST ${r.taxCode})` : ""}: **${fmtVnd(r.buckets.total)}** (${r.invoiceCount} HĐ, lâu nhất ${r.oldestDate})`
        )
      }
    }
    actions.push({ label: "Mở tab Công nợ AR/AP", kind: "open_accounting", target: "aging" })
  } else if (wantAssets) {
    const assets = await track(
      "ttax_list_fixed_assets",
      "ttax",
      {},
      () => params.backend.listFixedAssets(),
      (r) => `${r.length} TSCĐ/CCDC`
    )
    const totalOriginal = assets.reduce((s, a) => s + a.originalCostVnd, 0)
    const totalRemain = assets.reduce((s, a) => s + a.remainingValueVnd, 0)
    const monthlyDep = assets.filter((a) => a.status === "active").reduce((s, a) => s + a.monthlyDepreciationVnd, 0)
    lines.push(`### Tổng hợp TSCĐ (211) & CCDC (242)`)
    lines.push(`- **Số lượng tài sản:** ${assets.length} · **Tổng nguyên giá:** ${fmtVnd(totalOriginal)}`)
    lines.push(`- **Giá trị còn lại:** **${fmtVnd(totalRemain)}** · **Khấu hao/Phân bổ dự kiến tháng:** **${fmtVnd(monthlyDep)}**`)
    for (const a of assets.slice(0, 6)) {
      lines.push(`- **${a.code} — ${a.name}** (${a.assetType.toUpperCase()}): còn lại ${fmtVnd(a.remainingValueVnd)} · trích ${fmtVnd(a.monthlyDepreciationVnd)}/tháng`)
    }
    actions.push({ label: "Mở tab TSCĐ & CCDC", kind: "open_accounting", target: "assets" })
  } else if (wantTrial) {
    const tb = await track(
      "ttax_get_trial_balance",
      "ttax",
      {},
      () => params.backend.getTrialBalance(),
      (r) => `${r.length} tài khoản phát sinh`
    )
    const sumDr = tb.reduce((s, r) => s + r.closingDebit, 0)
    const sumCr = tb.reduce((s, r) => s + r.closingCredit, 0)
    lines.push(`### Bảng Cân đối Tài khoản VAS (${params.workspace.accountingRegime})`)
    lines.push(`- **Tổng Dư Nợ CK:** ${fmtVnd(sumDr)} · **Tổng Dư Có CK:** ${fmtVnd(sumCr)} (${sumDr === sumCr ? "Cân đối chuẩn" : "Cần kiểm tra lệch"})`)
    for (const r of tb.slice(0, 10)) {
      lines.push(`- **TK ${r.code}** (${r.name}): PS Nợ ${fmtVnd(r.periodDebit)} · PS Có ${fmtVnd(r.periodCredit)} · CK Nợ ${fmtVnd(r.closingDebit)} / Có ${fmtVnd(r.closingCredit)}`)
    }
    actions.push({ label: "Mở Cân đối Tài khoản", kind: "open_accounting", target: "trial_balance" })
  } else if (wantCounterparties) {
    const cps = await track(
      "ttax_list_counterparties",
      "ttax",
      {},
      () => params.backend.listCounterparties(),
      (r) => `${r.length} đối tác MST`
    )
    lines.push(`### Danh sách Đối tác MST (${cps.length} đơn vị)`)
    for (const c of cps.slice(0, 8)) {
      lines.push(`- **${String(c.name ?? "")}** (MST \`${String(c.taxCode ?? "")}\`) — Trạng thái: ${String(c.riskStatus ?? "unknown")} · ${Number(c.txCount ?? 0)} chứng từ`)
    }
    actions.push({ label: "Mở Đối tác & Rủi ro MST", kind: "navigate", target: "counterparties" })
  } else if (wantSearch) {
    const cleaned = params.prompt.replace(/^(tim|tìm|tra cuu|tra cứu|hoa don|hóa đơn|hd|hđ)\s+/i, "").trim()
    const res = await track(
      "ttax_search_transactions",
      "ttax",
      { query: cleaned, limit: 8 },
      () => params.backend.searchTransactions(cleaned, 8),
      (r) => `Tìm thấy ${Array.isArray(r.rows) ? r.rows.length : 0} giao dịch`
    )
    const rows = (res.rows as Array<Record<string, unknown>>) ?? []
    lines.push(`### Kết quả tìm kiếm "${cleaned}" (${rows.length} chứng từ)`)
    if (rows.length === 0) {
      lines.push(`Không tìm thấy giao dịch khớp. Thử nhập số hóa đơn, MST hoặc tên nhà cung cấp ngắn hơn.`)
    } else {
      for (const r of rows.slice(0, 8)) {
        lines.push(`- **${String(r.issuedAt ?? "")}** · HĐ ${String(r.invoiceNumber ?? "—")} · ${String(r.merchant || r.name || "")} — **${fmtVnd(Number(r.totalAmount ?? 0))}**`)
      }
      if (rows[0]?.id) {
        actions.push({ label: "Mở hóa đơn đầu tiên", kind: "open_tx", target: String(rows[0].id) })
      }
    }
  } else {
    // Default executive summary: Financial Overview + Tax Audit quick health
    const [ov, audit] = await Promise.all([
      track(
        "ttax_get_financial_overview",
        "ttax",
        {},
        () => params.backend.getOverview(),
        (r) => `DT TT: ${fmtVnd(Number(r.revenuePreTax ?? 0))} · CP TT: ${fmtVnd(Number(r.expensePreTax ?? 0))}`
      ),
      track(
        "ttax_run_tax_audit",
        "ttax",
        {},
        () => params.backend.runTaxAudit(),
        (r) => `Điểm tuân thủ ${r.healthScore}/100`
      )
    ])
    const vatPayable = Number(ov.vatPayable ?? 0)
    lines.push(`### Tóm tắt Tài chính & Thuế — ${params.workspace.name} (MST ${params.workspace.taxCode})`)
    lines.push(`- **Doanh thu trước thuế:** **${fmtVnd(Number(ov.revenuePreTax ?? 0))}** (VAT ra: ${fmtVnd(Number(ov.outputVat ?? 0))})`)
    lines.push(`- **Chi phí trước thuế:** **${fmtVnd(Number(ov.expensePreTax ?? 0))}** (VAT vào: ${fmtVnd(Number(ov.inputVat ?? 0))})`)
    lines.push(`- **Lãi / Lỗ tạm tính (trước thuế):** **${fmtVnd(Number(ov.operatingProfit ?? 0))}**`)
    lines.push(
      `- **Thuế GTGT:** ${vatPayable >= 0 ? `Dự kiến nộp **${fmtVnd(vatPayable)}**` : `Còn được khấu trừ **${fmtVnd(Math.abs(vatPayable))}**`}`
    )
    lines.push(`- **Điểm kiểm toán tuân thủ:** **${audit.healthScore}/100** (${audit.anomalies.length} lưu ý cần rà soát · ${Number(ov.unreviewedCount ?? 0)} chứng từ chờ duyệt)`)
    lines.push(`\n*Gợi ý câu hỏi nhanh:* "Kiểm toán rủi ro thuế", "Dự báo dòng tiền 6 tháng", "Báo cáo công nợ phải thu phải trả", "Xem bảng cân đối tài khoản", hoặc cấu hình API Key AI (Gemini/OpenAI/Anthropic/Ollama) trong Cài đặt để bật suy luận LLM & MCP mở rộng.`)
    actions.push(
      { label: "Mở Sổ Giao dịch", kind: "navigate", target: "transactions" },
      { label: "Mở Bảng kê GTGT", kind: "open_accounting", target: "vat" }
    )
  }

  return {
    content: lines.join("\n"),
    toolTraces,
    actions,
    providerUsed: "local-deterministic-engine"
  }
}
