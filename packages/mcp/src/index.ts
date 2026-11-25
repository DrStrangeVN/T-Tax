export {
  createTTaxMcpServer,
  TTAX_MCP_VERSION,
  TTAX_MCP_TOOL_CATALOG,
  TTAX_MCP_RESOURCES_CATALOG,
  TTAX_MCP_PROMPTS_CATALOG,
  type TTaxMcpServerOptions,
  type TTaxMcpToolDescriptor
} from "./server.js"
export {
  createTTaxWebMcpHandler,
  TTaxLocalMcpHttpHost,
  type WebMcpHandlerOptions
} from "./http-host.js"
export {
  testExternalMcpServer,
  callExternalMcpTool,
  buildCopilotExternalMcpTools,
  invokeBuiltInMcpTool
} from "./client-hub.js"
export { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
export { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"
export { InMemoryTransport } from "@modelcontextprotocol/server"
