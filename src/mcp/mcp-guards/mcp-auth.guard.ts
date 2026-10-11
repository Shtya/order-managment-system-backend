import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { MCP_SCOPES } from "entities/oauth.entity";
import { OAuthService } from "../oauth.service";

/**
 * Runs before every MCP request (initialize, tools/list, tools/call...).
 *
 * - No token      -> 401 + WWW-Authenticate pointing at the resource metadata.
 *                    This is what makes ChatGPT/Claude start the OAuth flow.
 * - Expired/bad   -> 401 + error="invalid_token". Clients answer this by using
 *                    their refresh token (most also refresh proactively using
 *                    `expires_in`) and retrying. Only if the refresh itself fails
 *                    do they ask the user to reconnect.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  // Applied with @UseGuards on McpHttpController (see mcp-http.controller.ts),
  // so it resolves in MadarMcpModule like any normal guard.
  constructor(private oauth: OAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();

    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) this.unauthorized(res, undefined, MCP_SCOPES.join(" "));

    try {
      const { user, scopes, grantId } = await this.oauth.authenticate(token!);
      req.user = user; // same shape as your web guard: tools reuse your services
      req.mcpScopes = scopes;
      req.mcpGrantId = grantId;
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      this.unauthorized(res, "invalid_token");
    }
  }

  private unauthorized(res: any, error?: string, scope?: string): never {
    const metadata = `${process.env.BACKEND_URL}/.well-known/oauth-protected-resource`;
    const parts = [`Bearer resource_metadata="${metadata}"`];
    if (error) parts.push(`error="${error}"`);
    if (scope) parts.push(`scope="${scope}"`);
    res.setHeader("WWW-Authenticate", parts.join(", "));
    throw new UnauthorizedException();
  }
}
