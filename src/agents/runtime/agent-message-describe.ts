import type { TemplateConfig, WhatsappMessageEntity } from "entities/whatsapp.entity";
import type {
  WhatsappButtonMessagePayload,
  WhatsappContactObject,
  WhatsappContactsMessagePayload,
  WhatsappDocumentMessagePayload,
  WhatsappImageMessagePayload,
  WhatsappInteractiveButtonReply,
  WhatsappInteractiveHeaderObject,
  WhatsappInteractiveMessagePayload,
  WhatsappInteractiveSection,
  WhatsappLocationMessagePayload,
  WhatsappSendMessagePayload,
  WhatsappTemplateComponent,
  WhatsappTemplateMessagePayload,
  WhatsappTemplateParameter,
  WhatsappTextMessagePayload,
  WhatsappVideoMessagePayload,
} from "src/whatsapp/services/WhatsappApi.service";

type DescribeMetadata = {
  transcript?: string;
  template?: {
    templateConfig?: TemplateConfig;
    language?: string;
  };
};

const formatTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: tz,
  }).format(d);

export function describeMessage(m: WhatsappMessageEntity, tz = "Africa/Cairo"): string {
  const who = speakerLabel(m);
  const type = messageTypeOf(m);
  const idTag = m.id ? ` (msg ${m.id})` : "";

  let line = `[${formatTime(m.createdAt, tz)}] [${type}]${idTag} ${who}: "${truncate(bodyOf(m), 800)}"`;
  const extras = contentExtras(m);
  if (extras) line += ` ${extras}`;

  if (m.replyTo) line += ` (replying to: ${describeRelated(m.replyTo)})`;
  if (m.reactionTo) line += ` (reacted to: ${describeRelated(m.reactionTo)})`;
  if (m.direction === "outbound" && m.status === "failed")
    line += " [NOT DELIVERED]";
  if (m.actionIntent && m.actionIntent !== "none")
    line += ` [asked customer: ${m.actionIntent}, ${m.actionStatus}]`;
  line += originNote(m);

  return line;
}

function describeRelated(m: WhatsappMessageEntity): string {
  const extras = contentExtras(m);
  const idTag = m.id ? `(msg ${m.id}) ` : "";
  const core = `${idTag}[${messageTypeOf(m)}] ${speakerLabel(m)}: "${truncate(bodyOf(m), 300)}"`;
  return extras ? `${core} ${extras}` : core;
}

function originHost(message: WhatsappMessageEntity): WhatsappMessageEntity {
  if (
    message.automationRunId ||
    message.campaignId ||
    message.orderId ||
    message.automationRun ||
    message.campaign ||
    message.order
  ) {
    return message;
  }
  return message.replyTo ?? message.reactionTo ?? message;
}

function originNote(message: WhatsappMessageEntity): string {
  const host = originHost(message);
  const flow =
    host.automationRun?.version?.automationFlow ?? host.automationRun?.automationFlow;
  const orderNumber = host.order?.orderNumber;
  const campaignName = host.campaign?.name;
  if (!flow && !orderNumber && !campaignName) return "";

  const isInbound = message.direction !== "outbound";
  if (isInbound) {
    const target = flow
      ? `automation${flow.name ? ` "${flow.name}"` : ""}`
      : campaignName
        ? `campaign "${campaignName}"`
        : "store message";
    const orderBit = orderNumber ? ` for order #${orderNumber}` : "";
    const locNote =
      message.messageType === "location"
        ? " — location for that existing order, not a new order"
        : " — reply for that existing order, not a new order";
    return ` [reply to ${target}${orderBit}${locNote}]`;
  }

  const bits: string[] = [];
  if (flow) {
    bits.push(
      `automation${flow.name ? ` "${flow.name}"` : ""}${
        flow.triggerType ? ` trigger=${flow.triggerType}` : ""
      }`,
    );
  }
  if (campaignName) bits.push(`campaign "${campaignName}"`);
  if (orderNumber) bits.push(`order #${orderNumber}`);
  return bits.length ? ` [${bits.join(" ")}]` : "";
}

function contentOf(message: WhatsappMessageEntity): WhatsappSendMessagePayload | null {
  return message.content ?? null;
}

function isType<T extends WhatsappSendMessagePayload["type"]>(
  content: WhatsappSendMessagePayload | null,
  type: T,
): content is Extract<WhatsappSendMessagePayload, { type: T }> {
  return content?.type === type;
}

function messageTypeOf(message: WhatsappMessageEntity): string {
  return String(message.messageType ?? contentOf(message)?.type ?? "message");
}

function metadataOf(message: WhatsappMessageEntity): DescribeMetadata {
  return (message.metadata ?? {}) as DescribeMetadata;
}

