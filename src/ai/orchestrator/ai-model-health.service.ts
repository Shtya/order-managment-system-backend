import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";
import {
  AiIntegrationEntity,
  AiModelAvailabilityEntity,
  AiModelEntity,
} from "../../../entities/ai.entity";
import { TENANT_COOLDOWN_MS } from "../ai.constants";
import { ClassifiedProviderFailure } from "../catalog/tools-error-classify";

@Injectable()
export class AiModelHealthService {
  constructor(
    @InjectRepository(AiModelEntity)
    private readonly modelRepo: Repository<AiModelEntity>,
    @InjectRepository(AiModelAvailabilityEntity)
    private readonly availabilityRepo: Repository<AiModelAvailabilityEntity>,
    @InjectRepository(AiIntegrationEntity)
    private readonly integrationRepo: Repository<AiIntegrationEntity>,
  ) {}

  async recordCallOutcome(params: {
    tenantId?: string | null;
    providerEntityId?: string;
    modelCode?: string | null;
    classification: ClassifiedProviderFailure | "SUCCESS";
    errorKind?: string;
    usedTools: boolean;
  }): Promise<void> {
    const modelCode = params.modelCode;
    const providerEntityId = params.providerEntityId;
    if (!modelCode || !providerEntityId) return;

    const model = await this.modelRepo.findOne({
      where: { providerId: providerEntityId, modelCode },
    });
    if (!model) return;

    if (params.classification === "TOOLS_UNSUPPORTED") {
      if (model.toolsCalling !== false) {
        model.toolsCalling = false;
        await this.modelRepo.save(model);
      }
      return;
    }

    if (params.classification === "SUCCESS") {
      if (params.usedTools && model.toolsCalling == null) {
        model.toolsCalling = true;
        await this.modelRepo.save(model);
      }
      await this.clearCooldown(params.tenantId, model.id);
      await this.setLastHealthy(
        params.tenantId,
        providerEntityId,
        modelCode,
      );
      return;
    }

    if (params.classification === "TENANT_UNHEALTHY") {
      await this.bumpCooldown(
        params.tenantId,
        model.id,
        params.errorKind ?? "RATE_LIMITED",
      );
    }
  }

  isAvailabilityHealthy(
    availability?: Pick<
      AiModelAvailabilityEntity,
      "unhealthyUntil"
    > | null,
  ): boolean {
    if (!availability?.unhealthyUntil) return true;
    return new Date(availability.unhealthyUntil).getTime() <= Date.now();
  }

  private async bumpCooldown(
    tenantId: string | null | undefined,
    modelId: string,
    errorKind: string,
  ) {
    if (!tenantId) return;
    const row = await this.ensureAvailability(tenantId, modelId);
    const step = Math.min(row.cooldownStep ?? 0, TENANT_COOLDOWN_MS.length - 1);
    const ms = TENANT_COOLDOWN_MS[step];
    row.unhealthyUntil = new Date(Date.now() + ms);
    row.cooldownStep = Math.min(step + 1, TENANT_COOLDOWN_MS.length - 1);
    row.lastErrorKind = errorKind;
    await this.availabilityRepo.save(row);
  }

  private async clearCooldown(
    tenantId: string | null | undefined,
    modelId: string,
  ) {
    if (!tenantId) return;
    const row = await this.availabilityRepo.findOne({
      where: { adminId: tenantId, modelId },
    });
    if (!row) return;
    if (!row.unhealthyUntil && !row.cooldownStep && !row.lastErrorKind) return;
    row.unhealthyUntil = null;
    row.cooldownStep = 0;
    row.lastErrorKind = null;
    await this.availabilityRepo.save(row);
  }

  private async setLastHealthy(
    tenantId: string | null | undefined,
    providerEntityId: string,
    modelCode: string,
  ) {
    const integration = await this.findIntegration(tenantId, providerEntityId);
    if (!integration) return;
    if (integration.lastHealthyModelCode === modelCode) return;
    integration.lastHealthyModelCode = modelCode;
    await this.integrationRepo.save(integration);
  }

  private async ensureAvailability(tenantId: string, modelId: string) {
    let row = await this.availabilityRepo.findOne({
      where: { adminId: tenantId, modelId },
    });
    if (row) return row;
    row = this.availabilityRepo.create({
      adminId: tenantId,
      modelId,
      isAvailable: true,
      cooldownStep: 0,
    });
    return this.availabilityRepo.save(row);
  }

  private async findIntegration(
    tenantId: string | null | undefined,
    providerEntityId: string,
  ) {
    if (tenantId) {
      const tenantRow = await this.integrationRepo.findOne({
        where: { providerId: providerEntityId, adminId: tenantId },
      });
      if (tenantRow) return tenantRow;
    }
    return this.integrationRepo.findOne({
      where: { providerId: providerEntityId, adminId: IsNull() },
    });
  }
}
