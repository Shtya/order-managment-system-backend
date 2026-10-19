import { vi } from "vitest";

// Entities pull service files with circular imports; replace them with the
// real enum values (see accounting.tool.spec.ts for the same pattern).
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

import { buildAutomationStepsCatalog } from "./automation-steps.catalog";
import { buildBusinessMessageConfig, CUSTOM_MESSAGE_DATA } from "./automation-message-configs";

const step = (id: string) =>
  (buildAutomationStepsCatalog({ type: id }).steps as any[])
    .find((s) => s.id === id) as any;

const schema = (id: string) => step(id).configSchema as any;
const prop = (id: string, key: string) => schema(id).properties[key] as any;

describe("automation-steps.catalog (triggers)", () => {
  it("order_created emits a JSON Schema pointing at list_stores", () => {
    const config = schema("order_created");
    expect(config.type).toBe("object");
    expect(config.required).toEqual(["store"]);
    const storeId = prop("order_created", "storeId");
    expect(storeId.type).toBe("string");
    expect(storeId.lookupTool).toBe("list_stores");
    expect(storeId.literals).toEqual(["all"]);
    const store = prop("order_created", "store");
    expect(store.derived).toMatch(/list_stores/);
    expect(store.derived).toMatch(/"all"/);
  });

  it("shipment_created points at providerId, not the integration id", () => {
    const companyId = prop("shipment_created", "shippingCompanyId");
    expect(companyId.lookupTool).toBe("list_shipping_companies");
    expect(companyId.lookupNote).toMatch(/providerId/);
    expect(schema("shipment_created").required).toEqual(["shippingCompany"]);
  });

  it("shipment_updated exposes real shipment status codes", () => {
    const status = prop("shipment_updated", "shipmentStatus");
    expect(status.type).toBe("string");
    expect(status.enum).toContain("pending_action");
    expect(status.enum).toContain("out_for_delivery");
    expect(status.enum).toContain("returned_to_warehouse");
  });

  it("assignment_cancelled defaults to automatic and is optional", () => {
    const config = schema("assignment_cancelled");
    expect(prop("assignment_cancelled", "cancelSource").default).toBe("automatic");
    expect(config.required ?? []).not.toContain("cancelSource");
  });
});

