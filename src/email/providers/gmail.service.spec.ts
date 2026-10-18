vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
const translations = { t: (key: string) => key } as any;
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("entities/user.entity", () => ({ User: class {} }));
import { GmailService } from "./gmail.service";

describe("Gmail authorization boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  function service() {
    return new GmailService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      translations,
    );
  }
  it("rejects malformed state before accessing persistence", async () => {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
    await expect(
      service().callback("bad-state", "cookie", "code"),
    ).rejects.toThrow("domains.email.invalid_oauth_state");
  });
  function transferFixture(
    status: string,
    credentials: any = null,
    options: { sameOwner?: boolean; stateAccountId?: string } = {},
  ) {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
    vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
    const previous = {
      id: "old-account",
      adminId: options.sameOwner ? "new-tenant" : "old-tenant",
      ownerId: options.sameOwner ? "new-owner" : "old-owner",
      status,
      credentials,
    };
    const query: any = {};
    for (const method of [
      "addSelect",
      "setLock",
      "where",
      "delete",
      "returning",
    ])
      query[method] = () => query;
    query.getOne = async () => previous;
    query.execute = async () => ({
      raw: [
        {
          ownerId: "new-owner",
          adminId: "new-tenant",
          nonce: "nonce",
          verifier: "verifier",
          returnTo: "/integrations",
          accountId: options.stateAccountId || null,
        },
      ],
    });
    const accounts = {
      createQueryBuilder: () => query,
      update: vi.fn(),
      create: (value: any) => value,
      save: vi.fn(async (value: any) => ({ id: "new-account", ...value })),
    };
    const managerQuery = vi.fn(async () => []);
    const encryption = {
      encrypt: vi.fn(() => ({ ciphertext: "new-token" })),
      decrypt: vi.fn(() => JSON.stringify({ refreshToken: "old-refresh" })),
    };
    const gmail = new GmailService(
      {} as any,
      { createQueryBuilder: () => query } as any,
      {
        context: () => ({ adminId: "new-tenant", actorId: "new-owner" }),
      } as any,
      encryption as any,
      {
        getRepository: () => ({ findOne: async () => ({ isActive: true }) }),
        transaction: async (fn: any) =>
          fn({ getRepository: () => accounts, query: managerQuery }),
      } as any,
      translations,
    );
    vi.spyOn(gmail as any, "client").mockReturnValue({
      getToken: async () => ({
        tokens: {
          refresh_token: "fresh-token",
          id_token: "identity",
          scope: "openid email https://www.googleapis.com/auth/gmail.send",
        },
      }),
      verifyIdToken: async () => ({
        getPayload: () => ({
          nonce: "nonce",
          email_verified: true,
          sub: "google-subject",
          email: "sender@example.com",
        }),
      }),
    });
    return { gmail, accounts, encryption, managerQuery };
  }
  it.each(["disconnected", "revocation_failed"])(
    "keeps permanent ownership of a %s mailbox",
    async (status) => {
      const f = transferFixture(status);
      await expect(
        f.gmail.callback("a".repeat(64), "binding", "code"),
      ).rejects.toThrow("domains.email.account_already_connected");
      expect(f.accounts.update).not.toHaveBeenCalled();
      expect(f.accounts.save).not.toHaveBeenCalled();
      expect(f.encryption.decrypt).not.toHaveBeenCalled();
      expect(f.managerQuery).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["connected", null],
    ["reconnect_required", null],
    ["suspended", null],
    ["revocation_pending", { ciphertext: "old-token" }],
    ["disconnected", { ciphertext: "old-token" }],
  ])(
    "rejects transfer of a %s mailbox before credentials are released",
    async (status, credentials) => {
      const f = transferFixture(status, credentials);
      await expect(
        f.gmail.callback("a".repeat(64), "binding", "code"),
      ).rejects.toThrow("domains.email.account_already_connected");
      expect(f.accounts.update).not.toHaveBeenCalled();
      expect(f.accounts.save).not.toHaveBeenCalled();
    },
  );
  it("allows reconnect to resolve to another mailbox already owned by the same user", async () => {
    const f = transferFixture(
      "connected",
      { ciphertext: "old", iv: "iv", tag: "tag" },
      { sameOwner: true, stateAccountId: "different-account" },
    );
    const result = await f.gmail.callback("a".repeat(64), "binding", "code");
    expect(result).toContain("accountId=old-account");
    expect(f.accounts.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "old-account",
        adminId: "new-tenant",
        ownerId: "new-owner",
        status: "connected",
      }),
    );
  });
  it("rejects external redirect paths before requesting Google authorization", async () => {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
    vi.stubEnv("EMAIL_GMAIL_ENABLED", "true");
    await expect(
      service().connect(
        { adminId: "tenant", actorId: "actor" },
        "//evil.example",
      ),
    ).rejects.toThrow("domains.email.invalid_return_path");
  });
  it("rejects replayed or expired state even with a cookie", async () => {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
    const query: any = {};
    for (const key of ["delete", "where", "returning"])
      query[key] = () => query;
    query.execute = async () => ({ raw: [] });
    const gmail = new GmailService(
      {} as any,
      { createQueryBuilder: () => query } as any,
      {} as any,
      {} as any,
      {} as any,
      translations,
    );
    await expect(
      gmail.callback("a".repeat(64), "binding", "code"),
    ).rejects.toThrow("domains.email.invalid_oauth_state");
  });
  it("consumes browser handoff tickets exactly once before binding the callback cookie", async () => {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    vi.stubEnv("BACKEND_URL", "https://api.example.com");
    const query: any = {};
    for (const key of ["update", "set", "where", "returning"])
      query[key] = vi.fn(() => query);
    query.execute = vi
      .fn()
      .mockResolvedValueOnce({
        raw: [{ verifier: "verifier", nonce: "nonce" }],
      })
      .mockResolvedValueOnce({ raw: [] });
    const gmail = new GmailService(
      {} as any,
      { createQueryBuilder: () => query } as any,
      {} as any,
      {} as any,
      {} as any,
      translations,
    );
    const result = await gmail.beginBrowserAuthorization(
      "a".repeat(64),
      "b".repeat(64),
    );
    expect(result.binding).toMatch(/^[a-f0-9]{64}$/);
    expect(new URL(result.authorizationUrl).hostname).toBe(
      "accounts.google.com",
    );
    expect(query.where.mock.calls[0][1].ticket).toMatch(
      /^pending:[a-f0-9]{64}$/,
    );
    await expect(
      gmail.beginBrowserAuthorization("a".repeat(64), "b".repeat(64)),
    ).rejects.toThrow("domains.email.invalid_oauth_state");
  });
  it("rejects non-origin frontend configuration", () => {
    vi.stubEnv("FRONTEND_URL", "https://example.com/unsafe-path");
    expect(() => service().frontendOrigin()).toThrow(
      "domains.email.invalid_frontend_origin",
    );
  });
  it("derives the Google callback from BACKEND_URL and preserves its API prefix", async () => {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
    vi.stubEnv("EMAIL_GMAIL_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    vi.stubEnv("BACKEND_URL", "https://api.example.com/api///");
    const gmail = new GmailService(
      {} as any,
      { create: (value) => value, save: async (value) => value } as any,
      {} as any,
      {} as any,
      {} as any,
      translations,
    );
    const result = await gmail.connect({ adminId: "tenant", actorId: "actor" });
    expect(
      new URL(result.authorizationUrl).searchParams.get("redirect_uri"),
    ).toBe("https://api.example.com/api/email/accounts/gmail/callback");
  });
});
