import { z } from "zod";
import { idDescription, ref, shippingCompanyIdDescription, TOOL, ToolName } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";
import { ActionType, ConditionType, TriggerType } from "entities/automation.entity";
import { ShipmentStatus } from "entities/shipping.entity";
import { SEND_WHATSAPP_MESSAGE_CONFIG } from "./automation-message-configs";
import { PLACEHOLDER_DEFINITION, PLACEHOLDER_PATH_MARKER } from "./automation-placeholders";

// ─────────────────────────────────────────────────────────────
// 1. Lookup registration
// ─────────────────────────────────────────────────────────────

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
  TOOL.ai.providersList,
  TOOL.agents.list,
];
CATALOG_LOOKUPS.forEach((name) => ref(name));

// ─────────────────────────────────────────────────────────────
// 2. Shared constants and types
// ─────────────────────────────────────────────────────────────

const MAX_WAIT_MINUTES = 7 * 24 * 60;

type StepKind = "trigger" | "action" | "condition";

type FieldDef = {
  key: string;
  type: "uuid" | "string" | "number" | "boolean" | "enum" | "object" | "array";
  required?: boolean;
  optional?: boolean;
  label?: string;
  description?: string;
  lookup?: ToolName;
  lookupNote?: string;
  /** Literal values (e.g. "all") accepted instead of a looked-up value. */
  literals?: string[];
  /** How to compute a mirror/display field instead of inventing it. */
  derived?: string;
  default?: string;
  enumValues?: { value: string; label?: string }[];
  min?: number;
  max?: number;
  notes?: string;
};

type BranchDef = {
  id: string;
  condition?: string;
  label: string;
  optional?: boolean;
  /** Human explanation of what this branch means for the flow. */
  description?: string;
  /** Config condition that makes this branch exist (for optional branches). */
  when?: string;
};

/**
 * A branch family whose ids/labels are derived from the step config at save
 * time (template buttons, quick-reply buttons). The AI uses the pattern and
 * the worked example to put the right id on `edge.sourceHandle`.
 */
type DynamicBranchDef = {
  when: string;
  onePer: string;
  idPattern: string;
  sourceHandlePattern: string;
  conditionPattern?: string;
  labelFrom: string;
  description: string;
  example: { id: string; sourceHandle: string; condition?: string; label: string };
};

type StepDef = {
  id: TriggerType | ConditionType | ActionType;
  kind: StepKind;
  category: "internal" | "logic";
  title: string;
  description?: string;
  entity?: string;
  restricted?: boolean;
  superAdminNoEdit?: boolean;
  configComponent: string;
  /** Zod config schema, emitted as JSON Schema. Preferred over `fields`. */
  configSchema?: z.ZodType;
  fields?: FieldDef[];
  branches?: BranchDef[];
  dynamicBranches?: DynamicBranchDef[];
  extra?: Record<string, unknown>;
};

const CHECK_ORDER_FIELDS: { id: string; valueType: string; label: string; lookup?: ToolName }[] = [
  { id: "orderNumber", valueType: "string", label: "Order Number" },
  { id: "shippingCompany", valueType: "select", label: "Shipping Company", lookup: TOOL.shippingCompanies.list },
  { id: "hasActiveShipment", valueType: "boolean", label: "Has Active Shipment" },
  { id: "paymentStatus", valueType: "select", label: "Payment Status" },
  { id: "productsTotal", valueType: "number", label: "Products Total" },
  { id: "items_count", valueType: "number", label: "All products" },
  { id: "paymentMethod", valueType: "select", label: "Payment Method" },
  { id: "cityId", valueType: "select", label: "City", lookup: TOOL.cities.list },
  { id: "lastCancelCauseId", valueType: "select", label: "Cancel cause", lookup: TOOL.cancelCauses.list },
  { id: "discount", valueType: "number", label: "Discount" },
  { id: "additionalFees", valueType: "number", label: "Additional Fees" },
  { id: "status", valueType: "select", label: "Order Status", lookup: TOOL.orderStatuses.list },
  { id: "allowOpenPackage", valueType: "boolean", label: "Allow Open Package" },
  { id: "isReplacement", valueType: "boolean", label: "Is Replacement Order" },
  { id: "campaignId", valueType: "boolean", label: "From Campaign" },
  { id: "hasEnoughStock", valueType: "boolean", label: "Has Enough Stock" },
  { id: "deposit", valueType: "number", label: "Deposit" },
];

const CLIENT_CHECK_FIELDS: { id: string; label: string; from?: string }[] = [
  { id: "client.totalOrders", label: "Total orders" },
  { id: "client.confirmedCount", label: "Confirmed orders" },
  { id: "client.confirmedPercent", label: "Confirmed percent", from: "of total orders" },
  { id: "client.confirmedRate", label: "Order confirmation rate", from: "of total orders" },
  { id: "client.shippedCount", label: "Shipped orders" },
  { id: "client.shippedPercent", label: "Shipped percent", from: "of total orders" },
  { id: "client.deliveredCount", label: "Delivered orders" },
  { id: "client.deliveredPercent", label: "Delivered percent", from: "of total orders" },
  { id: "client.returnedCount", label: "Returned orders" },
  { id: "client.returnedPercent", label: "Returned percent", from: "of total orders" },
  { id: "client.cancelledCount", label: "Cancelled orders" },
  { id: "client.cancelRate", label: "Cancel percent", from: "of total orders" },
  { id: "client.cancelledBeforeShippingCount", label: "Cancelled before shipping" },
  { id: "client.beforeShippingCancelRate", label: "Cancelled before shipping percent", from: "of total orders" },
  { id: "client.cancelledAfterShippingCount", label: "Cancelled after shipping" },
  { id: "client.afterShippingCancelRate", label: "Cancelled after shipping percent", from: "of total orders" },
  { id: "client.afterShippingCancelRateOfShipped", label: "After-shipping cancel rate of shipped", from: "of shipped orders" },
  { id: "client.totalSales", label: "Total sales" },
  { id: "client.deliveredRevenue", label: "Delivered revenue" },
];

