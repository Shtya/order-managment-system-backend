import { SetMetadata } from "@nestjs/common";
import { McpScope } from "entities/oauth.entity";

export const MCP_SCOPE_KEY = "mcpScope";

export const RequireMcpScope = (scope: McpScope) =>
  SetMetadata(MCP_SCOPE_KEY, scope);
