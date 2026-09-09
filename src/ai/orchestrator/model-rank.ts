import { AiModelTier, AiModelType } from "../../../entities/ai.entity";

export type RankableModel = {
  id?: string;
  name?: string;
  modelCode: string;
  isActive?: boolean;
  isAvailable?: boolean;
  modelType?: AiModelType | string | null;
  toolsCalling?: boolean | null;
  tier?: AiModelTier | string | null;
  contextWindow?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
  } | null;
  jsonMode?: boolean | null;
  reasoning?: boolean | null;
  stream?: boolean | null;
};

export type PickBestModelOptions = {
  requireTools?: boolean;
};

export type BestModelSummary = {
  id?: string;
  modelCode: string;
  name?: string;
  toolsCalling?: boolean | null;
  tier?: string | null;
};

function toolsScore(model: RankableModel): number {
  if (model.toolsCalling === true) return 2;
  if (model.toolsCalling === false) return 0;
  return 1;
}

function tierScore(model: RankableModel): number {
  const tier = String(model.tier || "").toLowerCase();
  if (tier === AiModelTier.PRO) return 2;
  if (tier === AiModelTier.FREE) return 0;
  return 1;
}

function tokenScore(value?: number): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function flagScore(value?: boolean | null): number {
  return value === true ? 1 : 0;
}

function modelLabel(model: RankableModel): string {
  return String(model.name || model.modelCode || "").toLowerCase();
}

/** Numeric segments from ids like glm-5.3, gpt-4.1, gemini-3.1-pro-preview. */
export function parseModelVersion(label: string): number[] {
  const parts: number[] = [];
  const re = /(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(label.toLowerCase()))) {
    parts.push(Number(match[1]));
  }
  return parts;
}

function compareVersionParts(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

/**
 * Higher is better. Full releases outrank preview/turbo/flash/air/mini/nano
 * of the same version (e.g. glm-5.3 > glm-5.3-flash).
 */
function variantScore(label: string): number {
  if (/\b(nano)\b/.test(label)) return 0;
  if (/\b(mini)\b/.test(label)) return 1;
  if (/\b(lite|air)\b/.test(label)) return 2;
  if (/\b(flash)\b/.test(label)) return 3;
  if (/\b(turbo)\b/.test(label)) return 4;
  if (/\b(preview|exp|experimental)\b/.test(label)) return 5;
  return 6;
}

/**
 * Chat Completions rejects function tools on several reasoning SKUs unless
 * reasoning_effort is none / Responses API is used (e.g. gpt-6-astra, o3).
 */
export function isChatCompletionsReasoningModel(label: string): boolean {
  const id = label.toLowerCase();
  if (id.includes("astra")) return true;
  if (/(^|-)o[1-4]($|-)/.test(id)) return true;
  return false;
}

export function isModelEligible(
  model: RankableModel | null | undefined,
  options: PickBestModelOptions = {},
): boolean {
  if (!model?.modelCode) return false;
  if (model.isActive === false) return false;
  if (model.isAvailable === false) return false;
  if (model.modelType && model.modelType !== AiModelType.TEXT) return false;
  if (options.requireTools && model.toolsCalling === false) return false;
  if (
    options.requireTools &&
    model.toolsCalling !== true &&
    isChatCompletionsReasoningModel(modelLabel(model))
  ) {
    return false;
  }
  return true;
}

/** Negative if `a` is better than `b`. */
export function compareRankableModels(a: RankableModel, b: RankableModel): number {
  const tools = toolsScore(b) - toolsScore(a);
  if (tools) return tools;

  const tier = tierScore(b) - tierScore(a);
  if (tier) return tier;

  const input =
    tokenScore(b.contextWindow?.maxInputTokens) -
    tokenScore(a.contextWindow?.maxInputTokens);
  if (input) return input;

  const output =
    tokenScore(b.contextWindow?.maxOutputTokens) -
    tokenScore(a.contextWindow?.maxOutputTokens);
  if (output) return output;

  const aLabel = modelLabel(a);
  const bLabel = modelLabel(b);

  const version = compareVersionParts(
    parseModelVersion(aLabel),
    parseModelVersion(bLabel),
  );
  if (version) return version;

  const variant = variantScore(bLabel) - variantScore(aLabel);
  if (variant) return variant;

  const json = flagScore(b.jsonMode) - flagScore(a.jsonMode);
  if (json) return json;

  const reasoning = flagScore(b.reasoning) - flagScore(a.reasoning);
  if (reasoning) return reasoning;

  const stream = flagScore(b.stream) - flagScore(a.stream);
  if (stream) return stream;

  return aLabel.localeCompare(bLabel);
}

export function pickBestModel<T extends RankableModel>(
  models: T[] | null | undefined,
  options: PickBestModelOptions = {},
): T | null {
  const eligible = (models ?? []).filter((model) =>
    isModelEligible(model, options),
  );
  if (!eligible.length) return null;
  return [...eligible].sort(compareRankableModels)[0];
}

export function toBestModelSummary(
  model: RankableModel | null | undefined,
): BestModelSummary | null {
  if (!model) return null;
  return {
    id: model.id,
    modelCode: model.modelCode,
    name: model.name,
    toolsCalling: model.toolsCalling ?? null,
    tier: model.tier ?? null,
  };
}
