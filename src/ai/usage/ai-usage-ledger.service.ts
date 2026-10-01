import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  AiUsageActor,
  AiUsageBilledBy,
  AiUsageEntity,
  AiUsageSource,
  AiUsageStatus,
} from "entities/ai-usage.entity";
import { Repository } from "typeorm";

export type AiUsageRecordInput = {
  adminId: string;
  source: AiUsageSource;
  api: string;
  actor: AiUsageActor;
  billedBy: AiUsageBilledBy;
  providerCode?: string | null;
  modelCode?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  rounds?: number;
  status?: AiUsageStatus;
  grossAmount?: bigint;
  payableAmount?: bigint;
  freeUnits?: bigint;
  currency?: string;
  chargeId?: string | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  mediaUsageId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  orderId?: string | null;
};

@Injectable()
export class AiUsageLedgerService {
  private readonly logger = new Logger(AiUsageLedgerService.name);

  constructor(
    @InjectRepository(AiUsageEntity)
    private readonly repo: Repository<AiUsageEntity>,
  ) {}

  async record(input: AiUsageRecordInput): Promise<void> {
    try {
      if (!input.adminId) return;
      const existing = await this.findDuplicate(input);
      if (existing) return;

      const billedByMerchant = input.billedBy === AiUsageBilledBy.MERCHANT;
      await this.repo.save(
        this.repo.create({
          adminId: input.adminId,
          source: input.source,
          api: input.api,
          actor: input.actor,
          billedBy: input.billedBy,
          providerCode: input.providerCode ?? null,
          modelCode: input.modelCode ?? null,
          inputTokens: Number(input.inputTokens ?? 0),
          outputTokens: Number(input.outputTokens ?? 0),
          audioSeconds: Number(input.audioSeconds ?? 0),
          rounds: Math.max(1, Number(input.rounds ?? 1)),
          status: input.status ?? AiUsageStatus.OK,
          grossAmount: billedByMerchant ? 0n : (input.grossAmount ?? 0n),
          payableAmount: billedByMerchant ? 0n : (input.payableAmount ?? 0n),
          freeUnits: billedByMerchant ? 0n : (input.freeUnits ?? 0n),
          currency: input.currency ?? "USD",
          chargeId: billedByMerchant ? null : (input.chargeId ?? null),
          idempotencyKey: input.idempotencyKey ?? null,
          requestId: input.requestId ?? null,
          sessionId: input.sessionId ?? null,
          turnId: input.turnId ?? null,
          mediaUsageId: input.mediaUsageId ?? null,
          agentId: input.agentId ?? null,
          conversationId: input.conversationId ?? null,
          orderId: input.orderId ?? null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `failed to record ai usage source=${input.source} api=${input.api}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async findDuplicate(input: AiUsageRecordInput) {
    const queries = [
      input.idempotencyKey &&
        this.repo.findOne({
          where: {
            adminId: input.adminId,
            idempotencyKey: input.idempotencyKey,
          },
        }),
  
      input.chargeId &&
        this.repo.findOne({
          where: { chargeId: input.chargeId },
        }),
  
      input.turnId &&
        this.repo.findOne({
          where: { turnId: input.turnId },
        }),
  
      input.mediaUsageId &&
        this.repo.findOne({
          where: { mediaUsageId: input.mediaUsageId },
        }),
  
      input.requestId &&
        this.repo.findOne({
          where: {
            adminId: input.adminId,
            source: input.source,
            requestId: input.requestId,
          },
        }),
    ].filter(Boolean) as Promise<typeof this.repo extends any ? any : never>[];
  
    try {
      return await Promise.any(
        queries.map(async (query) => {
          const row = await query;
  
          if (!row) {
            throw new Error("Not found");
          }
  
          return row;
        }),
      );
    } catch {
      return null;
    }
  }
}
