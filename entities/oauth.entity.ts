import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

export enum McpScope {
  READ = "madar:read",
  WRITE = "madar:write",
}

export const MCP_SCOPES: McpScope[] = Object.values(McpScope);

/**
 * A client that registered itself through Dynamic Client Registration
 * (ChatGPT, Claude, MCP Inspector...). `id` is the OAuth `client_id`.
 */
@Entity("oauth_clients")
export class OAuthClient {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar" })
  name: string;

  @Column("simple-json")
  redirectUris: string[];

  @CreateDateColumn()
  createdAt: Date;
}

/**
 * One row per /authorize call. Lifecycle:
 *   pending  -> created by GET /oauth/authorize (userId = null)
 *   approved -> user clicked "Allow" on the consent page (userId + codeHash set)
 *   used     -> client exchanged the code at POST /oauth/token (usedAt set)
 */
@Index(["codeHash"], { unique: true, where: `"codeHash" IS NOT NULL` })
@Entity("oauth_auth_requests")
export class OAuthAuthRequest {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar" })
  clientId: string;

  @Column({ type: "varchar" })
  redirectUri: string;

  @Column({ type: "varchar" })
  codeChallenge: string; // PKCE (S256)

  @Column({ type: "varchar", nullable: true })
  state: string | null;

  @Column({ type: "varchar" })
  scope: string; // space separated

  @Column({ type: "uuid", nullable: true })
  userId: string | null;

  @Column({ type: "varchar", nullable: true })
  codeHash: string | null;

  @Column({ type: "timestamp" })
  expiresAt: Date;

  @Column({ type: "timestamp", nullable: true })
  usedAt: Date | null;
}

/**
 * A "connection": user X allowed client Y with scopes Z.
 * This is what the user sees (and can revoke) in Madar settings.
 * Access tokens carry the grant id (`gid`) so revoking is instant.
 */
@Index(["userId", "revokedAt", "createdAt"])
@Entity("oauth_grants")
export class OAuthGrant {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @Column({ type: "varchar" })
  clientId: string;

  @Column({ type: "varchar" })
  scope: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: "timestamp", nullable: true })
  revokedAt: Date | null;
}

/**
 * Refresh tokens are opaque random strings; only their SHA-256 is stored.
 * Every refresh rotates the token: the old row gets `usedAt`, a new row is
 * created. Presenting a row that already has `usedAt` = token theft/replay.
 */
@Index(["grantId"])
@Index(["tokenHash"], { unique: true })
@Entity("oauth_refresh_tokens")
export class OAuthRefreshToken {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 36 })
  grantId: string;

  @Column({ type: "varchar" })
  tokenHash: string;

  @Column({ type: "timestamp" })
  expiresAt: Date;

  @Column({ type: "timestamp", nullable: true })
  usedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}