import { z } from "zod";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";
import { PLACEHOLDER_DATE_FORMATS } from "./automation-placeholders";

const MAX_NO_RESPONSE_MINUTES = 7 * 24 * 60;
const POSTPONE_ID_FORMAT = "DD-MM-YYYY";

export const CUSTOM_MESSAGE_TYPES = [
  "text",
  "image",
  "document",
  "video",
  "location",
  "contact",
  "list",
  "interactive",
  "location_request",
] as const;

export const BUSINESS_MESSAGE_USE_CASES = [
  "order_postpone_date",
  "order_discount_offer",
  "order_payment_method",
  "order_cancel_cause",
] as const;

export type BusinessMessageUseCase = (typeof BUSINESS_MESSAGE_USE_CASES)[number];

// Text fields the frontend fills with its VariableInput (order-property tokens).
const TEXT = { supportsPlaceholders: true } as const;

const MESSAGE_MEDIA = z
  .object({
    id: z.string().optional().describe("Uploaded WhatsApp media id."),
    link: z.string().optional().describe("Public https link to the media."),
    url: z.string().optional().describe("Public https link to the media."),
    name: z.string().optional(),
    caption: z.string().meta(TEXT).optional(),
    filename: z.string().optional(),
  })
  .refine((value) => !!(value.id || value.link || value.url), {
    message: "Media must include a valid id, link, or url.",
    path: ["id"],
  })
  .catchall(z.unknown());

// `text` messages wrap the body in `text.body`; interactive messages wrap it in
// `interactive.body.text`. The frontend sends exactly these shapes.
const MESSAGE_TEXT = z.object({ body: z.string().meta(TEXT) }).catchall(z.unknown());
const INTERACTIVE_BODY = z.object({ text: z.string().meta(TEXT) }).catchall(z.unknown());
const MESSAGE_FOOTER = z.object({ text: z.string().meta(TEXT) }).catchall(z.unknown());

const INTERACTIVE_HEADER = z
  .object({
    type: z.enum(["text", "image", "video", "document"]),
    text: z.string().meta(TEXT).optional(),
    image: MESSAGE_MEDIA.optional(),
    video: MESSAGE_MEDIA.optional(),
    document: MESSAGE_MEDIA.optional(),
  })
  .catchall(z.unknown());

const LIST_ROW = z
  .object({
    id: z.string().describe("Row id returned as the reply id. Unique in the list."),
    title: z.string().meta(TEXT).describe("Row title, maximum 24 characters."),
    description: z.string().meta(TEXT).optional(),
  })
  .catchall(z.unknown());

const LIST_SECTION = z
  .object({
    title: z.string().describe("Section title."),
    rows: z.array(LIST_ROW).min(1),
  })
  .catchall(z.unknown());

const BUTTON_REPLY = z
  .object({
    type: z.literal("reply"),
    reply: z.object({ id: z.string(), title: z.string().meta(TEXT) }).catchall(z.unknown()),
  })
  .catchall(z.unknown());

const LIST_INTERACTIVE = z.object({
  type: z.literal("list"),
  header: INTERACTIVE_HEADER.optional(),
  body: INTERACTIVE_BODY,
  footer: MESSAGE_FOOTER.optional(),
  action: z.object({
    button: z.string().describe("Menu button label, maximum 20 characters."),
    sections: z.array(LIST_SECTION).min(1),
  }),
});

const BUTTON_INTERACTIVE = z.object({
  type: z.literal("button"),
  header: INTERACTIVE_HEADER.optional(),
  body: INTERACTIVE_BODY,
  footer: MESSAGE_FOOTER.optional(),
  action: z.object({
    buttons: z.array(BUTTON_REPLY).min(1).max(3),
  }),
});

const LOCATION_REQUEST_INTERACTIVE = z.object({
  type: z.literal("location_request_message"),
  body: INTERACTIVE_BODY,
  action: z.object({ name: z.literal("send_location") }),
});

