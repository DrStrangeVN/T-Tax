import type { LLMProviderType } from "../types.js"

export interface ProviderPresetMeta {
  provider: LLMProviderType
  label: string
  defaultModel: string
  defaultBaseUrl?: string
  requiresApiKey: boolean
  docsUrl: string
}

export const LLM_PROVIDER_PRESETS: ProviderPresetMeta[] = [
  {
    provider: "google",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    requiresApiKey: true,
    docsUrl: "https://aistudio.google.com/apikey"
  },
  {
    provider: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
    docsUrl: "https://platform.openai.com/api-keys"
  },
  {
    provider: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-3-5-haiku-latest",
    requiresApiKey: true,
    docsUrl: "https://console.anthropic.com/"
  },
  {
    provider: "mistral",
    label: "Mistral AI",
    defaultModel: "mistral-medium-latest",
    requiresApiKey: true,
    docsUrl: "https://admin.mistral.ai/organization/api-keys"
  },
  {
    provider: "openai_compatible",
    label: "Local / Custom OpenAI-Compatible (Ollama, LM Studio, vLLM, OpenRouter)",
    defaultModel: "qwen3-vl:8b-instruct",
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md"
  }
]