describe("automation-steps.catalog (actions and conditions)", () => {
  it("ai_address_correction uses provider and agent lookups without hostedModelId", () => {
    expect(schema("ai_address_correction").properties).not.toHaveProperty("hostedModelId");
    expect(prop("ai_address_correction", "providerId").lookupTool).toBe("list_ai_providers");
    expect(prop("ai_address_correction", "agentId").lookupTool).toBe("list_agents");
    expect(prop("ai_address_correction", "updateWrittenAddress").default).toBe(true);
  });

  it("create_issue requires title and role and points employees at the employee lookup", () => {
    const config = schema("create_issue");
    expect(config.required).toEqual(["title", "assignedRoleId"]);
    expect(prop("create_issue", "causeId").lookupTool).toBe("issues_lookups_list");
    expect(prop("create_issue", "employeeIds").items.lookupTool).toBe("list_employees");
  });

  it("wait requires a positive bounded waitMinutes", () => {
    const config = schema("wait");
    expect(config.required).toEqual(["waitMinutes"]);
    expect(prop("wait", "waitMinutes").minimum).toBe(1);
    expect(prop("wait", "waitMinutes").maximum).toBe(7 * 24 * 60);
  });

  it("order_check describes check items and operator enum", () => {
    const checks = prop("order_check", "checks");
    expect(checks.minItems).toBe(1);
    expect(checks.maxItems).toBe(20);
    expect(checks.items.required).toEqual(["field", "fieldLabel", "operator", "targetValue"]);
    expect(checks.items.properties.operator.enum).toContain("contains");
  });

  it("send_whatsapp_template copies the template snapshot and variable shape", () => {
    const config = schema("send_whatsapp_template");
    expect(config.required).toEqual(["templateId", "templateName", "templateData"]);
    expect(prop("send_whatsapp_template", "templateId").lookupTool).toBe("whatsapp_templates_search");
    expect(prop("send_whatsapp_template", "templateData").properties.bodyText.type).toBe("string");
    const body = prop("send_whatsapp_template", "bodyVariables");
    expect(body.additionalProperties.properties.type.enum).toEqual(["direct", "variable"]);
    expect(prop("send_whatsapp_template", "locationData").properties.latitude.type).toContain("number");
  });

  it("send_whatsapp_message exposes every custom type plus business use cases", () => {
    const config = schema("send_whatsapp_message");
    expect(config.anyOf).toHaveLength(2);
    const custom = config.anyOf[0];
    const business = config.anyOf[1];
    expect(custom.properties.messageType.enum).toEqual([
      "text",
      "image",
      "document",
      "video",
      "location",
      "contact",
      "list",
      "interactive",
      "location_request",
    ]);
    expect(custom.properties.messageData.anyOf).toHaveLength(9);
    expect(business.properties.businessUseCase.enum).toEqual([
      "order_postpone_date",
      "order_discount_offer",
      "order_payment_method",
      "order_cancel_cause",
    ]);
    expect(business.properties).not.toHaveProperty("messageData");
  });

  it("requires a real media source for image, video, and document messages", () => {
    expect(CUSTOM_MESSAGE_DATA.safeParse({ type: "image", image: {} }).success).toBe(false);
    expect(CUSTOM_MESSAGE_DATA.safeParse({ type: "video", video: { id: "video_123" }, caption: "Hi" }).success).toBe(true);
    expect(CUSTOM_MESSAGE_DATA.safeParse({ type: "document", document: { url: "https://example.com/file.pdf" } }).success).toBe(true);
  });

  it("builds the postpone business message rows and command", () => {
    const config: any = buildBusinessMessageConfig({
      messageMode: "business",
      businessUseCase: "order_postpone_date",
      businessConfig: { daysCount: 2, dateFormat: "YYYY-MM-DD", excludeWeekends: true },
    });
    expect(config.businessCommand).toBe("order.set_postponed_date");
    expect(config.messageType).toBe("list");
    const rows = config.messageData.interactive.action.sections[0].rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("{{global.date.1.YYYY-MM-DD}}");
    expect(rows[0].id).toBe("__date_{{global.date.1.DD-MM-YYYY}}__");
  });

  it("builds cancel-cause, discount, and payment business messages", () => {
    const cancel: any = buildBusinessMessageConfig({
      messageMode: "business",
      businessUseCase: "order_cancel_cause",
      businessConfig: { cancelCauses: [{ id: "11111111-1111-1111-1111-111111111111", name: "Too expensive" }] },
    });
    expect(cancel.messageData.interactive.action.sections[0].rows[0].id).toContain("__cancel_cause_");
    const discount: any = buildBusinessMessageConfig({
      messageMode: "business",
      businessUseCase: "order_discount_offer",
      businessConfig: { discountValue: 15, discountType: "percentage" },
    });
    expect(discount.messageData.interactive.body.text).toBe("Get 15% off your order!");
    const payment: any = buildBusinessMessageConfig({
      messageMode: "business",
      businessUseCase: "order_payment_method",
    });
    expect(payment.messageData.interactive.action.buttons).toHaveLength(3);
    expect(payment.businessCommand).toBe("order.set_payment_method");
  });

  it("appends the no-response branch to business branches", () => {
    const config: any = buildBusinessMessageConfig({
      messageMode: "business",
      businessUseCase: "order_payment_method",
      noResponseMinutes: 60,
    });
    expect(config.branches.at(-1)).toMatchObject({ id: "no_response", isNoResponse: true, timeoutMinutes: 60 });
  });

  it("no longer lists the SMS step", () => {
    const ids = (buildAutomationStepsCatalog().steps as any[]).map((s) => s.id);
    expect(ids).not.toContain("send_sms");
  });
});

