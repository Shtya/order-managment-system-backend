import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { EmailConnectDto } from "dto/email.dto";
import { EmailAccountsService } from "../email-accounts.service";
import { GmailService } from "./gmail.service";

@Controller("email/accounts")
export class GmailController {
  constructor(
    private readonly gmail: GmailService,
    private readonly accounts: EmailAccountsService,
  ) {}
  @Post("gmail/connect")
  @UseGuards(JwtAuthGuard)
  connect(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: EmailConnectDto,
  ) {
    return this.begin(req, res, dto.returnTo, undefined, dto.browserRedirect);
  }
  @Post(":id/reconnect")
  @UseGuards(JwtAuthGuard)
  reconnect(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: EmailConnectDto,
  ) {
    return this.begin(req, res, dto.returnTo, id, dto.browserRedirect);
  }
  private async begin(
    req: any,
    res: Response,
    returnTo?: string,
    id?: string,
    browserRedirect = false,
  ) {
    const result = await this.gmail.connect(
      this.accounts.context(req.user),
      returnTo,
      id,
      browserRedirect,
    );
    if (!browserRedirect)
      this.setBindingCookie(res, result.state, result.binding);
    res.setHeader("Cache-Control", "no-store");
    return {
      authorizationUrl: result.authorizationUrl,
      browserAuthorizationUrl: result.browserAuthorizationUrl,
      callbackUrl: result.callbackUrl,
      expiresInSeconds: result.expiresInSeconds,
    };
  }
  private setBindingCookie(res: Response, state: string, binding: string) {
    res.cookie(`gmail_oauth_${state.slice(0, 16)}`, binding, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: 600_000,
      path: "/",
    });
  }
  @Get("gmail/authorize")
  async authorize(
    @Res() res: Response,
    @Query("state") state: string,
    @Query("ticket") ticket: string,
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const result = await this.gmail.beginBrowserAuthorization(state, ticket);
    this.setBindingCookie(res, state, result.binding);
    return res.redirect(result.authorizationUrl);
  }
  @Get("gmail/callback")
  async callback(
    @Req() req: any,
    @Res() res: Response,
    @Query("state") state: string,
    @Query("code") code?: string,
    @Query("error") error?: string,
  ) {
    const cookieName = `gmail_oauth_${String(state || "").slice(0, 16)}`;
    const cookies = Object.fromEntries(
      String(req.headers.cookie || "")
        .split(";")
        .map((p) => p.trim().split("=")),
    );
    res.clearCookie(cookieName, { path: "/" });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.redirect(
      await this.gmail.callback(state, cookies[cookieName], code, error),
    );
  }
}
