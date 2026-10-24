import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { User } from "entities/user.entity";
import { ConversationService } from "src/conversation/conversation.service";
import { CustomerService } from "src/customer/customer.service";
import { z } from "zod";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import {
  listPaging,
  parseSearchInput,
  searchInput,
} from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import {
  BUSINESS_TZ,
  TREND_RANGES,
  businessDayRange,
  isoDateField,
  resolveQuickRange,
  uuidField,
} from "../utils/mcp-date.util";

const searchContactsInput = searchInput(
  "contact",
  {
    ...listPaging({
      items: "contacts",
      sortBy: ["createdAt", "updatedAt", "name", "phoneNumber"],
      defaultSortBy: "createdAt",
      search: "Matches contact name or phone number.",
    }),
    accountId: uuidField(
      idDescription(
        "WhatsApp account id. Returns contacts that have at least one message through this account.",
        TOOL.whatsapp.accountsSearch,
      ),
    ).optional(),
  },
  TOOL.contacts.search,
);

const statsDateField = (label: string) =>
  z
    .union([
      isoDateField(`${label}, ISO date (YYYY-MM-DD).`),
      z.string().datetime({ offset: true }),
    ])
    .describe(
      `${label}. Use YYYY-MM-DD for a Cairo calendar day, or an ISO date-time with timezone.`,
    );

const contactsStatsInput = z.strictObject({
  range: z
    .enum(TREND_RANGES)
    .optional()
    .describe(
      `Quick period. One of: ${TREND_RANGES.join(", ")}. Omit dates and range for all-time statistics.`,
    ),
  startDate: statsDateField("Period start").optional(),
  endDate: statsDateField("Period end").optional(),
});

export function resolveContactStatsPeriod(
  input: z.infer<typeof contactsStatsInput>,
) {
  const hasRange = Boolean(input.range);
  const hasStart = Boolean(input.startDate);
  const hasEnd = Boolean(input.endDate);

  if (hasRange && (hasStart || hasEnd)) {
    throw new RpcException(
      "Pass either `range` or `startDate`/`endDate`, not both.",
    );
  }
  if (hasStart !== hasEnd) {
    throw new RpcException(
      "Custom periods require both `startDate` and `endDate`.",
    );
  }

  const source: "all_time" | "range" | "custom" = hasRange
    ? "range"
    : hasStart
      ? "custom"
      : "all_time";
  const range = input.range;

  let startDate: Date | undefined;
  let endDate: Date | undefined;
  if (range) {
    const resolved = resolveQuickRange(range);
    const dates = businessDayRange(resolved.startDate, resolved.endDate);
    startDate = dates.start!;
    endDate = dates.end!;
  } else if (hasStart) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    startDate = dateOnly.test(input.startDate!)
      ? businessDayRange(input.startDate).start!
      : new Date(input.startDate!);
    endDate = dateOnly.test(input.endDate!)
      ? businessDayRange(undefined, input.endDate).end!
      : new Date(input.endDate!);
  }

  if (startDate && endDate && startDate > endDate) {
    throw new RpcException("`startDate` is after `endDate`. Swap them.");
  }

  return {
    startDate,
    endDate,
    period: {
      startDate: startDate?.toISOString() ?? null,
      endDate: endDate?.toISOString() ?? null,
      timezone: BUSINESS_TZ,
      source,
    },
  };
}

function toContactSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    phoneNumber: row.phoneNumber ?? null,
    profilePicture: row.profilePicture ?? null,
    notes: row.notes ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    ordersCount: Number(row.ordersCount ?? 0),
    client: row.client
      ? { id: row.client.id, name: row.client.name ?? null }
      : null,
    conversation: row.conversation
      ? {
          id: row.conversation.id,
          status: row.conversation.status ?? null,
          lastMessageAt: row.conversation.lastMessageAt ?? null,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOneContactDto(row: any) {
  return {
    id: row.id,
    adminId: row.adminId,
    waId: row.waId,
    phoneNumber: row.phoneNumber,
    name: row.name ?? null,
    profilePicture: row.profilePicture ?? null,
    notes: row.notes ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    metadata: row.metadata ?? null,
    clientId: row.clientId ?? null,
    client: row.client
      ? {
          id: row.client.id,
          name: row.client.name ?? null,
          primaryContactId: row.client.primaryContactId ?? null,
        }
      : null,
    conversation: row.conversation
      ? {
          id: row.conversation.id,
          status: row.conversation.status ?? null,
          accountId: row.conversation.accountId ?? null,
          lastMessageId: row.conversation.lastMessageId ?? null,
          lastMessageAt: row.conversation.lastMessageAt ?? null,
          unreadCount: row.conversation.unreadCount ?? null,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpContactsTools {
  constructor(
    private readonly customers: CustomerService,
    private readonly conversations: ConversationService,
  ) {}

  @McpReadTool({
    name: TOOL.contacts.search,
    description:
      "Search contacts or fetch one. Contacts are stored internally as customers (CustomerEntity), so contact id and customerId mean the same id. Without `id`: paged contact summaries; search matches name or phone, and accountId keeps contacts with at least one message through that WhatsApp account. With `id`: returns full contact/customer details. Use the returned id as customerId in whatsapp_messages_search. Use contacts_stats for aggregate contact and conversation activity. Read-only.",
    parameters: searchContactsInput,
  })
  async searchContacts(
    @Payload() input: z.infer<typeof searchContactsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "contact");
    if (req.mode === "get") {
      return toolJson(
        toOneContactDto(
          await this.customers.findOne(user, req.id, {
            includeRelations: true,
          }),
        ),
      );
    }

    const result = await this.customers.findAllPaginated(user, {
      ...req.query,
      sortDir: req.query.sortOrder,
    });
    return toolPage("contacts", result, toContactSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.contacts.stats,
    description:
      "Contact and WhatsApp conversation statistics. Contacts are stored as customers, so contact id and customerId mean the same id. Returns contact/conversation totals, new and active counts, and a continuous daily trend. A new conversation is dated by its first non-reaction message. Accepts a quick range or startDate/endDate as dates or ISO date-times; omitting them returns all-time statistics. Read-only.",
    parameters: contactsStatsInput,
  })
  async getContactStats(
    @Payload() input: z.infer<typeof contactsStatsInput>,
    @McpUser() user: User,
  ) {
    const { startDate, endDate, period } = resolveContactStatsPeriod(input);
    return toolJson({
      period,
      definitions: {
        conversations: {
          new: "Conversations whose first non-reaction message occurred during the selected period. Every new conversation is also active.",
          active:
            "Distinct conversations with any non-reaction message during the selected period, including conversations that started before the period.",
        },
      },
      ...(await this.conversations.getContactConversationStats(
        user,
        startDate && endDate ? { startDate, endDate } : undefined,
      )),
    });
  }
}
