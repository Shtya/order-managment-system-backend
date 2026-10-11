import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { SkipThrottle } from "@nestjs/throttler";
import { Response } from "express";
import { OAuthService, oauthError } from "./oauth.service";

/**
 * NOTE
 * - If you use app.setGlobalPrefix("api"), exclude `.well-known/*`, `oauth/*`
 *   and `mcp` from it: clients look for /.well-known/... at the host root.
 * - If you have a global JWT guard (APP_GUARD), mark the discovery, register,
 *   authorize and token routes as public. The consent routes below
 *   deliberately use your normal web-session JWT.
 * - ChatGPT calls /oauth/token from shared OpenAI IPs, so do not put a tight
 *   per-IP throttle on it (hence SkipThrottle).
 */
@SkipThrottle({ default: true })
@Controller()
export class OAuthController {
  constructor(private oauth: OAuthService) {}

  // ───────── Discovery (public) ─────────

  @Get([
    ".well-known/oauth-protected-resource",
    ".well-known/oauth-protected-resource/mcp",
  ])
  protectedResource() {
    return this.oauth.protectedResourceMetadata();
  }

  @Get(".well-known/oauth-authorization-server")
  authorizationServer() {
    return this.oauth.authorizationServerMetadata();
  }

  // ───────── Dynamic Client Registration (public) ─────────

  @Post("oauth/register")
  @HttpCode(201)
  register(@Body() body: any) {
    return this.oauth.registerClient(body);
  }

  // ───────── Authorization endpoint: the browser lands here ─────────

  @Get("oauth/authorize")
  async authorize(@Query() q: Record<string, string>, @Res() res: Response) {
    const requestId = await this.oauth.startAuthorization(q);
    // Hand over to the React app: it logs the user in (email/password or
    // Google, your existing flow) and then shows the consent screen.
    res.redirect(`${process.env.FRONTEND_URL}/mcp/connect?request=${requestId}`);
  }

  // ───────── Consent API, called by the React page with the user's WEB JWT ─────────

  @UseGuards(AuthGuard("jwt"))
  @Get("oauth/requests/:id")
  getRequest(@Param("id") id: string) {
    return this.oauth.getPending(id);
  }

  @UseGuards(AuthGuard("jwt"))
  @Post("oauth/requests/:id/approve")
  @HttpCode(200)
  approve(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { scopes?: string[] },
  ) {
    return this.oauth.approve(id, req.user.id, body?.scopes);
  }

  @UseGuards(AuthGuard("jwt"))
  @Post("oauth/requests/:id/deny")
  @HttpCode(200)
  deny(@Param("id") id: string) {
    return this.oauth.deny(id);
  }

  // ───────── Token endpoint (public, form-encoded body) ─────────

  @Post("oauth/token")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  token(@Body() body: Record<string, string>) {
    switch (body.grant_type) {
      case "authorization_code":
        return this.oauth.exchangeCode(body);
      case "refresh_token":
        return this.oauth.refresh(body); // ChatGPT/Claude call this by themselves
      default:
        throw oauthError("unsupported_grant_type");
    }
  }

  // ───────── "Connected apps" in Madar settings (web JWT) ─────────

  @UseGuards(AuthGuard("jwt"))
  @Get("oauth/grants")
  listGrants(@Req() req: any) {
    return this.oauth.listGrants(req.user.id);
  }

  @UseGuards(AuthGuard("jwt"))
  @Delete("oauth/grants/:id")
  @HttpCode(204)
  revoke(@Param("id") id: string, @Req() req: any) {
    return this.oauth.revokeGrant(req.user.id, id);
  }
}
