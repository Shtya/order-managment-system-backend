import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RpcException } from "@nestjs/microservices";
import { McpContext } from "@rekog/mcp-nest";
import { McpScope } from "entities/oauth.entity";
import { MCP_SCOPE_KEY } from "../decorators/require-mcp-scope.decorator";

type McpAuthenticatedRequest = {
  mcpScopes?: McpScope[];
  res?: { setHeader?: (name: string, value: string) => void };
};

@Injectable()
export class McpScopeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScope = this.getRequiredScope(context);
    if (!requiredScope) return true;

    const mcpContext = context.switchToRpc().getContext<McpContext>();
    const req = mcpContext.getRawRequest<McpAuthenticatedRequest>();

    if (req?.mcpScopes?.includes(requiredScope)) {
      return true;
    }

    const metadata = `${process.env.BACKEND_URL}/.well-known/oauth-protected-resource`;

    req?.res?.setHeader?.(
      "WWW-Authenticate",
      `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="${requiredScope}"`,
    );

    throw new RpcException(`Missing scope: ${requiredScope}`);
  }

  private getRequiredScope(context: ExecutionContext): McpScope | undefined {
    return this.reflector.getAllAndOverride<McpScope>(MCP_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }
}
