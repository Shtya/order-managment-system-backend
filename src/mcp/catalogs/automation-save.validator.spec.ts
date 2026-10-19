import { vi } from "vitest";

vi.mock("entities/automation.entity", () => ({
  TriggerType: {
    ORDER_CREATED: "order_created",
    ORDER_UPDATED: "order_updated",
    SHIPMENT_CREATED: "shipment_created",
    SHIPMENT_UPDATED: "shipment_updated",
    ASSIGNMENT_CANCELLED: "assignment_cancelled",
  },
  ActionType: {
    UPDATE_ORDER_STATUS: "update_order_status",
    ASSIGN_ORDER_TO_EMPLOYEE: "assign_order_to_employee",
    AI_ADDRESS_CORRECTION: "ai_address_correction",
    ASSIGN_SHIPPING_PROVIDER: "assign_shipping_provider",
    SEND_WHATSAPP_TEMPLATE: "send_whatsapp_template",
    SEND_WHATSAPP_MESSAGE: "send_whatsapp_message",
    SEND_UPSELL: "send_upsell",
    SEND_SMS: "send_sms",
    WAIT: "wait",
    CREATE_ISSUE: "create_issue",
    ASSIGN_ORDER_TO_CLIENT: "assign_order_to_client",
  },
  ConditionType: {
    ORDER_CHECK: "order_check",
    QUICK_ORDER_STATUS: "quick_order_status",
    AI_ADDRESS_COMPLETENESS: "ai_address_completeness",
  },
}));
vi.mock("entities/shipping.entity", () => ({
  ShipmentStatus: {
    PENDING_ACTION: "pending_action",
    PREPARING: "preparing",
    READY_TO_SHIP: "ready_to_ship",
    OUT_FOR_DELIVERY: "out_for_delivery",
    DELIVERED: "delivered",
    RETURNED_TO_WAREHOUSE: "returned_to_warehouse",
    FAILED: "failed",
    CUSTOMER_NOT_RESPOND: "customer_not_respond",
    CUSTOMER_DATA_WRONG: "customer_data_wrong",
    CUSTOMER_REFUSED: "customer_refused",
    CANCELLED: "cancelled",
  },
}));

import { validateAndNormalizeNodes } from "./automation-save.validator";
import { saveFlowNodeInput } from "../mcp-tools/automation-flow-inputs";

