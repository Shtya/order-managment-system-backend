import { describe, expect, test } from "vitest";
import { describeMessage } from "./agent-message-describe";

const createdAt = new Date("2026-10-04T08:40:00.000Z");

function message(overrides: Record<string, unknown> = {}) {
  return {
    createdAt,
    direction: "outbound",
    sendSource: "automation",
    status: "sent",
    messageType: "text",
    content: { type: "text", text: { body: "Send your pin" } },
    actionIntent: "none",
    ...overrides,
  } as any;
}

describe("describeMessage origin", () => {
  test("labels outbound automation with flow, trigger and order", () => {
    const line = describeMessage(
      message({
        actionIntent: "location_request",
        actionStatus: "pending",
        order: { orderNumber: "12345" },
        automationRun: {
          version: {
            automationFlow: { name: "Confirm address", triggerType: "order_created" },
          },
        },
      }),
    );

    expect(line).toContain("[text]");
    expect(line).toContain('automation "Confirm address" trigger=order_created');
    expect(line).toContain("order #12345");
    expect(line).toContain("asked customer: location_request");
  });

  test("labels inbound location as reply for that existing order", () => {
    const line = describeMessage(
      message({
        direction: "inbound",
        sendSource: undefined,
        messageType: "location",
        content: {
          type: "location",
          location: { name: "Home", address: "Cairo", latitude: 30, longitude: 31 },
        },
        order: { orderNumber: "12345" },
        automationRun: {
          version: {
            automationFlow: { name: "Confirm address", triggerType: "order_created" },
          },
        },
      }),
    );

    expect(line).toContain(
      '[reply to automation "Confirm address" for order #12345 — location for that existing order, not a new order]',
    );
  });

  test("labels outbound campaign with campaign name", () => {
    const line = describeMessage(
      message({
        sendSource: "campaign",
        content: { type: "template", template: { name: "offer" } },
        campaign: { name: "Ramadan offers" },
      }),
    );

    expect(line).toContain('campaign "Ramadan offers"');
    expect(line).toContain("Campaign:");
  });

  test("falls back to replyTo origin when inbound has no FKs", () => {
    const parent = message({
      order: { orderNumber: "99" },
      automationRun: {
        version: {
          automationFlow: { name: "Status update", triggerType: "order_updated" },
        },
      },
    });
    const line = describeMessage(
      message({
        direction: "inbound",
        content: { type: "text", text: { body: "ok" } },
        replyTo: parent,
      }),
    );

    expect(line).toContain(
      '[reply to automation "Status update" for order #99 — reply for that existing order, not a new order]',
    );
  });

  test("includes message type, buttons, header and reply/reaction parents", () => {
    const parent = message({
      messageType: "interactive",
      content: {
        type: "interactive",
        interactive: {
          type: "button",
          header: { type: "text", text: "Cities" },
          body: { text: "Choose a city" },
          footer: { text: "Tap one" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "cairo", title: "Cairo" } },
              { type: "reply", reply: { id: "giza", title: "Giza" } },
            ],
          },
        },
      },
    });
    const line = describeMessage(
      message({
        direction: "inbound",
        sendSource: undefined,
        messageType: "interactive",
        content: {
          type: "interactive",
          interactive: {
            type: "button_reply",
            button_reply: { id: "cairo", title: "Cairo" },
          },
        },
        replyTo: parent,
        reactionTo: parent,
      }),
    );

    expect(line).toContain("[interactive]");
    expect(line).toContain('picked="Cairo" id=cairo');
    expect(line).toContain("replying to:");
    expect(line).toContain("reacted to:");
    expect(line).toContain("header=text");
    expect(line).toContain('buttons: "Cairo" (cairo) | "Giza" (giza)');
  });

  test("quotes filled template body, not only the template name", () => {
    const line = describeMessage(
      message({
        messageType: "template",
        content: {
          type: "template",
          template: {
            name: "order_confirmation_en",
            language: { code: "en" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: "Ahmed" },
                  { type: "text", text: "ORDKN2H5ZM" },
                  { type: "text", text: "14789.00" },
                  { type: "text", text: "40، بجوار ورشة المصري" },
                ],
              },
            ],
          },
        },
        metadata: {
          template: {
            templateConfig: {
              bodyText:
                "Hello {{1}},\n\nWe received your new order:\n\n📦 Order ID: {{2}}\n💰 Total: {{3}}\n📍 Address: {{4}}",
            },
          },
        },
      }),
    );

    expect(line).toContain("Hello Ahmed");
    expect(line).toContain("ORDKN2H5ZM");
    expect(line).toContain("14789.00");
    expect(line).not.toContain('"[template order_confirmation_en]"');
  });

  test("includes list options on outbound list messages", () => {
    const line = describeMessage(
      message({
        messageType: "interactive",
        content: {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: "Pick a time" },
            action: {
              button: "Times",
              sections: [
                {
                  title: "Today",
                  rows: [
                    { id: "am", title: "Morning", description: "9-12" },
                    { id: "pm", title: "Evening" },
                  ],
                },
              ],
            },
          },
        },
      }),
    );

    expect(line).toContain("interactive=list");
    expect(line).toContain('listButton="Times"');
    expect(line).toContain('options: Today: "Morning" — 9-12 (am) | Today: "Evening" (pm)');
  });

  test("includes message uuid and template/list option ids", () => {
    const listLine = describeMessage(
      message({
        id: "msg-list-1",
        messageType: "interactive",
        content: {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: "Pick a time" },
            action: {
              button: "Times",
              sections: [{ rows: [{ id: "am", title: "Morning" }] }],
            },
          },
        },
      }),
    );
    expect(listLine).toContain("(msg msg-list-1)");
    expect(listLine).toContain("(am)");

    const tplLine = describeMessage(
      message({
        id: "msg-tpl-1",
        messageType: "template",
        content: {
          type: "template",
          template: { name: "order_confirmation_en", language: { code: "en" } },
        },
        metadata: {
          template: {
            templateConfig: {
              bodyText: "Hello",
              buttons: [
                { type: "CUSTOM", text: "Confirm Order" },
                { type: "CUSTOM", text: "Cancel Order" },
              ],
            },
          },
        },
      }),
    );
    expect(tplLine).toContain("(msg msg-tpl-1)");
    expect(tplLine).toContain('"Confirm Order" (Confirm Order)');
    expect(tplLine).toContain('"Cancel Order" (Cancel Order)');

    const mixed = describeMessage(
      message({
        id: "msg-tpl-2",
        messageType: "template",
        content: {
          type: "template",
          template: {
            name: "order_confirmation_en",
            language: { code: "en" },
            components: [
              { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ORDZCVNN6K" }] },
            ],
          },
        },
        metadata: {
          template: {
            templateConfig: {
              bodyText: "Hello",
              buttons: [
                { type: "VISIT_WEBSITE", text: "View Order" },
                { type: "CUSTOM", text: "Confirm Order" },
                { type: "CUSTOM", text: "Cancel Order" },
              ],
            },
          },
        },
      }),
    );
    expect(mixed).toContain('buttons: "Confirm Order" (Confirm Order) | "Cancel Order" (Cancel Order)');
    expect(mixed).toContain('not replies: visit_website "View Order"');
    expect(mixed).not.toContain('url "View Order" (ORDZCVNN6K)');
  });
});
