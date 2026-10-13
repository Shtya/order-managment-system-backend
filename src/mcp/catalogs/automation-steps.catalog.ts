import { Language } from "entities/clientSettings.entity";
import { AUTOMATION_BUILDER_I18N } from "./automation-builder.i18n";
import { ref, shippingCompanyIdDescription, TOOL, ToolName } from "../utils/mcp-tool-names";
import { ActionType, ConditionType, TriggerType } from "entities/automation.entity";

/** Register lookup tools at import so the boot check sees them. */
const CATALOG_LOOKUPS: ToolName[] = [
  TOOL.stores.list,
  TOOL.orderStatuses.list,
  TOOL.shippingCompanies.list,
  TOOL.whatsapp.templatesSearch,
  TOOL.whatsapp.accountsSearch,
  TOOL.employees.list,
  TOOL.cancelCauses.list,
  TOOL.issues.lookupsList,
  TOOL.roles.list,
  TOOL.cities.list,
  TOOL.campaigns.search,
  TOOL.upsells.search,
];
CATALOG_LOOKUPS.forEach((name) => ref(name));

const MAX_WAIT_MINUTES = 7 * 24 * 60;

type StepKind = "trigger" | "action" | "condition";

type FieldDef = {
  key: string;
  type: "uuid" | "string" | "number" | "boolean" | "enum" | "object" | "array";
  required?: boolean;
  optional?: boolean;
  labelKey?: string;
  descKey?: string;
  lookup?: ToolName;
  lookupNote?: string;
  enumValues?: { value: string; labelKey: string }[];
  min?: number;
  max?: number;
  notes?: string;
};

type BranchDef = { id: string; condition: string; labelKey: string; optional?: boolean };

type StepDef = {
  id: TriggerType | ConditionType | ActionType;
  kind: StepKind;
  category: "internal" | "logic";
  titleKey: string;
  descKey?: string;
  entity?: string;
  restricted?: boolean;
  superAdminNoEdit?: boolean;
  configComponent: string;
  fields: FieldDef[];
  branches?: BranchDef[];
  extra?: Record<string, unknown>;
};

function t(dict: any, path: string, vars?: Record<string, string | number>): string {
  const raw = path.split(".").reduce((o: any, k) => (o == null ? o : o[k]), dict);
  if (typeof raw !== "string") return path;
  let s = raw.replace(/<\/?[^>]+>/g, "");
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (_m, k: string) =>
      vars[k] === undefined || vars[k] === null ? `{${k}}` : String(vars[k]),
    );
  }
  return s;
}

const CHECK_ORDER_FIELDS: { id: string; valueType: string; labelKey: string; lookup?: ToolName }[] = [
  { id: "orderNumber", valueType: "string", labelKey: "builder.orderProperties.orderNumber" },
  { id: "shippingCompany", valueType: "select", labelKey: "builder.orderProperties.shippingCompany", lookup: TOOL.shippingCompanies.list },
  { id: "hasActiveShipment", valueType: "boolean", labelKey: "builder.orderProperties.hasActiveShipment" },
  { id: "paymentStatus", valueType: "select", labelKey: "builder.orderProperties.paymentStatus" },
  { id: "productsTotal", valueType: "number", labelKey: "builder.orderProperties.productsTotal" },
  { id: "items_count", valueType: "number", labelKey: "builder.orderProperties.items" },
  { id: "paymentMethod", valueType: "select", labelKey: "builder.orderProperties.paymentMethod" },
  { id: "cityId", valueType: "select", labelKey: "builder.orderProperties.city", lookup: TOOL.cities.list },
  { id: "lastCancelCauseId", valueType: "select", labelKey: "builder.orderProperties.lastCancelCause", lookup: TOOL.cancelCauses.list },
  { id: "discount", valueType: "string", labelKey: "builder.orderProperties.discount" },
  { id: "additionalFees", valueType: "number", labelKey: "builder.orderProperties.additionalFees" },
  { id: "status", valueType: "select", labelKey: "builder.orderProperties.status", lookup: TOOL.orderStatuses.list },
  { id: "allowOpenPackage", valueType: "boolean", labelKey: "builder.orderProperties.allowOpenPackage" },
  { id: "isReplacement", valueType: "boolean", labelKey: "builder.orderProperties.isReplacement" },
  { id: "campaignId", valueType: "boolean", labelKey: "builder.orderProperties.fromCampaign" },
  { id: "hasEnoughStock", valueType: "boolean", labelKey: "builder.orderProperties.hasEnoughStock" },
  { id: "deposit", valueType: "number", labelKey: "builder.orderProperties.deposit" },
];

