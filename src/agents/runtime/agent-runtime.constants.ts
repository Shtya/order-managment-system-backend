import { AgentCapability, AgentLanguage } from "entities/agent.entity";
import { ConversationAiMode } from "entities/whatsapp.entity";
import { AGENT_END_TURN_TOOL } from "src/ai/orchestrator/ai-loop-policy";

export const AGENT_SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const AGENT_PREVIOUS_SUMMARY_WAIT_MS = 5_000;
export const AGENT_PROMPT_TIMEZONE = "Africa/Cairo";
export const AGENT_FRESH_READ_TURNS = 3;
/**
 * After shipping a new agent prompt, end leftover ACTIVE sessions so the model
 * does not copy old-style replies from live history:
 * UPDATE agent_sessions SET status = 'ended', "endedAt" = NOW() WHERE status = 'active';
 */
export const AGENT_PREVIOUS_RAW_MESSAGES = 10;
export const AGENT_GAP_MESSAGES = 15;
export const AGENT_HUMAN_PAUSE_MS = 30 * 60 * 1000;
export const AGENT_PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_UNSUPPORTED_REPLY_COOLDOWN_SECONDS = 5 * 60;

const AGENT_MESSAGE_ORIGIN_RELATIONS = {
  sentByUser: true,
  order: true,
  campaign: true,
  automationRun: { version: { automationFlow: true } },
};

/** Relations needed so describeMessage can show automation/campaign/order origin. */
export const AGENT_DESCRIBE_MESSAGE_RELATIONS = {
  ...AGENT_MESSAGE_ORIGIN_RELATIONS,
  replyTo: AGENT_MESSAGE_ORIGIN_RELATIONS,
  reactionTo: AGENT_MESSAGE_ORIGIN_RELATIONS,
};

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

export enum AgentToolName {
  SEND_TEXT = "send_text",
  SEND_IMAGE = "send_image",
  SEND_BUTTONS = "send_buttons",
  SEND_LIST = "send_list",
  REACT_TO_MESSAGE = "react_to_message",
  REQUEST_LOCATION = "request_location",
  SEND_WHATSAPP_TEMPLATE = "send_whatsapp_template",
  LIST_WHATSAPP_TEMPLATES = "list_whatsapp_templates",
  END_TURN = "end_turn",
  SEARCH_PRODUCTS = "search_products",
  GET_PRODUCT_DETAILS = "get_product_details",
  SEARCH_BUNDLES = "search_bundles",
  GET_BUNDLE_DETAILS = "get_bundle_details",
  LIST_CATEGORIES = "list_categories",
  REQUEST_ORDER = "request_order",
  REQUEST_CAMPAIGN_ORDER = "request_campaign_order",
  GET_MY_CAMPAIGN_OFFERS = "get_my_campaign_offers",
  GET_MY_ORDERS = "get_my_orders",
  GET_ORDER_DETAILS = "get_order_details",
  REQUEST_ADD_ORDER_ITEMS = "request_add_order_items",
  REQUEST_REPLACE_ORDER_ITEMS = "request_replace_order_items",
  REQUEST_UPDATE_ORDER_ITEMS = "request_update_order_items",
  REQUEST_UPDATE_ORDER_INFO = "request_update_order_info",
  REQUEST_CANCEL_ORDER = "request_cancel_order",
  REQUEST_POSTPONE_ORDER = "request_postpone_order",
  REQUEST_CONFIRM_ORDER = "request_confirm_order",
  REQUEST_ADD_CUSTOMER_ADDRESS = "request_add_customer_address",
  REQUEST_UPDATE_CUSTOMER_ADDRESS = "request_update_customer_address",
  REQUEST_REMOVE_CUSTOMER_ADDRESS = "request_remove_customer_address",
  REQUEST_SET_DEFAULT_ADDRESS = "request_set_default_address",
  GET_MY_ADDRESSES = "get_my_addresses",
  GET_CITIES = "get_cities",
  GET_AREAS_BY_CITY = "get_areas_by_city",
  REQUEST_UPDATE_CUSTOMER = "request_update_customer",
  REQUEST_ADDRESS_UPDATE = "request_address_update",
  CLOSE_ADDRESS_TASK = "close_address_task",
  CHECK_SHIPPING_COVERAGE = "check_shipping_coverage",
  GET_SHIPPING_ZONES = "get_shipping_zones",
  GET_SHIPPING_DISTRICTS = "get_shipping_districts",
  CONFIRM_PENDING_ACTION = "confirm_pending_action",
  CANCEL_PENDING_ACTION = "cancel_pending_action",
  LIST_ISSUE_CAUSES = "list_issue_causes",
  HUMAN_HANDOFF = "human_handoff",
  RESUME_AUTOMATION_CHOICE = "resume_automation_choice",
}

