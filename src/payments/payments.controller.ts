import { Controller, Post, Body, Headers, HttpCode, HttpStatus, Get, Param, Query, Res, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentProviderEnum, PaymentSessionStatusEnum } from 'entities/payments.entity';
import { Response } from 'express';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) { }

  @Post('webhook/:provider')
  @HttpCode(HttpStatus.OK) // Always return 200 OK to notify kashir that we receive event
  async handleKashierWebhook(
    @Param('provider') providerName: PaymentProviderEnum,
    @Headers() headers: any,
    @Body() body: any
  ) {
    try {
      this.paymentsService.processWebhook(providerName, headers, body)
    } catch (err) {
      console.error('Unexpected webhook error:', err);
    }

    // Always respond 200 immediately
    return { received: true };
  }


  @Get('redirect/:provider')
  async handlePaymentRedirect(
    @Param('provider') providerName: PaymentProviderEnum,
    @Query() query: any,
    @Res() res: Response
  ) {
    try {
      const { status, sessionId } = await this.paymentsService.processRedirect(providerName, query);
      const frontendUrl = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';

      // Route the user based on the payment status
      if (status === PaymentSessionStatusEnum.SUCCESS) {
        return res.redirect(`${frontendUrl}/ar/payment/success?session_id=${sessionId}`);
      } else {
        return res.redirect(`${frontendUrl}/ar/payment/fail?session_id=${sessionId}`);
      }

    } catch (err) {
      console.error('Redirect processing error:', err);
      const frontendUrl = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
      // Default to failure page if something goes wrong during redirect parsing
      return res.redirect(`${frontendUrl}/ar/payment/fail`);
    }
  }

  @Get('sessions/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions("payments.read")
  async getPaymentSession(
    @Param('id') sessionId: string,
    @Req() req: any,
  ) {

    return this.paymentsService.getPaymentSessionById(req.user, sessionId);;
  }
}