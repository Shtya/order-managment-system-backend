import { BadRequestException, Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { Permissions } from 'common/permissions.decorator';
import { WhatsappSendMessagePayload } from './services/WhatsappApi.service';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {

  }

  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Get('messages')
  @Permissions('whatsapp.read')
  findAllMessages(@Req() req: any, @Query() q: any) {
    return this.whatsappService.findAllMessages(req.user, q);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Get('messages/:id')
  @Permissions('whatsapp.read')
  findOneMessage(@Req() req: any, @Param('id') id: string) {
    return this.whatsappService.findOneMessage(req.user, id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Post('messages/send')
  @Permissions('whatsapp.send')
  sendMessage(@Req() req: any, @Body() payload: WhatsappSendMessagePayload, @Query('accountId') accountId?: string) {
    return this.whatsappService.sendMessage(req.user, payload, accountId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Post('messages/:messageId/retry')
  @Permissions('whatsapp.send')
  retryMessage(@Req() req: any, @Param('messageId') messageId: string) {
    return this.whatsappService.retryMessage(req.user, messageId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Post('messages/mark-as-read')
  @Permissions('whatsapp.send')
  markMessageAsRead(@Req() req: any, @Body() payload: { messageId?: string, conversationId?: string }) {
    return this.whatsappService.markAsRead(req.user, payload);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Post('messages/upload-media')
  @Permissions('whatsapp.send')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMediaFile(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Query('accountId') accountId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }


    return this.whatsappService.uploadMedia(req.user, {
      file,
      mimeType: file.mimetype,
      filename: file.originalname,
    }, accountId);
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
    console.log("code", code)
    console.log("state", state)

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
  handleEvents(@Body() body: any, @Headers() headers: Record<string, string>, @Req() req: Request) {
    return this.whatsappService.handleEvents(body, (req as any).rawBody as any, headers);
  }
}
