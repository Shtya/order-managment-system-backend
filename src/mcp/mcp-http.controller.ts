import { Controller, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { McpHttpControllerFor } from "@rekog/mcp-nest";
import { mcpTransport } from "./mcp.strategy";
import { McpAuthGuard } from "./mcp-guards/mcp-auth.guard";

/**
 * v2 has no `guards` option on the strategy. Instead the MCP route is a real
 * Nest controller, so the guard runs at the HTTP layer on every request
 * (initialize, tools/list, tools/call...). McpAuthGuard sets `req.user`.
 *
 * SkipThrottle: ChatGPT/Claude call from shared server IPs, so a per-IP limit
 * would throttle many different users together.
 */
@SkipThrottle({ default: true })
@Controller("mcp")
@UseGuards(McpAuthGuard)
export class McpHttpController extends McpHttpControllerFor(mcpTransport) {}