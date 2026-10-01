import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import {
  AgentMediaKind,
  AgentMediaUsageEntity,
  AgentMediaUsageStatus,
} from "entities/agent-conversation.entity";
import type { MediaKind } from "./media-config.service";

@Injectable()
export class AgentMediaUsageService {
  private readonly logger = new Logger(AgentMediaUsageService.name);

  constructor(
    @InjectRepository(AgentMediaUsageEntity)
    private readonly repo: Repository<AgentMediaUsageEntity>,
  ) {}

  async upsert(row: {
    adminId: string;
    agentId: string;
    conversationId?: string | null;
    messageId: string;
    kind: MediaKind;
    status: AgentMediaUsageStatus;
    errorCode?: string | null;
    error?: string | null;
    inputTokens: number;
    outputTokens: number;
    audioSeconds: number;
    chargedAmount: bigint;
    authorizationId?: string | null;
    chargeId?: string | null;
    visionModel?: string | null;
    transcribeModel?: string | null;
    documentModel?: string | null;
  }): Promise<string | null> {
    try {
      const existing = await this.repo.findOne({ where: { messageId: row.messageId } });
      const payload = {
        ...row,
        kind: row.kind as AgentMediaKind,
        error: row.error ? row.error.slice(0, 400) : null,
      };
      if (existing) {
        await this.repo.update(existing.id, {
          ...payload,
          turnId: existing.turnId,
        });
        return existing.id;
      }
      const saved = await this.repo.save(this.repo.create(payload));
      return saved.id;
    } catch (err) {
      this.logger.error(
        `failed to persist media usage for message ${row.messageId}`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  async attachTurnId(turnId: string, messageIds: string[]): Promise<void> {
    const ids = (messageIds ?? []).filter(Boolean);
    if (!ids.length) return;
    await this.repo.update({ messageId: In(ids) }, { turnId });
  }
}
