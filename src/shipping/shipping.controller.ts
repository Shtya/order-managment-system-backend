// --- File: backend/src/shipping/shipping.controller.ts ---
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ShippingService } from './shipping.service';
import { AssignOrderDto, CreateShipmentDto, SetActiveDto, SetProviderCredentialsDto } from './shipping.dto';
import { tenantId } from 'src/category/category.service';

@Controller('shipping')
export class ShippingController {
	constructor(private shipping: ShippingService) { }

	@UseGuards(JwtAuthGuard)
	@Get('providers')
	providers() {
		return this.shipping.listProviders();
	}

	@UseGuards(JwtAuthGuard)
	@Get('statuses')
	statuses() {
		return this.shipping.getUnifiedStatuses();
	}

	@UseGuards(JwtAuthGuard)
	@Post('providers/:provider/credentials')
	setCredentials(@Req() req: any, @Param('provider') provider: string, @Body() dto: SetProviderCredentialsDto) {
		return this.shipping.setCredentials(req.user.id, provider, dto.credentials);
	}

	@UseGuards(JwtAuthGuard)
	@Post('providers/:provider/active')
	setActive(@Req() req: any, @Param('provider') provider: string, @Body() dto: SetActiveDto) {
		return this.shipping.setActive(req.user.id, provider, dto.isActive);
	}

	@UseGuards(JwtAuthGuard)
	@Get('providers/:provider/services')
	services(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.getServices(req.user.id, provider);
	}

	@UseGuards(JwtAuthGuard)
	@Get('providers/:provider/capabilities')
	capabilities(@Req() req: any, @Param('provider') provider: string) {
		return this.shipping.getCapabilities(req.user.id, provider);
	}

	// @UseGuards(JwtAuthGuard)
	// @Get('providers/:provider/areas')
	// areas(@Req() req: any, @Param('provider') provider: string, @Query('countryId') countryId?: string) {
	// 	const cid = countryId ? Number(countryId) : 1;
	// 	return this.shipping.getAreas(req.user.id, provider, cid);
	// }

	@UseGuards(JwtAuthGuard)
	@Post('providers/:provider/shipments/create/:orderId')
	createShipment(@Req() req: any, @Param('provider') provider: string, @Param('orderId') orderId: string, @Body() dto: CreateShipmentDto) {
		const order = orderId ? Number(orderId) : null;
		return this.shipping.createShipment(req.user, provider, dto, order);
	}

	@UseGuards(JwtAuthGuard)
	@Post('providers/:provider/orders/:orderId/assign')
	assign(@Req() req: any, @Param('provider') provider: string, @Param('orderId') orderId: string, @Body() dto: AssignOrderDto) {
		return this.shipping.assignOrder(req.user.id, provider, Number(orderId), dto);
	}

	@UseGuards(JwtAuthGuard)
	@Get('shipments')
	list(@Req() req: any) {
		return this.shipping.listShipments(req.user.id);
	}

	@UseGuards(JwtAuthGuard)
	@Get('shipments/:id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.shipping.getShipment(req.user.id, Number(id));
	}

	@UseGuards(JwtAuthGuard)
	@Get('shipments/:id/events')
	events(@Req() req: any, @Param('id') id: string) {
		return this.shipping.getShipmentEvents(req.user.id, Number(id));
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
