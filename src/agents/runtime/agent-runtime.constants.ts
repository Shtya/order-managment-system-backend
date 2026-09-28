import { AgentLanguage } from "entities/agent.entity";

export const AGENT_SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const AGENT_PREVIOUS_SUMMARY_WAIT_MS = 20_000;
export const AGENT_PREVIOUS_RAW_MESSAGES = 10;
export const AGENT_HUMAN_PAUSE_MS = 30 * 60 * 1000;
export const AGENT_PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_UNSUPPORTED_REPLY_COOLDOWN_SECONDS = 5 * 60;

/** Rough token budget of the live context; compaction starts at ~65% of it. */
export const AGENT_CONTEXT_TOKEN_BUDGET = 48_000;
export const AGENT_COMPACTION_RATIO = 0.65;
export const AGENT_KEEP_RECENT_TURNS = 6;
export const AGENT_MEMORY_FACTS_LIMIT = 6;

const AGENT_UNSUPPORTED_MESSAGES = {
  arabic: "معلش، مش قادر أفهم النوع ده من الرسائل. ممكن تكتبلي طلبك أو تبعته بطريقة تانية؟",
  english: "Sorry, I can't read this type of message. Could you type your request or send it another way?",
};

/** Fixed language → that language; automatic → Arabic, since an unsupported item has no detectable language. */
export function unsupportedMessageFor(language: AgentLanguage): string {
  return language === AgentLanguage.ENGLISH
    ? AGENT_UNSUPPORTED_MESSAGES.english
    : AGENT_UNSUPPORTED_MESSAGES.arabic;
}

export const AGENT_CONFIRM_BUTTON_PREFIX = "agent_confirm:";
export const AGENT_EDIT_BUTTON_PREFIX = "agent_edit:";
export const AGENT_CANCEL_BUTTON_PREFIX = "agent_cancel:";

export const AGENT_SEND_TOOL_NAMES = [
  "send_text",
  "send_image",
  "send_buttons",
  "send_list",
  "react_to_message",
  "request_location",
];

/**
 * Everything a customer tool is allowed to act on. Set by the runtime from the server-side
 * session and passed as `session.metadata.agentScope`; never taken from model arguments.
 */
export type AgentToolScope = {
  adminId: string;
  agentId: string;
  sessionId: string;
  turnId: string;
  conversationId: string;
  customerId: string;
  phoneNumber: string;
  accountId: string | null;
  /** When set, send even if the WhatsApp account's default AI agent is off. */
  taskId?: string;
};

export function estimateTokens(text: string | null | undefined): number {
  return Math.ceil(String(text ?? "").length / 3.5);
}
