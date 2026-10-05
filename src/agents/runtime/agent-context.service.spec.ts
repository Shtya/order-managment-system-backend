import { describe, expect, test } from "vitest";
import { toChatHistory } from "./agent-context.service";

describe("toChatHistory", () => {
  test("stubs old get_* results and keeps recent reads plus writes", () => {
    const history = toChatHistory([
      {
        role: "assistant",
        seq: 1,
        content: null,
        toolCalls: [{ id: "c1", name: "get_order_details", arguments: {} }],
      },
      { role: "tool", seq: 1, toolCallId: "c1", content: '{"status":"old"}' },
      {
        role: "assistant",
        seq: 2,
        content: null,
        toolCalls: [{ id: "c2", name: "request_cancel_order", arguments: {} }],
      },
      { role: "tool", seq: 2, toolCallId: "c2", content: '{"ok":true}' },
      {
        role: "assistant",
        seq: 4,
        content: null,
        toolCalls: [{ id: "c4", name: "get_order_details", arguments: {} }],
      },
      { role: "tool", seq: 4, toolCallId: "c4", content: '{"status":"fresh"}' },
    ]);

    const tools = history.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
    expect(tools[0].content).toContain("Stale read result");
    expect(tools[1].content).toBe('{"ok":true}');
    expect(tools[2].content).toBe('{"status":"fresh"}');
  });
});