const CLIENT_CHECK_FIELDS = [
  "client.totalOrders",
  "client.confirmedCount",
  "client.confirmedPercent",
  "client.confirmedRate",
  "client.shippedCount",
  "client.shippedPercent",
  "client.deliveredCount",
  "client.deliveredPercent",
  "client.returnedCount",
  "client.returnedPercent",
  "client.cancelledCount",
  "client.cancelRate",
  "client.cancelledBeforeShippingCount",
  "client.beforeShippingCancelRate",
  "client.cancelledAfterShippingCount",
  "client.afterShippingCancelRate",
  "client.afterShippingCancelRateOfShipped",
  "client.totalSales",
  "client.deliveredRevenue",
];

const CLIENT_PERCENT_FROM: Record<string, string> = {
  "client.confirmedPercent": "totalOrders",
  "client.confirmedRate": "totalOrders",
  "client.shippedPercent": "totalOrders",
  "client.deliveredPercent": "totalOrders",
  "client.returnedPercent": "totalOrders",
  "client.cancelRate": "totalOrders",
  "client.beforeShippingCancelRate": "totalOrders",
  "client.afterShippingCancelRate": "totalOrders",
  "client.afterShippingCancelRateOfShipped": "shippedOrders",
};

const STEPS: StepDef[] = [
  {
    id: TriggerType.ORDER_CREATED,
    kind: "trigger",
    category: "internal",
    titleKey: "builder.triggerTypes.order_created",
    entity: "order",
    superAdminNoEdit: true,
    configComponent: "OrderCreatedConfig",
    fields: [
      { key: "storeId", type: "uuid", optional: true, labelKey: "builder.config.store", descKey: "builder.config.storeDesc", lookup: TOOL.stores.list, notes: "Omit with store=all to watch every store." },
      { key: "store", type: "string", required: true, labelKey: "builder.config.store", notes: "Store name, or all." },
    ],
  },
  {
    id: TriggerType.ORDER_UPDATED,
    kind: "trigger",
    category: "internal",
    titleKey: "builder.triggerTypes.order_updated",
    entity: "order",
    configComponent: "OrderStatusUpdatedConfig",
    fields: [
      { key: "statusId", type: "uuid", required: true, labelKey: "builder.config.targetStatus", descKey: "builder.config.targetStatusDesc", lookup: TOOL.orderStatuses.list },
      { key: "status", type: "string", labelKey: "builder.config.status", notes: "Display name copied from the selected status." },
    ],
  },
  {
    id: TriggerType.SHIPMENT_CREATED,
    kind: "trigger",
    category: "internal",
    titleKey: "builder.triggerTypes.shipment_created",
    entity: "order",
    superAdminNoEdit: true,
    configComponent: "ShipmentCreatedConfig",
    fields: [
      { key: "shippingCompanyId", type: "uuid", optional: true, labelKey: "builder.config.shippingCompany", descKey: "builder.config.shippingCompanyDesc", lookup: TOOL.shippingCompanies.list, lookupNote: shippingCompanyIdDescription("Shipping company id."), notes: "Use providerId. Omit with shippingCompany=all." },
      { key: "shippingCompany", type: "string", required: true, labelKey: "builder.config.shippingCompany", notes: "Company name, or all." },
    ],
  },
  {
    id: TriggerType.SHIPMENT_UPDATED,
    kind: "trigger",
    category: "internal",
    titleKey: "builder.triggerTypes.shipment_updated",
    entity: "order",
    configComponent: "ShipmentStatusUpdatedConfig",
    fields: [
      { key: "shipmentStatus", type: "string", required: true, labelKey: "builder.config.targetShipmentStatus", descKey: "builder.config.targetShipmentStatusDesc", notes: "Shipping status code from the workspace shipping statuses list. No dedicated MCP lookup." },
    ],
  },
  {
    id: TriggerType.ASSIGNMENT_CANCELLED,
    kind: "trigger",
    category: "internal",
    titleKey: "builder.triggerTypes.assignment_cancelled",
    entity: "order",
    configComponent: "AssignmentCancelledConfig",
    fields: [
      {
        key: "cancelSource",
        type: "enum",
        optional: true,
        labelKey: "builder.config.assignmentCancelSource",
        descKey: "builder.config.assignmentCancelSourceDesc",
        enumValues: [
          { value: "automatic", labelKey: "builder.config.assignmentCancelAutomatic" },
          { value: "manual", labelKey: "builder.config.assignmentCancelManual" },
          { value: "both", labelKey: "builder.config.assignmentCancelBoth" },
        ],
        notes: "Default automatic.",
      },
    ],
  },
  {
    id: ActionType.UPDATE_ORDER_STATUS,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.update_order_status",
    descKey: "builder.config.changeStatusToDesc",
    configComponent: "UpdateOrderStatusConfig",
    fields: [
      { key: "newStatusId", type: "uuid", required: true, labelKey: "builder.config.newStatus", descKey: "builder.config.newStatusDesc", lookup: TOOL.orderStatuses.list },
      { key: "newStatus", type: "string", required: true, labelKey: "builder.config.newStatus" },
      { key: "cancelCauseId", type: "uuid", optional: true, labelKey: "builder.config.cancelCause", descKey: "builder.config.cancelCauseDesc", lookup: TOOL.cancelCauses.list, notes: "Required when the new status code is cancelled." },
      { key: "cancelCauseName", type: "string", optional: true, labelKey: "builder.config.cancelCause" },
    ],
  },
  {
    id: ActionType.ASSIGN_ORDER_TO_EMPLOYEE,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.assign_order_to_employee",
    descKey: "builder.config.assignOrderToEmployeeDesc",
    configComponent: "AssignOrderToEmployeeConfig",
    fields: [
      { key: "employeeId", type: "uuid", optional: true, labelKey: "builder.config.selectEmployee", descKey: "builder.config.selectEmployeeDesc", lookup: TOOL.employees.list, notes: "Empty = auto assign." },
      { key: "employeeName", type: "string", optional: true, labelKey: "builder.config.selectEmployee" },
    ],
    branches: [
      { id: "assigned", condition: "assigned", labelKey: "builder.nodes.branches.assigned" },
      { id: "no_roles_match", condition: "no_roles_match", labelKey: "builder.nodes.branches.noRolesMatch", optional: true },
      { id: "not_eligable", condition: "not_eligable", labelKey: "builder.nodes.branches.notEligible" },
    ],
  },
  {
    id: ActionType.AI_ADDRESS_CORRECTION,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.ai_address_correction",
    descKey: "builder.config.aiAddressCorrectionDesc",
    restricted: true,
    configComponent: "AiAddressCorrectionConfig",
    fields: [
      {
        key: "aiSource",
        type: "enum",
        optional: true,
        labelKey: "builder.config.aiSource",
        enumValues: [
          { value: "hosted", labelKey: "builder.config.aiSourceHosted" },
          { value: "tenant", labelKey: "builder.config.aiSourceTenant" },
        ],
      },
      { key: "hostedModelId", type: "string", optional: true, labelKey: "builder.config.aiModel", descKey: "builder.config.aiModelDesc" },
      { key: "providerId", type: "uuid", optional: true, labelKey: "builder.config.aiProvider", descKey: "builder.config.aiProviderOptionalDesc", notes: "Tenant source only. Empty = automatic among connected providers." },
      { key: "shippingCompanyId", type: "uuid", optional: true, labelKey: "builder.config.aiAddressShippingCompanyLabel", descKey: "builder.config.aiAddressShippingCompanyDesc", lookup: TOOL.shippingCompanies.list, lookupNote: shippingCompanyIdDescription("Optional shipping company id."), notes: "Empty = automatic." },
      { key: "updateWrittenAddress", type: "boolean", optional: true, labelKey: "builder.config.updateWrittenAddress", descKey: "builder.config.updateWrittenAddressDesc", notes: "Default true." },
      { key: "agentId", type: "uuid", optional: true, labelKey: "builder.config.aiAddressCorrectionAgent", descKey: "builder.config.aiAddressCorrectionAgentDesc" },
      { key: "useWhatsappAccountAgent", type: "boolean", optional: true, labelKey: "builder.config.aiAddressCorrectionAgentDefault" },
    ],
    branches: [
      { id: "address_corrected", condition: "address_corrected", labelKey: "builder.nodes.branches.addressCorrected" },
      { id: "address_not_corrected", condition: "address_not_corrected", labelKey: "builder.nodes.branches.addressNotCorrected" },
    ],
  },
  {
    id: ActionType.ASSIGN_SHIPPING_PROVIDER,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.assign_shipping_provider",
    descKey: "builder.config.assignShippingProviderDesc",
    restricted: true,
    configComponent: "AssignShippingProviderConfig",
    fields: [
      { key: "useSpecialShippingCompany", type: "boolean", optional: true, labelKey: "builder.config.useSpecialShippingCompany", descKey: "builder.config.useSpecialShippingCompanyDesc", notes: "Default false: use the company AI assigned." },
      { key: "shippingCompanyId", type: "uuid", optional: true, labelKey: "builder.config.shippingCompany", descKey: "builder.config.shippingCompanyAssignDesc", lookup: TOOL.shippingCompanies.list, lookupNote: shippingCompanyIdDescription("Shipping company id."), notes: "Required only when useSpecialShippingCompany is true. Use providerId." },
      { key: "shippingCompany", type: "string", optional: true, labelKey: "builder.config.shippingCompany" },
      { key: "provider", type: "string", optional: true, labelKey: "builder.config.provider" },
    ],
    branches: [
      { id: "distributed", condition: "distributed", labelKey: "builder.nodes.branches.distributed" },
      { id: "failed_to_distribute", condition: "failed_to_distribute", labelKey: "builder.nodes.branches.failedToDistribute" },
    ],
  },
  {
    id: ActionType.SEND_WHATSAPP_TEMPLATE,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.send_whatsapp_template",
    descKey: "builder.config.whatsappTemplateDesc",
    configComponent: "SendWhatsappTemplateConfig",
    fields: [
      { key: "templateId", type: "uuid", required: true, labelKey: "builder.config.template", descKey: "builder.config.templateDesc", lookup: TOOL.whatsapp.templatesSearch },
      { key: "templateName", type: "string", labelKey: "builder.config.template" },
      { key: "recipientNumber", type: "string", optional: true, labelKey: "builder.config.recipientNumber", descKey: "builder.config.recipientNumberDesc" },
      { key: "templateData", type: "object", labelKey: "builder.config.template", notes: "Approved template snapshot (header/body/buttons). Not binary." },
      { key: "bodyVariables", type: "object", optional: true, labelKey: "builder.config.variables", descKey: "builder.config.fillVariablesDesc" },
      { key: "headerVariables", type: "object", optional: true, labelKey: "builder.config.messageHeader" },
      { key: "buttonVariables", type: "object", optional: true, labelKey: "builder.config.linkButtons" },
      { key: "useOrderFirstItemImage", type: "boolean", optional: true, labelKey: "builder.config.useOrderFirstItemImage", descKey: "builder.config.useOrderFirstItemImageNote" },
      { key: "locationData", type: "object", optional: true, labelKey: "builder.config.locationHeader" },
      { key: "noResponseMinutes", type: "number", optional: true, labelKey: "builder.config.noResponseMinutes", descKey: "builder.config.noResponseDesc", min: 1, max: MAX_WAIT_MINUTES },
    ],
    branches: [
      { id: "no_response", condition: "no_response", labelKey: "builder.config.noResponseBranchLabel", optional: true },
    ],
    extra: { branchesFrom: "CUSTOM template buttons become sourceHandle branches (button_click_N)." },
  },
  {
    id: ActionType.SEND_WHATSAPP_MESSAGE,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.send_whatsapp_message",
    descKey: "builder.config.whatsappMessageDesc",
    configComponent: "SendWhatsappMessageConfig",
    fields: [
      { key: "messageMode", type: "enum", required: true, labelKey: "builder.nodes.messageType", enumValues: [
        { value: "custom", labelKey: "chats.messageModes.custom" },
        { value: "business", labelKey: "chats.messageModes.business" },
      ] },
      { key: "messageType", type: "enum", required: true, labelKey: "builder.nodes.messageType", enumValues: [
        { value: "text", labelKey: "chats.messageTypes.text" },
        { value: "image", labelKey: "chats.messageTypes.image" },
        { value: "video", labelKey: "chats.messageTypes.video" },
        { value: "document", labelKey: "chats.messageTypes.document" },
        { value: "location", labelKey: "chats.messageTypes.location" },
        { value: "contact", labelKey: "chats.messageTypes.contact" },
        { value: "list", labelKey: "chats.messageTypes.list" },
        { value: "interactive", labelKey: "chats.messageTypes.interactive" },
        { value: "location_request", labelKey: "chats.messageTypes.location_request" },
      ] },
      { key: "messageData", type: "object", required: true, labelKey: "builder.config.messageBody", notes: "WhatsApp payload for the chosen type. No media bytes." },
      { key: "recipientNumber", type: "string", optional: true, labelKey: "builder.config.recipientNumber", descKey: "builder.config.recipientNumberDesc2" },
      { key: "businessUseCase", type: "enum", optional: true, labelKey: "chats.messageModes.business", enumValues: [
        { value: "orderPostponeDate", labelKey: "chats.businessMessages.orderPostponeDate" },
        { value: "offerDiscount", labelKey: "chats.businessMessages.offerDiscount" },
        { value: "paymentMethod", labelKey: "chats.businessMessages.paymentMethod" },
        { value: "orderCancelCause", labelKey: "chats.businessMessages.orderCancelCause" },
        { value: "confirmOrder", labelKey: "chats.businessMessages.confirmOrder" },
      ] },
      { key: "businessConfig", type: "object", optional: true, labelKey: "chats.businessMessages.businessConfigTitle" },
      { key: "noResponseMinutes", type: "number", optional: true, labelKey: "builder.config.noResponseMinutes", descKey: "builder.config.noResponseDesc", min: 1, max: MAX_WAIT_MINUTES },
    ],
    branches: [
      { id: "no_response", condition: "no_response", labelKey: "builder.config.noResponseBranchLabel", optional: true },
    ],
    extra: { flowWhatsapp: "The sending number is the flow WhatsApp setting, not a per-step account." },
  },
  {
    id: ActionType.ASSIGN_ORDER_TO_CLIENT,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.assign_order_to_client",
    descKey: "builder.config.assignOrderToClientDesc",
    configComponent: "AssignOrderToClientConfig",
    fields: [
      { key: "createIfMissing", type: "boolean", optional: true, labelKey: "builder.config.createClientIfMissing", descKey: "builder.config.createClientIfMissingDesc" },
    ],
  },
  {
    id: ActionType.SEND_SMS,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.send_sms",
    configComponent: "SendSmsConfig",
    fields: [
      { key: "toNumber", type: "string", optional: true, labelKey: "builder.config.recipientNumber", descKey: "builder.config.recipientNumberDesc", notes: "Empty uses the order phone. May include order-property tokens." },
      { key: "message", type: "string", required: true, labelKey: "builder.config.messageBody" },
      { key: "integrationId", type: "uuid", optional: true, labelKey: "builder.nodes.provider" },
      { key: "senderId", type: "string", optional: true, labelKey: "builder.nodes.account" },
    ],
    branches: [
      { id: "sent", condition: "sent", labelKey: "builder.nodes.branches.sent" },
      { id: "failed", condition: "failed", labelKey: "builder.nodes.branches.failed" },
    ],
  },
    {
    id: ActionType.SEND_UPSELL,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.send_upsell",
    configComponent: "SendUpsellConfig",
    fields: [
      { key: "noResponseMinutes", type: "number", optional: true, labelKey: "builder.config.noResponseMinutes", descKey: "builder.config.noResponseDesc", min: 1, max: MAX_WAIT_MINUTES },
    ],
    branches: [
      { id: "skipped", condition: "skipped", labelKey: "builder.config.upsell.none" },
      { id: "reject", condition: "reject", labelKey: "builder.config.upsell.system_reject" },
      { id: "accept", condition: "accept", labelKey: "builder.config.upsell.accept" },
      { id: "client_reject", condition: "client_reject", labelKey: "builder.config.upsell.client_reject" },
      { id: "no_response", condition: "no_response", labelKey: "builder.config.noResponseBranchLabel", optional: true },
    ],
    extra: { note: `Offer catalog is on ${TOOL.upsells.search}. This step only waits for the customer response.` },
  },
  {
    id: ActionType.CREATE_ISSUE,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.create_issue",
    configComponent: "CreateIssueConfig",
    fields: [
      { key: "title", type: "string", required: true, notes: "Issue title. May include order-property tokens." },
      { key: "description", type: "string", optional: true, notes: "Issue description. May include order-property tokens." },
      { key: "causeId", type: "uuid", optional: true, lookup: TOOL.issues.lookupsList, notes: "kind=cause." },
      { key: "priority", type: "enum", optional: true, labelKey: "builder.nodes.priority", notes: "low | medium | high | urgent. Default medium." },
      { key: "statusId", type: "uuid", optional: true, lookup: TOOL.issues.lookupsList, notes: "kind=status. Defaults to open." },
      { key: "assignedRoleId", type: "uuid", required: true, lookup: TOOL.roles.list },
      { key: "employeeIds", type: "array", optional: true, lookup: TOOL.employees.list },
      { key: "estimatedMinutes", type: "number", optional: true, min: 1 },
    ],
  },
  {
    id: ActionType.WAIT,
    kind: "action",
    category: "internal",
    titleKey: "builder.actionTypes.wait",
    descKey: "builder.config.waitMinutesDesc",
    configComponent: "WaitConfig",
    fields: [
      { key: "waitMinutes", type: "number", required: true, labelKey: "builder.config.waitMinutes", descKey: "builder.config.waitMinutesDesc", min: 1, max: MAX_WAIT_MINUTES },
    ],
  },
  {
    id: ConditionType.ORDER_CHECK,
    kind: "condition",
    category: "logic",
    titleKey: "builder.conditionTypes.order_check",
    descKey: "builder.config.orderCheckDesc",
    configComponent: "OrderCheckConfig",
    fields: [
      { key: "checks", type: "array", required: true, labelKey: "builder.config.checks", notes: "1–20 items. Each: field, fieldLabel, operator, targetValue, optional targetLabel. Operators depend on the field valueType." },
    ],
    branches: [
      { id: "yes", condition: "yes", labelKey: "builder.config.yes" },
      { id: "no", condition: "no", labelKey: "builder.config.no" },
    ],
  },
  {
    id: ConditionType.QUICK_ORDER_STATUS,
    kind: "condition",
    category: "logic",
    titleKey: "builder.conditionTypes.quick_order_status",
    descKey: "builder.config.quickCheckDesc",
    configComponent: "QuickOrderStatusConfig",
    fields: [
      { key: "statusId", type: "uuid", required: true, labelKey: "builder.config.status", descKey: "builder.config.statusDesc", lookup: TOOL.orderStatuses.list },
      { key: "status", type: "string", required: true, labelKey: "builder.config.status" },
    ],
    branches: [
      { id: "yes", condition: "yes", labelKey: "builder.config.yes" },
      { id: "no", condition: "no", labelKey: "builder.config.no" },
    ],
  },
  {
    id: ConditionType.AI_ADDRESS_COMPLETENESS,
    kind: "condition",
    category: "logic",
    titleKey: "builder.conditionTypes.ai_address_completeness",
    descKey: "builder.config.aiAddressCompletenessDesc",
    restricted: true,
    configComponent: "AiAddressCompletenessConfig",
    fields: [],
    branches: [
      { id: "valid", condition: "valid", labelKey: "builder.nodes.branches.addressValid" },
      { id: "not_valid", condition: "not_valid", labelKey: "builder.nodes.branches.addressNotValid" },
      { id: "not_sure", condition: "not_sure", labelKey: "builder.nodes.branches.addressNotSure" },
    ],
    extra: { noSettings: true },
  },
];