// ─────────────────────────────────────────────────────────────
// 3. Trigger config schemas
// ─────────────────────────────────────────────────────────────
// Same shape as tool inputs: z.object + uuidField/idDescription. `.meta()`
// carries the catalog metadata (label, lookup tool, derived mirror, ...) so the
// emitted JSON Schema stays self-describing for the model.

const ORDER_CREATED_CONFIG = z.object({
  storeId: uuidField(idDescription("Store id.", TOOL.stores.list, 'Use "all" for every store.'), ["all"])
    .optional()
    .meta({
      label: "Store",
      description: "Choose the store to monitor orders in",
      lookupTool: TOOL.stores.list,
      literals: ["all"],
      notes: 'When the store is "all", storeId is omitted.',
    }),
  store: z
    .string()
    .meta({
      label: "Store",
      derived: `Copy \`name\` from the ${ref(TOOL.stores.list)} row, or use the literal "all" for every store.`,
    }),
});

const ORDER_UPDATED_CONFIG = z.object({
  statusId: uuidField(idDescription("Target order status id.", TOOL.orderStatuses.list)).meta({
    label: "Target Status",
    description: "Trigger automation when order changes to this status",
    lookupTool: TOOL.orderStatuses.list,
    lookupNote: "Use `id` from the row.",
  }),
  status: z
    .string()
    .optional()
    .meta({
      label: "Status",
      derived: `Copy \`name\` from the ${ref(TOOL.orderStatuses.list)} row selected for statusId. Never write the name from memory.`,
    }),
});

const SHIPMENT_CREATED_CONFIG = z.object({
  shippingCompanyId: uuidField(shippingCompanyIdDescription("Optional shipping company id."), ["all"])
    .optional()
    .meta({
      label: "Shipping Company",
      description: "Choose the shipping company to monitor shipments in",
      lookupTool: TOOL.shippingCompanies.list,
      lookupNote: shippingCompanyIdDescription("Shipping company id."),
      literals: ["all"],
      notes: 'When the company is "all", shippingCompanyId is omitted.',
    }),
  shippingCompany: z
    .string()
    .meta({
      label: "Shipping Company",
      derived: `Copy \`name\` from the ${ref(TOOL.shippingCompanies.list)} row (select by \`providerId\`), or use the literal "all" for every company.`,
    }),
});

const SHIPMENT_UPDATED_CONFIG = z.object({
  shipmentStatus: z.enum(ShipmentStatus).meta({
    label: "Target Shipment Status",
    description: "Trigger automation when shipment changes to this status",
  }),
});

const ASSIGNMENT_CANCELLED_CONFIG = z.object({
  cancelSource: z
    .enum(["automatic", "manual", "both"])
    .default("automatic")
    .meta({
      label: "Cancellation type",
      description: "Choose when this automation should run after an assignment is cancelled",
      values: [
        { value: "automatic", label: "Automatic expiry only" },
        { value: "manual", label: "Manual cancellation only" },
        { value: "both", label: "Both automatic and manual" },
      ],
    }),
});

// ─────────────────────────────────────────────────────────────
// 4. Action and condition config schemas
// ─────────────────────────────────────────────────────────────

const UPDATE_ORDER_STATUS_CONFIG = z.object({
  newStatusId: uuidField(idDescription("Order status id.", TOOL.orderStatuses.list)).meta({
    label: "New Status",
    description: "Choose the status to move the order to",
    lookupTool: TOOL.orderStatuses.list,
    lookupNote: "Use `id` from the row.",
  }),
  newStatus: z.string().meta({ label: "New Status" }),
  cancelCauseId: uuidField(idDescription("Cancel cause id.", TOOL.cancelCauses.list))
    .optional()
    .meta({
      label: "Cancel cause",
      description: "Required when the new status is cancelled. Saved on the cancellation record.",
      lookupTool: TOOL.cancelCauses.list,
      notes: "Required when the new status code is cancelled.",
    }),
  cancelCauseName: z.string().optional().meta({ label: "Cancel cause" }),
});

const ASSIGN_ORDER_TO_EMPLOYEE_CONFIG = z.object({
  employeeId: uuidField(idDescription("Employee id.", TOOL.employees.list))
    .optional()
    .meta({
      label: "Select Employee",
      description: "Choose an employee to assign the order to, or leave empty for automatic assignment",
      lookupTool: TOOL.employees.list,
      notes: "Empty = auto assign.",
    }),
  employeeName: z.string().optional().meta({ label: "Select Employee" }),
});

