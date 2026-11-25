import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { openTTaxDatabase, TTaxService, VaultStorage } from "@t-tax/db"
import {
  Client,
  createTTaxMcpServer,
  getDefaultEnvironment,
  InMemoryTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  TTaxLocalMcpHttpHost
} from "@t-tax/mcp"

describe("Round 4: AI Intelligence, Tax Audit, Cashflow, AR/AP, Fixed Assets, Smart Rules & MCP v2", () => {
  let tempDir: string
  let dbPath: string
  let vaultDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ttax-r4-"))
    dbPath = join(tempDir, "ttax.db")
    vaultDir = join(tempDir, "vault")
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 })
    } catch {
      // Windows may briefly hold SQLite WAL handles after subprocess exit
    }
  })

  it("runs deep Vietnam Tax Audit, Cashflow Forecast, AR/AP Aging, Fixed Assets Depreciation, Smart Rules & Offline AI Copilot", async () => {
    const conn = openTTaxDatabase(dbPath)
    const vault = new VaultStorage(vaultDir)
    const service = new TTaxService(conn.db, conn.sqlite, vault)
    const ws = service.ensureWorkspace()

    // Seed opening cash balance 1121 = 100M / 4111 = 100M
    service.saveOpeningBalances(ws.id, [
      { accountCode: "1121", openingDebit: 100_000_000, openingCredit: 0 },
      { accountCode: "4111", openingDebit: 0, openingCredit: 100_000_000 }
    ])

    // 1. Seed transactions triggering: non-cash >=5M cash violation, duplicate invoice, category drift, recurring vendor & amount spike, AR/AP unpaid
    await service.createManualTransaction(ws.id, {
      name: "Mua máy tính thanh toán tiền mặt",
      merchant: "CÔNG TY THIẾT BỊ ABC",
      merchantTaxCode: "0311112222",
      direction: "input",
      invoiceSymbol: "1C26TAA",
      invoiceNumber: "00005555",
      preTaxAmount: 10_000_000,
      vatAmount: 1_000_000,
      totalAmount: 11_000_000,
      issuedAt: "2026-07-05",
      paymentMethod: "Tiền mặt",
      paymentStatus: "paid",
      categoryCode: "office"
    })
    // Duplicate invoice number
    await service.createManualTransaction(ws.id, {
      name: "Bản trùng hóa đơn 00005555",
      merchant: "CÔNG TY THIẾT BỊ ABC",
      merchantTaxCode: "0311112222",
      direction: "input",
      invoiceSymbol: "1C26TAA",
      invoiceNumber: "00005555",
      preTaxAmount: 10_000_000,
      vatAmount: 1_000_000,
      totalAmount: 11_000_000,
      issuedAt: "2026-07-05",
      paymentMethod: "Chuyển khoản",
      paymentStatus: "unpaid",
      categoryCode: "software"
    })
    // Recurring monthly cloud vendor + 1 price spike
    for (const [dt, amt] of [
      ["2026-04-01", 2_000_000],
      ["2026-05-01", 2_000_000],
      ["2026-06-01", 2_000_000],
      ["2026-07-01", 9_000_000]
    ] as const) {
      await service.createManualTransaction(ws.id, {
        name: `Cloud Server ${dt}`,
        merchant: "Cloud VN JSC",
        merchantTaxCode: "0309998887",
        direction: "input",
        preTaxAmount: amt,
        vatAmount: 0,
        totalAmount: amt,
        issuedAt: dt,
        paymentMethod: "Chuyển khoản",
        paymentStatus: "paid",
        categoryCode: "software"
      })
    }
    // Overdue Receivable (> 90 days)
    await service.createManualTransaction(ws.id, {
      name: "Hợp đồng triển khai ERP",
      merchant: "Khách hàng Enterprise X",
      merchantTaxCode: "0108887776",
      direction: "output",
      preTaxAmount: 30_000_000,
      vatAmount: 3_000_000,
      totalAmount: 33_000_000,
      issuedAt: "2026-01-10",
      paymentMethod: "Chuyển khoản",
      paymentStatus: "unpaid",
      categoryCode: "sales"
    })

    // Verify Tax Audit
    const audit = service.runTaxAudit(ws.id)
    expect(audit.totalTransactions).toBe(7)
    expect(audit.healthScore).toBeLessThan(100)
    const codes = new Set(audit.anomalies.map((a) => a.code))
    expect(codes.has("NON_CASH_THRESHOLD_VIOLATION")).toBe(true)
    expect(codes.has("DUPLICATE_INVOICE_NO")).toBe(true)
    expect(codes.has("VENDOR_CATEGORY_DRIFT")).toBe(true)
    expect(codes.has("AMOUNT_SPIKE_ANOMALY")).toBe(true)
    expect(audit.summary.totalVatAtRiskVnd).toBeGreaterThanOrEqual(2_000_000)

    // Verify Cashflow Analytics & Recurring Detection
    const cf = service.getCashflowAnalytics(ws.id, 6)
    expect(cf.forecastMonths).toHaveLength(6)
    expect(cf.recurringExpenses.some((r) => r.merchant === "Cloud VN JSC")).toBe(true)

    // Verify AR/AP Aging + Excel Export
    const aging = service.getArApAging(ws.id, "2026-07-20")
    expect(aging.receivableTotal).toBe(33_000_000)
    expect(aging.receivableBuckets.over90).toBe(33_000_000)
    expect(aging.payableTotal).toBe(11_000_000)
    const agingExcel = await service.exportArApAgingExcel(ws.id, "2026-07-20")
    expect(agingExcel.buffer.byteLength).toBeGreaterThan(1000)

    // Verify Fixed Assets & Monthly Depreciation
    const laptop = service.createFixedAsset(ws.id, {
      name: "MacBook Pro M4 Max",
      assetType: "tscd",
      purchaseDate: "2026-06-01",
      originalCostVnd: 36_000_000,
      usefulLifeMonths: 36
    })
    const desk = service.createFixedAsset(ws.id, {
      name: "Bộ bàn ghế văn phòng",
      assetType: "ccdc",
      purchaseDate: "2026-06-15",
      originalCostVnd: 12_000_000,
      usefulLifeMonths: 12
    })
    expect(laptop.monthlyDepreciationVnd).toBe(1_000_000)
    expect(desk.monthlyDepreciationVnd).toBe(1_000_000)

    const depRun = service.runMonthlyDepreciation(ws.id, "2026-07")
    expect(depRun.postedCount).toBe(2)
    expect(depRun.totalAmountVnd).toBe(2_000_000)
    expect(depRun.voucherNo).toMatch(/^KH-202607-/)
    // Idempotent for same period
    const depRepeat = service.runMonthlyDepreciation(ws.id, "2026-07")
    expect(depRepeat.postedCount).toBe(0)

    const afterDep = service.listFixedAssets(ws.id)
    expect(afterDep.find((a) => a.id === laptop.id)?.remainingValueVnd).toBe(35_000_000)

    // Verify Smart Rules Proposals + Apply
    const proposals = service.proposeSmartRules(ws.id)
    expect(proposals.some((p) => p.pattern === "0309998887")).toBe(true)
    service.upsertSmartRule(ws.id, {
      name: "Rule Cloud VN",
      matchField: "merchantTaxCode",
      matchType: "equals",
      pattern: "0309998887",
      direction: "input",
      assignCategoryCode: "software",
      assignDebitAccount: "6428"
    })
    const applied = service.applySmartRulesToLedger(ws.id)
    expect(applied.updatedCount).toBe(4)

    // Verify Offline AI Copilot + Persistent Sessions
    const chat1 = await service.chatWithCopilot(ws.id, { prompt: "Kiểm toán rủi ro thuế kỳ này" })
    expect(chat1.assistantMessage.content).toContain("Kiểm toán Rủi ro Thuế")
    expect(chat1.assistantMessage.toolTraces?.some((t) => t.toolName === "ttax_run_tax_audit")).toBe(true)
    const chat2 = await service.chatWithCopilot(ws.id, {
      sessionId: chat1.session.id,
      prompt: "Báo cáo công nợ phải thu phải trả"
    })
    expect(chat2.assistantMessage.content).toContain("Phải thu")
    expect(service.listAiMessages(chat1.session.id)).toHaveLength(4)

    conn.close()
  })

  it("verifies T-Tax MCP v2 Server over InMemoryTransport, Streamable HTTP (with Bearer auth), and stdio subprocess", async () => {
    const conn = openTTaxDatabase(dbPath)
    const vault = new VaultStorage(vaultDir)
    const service = new TTaxService(conn.db, conn.sqlite, vault)
    const ws = service.ensureWorkspace()

    // 1. InMemoryTransport full protocol verification (Tools + Resources + Prompts + Error Handling)
    const server = createTTaxMcpServer(service, { defaultWorkspaceId: ws.id })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "unit-test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.length).toBe(16)
    expect(tools.map((t) => t.name)).toContain("ttax_run_tax_audit")
    expect(tools.map((t) => t.name)).toContain("ttax_get_cashflow_forecast")
    expect(tools.map((t) => t.name)).toContain("ttax_create_transaction")

    const { resources } = await client.listResources()
    expect(resources.length).toBeGreaterThanOrEqual(5)
    const { prompts } = await client.listPrompts()
    expect(prompts.length).toBe(5)

    // Write tool via MCP -> then read back via audit & overview
    const created = await client.callTool({
      name: "ttax_create_transaction",
      arguments: {
        name: "MCP Created Expense",
        direction: "input",
        merchant: "Vendor MCP",
        pre_tax_amount: 6_000_000,
        vat_amount: 600_000,
        payment_method: "Tiền mặt",
        issued_at: "2026-07-10"
      }
    })
    expect(created.isError).toBeFalsy()

    const auditCall = await client.callTool({
      name: "ttax_run_tax_audit",
      arguments: { response_format: "json" }
    })
    expect(auditCall.isError).toBeFalsy()
    const auditStructured = auditCall.structuredContent as { anomalies: Array<{ code: string }> }
    expect(auditStructured.anomalies.some((a) => a.code === "NON_CASH_THRESHOLD_VIOLATION")).toBe(true)

    const wsRes = await client.readResource({ uri: "ttax://workspace/info" })
    expect(wsRes.contents[0] && "text" in wsRes.contents[0] ? wsRes.contents[0].text : "").toContain(ws.taxCode)

    const promptRes = await client.getPrompt({ name: "vn_tax_audit_briefing", arguments: {} })
    expect(promptRes.messages.length).toBe(1)

    // Invalid argument must return isError: true
    const badCall = await client.callTool({
      name: "ttax_get_transaction",
      arguments: { transaction_id: "non-existent-id" }
    })
    expect(badCall.isError).toBe(true)

    await client.close()
    await server.close()

    // 2. Streamable HTTP MCP host + Bearer Auth enforcement
    const httpHost = new TTaxLocalMcpHttpHost(service, "secret-test-token-123")
    const status = await httpHost.start(13941)
    expect(status.running).toBe(true)
    try {
      const unauth = await fetch(status.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
      expect(unauth.status).toBe(401)

      const httpClient = new Client({ name: "http-smoke", version: "1.0.0" })
      const httpTransport = new StreamableHTTPClientTransport(new URL(status.url), {
        requestInit: { headers: { Authorization: `Bearer ${status.bearerToken}` } }
      })
      await httpClient.connect(httpTransport)
      const httpTools = await httpClient.listTools()
      expect(httpTools.tools.length).toBe(16)
      const ov = await httpClient.callTool({
        name: "ttax_get_financial_overview",
        arguments: { response_format: "json" }
      })
      expect(ov.isError).toBeFalsy()
      expect((ov.structuredContent as { expensePreTax: number }).expensePreTax).toBe(6_000_000)
      await httpClient.close()
    } finally {
      await httpHost.stop()
    }

    conn.close()

    // 3. Stdio subprocess smoke test against built packages/mcp/dist/cli.js
    const stdioClient = new Client({ name: "stdio-smoke", version: "1.0.0" })
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("packages/mcp/dist/cli.js")],
      env: { ...getDefaultEnvironment(), TTAX_DATA_DIR: tempDir }
    })
    await stdioClient.connect(stdioTransport)
    const stdioTools = await stdioClient.listTools()
    expect(stdioTools.tools.length).toBe(16)
    const wsCall = await stdioClient.callTool({
      name: "ttax_list_workspaces",
      arguments: { response_format: "json" }
    })
    expect(wsCall.isError).toBeFalsy()
    expect((wsCall.structuredContent as { count: number }).count).toBeGreaterThanOrEqual(1)
    await stdioClient.close()
  })
})
