import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, Repository } from "typeorm";
import {
  OrderTagEntity,
  TagAssignmentSource,
  TagEntity,
} from "entities/tag.entity";
import { OrderEntity } from "entities/order.entity";
import { OrderTagMode } from "entities/clientSettings.entity";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";

@Injectable()
export class TagsAssignmentService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepo: Repository<TagEntity>,
    @InjectRepository(OrderTagEntity)
    private readonly orderTagRepo: Repository<OrderTagEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly clientSettingsService: ClientSettingsService,
    private readonly translations: TranslationService,
  ) {}

  private adminIdOf(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    return adminId;
  }

  async listOrderTags(me: any, orderId: string) {
    const adminId = this.adminIdOf(me);
    await this.requireOrder(adminId, orderId);
    return this.orderTagRepo.find({
      where: { adminId, orderId },
      relations: ["tag"],
      order: { created_at: "ASC" },
    });
  }

  async assignManual(me: any, orderId: string, tagId: string) {
    const adminId = this.adminIdOf(me);
    return this.assignTag({
      orderId,
      tagId,
      adminId,
      source: TagAssignmentSource.MANUAL,
      userId: me?.id,
      actorIsAdmin: me?.role?.name === "admin",
    });
  }

  async removeManual(me: any, orderId: string, tagId: string) {
    const adminId = this.adminIdOf(me);
    await this.requireOrder(adminId, orderId);
    const existing = await this.orderTagRepo.findOne({
      where: { adminId, orderId, tagId },
      relations: ["tag"],
    });
    if (!existing) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    if (
      me?.role?.name !== "admin" &&
      existing.tag?.allowManualAssignment === false
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_assignment_disabled"),
      );
    }
    await this.orderTagRepo.remove(existing);
    return this.listOrderTags(me, orderId);
  }

  async assignTag(params: {
    orderId: string;
    tagId: string;
    adminId: string;
    source: TagAssignmentSource;
    userId?: string | null;
    manager?: EntityManager;
    actorIsAdmin?: boolean;
  }) {
    const tagRepo = params.manager
      ? params.manager.getRepository(TagEntity)
      : this.tagRepo;
    const orderTagRepo = params.manager
      ? params.manager.getRepository(OrderTagEntity)
      : this.orderTagRepo;

    const tag = await tagRepo.findOne({
      where: { id: params.tagId, adminId: params.adminId },
    });
    if (!tag || !tag.isActive) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    if (
      params.source === TagAssignmentSource.MANUAL &&
      tag.allowManualAssignment === false &&
      !params.actorIsAdmin
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_assignment_disabled"),
      );
    }

    await this.requireOrder(params.adminId, params.orderId, params.manager);

    const settings = await this.clientSettingsService.getCachedSettings(
      params.adminId,
    );
    const mode = settings?.orderTagMode || OrderTagMode.MANY;

    const existing = await orderTagRepo.findOne({
      where: {
        adminId: params.adminId,
        orderId: params.orderId,
        tagId: params.tagId,
      },
    });

    if (mode === OrderTagMode.ONE) {
      await orderTagRepo
        .createQueryBuilder()
        .delete()
        .where('"adminId" = :adminId', { adminId: params.adminId })
        .andWhere('"orderId" = :orderId', { orderId: params.orderId })
        .andWhere('"tagId" != :tagId', { tagId: params.tagId })
        .execute();
    }

    if (existing) {
      return this.loadOrderTags(params.adminId, params.orderId, params.manager);
    }

    const row = orderTagRepo.create({
      adminId: params.adminId,
      orderId: params.orderId,
      tagId: params.tagId,
      source: params.source,
      createdByUserId: params.userId ?? null,
    });
    await orderTagRepo.save(row);
    return this.loadOrderTags(params.adminId, params.orderId, params.manager);
  }

  async removeAutomaticTags(params: {
    orderId: string;
    adminId: string;
    tagIds: string[];
    manager?: EntityManager;
  }) {
    if (!params.tagIds.length) return;
    const orderTagRepo = params.manager
      ? params.manager.getRepository(OrderTagEntity)
      : this.orderTagRepo;
    await orderTagRepo
      .createQueryBuilder()
      .delete()
      .where('"adminId" = :adminId', { adminId: params.adminId })
      .andWhere('"orderId" = :orderId', { orderId: params.orderId })
      .andWhere('"tagId" IN (:...tagIds)', { tagIds: params.tagIds })
      .andWhere("source = :source", { source: TagAssignmentSource.AUTOMATIC })
      .execute();
  }

  private async loadOrderTags(
    adminId: string,
    orderId: string,
    manager?: EntityManager,
  ) {
    const repo = manager
      ? manager.getRepository(OrderTagEntity)
      : this.orderTagRepo;
    return repo.find({
      where: { adminId, orderId },
      relations: ["tag"],
      order: { created_at: "ASC" },
    });
  }

  private async requireOrder(
    adminId: string,
    orderId: string,
    manager?: EntityManager,
  ) {
    const repo = manager ? manager.getRepository(OrderEntity) : this.orderRepo;
    const order = await repo.findOne({
      where: { id: orderId, adminId },
      select: ["id", "adminId"],
    });
    if (!order) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return order;
  }
}
