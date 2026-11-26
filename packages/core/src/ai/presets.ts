import type { LLMProviderConfig, LLMProviderType } from "../types.js"

export interface ProviderPresetMeta {
  provider: LLMProviderType
  label: string
  defaultModel: string
  defaultBaseUrl?: string
  defaultConcurrency?: number
  requiresApiKey: boolean
  docsUrl: string
  hint?: string
}

export const LLM_PROVIDER_PRESETS: ProviderPresetMeta[] = [
  {
    provider: "google",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    defaultConcurrency: 3,
    requiresApiKey: true,
    docsUrl: "https://aistudio.google.com/apikey"
  },
  {
    provider: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    defaultConcurrency: 3,
    requiresApiKey: true,
    docsUrl: "https://platform.openai.com/api-keys"
  },
  {
    provider: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-3-5-haiku-latest",
    defaultConcurrency: 2,
    requiresApiKey: true,
    docsUrl: "https://console.anthropic.com/"
  },
  {
    provider: "mistral",
    label: "Mistral AI",
    defaultModel: "mistral-medium-latest",
    defaultConcurrency: 2,
    requiresApiKey: true,
    docsUrl: "https://admin.mistral.ai/organization/api-keys"
  },
  {
    provider: "muse2api",
    label: "Muse2API (Vision đa tài khoản · Backup & Tra cứu AI)",
    defaultModel: "muse-spark",
    defaultBaseUrl: "http://127.0.0.1:18611/v1",
    defaultConcurrency: 4,
    requiresApiKey: false,
    docsUrl: "http://127.0.0.1:18611/admin",
    hint: "Tải trực tiếp ảnh/PDF hóa đơn lên Muse Spark đa tài khoản, tra cứu thuế & làm dự phòng khi Ollama cục bộ quá tải."
  },
  {
    provider: "openai_compatible",
    label: "Local / Custom OpenAI-Compatible (Ollama, LM Studio, vLLM, OpenRouter)",
    defaultModel: "qwen3-vl:8b-instruct",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultConcurrency: 1,
    requiresApiKey: false,
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md"
  }
]

/**
 * Ensures saved provider lists always include newly introduced presets (like `muse2api`)
 * while preserving the user's saved priority order, keys, and enabled flags.
 */
export function mergeMissingProviderPresets(saved: LLMProviderConfig[]): LLMProviderConfig[] {
  if (!saved || saved.length === 0) {
    return LLM_PROVIDER_PRESETS.map((pr) => ({
      provider: pr.provider,
      apiKey: "",
      model: pr.defaultModel,
      baseUrl: pr.defaultBaseUrl,
      enabled: pr.provider === "google",
      maxConcurrency: pr.defaultConcurrency ?? 2
    }))
  }
  const seen = new Set(saved.map((p) => p.provider))
  const merged = [...saved]
  for (const pr of LLM_PROVIDER_PRESETS) {
    if (!seen.has(pr.provider)) {
      merged.push({
        provider: pr.provider,
        apiKey: "",
        model: pr.defaultModel,
        baseUrl: pr.defaultBaseUrl,
        enabled: false,
        maxConcurrency: pr.defaultConcurrency ?? 2
      })
    }
  }
  return merged
}