const CONTACT_OBJECT = z
  .object({
    addresses: z
      .array(
        z
          .object({
            street: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            country: z.string().optional(),
            country_code: z.string().optional(),
            zip: z.string().optional(),
            type: z.enum(["HOME", "WORK"]).optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    birthday: z.string().optional(),
    emails: z.array(z.object({ email: z.string(), type: z.enum(["HOME", "WORK"]).optional() })).optional(),
    name: z
      .object({
        first_name: z.string().meta(TEXT),
        middle_name: z.string().meta(TEXT).optional(),
        last_name: z.string().meta(TEXT),
        formatted_name: z.string().meta(TEXT),
        prefix: z.string().meta(TEXT).optional(),
        suffix: z.string().meta(TEXT).optional(),
      })
      .catchall(z.unknown()),
    org: z.object({ company: z.string().optional(), department: z.string().optional(), title: z.string().optional() }).optional(),
    phones: z
      .array(
        z.object({
          phone: z.string(),
          type: z.enum(["HOME", "WORK", "MOBILE"]).optional(),
          wa_id: z.string().optional(),
        }),
      )
      .min(1),
    urls: z.array(z.object({ url: z.string(), type: z.enum(["HOME", "WORK"]).optional() })).optional(),
  })
  .catchall(z.unknown());

export const CUSTOM_MESSAGE_DATA = z.union([
  z.object({ type: z.literal("text"), text: MESSAGE_TEXT }),
  z.object({ type: z.literal("image"), image: MESSAGE_MEDIA, caption: z.string().meta(TEXT).optional() }),
  z.object({ type: z.literal("video"), video: MESSAGE_MEDIA, caption: z.string().meta(TEXT).optional() }),
  z.object({
    type: z.literal("document"),
    document: MESSAGE_MEDIA,
    caption: z.string().meta(TEXT).optional(),
  }),
  z.object({
    type: z.literal("location"),
    location: z.object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().meta(TEXT),
      address: z.string().meta(TEXT),
    }),
  }),
  z.object({ type: z.literal("contacts"), contacts: z.array(CONTACT_OBJECT).min(1) }),
  z.object({ type: z.literal("interactive"), interactive: LIST_INTERACTIVE }),
  z.object({ type: z.literal("interactive"), interactive: BUTTON_INTERACTIVE }),
  z.object({ type: z.literal("interactive"), interactive: LOCATION_REQUEST_INTERACTIVE }),
]);

const MESSAGE_BRANCH = z.object({
  id: z.string(),
  label: z.string(),
  condition: z.string().optional(),
  sourceButton: z.record(z.string(), z.unknown()).optional(),
  isCatchAll: z.boolean().optional(),
  isNoResponse: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(MAX_NO_RESPONSE_MINUTES).optional(),
});

const ACTION_INTENT = z.enum(["none", "location_request", "branches"]);

export const BUSINESS_MESSAGE_CONFIG_SCHEMA = z.object({
  daysCount: z.number().int().min(1).max(10).optional().describe("Number of date rows to offer, 1 to 10. Default 10."),
  dateFormat: z.enum(PLACEHOLDER_DATE_FORMATS).optional().describe("How each offered date is displayed. Default DD-MM-YYYY."),
  excludeWeekends: z.boolean().optional().describe("Skip Fridays and Saturdays when counting days. Default false."),
  startFromTomorrow: z.boolean().optional().describe("Start from tomorrow instead of today. Default true."),
  discountValue: z.number().min(1).max(100).optional().describe("Discount amount, 1 to 100. Default 10."),
  discountType: z.enum(["percentage", "fixed"]).optional().describe("percentage or fixed. Default percentage."),
  cancelCauses: z
    .array(
      z.object({
        id: uuidField(idDescription("Cancel cause id.", TOOL.cancelCauses.list)).meta({
          lookupTool: TOOL.cancelCauses.list,
          lookupNote: "Use `id` from the row.",
        }),
        name: z.string(),
      }),
    )
    .min(1)
    .max(10)
    .optional()
    .meta({
      label: "Cancel causes",
      description: "1 to 10 cancel causes to offer as list rows.",
      lookupTool: TOOL.cancelCauses.list,
    }),
});

export const CUSTOM_MESSAGE_CONFIG = z.object({
  messageMode: z.literal("custom"),
  messageType: z.enum(CUSTOM_MESSAGE_TYPES).meta({
    label: "Message type",
    description: "Custom message type. messageData must match this type.",
  }),
  messageData: CUSTOM_MESSAGE_DATA,
  recipientNumber: z.string().optional().meta({
    label: "Recipient Number",
    description: "Phone number to send to. Empty uses the order phone number.",
  }),
  actionIntent: ACTION_INTENT.optional(),
  branches: z.array(MESSAGE_BRANCH).optional(),
  noResponseMinutes: z.number().int().min(1).max(MAX_NO_RESPONSE_MINUTES).optional(),
});

export interface BusinessMessageInput {
  messageMode: "business";
  businessUseCase: BusinessMessageUseCase;
  businessConfig?: z.infer<typeof BUSINESS_MESSAGE_CONFIG_SCHEMA>;
  recipientNumber?: string;
  actionIntent?: z.infer<typeof ACTION_INTENT>;
  branches?: z.infer<typeof MESSAGE_BRANCH>[];
  noResponseMinutes?: number;
}

interface BusinessMessageDefinition {
  messageType: "list" | "interactive";
  businessCommand: string;
  defaultConfig: Record<string, unknown>;
}

export const BUSINESS_MESSAGE_DEFINITIONS: Record<BusinessMessageUseCase, BusinessMessageDefinition> = {
  order_postpone_date: {
    messageType: "list",
    businessCommand: "order.set_postponed_date",
    defaultConfig: { daysCount: 10, dateFormat: POSTPONE_ID_FORMAT, excludeWeekends: false },
  },
  order_discount_offer: {
    messageType: "interactive",
    businessCommand: "order.apply_discount",
    defaultConfig: { discountValue: 10, discountType: "percentage" },
  },
  order_payment_method: {
    messageType: "interactive",
    businessCommand: "order.set_payment_method",
    defaultConfig: {},
  },
  order_cancel_cause: {
    messageType: "list",
    businessCommand: "order.set_cancel_cause",
    defaultConfig: { cancelCauses: [] },
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildPostponeRows(config: Record<string, any>) {
  const daysCount = clamp(Number(config.daysCount) || 10, 1, 30);
  const excludeWeekends = !!config.excludeWeekends;
  const startFromTomorrow = config.startFromTomorrow !== false;
  const dateFormat = config.dateFormat || POSTPONE_ID_FORMAT;
  const start = startFromTomorrow ? 1 : 0;
  const rows = [];
  for (let offset = start; offset < start + daysCount; offset++) {
    const token = `{{global.date.${offset}.${dateFormat}}}`;
    rows.push({
      id: `__date_{{global.date.${offset}.${POSTPONE_ID_FORMAT}}}__`,
      title: token,
      description: `Delivery at ${token}`,
    });
  }
  return rows;
}

function buildCancelCauseRows(config: Record<string, any>) {
  const causes = Array.isArray(config.cancelCauses) ? config.cancelCauses.slice(0, 10) : [];
  return causes.map((cause: any) => {
    const name = String(cause?.name || "").trim() || String(cause?.id || "");
    return {
      id: `__cancel_cause_${cause.id}__`,
      title: name.slice(0, 24),
      description: "",
    };
  });
}

function discountText(base: string, value: number, isPercentage: boolean) {
  return isPercentage
    ? base.replace(/\{\{discountValue\}\}/g, String(value))
    : base.replace(/\{\{discountValue\}\}\s*%/g, String(value));
}

export function buildBusinessMessageData(
  businessUseCase: BusinessMessageUseCase,
  businessConfig: Record<string, any> = {},
): Record<string, any> {
  switch (businessUseCase) {
    case "order_postpone_date":
      return {
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "Choose a new delivery date" },
          body: { text: "Please choose a new delivery date for your order {{orderNumber}}." },
          footer: { text: "We will update your order once you choose." },
          action: {
            button: "Choose a date",
            sections: [{ title: "Available dates", rows: buildPostponeRows(businessConfig) }],
          },
        },
      };

    case "order_discount_offer": {
      const value = Number(businessConfig.discountValue) || 10;
      const isPercentage = businessConfig.discountType !== "fixed";
      return {
        type: "interactive",
        interactive: {
          type: "button",
          header: { type: "text", text: "Special Discount for You" },
          body: { text: discountText("Get {{discountValue}}% off your order!", value, isPercentage) },
          footer: { text: "Offer valid today only." },
          action: {
            buttons: [
              { type: "reply", reply: { id: "btn_0", title: "Accept Offer" } },
              { type: "reply", reply: { id: "btn_1", title: "Not now" } },
            ],
          },
        },
      };
    }

    case "order_payment_method":
      return {
        type: "interactive",
        interactive: {
          type: "button",
          header: { type: "text", text: "Choose payment method" },
          body: { text: "How would you like to pay for your order?" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "btn_0", title: "Cash on delivery" } },
              { type: "reply", reply: { id: "btn_1", title: "E-Wallet" } },
              { type: "reply", reply: { id: "btn_2", title: "Credit Card" } },
            ],
          },
        },
      };

    case "order_cancel_cause":
      return {
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "Cancel order" },
          body: { text: "Please choose a reason for cancelling order {{orderNumber}}." },
          action: {
            button: "Choose a reason",
            sections: [{ title: "Cancel reasons", rows: buildCancelCauseRows(businessConfig) }],
          },
        },
      };

    default:
      throw new Error(`Unknown business message use case: ${businessUseCase}`);
  }
}

