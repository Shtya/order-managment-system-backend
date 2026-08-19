export const AI_MODULE_TOKEN = "AI_MODULE";

export const AI_CONFIG_TOKEN = "AI_CONFIG_TOKEN";
export const AI_PROVIDER_TOKEN = "AI_PROVIDER";
export const AI_TOOL_NAMESPACE_TOKEN = "AI_TOOL_NAMESPACE";

// New: inject all providers via multi-token (instead of AI_PROVIDER_TOKEN factory array)
export const AI_ALL_PROVIDERS = "AI_ALL_PROVIDERS";

export const AI_MODULE_ENABLED_ENV = "AI_MODULE_ENABLED";

export const AI_PERMISSION_CHAT = "ai.chat";
export const AI_PERMISSION_TOOLS_ORDERS_READ = "ai.tools.orders.read";
export const AI_PERMISSION_TOOLS_ORDERS_WRITE = "ai.tools.orders.write";
export const AI_PERMISSION_TOOLS_SHIPPING_READ = "ai.tools.shipping.read";
export const AI_PERMISSION_TOOLS_SHIPPING_WRITE = "ai.tools.shipping.write";
export const AI_PERMISSION_TOOLS_WHATSAPP_READ = "ai.tools.whatsapp.read";
export const AI_PERMISSION_TOOLS_WHATSAPP_WRITE = "ai.tools.whatsapp.write";

export const AI_DEFAULT_PROVIDER = "llm7";
export const AI_PROVIDERS = ["llm7", "pollinations"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const AI_USE_DEPRECATED_EXTRA_FEATURE_FLAG = false;

export const PROVIDER_REQUEST_TIMEOUT_MS = 90_000;
export const PROVIDER_FUNCTION_CALLING_TIMEOUT_MS = 30_000;
export const PROVIDER_RETRY_BASE_DELAY_MS = 750;
export const PROVIDER_RETRY_MAX_DELAY_MS = 6_000;

export const ERROR_RETRYABLE_HTTP_CODES = [408, 409, 429, 500, 502, 503, 504];

// Defaults applied when not set per-integration
export const AI_PROVIDER_DEFAULTS = {
  MAX_TOKENS: 4096,
  TEMPERATURE: 0.4,
  SYSTEM_ROLE_NAME: "system" as const,
  PRIORITY: 100,
  RETRIES: 2,
} as const;
