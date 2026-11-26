import { generateText, Output, type LanguageModel } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { z } from "zod"
import type { LLMProviderConfig, LLMProviderType, Muse2ApiDiscoveryResult } from "../types.js"
export { LLM_PROVIDER_PRESETS, mergeMissingProviderPresets, type ProviderPresetMeta } from "./presets.js"

const TINY_TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

export function createLanguageModel(config: LLMProviderConfig): LanguageModel {
  switch (config.provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey: config.apiKey })
      return openai(config.model)
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.apiKey })
      return google(config.model)
    }
    case "mistral": {
      const mistral = createMistral({ apiKey: config.apiKey })
      return mistral(config.model)
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.apiKey })
      return anthropic(config.model)
    }
    case "muse2api": {
      const muse = createOpenAICompatible({
        name: "muse2api",
        baseURL: normalizeMuseBaseUrl(config.baseUrl),
        apiKey: config.apiKey || "muse-local",
        supportsStructuredOutputs: false
      })
      return muse.chatModel(config.model || "muse-spark")
    }
    case "openai_compatible": {
      const compat = createOpenAICompatible({
        name: "custom-openai",
        baseURL: (config.baseUrl || "http://localhost:11434/v1").trim(),
        apiKey: config.apiKey || "not-needed",
        supportsStructuredOutputs: true
      })
      return compat.chatModel(config.model)
    }
  }
}

export function normalizeMuseBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || "http://127.0.0.1:18611/v1").trim().replace(/\/+$/, "")
  return /\/v1$/i.test(raw) ? raw : `${raw}/v1`
}

export function resolveMuseRootUrl(baseUrl?: string): string {
  return normalizeMuseBaseUrl(baseUrl).replace(/\/v1$/i, "")
}

export function isProviderUsable(cfg: LLMProviderConfig): boolean {
  if (cfg.enabled === false || !cfg.model?.trim()) return false
  if (cfg.provider === "openai_compatible" || cfg.provider === "muse2api") return true
  return Boolean(cfg.apiKey?.trim())
}

/**
 * Extracts a JSON object cleanly from VLM output that may contain `<think>...</think>`,
 * markdown ```json fences, leading prose, or trailing commas.
 */
export function extractJsonObjectFromText(rawText: string): Record<string, unknown> {
  const stripped = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim()

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try stripping trailing commas before } or ]
      try {
        const cleaned = candidate.replace(/,\s*([}\]])/g, "$1")
        const parsed = JSON.parse(cleaned) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        return null
      }
    }
    return null
  }

  const direct = tryParse(stripped)
  if (direct) return direct

  // Find balanced outermost `{ ... }`
  const firstBrace = stripped.indexOf("{")
  if (firstBrace >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = firstBrace; i < stripped.length; i++) {
      const ch = stripped[i]!
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\" && inString) {
        escaped = true
        continue
      }
      if (ch === "\"") {
        inString = !inString
        continue
      }
      if (!inString) {
        if (ch === "{") depth++
        else if (ch === "}") {
          depth--
          if (depth === 0) {
            const sub = stripped.slice(firstBrace, i + 1)
            const parsed = tryParse(sub)
            if (parsed) return parsed
            break
          }
        }
      }
    }
    const lastBrace = stripped.lastIndexOf("}")
    if (lastBrace > firstBrace) {
      const parsed = tryParse(stripped.slice(firstBrace, lastBrace + 1))
      if (parsed) return parsed
    }

    // Salvage truncated JSON (e.g. a 20-item bill cut off mid-items[] after emitting all scalar fields)
    const tailSlice = stripped.slice(firstBrace)
    const itemsIdx = tailSlice.search(/"items"\s*:\s*\[/)
    if (itemsIdx > 0) {
      // Try closing cleanly after the last complete `{...}` item object inside items[]
      const beforeItems = tailSlice.slice(0, itemsIdx)
      const itemsPart = tailSlice.slice(itemsIdx)
      const lastObjEnd = itemsPart.lastIndexOf("}")
      if (lastObjEnd > 0) {
        const salvagedWithItems = `${beforeItems}${itemsPart.slice(0, lastObjEnd + 1)}]}`
        const p1 = tryParse(salvagedWithItems)
        if (p1) return p1
      }
      // Or close cleanly right before items[] with empty array
      const trimmedBefore = beforeItems.replace(/,\s*$/, "")
      const salvagedHeaderOnly = `${trimmedBefore}, "items": []}`
      const p2 = tryParse(salvagedHeaderOnly)
      if (p2) return p2
    }
  }

  throw new Error("Không trích xuất được JSON hợp lệ từ phản hồi AI.")
}

