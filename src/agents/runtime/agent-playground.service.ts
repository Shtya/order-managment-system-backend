import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomUUID } from "crypto";
import { Repository } from "typeorm";
import { RedisService } from "common/redis/RedisService";
import { AppGateway } from "common/app.gateway";
import { tenantId } from "src/category/category.service";
import { AgentAiSource, AgentEntity, AgentGender, AgentLanguage } from "entities/agent.entity";
import { CustomerEntity } from "entities/customers.entity";
import {
  WhatsappMessageEntity,
  WhatsappMessageType,
} from "entities/whatsapp.entity";
import { TryMeMessageDto, TryMeSessionDto } from "dto/agent.dto";
import { AiOrchestratorService } from "src/ai/orchestrator/ai-orchestrator.service";
import {
  AgentHostedTurnService,
  HostedInsufficientBalanceError,
} from "./agent-hosted-turn.service";
import { AiChatMessage, AiProgressEvent } from "src/ai/interfaces/ai-types";
import { isAiProviderError } from "src/ai/errors/provider.errors";
import { MediaKind } from "src/ai/media/media-config.service";
import { TranslationService } from "common/translation.service";
import { AgentsService } from "../agents.service";
import { buildAgentSystemPrompt, formatAgentNow } from "./agent-prompt";
import { AgentInputService } from "./agent-input.service";
import { renderInput } from "./agent-context.service";
import { AgentSessionService, SUMMARY_SYSTEM_PROMPT } from "./agent-session.service";
import {
  AGENT_COMPACTION_RATIO,
  AGENT_CONTEXT_TOKEN_BUDGET,
  AGENT_KEEP_RECENT_TURNS,
  AgentToolScope,
  PLAYGROUND_SEND_TOOL_NAMES,
  estimateTokens,
  resolvePlaygroundToolNames,
} from "./agent-runtime.constants";
import { AgentTurnQueueService } from "src/queue/queues/agent-turn.queue";
import {
  loadPlaygroundSession,
  newPlaygroundIds,
  playgroundRedisKey,
  PlaygroundError,
  PlaygroundPendingItem,
  PlaygroundSession,
  savePlaygroundSession,
  clearPlaygroundLane,
  clearPlaygroundIf,
  drainPlaygroundPending,
  continueOrReleasePlaygroundLane,
  isPlaygroundLaneRunning,
  playgroundPendingCount,
  playgroundBlobKey,
  playgroundBlobSetKey,
  savePlaygroundBlob,
  loadPlaygroundBlob,
} from "./agent-playground.session";

const ACCEPT_FLAG: Record<MediaKind, "acceptImage" | "acceptVideo" | "acceptDocument" | "acceptAudio"> = {
  image: "acceptImage",
  video: "acceptVideo",
  document: "acceptDocument",
  audio: "acceptAudio",
};

const MEDIA_TYPE: Record<MediaKind, WhatsappMessageType> = {
  image: WhatsappMessageType.IMAGE,
  video: WhatsappMessageType.VIDEO,
  document: WhatsappMessageType.DOCUMENT,
  audio: WhatsappMessageType.AUDIO,
};

@Injectable()
export class AgentPlaygroundService {
  constructor(
    private readonly redis: RedisService,
    private readonly agents: AgentsService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly hostedTurns: AgentHostedTurnService,
    private readonly input: AgentInputService,
    private readonly sessions: AgentSessionService,
    private readonly translations: TranslationService,
    @InjectRepository(CustomerEntity)
    private readonly customers: Repository<CustomerEntity>,
    @Inject(forwardRef(() => AgentTurnQueueService))
    private readonly agentTurns: AgentTurnQueueService,
    private readonly gateway: AppGateway,
  ) {}

