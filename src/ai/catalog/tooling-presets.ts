import { anthropicToolingPresets } from "./presets/anthropic-tooling-presets";
import { deepseekToolingPresets } from "./presets/deepseek-tooling-presets";
import { googleToolingPresets } from "./presets/google-tooling-presets";
import { llm7ToolingPresets } from "./presets/llm7-tooling-presets";
import { openaiCompatibleToolingPresets } from "./presets/openai-compatible-tooling-presets";
import { openaiToolingPresets } from "./presets/openai-tooling-presets";
import { pollinationsToolingPresets } from "./presets/pollinations-tooling-presets";
import { EMPTY_TOOLING_PRESETS, ToolingPresets } from "./presets/types";

const PRESETS_BY_CODE: Record<string, ToolingPresets> = {
  openai: openaiToolingPresets,
  anthropic: anthropicToolingPresets,
  google: googleToolingPresets,
  deepseek: deepseekToolingPresets,
  llm7: llm7ToolingPresets,
  pollinations: pollinationsToolingPresets,
  openai_compatible: openaiCompatibleToolingPresets,
};

function presetsFor(providerCode?: string | null): ToolingPresets {
  if (!providerCode) return EMPTY_TOOLING_PRESETS;
  return PRESETS_BY_CODE[providerCode.toLowerCase()] ?? EMPTY_TOOLING_PRESETS;
}

function hasExactId(list: readonly string[], modelCode: string): boolean {
  return list.includes(modelCode);
}

/**
 * Preset tools truth. Overlap → unsupported.
 * Unknown when the id is in neither list.
 */
export function resolveToolsCallingFromPresets(
  providerCode: string | null | undefined,
  modelCode: string,
): boolean | null {
  if (!modelCode) return null;
  const presets = presetsFor(providerCode);
  if (hasExactId(presets.unsupported, modelCode)) return false;
  if (hasExactId(presets.supported, modelCode)) return true;
  return null;
}

/**
 * Sync merge:
 * - never clear false
 * - preset unsupported wins over true
 * - preset supported only fills null
 */
export function mergeToolsCallingOnSync(
  current: boolean | null | undefined,
  fromPreset: boolean | null,
): boolean | null {
  if (fromPreset === false) return false;
  if (fromPreset === true) return true;
  if (current === false) return false;
  if (current === true) return true;
  return null;
}
