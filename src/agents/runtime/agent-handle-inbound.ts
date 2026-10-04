import type { WhatsappMessageEntity } from "entities/whatsapp.entity";
import type { WhatsappSendMessagePayload } from "src/whatsapp/services/WhatsappApi.service";

const AGENT = "agent";
const REACTION = "reaction";
const LOCATION = "location";

function optionReplyOf(content: WhatsappSendMessagePayload | null | undefined): boolean {
  if (!content) return false;
  if (content.type === "interactive") {
    return content.interactive.type === "button_reply" || content.interactive.type === "list_reply";
  }
  return content.type === "button";
}

/**
 * Whether an inbound WhatsApp message should start an agent turn.
 * Skip only copied flow FKs (button/list/template-button or pending location pin)
 * and non-agent option answers. A free-form reply to an automation/campaign
 * parent still goes to the agent. Reactions only enqueue on the agent's confirmation summary.
 */
export function shouldAgentHandleInbound(message: WhatsappMessageEntity): boolean {
  if (message.automationRunId || message.campaignId) return false;

  const type = message.messageType;
  if (type === REACTION) {
    return (
      message.reactionTo?.sendSource === AGENT &&
      !!message.reactionTo.metadata?.agentPendingActionId
    );
  }

  const isOptionAnswer =
    !!message.replyTo && optionReplyOf(message.content) && type !== LOCATION;
  if (isOptionAnswer) {
    return message.replyTo.sendSource === AGENT;
  }
  return true;
}