const AI_ADDRESS_CORRECTION_CONFIG = z.object({
  aiSource: z.enum(["hosted", "tenant"]).optional().meta({
    label: "AI source",
    values: [
      { value: "hosted", label: "Platform models" },
      { value: "tenant", label: "My account" },
    ],
  }),
  providerId: uuidField(idDescription("AI provider id.", TOOL.ai.providersList))
    .optional()
    .meta({
      label: "AI Provider",
      description: "Leave Automatic to pick the best connected provider. Choose one only if you want a specific provider.",
      lookupTool: TOOL.ai.providersList,
      notes: "Tenant source only. Empty = automatic among connected providers.",
    }),
  shippingCompanyId: uuidField(shippingCompanyIdDescription("Optional shipping company id."))
    .optional()
    .meta({
      label: "Restrict the choice to a specific shipping company (optional)",
      description: "Leave Automatic so AI can choose among all available shipping companies, or restrict it to one company if you want.",
      lookupTool: TOOL.shippingCompanies.list,
      lookupNote: shippingCompanyIdDescription("Shipping company id."),
      notes: "Empty = automatic.",
    }),
  updateWrittenAddress: z.boolean().default(true).meta({
    label: "Rewrite the address text",
    description: "On: the full address text is rewritten. Off: only the city, area, and district are updated.",
  }),
  agentId: uuidField(idDescription("WhatsApp agent id.", TOOL.agents.list))
    .optional()
    .meta({
      label: "AI agent",
      description: "Default uses the agent on the WhatsApp Business number. None means do not message the customer. You can also pick a specific agent.",
      lookupTool: TOOL.agents.list,
    }),
  useWhatsappAccountAgent: z.boolean().optional().meta({
    label: "Use the WhatsApp assistant on the WhatsApp Business number",
  }),
});

const ASSIGN_SHIPPING_PROVIDER_CONFIG = z.object({
  useSpecialShippingCompany: z.boolean().default(false).meta({
    label: "Choose a different shipping company manually (optional)",
    description: "Turn this on only if you want to force the order onto a specific shipping company, regardless of the AI decision.",
  }),
  shippingCompanyId: uuidField(shippingCompanyIdDescription("Shipping company id."))
    .optional()
    .meta({
      label: "Shipping Company",
      description: "This company will receive the shipment.",
      lookupTool: TOOL.shippingCompanies.list,
      lookupNote: shippingCompanyIdDescription("Shipping company id."),
      notes: "Required only when useSpecialShippingCompany is true. Use providerId.",
    }),
  shippingCompany: z.string().optional().meta({ label: "Shipping Company" }),
  provider: z.string().optional().meta({ label: "Provider" }),
});

const ASSIGN_ORDER_TO_CLIENT_CONFIG = z.object({
  createIfMissing: z.boolean().optional().meta({
    label: "Create a New Client if Missing",
    description: "When enabled, if no client is linked to the number, a new client will be created using the name, email, and phone number from the order, and the order will be added to them. When disabled, no new client will be created.",
  }),
});

const SEND_UPSELL_CONFIG = z.object({
  noResponseMinutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).optional().meta({
    label: "Minutes",
    description: 'If the client doesn\'t respond within this time, the automation will continue from the "No response" branch on this step.',
  }),
});

const CREATE_ISSUE_CONFIG = z.object({
  title: z
    .string()
    .min(1)
    .meta({
      label: "Title",
      description: "Issue title. May include order-property tokens.",
      supportsPlaceholders: true,
    }),
  description: z
    .string()
    .optional()
    .meta({
      label: "Description",
      description: "Issue description. May include order-property tokens.",
      supportsPlaceholders: true,
    }),
  causeId: uuidField(idDescription("Issue cause id.", TOOL.issues.lookupsList))
    .optional()
    .meta({
      label: "Cause",
      lookupTool: TOOL.issues.lookupsList,
      notes: "kind=cause.",
    }),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional().meta({
    label: "Priority",
    description: "low | medium | high | urgent. Default medium.",
  }),
  statusId: uuidField(idDescription("Issue status id.", TOOL.issues.lookupsList))
    .optional()
    .meta({
      label: "Status",
      lookupTool: TOOL.issues.lookupsList,
      notes: "kind=status. Defaults to open.",
    }),
  assignedRoleId: uuidField(idDescription("Role id.", TOOL.roles.list)).meta({ label: "Assigned Role" }),
  employeeIds: z
    .array(
      uuidField(idDescription("Employee id.", TOOL.employees.list)).meta({
        lookupTool: TOOL.employees.list,
        lookupNote: "Use `id` from the row.",
      }),
    )
    .optional()
    .meta({ label: "Employees" }),
  estimatedMinutes: z.number().int().min(1).optional().meta({ label: "Estimated minutes" }),
});

const WAIT_CONFIG = z.object({
  waitMinutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).meta({
    label: "Wait (minutes)",
    description: "Pause the flow for the specified number of minutes before continuing.",
  }),
});

const OPERATOR_VALUES = ["==", "!=", ">", "<", ">=", "<=", "contains", "not_contains", "starts_with"] as const;

const ORDER_CHECK_CONFIG = z.object({
  checks: z
    .array(
      z.object({
        field: z.string().min(1).describe("Order or client field id from orderCheckFields."),
        fieldLabel: z.string().describe("Display label of the selected field."),
        operator: z.enum(OPERATOR_VALUES).describe("Allowed operators depend on the field valueType."),
        targetValue: z.union([z.string(), z.number(), z.boolean()]).describe("Value to compare against."),
        targetLabel: z.string().optional().describe("Display label for the value, e.g. a lookup row name."),
      }),
    )
    .min(1)
    .max(20)
    .meta({
      label: "Checks",
      description: "1–20 conditions. All must match to take the yes branch.",
      notes: "Each item: field, fieldLabel, operator, targetValue, optional targetLabel.",
    }),
});

