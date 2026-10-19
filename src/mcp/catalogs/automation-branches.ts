/**
 * Server-owned branch derivation.
 *
 * The AI describes a step's settings; it never decides the graph branches.
 * Branches are derived from the settings here (template quick replies, dynamic
 * message buttons, no-response timeouts, ...) and written into
 * `data.config.branches`. Edges are then aligned to those branch ids so a flow
 * cannot reference stale handles invented by the model.
 */

export type FlowBranch = {
  id: string;
  label: string;
  condition?: string;
  sourceButton?: Record<string, unknown>;
  isCatchAll?: boolean;
  isNoResponse?: boolean;
  timeoutMinutes?: number;
};

export type BranchFlowNode = {
  id: string;
  type?: string;
  data: { type: string; config?: Record<string, unknown> };
};

export type BranchFlowEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

const MAX_NO_RESPONSE_MINUTES = 7 * 24 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const normalizeText = (value: unknown): string => asString(value).trim().toLowerCase();

function noResponseMinutes(config: Record<string, unknown>): number | undefined {
  const raw = config.noResponseMinutes;
  const minutes =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : Number.NaN;
  if (
    !Number.isFinite(minutes) ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_NO_RESPONSE_MINUTES
  ) {
    return undefined;
  }
  return minutes;
}

function noResponseBranch(config: Record<string, unknown>): FlowBranch | undefined {
  const minutes = noResponseMinutes(config);
  if (!minutes) return undefined;
  return {
    id: "no_response",
    label: "No response",
    isNoResponse: true,
    timeoutMinutes: minutes,
  };
}

function templateCustomButtons(config: Record<string, unknown>): Record<string, unknown>[] {
  const templateData = asRecord(config.templateData);
  const buttons = asArray(templateData.buttons).length
    ? asArray(templateData.buttons)
    : asArray(config.buttons);
  return buttons.filter(
    (button): button is Record<string, unknown> =>
      isRecord(button) && button.type === "CUSTOM",
  );
}

function messageAction(config: Record<string, unknown>): Record<string, unknown> {
  const messageData = asRecord(config.messageData);
  const interactive = asRecord(messageData.interactive);
  return asRecord(interactive.action);
}

function messageReplyButtons(config: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(messageAction(config).buttons).filter(
    (button): button is Record<string, unknown> =>
      isRecord(button) && isRecord(button.reply),
  );
}

function messageHasCatchAll(config: Record<string, unknown>): boolean {
  const action = messageAction(config);
  return asArray(action.sections).length > 0 || action.name === "send_location";
}

function catchAllBranch(): FlowBranch {
  return { id: "any_option", label: "When respond", isCatchAll: true };
}

function buildMessageBranches(config: Record<string, unknown>): FlowBranch[] {
  const messageType = asString(config.messageType);
  let base: FlowBranch[] = [];

  if (messageType === "interactive") {
    const replies = messageReplyButtons(config);
    if (replies.length) {
      const seen = new Set<string>();
      base = replies.map((button, index) => {
        const reply = asRecord(button.reply);
        const rawId = asString(reply.id) || `btn_${index}`;
        let id = rawId;
        while (seen.has(id)) id = `${rawId}_${index}`;
        seen.add(id);
        return {
          id,
          label: asString(reply.title),
          sourceButton: button,
        };
      });
    } else if (messageHasCatchAll(config)) {
      base = [catchAllBranch()];
    }
  } else if (messageType === "list" || messageType === "location_request") {
    base = [catchAllBranch()];
  }

  const noResponse = base.length ? noResponseBranch(config) : undefined;
  return noResponse ? [...base, noResponse] : base;
}

/**
 * The complete branch set a step must expose, derived only from its config.
 * Empty means the step does not branch and edges must not carry a sourceHandle.
 */
