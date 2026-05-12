import { Body, Controller, Get, HttpException, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { Response } from 'express';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {

  }

  @Get('embedded-signup')
  redirectToEmbeddedSignup(@Res() res: Response) {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID!,
      redirect_uri: process.env.META_REDIRECT_URI!,
      scope:
        'business_management,whatsapp_business_management,whatsapp_business_messaging',
      response_type: 'code',
      state: crypto.randomUUID(),
      config_id: process.env.META_CONFIG_ID!,
      extras: JSON.stringify({
        feature: 'whatsapp_embedded_signup',
        sessionInfoVersion: '3',
      }),
    });

    const url = `https://www.facebook.com/v22.0/dialog/oauth?${params.toString()}`;

    return res.redirect(url);
  }

  /**
   * Meta OAuth callback
   *
   * GET /whatsapp/callback?code=xxx
   */
  @Get('callback')
  async embeddedSignupCallback(
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    if (!code) {
      throw new HttpException(
        'Missing authorization code',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.whatsappService.exchangeCodeForToken(code, state);
  }

  @Get('webhook')
  verifyWebhook(@Query() query: any) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      return challenge;
    }

    return 'Forbidden';
  }

  @Post('webhook')
  handleEvents(@Body() body: any) {
    console.log('Incoming WhatsApp event:', body);
    return 'OK';
  }
}
