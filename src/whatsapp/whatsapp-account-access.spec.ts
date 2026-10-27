import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, test, vi } from "vitest";

vi.mock("entities/user.entity", () => ({
  SystemRole: { ADMIN: "admin", SUPER_ADMIN: "super_admin" },
  WhatsappAccessMode: { ALL: "all", SELECTED: "selected" },
}));
vi.mock("entities/whatsapp.entity", () => ({
  UserWhatsappAccountAccessEntity: class {},
  WhatsappAccountEntity: class {},
}));
vi.mock("src/category/category.service", () => ({
  tenantId: (me: any) => (me?.role?.name === "admin" ? me.id : me?.adminId),
}));

import {
  allowedAccountIds,
  assertWhatsappAccountAccess,
} from "./whatsapp-account-access";

const limitedUser = {
  id: "user-1",
  adminId: "admin-1",
  role: { name: "user" },
  whatsappAccessMode: "selected",
};

void allowedAccountIds;

describe("allowedAccountIds", () => {
  test("returns null for a user with full account access", async () => {
    const accessRepo = { find: vi.fn() };

    const result = await allowedAccountIds(
      { id: "admin-1", role: { name: "admin" } },
      accessRepo as any,
    );

    expect(result).toBeNull();
  });

  test("returns assigned account IDs for a limited user", async () => {
    const accessRepo = {
      find: vi.fn().mockResolvedValue([
        { whatsappAccountId: "account-1" },
        { whatsappAccountId: "account-2" },
      ]),
    };

    const result = await allowedAccountIds(limitedUser, accessRepo as any);

    expect(result).toEqual(["account-1", "account-2"]);
  });
});

void assertWhatsappAccountAccess;

describe("assertWhatsappAccountAccess", () => {
  test("allows an assigned WhatsApp account", async () => {
    const accessRepo = {
      find: vi.fn().mockResolvedValue([{ whatsappAccountId: "account-1" }]),
    };

    await expect(
      assertWhatsappAccountAccess({
        me: limitedUser,
        accountId: "account-1",
        accessRepo: accessRepo as any,
        accountRepo: {} as any,
        notFoundMessage: "not found",
        forbiddenMessage: "forbidden",
      }),
    ).resolves.toBeUndefined();
  });

  test("throws forbidden when the account exists without user access", async () => {
    const accessRepo = { find: vi.fn().mockResolvedValue([]) };
    const accountRepo = { exists: vi.fn().mockResolvedValue(true) };

    await expect(
      assertWhatsappAccountAccess({
        me: limitedUser,
        accountId: "account-1",
        accessRepo: accessRepo as any,
        accountRepo: accountRepo as any,
        notFoundMessage: "not found",
        forbiddenMessage: "forbidden",
      }),
    ).rejects.toEqual(new ForbiddenException("forbidden"));
  });

  test("throws not found when the account does not exist for the tenant", async () => {
    const accessRepo = { find: vi.fn().mockResolvedValue([]) };
    const accountRepo = { exists: vi.fn().mockResolvedValue(false) };

    await expect(
      assertWhatsappAccountAccess({
        me: limitedUser,
        accountId: "missing-account",
        accessRepo: accessRepo as any,
        accountRepo: accountRepo as any,
        notFoundMessage: "not found",
        forbiddenMessage: "forbidden",
      }),
    ).rejects.toEqual(new NotFoundException("not found"));
  });
});
