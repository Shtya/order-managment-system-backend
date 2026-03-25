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
			"order.read", "order.create", "order.update", "order.delete", "order.updateSettings", "order.readSettings", "order.assign",
			"warehouses.read", "warehouses.create", "warehouses.update", "warehouses.delete", "warehouses.scan-shipping", "warehouses.scan-preparation",
			"categories.read", "categories.create", "categories.update", "categories.delete",
			"orders.read", "orders.create", "orders.update", "orders.delete", "orders.replace", "orders.readReplace", "return-request.create",
			"suppliers.read", "suppliers.create", "suppliers.update", "suppliers.delete",
			"orders-collect.read", "orders-collect.create",
			"products.read", "products.create", "products.update", "products.delete",

			"shipping-companies.create", "shipping-companies.read", "shipping-companies.update", "shipping-companies.delete",

			"notifications.read", "notifications.update",
			"subscriptions.read", "subscriptions.create", "subscriptions.update",
			"admin-settings.read", "admin-settings.update",
			"wallet.read", "wallet.update",
			"payments.read",
			"extra-features.read", "extra-features.create", "extra-features.update",
			"dashboard.read",
			"assets.read", "assets.create", "assets.update", "assets.delete",
			"purchase_returns.read", "purchase_returns.create", "purchase_returns.update", "purchase_returns.delete",
			"purchases.read", "purchases.create", "purchases.update", "purchases.delete",
			"sales_invoice.read", "sales_invoice.create", "sales_invoice.update", "sales_invoice.delete",


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
