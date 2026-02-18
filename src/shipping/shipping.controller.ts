import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ShippingService } from './shipping.service';
import { AssignOrderDto, CreateShipmentDto, SetActiveDto, SetProviderCredentialsDto } from './shipping.dto';

@Controller('shipping')
export class ShippingController {
  constructor(private shipping: ShippingService) {}

	
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

  /**
   * ✅ Admin sets his own credentials for provider
   */
  @UseGuards(JwtAuthGuard)
  @Post('providers/:provider/credentials')
  setCredentials(@Req() req: any, @Param('provider') provider: string, @Body() dto: SetProviderCredentialsDto) {
    return this.shipping.setCredentials(req.user.sub, provider, dto.credentials);
  }

  @UseGuards(JwtAuthGuard)
  @Post('providers/:provider/active')
  setActive(@Req() req: any, @Param('provider') provider: string, @Body() dto: SetActiveDto) {
    return this.shipping.setActive(req.user.sub, provider, dto.isActive);
  }

  /**
   * ✅ array of text for what provider offers
   */
  @UseGuards(JwtAuthGuard)
  @Get('providers/:provider/services')
  services(@Req() req: any, @Param('provider') provider: string) {
    return this.shipping.getServices(req.user.sub, provider);
  }

  /**
   * ✅ capabilities/support endpoint (dynamic)
   */
  @UseGuards(JwtAuthGuard)
  @Get('providers/:provider/capabilities')
  capabilities(@Req() req: any, @Param('provider') provider: string) {
    return this.shipping.getCapabilities(req.user.sub, provider);
  }

  // Areas by provider
  @UseGuards(JwtAuthGuard)
  @Get('providers/:provider/areas')
  areas(@Req() req: any, @Param('provider') provider: string, @Query('countryId') countryId?: string) {
    const cid = countryId ? Number(countryId) : 1;
    return this.shipping.getAreas(req.user.sub, provider, cid);
  }

  // Create shipment
  @UseGuards(JwtAuthGuard)
  @Post('providers/:provider/shipments/create')
  createShipment(@Req() req: any, @Param('provider') provider: string, @Body() dto: CreateShipmentDto) {
    return this.shipping.createShipment(req.user.sub, provider, dto);
  }

  // Assign order
  @UseGuards(JwtAuthGuard)
  @Post('providers/:provider/orders/:orderId/assign')
  assign(@Req() req: any, @Param('provider') provider: string, @Param('orderId') orderId: string, @Body() dto: AssignOrderDto) {
    return this.shipping.assignOrder(req.user.sub, provider, Number(orderId), dto);
  }

  // Shipments view
  @UseGuards(JwtAuthGuard)
  @Get('shipments')
  list(@Req() req: any) {
    return this.shipping.listShipments(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('shipments/:id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.shipping.getShipment(req.user.sub, Number(id));
  }

  @UseGuards(JwtAuthGuard)
  @Get('shipments/:id/events')
  events(@Req() req: any, @Param('id') id: string) {
    return this.shipping.getShipmentEvents(req.user.sub, Number(id));
  }
 
	@UseGuards(JwtAuthGuard)
	@Get('integrations/status')
	integrationsStatus(@Req() req: any) {
		return this.shipping.getIntegrationsStatus(req.user.sub);
	}
  
}
