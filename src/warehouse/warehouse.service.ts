import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { STORAGE_LOCATION_CHILDREN, StorageLocationEntity, StorageLocationType, WarehouseEntity } from "entities/warehouses.entity";
import { CreateWarehouseDto, UpdateWarehouseDto } from "dto/warehouse.dto";
import { CreateStorageLocationDto, UpdateStorageLocationDto } from "dto/storage-location.dto";
import { CRUD } from "../../common/crud.service";
import { tenantId } from "../category/category.service";
import { DateFilterUtil } from "common/date-filter.util";
import * as ExcelJS from 'exceljs';
import { I18nKey, TranslationService } from "common/translation.service";

@Injectable()
export class WarehousesService {
	constructor(
		@InjectRepository(WarehouseEntity) private warehousesRepo: Repository<WarehouseEntity>,
		@InjectRepository(StorageLocationEntity) private locationsRepo: Repository<StorageLocationEntity>,
		private readonly translations: TranslationService,
	) { }


	async list(me: any, q?: any) {
		const adminId = tenantId(me);

		const page = q?.page ?? 1;
		const limit = q?.limit ?? 10;

		const qb = this.warehousesRepo
			.createQueryBuilder("w")
			.where(`w."adminId" = :adminId`, { adminId })
			.orderBy(`w."created_at"`, "DESC");

		DateFilterUtil.applyToQueryBuilder(
			qb,
			"w.created_at",
			q?.startDate,
			q?.endDate
		);

		if (q?.isActive !== undefined) {
			qb.andWhere(
				`w."isActive" = :isActive`,
				{ isActive: q.isActive }
			);
		}

		if (q?.search?.trim()) {
			const search = `%${String(q.search).trim().toLowerCase()}%`;

			qb.andWhere(
				`(
				LOWER(w.name) LIKE :search
				OR LOWER(w.address) LIKE :search
			)`,
				{ search }
			);
		}

		const [records, total] = await qb
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return {
			total_records: total,
			current_page: page,
			per_page: limit,
			records
		};
	}

	async export(me: any, q: any) {
		const { records } = await this.list(me, {
			...q,
			limit: 1000,
			page: 1,
		});

		const workbook = new ExcelJS.Workbook();

		const worksheet = workbook.addWorksheet(
			this.translations.t("domains.warehouses.title")
		);

		worksheet.columns = [
			{
				header: this.translations.t("common.name"),
				key: "name",
				width: 25,
			},
			{
				header: this.translations.t("common.address"),
				key: "address",
				width: 35,
			},
			{
				header: this.translations.t("common.description"),
				key: "description",
				width: 35,
			},
			{
				header: this.translations.t("common.status"),
				key: "status",
				width: 15,
			},
			{
				header: this.translations.t("common.created_at"),
				key: "createdAt",
				width: 25,
			},
		];

		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).fill = {
			type: "pattern",
			pattern: "solid",
			fgColor: { argb: "FFE0E0E0" },
		};

		records.forEach(w => {
			worksheet.addRow({
				name: w.name,
				address:
					w.address ||
					this.translations.t("common.not_available_symbol"),

				description:
					w.description ||
					this.translations.t("common.not_available_symbol"),

				status: w.isActive
					? this.translations.t("common.active")
					: this.translations.t("common.inactive"),

				createdAt: w.created_at,
			});
		});

