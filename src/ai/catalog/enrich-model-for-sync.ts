import { lookupLiteLlmFields, mergeModelMetadata } from "./litellm-catalog";
import { displayNameFromModelId } from "./model-display-name";
import {
  mergeToolsCallingOnSync,
  resolveToolsCallingFromPresets,
} from "./tooling-presets";
import { AiProviderModelInfo } from "../providers/ai-provider.abstract";

export async function enrichRemoteModelForSync(
  remote: AiProviderModelInfo,
  providerCode: string | null | undefined,
  existing?: {
    name?: string;
    metadata?: Record<string, any> | null;
    contextWindow?: {
      maxInputTokens?: number;
      maxOutputTokens?: number;
    } | null;
    toolsCalling?: boolean | null;
  },
): Promise<{
  name: string;
  metadata?: Record<string, any>;
  contextWindow?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
  toolsCalling: boolean | null;
}> {
  const litellm = await lookupLiteLlmFields(remote.modelCode);
  const name = displayNameFromModelId(remote.modelCode) || remote.name;
  const metadata = mergeModelMetadata(
    { ...(existing?.metadata || {}), ...(remote.metadata || {}) },
    litellm?.metadata,
  );
  const contextWindow = {
    ...(existing?.contextWindow || {}),
    ...(remote.contextWindow || {}),
    ...(litellm?.contextWindow || {}),
  };
  const fromPreset = resolveToolsCallingFromPresets(
    providerCode,
    remote.modelCode,
  );
  const toolsCalling = mergeToolsCallingOnSync(
    existing?.toolsCalling ?? remote.toolsCalling ?? null,
    fromPreset,
  );

  return {
    name,
    metadata,
    contextWindow: Object.keys(contextWindow).length
      ? contextWindow
      : undefined,
    toolsCalling,
  };
}
