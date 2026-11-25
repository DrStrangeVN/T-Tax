#!/usr/bin/env node
/**
 * T-Tax Model Context Protocol (MCP v2) Standalone Server.
 * - Default transport: stdio (for Claude Desktop, Cursor, Antigravity, Windsurf, Claude Code, Gemini CLI)
 * - Streamable HTTP transport: TRANSPORT=http PORT=3939 TTAX_MCP_TOKEN=... node dist/cli.js
 *
 * IMPORTANT: Never log to stdout in stdio mode — stdout carries JSON-RPC frames.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { openTTaxDatabase, TTaxService, VaultStorage } from "@t-tax/db"
import { createTTaxMcpServer } from "./server.js"
import { TTaxLocalMcpHttpHost } from "./http-host.js"

function resolveDefaultDataDir(): string {
  if (process.env.TTAX_DATA_DIR) return process.env.TTAX_DATA_DIR
  if (process.env.TTAX_USER_DATA_DIR) return process.env.TTAX_USER_DATA_DIR
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "T-Tax")
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || homedir(), "T-Tax")
  }
  return join(homedir(), ".t-tax")
}

async function main() {
  const dataDir = resolveDefaultDataDir()
  const dbPath = join(dataDir, "ttax.db")
  const vaultDir = join(dataDir, "vault")

  const conn = openTTaxDatabase(dbPath)
  const vault = new VaultStorage(vaultDir)
  const service = new TTaxService(conn.db, conn.sqlite, vault)
  const ws = service.ensureWorkspace()

  const readOnly = process.env.TTAX_MCP_READ_ONLY === "1"
  const defaultWorkspaceId = process.env.TTAX_WORKSPACE_ID || ws.id

  if (process.env.TRANSPORT === "http") {
    const port = Number(process.env.PORT ?? 3939)
    const host = new TTaxLocalMcpHttpHost(service, process.env.TTAX_MCP_TOKEN)
    host.setDefaultWorkspaceId(defaultWorkspaceId)
    const st = await host.start(port)
    console.error(`[t-tax-mcp] Streamable HTTP listening at ${st.url} (dataDir=${dataDir})`)
    const shutdown = async () => {
      await host.stop()
      conn.close()
      process.exit(0)
    }
    process.on("SIGINT", () => void shutdown())
    process.on("SIGTERM", () => void shutdown())
  } else {
    serveStdio(() => createTTaxMcpServer(service, { defaultWorkspaceId, readOnly }))
    console.error(`[t-tax-mcp] stdio server ready (dataDir=${dataDir}, workspace=${ws.taxCode})`)
  }
}

main().catch((err) => {
  console.error("[t-tax-mcp] fatal:", err)
  process.exit(1)
})
