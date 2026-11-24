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
        apiKey: config.apiKey || "not-needed"
      })
      return compat.chatModel(config.model)
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
  if (config.provider !== "openai_compatible" && !config.apiKey) {
    return { success: false, supportsVision: false, message: "Thiếu API Key." }
  }

  try {
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
              type: "image",
              image: Buffer.from(TINY_TEST_PNG_BASE64, "base64"),
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
  let lastError = "Chưa cấu hình nhà cung cấp AI hợp lệ."

  for (const cfg of providers) {
    if (cfg.enabled === false || !cfg.model) continue
    if (cfg.provider !== "openai_compatible" && !cfg.apiKey) continue

    try {
      const model = createLanguageModel(cfg)
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; image: Buffer; mediaType: string }
      > = [{ type: "text", text: params.textContext ? `${params.prompt}\n\nDOCUMENT TEXT:\n${params.textContext}` : params.prompt }]

      for (const att of params.attachments ?? []) {
        content.push({
          type: "image",
          image: att.buffer,
          mediaType: att.mediaType
        })
      }

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
