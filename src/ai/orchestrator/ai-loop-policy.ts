import { AiToolCall } from "../interfaces/ai-types";
import { AiToolAudience } from "../tools/ai-tool.abstract";
import { AiToolContext } from "../tools/ai-tool-context";

/**
 * The per-caller rules of the shared provider/tool loop. Provider selection, failover,
 * model health, write idempotency and observability are the same for every policy.
 */
export interface AiLoopPolicy {
  audience: AiToolAudience;
  /** "ordered": write tools (including send tools) run one at a time in call order; consecutive read tools still run together. */
  toolExecution: "parallel" | "ordered";
  /** Tools still offered on the last round. Empty = no tools, the model must answer in text. */
  lastRoundToolNames: string[];
  /** Pushed after the tool round right before the last one. */
  lastRoundNote?: string;
  /** "nudge_once_then_fail": plain text only ends the turn after one of `sendToolNames` ran; otherwise the model is reminded once. */
  onAssistantText: "finish" | "nudge_once_then_fail";
  assistantTextNudge?: string;
  sendToolNames?: string[];
  /** Calling this tool ends the turn after the current round's tools ran. */
  terminalToolName?: string;
  /** Overrides the write-tool idempotency key (default: tool dedup key, else args hash). */
  writeDedupScope?: (toolCall: AiToolCall, ctx: AiToolContext) => string | null;
}

export const FORCE_ANSWER_NOTE =
  "You have already retrieved all the information needed to answer the user's request. Do not call any more tools. Provide the final answer now using only the tool results already present in this conversation.";

export const ERP_ASSISTANT_POLICY: AiLoopPolicy = {
  audience: "staff",
  toolExecution: "parallel",
  lastRoundToolNames: [],
  lastRoundNote: FORCE_ANSWER_NOTE,
  onAssistantText: "finish",
};

export const AGENT_END_TURN_TOOL = "end_turn";
export const AI_AGENT_ROLE = "ai_agent";

const AGENT_TEXT_NUDGE =
  "Plain text is never shown to the customer. Reply using the send tools, or call end_turn if no reply is needed.";

const AGENT_LAST_ROUND_NOTE =
  "This is your last step. Send your reply to the customer now using the send tools, then call end_turn.";

export function customerAgentPolicy(options: {
  sendToolNames: string[];
  writeDedupScope?: AiLoopPolicy["writeDedupScope"];
}): AiLoopPolicy {
  return {
    audience: "customer",
    toolExecution: "ordered",
    lastRoundToolNames: [...options.sendToolNames, AGENT_END_TURN_TOOL],
    lastRoundNote: AGENT_LAST_ROUND_NOTE,
    onAssistantText: "nudge_once_then_fail",
    assistantTextNudge: AGENT_TEXT_NUDGE,
    sendToolNames: options.sendToolNames,
    terminalToolName: AGENT_END_TURN_TOOL,
    writeDedupScope: options.writeDedupScope,
  };
}
