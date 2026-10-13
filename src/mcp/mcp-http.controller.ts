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
 * SkipThrottle `default`: ChatGPT/Claude share outbound IPs, so the web
 * 300/min IP-or-user bucket must not apply here. Authenticated MCP traffic
 * uses the separate named `mcp` throttler (300/min per user `sub`).
 * Unauthenticated probes (no `sub`) skip that throttler and get 401.
 */
@SkipThrottle({ default: true })
@Controller("mcp")
@UseGuards(McpAuthGuard)
export class McpHttpController extends McpHttpControllerFor(mcpTransport) {}