function localizeField(dict: any, field: FieldDef) {
  const out: Record<string, unknown> = {
    key: field.key,
    type: field.type,
    required: field.required ?? false,
  };
  if (field.labelKey) out.label = t(dict, field.labelKey);
  if (field.optional) out.optional = true;
  if (field.descKey) out.description = t(dict, field.descKey);
  if (field.lookup) out.lookup = field.lookup;
  if (field.lookupNote) out.lookupNote = field.lookupNote;
  if (field.enumValues) {
    out.values = field.enumValues.map((v) => ({ value: v.value, label: t(dict, v.labelKey) }));
  }
  if (field.min != null) out.min = field.min;
  if (field.max != null) out.max = field.max;
  if (field.notes) out.notes = field.notes;
  return out;
}

function localizeStep(dict: any, step: StepDef) {
  const out: Record<string, unknown> = {
    id: step.id,
    kind: step.kind,
    category: step.category === "internal"
      ? t(dict, "builder.sidebar.internalSystem")
      : t(dict, "builder.sidebar.logic"),
    title: t(dict, step.titleKey),
    graph: {
      nodeType: step.kind,
      dataType: step.id,
    },
    config: step.fields.length
      ? step.fields.map((f) => localizeField(dict, f))
      : [],
  };
  if (step.descKey) out.description = t(dict, step.descKey);
  if (step.entity) out.entity = step.entity;
  if (step.restricted) out.restricted = true;
  if (step.superAdminNoEdit) out.superAdminNoEdit = true;
  if (!step.fields.length) out.noSettings = t(dict, "builder.config.noSettings");
  if (step.branches?.length) {
    out.branches = step.branches.map((b) => ({
      id: b.id,
      condition: b.condition,
      sourceHandle: b.id,
      label: t(dict, b.labelKey),
      optional: b.optional ?? false,
    }));
  }
  if (step.extra) out.extra = step.extra;
  return out;
}

