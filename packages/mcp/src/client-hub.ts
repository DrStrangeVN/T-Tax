import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import type { CopilotExternalToolDef, ExternalMcpServerConfig } from "@t-tax/core"
import type { TTaxService } from "@t-tax/db"
import { createTTaxMcpServer } from "./server.js"

function buildClientTransport(cfg: ExternalMcpServerConfig) {
  if (cfg.transport === "http") {
    if (!cfg.url?.trim()) throw new Error("Thiếu URL cho MCP Server HTTP.")
    const headers: Record<string, string> = {}
    if (cfg.bearerToken?.trim()) {
      headers.Authorization = `Bearer ${cfg.bearerToken.trim()}`
    }
    return new StreamableHTTPClientTransport(new URL(cfg.url.trim()), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined
    })
  }

  if (!cfg.command?.trim()) throw new Error("Thiếu lệnh (command) cho MCP Server stdio.")
  return new StdioClientTransport({
    command: cfg.command.trim(),
    args: Array.isArray(cfg.args) ? cfg.args : [],
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) }
  })
}

export async function testExternalMcpServer(cfg: ExternalMcpServerConfig): Promise<{
  ok: boolean
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  message: string
}> {
  const client = new Client({ name: "t-tax-mcp-client", version: "0.1.0" })
  try {
    const transport = buildClientTransport(cfg)
    await client.connect(transport)
    const listed = await client.listTools()
    const tools = listed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined
    }))
    return {
      ok: true,
      tools,
      message: `Kết nối thành công tới "${cfg.name}" — phát hiện ${tools.length} MCP tools.`
    }
  } catch (err) {
    return {
      ok: false,
      tools: [],
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    await client.close().catch(() => {})
  }
}

export async function callExternalMcpTool(
  cfg: ExternalMcpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; text: string; structuredContent?: unknown }> {
  const client = new Client({ name: "t-tax-mcp-client", version: "0.1.0" })
  try {
    const transport = buildClientTransport(cfg)
    await client.connect(transport)
    const res = await client.callTool({ name: toolName, arguments: args })
    const content = Array.isArray(res.content) ? res.content : []
    const text = content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
      .join("\n")
    return {
      isError: Boolean(res.isError),
      text,
      structuredContent: res.structuredContent
    }
  } finally {
    await client.close().catch(() => {})
  }
}

export function buildCopilotExternalMcpTools(servers: ExternalMcpServerConfig[]): CopilotExternalToolDef[] {
  const defs: CopilotExternalToolDef[] = []
  for (const srv of servers) {
    if (!srv.enabled || !Array.isArray(srv.cachedTools)) continue
    for (const t of srv.cachedTools) {
      defs.push({
        serverId: srv.id,
        serverName: srv.name,
        name: t.name,
        description: t.description || t.name,
        execute: async (args) => callExternalMcpTool(srv, t.name, args)
      })
    }
  }
  return defs
}

/**
 * In-process MCP playground invocation (uses real MCP Protocol via InMemoryTransport-style local HTTP or direct server pair).
 * Executes any built-in T-Tax MCP tool with full Zod validation and exact MCP output.
 */
export async function invokeBuiltInMcpTool(
  service: TTaxService,
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; text: string; structuredContent?: unknown; durationMs: number }> {
  const started = Date.now()
  const server = createTTaxMcpServer(service, { defaultWorkspaceId: workspaceId })
  const { InMemoryTransport } = await import("@modelcontextprotocol/server")
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "t-tax-playground", version: "0.1.0" })
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const res = await client.callTool({ name: toolName, arguments: args })
    const content = Array.isArray(res.content) ? res.content : []
    const text = content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
      .join("\n")
    return {
      isError: Boolean(res.isError),
      text,
      structuredContent: res.structuredContent,
      durationMs: Date.now() - started
    }
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}