/** Short readable form of any stored message (inbound raw webhook or outbound payload). */
export function bodyOf(message: WhatsappMessageEntity, limit: number = 1200): string {
  const c = contentOf(message);
  const type = messageTypeOf(message);
  let body = "";

  if (isType(c, "text")) body = textBody(c);
  else if (isType(c, "audio") || type === "audio") {
    return `[voice transcript] ${metadataOf(message).transcript ?? "[voice note, no transcript]"}`;
  } else if (isType(c, "interactive")) body = interactiveBody(c);
  else if (isType(c, "button")) body = c.button.text || "[button]";
  else if (isType(c, "template")) body = templateBody(c, message);
  else if (isType(c, "reaction")) body = `[reaction ${c.reaction.emoji}]`;
  else if (isType(c, "location")) body = locationBody(c);
  else if (isType(c, "image") || isType(c, "video") || isType(c, "document")) {
    body = mediaCaption(c) || `[${c.type}]`;
  } else body = `[${type || "message"}]`;

  return truncate(String(body), limit);
}

function textBody(c: WhatsappTextMessagePayload): string {
  return c.text.body ?? "";
}

function templateBody(
  c: WhatsappTemplateMessagePayload,
  message: WhatsappMessageEntity,
): string {
  const name = c.template.name || "template";
  const bodyText = metadataOf(message).template?.templateConfig?.bodyText;
  const params = templateParamTexts(c.template.components, "body");
  if (bodyText) {
    const filled = bodyText.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
      const value = params[Number(n) - 1];
      return value ?? `{{${n}}}`;
    });
    return filled.trim() || `[template ${name}]`;
  }
  return params.length ? params.join(" | ") : `[template ${name}]`;
}

function interactiveBody(c: WhatsappInteractiveMessagePayload): string {
  const interactive = c.interactive;
  if ("body" in interactive && interactive.body?.text) return interactive.body.text;
  if (interactive.type === "button_reply") return interactive.button_reply.title;
  if (interactive.type === "list_reply") return interactive.list_reply.title;
  return "[interactive]";
}

function locationBody(c: WhatsappLocationMessagePayload): string {
  const l = c.location;
  return `[location ${l.name ?? ""} ${l.address ?? ""} (${l.latitude}, ${l.longitude})]`.replace(/\s+/g, " ");
}

function mediaCaption(
  c: WhatsappImageMessagePayload | WhatsappVideoMessagePayload | WhatsappDocumentMessagePayload,
): string {
  if (c.type === "image") return String(c.image.caption ?? "").trim();
  if (c.type === "video") return String(c.video.caption ?? "").trim();
  return String(c.document.caption ?? "").trim();
}

function contentExtras(message: WhatsappMessageEntity): string {
  const c = contentOf(message);
  const bits: string[] = [];

  if (isType(c, "interactive")) bits.push(...interactiveExtras(c));
  else if (isType(c, "button")) bits.push(...buttonExtras(c));
  else if (isType(c, "template")) bits.push(...templateExtras(c, message));
  else if (isType(c, "contacts")) bits.push(...contactsExtras(c));
  else if (isType(c, "document") && c.document.filename) bits.push(`file=${c.document.filename}`);

  return bits.length ? `[${bits.join("; ")}]` : "";
}

function interactiveExtras(c: WhatsappInteractiveMessagePayload): string[] {
  const interactive = c.interactive;
  const bits: string[] = [`interactive=${interactive.type}`];

  if ("header" in interactive) bits.push(...headerBits(interactive.header));
  if ("footer" in interactive && interactive.footer?.text) {
    bits.push(`footer="${truncate(interactive.footer.text, 80)}"`);
  }

  if (interactive.type === "button") {
    const labels = interactive.action.buttons.map(buttonLabel).filter(Boolean);
    if (labels.length) bits.push(`buttons: ${labels.join(" | ")}`);
  } else if (interactive.type === "list") {
    bits.push(`listButton="${truncate(interactive.action.button, 40)}"`);
    const rows = listRows(interactive.action.sections);
    if (rows.length) bits.push(`options: ${rows.join(" | ")}`);
  } else if (interactive.type === "product_list") {
    const rows = listRows(interactive.action.sections);
    if (rows.length) bits.push(`options: ${rows.join(" | ")}`);
  } else if (interactive.type === "button_reply") {
    bits.push(`picked="${interactive.button_reply.title}" id=${interactive.button_reply.id}`);
  } else if (interactive.type === "list_reply") {
    const desc = interactive.list_reply.description
      ? ` (${interactive.list_reply.description})`
      : "";
    bits.push(`picked="${interactive.list_reply.title}"${desc} id=${interactive.list_reply.id}`);
  }

  return bits;
}

function buttonExtras(c: WhatsappButtonMessagePayload): string[] {
  return c.button.payload ? [`payload=${c.button.payload}`] : [];
}