  async startSession(me: any, dto: TryMeSessionDto) {
    const adminId = this.adminIdOf(me);
    const dashboardUserId = String(me?.id ?? "");
    if (!dashboardUserId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }
    const phoneNumber = dto.customerId ? await this.phoneOf(adminId, dto.customerId) : "";
    if (dto.customerId && !phoneNumber) {
      throw new NotFoundException("Customer not found");
    }
    const ids = newPlaygroundIds();
    const hashId = hashAgentSnapshot(dto, ids.sessionId);
    const bootstrap = dto.customerId
      ? await this.sessions.getBootstrap(adminId, dto.customerId, phoneNumber)
      : null;
    const session: PlaygroundSession = {
      hashId,
      snapshot: dto,
      customerId: dto.customerId ?? null,
      agentId: dto.id || ids.agentId,
      sessionId: ids.sessionId,
      conversationId: ids.conversationId,
      messages: [],
      bubbles: [],
      inboundIds: [],
      bootstrap,
      summary: null,
      lastErrors: [],
      startedAt: new Date().toISOString(),
    };
    const key = playgroundRedisKey(adminId, dashboardUserId);
    await clearPlaygroundLane(this.redis, key);
    await savePlaygroundSession(this.redis, key, session);
    return { hashId };
  }

  async endSession(me: any) {
    const adminId = this.adminIdOf(me);
    const dashboardUserId = String(me?.id ?? "");
    const key = playgroundRedisKey(adminId, dashboardUserId);
    await clearPlaygroundLane(this.redis, key);
    await this.redis.del(key);
    return { ok: true };
  }

  async getSession(me: any) {
    const adminId = this.adminIdOf(me);
    const dashboardUserId = String(me?.id ?? "");
    const key = playgroundRedisKey(adminId, dashboardUserId);
    const session = await loadPlaygroundSession(this.redis, key);
    if (!session) throw new NotFoundException("Playground session not found");
    const [running, pendingCount] = await Promise.all([
      isPlaygroundLaneRunning(this.redis, key),
      playgroundPendingCount(this.redis, key),
    ]);
    return {
      hashId: session.hashId,
      running,
      pendingCount,
      messages: session.bubbles ?? [],
      lastErrors: session.lastErrors ?? [],
    };
  }

  async runMessage(me: any, dto: TryMeMessageDto, file?: Express.Multer.File) {
    const adminId = this.adminIdOf(me);
    const dashboardUserId = String(me?.id ?? "");
    const key = playgroundRedisKey(adminId, dashboardUserId);
    const session = await loadPlaygroundSession(this.redis, key);
    if (!session || session.hashId !== dto.hashId) {
      throw new NotFoundException("Playground session not found");
    }
    const text = String(dto.text ?? "").trim();
    const uploaded = this.normalizeInboundMedia(dto, file);
    const location = dto.location?.latitude != null && dto.location?.longitude != null
      ? dto.location
      : undefined;
    if (!text && !uploaded.length && !location) {
      throw new BadRequestException("text, media, or location required");
    }

    const inboundId = randomUUID();
    const media = await this.persistInboundMedia(key, inboundId, uploaded);
    const inbound = {
      id: inboundId,
      text: text || undefined,
      media,
      location,
      at: Date.now(),
    };
    const lane = await this.agentTurns.enqueuePlayground(
      { adminId, dashboardUserId, hashId: session.hashId },
      JSON.stringify(inbound),
    );

    this.emitTryMe(dashboardUserId, {
      hashId: session.hashId,
      kind: "inbound",
      inboundId,
      text: inbound.text,
      media: media.map((row) => ({
        kind: row.kind,
        mimeType: row.mimeType,
        filename: row.filename,
      })),
      location: location
        ? {
            latitude: location.latitude,
            longitude: location.longitude,
            name: location.name,
            address: location.address,
          }
        : undefined,
    });
    if (lane === "new" || lane === "scheduled") {
      this.emitTryMe(dashboardUserId, {
        hashId: session.hashId,
        kind: "status",
        status: "gathering",
      });
    }

    return { hashId: session.hashId, queued: true, inboundId, messages: [], errors: [] };
  }

