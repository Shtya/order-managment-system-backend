// --- File: backend/src/shipping/shipping.controller.ts ---
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ShippingService } from './shipping.service';
import { AssignOrderDto, BulkAssignOrderDto, CreateShipmentDto, SetActiveDto, SetProviderCredentialsDto } from './shipping.dto';
import { tenantId } from 'src/category/category.service';
import { ProviderCode } from './providers/shipping-provider.interface';

import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { RequireSubscription } from 'common/require-subscription.decorator';
import { SubscriptionGuard } from 'common/subscription.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('shipping')
@RequireSubscription()
export class ShippingController {
	constructor(private shipping: ShippingService) { }

	@Permissions("shipping-companies.read")
	@Get('providers')
	providers() {
		return this.shipping.listProviders();
	}

	@Permissions("shipping-companies.read")
	@Get('statuses')
	statuses() {
		return this.shipping.getUnifiedStatuses();
	}

	@Permissions("shipping-companies.update")
	@Post('providers/:provider/credentials')
	setCredentials(@Req() req: any, @Param('provider') provider: string, @Body() dto: SetProviderCredentialsDto) {
		return this.shipping.setCredentials(req.user.id, provider, dto.credentials);
	}

	@Permissions("shipping-companies.update")
	@Post('providers/:provider/active')
	setActive(@Req() req: any, @Param('provider') provider: string, @Body() dto: SetActiveDto) {
		return this.shipping.setActive(req.user.id, provider, dto.isActive);
	}

	@Permissions("shipping-companies.read")
	@Get('providers/:provider/services')
	services(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.getServices(req.user.id, provider);
	}

	@Permissions("shipping-companies.read")
	@Get('providers/:provider/capabilities')
	capabilities(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.getCapabilities(req.user.id, provider);
	}

	@Permissions("shipping-companies.read")
	@Get('stats/companies-workload')
	async getCompanyWorkload(@Req() req: any) {
		return await this.shipping.getCompanyDistribution(req.user);
	}

	/**
	 * Endpoint 2: Lifecycle Totals
	 * Returns: { confirmed: 100, distributed: 50, distributedNotPrinted: 10 }
	*/
	@Permissions("shipping-companies.read")
	@Get('stats/lifecycle-summary')
	async getLifecycleSummary(@Req() req: any) {
		return await this.shipping.getShipmentLifecycleStats(req.user);
	}


	// @UseGuards(JwtAuthGuard)
	// @Get('providers/:provider/areas')
	// areas(@Req() req: any, @Param('provider') provider: string, @Query('countryId') countryId?: string) {
	// 	const cid = countryId ? Number(countryId) : 1;
	// 	return this.shipping.getAreas(req.user.id, provider, cid);
	// }


	@Permissions("shipping-companies.update")
	@Post('providers/:provider/orders/:orderId/assign')
	assign(@Req() req: any, @Param('orderId') orderId: string, @Body() dto: AssignOrderDto, @Param('provider') provider?: ProviderCode | 'none',) {
		return this.shipping.assignOrder(req.user, orderId, dto, provider);
	}

	@Permissions("shipping-companies.update")
	@Post('providers/:provider/orders/bulk-assign')
	bulkAssign(
		@Req() req: any,
		@Param('provider') provider: ProviderCode,
		@Body() dto: BulkAssignOrderDto
	) {
		return this.shipping.bulkAssignOrders(req.user, provider, dto);
	}

	@Permissions("shipping-companies.read")
	@Get('shipments')
	list(@Req() req: any) {
		return this.shipping.listShipments(req.user.id);
	}

	@Permissions("shipping-companies.read")
	@Get('shipments/:id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.shipping.getShipment(req.user.id, id);
	}

	@UseGuards(JwtAuthGuard)
	@Get('shipments/:id/events')
	events(@Req() req: any, @Param('id') id: string) {
		return this.shipping.getShipmentEvents(req.user.id, id);
	}

	@UseGuards(JwtAuthGuard)
	@Get('integrations/status')
	integrationsStatus(@Req() req: any) {
		return this.shipping.getIntegrationsStatus(req.user.id);
	}

	@UseGuards(JwtAuthGuard)
	@Get('integrations/active')
	activeIntegrations(@Req() req: any) {
		return this.shipping.activeIntegrations(req.user);
	}

	// NEW: Webhook setup
	@UseGuards(JwtAuthGuard)
	@Get('providers/:provider/webhook-setup')
	webhookSetup(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.getWebhookSetup(req.user.id, provider);
	}

	@UseGuards(JwtAuthGuard)
	@Post('providers/:provider/webhook-setup/rotate-secret')
	rotateWebhook(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.rotateWebhookSecret(req.user.id, provider);
	}

	// backend/src/shipping/shipping.controller.ts

	@Get('cities/:provider')
	async getCities(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.getCities(tenantId(req.user), provider);
	}

	@Get('districts/:provider/:cityId')
	async getDistricts(
		@Req() req: any,
		@Param('provider') provider: string,
		@Param('cityId') cityId: string
	) {
		return this.shipping.getDistricts(tenantId(req.user), provider, cityId);
	}

	@Get('zones/:provider/:cityId')
	async getZones(
		@Req() req: any,
		@Param('provider') provider: string,
		@Param('cityId') cityId: string
	) {
		return this.shipping.getZones(tenantId(req.user), provider, cityId);
	}

	@Get('pickup-locations/:provider')
	async getPickupLocations(
		@Req() req: any,
		@Param('provider') provider: string
	) {
		// tenantId هو helper لجلب الـ adminId من التوكن
		const adminId = tenantId(req.user);
		return this.shipping.getPickupLocations(adminId, provider);
	}
}