const TEMPLATE_VARIABLE = z
  .object({
    type: z.enum(["direct", "variable"]).meta({
      description: "direct = fixed value; variable = order/global field path.",
    }),
    value: z.string().optional().describe("Fixed value when type is direct."),
    label: z.string().optional().describe("Display label for the variable."),
    example: z.string().optional().describe("Example value from the template."),
    variablePath: z
      .string()
      .optional()
      .describe('Order/global path when type is variable, e.g. "customerName", "items[0].lineTotal", or "global.brandName".')
      .meta(PLACEHOLDER_PATH_MARKER),
  })
  .meta({ label: "Variable" });

const TEMPLATE_DATA_BUTTON = z
  .object({
    type: z.enum(["CUSTOM", "PHONE_NUMBER", "VISIT_WEBSITE", "WHATSAPP_CALL", "COPY_CODE"]),
    text: z.string(),
    url: z.string().optional(),
    urlType: z.enum(["Static", "Dynamic"]).optional(),
    urlExample: z.string().optional(),
    activeForDays: z.number().optional(),
    countryCode: z.string().optional(),
    phoneNumber: z.string().optional(),
    example: z.string().optional(),
  })
  .catchall(z.unknown());

const TEMPLATE_DATA = z
  .object({
    headerType: z.enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]).optional(),
    headerText: z.string().optional(),
    headerNamedKey: z.string().optional(),
    headerExample: z.string().optional(),
    headerUrl: z.string().optional(),
    bodyText: z.string().meta({ description: "Approved template body, including its placeholders." }),
    parameterFormat: z.enum(["positional", "named"]).optional(),
    footerText: z.string().optional(),
    examples: z.record(z.string(), z.string()).optional(),
    buttons: z.array(TEMPLATE_DATA_BUTTON).optional(),
  })
  .catchall(z.unknown())
  .meta({
    label: "Template snapshot",
    description: "Copy `templateConfig` from the chosen template lookup row exactly. Never invent or edit it.",
  });

const SEND_WHATSAPP_TEMPLATE_CONFIG = z.object({
  templateId: uuidField(idDescription("WhatsApp template id.", TOOL.whatsapp.templatesSearch)).meta({
    label: "Template",
    description: "Choose the approved message template to send.",
    lookupTool: TOOL.whatsapp.templatesSearch,
    lookupNote: "Use `id` from the row.",
  }),
  templateName: z.string().meta({
    label: "Template",
    description: "Copy `name` from the chosen template row.",
    derived: `Copy \`name\` from the ${ref(TOOL.whatsapp.templatesSearch)} row selected for templateId.`,
  }),
  recipientNumber: z.string().optional().meta({
    label: "Recipient Number",
    description: "Phone number to send to. Leave empty to use the order phone number.",
  }),
  templateData: TEMPLATE_DATA,
  headerUrl: z.string().optional().meta({ label: "Header media URL or leave it empty" }),
  useOrderFirstItemImage: z.boolean().optional().meta({
    label: "Use first product image",
    description: "Use the first order item's image as the image header.",
  }),
  bodyVariables: z.record(z.string(), TEMPLATE_VARIABLE).optional().meta({
    label: "Variables",
    description: "Keyed by body placeholder index or name, depending on the template parameterFormat.",
  }),
  headerVariables: z.record(z.string(), TEMPLATE_VARIABLE).optional().meta({
    label: "Message Header",
    description: "Keyed by header placeholder index or name. TEXT headers only.",
  }),
  buttonVariables: z.record(z.string(), TEMPLATE_VARIABLE).optional().meta({
    label: "Link Buttons",
    description: "Keyed by button index for dynamic website links and copy-code buttons.",
  }),
  locationData: z
    .object({
      latitude: z.union([z.string(), z.number()]),
      longitude: z.union([z.string(), z.number()]),
      address: TEMPLATE_VARIABLE,
      name: TEMPLATE_VARIABLE,
    })
    .optional()
    .meta({
      label: "Location Header",
      description: "Required only when the template header type is LOCATION.",
    }),
  noResponseMinutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).optional().meta({
    label: "Minutes",
    description: 'If the client doesn\'t respond within this time, continue from the "No response" branch.',
  }),
  branches: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        condition: z.string(),
        sourceButton: z.record(z.string(), z.unknown()).optional(),
        isNoResponse: z.boolean().optional(),
        timeoutMinutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).optional(),
      }),
    )
    .optional()
    .meta({
      label: "Branches",
      description:
        "One branch per CUSTOM template button (id btn_N, condition button_click_N), plus an optional no-response timeout branch.",
    }),
});

const QUICK_ORDER_STATUS_CONFIG = z.object({
  statusId: uuidField(idDescription("Order status id.", TOOL.orderStatuses.list)).meta({
    label: "Status",
    description: "Choose the status to monitor",
    lookupTool: TOOL.orderStatuses.list,
    lookupNote: "Use `id` from the row.",
  }),
  status: z.string().meta({ label: "Status" }),
});

// ─────────────────────────────────────────────────────────────
// 5. Schema registry
// ─────────────────────────────────────────────────────────────

