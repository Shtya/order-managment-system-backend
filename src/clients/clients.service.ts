import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, DataSource, EntityManager, In, Not, Repository, SelectQueryBuilder } from "typeorm";
import { ClientAddressEntity, ClientEntity, ClientStatus } from "entities/clients.entity";
import { CustomerEntity } from "entities/customers.entity";
import { AreaEntity, CityEntity } from "entities/cities.entity";
import { OrderEntity, OrderStatus, OrderStatusEntity } from "entities/order.entity";
import { OrderTagEntity } from "entities/tag.entity";
import {
  CreateClientAddressDto,
  CreateClientDto,
  LinkClientContactDto,
  UpdateClientAddressDto,
  UpdateClientDto,
} from "dto/client.dto";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import { CustomerService } from "../customer/customer.service";
import { deleteFile } from "common/healpers";
import * as ExcelJS from "exceljs";

@Injectable()
export class ClientService {
  constructor(
    @InjectRepository(ClientEntity)
    private readonly clientRepo: Repository<ClientEntity>,
    @InjectRepository(ClientAddressEntity)
    private readonly addressRepo: Repository<ClientAddressEntity>,
    @InjectRepository(CustomerEntity)
    private readonly contactRepo: Repository<CustomerEntity>,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
    private readonly customerService: CustomerService,
  ) { }

