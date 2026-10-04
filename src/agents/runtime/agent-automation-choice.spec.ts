import { describe, expect, test } from "vitest";
import { matchAutomationChoice, prepareResumeAutomationChoice } from "./agent-automation-choice";

describe("matchAutomationChoice", () => {
  test("matches interactive button by id", () => {
    const content = {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Offer" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "u1_btn_0", title: "Accept" } },
            { type: "reply", reply: { id: "u1_btn_1", title: "Reject" } },
          ],
        },
      },
    } as const;
    expect(matchAutomationChoice(content as any, { buttonId: "u1_btn_0" })).toEqual({
      id: "u1_btn_0",
      text: "Accept",
    });
  });

  test("matches list row by title", () => {
    const content = {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Pick" },
        action: {
          button: "Open",
          sections: [{ rows: [{ id: "am", title: "Morning" }] }],
        },
      },
    } as const;
    expect(matchAutomationChoice(content as any, { buttonText: "morning" })).toEqual({
      id: "am",
      text: "Morning",
    });
  });

  test("matches template CUSTOM button text from config", () => {
    expect(
      matchAutomationChoice(
        { type: "template", template: { name: "t", language: { code: "en" } } } as any,
        { buttonText: "Confirm Order" },
        [{ type: "CUSTOM", text: "Confirm Order" }, { type: "CUSTOM", text: "Cancel Order" }],
      ),
    ).toEqual({ id: "Confirm Order", text: "Confirm Order" });
  });

  test("returns null for unknown option", () => {
    expect(
      matchAutomationChoice(
        { type: "text", text: { body: "hi" } } as any,
        { buttonText: "Yes" },
      ),
    ).toBeNull();
  });
});

describe("prepareResumeAutomationChoice", () => {
  const upsell = {
    conversationId: "c1",
    direction: "outbound",
    sendSource: "automation",
    messageId: "wamid.ABC",
    content: {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Offer" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "u1_btn_0", title: "Accept" } },
          ],
        },
      },
    },
  };

  test("enqueues payload for a matched automation button", () => {
    expect(
      prepareResumeAutomationChoice({
        row: upsell as any,
        buttonId: "u1_btn_0",
        buttonText: "",
      }),
    ).toEqual({
      ok: true,
      originalMessageId: "wamid.ABC",
      buttonId: "u1_btn_0",
      buttonText: "Accept",
    });
  });

  test("rejects a plain text parent", () => {
    expect(
      prepareResumeAutomationChoice({
        row: { ...upsell, content: { type: "text", text: { body: "hi" } } } as any,
        buttonId: "",
        buttonText: "Yes",
      }),
    ).toMatchObject({ ok: false, code: "UNKNOWN_OPTION" });
  });

  test("rejects an unknown option", () => {
    expect(
      prepareResumeAutomationChoice({
        row: upsell as any,
        buttonId: "nope",
        buttonText: "",
      }),
    ).toMatchObject({ ok: false, code: "UNKNOWN_OPTION" });
  });

  test("rejects a missing row", () => {
    expect(
      prepareResumeAutomationChoice({
        row: null,
        buttonId: "u1_btn_0",
        buttonText: "",
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