export const AGENT_SEND_TOOL_NAMES = [
  AgentToolName.SEND_TEXT,
  AgentToolName.SEND_IMAGE,
  AgentToolName.SEND_BUTTONS,
  AgentToolName.SEND_LIST,
  AgentToolName.REACT_TO_MESSAGE,
  AgentToolName.REQUEST_LOCATION,
];

/** User-toggleable capabilities (address correction is automatic, never stored). */
export const AGENT_USER_CAPABILITIES = Object.values(AgentCapability);

/** Tools the model always sees, regardless of capabilities. Never gated. */
export const AGENT_ALWAYS_ON_TOOL_NAMES = [
  AgentToolName.SEND_TEXT,
  AgentToolName.SEND_IMAGE,
  AgentToolName.SEND_BUTTONS,
  AgentToolName.SEND_LIST,
  AGENT_END_TURN_TOOL,
];

const CONFIRM_TOOLS = [
  AgentToolName.CONFIRM_PENDING_ACTION,
  AgentToolName.CANCEL_PENDING_ACTION,
];

/**
 * Capability → tools it unlocks. A tool is exposed when ANY enabled capability lists it.
 */
export const AGENT_CAPABILITY_TOOL_NAMES: Record<AgentCapability, AgentToolName[]> = {
  [AgentCapability.SEARCH_PRODUCTS]: [AgentToolName.SEARCH_PRODUCTS],
  [AgentCapability.GET_PRODUCT_DETAILS]: [AgentToolName.GET_PRODUCT_DETAILS],
  [AgentCapability.SEARCH_BUNDLES]: [AgentToolName.SEARCH_BUNDLES],
  [AgentCapability.GET_BUNDLE_DETAILS]: [AgentToolName.GET_BUNDLE_DETAILS],
  [AgentCapability.LIST_CATEGORIES]: [AgentToolName.LIST_CATEGORIES],
  [AgentCapability.CREATE_ORDER]: [AgentToolName.REQUEST_ORDER, ...CONFIRM_TOOLS],
  [AgentCapability.CAMPAIGN_ORDERS]: [
    AgentToolName.REQUEST_CAMPAIGN_ORDER,
    AgentToolName.GET_MY_CAMPAIGN_OFFERS,
    ...CONFIRM_TOOLS,
  ],
  [AgentCapability.GET_MY_ORDERS]: [AgentToolName.GET_MY_ORDERS],
  [AgentCapability.GET_ORDER_DETAILS]: [AgentToolName.GET_ORDER_DETAILS],
  [AgentCapability.ADD_ORDER_ITEMS]: [AgentToolName.REQUEST_ADD_ORDER_ITEMS, ...CONFIRM_TOOLS],
  [AgentCapability.REPLACE_ORDER_ITEMS]: [
    AgentToolName.REQUEST_REPLACE_ORDER_ITEMS,
    ...CONFIRM_TOOLS,
  ],
  [AgentCapability.UPDATE_ORDER_ITEMS]: [AgentToolName.REQUEST_UPDATE_ORDER_ITEMS, ...CONFIRM_TOOLS],
  [AgentCapability.UPDATE_ORDER_INFO]: [AgentToolName.REQUEST_UPDATE_ORDER_INFO, ...CONFIRM_TOOLS],
  [AgentCapability.CANCEL_ORDER]: [AgentToolName.REQUEST_CANCEL_ORDER, ...CONFIRM_TOOLS],
  [AgentCapability.POSTPONE_ORDER]: [AgentToolName.REQUEST_POSTPONE_ORDER, ...CONFIRM_TOOLS],
  [AgentCapability.CONFIRM_ORDER]: [AgentToolName.REQUEST_CONFIRM_ORDER, ...CONFIRM_TOOLS],
  [AgentCapability.ADD_CUSTOMER_ADDRESS]: [
    AgentToolName.REQUEST_ADD_CUSTOMER_ADDRESS,
    ...CONFIRM_TOOLS,
  ],
  [AgentCapability.UPDATE_CUSTOMER_ADDRESS]: [
    AgentToolName.REQUEST_UPDATE_CUSTOMER_ADDRESS,
    ...CONFIRM_TOOLS,
  ],
  [AgentCapability.REMOVE_CUSTOMER_ADDRESS]: [
    AgentToolName.REQUEST_REMOVE_CUSTOMER_ADDRESS,
    ...CONFIRM_TOOLS,
  ],
  [AgentCapability.SET_DEFAULT_ADDRESS]: [
    AgentToolName.REQUEST_SET_DEFAULT_ADDRESS,
    ...CONFIRM_TOOLS,
  ],
  [AgentCapability.GET_MY_ADDRESSES]: [AgentToolName.GET_MY_ADDRESSES],
  [AgentCapability.GET_CITIES]: [AgentToolName.GET_CITIES],
  [AgentCapability.GET_AREAS_BY_CITY]: [AgentToolName.GET_AREAS_BY_CITY],
  [AgentCapability.UPDATE_CUSTOMER]: [AgentToolName.REQUEST_UPDATE_CUSTOMER, ...CONFIRM_TOOLS],
  [AgentCapability.LOCATION]: [AgentToolName.REQUEST_LOCATION],
  [AgentCapability.REACTIONS]: [AgentToolName.REACT_TO_MESSAGE],
  [AgentCapability.TEMPLATES]: [
    AgentToolName.SEND_WHATSAPP_TEMPLATE,
    AgentToolName.LIST_WHATSAPP_TEMPLATES,
  ],
  [AgentCapability.HUMAN_HANDOFF]: [
    AgentToolName.HUMAN_HANDOFF,
    AgentToolName.LIST_ISSUE_CAUSES,
  ],
  [AgentCapability.RESUME_AUTOMATION_CHOICE]: [AgentToolName.RESUME_AUTOMATION_CHOICE],
};

