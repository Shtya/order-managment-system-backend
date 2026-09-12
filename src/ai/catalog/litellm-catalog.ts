const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type LiteLlmRow = {
  mode?: unknown;
  supported_modalities?: unknown;
  supported_output_modalities?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
};

let cachedAt = 0;
let cachedRows: Record<string, LiteLlmRow> | null = null;
let inflight: Promise<Record<string, LiteLlmRow>> | null = null;

async function loadCatalog(): Promise<Record<string, LiteLlmRow>> {
  const now = Date.now();
  if (cachedRows && now - cachedAt < CACHE_TTL_MS) {
    return cachedRows;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const response = await fetch(LITELLM_PRICES_URL);
    if (!response.ok) {
      throw new Error(`LiteLLM catalog HTTP ${response.status}`);
    }
    const json = (await response.json()) as Record<string, LiteLlmRow>;
    cachedRows = json && typeof json === "object" ? json : {};
    cachedAt = Date.now();
    return cachedRows;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export type LiteLlmCatalogFields = {
  metadata: Record<string, unknown>;
  contextWindow: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
};

/** Exact model id only. No prefix guessing. */
export async function lookupLiteLlmFields(
  modelCode: string,
): Promise<LiteLlmCatalogFields | null> {
  if (!modelCode) return null;
  try {
    const catalog = await loadCatalog();
    const row = catalog[modelCode];
    if (!row || typeof row !== "object") return null;

    const maxInputTokens = toFiniteNumber(row.max_input_tokens);
    const maxOutputTokens = toFiniteNumber(row.max_output_tokens);
    const metadata: Record<string, unknown> = {};
    if (row.mode != null) metadata.mode = row.mode;
    if (row.supported_modalities != null) {
      metadata.supported_modalities = row.supported_modalities;
    }
    if (row.supported_output_modalities != null) {
      metadata.supported_output_modalities = row.supported_output_modalities;
    }

    return {
      metadata,
      contextWindow: {
        ...(maxInputTokens != null ? { maxInputTokens } : {}),
        ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function mergeModelMetadata(
  existing: Record<string, unknown> | null | undefined,
  litellm: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...(existing || {}), ...(litellm || {}) };
  return Object.keys(merged).length ? merged : undefined;
}