function localizeCheckFields(dict: any) {
  const paymentStatuses = ["pending", "paid", "partial", "refunded", "partially_refunded"].map((id) => ({
    id,
    label: t(dict, `orders.paymentStatuses.${id}`),
  }));
  const paymentMethods = ["cash", "card", "bank_transfer", "cod", "wallet", "other", "unknown"].map((id) => ({
    id,
    label: t(dict, `orders.paymentMethods.${id}`),
  }));
  const operators = {
    number: ["==", "!=", ">", "<", ">=", "<="],
    string: ["==", "!=", "contains", "not_contains", "starts_with"],
    boolean: ["==", "!="],
    select: ["==", "!="],
  };
  const operatorLabels: Record<string, string> = {
    "==": t(dict, "builder.operators.equal"),
    "!=": t(dict, "builder.operators.notEqual"),
    ">": t(dict, "builder.operators.greaterThan"),
    "<": t(dict, "builder.operators.lessThan"),
    ">=": t(dict, "builder.operators.greaterThanOrEqual"),
    "<=": t(dict, "builder.operators.lessThanOrEqual"),
    contains: t(dict, "builder.operators.contains"),
    not_contains: t(dict, "builder.operators.notContains"),
    starts_with: t(dict, "builder.operators.startsWith"),
  };
  const orderFields = CHECK_ORDER_FIELDS.map((f) => ({
    id: f.id,
    group: t(dict, "builder.orderProperties.orderData"),
    valueType: f.valueType,
    label: t(dict, f.labelKey),
    lookup: f.lookup,
    values: f.id === "paymentStatus" ? paymentStatuses : f.id === "paymentMethod" ? paymentMethods : undefined,
    operators: (operators as any)[f.valueType].map((op: string) => ({ id: op, label: operatorLabels[op] })),
  }));
  const clientFields = CLIENT_CHECK_FIELDS.map((id) => {
    const fromKey = CLIENT_PERCENT_FROM[id];
    return {
      id,
      group: t(dict, "builder.orderProperties.orderData"),
      valueType: "number",
      label: t(dict, `clientTags.fields.${id}`),
      from: fromKey ? t(dict, `clientTags.from.${fromKey}`) : undefined,
      isPercent: Boolean(fromKey),
      operators: operators.number.map((op) => ({ id: op, label: operatorLabels[op] })),
    };
  });
  return [...orderFields, ...clientFields];
}

