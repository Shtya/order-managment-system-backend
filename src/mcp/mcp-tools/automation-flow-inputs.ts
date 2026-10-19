import { z } from "zod";
import { TOOL } from "../utils/mcp-tool-names";

export const saveFlowNodeInput = z.object({
  id: z.string().min(1).describe("Unique node id, any string (e.g. \"n1\")."),
  type: z
    .enum(["trigger", "action", "condition"])
    .optional()
    .describe("Node kind. Omit it: it is derived from data.type."),
  position: z
    .object({
      x: z.number().finite().describe("Horizontal canvas position."),
      y: z.number().finite().describe("Vertical canvas position."),
    })
    .optional()
    .describe("Optional canvas placement metadata. Omit when the editor should compute the layout."),
  data: z.object({
    type: z
      .string()
      .min(1)
      .describe(`Step id from ${TOOL.automation.stepsList}.`),
    label: z
      .string()
      .min(1)
      .optional()
      .describe("Short name for this step instance. Defaults to the catalog title."),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Step settings described by configSchema in automation_steps_list. Validated and defaulted server-side."),
  }),
});

export const saveFlowEdgeInput = z.object({
  id: z.string().min(1).describe("Unique edge id, any string (e.g. \"e1\")."),
  source: z.string().min(1).describe("Source node id."),
  target: z.string().min(1).describe("Target node id."),
  sourceHandle: z
    .string()
    .optional()
    .describe("Branch id from the source step's branches. Omit when the source has no branches."),
  targetHandle: z.string().optional(),
});

export const saveFlowInput = z.object({
  nodes: z.array(saveFlowNodeInput).min(2).max(100).describe("Flow nodes. Exactly one trigger, at least one action."),
  edges: z.array(saveFlowEdgeInput).describe("Flow edges. Connect every node to the trigger and keep the graph acyclic."),
  whatsapp: z
    .object({
      mode: z.enum(["random", "fixed"]).optional().describe("WhatsApp sending number strategy."),
      accountId: z
        .string()
        .uuid()
        .optional()
        .nullable()
        .describe("Account id from the WhatsApp accounts search. Used when mode=fixed."),
    })
    .optional()
    .describe("Optional WhatsApp account used by every WhatsApp step in a run."),
});