describe("automation-steps.catalog (definitions and placeholders)", () => {
  it("returns the automation definition, step-kind meanings, and statuses", () => {
    const definitions = buildAutomationStepsCatalog().definitions as any;
    expect(definitions.automation.what).toMatch(/automation|flow/i);
    expect(definitions.automation.stepKinds.map((k: any) => k.kind)).toEqual([
      "trigger",
      "action",
      "condition",
    ]);
    expect(definitions.automation.stepKinds[0].meaning).toMatch(/exactly one trigger/);
    expect(definitions.automation.statuses.map((s: any) => s.status)).toEqual([
      "draft",
      "published",
      "paused",
      "archived",
    ]);
  });

  it("returns the placeholder definition once, not on every field", () => {
    const placeholders = (buildAutomationStepsCatalog().definitions as any).placeholders;
    expect(placeholders.syntax).toBe("{{<path>}}");
    expect(placeholders.example).toContain("{{customerName}}");
    expect(placeholders.whenUsed).toMatch(/supportsPlaceholders/);
    expect(placeholders.orderPaths).toContain("customerName");
    expect(placeholders.orderPaths).toContain("items[0].lineTotal");
    expect(placeholders.orderPaths).toContain("items[-1].variant.sku");
    expect(placeholders.globalPaths).toContain("global.brandName");
    expect(placeholders.datePath).toBe("global.date.<offset>.<format>");
    expect(placeholders.orderPaths.some((p: string) => p.startsWith("order."))).toBe(false);

    const title = prop("create_issue", "title");
    expect(title.supportsPlaceholders).toBe(true);
    expect(title).not.toHaveProperty("placeholders");
    expect(prop("create_issue", "description").supportsPlaceholders).toBe(true);
  });

  it("returns definitions even when the steps are filtered", () => {
    const catalog = buildAutomationStepsCatalog({ kind: "condition" });
    expect((catalog.definitions as any).placeholders.orderPaths).toContain("customerName");
    expect((catalog.steps as any[]).every((s) => s.kind === "condition")).toBe(true);
  });

  it("marks the custom-message text, caption, and row fields", () => {
    const custom = schema("send_whatsapp_message").anyOf[0];
    const text = custom.properties.messageData.anyOf[0].properties.text.properties.body;
    expect(text.supportsPlaceholders).toBe(true);
    expect(text).not.toHaveProperty("placeholders");
    const image = custom.properties.messageData.anyOf[1].properties;
    expect(image.caption.supportsPlaceholders).toBe(true);
    const list = custom.properties.messageData.anyOf
      .map((entry: any) => entry.properties.interactive)
      .find((entry: any) => entry?.properties.action.properties.sections);
    expect(list.properties.body.properties.text.supportsPlaceholders).toBe(true);
    const row = list.properties.action.properties.sections.items.properties.rows.items.properties;
    expect(row.title.supportsPlaceholders).toBe(true);
    expect(row.description.supportsPlaceholders).toBe(true);
  });

  it("marks the template variable path field as a raw path", () => {
    const body = prop("send_whatsapp_template", "bodyVariables");
    const variablePath = body.additionalProperties.properties.variablePath;
    expect(variablePath.placeholderPath).toBe(true);
    expect(variablePath).not.toHaveProperty("paths");
  });
});

describe("automation-steps.catalog (plain English)", () => {
  it("emits literal titles and labels with no lang or i18n keys", () => {
    const catalog = buildAutomationStepsCatalog();
    expect(catalog).not.toHaveProperty("lang");
    const created = (catalog.steps as any[]).find((s) => s.id === "order_created") as any;
    expect(created.title).toBe("New Order Created");
    expect(created.category).toBe("Internal System");
    expect(created.configSchema.properties.storeId.label).toBe("Store");
    expect(JSON.stringify(catalog)).not.toMatch(/builder\.|chats\.|orders\.|clientTags\./);
  });

  it("keeps lookup schema for order-check fields", () => {
    const catalog = buildAutomationStepsCatalog({ kind: "condition" });
    const fields = catalog.orderCheckFields as any[];
    const company = fields.find((f) => f.id === "shippingCompany");
    expect(company.lookup).toBe("list_shipping_companies");
    expect(company.label).toBe("Shipping Company");
    const percent = fields.find((f) => f.id === "client.confirmedPercent");
    expect(percent.from).toBe("of total orders");
    expect(percent.group).toBe("Customer statistics");
    expect(company.group).toBe("Order Data");
    const discount = fields.find((f) => f.id === "discount");
    expect(discount.valueType).toBe("number");
    expect(discount.operators.map((o: any) => o.id)).toEqual(["==", "!=", ">", "<", ">=", "<="]);
  });
});

