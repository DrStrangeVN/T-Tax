import { generateText, Output, type LanguageModel } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { z } from "zod"
import type { LLMProviderConfig, LLMProviderType } from "../types.js"
export { LLM_PROVIDER_PRESETS, type ProviderPresetMeta } from "./presets.js"

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

export async function testProviderVisionSupport(config: LLMProviderConfig): Promise<{
  success: boolean
  supportsVision: boolean
  message: string
}> {
  if (!config.model) {
    return { success: false, supportsVision: false, message: "Chưa chọn tên model." }
  }
  if (config.provider !== "openai_compatible" && !config.apiKey) {
    return { success: false, supportsVision: false, message: "Thiếu API Key." }
  }

  try {
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

/**
 * Resilient JSON document extraction across Ollama native Vision, OpenAI, Gemini, Claude, Mistral,
 * and OpenAI-compatible servers. Automatically falls back from strict `Output.object()` to resilient
 * JSON extraction so messy handwritten numbers/strings never crash extraction.
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
): Promise<{ output: Record<string, unknown>; provider: LLMProviderType; model: string; tokensUsed: number }> {
  let lastError = "Chưa cấu hình nhà cung cấp AI hợp lệ."

  for (const cfg of providers) {
    if (cfg.enabled === false || !cfg.model) continue
    if (cfg.provider !== "openai_compatible" && !cfg.apiKey) continue

    try {
      // Fast, rock-solid native Ollama /api/chat path (avoids OpenAI-compat schema drop & repeat loops)
      if (cfg.provider === "openai_compatible") {
        const ollamaRoot = resolveOllamaRootUrl(cfg.baseUrl)
        if (ollamaRoot) {
          const nativeRes = await callOllamaNativeVisionJson({
            ollamaRoot,
            model: cfg.model,
            prompt: params.prompt,
            attachments: params.attachments,
            textContext: params.textContext
          })
          return {
            output: nativeRes.output,
            provider: cfg.provider,
            model: cfg.model,
            tokensUsed: nativeRes.tokensUsed
          }
        }
      }

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

      if (params.schema) {
        try {
          const result = await generateText({
            model,
            temperature: 0,
            output: Output.object({ schema: params.schema }),
            messages: [{ role: "user", content }]
          })
          return {
            output: result.output,
            provider: cfg.provider,
            model: cfg.model,
            tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
          }
        } catch (strictErr) {
          // If the provider failed ONLY on strict schema parsing (not 401/429/network), retry with raw JSON text
          const sMsg = strictErr instanceof Error ? strictErr.message : String(strictErr)
          if (sMsg.includes("401") || sMsg.includes("403") || sMsg.includes("429") || sMsg.includes("ECONNREFUSED")) {
            throw strictErr
          }
        }
      }

      const rawRes = await generateText({
        model,
        temperature: 0,
        messages: [{ role: "user", content }]
      })
      const parsed = extractJsonObjectFromText(rawRes.text)
      return {
        output: parsed,
        provider: cfg.provider,
        model: cfg.model,
        tokensUsed: (rawRes.usage?.inputTokens ?? 0) + (rawRes.usage?.outputTokens ?? 0)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
        params.onRateLimit?.()
      }
      lastError = `[${cfg.provider}/${cfg.model}] ${msg}`
    }
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