		return await workbook.xlsx.writeBuffer();
	}

	async get(me: any, id: string) {
		const adminId = tenantId(me);
		const entity = await CRUD.findOne(this.warehousesRepo, "warehouses", id);
		if ((entity as any).adminId !== adminId) throw new ForbiddenException(this.translations.t("common.not_allowed"));
		return entity;
	}

	async create(me: any, dto: CreateWarehouseDto) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException(this.translations.t("common.missing_admin_id"));

		const exists = await this.warehousesRepo.findOne({ where: { adminId, name: dto.name } as any });
		if (exists) throw new BadRequestException(this.translations.t("domains.warehouses.name_already_exists"));

		const wh = this.warehousesRepo.create({
			adminId,
			name: dto.name,
			address: dto.address,
			description: dto.description,
			isActive: dto.isActive ?? true,
		});

		return this.warehousesRepo.save(wh);
	}

	async update(me: any, id: string, dto: UpdateWarehouseDto) {
		const wh = await this.get(me, id);

		if (dto.name !== undefined && dto.name !== (wh as any).name) {
			const adminId = tenantId(me);
			const exists = await this.warehousesRepo.findOne({ where: { adminId, name: dto.name } as any });
			if (exists && (exists as any).id !== (wh as any).id) throw new BadRequestException(this.translations.t("domains.warehouses.name_already_exists"));
		}

		if (dto.name !== undefined) (wh as any).name = dto.name;
		if (dto.address !== undefined) (wh as any).address = dto.address;
		if (dto.description !== undefined) (wh as any).description = dto.description;
		if (dto.isActive !== undefined) (wh as any).isActive = dto.isActive;

		return this.warehousesRepo.save(wh as any);
	}

	async remove(me: any, id: string) {
		await this.get(me, id);
		await this.warehousesRepo.delete({ id } as any);
		return { message: this.translations.t("domains.warehouses.deleted") };
	}

	async toggleStatus(me: any, id: string) {
		const wh = await this.get(me, id);
		(wh as any).isActive = !(wh as any).isActive;
		await this.warehousesRepo.save(wh as any);
		return wh;
	}

	private async getLocationForWarehouse(me: any, warehouseId: string, locationId: string) {
		const adminId = tenantId(me);
		const location = await this.locationsRepo.findOne({
			where: { id: locationId, adminId, warehouseId } as any,
		});
		if (!location) throw new BadRequestException(this.translations.t("domains.warehouses.location_not_found"));
		return location;
	}

	private async assertValidParent(me: any, warehouseId: string, parentId: string, childType: StorageLocationType) {
		const adminId = tenantId(me);
		const parent = await this.locationsRepo.findOne({
			where: { id: parentId, adminId, warehouseId } as any,
		});
		if (!parent) throw new BadRequestException(this.translations.t("domains.warehouses.parent_location_not_found"));

		const allowed = STORAGE_LOCATION_CHILDREN[parent.type] ?? [];
		if (!allowed.includes(childType)) throw new BadRequestException(this.translations.t("domains.warehouses.invalid_location_type_for_parent"));

		return parent;
	}

	async listLocations(me: any, q?: any) {
		const adminId = tenantId(me);
		const page = q?.page ?? 1;
		const limit = q?.limit ?? 10;
		const qb = this.locationsRepo
			.createQueryBuilder("l")
			.leftJoinAndSelect("l.parent", "parent")
			.leftJoinAndSelect("l.warehouse", "warehouse")
			.where(`l."adminId" = :adminId`, { adminId })
			.orderBy(`l."created_at"`, "ASC");
		DateFilterUtil.applyToQueryBuilder(qb, "l.created_at", q?.startDate, q?.endDate);

		if (q?.types) {
			const typesArr = String(q.types).split(",").map(s => s.trim()).filter(Boolean);
			if (typesArr.length > 0) qb.andWhere("l.type IN (:...types)", { types: typesArr });
		} else if (q?.type) {
			qb.andWhere("l.type = :type", { type: q.type });
		}

		if (q?.parentId) qb.andWhere("l.parentId = :parentId", { parentId: q.parentId });

		if (q?.isActive) qb.andWhere("l.isActive = :isActive", { isActive: q.isActive });

		if (q?.warehouseId) qb.andWhere("l.warehouseId = :warehouseId", { warehouseId: q.warehouseId });

		if (q?.search?.trim()) {
			const search = `%${String(q.search).trim().toLowerCase()}%`;
			qb.andWhere("LOWER(l.name) LIKE :search", { search });
		}

		const [records, total] = await qb
			.orderBy("l.created_at", "DESC")
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return {
			total_records: total,
			current_page: page,
			per_page: limit,
			records
		};
	}

	async exportLocations(me: any, q: any) {
		const { records } = await this.listLocations(
			me,
			{
				...q,
				limit: 1000,
				page: 1,
			}
		);

		const workbook = new ExcelJS.Workbook();

		const worksheet = workbook.addWorksheet(
			this.translations.t("domains.warehouses.titleLocations")
		);

		worksheet.columns = [
			{
				header: this.translations.t("common.name"),
				key: "name",
				width: 25,
			},
			{
				header: this.translations.t("common.type"),
				key: "type",
				width: 15,
			},
			{
				header: this.translations.t("common.parent"),
				key: "parent",
				width: 25,
			},
			{
				header: this.translations.t("common.description"),
				key: "description",
				width: 35,
			},
			{
				header: this.translations.t("common.created_at"),
				key: "createdAt",
				width: 25,
			},
		];

		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).fill = {
			type: "pattern",
			pattern: "solid",
			fgColor: { argb: "FFE0E0E0" },
		};

		records.forEach(location => {
			worksheet.addRow({
				name: location.name,

				type: this.translations.t(
					`domains.warehouses.storage_location_types.${location.type}` as I18nKey
				),

				parent:
					location.parent?.name ||
					this.translations.t("common.not_available_symbol"),

				description:
					location.description ||
					this.translations.t("common.not_available_symbol"),

				createdAt: location.created_at,
			});
		});

		return await workbook.xlsx.writeBuffer();
	}

	async createLocation(me: any, warehouseId: string, dto: CreateStorageLocationDto) {
		await this.get(me, warehouseId);
		const adminId = tenantId(me);

		const existing = await this.locationsRepo.findOne({
			where: { adminId, warehouseId, name: dto.name, parentId: dto.parentId ?? null } as any,
		});
		if (existing) throw new BadRequestException(this.translations.t("domains.warehouses.location_name_already_exists"));

		let parent: StorageLocationEntity | null = null;
		if (dto.parentId) parent = await this.assertValidParent(me, warehouseId, dto.parentId, dto.type);

		if (dto.name !== undefined) {
			const adminId = tenantId(me);
			const existing = await this.locationsRepo.findOne({
				where: { adminId, warehouseId, name: dto.name, parentId: dto.parentId ?? null } as any,
			});
			if (existing) throw new BadRequestException(this.translations.t("domains.warehouses.location_name_already_exists"));
		}

		const row = this.locationsRepo.create({
			adminId,
			warehouseId,
			name: dto.name,
			type: dto.type,
			parentId: parent ? parent.id : null,
			description: dto.description ?? null,
		} as any);

		return this.locationsRepo.save(row);
	}

	async updateLocation(me: any, warehouseId: string, locationId: string, dto: UpdateStorageLocationDto) {
		await this.get(me, warehouseId);
		const row = await this.getLocationForWarehouse(me, warehouseId, locationId);

		if (dto.name !== undefined && dto.name !== (row as any).name) {
			const adminId = tenantId(me);
			const existing = await this.locationsRepo.findOne({
				where: { adminId, warehouseId, name: dto.name, parentId: (row as any).parentId ?? null } as any,
			});
			if (existing) throw new BadRequestException(this.translations.t("domains.warehouses.location_name_already_exists"));
		}

		// const nextType = dto.type ?? row.type;
		// const nextParentId = dto.parentId === undefined ? row.parentId ?? null : dto.parentId;

		// if (nextParentId) {
		// 	await this.assertValidParent(me, warehouseId, nextParentId, nextType);
		// }

		if (dto.name !== undefined) (row as any).name = dto.name;
		// if (dto.type !== undefined) (row as any).type = dto.type;
		// if (dto.parentId !== undefined) (row as any).parentId = dto.parentId;
		if (dto.description !== undefined) (row as any).description = dto.description;

		return this.locationsRepo.save(row as any);
	}

	async removeLocation(me: any, warehouseId: string, locationId: string) {

		const location = await this.getLocationForWarehouse(me, warehouseId, locationId);
		if (!location) throw new BadRequestException(this.translations.t("domains.warehouses.location_has_children"));

		await this.locationsRepo.delete({ id: locationId } as any);
		return { message: this.translations.t("domains.warehouses.location_deleted") };
	}

	async toggleLocationStatus(me: any, warehouseId: string, locationId: string) {
		const row = await this.getLocationForWarehouse(me, warehouseId, locationId);
		(row as any).isActive = !(row as any).isActive;
		await this.locationsRepo.save(row as any);
		return row;
	}

	async stats(me: any) {
		const adminId = tenantId(me);

		const result = await this.warehousesRepo
			.createQueryBuilder("w")
			.select("COUNT(*)", "total")
			.addSelect(
				`SUM(CASE WHEN w."isActive" = true THEN 1 ELSE 0 END)`,
				"active"
			)
			.where(`w."adminId" = :adminId`, { adminId })
			.getRawOne();

		return {
			total: Number(result.total),
			active: Number(result.active),
		};
	}

	async locationStats(me: any, warehouseId?: string) {
		const adminId = tenantId(me);

		const qb = this.locationsRepo
			.createQueryBuilder("l")
			.select(
				`SUM(CASE WHEN l.type = :zone THEN 1 ELSE 0 END)`,
				"zones"
			)
			.addSelect(
				`SUM(CASE WHEN l.type = :rack THEN 1 ELSE 0 END)`,
				"racks"
			)
			.addSelect(
				`SUM(CASE WHEN l.type = :shelf THEN 1 ELSE 0 END)`,
				"shelves"
			)
			.addSelect(
				`SUM(CASE WHEN l.type = :bin THEN 1 ELSE 0 END)`,
				"bins"
			)
			.where(`l."adminId" = :adminId`, { adminId })
			.setParameters({
				zone: StorageLocationType.ZONE,
				rack: StorageLocationType.RACK,
				shelf: StorageLocationType.SHELF,
				bin: StorageLocationType.BIN,
			});

		if (warehouseId) {
			qb.andWhere(`l."warehouseId" = :warehouseId`, { warehouseId });
		}

		const result = await qb.getRawOne();

		return {
			zones: Number(result.zones),
			racks: Number(result.racks),
			shelves: Number(result.shelves),
			bins: Number(result.bins),
		};
	}
}