export function resolveCatalogLang(requested?: string, settingsLang?: string): "en" | "ar" {
  const raw = (requested || settingsLang || Language.EN).toLowerCase();
  return raw === Language.AR || raw === "ar" ? "ar" : "en";
}

export function buildAutomationStepsCatalog(lang: "en" | "ar", opts?: { kind?: StepKind; type?: string }) {
  const dict = AUTOMATION_BUILDER_I18N[lang];
  let steps = STEPS;
  if (opts?.kind) steps = steps.filter((s) => s.kind === opts.kind);
  if (opts?.type) steps = steps.filter((s) => s.id === opts.type);

  const kinds = {
    trigger: t(dict, "builder.sidebar.triggers"),
    action: t(dict, "builder.sidebar.actions"),
    condition: t(dict, "builder.sidebar.conditions"),
  };

  const payload: Record<string, unknown> = {
    lang,
    graph: {
      nodeType: "trigger | action | condition (kind)",
      dataType: "step id such as order_created",
      config: "node.data.config keys listed per step",
      edges: "source/target plus sourceHandle = branch id on branching steps",
    },
    flowWhatsapp: {
      title: t(dict, "builder.settings.title"),
      description: t(dict, "builder.settings.subtitle"),
      fields: [
        { key: "mode", values: ["random", "fixed"], randomLabel: t(dict, "builder.settings.random") },
        { key: "accountId", label: t(dict, "builder.settings.account"), lookup: TOOL.whatsapp.accountsSearch, notes: "Used when mode=fixed. Reused for every WhatsApp step in a run." },
      ],
    },
    kinds,
    steps: steps.map((s) => localizeStep(dict, s)),
  };

  const includeChecks = !opts?.type || opts.type === "order_check" || opts.kind === "condition";
  if (includeChecks && steps.some((s) => s.id === "order_check")) {
    payload.orderCheckFields = localizeCheckFields(dict);
  }

  return payload;
}

export const AUTOMATION_STEP_IDS = STEPS.map((s) => s.id);
export const AUTOMATION_STEP_ID_SET = new Set(AUTOMATION_STEP_IDS);
