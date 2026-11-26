import { describe, expect, it, vi, afterEach } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  adviseOnDocumentWithAi,
  callMuse2ApiChat,
  discoverMuse2Api,
  mergeMissingProviderPresets,
  requestFlexibleJsonWithFallback,
  runTTaxCopilot,
  testProviderVisionSupport,
  type LLMProviderConfig,
  type WorkspaceDTO
} from "@t-tax/core"

async function startMockMuseServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(Buffer.from(c)))
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const DEMO_WS: WorkspaceDTO = {
  id: "ws-1",
  name: "Công ty TNHH Kiểm thử T-Tax",
  taxCode: "0312345678",
  entityType: "enterprise",
  accountingRegime: "TT99_2025",
  fiscalYearStart: "01-01",
  baseCurrency: "VND",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z"
}

describe("Muse2API Integration, Discovery, Failover & Grounded Copilot", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("merges newly added muse2api preset into existing saved provider lists without losing priority", () => {
    const existing: LLMProviderConfig[] = [
      { provider: "openai_compatible", apiKey: "ollama", model: "qwen3-vl:8b-instruct", baseUrl: "http://localhost:11434/v1", enabled: true },
      { provider: "google", apiKey: "secret", model: "gemini-2.5-flash", enabled: false }
    ]
    const merged = mergeMissingProviderPresets(existing)
    expect(merged[0]?.provider).toBe("openai_compatible")
    expect(merged[1]?.provider).toBe("google")
    const muse = merged.find((p) => p.provider === "muse2api")
    expect(muse).toBeTruthy()
    expect(muse?.model).toBe("muse-spark")
    expect(muse?.baseUrl).toBe("http://127.0.0.1:18611/v1")
    expect(muse?.enabled).toBe(false)
  })

  it("discovers Muse2API server, validates Bearer auth, and tests Vision PNG ping", async () => {
    let sawImagePart = false
    const srv = await startMockMuseServer((req, body, res) => {
      res.setHeader("Content-Type", "application/json")
      if (req.url === "/healthz") {
        res.end(JSON.stringify({ status: "ok", version: "1.6.12" }))
        return
      }
      if (req.url === "/readyz") {
        res.end(JSON.stringify({ status: "ready", accounts: 9, browser_running: true }))
        return
      }
      if (req.headers.authorization !== "Bearer test-muse-key") {
        res.statusCode = 401
        res.end(JSON.stringify({ error: { message: "invalid api key" } }))
        return
      }
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ object: "list", data: [{ id: "muse-spark", vision: true, description: "Muse Spark" }] }))
        return
      }
      if (req.url === "/v1/health/deep") {
        res.end(JSON.stringify({ ok: true, cdp_ok: true, valid_accounts: 6, enabled_accounts: 9, vision_chat: true }))
        return
      }
      if (req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as { messages: Array<{ content: unknown }> }
        const content = parsed.messages[0]?.content
        if (Array.isArray(content) && content.some((p: Record<string, unknown>) => p.type === "image_url")) {
          sawImagePart = true
        }
        res.end(JSON.stringify({ model: "muse-spark", choices: [{ message: { role: "assistant", content: "ok" } }] }))
        return
      }
      res.statusCode = 404
      res.end("{}")
    })

    try {
      const noKey = await discoverMuse2Api(srv.baseUrl)
      expect(noKey.reachable).toBe(true)
      expect(noKey.authRequired).toBe(true)
      expect(noKey.accountsTotal).toBe(9)

      const withKey = await discoverMuse2Api(srv.baseUrl, "test-muse-key")
      expect(withKey.reachable).toBe(true)
      expect(withKey.authValid).toBe(true)
      expect(withKey.validAccounts).toBe(6)
      expect(withKey.visionSupported).toBe(true)

      const ping = await testProviderVisionSupport({
        provider: "muse2api",
        apiKey: "test-muse-key",
        model: "muse-spark",
        baseUrl: srv.baseUrl,
        enabled: true
      })
      expect(ping.success).toBe(true)
      expect(ping.supportsVision).toBe(true)
      expect(sawImagePart).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it("automatically fails over from broken/weak local provider to Muse2API backup and salvages JSON", async () => {
    let callCount = 0
    const srv = await startMockMuseServer((req, _body, res) => {
      res.setHeader("Content-Type", "application/json")
      if (req.url === "/v1/chat/completions") {
        callCount += 1
        res.end(
          JSON.stringify({
            model: "muse-spark",
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    '```json\n{"documentKind":"handwritten_bill","merchant":"PGL Motor","total":1340000,"currencyCode":"VND","categoryCode":"travel","items":[{"name":"Day Curoa","amount":450000}]}\n```'
                }
              }
            ]
          })
        )
        return
      }
      res.statusCode = 404
      res.end("{}")
    })

    try {
      const res = await requestFlexibleJsonWithFallback(
        [
          {
            provider: "openai_compatible",
            apiKey: "ollama",
            model: "qwen3-vl:8b-instruct",
            baseUrl: "http://127.0.0.1:19998/v1",
            enabled: true
          },
          {
            provider: "muse2api",
            apiKey: "k",
            model: "muse-spark",
            baseUrl: srv.baseUrl,
            enabled: true
          }
        ],
        {
          prompt: "Extract receipt JSON",
          attachments: [{ filename: "bill.jpg", mediaType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff]) }]
        }
      )
      expect(res.provider).toBe("muse2api")
      expect(res.backupUsed).toBe(true)
      expect(res.output.total).toBe(1340000)
      expect(callCount).toBe(1)
    } finally {
      await srv.close()
    }
  })

  it("grounds Muse2API Copilot with real SQLite tools for synthesis/proposals and handles image upload draft action", async () => {
    const promptsReceived: string[] = []
    const srv = await startMockMuseServer((req, body, res) => {
      res.setHeader("Content-Type", "application/json")
      if (req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> }
        const combined = parsed.messages.map((m) => String(m.content)).join("\n")
        promptsReceived.push(combined)
        res.end(
          JSON.stringify({
            model: "muse-spark",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Tổng hợp: Doanh thu 180.000.000 đ, rủi ro tiền mặt 26.400.000 đ. Đề xuất chuyển khoản và lập bảng kê 01/TNDN."
                }
              }
            ]
          })
        )
        return
      }
      res.statusCode = 404
      res.end("{}")
    })

    try {
      const museCfg: LLMProviderConfig = {
        provider: "muse2api",
        apiKey: "k",
        model: "muse-spark",
        baseUrl: srv.baseUrl,
        enabled: true
      }

      const backend = {
        getOverview: async () => ({ revenuePreTax: 180_000_000, expensePreTax: 59_000_000, vatPayable: 12_100_000 }),
        searchTransactions: async () => ({ rows: [] }),
        getTrialBalance: async () => [],
        runTaxAudit: async () => ({
          scannedAt: "2026-11-26",
          totalTransactions: 4,
          healthScore: 78,
          summary: { critical: 1, high: 0, medium: 0, info: 0, totalVatAtRiskVnd: 2_400_000, totalCitAtRiskVnd: 4_800_000 },
          anomalies: []
        }),
        getCashflowForecast: async () => ({
          currentCashVnd: 200_000_000,
          averageMonthlyRevenueVnd: 180_000_000,
          averageMonthlyBurnVnd: 59_000_000,
          netMonthlyCashflowVnd: 121_000_000,
          runwayMonths: null,
          recurringMonthlyTotalVnd: 35_000_000,
          recurringExpenses: [],
          forecastMonths: [],
          estimatedQuarterlyCitVnd: 24_000_000,
          estimatedVatPayableVnd: 12_100_000
        }),
        getArApAging: async () => ({
          asOfDate: "2026-11-26",
          receivableTotal: 70_200_000,
          payableTotal: 0,
          receivableBuckets: { current0To30: 0, days31To60: 70_200_000, days61To90: 0, over90: 0, total: 70_200_000 },
          payableBuckets: { current0To30: 0, days31To60: 0, days61To90: 0, over90: 0, total: 0 },
          rows: []
        }),
        listFixedAssets: async () => [],
        listCounterparties: async () => [],
        analyzeAttachment: async () => ({
          savedFileId: "file-bill-1",
          outcome: {
            extractionMethod: "vlm" as const,
            documentKind: "handwritten_bill" as const,
            confidence: 0.94,
            auditIssues: [],
            extractedFields: {
              name: "PGL Motor — Sửa xe",
              merchant: "PGL Motor",
              total: 1_340_000,
              preTaxAmount: 1_340_000,
              vatAmount: 0,
              currencyCode: "VND",
              categoryCode: "travel",
              paymentMethod: "Tiền mặt"
            },
            items: [{ index: 1, name: "Dây Curoa", preTaxAmount: 450_000, amount: 450_000 }],
            provenance: {},
            tokensUsed: 120,
            providerUsed: "muse2api:muse-spark"
          }
        })
      }

      // 1. Grounded synthesis & proposals
      const synth = await runTTaxCopilot({
        workspace: DEMO_WS,
        prompt: "Tổng hợp toàn diện tình hình tài chính và đề xuất tối ưu thuế",
        history: [],
        providers: [museCfg],
        backend
      })
      expect(synth.providerUsed).toBe("muse2api/muse-spark")
      expect(synth.toolTraces.map((t) => t.toolName)).toContain("ttax_get_financial_overview")
      expect(synth.toolTraces.map((t) => t.toolName)).toContain("ttax_run_tax_audit")
      expect(synth.toolTraces.map((t) => t.toolName)).toContain("ttax_get_cashflow_forecast")
      expect(promptsReceived[0]).toContain("180000000")

      // 2. Direct image attachment in Copilot produces extractedBill + ingest_bill_draft action
      const imgChat = await runTTaxCopilot({
        workspace: DEMO_WS,
        prompt: "Đọc bill sửa xe này và hướng dẫn hạch toán",
        history: [],
        providers: [museCfg],
        backend,
        attachments: [{ filename: "pgl.jpg", mediaType: "image/jpeg", base64: "AQID" }]
      })
      expect(imgChat.extractedBill?.totalAmount).toBe(1_340_000)
      expect(imgChat.actions.some((a) => a.kind === "ingest_bill_draft")).toBe(true)

      // 3. Direct callMuse2ApiChat & adviseOnDocumentWithAi
      const direct = await callMuse2ApiChat({
        baseUrl: srv.baseUrl,
        apiKey: "k",
        messages: [{ role: "user", content: "Ping" }]
      })
      expect(direct.text).toContain("Tổng hợp")

      const adv = await adviseOnDocumentWithAi({
        workspace: DEMO_WS,
        draft: { name: "Sửa xe", totalAmount: 1_340_000, documentKind: "handwritten_bill", currencyCode: "VND" },
        providers: [museCfg]
      })
      expect(adv.providerUsed).toBe("muse2api/muse-spark")
    } finally {
      await srv.close()
    }
  })
})
