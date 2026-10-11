import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { RpcException } from "@nestjs/microservices";
import { McpContext } from "@rekog/mcp-nest";

/**
 * Injects the authenticated Madar user that McpAuthGuard put on req.user.
 *   @McpUser() user          -> the whole user object
 *   @McpUser("id") userId    -> a single property
 */
export const McpUser = createParamDecorator(
  (field: string | undefined, ctx: ExecutionContext) => {
    const mcp = ctx.switchToRpc().getContext<McpContext>();
    const user = mcp.getRawRequest<{ user?: any }>()?.user;

    // McpAuthGuard already guarantees this; fail loudly if the guard is ever removed.
    if (!user) throw new RpcException("Unauthenticated MCP request");

    return field ? user[field] : user;
  },
);