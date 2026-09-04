import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import {
  ClientTagEntity,
  OrderTagEntity,
  TagAssignmentSource,
  TagEntity,
  TagTarget,
} from "entities/tag.entity";
import { OrderEntity } from "entities/order.entity";
import { ClientEntity } from "entities/clients.entity";
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
    @InjectRepository(ClientTagEntity)
    private readonly clientTagRepo: Repository<ClientTagEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(ClientEntity)
    private readonly clientRepo: Repository<ClientEntity>,
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
      relations: {
        tag: true
      },
      order: { created_at: "ASC" },
    });
  }

  private uniqueTagIds(ids?: string[]) {
    return [...new Set((ids || []).filter(Boolean))];
  }

  private assertManualTagAccess(me: any, tag?: TagEntity | null) {
    if (me?.role?.name === "admin") return;
    if (tag?.allowManualAssignment === false) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_assignment_disabled"),
      );
    }
    if (
      Array.isArray(tag?.employeeIds) &&
      tag.employeeIds.length > 0 &&
      !tag.employeeIds.includes(me?.id)
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_no_access"),
      );
    }
  }

  async syncOrderManual(
    me: any,
    orderId: string,
    addTagIds?: string[],
    removeTagIds?: string[],
  ) {
    const adminId = this.adminIdOf(me);
    const actorIsAdmin = me?.role?.name === "admin";
  
    const addIds = this.uniqueTagIds(addTagIds);
    const addSet = new Set(addIds);
  
    const removeIds = this.uniqueTagIds(removeTagIds).filter(
      (id) => !addSet.has(id),
    );
  
    await this.requireOrder(adminId, orderId);
  
    return this.orderTagRepo.manager.transaction(async (manager) => {
      const orderTagRepo = manager.getRepository(OrderTagEntity);
  
      if (removeIds.length) {
        const existing = await orderTagRepo.find({
          where: {
            adminId,
            orderId,
            tagId: In(removeIds),
          },
          relations: {
            tag: true
          },
        });
  
        for (const row of existing) {
          this.assertManualTagAccess(me, row.tag);
        }
  
        if (existing.length) {
          await orderTagRepo.remove(existing);
        }
      }
  
      await Promise.all(
        addIds.map((tagId) =>
          this.assignTag({
            orderId,
            tagId,
            adminId,
            source: TagAssignmentSource.MANUAL,
            userId: me?.id,
            manager,
            actorIsAdmin,
          }),
        ),
      );
  
      return this.loadOrderTags(adminId, orderId, manager);
    });
  }

  async syncClientManual(
    me: any,
    clientId: string,
    addTagIds?: string[],
    removeTagIds?: string[],
  ) {
    const adminId = this.adminIdOf(me);
    const actorIsAdmin = me?.role?.name === "admin";
  
    const addIds = this.uniqueTagIds(addTagIds);
    const addSet = new Set(addIds);
  
    const removeIds = this.uniqueTagIds(removeTagIds).filter(
      (id) => !addSet.has(id),
    );
  
    await this.requireClient(adminId, clientId);
  
    return this.clientTagRepo.manager.transaction(async (manager) => {
      const clientTagRepo = manager.getRepository(ClientTagEntity);
  
      if (removeIds.length) {
        const existing = await clientTagRepo.find({
          where: {
            adminId,
            clientId,
            tagId: In(removeIds),
          },
          relations: {
            tag: true
          },
        });
  
        for (const row of existing) {
          this.assertManualTagAccess(me, row.tag);
        }
  
        if (existing.length) {
          await clientTagRepo.remove(existing);
        }
      }
  
      await Promise.all(
        addIds.map((tagId) =>
          this.assignClientTag({
            clientId,
            tagId,
            adminId,
            source: TagAssignmentSource.MANUAL,
            userId: me?.id,
            manager,
            actorIsAdmin,
          }),
        ),
      );
  
      return this.loadClientTags(adminId, clientId, manager);
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
      relations: {
        tag: true
      },
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
    if (
      me?.role?.name !== "admin" &&
      Array.isArray(existing.tag?.employeeIds) &&
      existing.tag.employeeIds.length > 0 &&
      !existing.tag.employeeIds.includes(me?.id)
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_no_access"),
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
    if ((tag.target || TagTarget.ORDER) !== TagTarget.ORDER) {
      throw new BadRequestException(this.translations.t("domains.tags.wrong_target"));
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
    if (
      params.source === TagAssignmentSource.MANUAL &&
      !params.actorIsAdmin &&
      Array.isArray(tag.employeeIds) &&
      tag.employeeIds.length > 0 &&
      !tag.employeeIds.includes(params.userId)
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_no_access"),
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
      relations: {
        tag: true
      },
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
      select: {
        id: true,
        adminId: true
      },
    });
    if (!order) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return order;
  }

  async listClientTags(me: any, clientId: string) {
    const adminId = this.adminIdOf(me);
    await this.requireClient(adminId, clientId);
    return this.clientTagRepo.find({
      where: { adminId, clientId },
      relations: {
        tag: true
      },
      order: { created_at: "ASC" },
    });
  }

  async assignClientManual(me: any, clientId: string, tagId: string) {
    const adminId = this.adminIdOf(me);
    return this.assignClientTag({
      clientId,
      tagId,
      adminId,
      source: TagAssignmentSource.MANUAL,
      userId: me?.id,
      actorIsAdmin: me?.role?.name === "admin",
    });
  }

  async removeClientManual(me: any, clientId: string, tagId: string) {
    const adminId = this.adminIdOf(me);
    await this.requireClient(adminId, clientId);
    const existing = await this.clientTagRepo.findOne({
      where: { adminId, clientId, tagId },
      relations: {
        tag: true
      },
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
    if (
      me?.role?.name !== "admin" &&
      Array.isArray(existing.tag?.employeeIds) &&
      existing.tag.employeeIds.length > 0 &&
      !existing.tag.employeeIds.includes(me?.id)
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_no_access"),
      );
    }
    await this.clientTagRepo.remove(existing);
    return this.listClientTags(me, clientId);
  }

  async assignClientTag(params: {
    clientId: string;
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
    const clientTagRepo = params.manager
      ? params.manager.getRepository(ClientTagEntity)
      : this.clientTagRepo;

    const tag = await tagRepo.findOne({
      where: { id: params.tagId, adminId: params.adminId },
    });
    if (!tag || !tag.isActive) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    if (tag.target !== TagTarget.CLIENT) {
      throw new BadRequestException(this.translations.t("domains.tags.wrong_target"));
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
    if (
      params.source === TagAssignmentSource.MANUAL &&
      !params.actorIsAdmin &&
      Array.isArray(tag.employeeIds) &&
      tag.employeeIds.length > 0 &&
      !tag.employeeIds.includes(params.userId)
    ) {
      throw new BadRequestException(
        this.translations.t("domains.tags.employee_no_access"),
      );
    }

    await this.requireClient(params.adminId, params.clientId, params.manager);

    const settings = await this.clientSettingsService.getCachedSettings(
      params.adminId,
    );
    const mode = settings?.clientTagMode || OrderTagMode.MANY;

    const existing = await clientTagRepo.findOne({
      where: {
        adminId: params.adminId,
        clientId: params.clientId,
        tagId: params.tagId,
      },
    });

    if (mode === OrderTagMode.ONE) {
      await clientTagRepo
        .createQueryBuilder()
        .delete()
        .where('"adminId" = :adminId', { adminId: params.adminId })
        .andWhere('"clientId" = :clientId', { clientId: params.clientId })
        .andWhere('"tagId" != :tagId', { tagId: params.tagId })
        .execute();
    }

    if (existing) {
      return this.loadClientTags(params.adminId, params.clientId, params.manager);
    }

    const row = clientTagRepo.create({
      adminId: params.adminId,
      clientId: params.clientId,
      tagId: params.tagId,
      source: params.source,
      createdByUserId: params.userId ?? null,
    });
    await clientTagRepo.save(row);
    return this.loadClientTags(params.adminId, params.clientId, params.manager);
  }

  async removeAutomaticClientTags(params: {
    clientId: string;
    adminId: string;
    tagIds: string[];
    manager?: EntityManager;
  }) {
    if (!params.tagIds.length) return;
    const clientTagRepo = params.manager
      ? params.manager.getRepository(ClientTagEntity)
      : this.clientTagRepo;
    await clientTagRepo
      .createQueryBuilder()
      .delete()
      .where('"adminId" = :adminId', { adminId: params.adminId })
      .andWhere('"clientId" = :clientId', { clientId: params.clientId })
      .andWhere('"tagId" IN (:...tagIds)', { tagIds: params.tagIds })
      .andWhere("source = :source", { source: TagAssignmentSource.AUTOMATIC })
      .execute();
  }

  private async loadClientTags(
    adminId: string,
    clientId: string,
    manager?: EntityManager,
  ) {
    const repo = manager
      ? manager.getRepository(ClientTagEntity)
      : this.clientTagRepo;
    return repo.find({
      where: { adminId, clientId },
      relations: {
        tag: true
      },
      order: { created_at: "ASC" },
    });
  }

  private async requireClient(
    adminId: string,
    clientId: string,
    manager?: EntityManager,
  ) {
    const repo = manager ? manager.getRepository(ClientEntity) : this.clientRepo;
    const client = await repo.findOne({
      where: { id: clientId, adminId },
      select: {
        id: true,
        adminId: true
      },
    });
    if (!client) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return client;
  }
}