function resolveOllamaRootUrl(baseUrl?: string): string | null {
  const raw = (baseUrl || "http://127.0.0.1:11434/v1").trim()
  try {
    const u = new URL(raw)
    if (u.port === "11434" || u.hostname === "ollama" || raw.toLowerCase().includes("11434")) {
      return `${u.protocol}//${u.host}`
    }
    return null
  } catch {
    return null
  }
}

export interface DiscoveredOllamaModel {
  name: string
  isVision: boolean
  sizeBytes: number
  family?: string
}

const VISION_MODEL_PATTERN = /(?:qwen3?-?vl|qwen2\.5-?vl|llava|vision|minicpm-v|pixtral|moondream|bakllava|gemma3|internvl|cogvlm)/i

/**
 * Probes local Ollama (`/api/tags`) with a fast 1.5s timeout and returns installed models,
 * sorting Vision-capable models (`qwen3-vl`, `qwen2.5vl`, `llava`, etc.) first.
 */
export async function discoverLocalOllamaModels(
  baseUrl = "http://127.0.0.1:11434"
): Promise<{ reachable: boolean; baseUrl: string; models: DiscoveredOllamaModel[]; bestVisionModel?: string }> {
  const root = baseUrl.replace(/\/v1\/?$/i, "").replace(/\/$/, "")
  const ac = new AbortController()
  const tm = setTimeout(() => ac.abort(), 1500)
  try {
    const res = await fetch(`${root}/api/tags`, { signal: ac.signal })
    if (!res.ok) return { reachable: false, baseUrl: `${root}/v1`, models: [] }
    const data = (await res.json()) as {
      models?: Array<{
        name?: string
        size?: number
        details?: { family?: string; families?: string[] }
      }>
    }
    const models: DiscoveredOllamaModel[] = (data.models ?? [])
      .filter((m) => Boolean(m.name))
      .map((m) => {
        const name = m.name!
        const families = m.details?.families ?? []
        const isVision =
          VISION_MODEL_PATTERN.test(name) ||
          families.some((f) => /clip|vl|vision|mllama/i.test(f))
        return {
          name,
          isVision,
          sizeBytes: Number(m.size ?? 0),
          family: m.details?.family
        }
      })
      .sort((a, b) => {
        if (a.isVision !== b.isVision) return a.isVision ? -1 : 1
        // Prefer official qwen3-vl / qwen2.5vl instruct vision models first
        const aPref = /qwen3-vl/i.test(a.name) ? 3 : /qwen.*vl/i.test(a.name) ? 2 : 1
        const bPref = /qwen3-vl/i.test(b.name) ? 3 : /qwen.*vl/i.test(b.name) ? 2 : 1
        return bPref - aPref
      })

    const bestVisionModel = models.find((m) => m.isVision)?.name
    return { reachable: true, baseUrl: `${root}/v1`, models, bestVisionModel }
  } catch {
    return { reachable: false, baseUrl: `${root}/v1`, models: [] }
  } finally {
    clearTimeout(tm)
  }
}

