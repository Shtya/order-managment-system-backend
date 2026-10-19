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
  FlowNodeType: {
    TRIGGER: "trigger",
    ACTION: "action",
    CONDITION: "condition",
  },
  FlowWhatsappAccountMode: {
    RANDOM: "random",
    FIXED: "fixed",
  },
  FlowNodeDataType: {},
  NodeConfig: {},
  SendWhatsappTemplateConfig: {},
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
vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

import { rewriteEdgeHandles } from "./automation-branches";
import { validateAndNormalizeNodes } from "./automation-save.validator";
import { CreateAutomationDto } from "dto/automation.dto";
import { parseDto } from "../utils/mcp-dto.util";

const rawNodes = [
  { id: "n1", data: { type: "assignment_cancelled" } },
  { id: "n2", data: { type: "wait", config: { waitMinutes: 5 } } },
];

describe("automation save pipeline (normalize -> DTO)", () => {
  it("accepts the normalized flow through the REST DTO", async () => {
    const validation = validateAndNormalizeNodes(rawNodes);
    expect(validation.ok).toBe(true);

    const parsed = await parseDto(CreateAutomationDto, {
      name: "Welcome",
      triggerType: "assignment_cancelled",
      flow: {
        nodes: validation.nodes,
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      },
    });

    expect(parsed.ok).toBe(true);
  });

  it("lets the DTO reject a disconnected graph after normalization", async () => {
    const validation = validateAndNormalizeNodes(rawNodes);
    expect(validation.ok).toBe(true);

    const parsed = await parseDto(CreateAutomationDto, {
      name: "Welcome",
      triggerType: "assignment_cancelled",
      flow: { nodes: validation.nodes, edges: [] },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) expect(parsed.message).toMatch(/flow/);
  });

  it("injects branches and remaps AI handles before the DTO", async () => {
    const validation = validateAndNormalizeNodes([
      { id: "n1", data: { type: "assignment_cancelled" } },
      {
        id: "n2",
        data: {
          type: "order_check",
          config: {
            checks: [
              { field: "client.confirmedPercent", fieldLabel: "Confirmed %", operator: ">", targetValue: 80 },
            ],
            branches: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          },
        },
      },
      { id: "n3", data: { type: "wait", config: { waitMinutes: 5 } } },
      { id: "n4", data: { type: "wait", config: { waitMinutes: 10 } } },
    ]);
    expect(validation.ok).toBe(true);
    expect((validation.nodes[1].data.config.branches as any[]).map((b) => b.id)).toEqual([
      "true",
      "false",
    ]);

    const rewritten = rewriteEdgeHandles(
      [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3", sourceHandle: "yes" },
        { id: "e3", source: "n2", target: "n4", sourceHandle: "no" },
      ],
      validation.nodes,
      validation.previousBranches,
    );
    expect(rewritten.errors).toEqual([]);
    expect(rewritten.edges[1].sourceHandle).toBe("true");
    expect(rewritten.edges[2].sourceHandle).toBe("false");

    const parsed = await parseDto(CreateAutomationDto, {
      name: "Branching",
      triggerType: "assignment_cancelled",
      flow: { nodes: validation.nodes, edges: rewritten.edges },
    });

    expect(parsed.ok).toBe(true);
  });

  it("rejects a flow whose edge handle cannot be resolved", () => {
    const validation = validateAndNormalizeNodes([
      { id: "n1", data: { type: "assignment_cancelled" } },
      {
        id: "n2",
        data: {
          type: "order_check",
          config: {
            checks: [
              { field: "status", fieldLabel: "Status", operator: "==", targetValue: "x" },
            ],
          },
        },
      },
      { id: "n3", data: { type: "wait", config: { waitMinutes: 5 } } },
      { id: "n4", data: { type: "wait", config: { waitMinutes: 10 } } },
    ]);
    expect(validation.ok).toBe(true);

    const rewritten = rewriteEdgeHandles(
      [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3", sourceHandle: "maybe" },
        { id: "e3", source: "n2", target: "n4", sourceHandle: "no" },
      ],
      validation.nodes,
      validation.previousBranches,
    );

    expect(rewritten.errors).toHaveLength(1);
    expect(rewritten.errors[0]).toContain('sourceHandle "maybe"');
  });

  it("repairs a real model-authored flow end to end", async () => {
    const validation = validateAndNormalizeNodes([
      { id: "n1", type: "trigger", data: { type: "order_created", config: { store: "all" } } },
      {
        id: "n2",
        type: "condition",
        data: {
          type: "quick_order_status",
          config: { statusId: "6aa5ba0a-61b5-4a4f-87fb-c7fea5bac389", status: "New" },
        },
      },
      {
        id: "n3",
        type: "action",
        data: {
          type: "send_whatsapp_template",
          config: {
            templateId: "1cfd8f39-9fdb-4bbb-8177-c913bccbc1f5",
            templateName: "order_confirmation_en",
            templateData: {
              bodyText: "Hello",
              buttons: [
                { type: "VISIT_WEBSITE", text: "View Order" },
                { type: "CUSTOM", text: "Confirm Order" },
                { type: "CUSTOM", text: "Cancel Order" },
              ],
            },
            branches: [
              { id: "btn_1", label: "Confirm Order", condition: "button_click_1" },
              { id: "btn_2", label: "Cancel Order", condition: "button_click_2" },
            ],
          },
        },
      },
      {
        id: "n4",
        type: "action",
        data: {
          type: "send_whatsapp_message",
          config: {
            messageMode: "custom",
            messageType: "location_request",
            actionIntent: "location_request",
            branches: [],
            messageData: {
              type: "interactive",
              interactive: {
                type: "location_request_message",
                body: { text: "Send your location" },
                action: { name: "send_location" },
              },
            },
          },
        },
      },
      {
        id: "n5",
        type: "action",
        data: {
          type: "assign_order_to_employee",
          config: { employeeId: "4b29b79d-afe7-46ff-88a1-f10ce03c01b7", employeeName: "Mosa" },
        },
      },
      {
        id: "n6",
        type: "action",
        data: { type: "send_upsell", config: { noResponseMinutes: 1 } },
      },
      {
        id: "n7",
        type: "action",
        data: {
          type: "send_whatsapp_message",
          config: {
            messageMode: "custom",
            messageType: "text",
            messageData: { type: "text", text: { body: "Under review" } },
          },
        },
      },
    ]);
    expect(validation.errors).toEqual([]);

    const rewritten = rewriteEdgeHandles(
      [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3", sourceHandle: "yes" },
        { id: "e3", source: "n3", target: "n4", sourceHandle: "btn_1" },
        { id: "e4", source: "n4", target: "n5" },
        { id: "e5", source: "n5", target: "n6", sourceHandle: "assigned" },
        { id: "e6", source: "n6", target: "n7", sourceHandle: "accept" },
        { id: "e7", source: "n6", target: "n7", sourceHandle: "client_reject" },
        { id: "e8", source: "n6", target: "n7", sourceHandle: "reject" },
        { id: "e9", source: "n6", target: "n7", sourceHandle: "skipped" },
        { id: "e10", source: "n6", target: "n7", sourceHandle: "no_response" },
      ],
      validation.nodes,
      validation.previousBranches,
    );
    expect(rewritten.errors).toEqual([]);

    const byId = new Map(rewritten.edges.map((edge) => [edge.id, edge.sourceHandle]));
    expect(byId.get("e2")).toBe("true");
    expect(byId.get("e3")).toBe("btn_0");
    expect(byId.get("e4")).toBe("any_option");
    expect(byId.get("e5")).toBe("assigned");

    const config = validation.nodes[5].data.config as any;
    expect(config.branches.map((branch: any) => branch.id)).toEqual([
      "skipped",
      "reject",
      "accept",
      "client_reject",
      "no_response",
    ]);

    const parsed = await parseDto(CreateAutomationDto, {
      name: "Confirm order",
      triggerType: "order_created",
      flow: { nodes: validation.nodes, edges: rewritten.edges },
    });

    expect(parsed.ok).toBe(true);
  });
});