export const STEP_CONFIG_SCHEMAS: Partial<Record<TriggerType | ActionType | ConditionType, z.ZodType>> = {
  [TriggerType.ORDER_CREATED]: ORDER_CREATED_CONFIG,
  [TriggerType.ORDER_UPDATED]: ORDER_UPDATED_CONFIG,
  [TriggerType.SHIPMENT_CREATED]: SHIPMENT_CREATED_CONFIG,
  [TriggerType.SHIPMENT_UPDATED]: SHIPMENT_UPDATED_CONFIG,
  [TriggerType.ASSIGNMENT_CANCELLED]: ASSIGNMENT_CANCELLED_CONFIG,
  [ActionType.UPDATE_ORDER_STATUS]: UPDATE_ORDER_STATUS_CONFIG,
  [ActionType.ASSIGN_ORDER_TO_EMPLOYEE]: ASSIGN_ORDER_TO_EMPLOYEE_CONFIG,
  [ActionType.AI_ADDRESS_CORRECTION]: AI_ADDRESS_CORRECTION_CONFIG,
  [ActionType.ASSIGN_SHIPPING_PROVIDER]: ASSIGN_SHIPPING_PROVIDER_CONFIG,
  [ActionType.ASSIGN_ORDER_TO_CLIENT]: ASSIGN_ORDER_TO_CLIENT_CONFIG,
  [ActionType.SEND_WHATSAPP_TEMPLATE]: SEND_WHATSAPP_TEMPLATE_CONFIG,
  [ActionType.SEND_WHATSAPP_MESSAGE]: SEND_WHATSAPP_MESSAGE_CONFIG,
  [ActionType.SEND_UPSELL]: SEND_UPSELL_CONFIG,
  [ActionType.CREATE_ISSUE]: CREATE_ISSUE_CONFIG,
  [ActionType.WAIT]: WAIT_CONFIG,
  [ConditionType.ORDER_CHECK]: ORDER_CHECK_CONFIG,
  [ConditionType.QUICK_ORDER_STATUS]: QUICK_ORDER_STATUS_CONFIG,
};

// ─────────────────────────────────────────────────────────────
// 6. Step catalog
// ─────────────────────────────────────────────────────────────