export function buildStepBranches(
  stepType: string,
  config: Record<string, unknown>,
): FlowBranch[] {
  switch (stepType) {
    case "order_check":
    case "quick_order_status":
      return [
        { id: "true", label: "Yes", condition: "true" },
        { id: "false", label: "No", condition: "false" },
      ];

    case "ai_address_completeness":
      return [
        { id: "valid", label: "Valid", condition: "valid" },
        { id: "not_valid", label: "Not valid", condition: "not_valid" },
        { id: "not_sure", label: "Not sure", condition: "not_sure" },
      ];

    case "ai_address_correction":
      return [
        {
          id: "address_corrected",
          label: "Address corrected",
          condition: "address_corrected",
        },
        {
          id: "address_not_corrected",
          label: "Address not corrected",
          condition: "address_not_corrected",
        },
      ];

    case "assign_order_to_employee": {
      const manual = asString(config.employeeId).trim().length > 0;
      const branches: FlowBranch[] = [
        { id: "assigned", label: "Assigned", condition: "assigned" },
      ];
      if (!manual) {
        branches.push({
          id: "no_roles_match",
          label: "No roles match",
          condition: "no_roles_match",
        });
      }
      branches.push({
        id: "not_eligable",
        label: "Not eligible",
        condition: "not_eligable",
      });
      return branches;
    }

    case "assign_shipping_provider":
      return [
        {
          id: "distributed",
          label: "Distributed",
          condition: "distributed",
        },
        {
          id: "failed_to_distribute",
          label: "Failed to distribute",
          condition: "failed_to_distribute",
        },
      ];

    case "send_upsell": {
      const base: FlowBranch[] = [
        { id: "skipped", label: "Skipped", condition: "skipped" },
        { id: "reject", label: "Reject", condition: "reject" },
        { id: "accept", label: "Accept", condition: "accept" },
        {
          id: "client_reject",
          label: "Client reject",
          condition: "client_reject",
        },
      ];
      const noResponse = noResponseBranch(config);
      return noResponse ? [...base, noResponse] : base;
    }

    case "send_whatsapp_template": {
      const base: FlowBranch[] = templateCustomButtons(config).map(
        (button, index) => ({
          id: `btn_${index}`,
          label: asString(button.text) || `Button ${index + 1}`,
          condition: `button_click_${index}`,
          sourceButton: button,
        }),
      );
      const noResponse = noResponseBranch(config);
      return noResponse ? [...base, noResponse] : base;
    }

    case "send_whatsapp_message":
      return buildMessageBranches(config);

    default:
      return [];
  }
}

/** Message steps expose `actionIntent` to the runtime; keep it aligned with the real branches. */
export function normalizeMessageActionIntent(
  stepType: string,
  config: Record<string, unknown>,
  branches: readonly FlowBranch[],
): void {
  if (stepType !== "send_whatsapp_message") return;
  const branchable = branches.some((branch) => !branch.isNoResponse);
  if (!branchable) {
    config.actionIntent = "none";
    return;
  }
  config.actionIntent =
    asString(config.messageType) === "location_request"
      ? "location_request"
      : "branches";
}

function buttonText(button: unknown): string {
  const value = asRecord(button);
  const reply = asRecord(value.reply);
  return asString(value.text) || asString(reply.title);
}

function buttonReplyId(button: unknown): string {
  const value = asRecord(button);
  const reply = asRecord(value.reply);
  return asString(reply.id) || asString(value.id);
}

/**
 * Map an AI-authored branch onto the canonical one. Labels are the trustworthy
 * signal (models often guess numeric indexes); ids are used when the label
 * agrees too.
 */
function mapOldBranch(
  old: Record<string, unknown>,
  canonical: readonly FlowBranch[],
): string | undefined {
  const oldId = asString(old.id);
  const oldLabel = normalizeText(old.label);

  const sameId = canonical.find((branch) => branch.id === oldId);
  if (sameId && (!oldLabel || normalizeText(sameId.label) === oldLabel)) {
    return sameId.id;
  }

  if (oldLabel) {
    const byLabel = canonical.filter(
      (branch) => normalizeText(branch.label) === oldLabel,
    );
    if (byLabel.length === 1) return byLabel[0].id;
  }

  const oldButtonText = normalizeText(buttonText(old.sourceButton));
  if (oldButtonText) {
    const byText = canonical.filter(
      (branch) => normalizeText(buttonText(branch.sourceButton)) === oldButtonText,
    );
    if (byText.length === 1) return byText[0].id;
  }

  const oldReplyId = normalizeText(buttonReplyId(old.sourceButton));
  if (oldReplyId) {
    const byReply = canonical.filter(
      (branch) => normalizeText(buttonReplyId(branch.sourceButton)) === oldReplyId,
    );
    if (byReply.length === 1) return byReply[0].id;
  }

  return undefined;
}

