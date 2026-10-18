vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
const translations = { t: (key: string) => key } as any;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("entities/user.entity", () => ({ User: class {} }));
import { EmailService } from "./email.service";
import { EmailDeferredError, EmailProviderError } from "./email.types";

describe("provider-neutral email dispatch", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_FEATURE_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("queues version 2 content and retains its assets in one transaction", async () => {
    let stored: any,
      active = false,
      committed = false;
    const builder: any = {};
    for (const key of ["insert", "orIgnore"]) builder[key] = () => builder;
    builder.values = (value: any) => {
      stored = { id: "m1", ...value };
      return builder;
    };
    builder.execute = async () => ({});
    const repo: any = {
      createQueryBuilder: () => builder,
      findOneByOrFail: async () => stored,
    };
    const manager: any = { getRepository: () => repo };
    const data: any = {
      transaction: async (run: any) => {
        active = true;
        try {
          const result = await run(manager);
          committed = true;
          return result;
        } finally {
          active = false;
        }
      },
    };
    const assets = {
      retain: vi.fn(async (_admin, _ids, reason, transaction) => {
        expect(active).toBe(true);
        expect(transaction).toBe(manager);
        expect(reason).toBe("queued");
      }),
    };
    const service = new EmailService(
      repo,
      data,
      { get: async () => ({ email: "sender@example.com" }) } as any,
      { validate: () => {}, render: async () => ({}) } as any,
      {} as any,
      [],
      translations,
      assets as any,
    );
    const input: any = {
      accountId: "account",
      to: "recipient@example.com",
      purpose: "test",
      idempotencyKey: "one",
      source: { type: "test" },
      content: {
        subject: "Hello",
        businessIdentity: "Store",
        document: {
          schemaVersion: 2,
          blocks: [
            {
              id: "s",
              type: "section",
              children: [
                {
                  id: "c",
                  type: "column",
                  children: [
                    {
                      id: "i",
                      type: "image",
                      assetId: "11111111-1111-4111-8111-111111111111",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    await service.enqueue({ adminId: "tenant", actorId: "actor" }, input);
    expect(committed).toBe(true);
    expect(assets.retain).toHaveBeenCalledWith(
      "tenant",
      ["11111111-1111-4111-8111-111111111111"],
      "queued",
      manager,
    );
    committed = false;
    assets.retain.mockRejectedValueOnce(new Error("asset unavailable"));
    await expect(
      service.enqueue(
        { adminId: "tenant", actorId: "actor" },
        { ...input, idempotencyKey: "two" },
      ),
    ).rejects.toThrow("asset unavailable");
    expect(committed).toBe(false);
  });
  it("returns the original submission for the same key and rejects changed content", async () => {
    let stored: any;
    const builder: any = {};
    for (const key of ["insert", "orIgnore"]) builder[key] = () => builder;
    builder.values = (data: any) => {
      if (!stored) stored = { id: "m1", ...data };
      return builder;
    };
    builder.execute = async () => ({});
    const repo: any = {
      createQueryBuilder: () => builder,
      findOneByOrFail: async () => stored,
    };
    const accounts: any = {
      get: async () => ({ email: "sender@example.com" }),
    };
    const content: any = { validate: () => {}, render: async () => ({}) };
    const service = new EmailService(
      repo,
      {} as any,
      accounts,
      content,
      {} as any,
      [],
      translations,
    );
    const request: any = {
      accountId: "a1",
      to: "mona@example.com",
      content: { subject: "Hello" },
      purpose: "test",
      idempotencyKey: "same-key",
      source: { type: "test-caller" },
    };
    const ctx = { adminId: "tenant", actorId: "actor" };
    expect((await service.submit(ctx, request)).id).toBe("m1");
    expect((await service.submit(ctx, request)).id).toBe("m1");
    await expect(
      service.submit(ctx, { ...request, content: { subject: "Changed" } }),
    ).rejects.toThrow("domains.email.idempotency_conflict");
  });
  function setup(status = "queued") {
    const message: any = {
      id: "m1",
      adminId: "tenant",
      actorId: "actor",
      accountId: "account",
      status,
      attempts: 0,
      recipient: "mona@example.com",
      request: { purpose: "marketing", content: {}, variables: {} },
    };
    const qb: any = {};
    for (const method of ["addSelect", "where"]) qb[method] = vi.fn(() => qb);
    qb.getOneOrFail = vi.fn(async () => message);
    const repo = {
      createQueryBuilder: vi.fn(() => qb),
      findOneByOrFail: vi.fn(async () => message),
      update: vi.fn(async (_id: string, data: any) =>
        Object.assign(message, data),
      ),
      query: vi.fn(async (sql: string) =>
        sql.includes("MAX(") ? [{ last: null }] : [{ hourly: 0, daily: 0 }],
      ),
    };
    const runner = {
      connect: vi.fn(),
      release: vi.fn(),
      query: vi.fn(async () => [{ locked: true }]),
    };
    const dataSource: any = {
      createQueryRunner: () => runner,
      getRepository: () => ({
        findOne: async () => ({ isActive: true }),
        update: vi.fn(),
      }),
    };
    const accounts = {
      get: vi.fn(async () => ({
        id: "account",
        provider: "fake",
        email: "sender@example.com",
        status: "connected",
      })),
      context: () => ({ adminId: "tenant", actorId: "actor" }),
    };
    const content = {
      render: vi.fn(async () => ({
        subject: "Hello",
        html: "<p>Hello</p>",
        text: "Hello",
      })),
    };
    const policy = {
      eligibility: vi.fn(async () => null),
      unsubscribeUrl: () => "https://example.com/unsubscribe",
    };
    const provider = {
      key: "fake",
      send: vi.fn(async (_account: any, _message: any) => ({
        providerMessageId: "provider-1",
      })),
      revoke: vi.fn(),
    };
    const assets = { retain: vi.fn(async () => ({})) };
    const service = new EmailService(
      repo as any,
      dataSource,
      accounts as any,
      content as any,
      policy as any,
      [provider],
      translations,
      assets as any,
    );
    return {
      service,
      message,
      repo,
      runner,
      provider,
      accounts,
      policy,
      assets,
    };
  }
  it("sends through a second provider without Gmail or campaign dependencies", async () => {
    const f = setup();
    const result = await f.service.dispatch("m1");
    expect(result.status).toBe("accepted");
    expect(result.providerMessageId).toBe("provider-1");
    expect(f.provider.send.mock.calls[0][1].headers).toHaveProperty(
      "List-Unsubscribe-Post",
    );
    expect(f.runner.release).toHaveBeenCalled();
  });
  it("sends a test to another address without marketing unsubscribe headers", async () => {
    const f = setup();
    f.message.request.purpose = "test";
    expect((await f.service.dispatch("m1")).status).toBe("accepted");
    expect(f.provider.send.mock.calls[0][1].to).toBe("mona@example.com");
    expect(f.provider.send.mock.calls[0][1].headers).not.toHaveProperty(
      "List-Unsubscribe-Post",
    );
  });
  it("never resends an accepted message on job replay", async () => {
    const f = setup("accepted");
    await f.service.dispatch("m1");
    expect(f.provider.send).not.toHaveBeenCalled();
  });
  it("permanently pins message images before the provider attempt, even on uncertain outcomes", async () => {
    const f = setup();
    f.message.request.content.document = {
      schemaVersion: 2,
      blocks: [{ type: "image", assetId: "asset-id" }],
    };
    f.provider.send.mockImplementationOnce(async () => {
      expect(f.assets.retain).toHaveBeenCalledWith(
        "tenant",
        ["asset-id"],
        "permanent",
      );
      throw new EmailProviderError("unknown", "timeout");
    });
    expect((await f.service.dispatch("m1")).status).toBe("unknown");
    expect(f.assets.retain).toHaveBeenCalledTimes(1);
  });
  it("classifies interrupted sends as unknown without transmission", async () => {
    const f = setup("sending");
    expect((await f.service.dispatch("m1")).status).toBe("unknown");
    expect(f.provider.send).not.toHaveBeenCalled();
  });
  it("does not retry a possible remote acceptance after a network failure", async () => {
    const f = setup();
    f.provider.send.mockRejectedValue(
      new EmailProviderError("unknown", "timeout"),
    );
    expect((await f.service.dispatch("m1")).status).toBe("unknown");
    await f.service.dispatch("m1");
    expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it("checks suppression again at dispatch", async () => {
    const f = setup();
    f.policy.eligibility.mockResolvedValue("unsubscribed");
    expect((await f.service.dispatch("m1")).status).toBe("suppressed");
    expect(f.provider.send).not.toHaveBeenCalled();
  });
  it("defers quota errors without claiming acceptance", async () => {
    const f = setup();
    f.provider.send.mockRejectedValue(new EmailProviderError("quota", "limit"));
    await expect(f.service.dispatch("m1")).rejects.toBeInstanceOf(
      EmailDeferredError,
    );
    expect(f.message.status).toBe("queued");
    expect(f.message.acceptedAt).toBeUndefined();
  });
  it("defers disconnected accounts without sending", async () => {
    const f = setup();
    f.accounts.get.mockResolvedValue({
      id: "account",
      provider: "fake",
      email: "sender@example.com",
      status: "disconnected",
    });
    await expect(f.service.dispatch("m1")).rejects.toBeInstanceOf(
      EmailDeferredError,
    );
    expect(f.provider.send).not.toHaveBeenCalled();
  });
  it("returns a terminal failure for an immediate test instead of queueing it", async () => {
    const f = setup();
    f.accounts.get.mockResolvedValue({
      id: "account",
      provider: "fake",
      email: "sender@example.com",
      status: "reconnect_required",
    });
    const result = await f.service.dispatch("m1", { immediate: true });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("email.reconnect_required");
    expect(result.nextAttemptAt).toBeNull();
    expect(f.provider.send).not.toHaveBeenCalled();
  });
  it("fails a deferred message after five total dispatch attempts", async () => {
    const f = setup();
    f.message.dispatchAttempts = 4;
    f.accounts.get.mockResolvedValue({
      id: "account",
      provider: "fake",
      email: "sender@example.com",
      status: "reconnect_required",
    });
    const result = await f.service.dispatch("m1");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe(
      "attempts_exhausted:email.reconnect_required",
    );
    expect(result.dispatchAttempts).toBe(5);
    expect(f.provider.send).not.toHaveBeenCalled();
  });
});