const STEPS: StepDef[] = [
  // Triggers
  {
    id: TriggerType.ORDER_CREATED,
    kind: "trigger",
    category: "internal",
    title: "New Order Created",
    entity: "order",
    superAdminNoEdit: true,
    configComponent: "OrderCreatedConfig",
    configSchema: ORDER_CREATED_CONFIG,
  },
  {
    id: TriggerType.ORDER_UPDATED,
    kind: "trigger",
    category: "internal",
    title: "Order Status Updated",
    entity: "order",
    configComponent: "OrderStatusUpdatedConfig",
    configSchema: ORDER_UPDATED_CONFIG,
  },
  {
    id: TriggerType.SHIPMENT_CREATED,
    kind: "trigger",
    category: "internal",
    title: "New Shipment Created",
    entity: "order",
    superAdminNoEdit: true,
    configComponent: "ShipmentCreatedConfig",
    configSchema: SHIPMENT_CREATED_CONFIG,
  },
  {
    id: TriggerType.SHIPMENT_UPDATED,
    kind: "trigger",
    category: "internal",
    title: "Shipment Status Updated",
    entity: "order",
    configComponent: "ShipmentStatusUpdatedConfig",
    configSchema: SHIPMENT_UPDATED_CONFIG,
  },
  {
    id: TriggerType.ASSIGNMENT_CANCELLED,
    kind: "trigger",
    category: "internal",
    title: "Assignment Cancelled",
    entity: "order",
    configComponent: "AssignmentCancelledConfig",
    configSchema: ASSIGNMENT_CANCELLED_CONFIG,
  },
  // Actions
  {
    id: ActionType.UPDATE_ORDER_STATUS,
    kind: "action",
    category: "internal",
    title: "Update Order Status",
    description: "The new status to be assigned to the order",
    configComponent: "UpdateOrderStatusConfig",
    configSchema: UPDATE_ORDER_STATUS_CONFIG,
  },
  {
    id: ActionType.ASSIGN_ORDER_TO_EMPLOYEE,
    kind: "action",
    category: "internal",
    title: "Assign Order to Employee",
    description: "Assign the order to a specific employee or use automatic assignment",
    configComponent: "AssignOrderToEmployeeConfig",
    configSchema: ASSIGN_ORDER_TO_EMPLOYEE_CONFIG,
    branches: [
      {
        id: "assigned",
        condition: "assigned",
        label: "Assigned",
        description: "The order was assigned to the chosen employee, or auto-assignment found a match.",
      },
      {
        id: "no_roles_match",
        condition: "no_roles_match",
        label: "No Rules Match",
        optional: true,
        when: "employeeId is empty (auto-assignment mode).",
        description: "Auto-assignment only: no assignment rule matched the order.",
      },
      {
        id: "not_eligable",
        condition: "not_eligable",
        label: "Not Eligible",
        description: "The order could not be assigned because no employee is eligible.",
      },
    ],
  },
  {
    id: ActionType.AI_ADDRESS_CORRECTION,
    kind: "action",
    category: "internal",
    title: "Correct address and assign shipping (AI)",
    description: "Reviews the address and corrects it when needed, then assigns the shipping company, city, and area automatically.",
    restricted: true,
    configComponent: "AiAddressCorrectionConfig",
    configSchema: AI_ADDRESS_CORRECTION_CONFIG,
    branches: [
      {
        id: "address_corrected",
        condition: "address_corrected",
        label: "Address Corrected",
        description: "The address was corrected and the shipping company, city, and area were assigned.",
      },
      {
        id: "address_not_corrected",
        condition: "address_not_corrected",
        label: "Address Not Corrected",
        description: "Address correction or shipping assignment failed; the order keeps its original address.",
      },
    ],
  },
  {
    id: ActionType.ASSIGN_SHIPPING_PROVIDER,
    kind: "action",
    category: "internal",
    title: "Distribute order to shipping company",
    description: "By default, the shipping company chosen by AI in the correction step is used automatically. You do not need to pick a company yourself.",
    restricted: true,
    configComponent: "AssignShippingProviderConfig",
    configSchema: ASSIGN_SHIPPING_PROVIDER_CONFIG,
    branches: [
      {
        id: "distributed",
        condition: "distributed",
        label: "Distributed",
        description: "A shipment was created with the selected shipping company.",
      },
      {
        id: "failed_to_distribute",
        condition: "failed_to_distribute",
        label: "Failed to Distribute",
        description: "No shipping provider was selected or shipment creation failed.",
      },
    ],
  },
  {
    id: ActionType.SEND_WHATSAPP_TEMPLATE,
    kind: "action",
    category: "internal",
    title: "Send WhatsApp Template",
    description: "Choose the template and fill in the required variables",
    configComponent: "SendWhatsappTemplateConfig",
    configSchema: SEND_WHATSAPP_TEMPLATE_CONFIG,
    branches: [
      {
        id: "no_response",
        label: "No response",
        optional: true,
        when: "config.noResponseMinutes is set to 1..10080.",
        description: "The customer did not answer within noResponseMinutes, so the run continues down this handle.",
      },
    ],
    dynamicBranches: [
      {
        when: "A template is chosen and templateData.buttons contains quick-reply buttons (type=CUSTOM).",
        onePer: "Each CUSTOM button, in order.",
        idPattern: "btn_<index>",
        sourceHandlePattern: "btn_<index>",
        conditionPattern: "button_click_<index>",
        labelFrom: "The button text (templateData.buttons[].text).",
        description: "The customer tapped that quick-reply button. <index> counts CUSTOM buttons only, starting at 0; VISIT_WEBSITE, PHONE_NUMBER, WHATSAPP_CALL, and COPY_CODE buttons create no branch and do not shift the index. Use the id on edge.sourceHandle.",
        example: { id: "btn_0", sourceHandle: "btn_0", condition: "button_click_0", label: "Confirm Order" },
      },
    ],
  },
  {
    id: ActionType.SEND_WHATSAPP_MESSAGE,
    kind: "action",
    category: "internal",
    title: "Send WhatsApp Message",
    description: "Choose the message type and configure it",
    configComponent: "SendWhatsappMessageConfig",
    configSchema: SEND_WHATSAPP_MESSAGE_CONFIG,
    branches: [
      {
        id: "any_option",
        label: "When respond",
        optional: true,
        when: "The message asks for a choice: custom list or location_request, or the business use cases order_postpone_date / order_cancel_cause.",
        description: "Catch-all: whatever the customer selects or replies with follows this handle.",
      },
      {
        id: "no_response",
        label: "No response",
        optional: true,
        when: "config.noResponseMinutes is set to 1..10080 and the message collects a response (quick replies, list, or location_request).",
        description: "The customer did not answer within noResponseMinutes, so the run continues down this handle.",
      },
    ],
    dynamicBranches: [
      {
        when: "messageMode=custom, messageType=interactive, and messageData.interactive.action.buttons contains quick-reply buttons.",
        onePer: "Each quick-reply button.",
        idPattern: "<button.reply.id>",
        sourceHandlePattern: "<button.reply.id>",
        labelFrom: "The button title (messageData.interactive.action.buttons[].reply.title).",
        description: "The customer tapped that quick-reply button. Use the same id you wrote in messageData.interactive.action.buttons[].reply.id (usually btn_0, btn_1, ...) as edge.sourceHandle. There is no condition field on these branches.",
        example: { id: "btn_0", sourceHandle: "btn_0", label: "Confirm Order" },
      },
      {
        when: "messageMode=business and businessUseCase is order_discount_offer or order_payment_method.",
        onePer: "Each button generated by the business message.",
        idPattern: "btn_<index>",
        sourceHandlePattern: "btn_<index>",
        labelFrom: "The generated button title in messageData.",
        description: "The customer tapped that business-message button. messageData is generated server-side; the ids are btn_0, btn_1, ... in the generated button order.",
        example: { id: "btn_0", sourceHandle: "btn_0", label: "Cash on delivery" },
      },
    ],
    extra: { flowWhatsapp: "The sending number is the flow WhatsApp setting, not a per-step account." },
  },
  {
    id: ActionType.ASSIGN_ORDER_TO_CLIENT,
    kind: "action",
    category: "internal",
    title: "Add Order to Client",
    description: "Link this order to the client matching the order's phone number.",
    configComponent: "AssignOrderToClientConfig",
    configSchema: ASSIGN_ORDER_TO_CLIENT_CONFIG,
  },
  {
    id: ActionType.SEND_UPSELL,
    kind: "action",
    category: "internal",
    title: "Send Upsell",
    configComponent: "SendUpsellConfig",
    configSchema: SEND_UPSELL_CONFIG,
    branches: [
      {
        id: "skipped",
        condition: "skipped",
        label: "None",
        description: "There were no matching products or no available upsell, so nothing was offered.",
      },
      {
        id: "reject",
        condition: "reject",
        label: "System Rejected",
        description: "The customer accepted but applying the upsell failed on the system side.",
      },
      {
        id: "accept",
        condition: "accept",
        label: "Accept",
        description: "The customer accepted the upsell and it was applied to the order.",
      },
      {
        id: "client_reject",
        condition: "client_reject",
        label: "Client Rejected",
        description: "The customer declined the upsell.",
      },
      {
        id: "no_response",
        label: "No response",
        optional: true,
        when: "config.noResponseMinutes is set to 1..10080.",
        description: "The customer did not answer within noResponseMinutes.",
      },
    ],
    extra: { note: `Offer catalog is on ${TOOL.upsells.search}. This step only waits for the customer response.` },
  },
  {
    id: ActionType.CREATE_ISSUE,
    kind: "action",
    category: "internal",
    title: "Create Issue",
    configComponent: "CreateIssueConfig",
    configSchema: CREATE_ISSUE_CONFIG,
  },
  {
    id: ActionType.WAIT,
    kind: "action",
    category: "internal",
    title: "Wait",
    description: "Pause the flow for the specified number of minutes before continuing.",
    configComponent: "WaitConfig",
    configSchema: WAIT_CONFIG,
  },
  // Conditions
  {
    id: ConditionType.ORDER_CHECK,
    kind: "condition",
    category: "logic",
    title: "Check Order Data",
    description: "Route the flow based on order fields or customer statistics",
    configComponent: "OrderCheckConfig",
    configSchema: ORDER_CHECK_CONFIG,
    branches: [
      {
        id: "true",
        condition: "true",
        label: "Yes",
        description: "Every configured check matched the order.",
      },
      {
        id: "false",
        condition: "false",
        label: "No",
        description: "At least one configured check did not match.",
      },
    ],
  },
  {
    id: ConditionType.QUICK_ORDER_STATUS,
    kind: "condition",
    category: "logic",
    title: "Quick Status Check",
    description: "Route flow based on current order status",
    configComponent: "QuickOrderStatusConfig",
    configSchema: QUICK_ORDER_STATUS_CONFIG,
    branches: [
      {
        id: "true",
        condition: "true",
        label: "Yes",
        description: "The order status is the configured status.",
      },
      {
        id: "false",
        condition: "false",
        label: "No",
        description: "The order status is different from the configured status.",
      },
    ],
  },
  {
    id: ConditionType.AI_ADDRESS_COMPLETENESS,
    kind: "condition",
    category: "logic",
    title: "Check address completeness (AI) — no changes",
    description: "Confirms that every address field, including the address, city, and area, is clear, complete, consistent, and free of conflicts.",
    restricted: true,
    configComponent: "AiAddressCompletenessConfig",
    fields: [],
    branches: [
      {
        id: "valid",
        condition: "valid",
        label: "Valid",
        description: "All address fields are clear, complete, and consistent (high confidence).",
      },
      {
        id: "not_valid",
        condition: "not_valid",
        label: "Not valid",
        description: "The address is clearly incomplete or conflicting (low confidence).",
      },
      {
        id: "not_sure",
        condition: "not_sure",
        label: "Not sure",
        description: "Address completeness could not be decided with confidence.",
      },
    ],
    extra: { noSettings: true },
  },
];

