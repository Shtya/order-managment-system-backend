import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomBytes } from "crypto";
import { In, IsNull, Repository } from "typeorm";
import {
  MCP_SCOPES,
  McpScope,
  OAuthAuthRequest,
  OAuthClient,
  OAuthGrant,
  OAuthRefreshToken,
} from "entities/oauth.entity";
import { AuthService } from "src/auth/auth.service";
import { SystemRole } from "entities/user.entity";

export { MCP_SCOPES, McpScope };
 
const ACCESS_TTL_SEC = 12 * 60 * 60; // 12 hours
const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000; // 60 days, extended on every refresh
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000; // user has 10 min to log in + approve
const CODE_TTL_MS = 60 * 1000; // authorization code lives 60 s
const TOKEN_RATE_LIMIT = 30;
const TOKEN_RATE_WINDOW_MS = 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DEFAULT_TRUSTED_REDIRECT_HOSTS = [
  "chatgpt.com",
  "claude.ai",
  "anthropic.com",
];
 
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
const randomToken = () => randomBytes(32).toString("base64url");
 
export const oauthError = (error: string, description?: string) =>
  new BadRequestException({ error, error_description: description });
 
export interface McpAccessPayload {
  sub: string; // Madar user id (uuid)
  gid: string; // grant id (the "connection")
  cid: string; // client id
  scope: string; // space separated
}
 
@Injectable()
export class OAuthService {
  // Issuer = this backend. Resource = the MCP endpoint.
  readonly issuer = process.env.BACKEND_URL!;
  readonly resource = `${process.env.BACKEND_URL}/mcp`;
 
  constructor(
    @InjectRepository(OAuthClient) private clients: Repository<OAuthClient>,
    @InjectRepository(OAuthAuthRequest)
    private requests: Repository<OAuthAuthRequest>,
    @InjectRepository(OAuthGrant) private grants: Repository<OAuthGrant>,
    @InjectRepository(OAuthRefreshToken)
    private refreshTokens: Repository<OAuthRefreshToken>,
    private jwt: JwtService, // configured with MCP_JWT_SECRET (NOT your web JWT secret)
    private auth: AuthService,
  ) {}

  private readonly tokenHits = new Map<string, number[]>();
 