const CATALOG_READ = [
  AgentCapability.SEARCH_PRODUCTS,
  AgentCapability.GET_PRODUCT_DETAILS,
  AgentCapability.SEARCH_BUNDLES,
  AgentCapability.GET_BUNDLE_DETAILS,
];
const GEO_READ = [
  AgentCapability.GET_CITIES,
  AgentCapability.GET_AREAS_BY_CITY,
];
const ADDRESS_READ = [AgentCapability.GET_MY_ADDRESSES, ...GEO_READ];
const ORDER_READ = [AgentCapability.GET_MY_ORDERS, AgentCapability.GET_ORDER_DETAILS];

/** Direct deps; expandAgentCapabilities walks them transitively. */
export const AGENT_CAPABILITY_DEPENDENCIES: Partial<Record<AgentCapability, AgentCapability[]>> = {
  [AgentCapability.GET_PRODUCT_DETAILS]: [],
  [AgentCapability.GET_BUNDLE_DETAILS]: [],
  [AgentCapability.GET_AREAS_BY_CITY]: [],
  [AgentCapability.GET_ORDER_DETAILS]: [],
  [AgentCapability.CREATE_ORDER]: [
    ...CATALOG_READ,
    AgentCapability.LIST_CATEGORIES,
    ...ADDRESS_READ,
  ],
  [AgentCapability.CAMPAIGN_ORDERS]: [...ADDRESS_READ],
  [AgentCapability.ADD_ORDER_ITEMS]: [...ORDER_READ, ...CATALOG_READ],
  [AgentCapability.REPLACE_ORDER_ITEMS]: [...ORDER_READ, ...CATALOG_READ],
  [AgentCapability.UPDATE_ORDER_ITEMS]: [...ORDER_READ, ...CATALOG_READ],
  [AgentCapability.UPDATE_ORDER_INFO]: [...ORDER_READ, ...ADDRESS_READ],
  [AgentCapability.CANCEL_ORDER]: [...ORDER_READ],
  [AgentCapability.POSTPONE_ORDER]: [...ORDER_READ],
  [AgentCapability.CONFIRM_ORDER]: [...ORDER_READ],
  [AgentCapability.ADD_CUSTOMER_ADDRESS]: [...ADDRESS_READ],
  [AgentCapability.UPDATE_CUSTOMER_ADDRESS]: [...ADDRESS_READ],
  [AgentCapability.REMOVE_CUSTOMER_ADDRESS]: [AgentCapability.GET_MY_ADDRESSES],
  [AgentCapability.SET_DEFAULT_ADDRESS]: [AgentCapability.GET_MY_ADDRESSES],
  [AgentCapability.HUMAN_HANDOFF]: [
    AgentCapability.GET_MY_ORDERS,
    AgentCapability.GET_ORDER_DETAILS,
  ],
};

/**
 * Added automatically — never user-controlled — only while an open address
 * task exists for the conversation (see ActionAiAddressCorrectionHandler).
 * Includes the full closure the flow needs, since the user may have disabled
 * everything that would otherwise provide it (incl. confirm machinery).
 */