  async runLane(adminId: string, dashboardUserId: string, hashId: string, jobId: string) {
    const key = playgroundRedisKey(adminId, dashboardUserId);
    const session = await loadPlaygroundSession(this.redis, key);
    if (!session || session.hashId !== hashId) {
      await clearPlaygroundIf(this.redis, key, `active:${jobId}`);
      return { skipped: true };
    }

    this.emitTryMe(dashboardUserId, { hashId, kind: "status", status: "running" });
    try {
      let more = true;
      while (more) {
        const batch = await drainPlaygroundPending(this.redis, key);
        if (batch.length) {
          const result = await this.processBatch(adminId, key, batch);
          if (result.messages.length) {
            this.emitTryMe(dashboardUserId, {
              hashId,
              kind: "messages",
              messages: result.messages,
            });
          }
          if (result.errors.length) {
            this.emitTryMe(dashboardUserId, {
              hashId,
              kind: "errors",
              errors: result.errors,
            });
          }
        }
      more = await continueOrReleasePlaygroundLane(this.redis, key, jobId);
    }
      const still = await loadPlaygroundSession(this.redis, key);
      if (still?.hashId === hashId) {
        this.emitTryMe(dashboardUserId, { hashId, kind: "status", status: "idle" });
      }
      return { ok: true };
    } catch (error) {
      await clearPlaygroundIf(this.redis, key, `active:${jobId}`);
      this.emitTryMe(dashboardUserId, {
        hashId,
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private emitTryMe(
    dashboardUserId: string,
    payload: Record<string, unknown> & { hashId: string; kind: string },
  ) {
    this.gateway.emitTryMe(dashboardUserId, payload);
  }

  private async processBatch(
    adminId: string,
    key: string,
    batch: PlaygroundPendingItem[],
  ): Promise<{ messages: PlaygroundSession["bubbles"]; errors: PlaygroundError[] }> {
    const session = await loadPlaygroundSession(this.redis, key);
    if (!session) throw new NotFoundException("Playground session not found");

    const errors: PlaygroundError[] = [];
    const bubbleFrom = session.bubbles.length;
    const agent = this.agentFromSnapshot(adminId, session);
    const inbound = await this.buildInboundMessages(session, batch, errors);
    const insights = inbound.length
      ? await this.input.understand(adminId, inbound, { agent })
      : [];
    for (const insight of insights) {
      if (insight.kind === "failed") {
        errors.push({
          source: "media",
          code: insight.errorCode || "MEDIA_FAILED",
          message: insight.text,
          fatal: false,
        });
      }
    }
    const storedInput = renderInput(insights, []);
    if (!storedInput.trim()) {
      session.lastErrors = errors;
      await savePlaygroundSession(this.redis, key, session);
      return { messages: [], errors };
    }

    session.inboundIds = [...(session.inboundIds ?? []), ...inbound.map((row) => row.id)];
    await this.compactIfNeeded(adminId, session, agent);
    await savePlaygroundSession(this.redis, key, session);

    const turnId = randomUUID();
    const hasCustomer = Boolean(session.customerId);
    const knowledge = await this.loadKnowledge(adminId, session.snapshot);
    const memory = session.customerId
      ? await this.sessions.getMemoryFacts(adminId, session.customerId)
      : [];
    const system = this.buildSystem(agent, knowledge, session, memory.map((row) => row.fact));
    const userContent = `Current date/time: ${formatAgentNow()}.\n\n${storedInput}`;
    const history = [...session.messages];
    const inputMessages: AiChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userContent },
    ];

    let position = 0;
    const phoneNumber = session.customerId ? await this.phoneOf(adminId, session.customerId) : "";
    const scope: AgentToolScope = {
      adminId,
      agentId: session.agentId,
      sessionId: session.sessionId,
      turnId,
      conversationId: session.conversationId,
      customerId: session.customerId ?? "",
      phoneNumber,
      accountId: null,
      playgroundKey: key,
      playgroundHashId: session.hashId,
    };

    let turnErrors: PlaygroundError[] = [];
    try {
      const turnInput = {
        tenantId: adminId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        agentId: session.agentId,
        agentName: agent.name,
        providerId: agent.responseProviderId ?? null,
        turnId,
        messages: inputMessages,
        toolNames: resolvePlaygroundToolNames(agent.capabilities, hasCustomer),
        sendToolNames: PLAYGROUND_SEND_TOOL_NAMES,
        writeDedupScope: (toolCall) =>
          `playground:${session.sessionId}:${turnId}:${toolCall.name}:${position++}`,
        metadata: { agentScope: scope, source: "agent_playground" },
      };
      const result = await this.hostedTurns.runAgentTurn(agent, turnInput);
      turnErrors = collectToolErrors(result.progress);
      if (!result.ok && (result.error || result.errorCode)) {
        turnErrors.push({
          source: "turn",
          code: result.errorCode || result.errorDetails?.kind || "TURN_FAILED",
          message: result.error || result.errorDetails?.message || "Turn failed",
          fatal: true,
        });
      }
      session.messages = result.messages
        .slice(1)
        .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool");
    } catch (error) {
      turnErrors.push(turnFatalError(error));
    }

    const latest = await loadPlaygroundSession(this.redis, key);
    if (!latest || latest.hashId !== session.hashId) {
      return { messages: [], errors: [] };
    }
    const allErrors = [...errors, ...turnErrors];
    latest.messages = session.messages;
    latest.inboundIds = session.inboundIds;
    latest.summary = session.summary;
    latest.lastErrors = allErrors;
    await savePlaygroundSession(this.redis, key, latest);

    const messages = latest.bubbles.slice(bubbleFrom);
    return { messages, errors: allErrors };
  }

  private async buildInboundMessages(
    session: PlaygroundSession,
    batch: PlaygroundPendingItem[],
    errors: PlaygroundError[],
  ): Promise<WhatsappMessageEntity[]> {
    const rows: WhatsappMessageEntity[] = [];
    for (const item of batch) {
      const text = String(item.text ?? "").trim();
      if (text) {
        rows.push(
          this.fakeMessage(session, WhatsappMessageType.TEXT, {
            text: { body: text },
          }),
        );
      }
      if (item.location?.latitude != null && item.location?.longitude != null) {
        rows.push(
          this.fakeMessage(session, WhatsappMessageType.LOCATION, {
            location: {
              latitude: item.location.latitude,
              longitude: item.location.longitude,
              name: item.location.name,
              address: item.location.address,
            },
          }),
        );
      }
      for (const media of item.media ?? []) {
        const kind = media.kind as MediaKind;
        if (!session.snapshot[ACCEPT_FLAG[kind]]) {
          errors.push({
            source: "media",
            code: "MEDIA_NOT_ACCEPTED",
            message: `${kind} is not enabled on this agent`,
            fatal: false,
          });
          continue;
        }
        const buffer = media.blobKey
          ? await loadPlaygroundBlob(this.redis, media.blobKey)
          : null;
        if (!buffer?.length) {
          errors.push({
            source: "media",
            code: "INVALID_MEDIA",
            message: "Media payload is empty",
            fatal: false,
          });
          continue;
        }
        rows.push(
          this.fakeMessage(session, MEDIA_TYPE[kind], {
            [kind]: {
              buffer,
              mime_type: media.mimeType,
              filename: media.filename,
            },
          }),
        );
      }
    }
    return rows;
  }

  private normalizeInboundMedia(
    dto: TryMeMessageDto,
    file?: Express.Multer.File,
  ): Array<{
    kind: MediaKind;
    mimeType?: string;
    filename?: string;
    buffer: Buffer;
  }> {
    if (file?.buffer?.length) {
      const kind = (dto.kind || inferMediaKind(file.mimetype)) as MediaKind;
      return [
        {
          kind,
          mimeType: file.mimetype,
          filename: file.originalname,
          buffer: file.buffer,
        },
      ];
    }
    const rows = [];
    for (const media of dto.media ?? []) {
      const buffer = media.base64 ? Buffer.from(media.base64, "base64") : Buffer.alloc(0);
      if (!buffer.length) continue;
      rows.push({
        kind: media.kind as MediaKind,
        mimeType: media.mimeType,
        filename: media.filename,
        buffer,
      });
    }
    return rows;
  }

  private async persistInboundMedia(
    sessionKey: string,
    inboundId: string,
    uploaded: Array<{
      kind: MediaKind;
      mimeType?: string;
      filename?: string;
      buffer: Buffer;
    }>,
  ) {
    const blobSetKey = playgroundBlobSetKey(sessionKey);
    const media = [];
    for (let index = 0; index < uploaded.length; index++) {
      const row = uploaded[index];
      const blobKey = playgroundBlobKey(sessionKey, inboundId, index);
      await savePlaygroundBlob(this.redis, blobKey, blobSetKey, row.buffer);
      media.push({
        kind: row.kind,
        mimeType: row.mimeType,
        filename: row.filename,
        blobKey,
      });
    }
    return media;
  }

  private fakeMessage(
    session: PlaygroundSession,
    messageType: WhatsappMessageType,
    content: Record<string, unknown>,
  ): WhatsappMessageEntity {
    return {
      id: randomUUID(),
      conversationId: session.conversationId,
      accountId: "playground",
      messageType,
      content,
    } as unknown as WhatsappMessageEntity;
  }

  private async compactIfNeeded(adminId: string, session: PlaygroundSession, agent: AgentEntity) {
    const historyTokens = session.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolCalls ?? "")),
      0,
    );
    const userIndexes = session.messages
      .map((m, index) => (m.role === "user" ? index : -1))
      .filter((index) => index >= 0);
    if (
      historyTokens <= AGENT_CONTEXT_TOKEN_BUDGET * AGENT_COMPACTION_RATIO ||
      userIndexes.length <= AGENT_KEEP_RECENT_TURNS
    ) {
      return;
    }
    const cutoff = userIndexes[userIndexes.length - AGENT_KEEP_RECENT_TURNS];
    const toFold = session.messages.slice(0, cutoff);
    const kept = session.messages.slice(cutoff);
    const transcript = toFold
      .map((m) => `${m.role}: ${String(m.content ?? "").slice(0, 2000)}`)
      .join("\n");
    const user = [
      session.summary ? `Earlier summary:\n${session.summary}` : null,
      `Transcript to add:\n${transcript}`,
      "Return the updated summary only. At most 12 bullets. Drop resolved items.",
    ]
      .filter(Boolean)
      .join("\n\n");
    let summary: string | null = null;
    try {
      if (this.hostedTurns.isHosted(agent)) {
        const result = await this.hostedTurns.runCompletion(agent, {
          tenantId: adminId,
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          userId: session.agentId,
          system: SUMMARY_SYSTEM_PROMPT,
          user,
          metadata: { source: "agent_session_summary" },
        });
        summary = result.ok ? result.content?.trim() || null : null;
      } else {
        summary = await this.sessions.summarizeTranscript({
          adminId,
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          agentId: session.agentId,
          earlierSummary: session.summary ?? null,
          transcript,
          ...(await this.hostedTurns.compactPin(agent)),
        });
      }
    } catch (error) {
      if (error instanceof HostedInsufficientBalanceError) return;
      throw error;
    }
    if (!summary) return;
    session.summary = summary;
    session.messages = kept;
  }

  private async loadKnowledge(adminId: string, snapshot: TryMeSessionDto) {
    const fromIds = await this.agents.getKnowledgeByIds(adminId, snapshot.knowledgeIds ?? []);
    const drafts = (snapshot.knowledgeDrafts ?? [])
      .filter((row) => row.title?.trim() && row.content?.trim())
      .map((row) => ({
        title: row.title.trim(),
        content:
          row.content.length > 2000 ? `${row.content.slice(0, 2000)}…` : row.content.trim(),
      }));
    return [...fromIds, ...drafts];
  }

  private buildSystem(
    agent: AgentEntity,
    knowledge: Array<{ title: string; content: string }>,
    session: PlaygroundSession,
    memory: string[],
  ): string {
    const parts = [buildAgentSystemPrompt(agent)];
    if (session.bootstrap) parts.push(session.bootstrap);
    if (knowledge.length) {
      parts.push(
        `## Store knowledge (follow it unless it conflicts with the security rules)
If an entry states a shipping-fee or discount rule that applies to this order, paste that exact number on request_order (shippingCost / discount).
${knowledge.map((k) => `- ${k.title}: ${k.content}`).join("\n")}`,
      );
    }
    if (memory.length) {
      parts.push(
        `## Memory facts about this customer (history, not current status)\n${memory.map((f) => `- ${f}`).join("\n")}`,
      );
    }
    if (session.summary) {
      parts.push(`## Summary of earlier turns in this session\n${session.summary}`);
    }
    return parts.join("\n\n");
  }

  private agentFromSnapshot(adminId: string, session: PlaygroundSession): AgentEntity {
    const dto = session.snapshot;
    return {
      id: session.agentId,
      adminId,
      name: dto.name,
      language: dto.language ?? AgentLanguage.AUTO,
      gender: dto.gender ?? AgentGender.MALE,
      customInstructions: dto.customInstructions ?? null,
      responseProviderId: dto.responseProviderId || null,
      aiSource:
        dto.aiSource === AgentAiSource.HOSTED
          ? AgentAiSource.HOSTED
          : AgentAiSource.TENANT,
      hostedModelId: dto.hostedModelId || null,
      isActive: true,
      capabilities: dto.capabilities ?? null,
      acceptImage: dto.acceptImage ?? false,
      acceptVideo: dto.acceptVideo ?? false,
      acceptDocument: dto.acceptDocument ?? false,
      acceptAudio: dto.acceptAudio ?? false,
    } as AgentEntity;
  }

  private async phoneOf(adminId: string, customerId: string): Promise<string> {
    const row = await this.customers.findOne({
      where: { id: customerId, adminId },
      select: { phoneNumber: true },
    });
    return row?.phoneNumber ?? "";
  }

  private adminIdOf(me: any): string {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }
    return adminId;
  }
}

