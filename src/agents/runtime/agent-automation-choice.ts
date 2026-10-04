import type { TemplateConfig } from "entities/whatsapp.entity";
import type { WhatsappSendMessagePayload } from "src/whatsapp/services/WhatsappApi.service";

export type AutomationChoice = { id: string; text: string };

export function automationChoicesOf(
  content: WhatsappSendMessagePayload | null | undefined,
  templateButtons?: TemplateConfig["buttons"],
): AutomationChoice[] {
  if (!content) return choicesFromTemplateConfig(templateButtons);
  if (content.type === "interactive") {
    const interactive = content.interactive;
    if (interactive.type === "button") {
      return interactive.action.buttons
        .map((btn) => ({
          id: String(btn.reply?.id ?? ""),
          text: String(btn.reply?.title ?? ""),
        }))
        .filter((c) => c.id || c.text);
    }
    if (interactive.type === "list" || interactive.type === "product_list") {
      const rows: AutomationChoice[] = [];
      for (const section of interactive.action.sections ?? []) {
        for (const row of section.rows ?? []) {
          if (!row.id && !row.title) continue;
          rows.push({ id: String(row.id ?? ""), text: String(row.title ?? "") });
        }
      }
      return rows;
    }
    return [];
  }
  if (content.type === "template") {
    const fromComponents = (content.template.components ?? [])
      .filter((comp) => comp.type === "button")
      .map((comp) => {
        const text = (comp.parameters ?? [])
          .map((p) => (p.type === "text" ? p.text : ""))
          .filter(Boolean)
          .join(" ");
        return { id: String(comp.index ?? ""), text };
      })
      .filter((c) => c.id || c.text);
    if (fromComponents.length) return fromComponents;
    return choicesFromTemplateConfig(templateButtons);
  }
  return choicesFromTemplateConfig(templateButtons);
}

function choicesFromTemplateConfig(buttons: TemplateConfig["buttons"]): AutomationChoice[] {
  return (buttons ?? [])
    .filter((btn) => btn.type === "CUSTOM" && btn.text)
    .map((btn) => ({ id: btn.text, text: btn.text }));
}

export function prepareResumeAutomationChoice(input: {
  row: {
    conversationId: string;
    direction: string;
    sendSource?: string | null;
    messageId?: string | null;
    content?: WhatsappSendMessagePayload | null;
    metadata?: { template?: { templateConfig?: { buttons?: TemplateConfig["buttons"] } } } | null;
  } | null;
  buttonId: string;
  buttonText: string;
}):
  | { ok: true; originalMessageId: string; buttonId: string; buttonText: string }
  | { ok: false; code: string; error: string } {
  const { row, buttonId, buttonText } = input;
  if (!row) return { ok: false, code: "NOT_FOUND", error: "That message is not in this conversation." };
  if (row.direction !== "outbound" || row.sendSource !== "automation") {
    return { ok: false, code: "NOT_AUTOMATION", error: "That message is not a store automation message." };
  }
  if (!row.messageId) {
    return { ok: false, code: "NOT_READY", error: "That automation message has no WhatsApp id yet." };
  }
  const choice = matchAutomationChoice(row.content, { buttonId, buttonText }, row.metadata?.template?.templateConfig?.buttons);
  if (!choice) {
    return {
      ok: false,
      code: "UNKNOWN_OPTION",
      error:
        "That option is not on this automation message. Ask the customer which button they mean, or use a listed id/title.",
    };
  }
  return {
    ok: true,
    originalMessageId: row.messageId,
    buttonId: choice.id || buttonId,
    buttonText: choice.text || buttonText || choice.id,
  };
}

export function matchAutomationChoice(
  content: WhatsappSendMessagePayload | null | undefined,
  input: { buttonId?: string; buttonText?: string },
  templateButtons?: TemplateConfig["buttons"],
): AutomationChoice | null {
  const buttonId = input.buttonId?.trim() ?? "";
  const buttonText = input.buttonText?.trim() ?? "";
  if (!buttonId && !buttonText) return null;
  const choices = automationChoicesOf(content, templateButtons);
  if (buttonId) {
    const byId = choices.find(
      (c) => c.id === buttonId || c.id.toLowerCase() === buttonId.toLowerCase(),
    );
    if (byId) return byId;
  }
  if (buttonText) {
    const wanted = buttonText.toLowerCase();
    return choices.find((c) => c.text.toLowerCase() === wanted) ?? null;
  }
  return null;
}