  private runInTransaction<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (manager) return work(manager);
    return this.dataSource.transaction((mgr) => work(mgr));
  }

  private addClientCountSelects(qb: SelectQueryBuilder<ClientEntity>) {
    return qb
      .addSelect((subQuery) => {
        return subQuery
          .select("COUNT(ord.id)")
          .from(OrderEntity, "ord")
          .where("ord.clientId = client.id")
          .andWhere("ord.deleted_at IS NULL");
      }, "client_ordersCount")
      .addSelect((subQuery) => {
        return subQuery
          .select("COUNT(ct.id)")
          .from(CustomerEntity, "ct")
          .where("ct.clientId = client.id");
      }, "client_contactsCount");
  }

  private attachClientCounts(
    entities: ClientEntity[],
    raw: Record<string, unknown>[],
  ) {
    const countsById = new Map<
      string,
      { ordersCount: number; contactsCount: number }
    >();
    for (const row of raw) {
      const id = String(row.client_id ?? "");
      if (!id || countsById.has(id)) continue;
      countsById.set(id, {
        ordersCount: Number(row.client_ordersCount ?? 0),
        contactsCount: Number(row.client_contactsCount ?? 0),
      });
    }
    for (const entity of entities) {
      const counts = countsById.get(entity.id);
      (entity as any).ordersCount = counts?.ordersCount ?? 0;
      (entity as any).contactsCount = counts?.contactsCount ?? 0;
    }
  }

  private parseContacts(input: any) {
    if (!input) return [];
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return Array.isArray(input) ? input : [];
  }

  private normalizeContactPhone(phone?: string): string {
    if (!phone) return "";
    const egyptian = normalizeEgyptianPhoneNumber(phone);
    if (egyptian !== phone) return egyptian;
    return phone.replace(/\D/g, "") || phone;
  }

  private async findContactByPhone(
    repo: Repository<CustomerEntity>,
    adminId: string,
    phoneNumber: string,
  ) {
    const normalized = this.normalizeContactPhone(phoneNumber);
    const digits = String(phoneNumber).replace(/\D/g, "");

    const exact = await repo.findOne({
      where: [
        { adminId, phoneNumber: normalized },
        { adminId, phoneNumber },
      ],
    });
    if (exact) return exact;

    if (!digits) return null;

    return repo
      .createQueryBuilder("contact")
      .where("contact.adminId = :adminId", { adminId })
      .andWhere(
        "regexp_replace(contact.phoneNumber, '\\D', '', 'g') = :digits",
        { digits },
      )
      .getOne();
  }

  async findClientIdByPhone(adminId: string, phoneNumber: string): Promise<string | null> {
    const contact = await this.findContactByPhone(this.contactRepo, adminId, phoneNumber);
    return contact?.clientId || null;
  }

  private async findClientOrThrow(me: any, clientId: string, manager?: EntityManager) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }

    const repo = manager ? manager.getRepository(ClientEntity) : this.clientRepo;
    const client = await repo.findOne({
      where: { id: clientId, adminId },
      relations: {
        contacts: true,
        primaryContact: true,
        addresses: true
      },
    });
    if (!client) {
      throw new NotFoundException(this.translations.t("domains.customer.not_found"));
    }
    return { client, adminId };
  }

  private async resolveContact(
    me: any,
    adminId: string,
    payload: LinkClientContactDto,
    manager: EntityManager,
    client?: ClientEntity,
  ) {
    const repo = manager.getRepository(CustomerEntity);
    let contact: CustomerEntity = null;

    if (payload.customerId) {
      contact = await repo.findOne({
        where: { id: payload.customerId, adminId },
      });
    } else if (payload.phoneNumber) {
      const phoneNumber = this.normalizeContactPhone(payload.phoneNumber);
      contact = await this.findContactByPhone(repo, adminId, payload.phoneNumber);
      if (!contact) {
        contact = await this.customerService.getOrCreateCustomer(
          me,
          {
            phoneNumber,
            name: client?.name || phoneNumber,
            profilePicture: client?.profilePicture,
          },
          manager,
        );
      }
    }

    if (!contact) {
      throw new NotFoundException(this.translations.t("domains.customer.not_found"));
    }
    if (contact.clientId && contact.clientId !== client?.id) {
      throw new ConflictException(this.translations.t("domains.customer.phone_already_exists", { args: { phoneNumber: contact.phoneNumber } }));
    }

    return contact;
  }

  private async syncContacts(
    me: any,
    client: ClientEntity,
    contactsInput: any,
    manager: EntityManager,
  ) {
    if (contactsInput === undefined || contactsInput === null) {
      return client;
    }

    const contacts = this.parseContacts(contactsInput);
    const contactRepo = manager.getRepository(CustomerEntity);
    const clientRepo = manager.getRepository(ClientEntity);

    const existing = await contactRepo.find({
      where: { clientId: client.id, adminId: client.adminId },
    });

    const resolvedContacts = [];
    for (const item of contacts) {
      const contact = await this.resolveContact(
        me,
        client.adminId,
        item,
        manager,
        client,
      );
      resolvedContacts.push({
        contact,
        isPrimary: item.isPrimary,
      });
    }

    const keepIds = new Set(resolvedContacts.map(({ contact }) => contact.id));
    const unlinkIds = existing
      .filter((contact) => !keepIds.has(contact.id))
      .map((contact) => contact.id);

    if (unlinkIds.includes(client.primaryContactId)) {
      client.primaryContactId = null;
      await clientRepo.update({ id: client.id }, { primaryContactId: null });
    }

    if (unlinkIds.length) {
      await contactRepo.update(
        {
          id: In(unlinkIds),
          adminId: client.adminId,
          clientId: client.id,
        },
        { clientId: null },
      );
    }

    if (resolvedContacts.length) {
      await contactRepo.update(
        {
          id: In([...keepIds]),
          adminId: client.adminId,
        },
        { clientId: client.id },
      );

      const primaryContact =
        resolvedContacts.find(({ isPrimary }) => isPrimary)?.contact ??
        resolvedContacts[0]?.contact;

      if (primaryContact && primaryContact.id !== client.primaryContactId) {
        client.primaryContactId = primaryContact.id;
        await clientRepo.update(
          { id: client.id },
          { primaryContactId: primaryContact.id },
        );
      }
    } else if (client.primaryContactId) {
      client.primaryContactId = null;
      await clientRepo.update({ id: client.id }, { primaryContactId: null });
    }

    return client;
  }

  async create(me: any, payload: CreateClientDto, manager?: EntityManager) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }

    return this.runInTransaction(manager, async (mgr) => {
      const repo = mgr.getRepository(ClientEntity);
      const client = repo.create({
        adminId,
        name: payload.name?.trim(),
        email: payload.email?.toLowerCase(),
        notes: payload.notes,
        profilePicture: payload.profilePicture,
      });
      const saved = await repo.save(client);
      await this.syncContacts(me, saved, payload.contacts, mgr);
      return this.findOne(me, saved.id, mgr);
    });
  }

  async update(me: any, clientId: string, payload: UpdateClientDto) {
    const { client, adminId } = await this.findClientOrThrow(me, clientId);
    const oldImage = client.profilePicture;

    if (payload.name !== undefined) client.name = payload.name?.trim();
    if (payload.email !== undefined) client.email = payload.email?.toLowerCase() || null;
    if (payload.notes !== undefined) client.notes = payload.notes;
    if (payload.profilePicture) client.profilePicture = payload.profilePicture;

    const saved = await this.dataSource.transaction(async (mgr) => {
      await mgr.getRepository(ClientEntity).save(client);
      await this.syncContacts(me, client, payload.contacts, mgr);
      return this.findOne(me, client.id, mgr);
    });

    if (oldImage && payload.profilePicture && oldImage !== payload.profilePicture) {
      deleteFile(oldImage);
    }

    return saved;
  }

  async findAllPaginated(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();
    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.clientRepo
      .createQueryBuilder("client")
      .leftJoinAndSelect("client.primaryContact", "primaryContact")
      .leftJoinAndSelect("client.contacts", "contacts")
      .leftJoinAndSelect("contacts.conversation", "conversation")
      .leftJoinAndSelect("conversation.lastMessage", "lastMessage")
      .where("client.adminId = :adminId", { adminId });

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("client.name ILIKE :s", { s: `%${search}%` })
            .orWhere("client.email ILIKE :s", { s: `%${search}%` })
            .orWhere("contacts.name ILIKE :s", { s: `%${search}%` })
            .orWhere("contacts.phoneNumber ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    const sortColumns: Record<string, string> = {
      createdAt: "client.createdAt",
      updatedAt: "client.updatedAt",
      name: "client.name",
      email: "client.email",
    };
    qb.orderBy(sortColumns[sortBy] || "client.createdAt", sortDir);

    const total = await qb.getCount();
    const { entities: records, raw } = await this.addClientCountSelects(qb)
      .skip((page - 1) * limit)
      .take(limit)
      .getRawAndEntities();
    this.attachClientCounts(records, raw);

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }

    const fetchLimit = Math.min(50, Math.max(1, Number(q?.limit) || 10));
    const search = String(q?.search ?? "").trim();

    const qb = this.clientRepo
      .createQueryBuilder("client")
      .leftJoinAndSelect("client.primaryContact", "primaryContact")
      .select([
        "client.id",
        "client.name",
        "client.email",
        "client.profilePicture",
        "client.createdAt",
        "primaryContact.id",
        "primaryContact.phoneNumber",
      ])
      .where("client.adminId = :adminId", { adminId })
      .andWhere("client.status = :status", { status: ClientStatus.ACTIVE })
      .orderBy("client.createdAt", "DESC")
      .addOrderBy("client.id", "DESC")
      .take(fetchLimit + 1);

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("client.name ILIKE :s", { s: `%${search}%` })
            .orWhere("client.email ILIKE :s", { s: `%${search}%` })
            .orWhere("primaryContact.phoneNumber ILIKE :s", { s: `%${search}%` })
            .orWhere(
              `EXISTS (
                SELECT 1 FROM customers contact
                WHERE contact."clientId" = client.id
                  AND (
                    contact."phoneNumber" ILIKE :s
                    OR contact.name ILIKE :s
                  )
              )`,
            );
        }),
      );
      qb.setParameter("s", `%${search}%`);
    }

    const cursor = String(q?.cursor ?? "").trim();
    if (cursor.includes("|")) {
      const [createdAt, id] = cursor.split("|");
      if (createdAt && id) {
        qb.andWhere(
          "(client.createdAt < :cAt OR (client.createdAt = :cAt AND client.id < :cId))",
          { cAt: createdAt, cId: id },
        );
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > fetchLimit;
    if (hasMore) rows.pop();

    const last = rows[rows.length - 1];
    const nextCursor =
      hasMore && last?.createdAt
        ? `${new Date(last.createdAt).toISOString()}|${last.id}`
        : null;

    return {
      data: rows,
      nextCursor,
      hasMore,
    };
  }

  async exportClients(me: any, q?: any) {
    const { records } = await this.findAllPaginated(me, {
      ...q,
      page: 1,
      limit: 10000,
    });
    const na = this.translations.t("common.not_applicable");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Clients");
    sheet.columns = [
      { header: this.translations.t("common.name"), key: "name", width: 25 },
      { header: this.translations.t("common.phone"), key: "phoneNumber", width: 18 },
      { header: "Contacts", key: "contacts", width: 35 },
      { header: this.translations.t("common.email"), key: "email", width: 30 },
      { header: this.translations.t("common.notes"), key: "notes", width: 35 },
      { header: "Orders", key: "ordersCount", width: 12 },
      { header: this.translations.t("common.created_at"), key: "createdAt", width: 20 },
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEFEFEF" },
    };

    records.forEach((client) => {
      sheet.addRow({
        name: client.name || na,
        phoneNumber: client.primaryContact?.phoneNumber || na,
        contacts: (client.contacts || []).map((contact) => contact.phoneNumber).join(", ") || na,
        email: client.email || na,
        notes: client.notes || na,
        ordersCount: Number((client as any).ordersCount || 0),
        createdAt: client.createdAt ? new Date(client.createdAt).toLocaleString() : na,
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  async findOne(me: any, clientId: string, manager?: EntityManager) {
    const { adminId } = await this.findClientOrThrow(me, clientId, manager);
    const repo = manager ? manager.getRepository(ClientEntity) : this.clientRepo;
    const { entities, raw } = await this.addClientCountSelects(
      repo
        .createQueryBuilder("client")
        .leftJoinAndSelect("client.primaryContact", "primaryContact")
        .leftJoinAndSelect("client.contacts", "contacts")
        .leftJoinAndSelect("contacts.conversation", "conversation")
        .leftJoinAndSelect("conversation.lastMessage", "lastMessage")
        .leftJoinAndSelect("client.addresses", "addresses")
        .leftJoinAndSelect("addresses.cityDetails", "city")
        .leftJoinAndSelect("addresses.areaDetails", "area")
        .where("client.id = :clientId", { clientId })
        .andWhere("client.adminId = :adminId", { adminId }),
    ).getRawAndEntities();
    this.attachClientCounts(entities, raw);
    const client = entities[0];

    if (!client) {
      throw new NotFoundException(this.translations.t("domains.customer.not_found"));
    }
    return client;
  }

  async remove(me: any, clientId: string) {
    const { client } = await this.findClientOrThrow(me, clientId);
    // do delete operation

    return this.clientRepo.delete(clientId);
  }

  async getStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }
    const since30Days = new Date();
    since30Days.setDate(since30Days.getDate() - 30);

    const [totalClients, clientsWithOrders, clientsWithDeliveredOrders, clientsWithOrdersLast30Days] =
      await Promise.all([
        this.clientRepo.count({ where: { adminId } }),
        this.countClientsWithOrders(adminId),
        this.countClientsWithOrders(adminId, { deliveredOnly: true }),
        this.countClientsWithOrders(adminId, { since: since30Days }),
      ]);

    return {
      totalClients,
      clientsWithOrders,
      clientsWithDeliveredOrders,
      clientsWithOrdersLast30Days,
    };
  }

  private async countClientsWithOrders(
    adminId: string,
    opts?: { deliveredOnly?: boolean; since?: Date },
  ) {
    const qb = this.clientRepo
      .createQueryBuilder("client")
      .innerJoin(
        OrderEntity,
        "ord",
        `ord.adminId = client."adminId"
         AND ord.deleted_at IS NULL
         AND ord."clientId" = client.id`,
      )
      .where("client.adminId = :adminId", { adminId })
      .select("COUNT(DISTINCT client.id)", "count");

    if (opts?.deliveredOnly) {
      qb.innerJoin(
        OrderStatusEntity,
        "status",
        "status.id = ord.statusId AND status.code = :deliveredCode",
        { deliveredCode: OrderStatus.DELIVERED },
      );
    }

    if (opts?.since) {
      qb.andWhere("ord.created_at >= :since", { since: opts.since });
    }

    const raw = await qb.getRawOne();
    return Number(raw?.count ?? 0);
  }

  async getOrderStatsSnapshot(adminId: string, clientId: string) {
    const raw = await this.dataSource
      .getRepository(OrderEntity)
      .createQueryBuilder("ord")
      .leftJoin("ord.status", "status")
      .where("ord.adminId = :adminId", { adminId })
      .andWhere("ord.clientId = :clientId", { clientId })
      .select("COUNT(ord.id)", "totalOrders")
      .addSelect("COUNT(CASE WHEN ord.isConfirmed = true THEN 1 END)", "allConfirmedCount")
      .addSelect(`COUNT(CASE WHEN status.code = :confirmedCode THEN 1 END)`, "confirmedCount")
      .addSelect("COALESCE(SUM(ord.finalTotal), 0)", "totalSales")
      .addSelect(`COUNT(CASE WHEN status.code = :deliveredCode THEN 1 END)`, "deliveredCount")
      .addSelect(`COUNT(CASE WHEN status.code = :postponedCode THEN 1 END)`, "postponedCount")
      .addSelect(
        `COALESCE(SUM(CASE WHEN status.code = :deliveredCode THEN ord.finalTotal ELSE 0 END), 0)`,
        "deliveredRevenue",
      )
      .addSelect(`COUNT(CASE WHEN status.code = :shippedCode THEN 1 END)`, "shippedCount")
      .addSelect(
        `(SELECT COUNT(DISTINCT so.id)
            FROM orders so
            INNER JOIN shipments sh ON sh."orderId" = so.id
            WHERE so."clientId" = :clientId
              AND so."adminId" = :adminId
              AND so.deleted_at IS NULL
              AND sh."shippedAt" IS NOT NULL)`,
        "allShippedCount",
      )
      .addSelect(`COUNT(CASE WHEN status.code = :returnedCode THEN 1 END)`, "returnedCount")
      .addSelect(
        `COUNT(CASE WHEN status.code IN ('${OrderStatus.CANCELLED}') THEN 1 END)`,
        "cancelledCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code IN ('${OrderStatus.CANCELLED}') AND COALESCE((
            SELECT occ."cancelledAfterShipping"
            FROM order_cancel_causes occ
            WHERE occ."orderId" = ord.id
            ORDER BY occ.created_at DESC
            LIMIT 1
          ), ord."shippedAt" IS NOT NULL) = false THEN 1 END)`,
        "cancelledBeforeShippingCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code IN ('${OrderStatus.CANCELLED}') AND COALESCE((
            SELECT occ."cancelledAfterShipping"
            FROM order_cancel_causes occ
            WHERE occ."orderId" = ord.id
            ORDER BY occ.created_at DESC
            LIMIT 1
          ), ord."shippedAt" IS NOT NULL) = true THEN 1 END)`,
        "cancelledAfterShippingCount",
      )
      .setParameter("deliveredCode", OrderStatus.DELIVERED)
      .setParameter("confirmedCode", OrderStatus.CONFIRMED)
      .setParameter("shippedCode", OrderStatus.SHIPPED)
      .setParameter("returnedCode", OrderStatus.RETURNED)
      .setParameter("postponedCode", OrderStatus.POSTPONED)
      .getRawOne();

    return this.mapClientOrderStats(raw);
  }

  private mapClientOrderStats(raw: any) {
    const totalOrders = Number(raw?.totalOrders ?? 0);
    const confirmedCount = Number(raw?.confirmedCount ?? 0);
    const allConfirmedCount = Number(raw?.allConfirmedCount ?? 0);
    const shippedCount = Number(raw?.shippedCount ?? 0);
    const cancelledCount = Number(raw?.cancelledCount ?? 0);
    const allShippedCount = Number(raw?.allShippedCount ?? 0);
    const cancelledBeforeShippingCount = Number(
      raw?.cancelledBeforeShippingCount ?? 0,
    );
    const cancelledAfterShippingCount = Number(
      raw?.cancelledAfterShippingCount ?? 0,
    );
    const deliveredCount = Number(raw?.deliveredCount ?? 0);
    const returnedCount = Number(raw?.returnedCount ?? 0);
    const rate = (count: number, denominator: number) =>
      denominator > 0 ? Number(((count / denominator) * 100).toFixed(2)) : 0;

    return {
      totalOrders,
      confirmedCount,
      confirmedPercent: rate(confirmedCount, totalOrders),
      confirmedRate: rate(allConfirmedCount, totalOrders),
      totalSales: Number(raw?.totalSales ?? 0),
      deliveredCount,
      deliveredPercent: rate(deliveredCount, totalOrders),
      postponedCount: Number(raw?.postponedCount ?? 0),
      deliveredRevenue: Number(raw?.deliveredRevenue ?? 0),
      shippedCount,
      shippedPercent: rate(shippedCount, totalOrders),
      returnedCount,
      returnedPercent: rate(returnedCount, totalOrders),
      cancelledCount,
      cancelledBeforeShippingCount,
      cancelledAfterShippingCount,
      cancelRate: rate(cancelledCount, totalOrders),
      beforeShippingCancelRate: rate(cancelledBeforeShippingCount, totalOrders),
      afterShippingCancelRate: rate(cancelledAfterShippingCount, totalOrders),
      afterShippingCancelRateOfShipped: rate(
        cancelledAfterShippingCount,
        allShippedCount,
      ),
    };
  }

  async getOrderStats(me: any, clientId: string) {
    const { adminId } = await this.findClientOrThrow(me, clientId);

    const [stats, tagRows] = await Promise.all([
      this.getOrderStatsSnapshot(adminId, clientId),
      this.dataSource
        .getRepository(OrderTagEntity)
        .createQueryBuilder("ot")
        .innerJoin("ot.order", "ord")
        .innerJoin("ot.tag", "tag")
        .where("ord.adminId = :adminId", { adminId })
        .andWhere("ord.clientId = :clientId", { clientId })
        .select("tag.id", "id")
        .addSelect("tag.name", "name")
        .addSelect("tag.color", "color")
        .addSelect("COUNT(DISTINCT ord.id)", "count")
        .groupBy("tag.id")
        .addGroupBy("tag.name")
        .addGroupBy("tag.color")
        .orderBy("count", "DESC")
        .addOrderBy("tag.name", "ASC")
        .getRawMany(),
    ]);

    return {
      ...stats,
      tags: tagRows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        count: Number(row.count ?? 0),
      })),
    };
  }

  async linkContact(
    me: any,
    clientId: string,
    payload: LinkClientContactDto,
  ) {
    return this.runInTransaction(undefined, async (mgr) => {
      const { client, adminId } = await this.findClientOrThrow(me, clientId, mgr);

      const contactRepo = mgr.getRepository(CustomerEntity);
      const clientRepo = mgr.getRepository(ClientEntity);

      const contact = await this.resolveContact(
        me,
        adminId,
        payload,
        mgr,
        client,
      );

      if(contact.clientId && contact.clientId !== client.id) {
        throw new BadRequestException(this.translations.t("domains.customer.phone_already_exists", { args: { phoneNumber: contact.phoneNumber } }));
      }

      await contactRepo.update(
        { id: contact.id, adminId },
        { clientId: client.id },
      );

      if (payload.isPrimary || !client.primaryContactId) {
        await clientRepo.update(
          { id: client.id, adminId },
          { primaryContactId: contact.id },
        );
      }

      return this.findOne(me, client.id, mgr);
    });
  }

  async unlinkContact(me: any, clientId: string, customerId: string) {
    return this.runInTransaction(undefined, async (mgr) => {
      const { client, adminId } = await this.findClientOrThrow(me, clientId, mgr);

      const customerRepo = mgr.getRepository(CustomerEntity);
      const clientRepo = mgr.getRepository(ClientEntity);

      const contact = await customerRepo.findOne({
        where: {
          id: customerId,
          adminId,
          clientId: client.id,
        },
      });

      if (!contact) {
        throw new NotFoundException(
          this.translations.t("domains.customer.not_found"),
        );
      }

      // Actually unlink the contact
      await customerRepo.update(
        { id: contact.id, adminId, clientId: client.id },
        {
          clientId: null,
        },
      );

      // If this was the primary contact, choose another one
      if (client.primaryContactId === contact.id) {
        const replacement = await customerRepo.findOne({
          where: {
            adminId,
            clientId: client.id,
            id: Not(contact.id),
          },
          order: {
            createdAt: "ASC",
          },
        });

        await clientRepo.update(
          { id: client.id, adminId },
          {
            primaryContactId: replacement?.id ?? null,
          },
        );
      }

      return this.findOne(me, client.id, mgr);
    });
  }

  async setPrimaryContact(me: any, clientId: string, customerId: string) {
    return this.runInTransaction(undefined, async (mgr) => {
      const { client, adminId } = await this.findClientOrThrow(
        me,
        clientId,
        mgr,
      );

      const contactRepo = mgr.getRepository(CustomerEntity);
      const clientRepo = mgr.getRepository(ClientEntity);

      const contact = await contactRepo.findOne({
        where: {
          id: customerId,
          adminId,
          clientId: client.id,
        },
      });

      if (!contact) {
        throw new NotFoundException(
          this.translations.t("domains.customer.not_found"),
        );
      }

      await clientRepo.update(
        { id: client.id, adminId },
        { primaryContactId: contact.id },
      );

      return this.findOne(me, client.id, mgr);
    });
  }

  async findContacts(me: any, clientId: string) {
    const { client } = await this.findClientOrThrow(me, clientId);
    return client.contacts || [];
  }

  private async loadCityAndArea(
    manager: EntityManager,
    cityId?: string | null,
    areaId?: string | null,
  ): Promise<{ city: CityEntity | null; area: AreaEntity | null }> {
    const cityRepo = manager.getRepository(CityEntity);
    const areaRepo = manager.getRepository(AreaEntity);
    let city: CityEntity | null = null;
    let area: AreaEntity | null = null;

    if (cityId) {
      city = await cityRepo.findOne({ where: { id: cityId } });
      if (!city) throw new NotFoundException(this.translations.t("domains.cities.not_found"));
    }
    if (areaId) {
      area = await areaRepo.findOne({ where: { id: areaId } });
      if (!area) throw new NotFoundException(this.translations.t("domains.cities.area_not_found"));
      if (city && area.cityId !== city.id) {
        throw new BadRequestException(this.translations.t("domains.cities.area_city_mismatch"));
      }
      if (!city) {
        city = await cityRepo.findOne({ where: { id: area.cityId } });
      }
    }
    return { city, area };
  }

  private assignCityAndArea(
    address: ClientAddressEntity,
    city: CityEntity | null,
    area: AreaEntity | null,
  ) {
    address.cityDetails = city;
    address.cityId = city?.id ?? null;
    address.city = city?.nameAr ?? "";
    address.areaDetails = area;
    address.areaId = area?.id ?? null;
    address.area = area?.nameAr ?? "";
  }

  async findAllAddresses(me: any, clientId: string) {
    const { adminId } = await this.findClientOrThrow(me, clientId);
    return this.addressRepo.find({
      where: { clientId, adminId },
      order: { isDefault: "DESC", createdAt: "DESC" },
    });
  }

  async createAddress(me: any, clientId: string, payload: CreateClientAddressDto) {
    return this.runInTransaction(undefined, async (mgr) => {
      const { client, adminId } = await this.findClientOrThrow(me, clientId, mgr);
      const { city, area } = await this.loadCityAndArea(mgr, payload.cityId, payload.areaId);
      const repo = mgr.getRepository(ClientAddressEntity);
      const address = repo.create({
        adminId,
        clientId: client.id,
        label: payload.label,
        address: payload.address,
        landmark: payload.landmark,
        isDefault: payload.isDefault ?? false,
      });
      this.assignCityAndArea(address, city, area);
      if (address.isDefault) {
        await this.clearDefaultAddress(adminId, client.id, mgr);
      }
      return repo.save(address);
    });
  }

  async updateAddress(me: any, clientId: string, addressId: string, payload: UpdateClientAddressDto) {
    return this.runInTransaction(undefined, async (mgr) => {
      const { client, adminId } = await this.findClientOrThrow(me, clientId, mgr);
      const repo = mgr.getRepository(ClientAddressEntity);
      const address = await repo.findOne({ where: { id: addressId, clientId: client.id, adminId } });
      if (!address) throw new NotFoundException(this.translations.t("domains.customer.address_not_found"));
      if (payload.isDefault) await this.clearDefaultAddress(adminId, client.id, mgr);
      if (payload.label !== undefined) address.label = payload.label;
      if (payload.address !== undefined) address.address = payload.address;
      if (payload.landmark !== undefined) address.landmark = payload.landmark;
      if (payload.isDefault !== undefined) address.isDefault = payload.isDefault;
      if (payload.cityId !== undefined || payload.areaId !== undefined) {
        const { city, area } = await this.loadCityAndArea(
          mgr,
          payload.cityId !== undefined ? payload.cityId : address.cityId,
          payload.areaId !== undefined ? payload.areaId : address.areaId,
        );
        this.assignCityAndArea(address, city, area);
      }
      return repo.save(address);
    });
  }

  async setDefaultAddress(me: any, clientId: string, addressId: string) {
    return this.runInTransaction(undefined, async (mgr) => {
      const { client, adminId } = await this.findClientOrThrow(me, clientId, mgr);
      const repo = mgr.getRepository(ClientAddressEntity);
      const address = await repo.findOne({ where: { id: addressId, clientId: client.id, adminId } });
      if (!address) throw new NotFoundException(this.translations.t("domains.customer.address_not_found"));
      await this.clearDefaultAddress(adminId, client.id, mgr);
      address.isDefault = true;
      return repo.save(address);
    });
  }

  async removeAddress(me: any, clientId: string, addressId: string) {
    const { adminId } = await this.findClientOrThrow(me, clientId);
    const address = await this.addressRepo.findOne({ where: { id: addressId, clientId, adminId } });
    if (!address) throw new NotFoundException(this.translations.t("domains.customer.address_not_found"));
    await this.addressRepo.remove(address);
    return { id: addressId };
  }

  private async clearDefaultAddress(
    adminId: string,
    clientId: string,
    manager: EntityManager,
  ) {
    await manager
      .createQueryBuilder()
      .update(ClientAddressEntity)
      .set({ isDefault: false })
      .where("clientId = :clientId", { clientId })
      .andWhere("adminId = :adminId", { adminId })
      .andWhere("isDefault = :isDefault", { isDefault: true })
      .execute();
  }
}
