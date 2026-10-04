import { describe, expect, test } from "vitest";
import { shouldAgentHandleInbound } from "./agent-handle-inbound";

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    messageType: "text",
    content: {
      messaging_product: "whatsapp",
      to: "20100",
      type: "text",
      text: { body: "hello" },
    },
    ...overrides,
  } as Parameters<typeof shouldAgentHandleInbound>[0];
}

describe("shouldAgentHandleInbound", () => {
  test("skips replies to automation parents", () => {
    expect(shouldAgentHandleInbound(inbound({ replyTo: { sendSource: "automation" } }))).toBe(false);
  });

  test("skips replies to campaign parents", () => {
    expect(shouldAgentHandleInbound(inbound({ replyTo: { sendSource: "campaign" } }))).toBe(false);
  });

  test("skips reactions to automation or campaign", () => {
    expect(
      shouldAgentHandleInbound(
        inbound({
          messageType: "reaction",
          reactionTo: { sendSource: "automation" },
        }),
      ),
    ).toBe(false);
  });

  test("skips unthreaded location with copied automationRunId", () => {
    expect(
      shouldAgentHandleInbound(
        inbound({
          messageType: "location",
          automationRunId: "run-1",
          content: {
            messaging_product: "whatsapp",
            to: "20100",
            type: "location",
            location: { latitude: 30, longitude: 31 },
          },
        }),
      ),
    ).toBe(false);
  });

  test("skips inbound with campaignId even without replyTo", () => {
    expect(shouldAgentHandleInbound(inbound({ campaignId: "camp-1" }))).toBe(false);
  });

  test("skips button answers whose parent is not the agent", () => {
    expect(
      shouldAgentHandleInbound(
        inbound({
          messageType: "interactive",
          content: {
            messaging_product: "whatsapp",
            to: "20100",
            type: "interactive",
            interactive: {
              type: "button_reply",
              button_reply: { id: "yes", title: "Yes" },
            },
          },
          replyTo: { sendSource: "system" },
        }),
      ),
    ).toBe(false);
  });

  test("allows button answers to the agent", () => {
    expect(
      shouldAgentHandleInbound(
        inbound({
          messageType: "interactive",
          content: {
            messaging_product: "whatsapp",
            to: "20100",
            type: "interactive",
            interactive: {
              type: "button_reply",
              button_reply: { id: "yes", title: "Yes" },
            },
          },
          replyTo: { sendSource: "agent" },
        }),
      ),
    ).toBe(true);
  });

  test("allows reactions on the agent's confirmation summary", () => {
    expect(
      shouldAgentHandleInbound(
        inbound({
          messageType: "reaction",
          reactionTo: {
            sendSource: "agent",
            metadata: { agentPendingActionId: "act-1" },
          },
        }),
      ),
    ).toBe(true);
  });

  test("allows a normal customer text with no origin", () => {
    expect(shouldAgentHandleInbound(inbound())).toBe(true);
  });
});
