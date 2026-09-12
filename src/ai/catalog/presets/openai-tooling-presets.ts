import { ToolingPresets } from "./types";

/**
 * Paste exact OpenAI model ids you have tested.
 * Keep logic out of this file — list edits only.
 *
 * Proven by probe_openai_real_tool_calls.py (actual function tool_calls).
 */
export const openaiToolingPresets: ToolingPresets = {
  supported: [
    "chat-latest",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-4-0613",
    "gpt-4-turbo-2024-04-09",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano-2025-04-14",
    "gpt-5-2025-08-07",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano-2025-08-07",
    "gpt-5.1-2025-11-13",
    "gpt-5.2-2025-12-11",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4-nano-2026-03-17",
    "gpt-5.5-2026-04-23",
    "o1-2024-12-17",
    "o3-2025-04-16",
    "o3-mini-2025-01-31",
    "o4-mini-2025-04-16",
  ],
  unsupported: [
    "gpt-3.5-turbo-instruct-0914",
    "gpt-4o-mini-search-preview",
    "gpt-4o-mini-search-preview-2025-03-11",
    "gpt-4o-search-preview",
    "gpt-4o-search-preview-2025-03-11",
    "gpt-5-chat-latest",
    "gpt-5-codex",
    "gpt-5-pro-2025-10-06",
    "gpt-5-search-api",
    "gpt-5-search-api-2025-10-14",
    "gpt-5.1-chat-latest",
    "gpt-5.2-chat-latest",
    "gpt-5.2-pro-2025-12-11",
    "gpt-5.3-chat-latest",
    "gpt-5.4-pro-2026-03-05",
    "gpt-5.5-pro-2026-04-23",
    "gpt-live-1",
    "gpt-6-astra",
    "o1-pro-2025-03-19",
  ],
};