async function callOllamaNativeVisionJson(params: {
  ollamaRoot: string
  model: string
  prompt: string
  attachments?: LLMAttachment[]
  textContext?: string
}): Promise<{ output: Record<string, unknown>; tokensUsed: number }> {
  const userText = params.textContext ? `${params.prompt}\n\nDOCUMENT TEXT:\n${params.textContext}` : params.prompt
  const images = (params.attachments ?? []).map((att) => att.buffer.toString("base64"))

  const res = await fetch(`${params.ollamaRoot}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 2048,
        repeat_penalty: 1.12
      },
      messages: [
        {
          role: "user",
          content: userText,
          ...(images.length > 0 ? { images } : {})
        }
      ]
    })
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => "")
    throw new Error(`Ollama HTTP ${res.status}: ${errBody.slice(0, 180)}`)
  }
  const data = (await res.json()) as {
    message?: { content?: string }
    prompt_eval_count?: number
    eval_count?: number
  }
  const content = data.message?.content ?? ""
  const parsed = extractJsonObjectFromText(content)
  return {
    output: parsed,
    tokensUsed: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)
  }
}

/**
 * Probes a local or remote Muse2API server (`/healthz`, `/readyz`, `/v1/health/deep`, `/v1/models`)
 * and reports live account pool status, auth status, and multimodal Vision chat capability.
 */
export async function discoverMuse2Api(
  baseUrl?: string,
  apiKey?: string
): Promise<Muse2ApiDiscoveryResult> {
  const candidates = baseUrl?.trim()
    ? [resolveMuseRootUrl(baseUrl)]
    : ["http://127.0.0.1:18611", "http://127.0.0.1:18610"]

  const fetchJsonQuick = async (url: string, headers: Record<string, string> = {}, timeoutMs = 2500) => {
    const ac = new AbortController()
    const tm = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers, signal: ac.signal })
      const text = await res.text()
      let json: Record<string, unknown> | null = null
      try {
        json = JSON.parse(text) as Record<string, unknown>
      } catch {
        json = null
      }
      return { ok: res.ok, status: res.status, json, text }
    } catch {
      return null
    } finally {
      clearTimeout(tm)
    }
  }

  for (const root of candidates) {
    const health = await fetchJsonQuick(`${root}/healthz`)
    if (!health || !health.ok) continue

    const ready = await fetchJsonQuick(`${root}/readyz`)
    const readyJson = ready?.json ?? {}
    const isMockDriver =
      typeof readyJson.driver === "object" &&
      readyJson.driver !== null &&
      (readyJson.driver as Record<string, unknown>).driver === "mock"

    let accountsTotal = 0
    if (typeof readyJson.accounts === "number") {
      accountsTotal = readyJson.accounts
    } else if (typeof readyJson.accounts === "object" && readyJson.accounts !== null) {
      accountsTotal = Number((readyJson.accounts as Record<string, unknown>).total ?? 0)
    }
    const browserRunning = Boolean(readyJson.browser_running)

    const authHeaders: Record<string, string> = apiKey?.trim()
      ? { Authorization: `Bearer ${apiKey.trim()}` }
      : {}

    const modelsRes = await fetchJsonQuick(`${root}/v1/models`, authHeaders)
    const authRequired = modelsRes?.status === 401 && !apiKey?.trim()
    const authValid = Boolean(modelsRes?.ok)
    const rawModels = Array.isArray(modelsRes?.json?.data)
      ? (modelsRes!.json!.data as Array<Record<string, unknown>>)
      : []
    const models = rawModels
      .filter((m) => typeof m.id === "string")
      .map((m) => ({
        id: String(m.id),
        description: typeof m.description === "string" ? m.description : undefined,
        vision: Boolean(m.vision || m.multimodal || m.id === "muse-spark")
      }))

    let validAccounts = accountsTotal
    let visionSupported = models.some((m) => m.vision)
    if (authValid) {
      const deep = await fetchJsonQuick(`${root}/v1/health/deep`, authHeaders, 4000)
      if (deep?.ok && deep.json) {
        if (typeof deep.json.valid_accounts === "number") validAccounts = deep.json.valid_accounts
        if (typeof deep.json.enabled_accounts === "number" && accountsTotal === 0) {
          accountsTotal = deep.json.enabled_accounts
        }
        if (typeof deep.json.vision_chat === "boolean") {
          visionSupported = deep.json.vision_chat
        }
      }
    }

    const recommendedModel =
      models.find((m) => m.id === "muse-spark")?.id ??
      models.find((m) => m.vision)?.id ??
      models[0]?.id ??
      "muse-spark"

    const v1Base = `${root}/v1`
    let message: string
    if (isMockDriver && accountsTotal === 0) {
      message = `Phát hiện Muse2API chế độ mock (0 tài khoản thật) tại ${v1Base}. Khuyên dùng cổng muse2api-local (mặc định :18611).`
    } else if (modelsRes?.status === 401) {
      message = apiKey?.trim()
        ? `Muse2API tại ${v1Base} phản hồi API Key không hợp lệ (401).`
        : `Phát hiện Muse2API tại ${v1Base} (${accountsTotal} tài khoản) — nhập Bearer API Key để kết nối.`
    } else if (validAccounts === 0) {
      message = `Muse2API kết nối được tại ${v1Base} nhưng chưa có tài khoản hợp lệ (0/${accountsTotal}). Kiểm tra Cookie trên trang Admin.`
    } else {
      message = `Muse2API sẵn sàng tại ${v1Base} · ${validAccounts}/${accountsTotal} tài khoản hợp lệ${visionSupported ? " · Hỗ trợ Vision ảnh/PDF" : ""}.`
    }

    return {
      reachable: true,
      baseUrl: v1Base,
      version: typeof health.json?.version === "string" ? health.json.version : undefined,
      accountsTotal,
      validAccounts,
      browserRunning,
      visionSupported,
      authRequired: authRequired || modelsRes?.status === 401,
      authValid,
      models,
      recommendedModel,
      message
    }
  }

  const fallbackBase = normalizeMuseBaseUrl(baseUrl)
  return {
    reachable: false,
    baseUrl: fallbackBase,
    accountsTotal: 0,
    validAccounts: 0,
    browserRunning: false,
    visionSupported: false,
    authRequired: false,
    authValid: false,
    models: [],
    recommendedModel: "muse-spark",
    message: `Không tìm thấy dịch vụ Muse2API tại ${fallbackBase}. Kiểm tra muse2api-local đang chạy.`
  }
}

export async function callMuse2ApiChat(params: {
  baseUrl?: string
  apiKey?: string
  model?: string
  messages: Array<{
    role: "system" | "user" | "assistant"
    content: string
    attachments?: LLMAttachment[]
  }>
  timeoutMs?: number
}): Promise<{ text: string; model: string; tokensUsed: number }> {
  const v1Base = normalizeMuseBaseUrl(params.baseUrl)
  const model = (params.model || "muse-spark").trim()
  const timeoutMs = params.timeoutMs ?? 210_000

  const formattedMessages = params.messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content }
    }
    const parts: Array<Record<string, unknown>> = []
    if (m.content.trim()) {
      parts.push({ type: "text", text: m.content })
    }
    for (const att of m.attachments) {
      const b64 = att.buffer.toString("base64")
      const dataUrl = `data:${att.mediaType};base64,${b64}`
      if (att.mediaType.startsWith("image/")) {
        parts.push({ type: "image_url", image_url: { url: dataUrl } })
      } else {
        parts.push({
          type: "file",
          file: { filename: att.filename, media_type: att.mediaType, file_data: dataUrl }
        })
      }
    }
    return { role: m.role, content: parts }
  })

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (params.apiKey?.trim()) {
    headers.Authorization = `Bearer ${params.apiKey.trim()}`
  }

  const ac = new AbortController()
  const tm = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${v1Base}/chat/completions`, {
      method: "POST",
      headers,
      signal: ac.signal,
      body: JSON.stringify({
        model,
        stream: false,
        timeout: Math.max(60, Math.round((timeoutMs - 15_000) / 1000)),
        messages: formattedMessages
      })
    })
    const rawText = await res.text()
    let data: Record<string, unknown> | null = null
    try {
      data = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      data = null
    }
    if (!res.ok) {
      const errObj = data?.error as Record<string, unknown> | undefined
      const errMsg =
        (typeof errObj?.message === "string" && errObj.message) ||
        (typeof data?.detail === "string" && data.detail) ||
        rawText.slice(0, 220)
      throw new Error(`Muse2API HTTP ${res.status}: ${errMsg}`)
    }
    const choices = Array.isArray(data?.choices) ? (data!.choices as Array<Record<string, unknown>>) : []
    const firstMsg = choices[0]?.message as Record<string, unknown> | undefined
    const content = typeof firstMsg?.content === "string" ? firstMsg.content.trim() : ""
    if (!content) {
      throw new Error("Muse2API trả về phản hồi rỗng.")
    }
    const usage = data?.usage as Record<string, unknown> | undefined
    const tokensUsed = Number(usage?.total_tokens ?? 0) || 0
    return {
      text: content,
      model: typeof data?.model === "string" ? data.model : model,
      tokensUsed
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Muse2API quá thời gian chờ (${Math.round(timeoutMs / 1000)}s).`)
    }
    throw err
  } finally {
    clearTimeout(tm)
  }
}

async function callMuse2ApiVisionJson(params: {
  config: LLMProviderConfig
  prompt: string
  attachments?: LLMAttachment[]
  textContext?: string
}): Promise<{ output: Record<string, unknown>; tokensUsed: number }> {
  const userText = params.textContext
    ? `${params.prompt}\n\nDOCUMENT TEXT:\n${params.textContext}\n\nCHỈ trả về đúng 1 JSON object hợp lệ (không giải thích thêm).`
    : `${params.prompt}\n\nCHỈ trả về đúng 1 JSON object hợp lệ (không giải thích thêm).`

  const first = await callMuse2ApiChat({
    baseUrl: params.config.baseUrl,
    apiKey: params.config.apiKey,
    model: params.config.model || "muse-spark",
    messages: [{ role: "user", content: userText, attachments: params.attachments }],
    timeoutMs: 210_000
  })

  try {
    return {
      output: extractJsonObjectFromText(first.text),
      tokensUsed: first.tokensUsed
    }
  } catch {
    // 1 fast repair turn if Muse wrapped its extraction in natural Vietnamese prose
    const repair = await callMuse2ApiChat({
      baseUrl: params.config.baseUrl,
      apiKey: params.config.apiKey,
      model: params.config.model || "muse-spark",
      messages: [
        {
          role: "user",
          content:
            "Chuyển toàn bộ thông tin hóa đơn sau sang ĐÚNG 1 JSON object duy nhất gồm các trường: documentKind, name, merchant, merchantTaxCode, issuedAt (YYYY-MM-DD), invoiceSymbol, invoiceNumber, currencyCode, preTaxAmount, vatAmount, total, amountInWords, paymentMethod, categoryCode, items ([{name, quantity, unitPrice, amount}]). Không viết thêm bất kỳ chữ nào ngoài JSON:\n\n" +
            first.text.slice(0, 6000)
        }
      ],
      timeoutMs: 90_000
    })
    return {
      output: extractJsonObjectFromText(repair.text),
      tokensUsed: first.tokensUsed + repair.tokensUsed
    }
  }
}

export async function testProviderVisionSupport(config: LLMProviderConfig): Promise<{
  success: boolean
  supportsVision: boolean
  message: string
}> {
  if (!config.model) {
    return { success: false, supportsVision: false, message: "Chưa chọn tên model." }
  }
  if (config.provider !== "openai_compatible" && config.provider !== "muse2api" && !config.apiKey) {
    return { success: false, supportsVision: false, message: "Thiếu API Key." }
  }

  try {
    if (config.provider === "muse2api") {
      const probe = await discoverMuse2Api(config.baseUrl, config.apiKey)
      if (!probe.reachable) {
        return { success: false, supportsVision: false, message: probe.message }
      }
      if (!probe.authValid) {
        return { success: false, supportsVision: false, message: probe.message }
      }
      if (probe.validAccounts === 0) {
        return { success: false, supportsVision: false, message: probe.message }
      }
      const res = await callMuse2ApiChat({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model || probe.recommendedModel,
        messages: [
          {
            role: "user",
            content: "Reply with the single word: ok",
            attachments: [
              {
                filename: "ping.png",
                mediaType: "image/png",
                buffer: Buffer.from(TINY_TEST_PNG_BASE64, "base64")
              }
            ]
          }
        ],
        timeoutMs: 90_000
      })
      return {
        success: true,
        supportsVision: true,
        message: `Kết nối Muse2API Vision thành công (${res.model} · ${probe.validAccounts}/${probe.accountsTotal} tài khoản): "${res.text.slice(0, 60)}"`
      }
    }

    const ollamaRoot = config.provider === "openai_compatible" ? resolveOllamaRootUrl(config.baseUrl) : null
    if (ollamaRoot) {
      const res = await fetch(`${ollamaRoot}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          options: { temperature: 0, num_predict: 16 },
          messages: [{ role: "user", content: "Reply with the single word: ok", images: [TINY_TEST_PNG_BASE64] }]
        })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
      const data = (await res.json()) as { message?: { content?: string } }
      return {
        success: true,
        supportsVision: true,
        message: `Kết nối Ollama Vision thành công (${config.model}): "${(data.message?.content || "ok").trim().slice(0, 60)}"`
      }
    }

    const model = createLanguageModel(config)
    const { text } = await generateText({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with the single word: ok" },
            {
              type: "file",
              data: Buffer.from(TINY_TEST_PNG_BASE64, "base64"),
              mediaType: "image/png"
            }
          ]
        }
      ]
    })

    return {
      success: true,
      supportsVision: true,
      message: `Kết nối Vision thành công: "${text.trim().slice(0, 80)}"`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const lower = msg.toLowerCase()
    const isVisionRejected =
      lower.includes("image") || lower.includes("vision") || lower.includes("content.type")

    return {
      success: false,
      supportsVision: !isVisionRejected,
      message: isVisionRejected
        ? `Model ${config.model} không hỗ trợ đầu vào hình ảnh (Vision).`
        : `Lỗi kết nối: ${msg}`
    }
  }
}

