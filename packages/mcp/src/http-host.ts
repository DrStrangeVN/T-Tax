import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createMcpHandler } from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"
import type { McpHostStatus } from "@t-tax/core"
import type { TTaxService } from "@t-tax/db"
import { createTTaxMcpServer, type TTaxMcpServerOptions } from "./server.js"

function safeBearerMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(provided, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isAllowedLocalHost(hostHeader: string | null): boolean {
  if (!hostHeader) return true
  const host = hostHeader.split(":")[0]?.toLowerCase() ?? ""
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]"
}

export interface WebMcpHandlerOptions extends TTaxMcpServerOptions {
  bearerToken?: string
  allowRemoteHost?: boolean
}

/**
 * Web-standard Streamable HTTP MCP handler compatible with Hono (`app.all("/mcp", c => handler(c.req.raw))`)
 * and Node HTTP servers via `toNodeHandler`.
 */
export function createTTaxWebMcpHandler(service: TTaxService, opts: WebMcpHandlerOptions = {}) {
  const mcpHandler = createMcpHandler(() => createTTaxMcpServer(service, opts))

  const fetch = async (request: Request): Promise<Response> => {
    // DNS rebinding protection on localhost bindings
    if (!opts.allowRemoteHost) {
      const hostHeader = request.headers.get("host")
      if (!isAllowedLocalHost(hostHeader)) {
        return new Response(JSON.stringify({ error: "Forbidden host header" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        })
      }
      const origin = request.headers.get("origin")
      if (origin) {
        try {
          const originHost = new URL(origin).hostname.toLowerCase()
          if (originHost !== "127.0.0.1" && originHost !== "localhost" && originHost !== "::1") {
            return new Response(JSON.stringify({ error: "Forbidden origin" }), {
              status: 403,
              headers: { "Content-Type": "application/json" }
            })
          }
        } catch {
          return new Response(JSON.stringify({ error: "Invalid origin" }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          })
        }
      }
    }

    // Optional Bearer Token enforcement
    if (opts.bearerToken) {
      const auth = request.headers.get("authorization") ?? ""
      const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : ""
      if (!token || !safeBearerMatch(opts.bearerToken, token)) {
        return new Response(JSON.stringify({ error: "Unauthorized — valid Bearer token required" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="t-tax-mcp"'
          }
        })
      }
    }

    return mcpHandler.fetch(request)
  }

  return { fetch }
}

/**
 * Toggleable local Streamable HTTP MCP host embedded in Electron Desktop main process.
 */
export class TTaxLocalMcpHttpHost {
  private httpServer: HttpServer | null = null
  private host = "127.0.0.1"
  private port = 3939
  private bearerToken: string
  private requestCount = 0
  private recentLogs: McpHostStatus["recentLogs"] = []
  private defaultWorkspaceId?: string

  constructor(
    private readonly service: TTaxService,
    initialToken?: string
  ) {
    this.bearerToken = initialToken || `ttax_${randomBytes(18).toString("hex")}`
  }

  setDefaultWorkspaceId(wsId?: string) {
    this.defaultWorkspaceId = wsId
  }

  rotateToken(): string {
    this.bearerToken = `ttax_${randomBytes(18).toString("hex")}`
    return this.bearerToken
  }

  getStatus(): McpHostStatus {
    return {
      running: Boolean(this.httpServer?.listening),
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}/mcp`,
      bearerToken: this.bearerToken,
      requestCount: this.requestCount,
      recentLogs: [...this.recentLogs]
    }
  }

  async start(port = this.port): Promise<McpHostStatus> {
    if (this.httpServer?.listening) {
      if (port === this.port) return this.getStatus()
      await this.stop()
    }
    this.port = port

    const webHandler = createTTaxWebMcpHandler(this.service, {
      defaultWorkspaceId: this.defaultWorkspaceId,
      bearerToken: this.bearerToken,
      onAuditLog: (entry) => {
        this.requestCount += 1
        this.recentLogs.unshift({
          ts: new Date().toISOString(),
          ...entry
        })
        if (this.recentLogs.length > 40) this.recentLogs.length = 40
      }
    })
    const nodeHandler = toNodeHandler(webHandler)

    await new Promise<void>((resolve, reject) => {
      const srv = createHttpServer((req, res) => {
        const pathname = new URL(req.url || "/", `http://${this.host}:${this.port}`).pathname
        if (pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, service: "t-tax-mcp", running: true }))
          return
        }
        if (pathname !== "/mcp") {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Not found. Use /mcp for Streamable HTTP MCP." }))
          return
        }
        void nodeHandler(req, res)
      })
      srv.once("error", reject)
      srv.listen(this.port, this.host, () => {
        this.httpServer = srv
        resolve()
      })
    })

    return this.getStatus()
  }

  async stop(): Promise<McpHostStatus> {
    if (!this.httpServer) return this.getStatus()
    const srv = this.httpServer
    this.httpServer = null
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    return this.getStatus()
  }
}