// ─────────────────────────────────────────────────────────────
// 7. Catalog serialization
// ─────────────────────────────────────────────────────────────

function fieldSpec(field: FieldDef) {
  const schema: Record<string, unknown> = {
    type: field.type,
  };
  if (field.lookup) schema.lookupTool = field.lookup;
  if (field.lookupNote) schema.lookupNote = field.lookupNote;
  if (field.literals?.length) schema.literals = field.literals;
  if (field.derived) schema.derived = field.derived;
  if (field.default) schema.default = field.default;
  if (field.enumValues) {
    schema.values = field.enumValues.map((v) => ({
      value: v.value,
      ...(v.label ? { label: v.label } : {}),
    }));
  }
  if (field.min != null) schema.min = field.min;
  if (field.max != null) schema.max = field.max;
  if (field.notes) schema.notes = field.notes;

  const out: Record<string, unknown> = {
    key: field.key,
    required: field.required ?? false,
    schema,
  };
  if (field.label) out.label = field.label;
  if (field.description) out.description = field.description;
  return out;
}

function stepSpec(step: StepDef) {
  const out: Record<string, unknown> = {
    id: step.id,
    kind: step.kind,
    category: step.category === "internal" ? "Internal System" : "Logic",
    title: step.title,
    graph: {
      nodeType: step.kind,
      dataType: step.id,
    },
  };
  if (step.configSchema) {
    const json = z.toJSONSchema(step.configSchema, { io: "input" }) as Record<string, unknown>;
    delete json.$schema;
    out.configSchema = json;
  } else {
    out.config = step.fields?.length ? step.fields.map((f) => fieldSpec(f)) : [];
  }
  if (step.description) out.description = step.description;
  if (step.entity) out.entity = step.entity;
  if (step.restricted) out.restricted = true;
  if (step.superAdminNoEdit) out.superAdminNoEdit = true;
  if (!step.configSchema && !step.fields?.length) out.noSettings = "This step requires no additional settings";
  if (step.branches?.length || step.dynamicBranches?.length) out.branching = true;
  if (step.branches?.length) {
    out.branches = step.branches.map((b) => ({
      id: b.id,
      sourceHandle: b.id,
      label: b.label,
      ...(b.condition ? { condition: b.condition } : {}),
      optional: b.optional ?? false,
      ...(b.when ? { when: b.when } : {}),
      ...(b.description ? { description: b.description } : {}),
    }));
  }
  if (step.dynamicBranches?.length) out.dynamicBranches = step.dynamicBranches;
  if (step.extra) out.extra = step.extra;
  return out;
}

