import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ShippingService } from './shipping.service';

@Controller('shipping/webhooks')
export class ShippingWebhookController {
	constructor(private shipping: ShippingService) { }

	@Post(':provider')
	@HttpCode(200)
	async webhook(
		@Param('provider') provider: string,
		@Headers() headers: Record<string, any>,
		@Body() body: any,
	) {
		// shipping service will validate per-admin secret based on the shipment found
		await this.shipping.handleWebhook(provider, body, headers);
		return { ok: true };
	}
}