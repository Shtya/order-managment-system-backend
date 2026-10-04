import type { WhatsappMessageEntity } from "entities/whatsapp.entity";
import type { WhatsappSendMessagePayload } from "src/whatsapp/services/WhatsappApi.service";

const AUTOMATION = "automation";
const CAMPAIGN = "campaign";
const AGENT = "agent";
const REACTION = "reaction";
const LOCATION = "location";

function isAutomationOrCampaign(source?: string | null): boolean {
  return source === AUTOMATION || source === CAMPAIGN;
}

function optionReplyOf(content: WhatsappSendMessagePayload | null | undefined): boolean {
  if (!content) return false;
  if (content.type === "interactive") {
    return content.interactive.type === "button_reply" || content.interactive.type === "list_reply";
  }
  return content.type === "button";
}

/**
 * Whether an inbound WhatsApp message should start an agent turn.
 * Automation/campaign parents, copied origin FKs, and non-agent button/list answers are skipped.
 * Reactions only enqueue when they sit on the agent's confirmation summary.
 */
export function shouldAgentHandleInbound(message: WhatsappMessageEntity): boolean {
  if (message.automationRunId || message.campaignId) return false;
  if (isAutomationOrCampaign(message.replyTo?.sendSource)) return false;
  if (isAutomationOrCampaign(message.reactionTo?.sendSource)) return false;

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