function buildCheckFields() {
  const paymentStatuses = [
    { id: "pending", label: "Pending" },
    { id: "paid", label: "Paid" },
    { id: "partial", label: "Partially Paid" },
    { id: "refunded", label: "Refunded" },
    { id: "partially_refunded", label: "Partially Refunded" },
  ];
  const paymentMethods = [
    { id: "cash", label: "Cash" },
    { id: "card", label: "Card" },
    { id: "bank_transfer", label: "Bank Transfer" },
    { id: "cod", label: "Cash on Delivery" },
    { id: "wallet", label: "E-Wallet" },
    { id: "other", label: "Other Method" },
    { id: "unknown", label: "Unknown Method" },
  ];
  const operators = {
    number: ["==", "!=", ">", "<", ">=", "<="],
    string: ["==", "!=", "contains", "not_contains", "starts_with"],
    boolean: ["==", "!="],
    select: ["==", "!="],
  };
  const operatorLabels: Record<string, string> = {
    "==": "Equal",
    "!=": "Not Equal",
    ">": "Greater Than",
    "<": "Less Than",
    ">=": "Greater Than or Equal",
    "<=": "Less Than or Equal",
    contains: "Contains",
    not_contains: "Does Not Contain",
    starts_with: "Starts With",
  };
  const orderFields = CHECK_ORDER_FIELDS.map((f) => ({
    id: f.id,
    group: "Order Data",
    valueType: f.valueType,
    label: f.label,
    lookup: f.lookup,
    values: f.id === "paymentStatus" ? paymentStatuses : f.id === "paymentMethod" ? paymentMethods : undefined,
    operators: (operators as any)[f.valueType].map((op: string) => ({ id: op, label: operatorLabels[op] })),
  }));
  const clientFields = CLIENT_CHECK_FIELDS.map((f) => ({
    id: f.id,
    group: "Customer statistics",
    valueType: "number",
    label: f.label,
    from: f.from,
    isPercent: Boolean(f.from),
    operators: operators.number.map((op) => ({ id: op, label: operatorLabels[op] })),
  }));
  return [...orderFields, ...clientFields];
}

// ─────────────────────────────────────────────────────────────
// 8. Public API
// ─────────────────────────────────────────────────────────────

const AUTOMATION_DEFINITION = {
  what: "An automation (flow) is a saved no-code graph that runs automatically for an order when its trigger fires. A run starts at the trigger, then follows edges through actions and conditions.",
  flow: "A flow is { nodes, edges, whatsapp? }. A node is { id, type: trigger|action|condition, data: { type, label, config } }; data.type is a step id from this catalog, data.label is a short human name for the step instance, and data.config holds that step's settings exactly as described by its configSchema.",
  branches: "Every branching step lists its branches: `branches` are the fixed/optional branches and `dynamicBranches` are the ones derived from the config (one per template CUSTOM button or quick-reply button). Each branch shows the exact `id` to put on `edge.sourceHandle`. On a branching step, every outgoing edge MUST set sourceHandle to one of those ids; on a step with no branches, leave sourceHandle out. Do NOT write config.branches yourself: the server generates them from the step config when the flow is saved.",
  stepKinds: [
    {
      kind: "trigger",
      title: "Triggers",
      meaning: "The event that starts a run. A flow has exactly one trigger node and it has no incoming edges.",
    },
    {
      kind: "action",
      title: "Actions",
      meaning: "Work the run performs, such as updating the order, assigning an employee or shipping company, sending WhatsApp, waiting, or creating an issue.",
    },
    {
      kind: "condition",
      title: "Conditions",
      meaning: "Route the run by checking order data. A condition node branches to the handles listed on that step.",
    },
  ],
  statuses: [
    { status: "draft", meaning: "Saved but not running; only published flows execute." },
    { status: "published", meaning: "Active and can be triggered." },
    { status: "paused", meaning: "Temporarily stopped; can be resumed without losing its graph." },
    { status: "archived", meaning: "Retired and kept for reference." },
  ],
} as const;

export function buildAutomationStepsCatalog(opts?: { kind?: StepKind; type?: string }) {
  let steps = STEPS;
  if (opts?.kind) steps = steps.filter((s) => s.kind === opts.kind);
  if (opts?.type) steps = steps.filter((s) => s.id === opts.type);

  const kinds = {
    trigger: "Triggers",
    action: "Actions",
    condition: "Conditions",
  };

  const payload: Record<string, unknown> = {
    definitions: {
      automation: AUTOMATION_DEFINITION,
      placeholders: PLACEHOLDER_DEFINITION,
    },
    graph: {
      nodeType: "trigger | action | condition (kind)",
      dataType: "step id such as order_created",
      config: "node.data.config. Steps with configSchema describe it as JSON Schema; other steps list the keys in config.",
      edges: "source/target plus sourceHandle = branch id. Required on branching steps (see the step's branches/dynamicBranches); omit it on steps with no branches.",
    },
    flowWhatsapp: {
      title: "WhatsApp sending number",
      description: "Choose a WhatsApp account for this automation, or pick a random account for each run. The chosen number is reused for every WhatsApp step in that run.",
      fields: [
        { key: "mode", values: ["random", "fixed"], randomLabel: "Random account each run" },
        { key: "accountId", label: "WhatsApp account", lookup: TOOL.whatsapp.accountsSearch, notes: "Used when mode=fixed. Reused for every WhatsApp step in a run." },
      ],
    },
    kinds,
    steps: steps.map((s) => stepSpec(s)),
  };

  const includeChecks = !opts?.type || opts.type === "order_check" || opts.kind === "condition";
  if (includeChecks && steps.some((s) => s.id === "order_check")) {
    payload.orderCheckFields = buildCheckFields();
  }

  return payload;
}

export const AUTOMATION_STEP_IDS = STEPS.map((s) => s.id);
export const AUTOMATION_STEP_ID_SET = new Set(AUTOMATION_STEP_IDS);

/** Lightweight lookup used when validating a saved flow. */
export const AUTOMATION_STEP_META = new Map<
  string,
  { kind: StepKind; title: string }
>(STEPS.map((s) => [s.id, { kind: s.kind, title: s.title }]));
