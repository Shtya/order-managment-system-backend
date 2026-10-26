import { describe, expect, test, vi } from "vitest";

vi.mock("redis", () => ({
  createClient: () => ({
    connect: vi.fn(),
    sIsMember: vi.fn(),
    incr: vi.fn(),
    sAdd: vi.fn(),
    sMembers: vi.fn(),
    decr: vi.fn(),
    del: vi.fn(),
    sRem: vi.fn(),
  }),
}));
vi.mock("entities/user.entity", () => ({
  User: class {},
  WhatsappAccessMode: { ALL: "all", SELECTED: "selected" },
}));
vi.mock("entities/notifications.entity", () => ({ Notification: class {} }));
vi.mock("entities/support_tickets.entity", () => ({
  SupportTicketEntity: class {},
  SupportTicketMessageEntity: class {},
}));
vi.mock("entities/issue.entity", () => ({
  IssueEntity: class {},
  IssueMessageEntity: class {},
}));
vi.mock("entities/order.entity", () => ({ OrderInternalNoteEntity: class {} }));
vi.mock("entities/whatsapp.entity", () => ({
  ConversationEntity: class {},
  UserWhatsappAccountAccessEntity: class {},
  WhatsappMessageEntity: class {},
}));
vi.mock("entities/customers.entity", () => ({ CustomerEntity: class {} }));

import { AppGateway } from "./app.gateway";

void AppGateway.prototype.refreshWhatsappAccess;

describe("refreshWhatsappAccess", () => {
  test("updates only sockets owned by the requested user", async () => {
    const targetSocket = {
      data: { user: { id: "admin-1" } },
      rooms: new Set(["socket-admin", "whatsapp_account_old"]),
      leave: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
    };
    const employeeSocket = {
      data: { user: { id: "employee-1" } },
      rooms: new Set(["socket-employee", "whatsapp_account_employee"]),
      leave: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new AppGateway(
      {} as any,
      { get: () => ({ host: "localhost", port: 6379, db: 0 }) } as any,
      {
        findOne: vi.fn().mockResolvedValue({
          id: "admin-1",
          role: { name: "admin" },
          whatsappAccessMode: "all",
        }),
      } as any,
      { find: vi.fn() } as any,
      {} as any,
    );
    gateway.server = {
      in: vi.fn().mockReturnValue({
        fetchSockets: vi.fn().mockResolvedValue([targetSocket, employeeSocket]),
      }),
    } as any;

    await gateway.refreshWhatsappAccess("admin-1");

    expect(targetSocket.leave).toHaveBeenCalledWith("whatsapp_account_old");
    expect(targetSocket.join).toHaveBeenCalledWith("whatsapp_owner_admin-1");
    expect(employeeSocket.leave).not.toHaveBeenCalled();
    expect(employeeSocket.join).not.toHaveBeenCalled();
  });
});
