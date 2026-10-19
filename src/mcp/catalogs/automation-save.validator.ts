import {
  buildStepBranches,
  normalizeMessageActionIntent,
} from "./automation-branches";
import { AUTOMATION_STEP_META, STEP_CONFIG_SCHEMAS } from "./automation-steps.catalog";

const MAX_REPORTED_ISSUES = 15;
const AUTO_LAYOUT_STEP = 280;

export type AutomationNodeKind = "trigger" | "action" | "condition";

export type AutomationFlowNode = {
  id: string;
  type: AutomationNodeKind;
  data: { type: string; label: string; config: Record<string, unknown> };
  position: { x: number; y: number };
  measured?: { width: number; height: number };
};

export type FlowValidationResult = {
  ok: boolean;
  nodes: AutomationFlowNode[];
  errors: string[];
  /** Branches authored by the model, kept only to remap their edge handles. */
  previousBranches: Map<string, readonly unknown[]>;
};

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Zod `.object()` strips unknown keys. Configs also carry fields the catalog
 * does not model (graph branches, display mirrors, legacy keys), and some
 * message schemas are `.transform()`s that build `messageData`. Merge the
 * parsed output over the original so defaults/transforms are applied without
 * losing the rest of the config.
 */
export function mergeConfig(original: PlainObject, parsed: PlainObject): PlainObject {
  const merged: PlainObject = { ...original };
  for (const [key, value] of Object.entries(parsed)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? mergeConfig(merged[key] as PlainObject, value)
      : value;
  }
  return merged;
}

type ZodIssueLine = { path: PropertyKey[]; message: string };

/** Flatten union errors so a bad message config reports the useful branch, not just "Invalid input". */
function flattenIssues(issues: readonly any[], lines: ZodIssueLine[] = []): ZodIssueLine[] {
  for (const issue of issues) {
    if (issue?.code === "invalid_union" && Array.isArray(issue.errors)) {
      for (const branch of issue.errors) flattenIssues(branch, lines);
      continue;
    }
    const extra = Array.isArray(issue?.keys) && issue.keys.length ? ` (${issue.keys.join(", ")})` : "";
    lines.push({ path: Array.isArray(issue?.path) ? issue.path : [], message: `${issue?.message ?? "Invalid value"}${extra}` });
  }
  return lines;
}

function nodeLabel(raw: { data?: { label?: unknown }; id?: unknown }, index: number): string {
  const id = typeof raw?.id === "string" && raw.id ? raw.id : `nodes[${index}]`;
  return typeof raw?.data?.label === "string" && raw.data.label.trim()
    ? `${id} (${raw.data.label.trim()})`
    : id;
}

function positionOf(raw: { position?: unknown }, index: number): { x: number; y: number } {
  const position = raw?.position as { x?: unknown; y?: unknown } | undefined;
  return {
    x: typeof position?.x === "number" && Number.isFinite(position.x) ? position.x : index * AUTO_LAYOUT_STEP,
    y: typeof position?.y === "number" && Number.isFinite(position.y) ? position.y : 0,
  };
}

/**
 * Validates every node's `data.type` and `data.config` against the step
 * catalog, then normalizes labels/positions/configs for the automation DTO.
 * Structural flow rules (trigger count, cycles, edges, ...) are left to the DTO.
 */
export function validateAndNormalizeNodes(nodes: readonly unknown[]): FlowValidationResult {
  const errors: string[] = [];
  const normalized: AutomationFlowNode[] = [];
  const previousBranches = new Map<string, readonly unknown[]>();

  nodes.forEach((raw, index) => {
    const node = raw as {
      id?: unknown;
      type?: unknown;
      position?: unknown;
      measured?: unknown;
      data?: { type?: unknown; label?: unknown; config?: unknown };
    };
    const stepType = typeof node?.data?.type === "string" ? node.data.type : "";
    const meta = AUTOMATION_STEP_META.get(stepType);
    const where = nodeLabel(node, index);

    if (!meta) {
      errors.push(
        `${where}: unknown step type "${stepType || "(missing)"}". Use an id from automation_steps_list.`,
      );
      return;
    }

    if (node?.type && node.type !== meta.kind) {
      errors.push(
        `${where}: node.type "${String(node.type)}" does not match step "${stepType}" (${meta.kind}).`,
      );
    }

    const originalConfig = isPlainObject(node?.data?.config) ? node.data.config : {};
    const { branches: modelBranches, ...configWithoutBranches } = originalConfig;
    previousBranches.set(String(node.id), Array.isArray(modelBranches) ? modelBranches : []);
    const schema = STEP_CONFIG_SCHEMAS[stepType as keyof typeof STEP_CONFIG_SCHEMAS];
    let config: PlainObject = { ...configWithoutBranches };

    if (schema) {
      const parsed = schema.safeParse(configWithoutBranches);
      if (!parsed.success) {
        const seen = new Set<string>();
        for (const issue of flattenIssues(parsed.error.issues)) {
          const path = issue.path.length ? `config.${issue.path.map(String).join(".")}` : "config";
          const line = `${where} (${stepType}) ${path}: ${issue.message}`;
          if (seen.has(line)) continue;
          seen.add(line);
          errors.push(line);
        }
      } else if (isPlainObject(parsed.data)) {
        config = mergeConfig(configWithoutBranches, parsed.data);
      }
    } else if (Object.keys(configWithoutBranches).length > 0) {
      errors.push(`${where} (${stepType}) config: this step has no settings; send an empty config.`);
    }

    // Branches are owned by the server: derive them from the validated settings.
    const branches = buildStepBranches(stepType, config);
    if (branches.length) {
      config = { ...config, branches };
      normalizeMessageActionIntent(stepType, config, branches);
    } else {
      const { branches: _dropped, ...rest } = config;
      config = rest;
    }

    normalized.push({
      id: String(node.id),
      type: node.type ? (node.type as AutomationNodeKind) : meta.kind,
      position: positionOf(node, index),
      ...(isPlainObject(node.measured) ? { measured: node.measured as { width: number; height: number } } : {}),
      data: {
        type: stepType,
        label:
          typeof node?.data?.label === "string" && node.data.label.trim()
            ? node.data.label.trim()
            : meta.title,
        config,
      },
    });
  });

  if (errors.length > MAX_REPORTED_ISSUES) {
    const keep = MAX_REPORTED_ISSUES - 1;
    const hidden = errors.length - keep;
    errors.splice(keep, errors.length, `...and ${hidden} more issue(s).`);
  }

  return { ok: errors.length === 0, nodes: normalized, errors, previousBranches };
}
