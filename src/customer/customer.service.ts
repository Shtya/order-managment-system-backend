import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, DataSource, EntityManager, Repository } from "typeorm";
import { CustomerEntity } from "entities/customers.entity";
import { ClientAddressEntity, ClientEntity } from "entities/clients.entity";
import { AreaEntity, CityEntity } from "entities/cities.entity";
import { OrderEntity, OrderStatus, OrderStatusEntity } from "entities/order.entity";
import { OrderTagEntity } from "entities/tag.entity";
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CreateCustomerAddressDto,
  UpdateCustomerAddressDto,
} from "dto/customer.dto";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { AppGateway } from "common/app.gateway";
import { deleteFile } from "common/healpers";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly customerRepo: Repository<CustomerEntity>,
    @InjectRepository(ClientEntity)
    private readonly clientRepo: Repository<ClientEntity>,
    @InjectRepository(ClientAddressEntity)
    private readonly addressRepo: Repository<ClientAddressEntity>,
    private readonly dataSource: DataSource,
    private readonly appGateway: AppGateway,
    private readonly translations: TranslationService,
  ) {}

  private runInTransaction<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (manager) return work(manager);
    return this.dataSource.transaction((mgr) => work(mgr));
  }

  async update(me: any, id: string, payload: UpdateCustomerDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
    });
    if (!customer) {
      throw new NotFoundException(
        this.translations.t("domains.customer.not_found"),
      );
    }

    if (payload.phoneNumber) {
      const normalizedPhone = normalizeEgyptianPhoneNumber(payload.phoneNumber);
      if (normalizedPhone !== customer.phoneNumber) {
        const phoneTaken = await this.customerRepo.findOne({
          where: { phoneNumber: normalizedPhone, adminId },
        });
        if (phoneTaken) {
          throw new ConflictException(
            this.translations.t("domains.customer.phone_already_exists"),
          );
        }
        customer.phoneNumber = normalizedPhone;
        customer.waId = normalizedPhone;
      }
    }

    const oldImage = customer.profilePicture;
    if (payload.profilePicture) {
      customer.profilePicture = payload.profilePicture;
    }

    if (payload.name) {
      customer.name = payload.name.trim();
    }

    customer.notes = payload.notes;

    const saved = await this.customerRepo.save(customer);
    if (oldImage && oldImage !== saved.profilePicture) {
      deleteFile(oldImage);
    }
    return saved;
  }

  async getOrCreateCustomer(
    me: any,
    payload: {
      phoneNumber: string;
      name?: string;
      profilePicture?: string;
      notes?: string;
    },
    manager?: EntityManager,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const repo = manager
      ? manager.getRepository(CustomerEntity)
      : this.customerRepo;
    const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(
      payload.phoneNumber,
    );

    // Attempt atomic insert ignoring conflict on unique keys (adminId, phoneNumber)
    const insertResult = await repo
      .createQueryBuilder()
      .insert()
      .into(CustomerEntity)
      .values({
        adminId,
        waId: normalizedPhoneNumber,
        phoneNumber: normalizedPhoneNumber,
        name: payload.name || normalizedPhoneNumber,
        profilePicture: payload.profilePicture,
        notes: payload.notes,
      })
      .orIgnore() // Generates "ON CONFLICT DO NOTHING" in Postgres or "INSERT IGNORE" in MySQL
      .returning("*") // Postgres specific: returns inserted raw values
      .execute();

    // If a row was inserted by this query
    if (insertResult.raw?.length > 0) {
      const newCustomer = repo.create(insertResult.raw[0] as CustomerEntity);
      this.appGateway.emitNewCustomer(adminId, newCustomer);
      return newCustomer;
    }

    // If it wasn't inserted (already exists), fetch the customer
    return await repo.findOne({
      where: { phoneNumber: normalizedPhoneNumber, adminId },
    });
  }

  async createCustomer(
    me: any,
    payload: CreateCustomerDto,
    manager?: EntityManager,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const repo = manager
      ? manager.getRepository(CustomerEntity)
      : this.customerRepo;
    const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(
      payload.phoneNumber,
    );

    const existing = await repo.findOne({
      where: { phoneNumber: normalizedPhoneNumber, adminId },
    });

    if (existing) {
      throw new ConflictException(
        this.translations.t("domains.customer.phone_already_exists"),
      );
    }

    const customer = repo.create({
      adminId,
      waId: normalizedPhoneNumber,
      phoneNumber: normalizedPhoneNumber,
      name: payload.name || normalizedPhoneNumber,
      profilePicture: payload.profilePicture,
      notes: payload.notes,
    });
    const saved = await repo.save(customer);

    // Emit new customer notification
    this.appGateway.emitNewCustomer(adminId, saved);

    return saved;
  }

  async findAllPaginated(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();
    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.customerRepo
      .createQueryBuilder("customer")
      .leftJoinAndSelect("customer.client", "client")
      .leftJoinAndSelect("customer.conversation", "conversation")
      .leftJoinAndSelect("conversation.lastMessage", "lastMessage")
      .loadRelationCountAndMap("customer.ordersCount", "customer.orders")
      .where("customer.adminId = :adminId", { adminId });

    // Search (by name or phone number)
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("customer.name ILIKE :s", { s: `%${search}%` })
          .orWhere("customer.phoneNumber ILIKE :s",{ s: `%${search}%` })
        }),
      );
    }

    // Sorting
    const sortColumns: Record<string, string> = {
      createdAt: "customer.createdAt",
      updatedAt: "customer.updatedAt",
      name: "customer.name",
      phoneNumber: "customer.phoneNumber",
    };

    if (sortColumns[sortBy]) {
      qb.orderBy(sortColumns[sortBy], sortDir);
    } else {
      qb.orderBy("customer.createdAt", "DESC");
    }

    const total = await qb.getCount();
    const records = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async getStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const since30Days = new Date();
    since30Days.setDate(since30Days.getDate() - 30);

    const [totalCustomers, withOrders, withDelivered, withOrdersLast30Days] =
      await Promise.all([
        this.customerRepo.count({ where: { adminId } }),
        this.countCustomersWithOrders(adminId),
        this.countCustomersWithOrders(adminId, { deliveredOnly: true }),
        this.countCustomersWithOrders(adminId, { since: since30Days }),
      ]);

    return {
      totalCustomers,
      customersWithOrders: withOrders,
      customersWithDeliveredOrders: withDelivered,
      customersWithOrdersLast30Days: withOrdersLast30Days,
    };
  }

  private async countCustomersWithOrders(
    adminId: string,
    opts?: { deliveredOnly?: boolean; since?: Date },
  ) {
    const qb = this.customerRepo
      .createQueryBuilder("customer")
      .innerJoin(
        OrderEntity,
        "ord",
        `ord.adminId = customer."adminId"
         AND ord.deleted_at IS NULL
         AND customer."clientId" IS NOT NULL
         AND ord."clientId" = customer."clientId"`,
      )
      .where("customer.adminId = :adminId", { adminId })
      .select("COUNT(DISTINCT customer.id)", "count");

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

  async getOrderStats(me: any, customerId: string) {
    const { customer, adminId } = await this.findCustomerOrThrow(me, customerId);
    const clientId = customer.clientId;
    const emptyStats = {
      totalOrders: 0,
      confirmedCount: 0,
      confirmedRate: 0,
      totalSales: 0,
      deliveredCount: 0,
      deliveredRevenue: 0,
      tags: [],
    };
    if (!clientId) {
      return emptyStats;
    }

    const [raw, tagRows] = await Promise.all([
      this.dataSource
        .getRepository(OrderEntity)
        .createQueryBuilder("ord")
        .leftJoin("ord.status", "status")
        .where("ord.adminId = :adminId", { adminId })
        .andWhere("ord.clientId = :clientId", { clientId })
        .select("COUNT(ord.id)", "totalOrders")
        .addSelect(
          "COUNT(CASE WHEN ord.isConfirmed = true THEN 1 END)",
          "confirmedCount",
        )
        .addSelect("COALESCE(SUM(ord.finalTotal), 0)", "totalSales")
        .addSelect(
          `COUNT(CASE WHEN status.code = :deliveredCode THEN 1 END)`,
          "deliveredCount",
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN status.code = :deliveredCode THEN ord.finalTotal ELSE 0 END), 0)`,
          "deliveredRevenue",
        )
        .setParameter("deliveredCode", OrderStatus.DELIVERED)
        .getRawOne(),
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

    const totalOrders = Number(raw?.totalOrders ?? 0);
    const confirmedCount = Number(raw?.confirmedCount ?? 0);

    return {
      totalOrders,
      confirmedCount,
      confirmedRate:
        totalOrders > 0
          ? Number(((confirmedCount / totalOrders) * 100).toFixed(2))
          : 0,
      totalSales: Number(raw?.totalSales ?? 0),
      deliveredCount: Number(raw?.deliveredCount ?? 0),
      deliveredRevenue: Number(raw?.deliveredRevenue ?? 0),
      tags: tagRows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        count: Number(row.count ?? 0),
      })),
    };
  }

  async exportCustomers(me: any, q?: any) {
    const { records } = await this.findAllPaginated(me, {
      ...q,
      page: 1,
      limit: 10000,
    });
    const na = this.translations.t("common.not_applicable");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(
      this.translations.t("domains.customer.export_sheet"),
    );

    sheet.columns = [
      { header: this.translations.t("common.name"), key: "name", width: 25 },
      {
        header: this.translations.t("common.phone"),
        key: "phoneNumber",
        width: 18,
      },
      {
        header: "Client",
        key: "clientName",
        width: 25,
      },
      { header: this.translations.t("common.notes"), key: "notes", width: 35 },
      {
        header: this.translations.t("common.created_at"),
        key: "createdAt",
        width: 20,
      },
    ];

    this.styleExcelHeader(sheet);

    records.forEach((c) => {
      sheet.addRow({
        name: c.name || na,
        phoneNumber: c.phoneNumber || na,
        clientName: c.client?.name || na,
        notes: c.notes || na,
        createdAt: c.createdAt
          ? new Date(c.createdAt).toLocaleString()
          : na,
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  async exportAddresses(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const search = String(q?.search ?? "").trim();
    const customerId = q?.customerId ? String(q.customerId).trim() : "";
    const clientId = q?.clientId ? String(q.clientId).trim() : "";
    const na = this.translations.t("common.not_applicable");

    const qb = this.addressRepo
      .createQueryBuilder("addr")
      .leftJoinAndSelect("addr.client", "client")
      .leftJoinAndSelect("client.primaryContact", "primaryContact")
      .leftJoinAndSelect("addr.cityDetails", "city")
      .leftJoinAndSelect("addr.areaDetails", "area")
      .where("addr.adminId = :adminId", { adminId });

    if (clientId) {
      qb.andWhere("addr.clientId = :clientId", { clientId });
    } else if (customerId) {
      const contact = await this.customerRepo.findOne({
        where: { id: customerId, adminId },
      });
      if (contact?.clientId) {
        qb.andWhere("addr.clientId = :clientId", { clientId: contact.clientId });
      } else {
        qb.andWhere("1 = 0");
      }
    }

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.orWhere("addr.address ILIKE :s", { s: `%${search}%` })
            .orWhere("addr.city ILIKE :s", { s: `%${search}%` })
            .orWhere("addr.area ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    const records = await qb
      .orderBy("addr.isDefault", "DESC")
      .addOrderBy("addr.createdAt", "DESC")
      .take(10000)
      .getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(
      this.translations.t("domains.customer.export_addresses_sheet"),
    );

    sheet.columns = [
      {
        header: this.translations.t("common.name"),
        key: "customerName",
        width: 25,
      },
      {
        header: this.translations.t("common.phone"),
        key: "customerPhone",
        width: 18,
      },
      {
        header: this.translations.t("domains.customer.export_label"),
        key: "label",
        width: 15,
      },
      {
        header: this.translations.t("common.address"),
        key: "address",
        width: 40,
      },
      {
        header: this.translations.t("domains.customer.export_city"),
        key: "city",
        width: 18,
      },
      {
        header: this.translations.t("domains.customer.export_area"),
        key: "area",
        width: 18,
      },
      {
        header: this.translations.t("domains.customer.export_landmark"),
        key: "landmark",
        width: 20,
      },
      {
        header: this.translations.t("domains.customer.export_is_default"),
        key: "isDefault",
        width: 12,
      },
      {
        header: this.translations.t("common.created_at"),
        key: "createdAt",
        width: 20,
      },
    ];

    this.styleExcelHeader(sheet);

    records.forEach((addr) => {
      sheet.addRow({
        customerName: addr.client?.name || na,
        customerPhone: addr.client?.primaryContact?.phoneNumber || na,
        label: addr.label || na,
        address: addr.address || na,
        city: addr.cityDetails?.nameAr || addr.city || na,
        area: addr.areaDetails?.nameAr || addr.area || na,
        landmark: addr.landmark || na,
        isDefault: addr.isDefault
          ? this.translations.t("common.yes")
          : this.translations.t("common.no"),
        createdAt: addr.createdAt
          ? new Date(addr.createdAt).toLocaleString()
          : na,
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  private styleExcelHeader(sheet: ExcelJS.Worksheet) {
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };
  }

  async findOne(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
      relations: ["conversation"],
    });

    if (!customer) {
      throw new NotFoundException(
        this.translations.t("domains.customer.not_found"),
      );
    }

    return customer;
  }

  async remove(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
    });
    if (!customer) {
      throw new NotFoundException(
        this.translations.t("domains.customer.not_found"),
      );
    }

    await this.customerRepo.remove(customer);
    
    if (customer.profilePicture) {
      deleteFile(customer.profilePicture);
    }

    return { id };
  }

  // ── Customer Addresses ───────────────────────────────────────────

  private async findCustomerOrThrow(
    me: any,
    customerId: string,
    manager?: EntityManager,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const repo = manager
      ? manager.getRepository(CustomerEntity)
      : this.customerRepo;
    const customer = await repo.findOne({
      where: { id: customerId, adminId },
    });
    if (!customer) {
      throw new NotFoundException(
        this.translations.t("domains.customer.not_found"),
      );
    }
    return { customer, adminId };
  }

  private async findAddressOrThrow(
    adminId: string,
    clientId: string,
    addressId: string,
    manager?: EntityManager,
  ) {
    const repo = manager
      ? manager.getRepository(ClientAddressEntity)
      : this.addressRepo;
    const address = await repo.findOne({
      where: { id: addressId, clientId, adminId },
    });
    if (!address) {
      throw new NotFoundException(
        this.translations.t("domains.customer.address_not_found"),
      );
    }
    return address;
  }

  private async ensureClientForCustomer(
    customer: CustomerEntity,
    adminId: string,
    manager: EntityManager,
  ) {
    if (customer.clientId) return customer.clientId;

    const clientRepo = manager.getRepository(ClientEntity);
    const contactRepo = manager.getRepository(CustomerEntity);
    const client = clientRepo.create({
      adminId,
      name: customer.name || customer.phoneNumber,
      notes: customer.notes,
      profilePicture: customer.profilePicture,
      primaryContactId: customer.id,
    });
    const saved = await clientRepo.save(client);

    customer.clientId = saved.id;
    await contactRepo.save(customer);
    return saved.id;
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
      if (!city) {
        throw new NotFoundException(
          this.translations.t("domains.cities.not_found"),
        );
      }
    }

    if (areaId) {
      area = await areaRepo.findOne({ where: { id: areaId } });
      if (!area) {
        throw new NotFoundException(
          this.translations.t("domains.cities.area_not_found"),
        );
      }

      if (city && area.cityId !== city.id) {
        throw new BadRequestException(
          this.translations.t("domains.cities.area_city_mismatch"),
        );
      }

      if (!city) {
        city = await cityRepo.findOne({ where: { id: area.cityId } });
        if (!city) {
          throw new NotFoundException(
            this.translations.t("domains.cities.not_found"),
          );
        }
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

  async createAddress(
    me: any,
    customerId: string,
    payload: CreateCustomerAddressDto,
    manager?: EntityManager,
  ) {
    return this.runInTransaction(manager, async (mgr) => {
      const { customer, adminId } = await this.findCustomerOrThrow(
        me,
        customerId,
        mgr,
      );
      const addressRepo = mgr.getRepository(ClientAddressEntity);
      const clientId = await this.ensureClientForCustomer(customer, adminId, mgr);
      const { city, area } = await this.loadCityAndArea(
        mgr,
        payload.cityId,
        payload.areaId,
      );

      const address = addressRepo.create({
        adminId,
        clientId,
        label: payload.label,
        address: payload.address,
        landmark: payload.landmark,
        isDefault: payload.isDefault ?? false,
      });
      this.assignCityAndArea(address, city, area);

      if (address.isDefault) {
        await this.clearDefaultAddress(adminId, clientId, mgr);
        address.isDefault = true;
      }

      return addressRepo.save(address);
    });
  }

  async findAllAddresses(
    me: any,
    customerId: string,
    q?: any,
    manager?: EntityManager,
  ) {
    const { customer, adminId } = await this.findCustomerOrThrow(
      me,
      customerId,
      manager,
    );
    const addressRepo = manager
      ? manager.getRepository(ClientAddressEntity)
      : this.addressRepo;
    const clientId = customer.clientId;

    // const page = Number(q?.page ?? 1);
    // const limit = Number(q?.limit ?? 10);

    const qb = addressRepo
      .createQueryBuilder("addr")
      .where("addr.clientId = :clientId", { clientId: clientId || "" })
      .andWhere("addr.adminId = :adminId", { adminId });

    // const total = await qb.getCount();
    const records = await qb
      .orderBy("addr.isDefault", "DESC")
      .addOrderBy("addr.createdAt", "DESC")
      // .skip((page - 1) * limit)
      // .take(limit)
      .getMany();

    return records;
  }

  async findOneAddress(
    me: any,
    customerId: string,
    addressId: string,
    manager?: EntityManager,
  ) {
    const { customer, adminId } = await this.findCustomerOrThrow(
      me,
      customerId,
      manager,
    );
    if (!customer.clientId) {
      throw new NotFoundException(
        this.translations.t("domains.customer.address_not_found"),
      );
    }
    return this.findAddressOrThrow(adminId, customer.clientId, addressId, manager);
  }

  async updateAddress(
    me: any,
    customerId: string,
    addressId: string,
    payload: UpdateCustomerAddressDto,
    manager?: EntityManager,
  ) {
    return this.runInTransaction(manager, async (mgr) => {
      const { customer, adminId } = await this.findCustomerOrThrow(
        me,
        customerId,
        mgr,
      );
      const clientId = await this.ensureClientForCustomer(customer, adminId, mgr);
      const address = await this.findAddressOrThrow(
        adminId,
        clientId,
        addressId,
        mgr,
      );
      const addressRepo = mgr.getRepository(ClientAddressEntity);

      if (payload.isDefault) {
        await this.clearDefaultAddress(adminId, clientId, mgr);
        address.isDefault = true;
      }

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

      return addressRepo.save(address);
    });
  }

  async setDefaultAddress(
    me: any,
    customerId: string,
    addressId: string,
    manager?: EntityManager,
  ) {
    return this.runInTransaction(manager, async (mgr) => {
      const { customer, adminId } = await this.findCustomerOrThrow(
        me,
        customerId,
        mgr,
      );
      const clientId = await this.ensureClientForCustomer(customer, adminId, mgr);
      const address = await this.findAddressOrThrow(
        adminId,
        clientId,
        addressId,
        mgr,
      );

      await this.clearDefaultAddress(adminId, clientId, mgr);
      address.isDefault = true;
      return mgr.getRepository(ClientAddressEntity).save(address);
    });
  }

  async removeDefaultAddress(
    me: any,
    customerId: string,
    addressId: string,
    manager?: EntityManager,
  ) {
    return this.runInTransaction(manager, async (mgr) => {
      const { customer, adminId } = await this.findCustomerOrThrow(
        me,
        customerId,
        mgr,
      );
      const clientId = await this.ensureClientForCustomer(customer, adminId, mgr);
      const address = await this.findAddressOrThrow(
        adminId,
        clientId,
        addressId,
        mgr,
      );

      address.isDefault = false;
      return mgr.getRepository(ClientAddressEntity).save(address);
    });
  }

  async removeAddress(
    me: any,
    customerId: string,
    addressId: string,
    manager?: EntityManager,
  ) {
    return this.runInTransaction(manager, async (mgr) => {
      const { customer, adminId } = await this.findCustomerOrThrow(
        me,
        customerId,
        mgr,
      );
      const clientId = await this.ensureClientForCustomer(customer, adminId, mgr);
      const address = await this.findAddressOrThrow(
        adminId,
        clientId,
        addressId,
        mgr,
      );

      await mgr.getRepository(ClientAddressEntity).remove(address);
      return { id: addressId };
    });
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