describe("automation-steps.catalog (branches)", () => {
  const branching = [
    "assign_order_to_employee",
    "ai_address_correction",
    "assign_shipping_provider",
    "send_whatsapp_template",
    "send_whatsapp_message",
    "send_upsell",
    "order_check",
    "quick_order_status",
    "ai_address_completeness",
  ];

  it("describes every static branch with its sourceHandle", () => {
    for (const id of branching) {
      const spec = step(id);
      expect(spec.branching).toBe(true);
      expect((spec.branches ?? []).length).toBeGreaterThan(0);
      for (const branch of spec.branches) {
        expect(branch.sourceHandle).toBe(branch.id);
        expect(branch.label).toEqual(expect.any(String));
        expect(branch.description).toEqual(expect.any(String));
        expect(branch.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("documents the server-injected branch contract", () => {
    const definition = (buildAutomationStepsCatalog().definitions as any).automation;
    expect(definition.branches).toMatch(/dynamicBranches/);
    expect(definition.branches).toMatch(/sourceHandle/);
    expect(definition.branches).toMatch(/Do NOT write config\.branches/);
  });

  it("describes template dynamic branches as CUSTOM-only", () => {
    const template = step("send_whatsapp_template");
    expect(template.branches.map((b: any) => b.id)).toEqual(["no_response"]);
    const dynamic = template.dynamicBranches[0];
    expect(dynamic.idPattern).toBe("btn_<index>");
    expect(dynamic.sourceHandlePattern).toBe("btn_<index>");
    expect(dynamic.conditionPattern).toBe("button_click_<index>");
    expect(dynamic.description).toMatch(/CUSTOM/);
    expect(dynamic.example).toMatchObject({
      id: "btn_0",
      sourceHandle: "btn_0",
      condition: "button_click_0",
    });
  });

  it("describes message conditional and dynamic branches", () => {
    const message = step("send_whatsapp_message");
    expect(message.branches.map((b: any) => b.id)).toEqual(["any_option", "no_response"]);
    const anyOption = message.branches.find((b: any) => b.id === "any_option");
    expect(anyOption.when).toMatch(/list|location_request/);
    expect(message.dynamicBranches[0].idPattern).toBe("<button.reply.id>");
    expect(message.dynamicBranches[1].when).toMatch(/business/);
  });

  it("marks no_response as conditional on noResponseMinutes with no condition", () => {
    const noResponse = step("send_upsell").branches.find((b: any) => b.id === "no_response") as any;
    expect(noResponse.when).toMatch(/noResponseMinutes/);
    expect(noResponse.condition).toBeUndefined();
  });

  it("keeps condition handles true/false with descriptions", () => {
    expect(step("order_check").branches.map((b: any) => b.id)).toEqual(["true", "false"]);
    expect(step("quick_order_status").branches[0].description).toMatch(/status/i);
    expect(step("order_check").branches[0].description).toMatch(/check/i);
  });
});

describe("automation-steps.catalog (custom message shapes match the frontend forms)", () => {
  const custom = () => schema("send_whatsapp_message").anyOf[0];
  const data = (type: string) =>
    custom().properties.messageData.anyOf.find(
      (entry: any) => entry.properties.type.const === type,
    ).properties;

  const interactive = (subtype: string) =>
    custom()
      .properties.messageData.anyOf.filter(
        (entry: any) => entry.properties.type?.const === "interactive",
      )
      .map((entry: any) => entry.properties.interactive)
      .find((entry: any) => entry.properties?.type?.const === subtype).properties;

  it("uses text.body for text messages and interactive.body.text for interactive", () => {
    expect(data("text").text.required).toEqual(["body"]);
    for (const subtype of ["list", "button", "location_request_message"]) {
      expect(interactive(subtype).body.required).toEqual(["text"]);
    }
  });

  it("requires the location name and address the form requires", () => {
    const location = data("location").location;
    expect(location.required).toEqual(["latitude", "longitude", "name", "address"]);
  });

  it("requires a contact name and phone and allows the MOBILE phone type", () => {
    const contact = data("contacts").contacts.items;
    expect(contact.required).toContain("name");
    expect(contact.required).toContain("phones");
    expect(contact.properties.name.required).toEqual([
      "first_name",
      "last_name",
      "formatted_name",
    ]);
    expect(contact.properties.phones.items.required).toEqual(["phone"]);
    expect(contact.properties.phones.items.properties.type.enum).toContain("MOBILE");
  });

  it("requires a list section title and a reply button title", () => {
    expect(interactive("list").action.properties.sections.items.required).toContain("title");
    expect(
      interactive("button").action.properties.buttons.items.properties.reply.required,
    ).toContain("title");
  });

  it("accepts the frontend isCatchAll branch flag", () => {
    expect(custom().properties.branches.items.properties.isCatchAll).toBeDefined();
  });
});
