import { FileInterceptor } from "@nestjs/platform-express";
import { UploadedFile, UseInterceptors } from "@nestjs/common";
import { Response } from "express";
import { Res } from "@nestjs/common";
import { EmailAssetsService } from "./email-assets.service";
import { EmailSendingStatusService } from "./email-sending-status.service";
import { TranslationService } from "common/translation.service";
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import {
  EmailConsentDto,
  EmailContentDto,
  EmailTestDto,
  EmailAssetLeaseDto,
} from "dto/email.dto";
import { EmailAccountsService } from "./email-accounts.service";
import { EmailContentService } from "./email-content.service";
import { escapeEmailHtml } from "./email-content.service";
import { I18nContext } from "nestjs-i18n";
import { EmailPolicyService } from "./email-policy.service";
import { EmailService } from "./email.service";

@Controller("email")
export class EmailController {
  constructor(
    private readonly assets: EmailAssetsService,
    private readonly sendingStatus: EmailSendingStatusService,
    private readonly accounts: EmailAccountsService,
    private readonly content: EmailContentService,
    private readonly policy: EmailPolicyService,
    private readonly email: EmailService,
    private readonly translations: TranslationService,
  ) {}
  @Post("assets")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  upload(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    return this.assets.upload(
      this.accounts.context(req.user).adminId,
      file?.buffer,
    );
  }
  @Post("assets/retain")
  @UseGuards(JwtAuthGuard)
  renew(@Req() req: any, @Body() dto: EmailAssetLeaseDto) {
    return this.assets.retain(this.accounts.context(req.user).adminId, dto.ids);
  }
  @Get("accounts/:id/sending-status")
  @UseGuards(JwtAuthGuard)
  async status(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    try {
      return await this.sendingStatus.get(this.accounts.context(req.user), id);
    } catch (error) {
      if (error.getStatus?.() === 429)
        res.setHeader("Retry-After", String(error.getResponse().retryAfter));
      throw error;
    }
  }
  @Get("accounts")
  @UseGuards(JwtAuthGuard)
  list(@Req() req: any) {
    return this.accounts.listSafe(this.accounts.context(req.user));
  }
  @Get("accounts/:id")
  @UseGuards(JwtAuthGuard)
  account(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounts.getSafe(this.accounts.context(req.user), id);
  }
  @Delete("accounts/:id")
  @UseGuards(JwtAuthGuard)
  disconnect(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.email.disconnect(this.accounts.context(req.user), id);
  }
  @Post("content/validate")
  @UseGuards(JwtAuthGuard)
  validate(@Body() dto: EmailContentDto) {
    this.content.validate(dto);
    return { valid: true };
  }
  @Post("content/preview")
  @UseGuards(JwtAuthGuard)
  preview(@Req() req: any, @Body() dto: EmailContentDto) {
    return this.content.render(
      dto,
      dto.variables,
      "https://example.com/unsubscribe-preview",
      this.accounts.context(req.user).adminId,
    );
  }
  @Post("test-send")
  @UseGuards(JwtAuthGuard)
  test(@Req() req: any, @Body() dto: EmailTestDto) {
    return this.email.sendImmediate(this.accounts.context(req.user), {
      accountId: dto.accountId,
      to: dto.to,
      purpose: "test",
      idempotencyKey: `test:${randomUUID()}`,
      source: { type: "test" },
      content: {
        subject: dto.subject,
        preheader: dto.preheader,
        document: dto.document,
        businessIdentity: dto.businessIdentity,
      },
      variables: dto.variables,
    });
  }
  @Post("consents")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions("campaigns.create", "campaigns.update")
  consent(@Req() req: any, @Body() dto: EmailConsentDto) {
    return this.policy.recordConsent(
      this.accounts.context(req.user),
      dto.email,
      dto.evidence,
    );
  }
  @Get("messages/:id")
  @UseGuards(JwtAuthGuard)
  message(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.email.get(this.accounts.context(req.user), id);
  }
  @Get("unsubscribe/:token")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  unsubscribePage() {
    const arabic = I18nContext.current()?.lang?.startsWith("ar") ?? false;
    const title = escapeEmailHtml(
      this.translations.t("domains.email.preferences_title"),
    );
    const heading = escapeEmailHtml(
      this.translations.t("domains.email.unsubscribe_heading"),
    );
    const confirm = escapeEmailHtml(
      this.translations.t("domains.email.unsubscribe_confirm"),
    );
    return `<!doctype html><html lang="${arabic ? "ar" : "en"}" dir="${arabic ? "rtl" : "ltr"}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title><h1>${heading}</h1><form method="post"><button type="submit">${confirm}</button></form></html>`;
  }
  @Post("unsubscribe/:token")
  unsubscribe(@Param("token") token: string) {
    return this.policy.unsubscribe(token);
  }
}
