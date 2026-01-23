import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { LookupsService } from './lookups.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('lookups')
export class LookupsController {
	constructor(private readonly lookups: LookupsService) { }

	@Permissions('users.read')
	@Get('users')
	users(
		@Req() req: any,
		@Query('q') q?: string,
		@Query('roleId') roleId?: string,
		@Query('isActive') isActive?: string,
		@Query('limit') limit?: string,
	) {
		return this.lookups.users(req.user, {
			q,
			roleId: roleId ? Number(roleId) : undefined,
			isActive: typeof isActive === 'string' ? isActive === 'true' : undefined,
			limit: limit ? Math.min(Number(limit) || 20, 100) : 20,
		});
	}

	@Permissions('roles.read')
	@Get('roles')
	rolesLookup(@Req() req: any, @Query() params: any) {
		console.log(req);
		return this.lookups.roles(req.user, params);
	}

	@Permissions('permissions.read')
	@Get('permissions')
	permissions(@Query('q') q?: string, @Query('limit') limit?: string) {
		return this.lookups.permissions({
			q,
			limit: limit ? Math.min(Number(limit) || 50, 500) : 50,
		});
	}


	@Permissions('categories.read')
	@Get('categories')
	categories(@Req() req: any, @Query('q') q?: string, @Query('limit') limit?: string) {
		return this.lookups.categories(req.user, {
			q,
			limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
		});
	}

	@Permissions('stores.read')
	@Get('stores')
	stores(
		@Req() req: any,
		@Query('q') q?: string,
		@Query('isActive') isActive?: string,
		@Query('limit') limit?: string,
	) {
		return this.lookups.stores(req.user, {
			q,
			isActive: typeof isActive === 'string' ? isActive === 'true' : undefined,
			limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
		});
	}

	@Permissions('warehouses.read')
	@Get('warehouses')
	warehouses(
		@Req() req: any,
		@Query('q') q?: string,
		@Query('isActive') isActive?: string,
		@Query('limit') limit?: string,
	) {
		return this.lookups.warehouses(req.user, {
			q,
			isActive: typeof isActive === 'string' ? isActive === 'true' : undefined,
			limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
		});
	}


	@Permissions('products.read')
	@Get('products')
	products(
		@Req() req: any,
		@Query('q') q?: string,
		@Query('limit') limit?: string,
	) {
		return this.lookups.products(req.user, {
			q,
			limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
		});
	}

	@Permissions('products.read')
	@Get('skus')
	skus(
		@Req() req: any,
		@Query('q') q?: string,
		@Query('productId') productId?: string,
		@Query('limit') limit?: string,
	) {
		return this.lookups.skus(req.user, {
			q,
			productId: productId ? Number(productId) : undefined,
			limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
		});
	}

	@Permissions('suppliers.read')
	@Get('suppliers')
	suppliers(
		@Req() req: any,
		@Query('q') q?: string,
		@Query('limit') limit?: string,
	) {
		return this.lookups.suppliers(req.user, {
			q,
			limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
		});
	}

}