export const AGENT_ADDRESS_TASK_TOOL_NAMES = [
  AgentToolName.REQUEST_ADDRESS_UPDATE,
  AgentToolName.CLOSE_ADDRESS_TASK,
  AgentToolName.CHECK_SHIPPING_COVERAGE,
  AgentToolName.GET_SHIPPING_ZONES,
  AgentToolName.GET_SHIPPING_DISTRICTS,
  AgentToolName.GET_MY_ADDRESSES,
  AgentToolName.GET_CITIES,
  AgentToolName.GET_AREAS_BY_CITY,
  AgentToolName.CONFIRM_PENDING_ACTION,
  AgentToolName.CANCEL_PENDING_ACTION,
];

export const AGENT_CAPABILITY_LABELS: Record<AgentCapability, string> = {
  [AgentCapability.SEARCH_PRODUCTS]: "Search products",
  [AgentCapability.GET_PRODUCT_DETAILS]: "Product details",
  [AgentCapability.SEARCH_BUNDLES]: "Search bundles",
  [AgentCapability.GET_BUNDLE_DETAILS]: "Bundle details",
  [AgentCapability.LIST_CATEGORIES]: "List categories",
  [AgentCapability.CREATE_ORDER]: "Create order",
  [AgentCapability.CAMPAIGN_ORDERS]: "Campaign orders",
  [AgentCapability.GET_MY_ORDERS]: "List orders",
  [AgentCapability.GET_ORDER_DETAILS]: "Order details",
  [AgentCapability.ADD_ORDER_ITEMS]: "Add order items",
  [AgentCapability.REPLACE_ORDER_ITEMS]: "Replace order items",
  [AgentCapability.UPDATE_ORDER_ITEMS]: "Update order items",
  [AgentCapability.UPDATE_ORDER_INFO]: "Update order info",
  [AgentCapability.CANCEL_ORDER]: "Cancel order",
  [AgentCapability.POSTPONE_ORDER]: "Postpone order",
  [AgentCapability.CONFIRM_ORDER]: "Confirm order",
  [AgentCapability.ADD_CUSTOMER_ADDRESS]: "Add saved address",
  [AgentCapability.UPDATE_CUSTOMER_ADDRESS]: "Update saved address",
  [AgentCapability.REMOVE_CUSTOMER_ADDRESS]: "Remove saved address",
  [AgentCapability.SET_DEFAULT_ADDRESS]: "Set default address",
  [AgentCapability.GET_MY_ADDRESSES]: "List saved addresses",
  [AgentCapability.GET_CITIES]: "List cities",
  [AgentCapability.GET_AREAS_BY_CITY]: "List areas",
  [AgentCapability.UPDATE_CUSTOMER]: "Update customer",
  [AgentCapability.LOCATION]: "Location requests",
  [AgentCapability.REACTIONS]: "Reactions",
  [AgentCapability.TEMPLATES]: "Template messages",
  [AgentCapability.HUMAN_HANDOFF]: "Human handoff",
  [AgentCapability.RESUME_AUTOMATION_CHOICE]: "Resume automation from chat",
};

export function expandAgentCapabilities(
  capabilities: Array<string | AgentCapability>,
): AgentCapability[] {
  const valid = new Set<string>(AGENT_USER_CAPABILITIES);
  const out = new Set<AgentCapability>();
  const visit = (cap: AgentCapability) => {
    if (out.has(cap) || !valid.has(cap)) return;
    out.add(cap);
    for (const dep of AGENT_CAPABILITY_DEPENDENCIES[cap] ?? []) visit(dep);
  };
  for (const raw of capabilities) {
    if (valid.has(raw as string)) visit(raw as AgentCapability);
  }
  return [...out];
}

/** Null/empty capabilities = all (pre-capability agents keep full behavior). */
export function resolveAgentCapabilities(
  capabilities: Array<string | AgentCapability> | null | undefined,
): AgentCapability[] {
  if (!capabilities?.length) return [...AGENT_USER_CAPABILITIES];
  return expandAgentCapabilities(capabilities);
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
  return Math.ceil(String(text ?? "").length / 2.5);
}

export function isAgentSilenced(conversation: {
  aiMode?: ConversationAiMode | string | null;
  humanHandoff?: boolean | null;
  agentPausedUntil?: Date | string | null;
}): boolean {
  if (conversation.aiMode === ConversationAiMode.DISABLED) return true;
  if (conversation.humanHandoff) return true;
  if (
    conversation.agentPausedUntil &&
    new Date(conversation.agentPausedUntil).getTime() > Date.now()
  ) {
    return true;
  }
  return false;
}
