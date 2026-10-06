import { randomUUID } from "crypto";
import { RedisService } from "common/redis/RedisService";
import { AiChatMessage } from "src/ai/interfaces/ai-types";
import { TryMeSessionDto } from "dto/agent.dto";

export const PLAYGROUND_TTL_SECONDS = 12 * 60 * 60;
export const PLAYGROUND_LOCK_TTL_SECONDS = 10 * 60;
export const PLAYGROUND_GATHER_MS = 800;
export const PLAYGROUND_GATHER_MAX_MS = 2500;

export type PlaygroundPendingMedia = {
  kind: "image" | "video" | "document" | "audio";
  blobKey?: string;
  mimeType?: string;
  filename?: string;
};

export type PlaygroundPendingItem = {
  id: string;
  text?: string;
  media?: PlaygroundPendingMedia[];
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  at: number;
};

export type PlaygroundError = {
  source: "turn" | "tool" | "media" | "http";
  code: string;
  message: string;
  toolName?: string;
  fatal: boolean;
};

export type PlaygroundBubble = {
  id: string;
  role: "assistant";
  type: string;
  text?: string;
  url?: string;
  caption?: string;
  body?: string;
  buttons?: Array<{ id?: string; title?: string }>;
  rows?: Array<{ id?: string; title?: string; description?: string }>;
  header?: string;
  footer?: string;
  buttonText?: string;
  targetId?: string;
  emoji?: string;
  createdAt: string;
};

export type PlaygroundSession = {
  hashId: string;
  snapshot: TryMeSessionDto;
  customerId: string | null;
  agentId: string;
  sessionId: string;
  conversationId: string;
  messages: AiChatMessage[];
  bubbles: PlaygroundBubble[];
  inboundIds: string[];
  bootstrap?: string | null;
  summary?: string | null;
  lastErrors?: PlaygroundError[];
  startedAt: string;
};

export function playgroundRedisKey(adminId: string, dashboardUserId: string): string {
  return `playground:${adminId}:${dashboardUserId}`;
}

export function playgroundLaneKeys(sessionKey: string) {
  return {
    pending: `${sessionKey}:pending`,
    state: `${sessionKey}:state`,
    firstAt: `${sessionKey}:first-at`,
  };
}

export function playgroundBlobSetKey(sessionKey: string): string {
  return `${sessionKey}:blobs`;
}

export function playgroundBlobKey(sessionKey: string, inboundId: string, index = 0): string {
  return `${sessionKey}:blob:${inboundId}:${index}`;
}

export async function savePlaygroundBlob(
  redis: RedisService,
  blobKey: string,
  blobSetKey: string,
  buffer: Buffer,
): Promise<void> {
  await redis.redisClient.set(blobKey, buffer, "EX", PLAYGROUND_TTL_SECONDS);
  await redis.redisClient.sadd(blobSetKey, blobKey);
  await redis.redisClient.expire(blobSetKey, PLAYGROUND_TTL_SECONDS);
}

export async function loadPlaygroundBlob(redis: RedisService, blobKey: string): Promise<Buffer | null> {
  const value = await redis.redisClient.getBuffer(blobKey);
  if (!value || !value.length) return null;
  return value;
}

export async function clearPlaygroundLane(redis: RedisService, sessionKey: string): Promise<void> {
  const keys = playgroundLaneKeys(sessionKey);
  const blobSetKey = playgroundBlobSetKey(sessionKey);
  const blobKeys = await redis.redisClient.smembers(blobSetKey);
  const toDelete = [keys.pending, keys.state, keys.firstAt, blobSetKey, ...blobKeys];
  if (toDelete.length) {
    await redis.redisClient.del(...toDelete);
  }
}

export function parsePlaygroundPending(raw: string[]): PlaygroundPendingItem[] {
  return raw.map((row) => JSON.parse(row) as PlaygroundPendingItem);
}

export async function playgroundPendingCount(redis: RedisService, sessionKey: string): Promise<number> {
  return redis.redisClient.llen(playgroundLaneKeys(sessionKey).pending);
}

export async function isPlaygroundLaneRunning(redis: RedisService, sessionKey: string): Promise<boolean> {
  return (await redis.redisClient.exists(playgroundLaneKeys(sessionKey).state)) === 1;
}

const DRAIN_SCRIPT = `
local ids = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return ids
`;

const CONTINUE_OR_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= 'active:' .. ARGV[1] then
  return 0