function templateExtras(c: WhatsappTemplateMessagePayload, message: WhatsappMessageEntity): string[] {
  const tpl = c.template;
  const cfg = metadataOf(message).template?.templateConfig;
  const bits: string[] = [];
  if (tpl.name) bits.push(`template=${tpl.name}`);
  if (tpl.language?.code) bits.push(`lang=${tpl.language.code}`);
  const headerComponent = tpl.components?.find(
    (comp): comp is Extract<WhatsappTemplateComponent, { type: "header" }> =>
      comp.type === "header",
  );
  const headerType = cfg?.headerType || headerComponent?.parameters?.[0]?.type;
  if (headerType) bits.push(`header=${String(headerType).toLowerCase()}`);
  const headerText = cfg?.headerText || templateParamTexts(tpl.components, "header")[0];
  if (headerText) bits.push(`headerText="${truncate(headerText, 80)}"`);
  const bodyParams = templateParamTexts(tpl.components, "body");
  if (bodyParams.length) bits.push(`vars: ${bodyParams.join(" | ")}`);
  const buttonBits = templateButtons(tpl.components, cfg?.buttons);
  if (buttonBits.length) bits.push(`buttons: ${buttonBits.join(" | ")}`);
  return bits;
}

function contactsExtras(c: WhatsappContactsMessagePayload): string[] {
  const contacts = c.contacts.map(contactLabel).filter(Boolean);
  return contacts.length ? [`contacts: ${contacts.join("; ")}`] : [];
}

function contactLabel(contact: WhatsappContactObject): string {
  const name = contact.name?.formatted_name ?? contact.name?.first_name ?? "";
  const phones = (contact.phones ?? []).map((p) => p.phone ?? p.wa_id).filter(Boolean);
  return `${name} ${phones.join("/")}`.trim();
}

function headerBits(header: WhatsappInteractiveHeaderObject | undefined): string[] {
  if (!header) return [];
  const bits: string[] = [`header=${header.type}`];
  if (header.text) bits.push(`headerText="${truncate(header.text, 80)}"`);
  return bits;
}

function buttonLabel(btn: WhatsappInteractiveButtonReply): string {
  const title = btn.reply.title;
  const id = btn.reply.id;
  if (!title) return "";
  return id ? `"${title}" (${id})` : `"${title}"`;
}

function listRows(sections: WhatsappInteractiveSection[]): string[] {
  const rows: string[] = [];
  for (const section of sections) {
    const prefix = section.title ? `${section.title}: ` : "";
    for (const row of section.rows ?? []) {
      if (!row.title) continue;
      const desc = row.description ? ` — ${row.description}` : "";
      rows.push(`${prefix}"${row.title}"${desc}${row.id ? ` (${row.id})` : ""}`);
    }
  }
  return rows;
}

function templateParamTexts(
  components: WhatsappTemplateComponent[] | undefined,
  kind: WhatsappTemplateComponent["type"],
): string[] {
  const component = (components ?? []).find((comp) => comp.type === kind);
  return (component?.parameters ?? []).map(templateParamText).filter((value): value is string => Boolean(value));
}

function templateParamText(param: WhatsappTemplateParameter): string | undefined {
  if (param.type === "text") return param.text;
  if (param.type === "coupon_code") return param.coupon_code;
  if (param.type === "date_time") return param.date_time.fallback_value;
  return undefined;
}

function templateButtons(
  components: WhatsappTemplateComponent[] | undefined,
  configButtons: TemplateConfig["buttons"],
): string[] {
  const fromComponents = (components ?? [])
    .filter((comp): comp is Extract<WhatsappTemplateComponent, { type: "button" }> => comp.type === "button")
    .map((comp) => {
      const text = (comp.parameters ?? []).map(templateParamText).filter(Boolean).join(" ");
      const label = `${comp.sub_type || "button"}${text ? ` "${text}"` : ""}`;
      return `${label} (${comp.index})`;
    });
  if (fromComponents.length) return fromComponents;
  return (configButtons ?? [])
    .map((btn, index) => {
      if (!btn.text) return "";
      const kind = btn.type === "CUSTOM" ? "quick_reply" : btn.type.toLowerCase();
      return `"${btn.text}" (${kind}:${index})`;
    })
    .filter(Boolean);
}

function speakerLabel(message: WhatsappMessageEntity): string {
  if (message.direction !== "outbound") return "Customer";
  if (message.sendSource === "agent") return "Agent";
  if (message.sendSource === "automation") return "Automation";
  if (message.sendSource === "campaign") return "Campaign";
  if (message.sendSource === "system") return "System";
  if (message.sendSource === "user") {
    const name = message.sentByUser?.name?.trim();
    return name ? `Staff (${name})` : "Staff";
  }
  return "System";
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
