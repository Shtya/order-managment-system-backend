import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ShippingService } from './shipping.service';

@Controller('shipping/webhooks')
export class ShippingWebhookController {
  constructor(private shipping: ShippingService) {}

  @Post(':provider')
  @HttpCode(200)
  async webhook(
    @Param('provider') provider: string,
    @Headers('authorization') auth: string | undefined,
    @Body() body: any,
  ) {
    // simple shared auth check (you can enhance per provider)
    const expected = process.env.BOSTA_WEBHOOK_AUTH;
    if (expected && auth !== expected) return { ok: true, ignored: true };

    await this.shipping.handleWebhook(provider, body);
    return { ok: true };
  }
}
