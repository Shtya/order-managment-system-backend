import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { WarehouseEntity } from "entities/warehouses.entity";
import { User } from "entities/user.entity";
import { CreateWarehouseDto, UpdateWarehouseDto } from "dto/warehouse.dto";
import { CRUD } from "../../common/crud.service";
import { tenantId } from "../category/category.service";

@Injectable()
export class WarehousesService {
	constructor(
		@InjectRepository(WarehouseEntity) private whRepo: Repository<WarehouseEntity>,
		@InjectRepository(User) private usersRepo: Repository<User>,
	) { }



	async list(me: any, q?: any) {
 		return CRUD.findAll(
			this.whRepo,
			"warehouses",
			q?.search,
			q?.page ?? 1,
			q?.limit ?? 10,
			q?.sortBy ?? "created_at",
			(q?.sortOrder ?? "DESC") as any,
			["manager"],
			["name", "location", "phone", "manager.name"],
			{
				__tenant: {
					role: me?.role?.name,
					userId: me?.id,
					adminId: me?.adminId,
				},
			} as any
		);
	}

	async get(me: any, id: number) {
		const adminId = tenantId(me);
		const entity = await CRUD.findOne(this.whRepo, "warehouses", id, ["manager"]);
		if ((entity as any).adminId !== adminId) throw new ForbiddenException("Not allowed");
		return entity;
	}

	private async validateManager(me: any, managerUserId?: number | null) {
		if (managerUserId == null) return null;

		const adminId = tenantId(me);
		const user = await this.usersRepo.findOne({ where: { id: managerUserId } as any });
		if (!user) throw new BadRequestException("Manager user not found");
		if ((user as any).adminId !== adminId) throw new ForbiddenException("Manager user not in your tenant");
		return user;
	}

	async create(me: any, dto: CreateWarehouseDto) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const manager = await this.validateManager(me, dto.managerUserId);

		const wh = this.whRepo.create({
			adminId,
			name: dto.name,
			location: dto.location,
			phone: dto.phone,
			isActive: dto.isActive ?? true,
			manager: manager ?? null,
		});

		return this.whRepo.save(wh);
	}

	async update(me: any, id: number, dto: UpdateWarehouseDto) {
		const wh = await this.get(me, id);
		const manager = await this.validateManager(me, dto.managerUserId);

		if (dto.managerUserId !== undefined) {
			(wh as any).manager = manager ?? null; // allow null
		}

		if (dto.name !== undefined) (wh as any).name = dto.name;
		if (dto.location !== undefined) (wh as any).location = dto.location;
		if (dto.phone !== undefined) (wh as any).phone = dto.phone;
		if (dto.isActive !== undefined) (wh as any).isActive = dto.isActive;

		return this.whRepo.save(wh as any);
	}

	async remove(me: any, id: number) {
		await this.get(me, id);
		return CRUD.delete(this.whRepo, "warehouses", id);
	}
}