end
if redis.call('LLEN', KEYS[2]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
redis.call('DEL', KEYS[1])
return 0
`;

const CLEAR_IF_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function drainPlaygroundPending(
  redis: RedisService,
  sessionKey: string,
): Promise<PlaygroundPendingItem[]> {
  const raw = (await redis.redisClient.eval(
    DRAIN_SCRIPT,
    1,
    playgroundLaneKeys(sessionKey).pending,
  )) as string[];
  return parsePlaygroundPending(raw ?? []);
}

export async function continueOrReleasePlaygroundLane(
  redis: RedisService,
  sessionKey: string,
  jobId: string,
): Promise<boolean> {
  const keys = playgroundLaneKeys(sessionKey);
  const keep = await redis.redisClient.eval(
    CONTINUE_OR_RELEASE_SCRIPT,
    2,
    keys.state,
    keys.pending,
    jobId,
    String(PLAYGROUND_LOCK_TTL_SECONDS),
  );
  return Number(keep) === 1;
}

export async function clearPlaygroundIf(
  redis: RedisService,
  sessionKey: string,
  expected: string,
): Promise<void> {
  await redis.redisClient.eval(
    CLEAR_IF_SCRIPT,
    1,
    playgroundLaneKeys(sessionKey).state,
    expected,
  );
}

export async function loadPlaygroundSession(
  redis: RedisService,
  key: string,
): Promise<PlaygroundSession | null> {
  const value = await redis.get<PlaygroundSession>(key);
  if (!value || typeof value !== "object") return null;
  return value;
}

export async function savePlaygroundSession(
  redis: RedisService,
  key: string,
  session: PlaygroundSession,
): Promise<void> {
  await redis.set(key, session, PLAYGROUND_TTL_SECONDS);
}

export async function appendPlaygroundBubble(
  redis: RedisService,
  key: string,
  bubble: PlaygroundBubble,
  expectedHashId?: string,
): Promise<boolean> {
  const session = await loadPlaygroundSession(redis, key);
  if (!session) {
    throw new Error("Playground session expired");
  }
  if (expectedHashId && session.hashId !== expectedHashId) {
    return false;
  }
  session.bubbles = [...(session.bubbles ?? []), bubble];
  await savePlaygroundSession(redis, key, session);
  return true;
}

export function playgroundBubbleFromSend(
  data: Record<string, any>,
  wamid: string,
): PlaygroundBubble {
  const createdAt = new Date().toISOString();
  const type = String(data?.type ?? "text");
  if (type === "text") {
    return {
      id: wamid,
      role: "assistant",
      type: "text",
      text: String(data?.text?.body ?? ""),
      createdAt,
    };
  }
  if (type === "image") {
    return {
      id: wamid,
      role: "assistant",
      type: "image",
      url: String(data?.image?.link ?? data?.image?.id ?? ""),
      caption: data?.image?.caption ? String(data.image.caption) : undefined,
      createdAt,
    };
  }
  if (type === "reaction") {
    return {
      id: wamid,
      role: "assistant",
      type: "reaction",
      targetId: String(data?.reaction?.message_id ?? ""),
      emoji: String(data?.reaction?.emoji ?? ""),
      text: String(data?.reaction?.emoji ?? ""),
      createdAt,
    };
  }
  const interactiveType = String(data?.interactive?.type ?? "")
    .toLowerCase()
    .replace(/_/g, "");
  if (
    type === "interactive" &&
    (interactiveType === "locationrequestmessage" ||
      data?.interactive?.action?.name === "send_location")
  ) {
    return {
      id: wamid,
      role: "assistant",
      type: "location_request",
      body: String(data.interactive?.body?.text ?? ""),
      createdAt,
    };
  }
  if (type === "interactive" && data?.interactive?.type === "button") {
    const buttons = Array.isArray(data.interactive?.action?.buttons)
      ? data.interactive.action.buttons.map((btn: any) => ({
          id: btn?.reply?.id,
          title: btn?.reply?.title,
        }))
      : [];
    return {
      id: wamid,
      role: "assistant",
      type: "buttons",
      body: String(data.interactive?.body?.text ?? ""),
      buttons,
      createdAt,
    };
  }
  if (type === "interactive" && data?.interactive?.type === "list") {
    const section = data.interactive?.action?.sections?.[0];
    const rows = Array.isArray(section?.rows)
      ? section.rows.map((row: any) => ({
          id: row?.id,
          title: row?.title,
          description: row?.description,
        }))
      : [];
    return {
      id: wamid,
      role: "assistant",
      type: "list",
      body: String(data.interactive?.body?.text ?? ""),
      header: data.interactive?.header?.text,
      footer: data.interactive?.footer?.text,
      buttonText: data.interactive?.action?.button,
      rows,
      createdAt,
    };
  }
  if (type === "template" || data?.templateId) {
    return {
      id: wamid,
      role: "assistant",
      type: "template",
      text: String(data?.templateId ?? data?.name ?? "template"),
      createdAt,
    };
  }
  return {
    id: wamid,
    role: "assistant",
    type,
    text: JSON.stringify(data),
    createdAt,
  };
}

export function newPlaygroundIds() {
  return {
    sessionId: randomUUID(),
    conversationId: randomUUID(),
    agentId: randomUUID(),
  };
}
