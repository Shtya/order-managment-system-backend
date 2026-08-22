import { BadRequestException, Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { AI_TOOL_NAMESPACE_TOKEN } from "../ai.constants";
import { AiTool } from "./ai-tool.abstract";
import { AiToolContext } from "./ai-tool-context";
import { AiToolSpec } from "../interfaces/ai-types";

export interface AiToolNamespace {
  getTools(): AiTool[];
}

@Injectable()
export class AiToolRegistryService implements OnModuleInit {
  private readonly tools = new Map<string, AiTool>();

  constructor(
    @Inject(AI_TOOL_NAMESPACE_TOKEN)
    private readonly namespaces: AiToolNamespace[],
  ) {}

  onModuleInit() {
    for (const namespace of this.namespaces ?? []) {
      for (const tool of namespace.getTools() ?? []) {
        if (this.tools.has(tool.name)) {
          throw new BadRequestException(
            `Duplicate AI tool name '${tool.name}' registered across namespaces`,
          );
        }
        this.tools.set(tool.name, tool);
      }
    }
  }

  getTool(name: string): AiTool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): AiTool[] {
    return Array.from(this.tools.values());
  }

  getToolSpecs(ctx: AiToolContext): AiToolSpec[] {
    return this.getAllTools()
      .filter((tool) => tool.canRunFor(ctx))
      .map((tool) => tool.toSpec());
  }
}