export interface LLMAttachment {
  filename: string
  mediaType: string
  buffer: Buffer
}

function isWeakExtraction(output: Record<string, unknown>): boolean {
  const totalRaw = output.total ?? output.totalAmount ?? output.grandTotal
  const totalNum = typeof totalRaw === "number" ? totalRaw : Number(String(totalRaw ?? "").replace(/[^\d.]/g, ""))
  const hasTotal = Number.isFinite(totalNum) && totalNum > 0
  const hasMerchant = typeof output.merchant === "string" && output.merchant.trim().length > 1
  const hasItems = Array.isArray(output.items) && output.items.length > 0
  return !hasTotal && !hasMerchant && !hasItems
}

/**
 * Resilient JSON document extraction across Muse2API, Ollama native Vision, OpenAI, Gemini, Claude,
 * Mistral, and OpenAI-compatible servers. Automatically falls back on errors OR weak/empty local
 * extraction to the next configured backup provider (e.g. Ollama -> Muse2API).
 */
export async function requestFlexibleJsonWithFallback(
  providers: LLMProviderConfig[],
  params: {
    prompt: string
    schema?: z.ZodType<Record<string, unknown>>
    attachments?: LLMAttachment[]
    textContext?: string
    onRateLimit?: () => void
  }
): Promise<{ output: Record<string, unknown>; provider: LLMProviderType; model: string; tokensUsed: number; backupUsed?: boolean }> {
  let lastError = "Chưa cấu hình nhà cung cấp AI hợp lệ."
  const usable = providers.filter(isProviderUsable)
  let weakCandidate: { output: Record<string, unknown>; provider: LLMProviderType; model: string; tokensUsed: number } | null = null

  for (let i = 0; i < usable.length; i++) {
    const cfg = usable[i]!
    const hasBackupAfter = i < usable.length - 1
    try {
      let res: { output: Record<string, unknown>; tokensUsed: number }

      if (cfg.provider === "muse2api") {
        res = await callMuse2ApiVisionJson({
          config: cfg,
          prompt: params.prompt,
          attachments: params.attachments,
          textContext: params.textContext
        })
      } else if (cfg.provider === "openai_compatible" && resolveOllamaRootUrl(cfg.baseUrl)) {
        // Fast, rock-solid native Ollama /api/chat path (avoids OpenAI-compat schema drop & repeat loops)
        res = await callOllamaNativeVisionJson({
          ollamaRoot: resolveOllamaRootUrl(cfg.baseUrl)!,
          model: cfg.model,
          prompt: params.prompt,
          attachments: params.attachments,
          textContext: params.textContext
        })
      } else {
        const model = createLanguageModel(cfg)
        const content: Array<
          | { type: "text"; text: string }
          | { type: "file"; data: Buffer; mediaType: string }
        > = [{ type: "text", text: params.textContext ? `${params.prompt}\n\nDOCUMENT TEXT:\n${params.textContext}` : params.prompt }]

        for (const att of params.attachments ?? []) {
          content.push({
            type: "file",
            data: att.buffer,
            mediaType: att.mediaType
          })
        }

        let gotStrict: { output: Record<string, unknown>; tokensUsed: number } | null = null
        if (params.schema) {
          try {
            const result = await generateText({
              model,
              temperature: 0,
              output: Output.object({ schema: params.schema }),
              messages: [{ role: "user", content }]
            })
            gotStrict = {
              output: result.output,
              tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
            }
          } catch (strictErr) {
            const sMsg = strictErr instanceof Error ? strictErr.message : String(strictErr)
            if (sMsg.includes("401") || sMsg.includes("403") || sMsg.includes("429") || sMsg.includes("ECONNREFUSED")) {
              throw strictErr
            }
          }
        }

        if (gotStrict) {
          res = gotStrict
        } else {
          const rawRes = await generateText({
            model,
            temperature: 0,
            messages: [{ role: "user", content }]
          })
          res = {
            output: extractJsonObjectFromText(rawRes.text),
            tokensUsed: (rawRes.usage?.inputTokens ?? 0) + (rawRes.usage?.outputTokens ?? 0)
          }
        }
      }

      // If local model returned an empty/broken extraction and we have a backup provider (like Muse2API), escalate!
      if (hasBackupAfter && cfg.provider === "openai_compatible" && isWeakExtraction(res.output)) {
        weakCandidate = {
          output: res.output,
          provider: cfg.provider,
          model: cfg.model,
          tokensUsed: res.tokensUsed
        }
        continue
      }

      return {
        output: res.output,
        provider: cfg.provider,
        model: cfg.model,
        tokensUsed: res.tokensUsed,
        backupUsed: i > 0
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
        params.onRateLimit?.()
      }
      lastError = `[${cfg.provider}/${cfg.model}] ${msg}`
    }
  }

  if (weakCandidate) {
    return weakCandidate
  }

  throw new Error(lastError)
}

export async function requestStructuredWithFallback<T>(
  providers: LLMProviderConfig[],
  params: {
    prompt: string
    schema: z.ZodType<T>
    attachments?: LLMAttachment[]
    textContext?: string
    onRateLimit?: () => void
  }
): Promise<{ output: T; provider: LLMProviderType; model: string; tokensUsed: number }> {
  const res = await requestFlexibleJsonWithFallback(providers, {
    prompt: params.prompt,
    schema: params.schema as unknown as z.ZodType<Record<string, unknown>>,
    attachments: params.attachments,
    textContext: params.textContext,
    onRateLimit: params.onRateLimit
  })
  return {
    output: res.output as unknown as T,
    provider: res.provider,
    model: res.model,
    tokensUsed: res.tokensUsed
  }
}
