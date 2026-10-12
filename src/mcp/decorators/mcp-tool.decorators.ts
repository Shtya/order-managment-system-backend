import { applyDecorators, UseFilters } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { McpScope } from "entities/oauth.entity";
import { McpToolExceptionFilter } from "../filters/mcp-tool-exception.filter";
import { registerToolName } from "../utils/mcp-tool-names";
import { RequireMcpScope } from "./require-mcp-scope.decorator";

type ToolOptions = Parameters<typeof Tool>[0];

const ANNOTATIONS = {
  read:   { readOnlyHint: true,  openWorldHint: false },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  save:   { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update: { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  delete: { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
} as const;

// Scope and annotations are bound together, so they can never disagree.
const make = (kind: keyof typeof ANNOTATIONS, scope: McpScope) =>
  (opts: Omit<ToolOptions, "annotations">) => {
    if (opts.name) registerToolName(opts.name);
    return applyDecorators(
      RequireMcpScope(scope),
      UseFilters(McpToolExceptionFilter),
      Tool({ ...opts, annotations: { ...ANNOTATIONS[kind] } }),
    );
  };

export const McpReadTool   = make("read",   McpScope.READ);
export const McpCreateTool = make("create", McpScope.WRITE);
export const McpSaveTool   = make("save",   McpScope.WRITE);
export const McpUpdateTool = make("update", McpScope.WRITE);
export const McpDeleteTool = make("delete", McpScope.WRITE);