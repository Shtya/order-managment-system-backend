export const ORDER_FOLLOWUP_URL_PLACEHOLDER = "{orderUrl}";
export const ORDER_TOKEN_PLACEHOLDER = "{{campaign.orderToken}}";
export const ORDER_URL_PLACEHOLDER = "{{campaign.orderUrl}}";

const ORDER_LINK_VAR_RE = /\{\{\s*campaign\.(orderToken|orderUrl)\s*\}\}/i;
const CUSTOM_BUTTON_TYPES = new Set(["CUSTOM", "QUICK_REPLY"]);

function rawVarValue(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object" && !Array.isArray(input) && "value" in (input as object)) {
    return String((input as { value?: unknown }).value ?? "");
  }
  return String(input);
}

export function campaignOrderPageBaseUrl(): string {
  const frontend = String(
    process.env.CAMPAIGN_ORDER_PAGE_BASE_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:3000",
  ).replace(/\/+$/, "");
  if (frontend.endsWith("/confirm")) return frontend;
  return `${frontend}/confirm`;
}

export function buildCampaignOrderUrl(token: string): string {
  return `${campaignOrderPageBaseUrl()}/${token}`;
}

export function textHasOrderLinkVariable(text?: string | null): boolean {
  const value = String(text ?? "");
  return ORDER_LINK_VAR_RE.test(value) || value.includes(ORDER_FOLLOWUP_URL_PLACEHOLDER);
}

function collectVariableValues(vars?: Record<string, any> | null): string[] {
  if (!vars || typeof vars !== "object") return [];
  return Object.values(vars).map((item) => rawVarValue(item));
}

export type CampaignQuickReply = {
  index: number;
  text: string;
};

export function inspectTemplateOrderLink(whatsapp?: any): {
  hasOrderUrlVariable: boolean;
  hasOrderUrlSlot: boolean;
  quickReplies: CampaignQuickReply[];
  hasQuickReply: boolean;
  orderLinkAvailable: boolean;
  qrOnly: boolean;
  urlOnly: boolean;
} {
  const source = whatsapp?.templateData ? whatsapp : { templateData: whatsapp };
  const templateData = source.templateData || {};
  const buttons = Array.isArray(templateData.buttons) ? templateData.buttons : [];

  const variableTexts = [
    ...collectVariableValues(source.headerVariables),
    ...collectVariableValues(source.bodyVariables),
    ...collectVariableValues(source.buttonVariables),
    rawVarValue(source.locationData?.name),
    rawVarValue(source.locationData?.address),
  ];
  const hasOrderUrlVariable = variableTexts.some((text) =>
    textHasOrderLinkVariable(text),
  );

  const quickReplies: CampaignQuickReply[] = buttons
    .map((btn: any, index: number) => ({
      index,
      text: String(btn?.text || ""),
      type: btn?.type,
    }))
    .filter((btn) => CUSTOM_BUTTON_TYPES.has(btn.type))
    .map(({ index, text }) => ({ index, text }));

  const hasQuickReply = quickReplies.length > 0;
  return {
    hasOrderUrlVariable,
    hasOrderUrlSlot: hasOrderUrlVariable,
    quickReplies,
    hasQuickReply,
    orderLinkAvailable: hasOrderUrlVariable || hasQuickReply,
    qrOnly: !hasOrderUrlVariable && hasQuickReply,
    urlOnly: hasOrderUrlVariable && !hasQuickReply,
  };
}

export function followupTextHasOrderUrl(text?: string | null): boolean {
  return textHasOrderLinkVariable(text);
}

export function substituteFollowupOrderUrl(text: string, url: string): string {
  return String(text ?? "").split(ORDER_FOLLOWUP_URL_PLACEHOLDER).join(url);
}

export function buttonValueNeedsOrderToken(value?: string | null): boolean {
  return textHasOrderLinkVariable(value);
}