describe("automation-save.validator", () => {
  it("normalizes node kind, label, config, and layout position", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", data: { type: "assignment_cancelled" } },
      { id: "n2", data: { type: "wait", config: { waitMinutes: 5 } } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.nodes[0]).toMatchObject({
      id: "n1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { type: "assignment_cancelled", label: "Assignment Cancelled" },
    });
    expect(result.nodes[1]).toMatchObject({
      id: "n2",
      type: "action",
      position: { x: 280, y: 0 },
      data: { type: "wait", label: "Wait", config: { waitMinutes: 5 } },
    });
  });

  it("accepts optional node position metadata in the save-flow schema", () => {
    const result = saveFlowNodeInput.safeParse({
      id: "n1",
      position: { x: 42, y: 99 },
      data: { type: "assignment_cancelled" },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      id: "n1",
      position: { x: 42, y: 99 },
      data: { type: "assignment_cancelled" },
    });
  });

  it("applies catalog defaults to the config", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", data: { type: "assignment_cancelled", config: {} } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.nodes[0].data.config.cancelSource).toBe("automatic");
  });

  it("preserves config keys the catalog does not model", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", data: { type: "wait", config: { waitMinutes: 5, customKey: "keep-me" } } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.nodes[0].data.config).toMatchObject({ waitMinutes: 5, customKey: "keep-me" });
  });

  it("rejects a removed or unknown step id", () => {
    const result = validateAndNormalizeNodes([{ id: "n1", data: { type: "send_sms" } }]);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('unknown step type "send_sms"');
    expect(result.errors[0]).toContain("automation_steps_list");
  });

  it("rejects a node kind that does not match the step", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", type: "action", data: { type: "assignment_cancelled" } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('node.type "action" does not match step "assignment_cancelled" (trigger)');
  });

  it("reports a bad config value with the node label and config path", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", data: { type: "wait", label: "Delay", config: { waitMinutes: 0 } } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("n1 (Delay) (wait) config.waitMinutes");
  });

  it("rejects config on a step that has no settings", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", data: { type: "ai_address_completeness", config: { anything: true } } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("this step has no settings");
  });

  it("keeps the generated business message and derives its branches", () => {
    const result = validateAndNormalizeNodes([
      {
        id: "n1",
        data: {
          type: "send_whatsapp_message",
          config: {
            messageMode: "business",
            businessUseCase: "order_payment_method",
            noResponseMinutes: 60,
            branches: [{ id: "accept", label: "Accept", condition: "accept" }],
          },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    const config = result.nodes[0].data.config as any;
    expect(config.businessCommand).toBe("order.set_payment_method");
    expect(config.messageData.interactive.action.buttons).toHaveLength(3);
    expect(config.branches.map((branch: any) => branch.id)).toEqual([
      "btn_0",
      "btn_1",
      "btn_2",
      "no_response",
    ]);
    expect(config.branches[3]).toMatchObject({
      id: "no_response",
      isNoResponse: true,
      timeoutMinutes: 60,
    });
    expect(config.branches[3].condition).toBeUndefined();
    expect(config.actionIntent).toBe("branches");
    expect(config.messageMode).toBe("business");
    expect(result.previousBranches.get("n1")).toEqual([
      { id: "accept", label: "Accept", condition: "accept" },
    ]);
  });

  it("derives template branches from CUSTOM buttons only", () => {
    const result = validateAndNormalizeNodes([
      {
        id: "n1",
        data: {
          type: "send_whatsapp_template",
          config: {
            templateId: "11111111-1111-4111-8111-111111111111",
            templateName: "order_followup",
            templateData: {
              bodyText: "Hello {{customerName}}",
              buttons: [
                { type: "CUSTOM", text: "Confirm order" },
                { type: "VISIT_WEBSITE", text: "Visit" },
                { type: "CUSTOM", text: "Cancel order" },
              ],
            },
            noResponseMinutes: 30,
          },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    const branches = result.nodes[0].data.config.branches as any[];
    expect(branches.map((branch) => branch.id)).toEqual(["btn_0", "btn_1", "no_response"]);
    expect(branches[0]).toMatchObject({ label: "Confirm order", condition: "button_click_0" });
    expect(branches[1]).toMatchObject({ label: "Cancel order", condition: "button_click_1" });
    expect(branches[2]).toMatchObject({ timeoutMinutes: 30, isNoResponse: true });
  });

  it("derives a catch-all branch for a list message", () => {
    const result = validateAndNormalizeNodes([
      {
        id: "n1",
        data: {
          type: "send_whatsapp_message",
          config: {
            messageMode: "custom",
            messageType: "list",
            messageData: {
              type: "interactive",
              interactive: {
                type: "list",
                body: { text: "Pick one" },
                action: {
                  button: "Open",
                  sections: [
                    { title: "Options", rows: [{ id: "row_1", title: "Option 1" }] },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    const config = result.nodes[0].data.config as any;
    expect(config.branches).toEqual([
      { id: "any_option", label: "When respond", isCatchAll: true },
    ]);
    expect(config.actionIntent).toBe("branches");
  });

  it("derives the fixed branches for conditions, upsell, and assignment", () => {
    const result = validateAndNormalizeNodes([
      {
        id: "n1",
        data: {
          type: "order_check",
          config: {
            checks: [
              { field: "status", fieldLabel: "Status", operator: "==", targetValue: "x" },
            ],
          },
        },
      },
      { id: "n2", data: { type: "send_upsell", config: {} } },
      {
        id: "n3",
        data: { type: "assign_order_to_employee", config: { employeeId: "33333333-3333-4333-8333-333333333333" } },
      },
      { id: "n4", data: { type: "assign_order_to_employee", config: {} } },
    ]);

    expect(result.ok).toBe(true);
    expect((result.nodes[0].data.config.branches as any[]).map((b) => b.id)).toEqual(["true", "false"]);
    expect((result.nodes[1].data.config.branches as any[]).map((b) => b.id)).toEqual([
      "skipped",
      "reject",
      "accept",
      "client_reject",
    ]);
    expect((result.nodes[2].data.config.branches as any[]).map((b) => b.id)).toEqual([
      "assigned",
      "not_eligable",
    ]);
    expect((result.nodes[3].data.config.branches as any[]).map((b) => b.id)).toEqual([
      "assigned",
      "no_roles_match",
      "not_eligable",
    ]);
  });

  it("drops model branches on a step that does not branch", () => {
    const result = validateAndNormalizeNodes([
      {
        id: "n1",
        data: { type: "wait", config: { waitMinutes: 5, branches: [{ id: "oops", label: "Oops" }] } },
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.nodes[0].data.config).not.toHaveProperty("branches");
    expect(result.previousBranches.get("n1")).toEqual([{ id: "oops", label: "Oops" }]);
  });

  it("reports useful paths for an invalid union config", () => {
    const result = validateAndNormalizeNodes([
      { id: "n1", data: { type: "send_whatsapp_message", config: { messageMode: "business" } } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("businessUseCase");
  });

  it("caps the number of reported issues", () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `n${index}`,
      data: { type: "wait", config: { waitMinutes: 0 } },
    }));

    const result = validateAndNormalizeNodes(nodes);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(15);
    expect(result.errors[result.errors.length - 1]).toMatch(/^\.\.\.and \d+ more issue\(s\)\.$/);
  });
});