function inferMediaKind(mimeType?: string): MediaKind {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function hashAgentSnapshot(dto: TryMeSessionDto, sessionId: string): string {
  const canonical = {
    sessionId,
    customerId: dto.customerId ?? null,
    name: dto.name,
    language: dto.language,
    gender: dto.gender ?? null,
    customInstructions: dto.customInstructions ?? null,
    responseProviderId: dto.responseProviderId ?? null,
    aiSource: dto.aiSource ?? null,
    hostedModelId: dto.hostedModelId ?? null,
    capabilities: [...(dto.capabilities ?? [])].sort(),
    knowledgeIds: [...(dto.knowledgeIds ?? [])].sort(),
    knowledgeDrafts: (dto.knowledgeDrafts ?? [])
      .map((row) => ({ title: row.title, content: row.content }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    acceptImage: !!dto.acceptImage,
    acceptVideo: !!dto.acceptVideo,
    acceptDocument: !!dto.acceptDocument,
    acceptAudio: !!dto.acceptAudio,
    handoffAssignedRoleId: dto.handoffAssignedRoleId ?? null,
    handoffEmployeeIds: [...(dto.handoffEmployeeIds ?? [])].sort(),
    handoffEstimatedMinutes: dto.handoffEstimatedMinutes ?? null,
    handoffPriority: dto.handoffPriority ?? null,
    handoffStatusId: dto.handoffStatusId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function collectToolErrors(progress?: AiProgressEvent[]): PlaygroundError[] {
  const out: PlaygroundError[] = [];
  for (const event of progress ?? []) {
    if (event.type !== "tool_result" && event.type !== "tool_skipped_dedup") continue;
    if (event.result?.ok !== false) continue;
    out.push({
      source: "tool",
      code: event.result.code || "TOOL_EXECUTION_ERROR",
      message: event.result.error || "Tool failed",
      toolName: event.toolName,
      fatal: false,
    });
  }
  return out;
}

function turnFatalError(error: unknown): PlaygroundError {
  if (error instanceof HostedInsufficientBalanceError) {
    return {
      source: "turn",
      code: "HOSTED_INSUFFICIENT_BALANCE",
      message: error.message,
      fatal: true,
    };
  }
  if (isAiProviderError(error)) {
    return {
      source: "turn",
      code: error.kind || "ALL_PROVIDERS_FAILED",
      message: error.message,
      fatal: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    source: "turn",
    code: "TURN_FAILED",
    message,
    fatal: true,
  };
}