  // ───────────────────────── Discovery documents ─────────────────────────
 
  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Madar",
    };
  }
 
  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], // public clients + PKCE
      scopes_supported: MCP_SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  }
 
  // ─────────────── Dynamic Client Registration (RFC 7591) ───────────────
 
  async registerClient(body: any) {
    const uris: unknown = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
      throw oauthError("invalid_redirect_uri", "redirect_uris is required");
    }
    for (const u of uris) {
      if (typeof u !== "string" || !this.isAllowedRedirect(u)) {
        throw oauthError("invalid_redirect_uri", `Not allowed: ${u}`);
      }
    }
    const client = await this.clients.save(
      this.clients.create({
        name: String(body.client_name ?? "MCP client").slice(0, 100),
        redirectUris: uris as string[],
      }),
    );
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
 
  private isAllowedRedirect(uri: string) {
    try {
      const u = new URL(uri);
      if (u.protocol === "https:") return true;
      // loopback is allowed for desktop tools (Claude Code, MCP Inspector...)
      return (
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      );
    } catch {
      return false;
    }
  }
 
  // ─────────────── Step 1: GET /oauth/authorize ───────────────
 
  /** Validates the request and parks it. Returns the id the consent page uses. */
  async startAuthorization(q: Record<string, string>) {
    const client = q.client_id
      ? await this.clients.findOneBy({ id: q.client_id })
      : null;
 
    // Never redirect to an unverified redirect_uri: show an error instead.
    if (!client) throw oauthError("invalid_client", "Unknown client_id");
    if (!client.redirectUris.includes(q.redirect_uri)) {
      throw oauthError("invalid_request", "redirect_uri does not match");
    }
    if (q.response_type !== "code") {
      throw oauthError("unsupported_response_type");
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      throw oauthError("invalid_request", "PKCE (S256) is required");
    }
    if (q.resource && q.resource !== this.resource) {
      throw oauthError("invalid_target", "Unknown resource");
    }
 
    const requested = (q.scope ?? "").split(" ").filter(Boolean);
    const scope = requested.filter((s): s is McpScope =>
      (MCP_SCOPES as string[]).includes(s),
    );
    if (scope.length === 0) scope.push(...MCP_SCOPES);
 
    const req = await this.requests.save(
      this.requests.create({
        clientId: client.id,
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        state: q.state ?? null,
        scope: scope.join(" "),
        expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
      }),
    );
    return req.id;
  }
 
  // ─────────────── Steps 2-3: consent page (user is logged in to Madar) ───────────────
 
  private async loadPending(id: string) {
    const req = await this.requests.findOneBy({ id });
    if (
      !req ||
      req.usedAt ||
      req.codeHash || // already approved
      req.expiresAt < new Date()
    ) {
      throw oauthError("invalid_request", "This connection request expired");
    }
    return req;
  }
 
  async getPending(id: string) {
    const req = await this.loadPending(id);
    const client = await this.clients.findOneByOrFail({ id: req.clientId });
    const redirectHost = new URL(req.redirectUri).host;
    const isLoopback = this.isLoopbackHost(redirectHost);
    return {
      clientName: client.name,
      redirectHost,
      isLoopback,
      isTrusted: !isLoopback && this.isTrustedHost(redirectHost),
      scopes: req.scope.split(" "),
    };
  }
 
  /** User clicked "Allow". Returns where the browser must go next. */
  async approve(id: string, userId: string, chosenScopes?: string[]) {
    const req = await this.loadPending(id);
 
    // The user may untick scopes, never add new ones.
    const requested = req.scope.split(" ");
    const scope = (chosenScopes?.length ? chosenScopes : requested).filter(
      (s) => requested.includes(s),
    );
    if (scope.length === 0) throw oauthError("access_denied");
 
    const code = randomToken();
    req.userId = userId;
    req.scope = scope.join(" ");
    req.codeHash = sha256Hex(code);
    req.expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.requests.save(req);
 
    return { redirectTo: this.buildRedirect(req, { code }) };
  }
 
  async deny(id: string) {
    const req = await this.loadPending(id);
    await this.requests.delete({ id });
    return { redirectTo: this.buildRedirect(req, { error: "access_denied" }) };
  }
 
  private buildRedirect(
    req: OAuthAuthRequest,
    params: Record<string, string>,
  ) {
    const url = new URL(req.redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (req.state) url.searchParams.set("state", req.state);
    url.searchParams.set("iss", this.issuer);
    return url.toString();
  }
 
  // ─────────────── Step 4: POST /oauth/token (authorization_code) ───────────────
 
  async exchangeCode(body: Record<string, string>) {
    this.assertTokenRateLimit(`code:${body.client_id || "unknown"}`);
    this.assertResource(body.resource);
    if (!body.code || !body.code_verifier) {
      throw oauthError("invalid_request");
    }
    const req = await this.requests.findOneBy({
      codeHash: sha256Hex(body.code),
    });
 
    if (
      !req ||
      req.usedAt ||
      req.expiresAt < new Date() ||
      req.clientId !== body.client_id ||
      req.redirectUri !== body.redirect_uri ||
      s256(body.code_verifier) !== req.codeChallenge
    ) {
      throw oauthError("invalid_grant");
    }
 
    // Single use, even under concurrent requests.
    const claimed = await this.requests.update(
      { id: req.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    if (claimed.affected !== 1) throw oauthError("invalid_grant");
 
    const grant = await this.grants.save(
      this.grants.create({
        userId: req.userId!,
        clientId: req.clientId,
        scope: req.scope,
      }),
    );
    return this.issueTokens(grant);
  }
 
  // ─────────────── POST /oauth/token (refresh_token): THE refresh logic ───────────────
 
  async refresh(body: Record<string, string>) {
    this.assertTokenRateLimit(
      `refresh:${body.client_id || "unknown"}:${sha256Hex(body.refresh_token || "").slice(0, 12)}`,
    );
    this.assertResource(body.resource);
    if (!body.refresh_token) throw oauthError("invalid_request");
 
    const record = await this.refreshTokens.findOneBy({
      tokenHash: sha256Hex(body.refresh_token),
    });
    if (!record) throw oauthError("invalid_grant");
 
    const grant = await this.grants.findOneBy({ id: record.grantId });
    if (
      !grant ||
      grant.revokedAt ||
      grant.clientId !== body.client_id ||
      record.expiresAt < new Date()
    ) {
      throw oauthError("invalid_grant");
    }
 
    // Rotation: each refresh token works exactly once.
    // Atomic claim -> two parallel refreshes can't both win.
    const claimed = await this.refreshTokens.update(
      { id: record.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    if (claimed.affected !== 1) {
      // An already-used token came back = replay (or a stolen copy).
      // Kill the whole connection; the user must reconnect.
      await this.revokeGrantInternal(grant.id);
      throw oauthError("invalid_grant", "Refresh token reuse detected");
    }
 
    // The account may have been disabled since the last refresh.
    try {
      await this.auth.validatePayload({ sub: grant.userId });
    } catch {
      await this.revokeGrantInternal(grant.id);
      throw oauthError("invalid_grant", "User is no longer active");
    }
 
    return this.issueTokens(grant);
  }
 
  private async issueTokens(grant: OAuthGrant) {
    const payload: McpAccessPayload = {
      sub: grant.userId,
      gid: grant.id,
      cid: grant.clientId,
      scope: grant.scope,
    };
    const access_token = await this.jwt.signAsync(payload, {
      audience: this.resource, // only valid for the MCP server
      issuer: this.issuer,
      expiresIn: ACCESS_TTL_SEC,
    });
 
    const refresh_token = randomToken();
    await this.refreshTokens.save(
      this.refreshTokens.create({
        grantId: grant.id,
        tokenHash: sha256Hex(refresh_token),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS), // sliding window
      }),
    );
 
    return {
      access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token,
      scope: grant.scope,
    };
  }
 
  // ─────────────── Used by McpAuthGuard on every MCP call ───────────────
 
  async authenticate(token: string) {
    let payload: McpAccessPayload;
    try {
      payload = await this.jwt.verifyAsync<McpAccessPayload>(token, {
        audience: this.resource,
        issuer: this.issuer,
      }); // throws when expired / wrong audience / bad signature
    } catch {
      throw new UnauthorizedException();
    }
 
    const grant = await this.grants.findOneBy({ id: payload.gid });
    if (!grant || grant.revokedAt) throw new UnauthorizedException();
    if (payload.sub !== grant.userId || payload.cid !== grant.clientId) {
      throw new UnauthorizedException();
    }
    if (!this.isScopeSubset(payload.scope, grant.scope)) {
      throw new UnauthorizedException();
    }

    const user = await this.auth.validatePayload({ sub: payload.sub });
    if (user.role?.name === SystemRole.SUPER_ADMIN) {
      throw new ForbiddenException();
    }

    await this.grants.update({ id: grant.id }, { lastUsedAt: new Date() });
    return { user, scopes: payload.scope.split(" "), grantId: grant.id };
  }

  private assertResource(resource?: string) {
    if (resource && resource !== this.resource) {
      throw oauthError("invalid_target", "Unknown resource");
    }
  }

  private isScopeSubset(claimed: string, granted: string) {
    const allowed = new Set(granted.split(" ").filter(Boolean));
    return claimed.split(" ").filter(Boolean).every((s) => allowed.has(s));
  }

  private hostname(host: string) {
    return host.replace(/^\[|\]$/g, "").split(":")[0].toLowerCase();
  }

  private isLoopbackHost(host: string) {
    return LOOPBACK_HOSTS.has(this.hostname(host));
  }

  private trustedRedirectHosts() {
    const fromEnv = process.env.MCP_TRUSTED_REDIRECT_HOSTS;
    const list = fromEnv
      ? fromEnv.split(",")
      : DEFAULT_TRUSTED_REDIRECT_HOSTS;
    return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  private isTrustedHost(host: string) {
    const h = this.hostname(host);
    return this.trustedRedirectHosts().some(
      (trusted) => h === trusted || h.endsWith(`.${trusted}`),
    );
  }

  private assertTokenRateLimit(key: string) {
    const now = Date.now();
    const times = (this.tokenHits.get(key) ?? []).filter(
      (t) => now - t < TOKEN_RATE_WINDOW_MS,
    );
    if (times.length >= TOKEN_RATE_LIMIT) {
      throw new HttpException(
        { error: "invalid_request", error_description: "slow_down" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    times.push(now);
    this.tokenHits.set(key, times);
  }
 
  // ─────────────── "Connected apps" screen in Madar settings ───────────────
 
  async listGrants(userId: string) {
    const rows = await this.grants.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: "DESC" },
    });
    const clients = await this.clients.findBy({
      id: In(rows.map((r) => r.clientId)),
    });
    return rows.map((g) => ({
      id: g.id,
      clientName: clients.find((c) => c.id === g.clientId)?.name ?? "Unknown",
      scope: g.scope,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
    }));
  }
 
  async grantStats(userId: string) {
    const canRead = `:read = ANY(string_to_array(g.scope, ' '))`;
    const canWrite = `:write = ANY(string_to_array(g.scope, ' '))`;

    const raw = await this.grants
      .createQueryBuilder("g")
      .select("COUNT(*)", "total")
      .addSelect(`COUNT(*) FILTER (WHERE ${canRead} AND NOT ${canWrite})`, "readOnly")
      .addSelect(`COUNT(*) FILTER (WHERE ${canWrite} AND NOT ${canRead})`, "writeOnly")
      .addSelect(`COUNT(*) FILTER (WHERE ${canRead} AND ${canWrite})`, "readWrite")
      .where("g.userId = :userId", { userId })
      .andWhere("g.revokedAt IS NULL")
      .setParameters({ read: McpScope.READ, write: McpScope.WRITE })
      .getRawOne();

    return {
      total: Number(raw?.total ?? 0),
      readOnly: Number(raw?.readOnly ?? 0),
      writeOnly: Number(raw?.writeOnly ?? 0),
      readWrite: Number(raw?.readWrite ?? 0),
    };
  }

  async revokeGrant(userId: string, grantId: string) {
    const grant = await this.grants.findOneBy({ id: grantId, userId });
    if (!grant) throw new BadRequestException();
    await this.revokeGrantInternal(grant.id);
  }
 
  private async revokeGrantInternal(grantId: string) {
    await this.grants.update({ id: grantId }, { revokedAt: new Date() });
    await this.refreshTokens.delete({ grantId });
  }
}
 