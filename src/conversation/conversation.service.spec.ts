import { vi } from "vitest";

vi.mock("entities/whatsapp.entity", () => ({
  ConversationEntity: class {},
  WhatsappMessageEntity: class {},
  ConversationAiMode: {},
  ConversationStatus: { OPEN: "open", ARCHIVED: "archived" },
  MessageDirection: {},
  WhatsappMessageType: { REACTION: "reaction" },
}));
vi.mock("entities/customers.entity", () => ({ CustomerEntity: class {} }));
vi.mock("dto/whatsapp.dto", () => ({ CreateConversationDto: class {} }));
vi.mock("../customer/customer.service", () => ({ CustomerService: class {} }));
vi.mock("common/app.gateway", () => ({ AppGateway: class {} }));
vi.mock("src/category/category.service", () => ({
  tenantId: (me: any) => (me?.role?.name === "admin" ? me.id : me?.adminId),
}));
vi.mock("common/translation.service", () => ({
  TranslationService: class {},
  RequestTranslationService: class {},
}));
vi.mock("src/queue/queues/agent-turn.queue", () => ({ AgentTurnQueueService: class {} }));
vi.mock("src/notifications/notification.service", () => ({ NotificationService: class {} }));
vi.mock("entities/notifications.entity", () => ({ NotificationType: {} }));
vi.mock("src/issue/issue.service", () => ({ IssueService: class {} }));
vi.mock("entities/agent.entity", () => ({ AgentEntity: class {} }));
vi.mock("entities/issue.entity", () => ({ IssuePriority: {} }));

describe("ConversationService contact/conversation statistics", () => {
  it("uses tenant-scoped non-reaction queries and normalizes numeric results", async () => {
    const { ConversationService } = await import("./conversation.service");
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          contacts: {
            total: "8",
            new: "2",
            withConversation: "6",
          },
          conversations: {
            total: "7",
            withMessages: "5",
            unreadMessages: "4",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          date: "2026-10-24",
          newContacts: "2",
          newConversations: "1",
          activeConversations: "3",
        },
      ]);
    const service = new ConversationService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { query } as any,
      { t: (key: string) => key } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getContactConversationStats(
      { id: "tenant-1", role: { name: "admin" } },
      {
        startDate: new Date("2026-10-01T00:00:00.000Z"),
        endDate: new Date("2026-10-31T23:59:59.999Z"),
      },
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('m."messageType" <> $4');
    expect(query.mock.calls[0][0]).toContain('m."adminId" = $1');
    expect(query.mock.calls[0][1]).toHaveLength(7);
    expect(query.mock.calls[1][1]).toHaveLength(4);
    expect(result).toEqual({
      contacts: { total: 8, new: 2, withConversation: 6 },
      conversations: { total: 7, withMessages: 5, unreadMessages: 4 },
      trend: [
        {
          date: "2026-10-24",
          newContacts: 2,
          newConversations: 1,
          activeConversations: 3,
        },
      ],
    });
  });
});
