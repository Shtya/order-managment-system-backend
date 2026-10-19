import {
  buildStepBranches,
  normalizeMessageActionIntent,
  rewriteEdgeHandles,
  type BranchFlowEdge,
  type BranchFlowNode,
} from "./automation-branches";

const node = (
  id: string,
  type: string,
  config: Record<string, unknown>,
): BranchFlowNode => ({ id, type, data: { type, config } });

const messageNode = (config: Record<string, unknown>): BranchFlowNode => {
  const branches = buildStepBranches("send_whatsapp_message", config);
  const next = { ...config };
  if (branches.length) {
    next.branches = branches;
    normalizeMessageActionIntent("send_whatsapp_message", next, branches);
  }
  return node("n1", "send_whatsapp_message", next);
};

const interactiveData = (buttons: { id: string; title: string }[]) => ({
  messageMode: "custom",
  messageType: "interactive",
  messageData: {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Choose" },
      action: {
        buttons: buttons.map((button) => ({
          type: "reply",
          reply: { id: button.id, title: button.title },
        })),
      },
    },
  },
});

describe("buildStepBranches", () => {
  it("returns the fixed yes/no condition branches", () => {
    expect(buildStepBranches("order_check", {})).toEqual([
      { id: "true", label: "Yes", condition: "true" },
      { id: "false", label: "No", condition: "false" },
    ]);
    expect(buildStepBranches("quick_order_status", {})[0].id).toBe("true");
  });

  it("adds no_roles_match only for automatic employee assignment", () => {
    expect(
      buildStepBranches("assign_order_to_employee", { employeeId: "abc" }).map((b) => b.id),
    ).toEqual(["assigned", "not_eligable"]);
    expect(buildStepBranches("assign_order_to_employee", {}).map((b) => b.id)).toEqual([
      "assigned",
      "no_roles_match",
      "not_eligable",
    ]);
  });

  it("only accepts a no-response timeout within 1..10080 minutes", () => {
    const withTimeout = (value: unknown) =>
      buildStepBranches("send_upsell", { noResponseMinutes: value as number }).map((b) => b.id);

    expect(withTimeout(30)).toEqual(["skipped", "reject", "accept", "client_reject", "no_response"]);
    expect(withTimeout("45")).toContain("no_response");
    expect(withTimeout(0)).not.toContain("no_response");
    expect(withTimeout(10081)).not.toContain("no_response");
    expect(withTimeout(1.5)).not.toContain("no_response");
  });

  it("indexes template branches over CUSTOM buttons only", () => {
    const branches = buildStepBranches("send_whatsapp_template", {
      templateData: {
        buttons: [
          { type: "CUSTOM", text: "Confirm" },
          { type: "VISIT_WEBSITE", text: "Site" },
          { type: "CUSTOM", text: "Cancel" },
        ],
      },
    });

    expect(branches.map((b) => b.id)).toEqual(["btn_0", "btn_1"]);
    expect(branches[0]).toMatchObject({ label: "Confirm", condition: "button_click_0" });
    expect(branches[1]).toMatchObject({ label: "Cancel", condition: "button_click_1" });
    expect(branches[1].sourceButton).toMatchObject({ text: "Cancel" });
  });

  it("uses the quick-reply id for interactive messages", () => {
    const branches = buildStepBranches(
      "send_whatsapp_message",
      interactiveData([
        { id: "yes_thanks", title: "Yes thanks" },
        { id: "no_thanks", title: "No thanks" },
      ]),
    );

    expect(branches.map((b) => b.id)).toEqual(["yes_thanks", "no_thanks"]);
    expect(branches[0].label).toBe("Yes thanks");
  });

  it("adds a catch-all for list and location_request messages", () => {
    expect(
      buildStepBranches("send_whatsapp_message", { messageType: "list" }),
    ).toEqual([{ id: "any_option", label: "When respond", isCatchAll: true }]);
    expect(
      buildStepBranches("send_whatsapp_message", { messageType: "location_request" })[0].id,
    ).toBe("any_option");
  });

  it("sets actionIntent from the derived branches", () => {
    const interactive: Record<string, unknown> = { ...interactiveData([{ id: "btn_0", title: "Ok" }]) };
    normalizeMessageActionIntent(
      "send_whatsapp_message",
      interactive,
      buildStepBranches("send_whatsapp_message", interactive),
    );
    expect(interactive.actionIntent).toBe("branches");

    const location = { messageType: "location_request", actionIntent: "branches" };
    normalizeMessageActionIntent(
      "send_whatsapp_message",
      location,
      buildStepBranches("send_whatsapp_message", location),
    );
    expect(location.actionIntent).toBe("location_request");

    const plain = { messageType: "text", actionIntent: "branches" };
    normalizeMessageActionIntent(
      "send_whatsapp_message",
      plain,
      buildStepBranches("send_whatsapp_message", plain),
    );
    expect(plain.actionIntent).toBe("none");
  });

  it("never branches for plain steps", () => {
    expect(buildStepBranches("wait", { waitMinutes: 5 })).toEqual([]);
    expect(buildStepBranches("order_created", {})).toEqual([]);
  });
});