function appendNoResponseBranch(
  branches: BusinessMessageInput["branches"],
  noResponseMinutes?: number,
) {
  const next = (branches || []).filter((branch) => !branch.isNoResponse);
  if (noResponseMinutes && noResponseMinutes > 0) {
    next.push({
      id: "no_response",
      label: "No response",
      isNoResponse: true,
      timeoutMinutes: noResponseMinutes,
    });
  }
  return next;
}

export function buildBusinessMessageConfig(input: BusinessMessageInput) {
  const definition = BUSINESS_MESSAGE_DEFINITIONS[input.businessUseCase];
  if (!definition) {
    throw new Error(`Unknown business message use case: ${input.businessUseCase}`);
  }
  const businessConfig = { ...definition.defaultConfig, ...(input.businessConfig || {}) };
  const branches = appendNoResponseBranch(input.branches, input.noResponseMinutes);
  return {
    messageMode: "business" as const,
    messageType: definition.messageType,
    businessUseCase: input.businessUseCase,
    businessCommand: definition.businessCommand,
    businessConfig,
    messageData: buildBusinessMessageData(input.businessUseCase, businessConfig),
    recipientNumber: input.recipientNumber ?? "",
    ...(input.actionIntent ? { actionIntent: input.actionIntent } : {}),
    ...(branches.length ? { branches } : {}),
  };
}

export const BUSINESS_MESSAGE_CONFIG = z
  .object({
    messageMode: z.literal("business"),
    businessUseCase: z.enum(BUSINESS_MESSAGE_USE_CASES).meta({
      label: "Business ready message",
      description: "Ready-made flow. messageData is generated server-side; only businessConfig is editable.",
    }),
    businessConfig: BUSINESS_MESSAGE_CONFIG_SCHEMA.optional(),
    recipientNumber: z.string().optional(),
    actionIntent: ACTION_INTENT.optional(),
    branches: z.array(MESSAGE_BRANCH).optional(),
    noResponseMinutes: z.number().int().min(1).max(MAX_NO_RESPONSE_MINUTES).optional(),
  })
  .transform((value) => buildBusinessMessageConfig(value as BusinessMessageInput));

export const SEND_WHATSAPP_MESSAGE_CONFIG = z.union([
  CUSTOM_MESSAGE_CONFIG,
  BUSINESS_MESSAGE_CONFIG,
]);