function buildRemap(
  previous: readonly unknown[],
  canonical: readonly FlowBranch[],
): Map<string, string> {
  const remap = new Map<string, string>();
  for (const branch of previous) {
    if (!isRecord(branch)) continue;
    const oldId = asString(branch.id);
    if (!oldId) continue;
    const nextId = mapOldBranch(branch, canonical);
    if (nextId && nextId !== oldId) remap.set(oldId, nextId);
  }
  return remap;
}

function conditionAlias(stepType: string, handle: string): string | undefined {
  if (stepType !== "order_check" && stepType !== "quick_order_status") {
    return undefined;
  }
  const value = handle.trim().toLowerCase();
  if (value === "yes" || value === "true" || value === "1") return "true";
  if (value === "no" || value === "false" || value === "0") return "false";
  return undefined;
}

function displayBranches(branches: readonly FlowBranch[]): string {
  return branches.map((branch) => `${branch.id} (${branch.label})`).join(", ");
}

/**
 * Align edge handles with the canonical branches injected into the source
 * nodes. Explicit unknown handles are reported (never silently guessed), while
 * a missing handle is filled only when the step has a single obvious target.
 */
export function rewriteEdgeHandles(
  edges: readonly BranchFlowEdge[],
  nodes: readonly BranchFlowNode[],
  previousBranches: ReadonlyMap<string, readonly unknown[]>,
): { edges: BranchFlowEdge[]; errors: string[] } {
  const errors: string[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const plan = new Map<
    string,
    { canonical: FlowBranch[]; remap: Map<string, string>; stepType: string }
  >();
  for (const node of nodes) {
    const canonical = asArray(node.data.config?.branches).filter(
      (branch): branch is FlowBranch =>
        isRecord(branch) && typeof branch.id === "string",
    );
    plan.set(node.id, {
      canonical,
      remap: buildRemap(previousBranches.get(node.id) ?? [], canonical),
      stepType: node.data.type,
    });
  }

  const rewritten = edges.map((edge) => {
    const node = nodeById.get(edge.source);
    if (!node) return { ...edge };

    const { canonical, remap, stepType } = plan.get(node.id)!;

    if (!canonical.length) {
      const next = { ...edge };
      delete next.sourceHandle;
      return next;
    }

    const ids = new Set(canonical.map((branch) => branch.id));
    const handle = typeof edge.sourceHandle === "string" && edge.sourceHandle
      ? edge.sourceHandle
      : null;

    if (handle && remap.has(handle)) {
      return { ...edge, sourceHandle: remap.get(handle)! };
    }
    if (handle && ids.has(handle)) return { ...edge, sourceHandle: handle };
    if (handle) {
      const alias = conditionAlias(stepType, handle);
      if (alias) return { ...edge, sourceHandle: alias };
    }

    const where = edge.id ?? `${edge.source}->${edge.target}`;

    if (!handle) {
      if (canonical.length === 1) {
        return { ...edge, sourceHandle: canonical[0].id };
      }
      const catchAll = canonical.filter((branch) => branch.isCatchAll);
      if (catchAll.length === 1) {
        return { ...edge, sourceHandle: catchAll[0].id };
      }
      errors.push(
        `Edge "${where}" leaves "${stepType}" without a sourceHandle. Add one of: ${displayBranches(canonical)}.`,
      );
      return { ...edge };
    }

    errors.push(
      `Edge "${where}" uses sourceHandle "${handle}" but "${stepType}" has: ${displayBranches(canonical)}.`,
    );
    return { ...edge };
  });

  return { edges: rewritten, errors };
}
