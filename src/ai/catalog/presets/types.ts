export type ToolingPresets = {
  supported: readonly string[];
  unsupported: readonly string[];
};

export const EMPTY_TOOLING_PRESETS: ToolingPresets = {
  supported: [],
  unsupported: [],
};
