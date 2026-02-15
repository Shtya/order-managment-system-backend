import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Permission } from 'entities/user.entity';
import { Repository } from 'typeorm';
import { CreatePermissionDto } from 'dto/permission.dto';

@Injectable()
export class PermissionsService implements OnModuleInit {
	constructor(@InjectRepository(Permission) private permsRepo: Repository<Permission>) { }

	async onModuleInit() {
		await this.seed();
	}


	private async seed() {
		const keys = [
			'users.read', 'users.create', 'users.update', 'users.deactivate', 'users.create_admin', 'users.view_credentials',
			'roles.read', 'roles.create', 'roles.update', 'roles.delete',
			'permissions.read', 'permissions.create', 'permissions.delete',

			// ✅ NEW: Plan permissions
			'plans.read', 'plans.create', 'plans.update', 'plans.delete',

			// ✅ NEW: Transaction permissions
			'transactions.read', 'transactions.create', 'transactions.update', 'transactions.cancel',

			"stores.read", "stores.create", "stores.update", "stores.delete",
			"warehouses.read", "warehouses.create", "warehouses.update", "warehouses.delete",
			"categories.read", "categories.create", "categories.update", "categories.delete",
			"products.read", "products.create", "products.update", "products.delete",

			"shipping-companies.create", "shipping-companies.read", "shipping-companies.update", "shipping-companies.delete"
		];

		for (const name of keys) {
			const exists = await this.permsRepo.findOne({ where: { name } });
			if (!exists) await this.permsRepo.save(this.permsRepo.create({ name }));
		}
	}



	list() {
		return this.permsRepo.find();
	}

	async create(dto: CreatePermissionDto) {
		const exists = await this.permsRepo.findOne({ where: { name: dto.name } });
		if (exists) throw new BadRequestException('Permission already exists');
		return this.permsRepo.save(this.permsRepo.create({ name: dto.name }));
	}

	async remove(id: number) {
		const p = await this.permsRepo.findOne({ where: { id } });
		if (!p) throw new NotFoundException('Permission not found');
		await this.permsRepo.delete(id);
		return { message: 'Permission deleted' };
	}
}
