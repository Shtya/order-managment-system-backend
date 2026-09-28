import { AgentCapability, AgentLanguage } from "entities/agent.entity";
import { AGENT_END_TURN_TOOL } from "src/ai/orchestrator/ai-loop-policy";

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

/** User-toggleable capabilities (address correction is automatic, never stored). */
export const AGENT_USER_CAPABILITIES = Object.values(AgentCapability);

/** Tools the model always sees, regardless of capabilities. Never gated. */
export const AGENT_ALWAYS_ON_TOOL_NAMES = [
  "send_text",
  "send_image",
  "send_buttons",
  "send_list",
  AGENT_END_TURN_TOOL,
];

/**
 * Capability → tools it unlocks, including the non-obvious helpers each flow
 * needs (catalog/address lookups, confirmation). A tool is exposed when ANY
 * enabled capability needs it; shared helpers are never toggles themselves.
 */
export const AGENT_CAPABILITY_TOOL_NAMES: Record<AgentCapability, string[]> = {
  [AgentCapability.CREATE_ORDERS]: [
    "request_order",
    "search_products",
    "get_product_details",
    "get_bundle_details",
    "list_categories",
    "get_my_addresses",
    "get_cities",
    "get_areas_by_city",
    "confirm_pending_action",
    "cancel_pending_action",
  ],
  [AgentCapability.CAMPAIGN_ORDERS]: [
    "request_campaign_order",
    "get_my_campaign_offers",
    "get_my_addresses",
    "get_cities",
    "get_areas_by_city",
    "confirm_pending_action",
    "cancel_pending_action",
  ],
  [AgentCapability.ORDER_LOOKUP]: ["get_my_orders", "get_order_details"],
  [AgentCapability.LOCATION]: ["request_location"],
  [AgentCapability.REACTIONS]: ["react_to_message"],
  [AgentCapability.TEMPLATES]: ["send_whatsapp_template", "list_whatsapp_templates"],
};

/**
 * Added automatically — never user-controlled — only while an open address
 * task exists for the conversation (see ActionAiAddressCorrectionHandler).
 * Includes the full closure the flow needs, since the user may have disabled
 * everything that would otherwise provide it (incl. confirm machinery).
 */
export const AGENT_ADDRESS_TASK_TOOL_NAMES = [
  "request_address_update",
  "close_address_task",
  "check_shipping_coverage",
  "get_shipping_zones",
  "get_shipping_districts",
  "get_my_addresses",
  "get_cities",
  "get_areas_by_city",
  "confirm_pending_action",
  "cancel_pending_action",
];

export const AGENT_CAPABILITY_LABELS: Record<AgentCapability, string> = {
  [AgentCapability.CREATE_ORDERS]: "Create orders",
  [AgentCapability.CAMPAIGN_ORDERS]: "Campaign orders",
  [AgentCapability.ORDER_LOOKUP]: "Order lookup",
  [AgentCapability.LOCATION]: "Location requests",
  [AgentCapability.REACTIONS]: "Reactions",
  [AgentCapability.TEMPLATES]: "Template messages",
};

/** Null/empty capabilities = all (pre-capability agents keep full behavior). */
export function resolveAgentCapabilities(
  capabilities: Array<string | AgentCapability> | null | undefined,
): AgentCapability[] {
  if (!capabilities?.length) return [...AGENT_USER_CAPABILITIES];
  const valid = new Set<string>(AGENT_USER_CAPABILITIES);
  return [...new Set(capabilities.filter((c) => valid.has(c as string)) as AgentCapability[])];
}

/** Union of always-on tools, enabled capabilities, and (if set) the address-task tools. */
export function resolveAgentToolNames(
  capabilities: Array<string | AgentCapability> | null | undefined,
  addressTaskOpen: boolean,
): string[] {
  const enabled = resolveAgentCapabilities(capabilities);
  const names = new Set<string>(AGENT_ALWAYS_ON_TOOL_NAMES);
  for (const capability of enabled) {
    for (const tool of AGENT_CAPABILITY_TOOL_NAMES[capability] ?? []) names.add(tool);
  }
  if (addressTaskOpen) {
    for (const tool of AGENT_ADDRESS_TASK_TOOL_NAMES) names.add(tool);
  }
  return [...names];
}

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