describe("rewriteEdgeHandles", () => {
  const templateNode = node("n1", "send_whatsapp_template", {
    templateData: {
      buttons: [
        { type: "CUSTOM", text: "Confirm" },
        { type: "CUSTOM", text: "Cancel" },
      ],
    },
    branches: buildStepBranches("send_whatsapp_template", {
      templateData: {
        buttons: [
          { type: "CUSTOM", text: "Confirm" },
          { type: "CUSTOM", text: "Cancel" },
        ],
      },
    }),
  });

  it("remaps a wrong numeric index by matching the button label", () => {
    const previous = new Map<string, readonly unknown[]>([
      [
        "n1",
        [
          { id: "btn_1", label: "Confirm" },
          { id: "btn_2", label: "Cancel" },
        ],
      ],
    ]);
    const { edges, errors } = rewriteEdgeHandles(
      [
        { id: "e1", source: "n1", target: "a", sourceHandle: "btn_1" },
        { id: "e2", source: "n1", target: "b", sourceHandle: "btn_2" },
      ],
      [templateNode],
      previous,
    );

    expect(errors).toEqual([]);
    expect(edges.map((edge) => edge.sourceHandle)).toEqual(["btn_0", "btn_1"]);
  });

  it("keeps a handle that already matches a canonical branch", () => {
    const { edges, errors } = rewriteEdgeHandles(
      [{ id: "e1", source: "n1", target: "a", sourceHandle: "btn_1" }],
      [templateNode],
      new Map(),
    );

    expect(errors).toEqual([]);
    expect(edges[0].sourceHandle).toBe("btn_1");
  });

  it("strips the handle when the source step has no branches", () => {
    const { edges, errors } = rewriteEdgeHandles(
      [{ id: "e1", source: "n1", target: "a", sourceHandle: "whatever" }],
      [node("n1", "wait", { waitMinutes: 5 })],
      new Map(),
    );

    expect(errors).toEqual([]);
    expect(edges[0].sourceHandle).toBeUndefined();
  });

  it("fills a missing handle for a single branch and for a single catch-all", () => {
    const single = rewriteEdgeHandles(
      [{ id: "e1", source: "n1", target: "a" }],
      [node("n1", "ai_address_correction", { branches: [{ id: "address_corrected", label: "x" }] })],
      new Map(),
    );
    expect(single.edges[0].sourceHandle).toBe("address_corrected");

    const catchAll = rewriteEdgeHandles(
      [{ id: "e1", source: "n1", target: "a" }],
      [
        node("n1", "send_whatsapp_message", {
          messageType: "list",
          branches: [{ id: "any_option", label: "When respond", isCatchAll: true }],
        }),
      ],
      new Map(),
    );
    expect(catchAll.errors).toEqual([]);
    expect(catchAll.edges[0].sourceHandle).toBe("any_option");
  });

  it("aliases yes/no handles on condition steps", () => {
    const { edges, errors } = rewriteEdgeHandles(
      [
        { id: "e1", source: "n1", target: "a", sourceHandle: "yes" },
        { id: "e2", source: "n1", target: "b", sourceHandle: "no" },
      ],
      [
        node("n1", "order_check", {
          branches: buildStepBranches("order_check", {}),
        }),
      ],
      new Map(),
    );

    expect(errors).toEqual([]);
    expect(edges.map((edge) => edge.sourceHandle)).toEqual(["true", "false"]);
  });

  it("reports an unmatched explicit handle with the expected list", () => {
    const { errors } = rewriteEdgeHandles(
      [{ id: "e1", source: "n1", target: "a", sourceHandle: "btn_9" }],
      [templateNode],
      new Map(),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sourceHandle "btn_9"');
    expect(errors[0]).toContain("btn_0 (Confirm)");
  });

  it("reports a missing handle when the choice is ambiguous", () => {
    const { errors } = rewriteEdgeHandles(
      [{ id: "e1", source: "n1", target: "a" }],
      [templateNode],
      new Map(),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("without a sourceHandle");
    expect(errors[0]).toContain("btn_1 (Cancel)");
  });

  it("leaves edges from unknown nodes untouched for the DTO to report", () => {
    const edges: BranchFlowEdge[] = [{ id: "e1", source: "missing", target: "a" }];
    const { edges: rewritten, errors } = rewriteEdgeHandles(edges, [], new Map());

    expect(errors).toEqual([]);
    expect(rewritten[0].sourceHandle).toBeUndefined();
  });
});
