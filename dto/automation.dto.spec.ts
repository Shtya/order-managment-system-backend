import { ValidationArguments, validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  ActionType,
  ConditionType,
  FlowNodeType,
  TriggerType,
} from "entities/automation.entity";
import { describe, expect, test, vi } from "vitest";
import {
  CreateAutomationDto,
  NodeDataMatchesNodeTypeConstraint,
  UniqueEdgeIdsConstraint,
  UniqueNodeIdsConstraint,
  ValidFlowGraphConstraint,
} from "./automation.dto";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

function trigger(id = "trigger") {
  return {
    id,
    type: FlowNodeType.TRIGGER,
    position: { x: 0, y: 0 },
    data: {
      type: TriggerType.ORDER_CREATED,
      label: "Order created",
      config: {},
    },
  };
}

function action(id: string, label = id) {
  return {
    id,
    type: FlowNodeType.ACTION,
    position: { x: 0, y: 0 },
    data: {
      type: ActionType.WAIT,
      label,
      config: {},
    },
  };
}

function condition(id: string, label = id) {
  return {
    id,
    type: FlowNodeType.CONDITION,
    position: { x: 0, y: 0 },
    data: {
      type: ConditionType.ORDER_CHECK,
      label,
      config: { checks: [] },
    },
  };
}

function branchedAction(id: string, branchIds: string[], label = id) {
  return {
    id,
    type: FlowNodeType.ACTION,
    position: { x: 0, y: 0 },
    data: {
      type: ActionType.SEND_WHATSAPP_TEMPLATE,
      label,
      config: {
        branches: branchIds.map((branchId) => ({
          id: branchId,
          label: branchId,
          condition: branchId,
        })),
      },
    },
  };
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string,
  id?: string,
) {
  return {
    id: id ?? `e-${source}-${sourceHandle || "out"}-${target}`,
    source,
    target,
    ...(sourceHandle !== undefined ? { sourceHandle } : {}),
  };
}

function graphArgs(flow: { nodes: unknown[]; edges?: unknown[] }) {
  return {
    object: flow,
    value: flow.nodes,
    targetName: "FlowDefinitionDto",
    property: "nodes",
    constraints: [],
  } as unknown as ValidationArguments;
}

function validateGraph(flow: { nodes: unknown[]; edges?: unknown[] }) {
  const constraint = new ValidFlowGraphConstraint();
  const args = graphArgs(flow);
  const valid = constraint.validate(flow.nodes, args);
  return {
    valid,
    message: constraint.defaultMessage(args),
  };
}

function linearFlow() {
  return {
    nodes: [trigger(), action("a", "Wait"), action("b", "Update status")],
    edges: [edge("trigger", "a"), edge("a", "b")],
  };
}

void ValidFlowGraphConstraint.prototype.validate;
describe("validate", () => {
  test("accepts a linear flow from a single trigger", () => {
    expect(validateGraph(linearFlow()).valid).toBe(true);
  });

  test("accepts a diamond that merges into one node", () => {
    const flow = {
      nodes: [
        trigger(),
        condition("c", "Check order"),
        action("yes", "Yes path"),
        action("no", "No path"),
        action("join", "Join"),
      ],
      edges: [
        edge("trigger", "c"),
        edge("c", "yes", "true"),
        edge("c", "no", "false"),
        edge("yes", "join"),
        edge("no", "join"),
      ],
    };

    expect(validateGraph(flow).valid).toBe(true);
  });

  test("accepts two outgoing edges from different source handles", () => {
    const flow = {
      nodes: [
        trigger(),
        branchedAction("wa", ["btn-1", "btn-2"], "Send template"),
        action("left", "Left"),
        action("right", "Right"),
      ],
      edges: [
        edge("trigger", "wa"),
        edge("wa", "left", "btn-1"),
        edge("wa", "right", "btn-2"),
      ],
    };

    expect(validateGraph(flow).valid).toBe(true);
  });

  test("rejects a second outgoing edge from the trigger default handle", () => {
    const flow = {
      nodes: [trigger(), action("a", "A"), action("b", "B")],
      edges: [edge("trigger", "a"), edge("trigger", "b")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.source_handle_already_connected")).toBe(
      true,
    );
  });

  test("rejects a second outgoing edge from the same action handle", () => {
    const flow = {
      nodes: [
        trigger(),
        action("a", "A"),
        action("b", "B"),
        action("c", "C"),
      ],
      edges: [
        edge("trigger", "a"),
        edge("a", "b"),
        edge("a", "c"),
      ],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.source_handle_already_connected")).toBe(
      true,
    );
  });

  test("rejects a duplicate connection to the same target via the same handle", () => {
    const flow = {
      nodes: [trigger(), action("a", "A")],
      edges: [
        edge("trigger", "a", undefined, "e-1"),
        edge("trigger", "a", undefined, "e-2"),
      ],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.duplicate_connection")).toBe(true);
  });

  test("rejects a flow with zero trigger nodes", () => {
    const flow = {
      nodes: [action("a", "A"), action("b", "B")],
      edges: [edge("a", "b")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.exactly_one_trigger_node")).toBe(
      true,
    );
  });

  test("rejects a flow with two trigger nodes", () => {
    const flow = {
      nodes: [trigger("t1"), trigger("t2"), action("a", "A")],
      edges: [edge("t1", "a")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.exactly_one_trigger_node")).toBe(
      true,
    );
  });

  test("rejects an incoming edge on the trigger", () => {
    const flow = {
      nodes: [trigger(), action("a", "A")],
      edges: [edge("trigger", "a"), edge("a", "trigger")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.trigger_cannot_have_incoming_edges")).toBe(
      true,
    );
  });

  test("rejects an edge whose source node does not exist", () => {
    const flow = {
      nodes: [trigger(), action("a", "A")],
      edges: [edge("missing", "a")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.edge_source_not_exist")).toBe(true);
  });

  test("rejects an edge whose target node does not exist", () => {
    const flow = {
      nodes: [trigger(), action("a", "A")],
      edges: [edge("trigger", "missing")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.edge_target_not_exist")).toBe(true);
  });

  test("rejects a non-trigger node with no incoming edge", () => {
    const flow = {
      nodes: [trigger(), action("a", "A"), action("orphan", "Orphan")],
      edges: [edge("trigger", "a")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.node_unreachable")).toBe(true);
  });

  test("rejects a component that has incoming edges but is not reachable from the trigger", () => {
    const flow = {
      nodes: [
        trigger(),
        action("a", "A"),
        action("x", "X"),
        action("y", "Y"),
      ],
      edges: [edge("trigger", "a"), edge("x", "y"), edge("y", "x", "back")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.flow_not_fully_connected")).toBe(
      true,
    );
  });

  test("rejects a self-loop on an action node", () => {
    const flow = {
      nodes: [trigger(), action("a", "Wait")],
      edges: [edge("trigger", "a"), edge("a", "a")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.flow_circular_reference")).toBe(
      true,
    );
  });

  test("rejects a simple cycle among actions", () => {
    const flow = {
      nodes: [
        trigger(),
        action("a", "Send offer"),
        action("b", "Check status"),
        action("c", "Wait"),
      ],
      edges: [
        edge("trigger", "a"),
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "a"),
      ],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.flow_circular_reference")).toBe(
      true,
    );
  });

  test("rejects a cycle that appears after a merge", () => {
    const flow = {
      nodes: [
        trigger(),
        condition("c", "Check"),
        action("yes", "Yes"),
        action("no", "No"),
        action("join", "Join"),
        action("loop", "Loop back"),
      ],
      edges: [
        edge("trigger", "c"),
        edge("c", "yes", "true"),
        edge("c", "no", "false"),
        edge("yes", "join"),
        edge("no", "join"),
        edge("join", "loop"),
        edge("loop", "yes"),
      ],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.flow_circular_reference")).toBe(
      true,
    );
  });

  test("rejects a long cycle hidden after a linear prefix", () => {
    const flow = {
      nodes: [
        trigger(),
        action("a", "A"),
        action("b", "B"),
        action("c", "C"),
        action("d", "D"),
        action("e", "E"),
      ],
      edges: [
        edge("trigger", "a"),
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "d"),
        edge("d", "e"),
        edge("e", "c"),
      ],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.flow_circular_reference")).toBe(
      true,
    );
  });

  test("rejects a branched node whose sourceHandle is not a branch id", () => {
    const flow = {
      nodes: [
        trigger(),
        branchedAction("wa", ["btn-1", "btn-2"], "Send template"),
        action("next", "Next"),
      ],
      edges: [edge("trigger", "wa"), edge("wa", "next", "unknown-button")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.invalid_source_handle")).toBe(
      true,
    );
  });

  test("rejects a branched node whose outgoing edge has no sourceHandle", () => {
    const flow = {
      nodes: [
        trigger(),
        branchedAction("wa", ["btn-1"], "Send template"),
        action("next", "Next"),
      ],
      edges: [edge("trigger", "wa"), edge("wa", "next")],
    };

    const result = validateGraph(flow);

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.invalid_source_handle")).toBe(
      true,
    );
  });

  test("treats missing edges as an empty list", () => {
    const result = validateGraph({
      nodes: [trigger(), action("a", "A")],
    });

    expect(result.valid).toBe(false);
    expect(result.message.startsWith("validation.node_unreachable")).toBe(true);
  });
});

void ValidFlowGraphConstraint.prototype.defaultMessage;
describe("defaultMessage", () => {
  test("includes node labels in a circular-dependency message", () => {
    const flow = {
      nodes: [
        trigger(),
        action("a", "Send offer"),
        action("b", "Check status"),
      ],
      edges: [edge("trigger", "a"), edge("a", "b"), edge("b", "a")],
    };

    const result = validateGraph(flow);

    expect(result.message).toContain("Send offer");
    expect(result.message).toContain("Check status");
  });
});

void UniqueNodeIdsConstraint.prototype.validate;
describe("validate", () => {
  test("accepts unique node ids", () => {
    const constraint = new UniqueNodeIdsConstraint();
    expect(constraint.validate([trigger(), action("a")])).toBe(true);
  });

  test("rejects duplicate node ids", () => {
    const constraint = new UniqueNodeIdsConstraint();
    expect(constraint.validate([trigger("same"), action("same")])).toBe(false);
  });

  test("accepts a non-array value so other validators can report it", () => {
    const constraint = new UniqueNodeIdsConstraint();
    expect(constraint.validate(null as never)).toBe(true);
  });
});

void UniqueEdgeIdsConstraint.prototype.validate;
describe("validate", () => {
  test("accepts unique edge ids", () => {
    const constraint = new UniqueEdgeIdsConstraint();
    expect(
      constraint.validate([
        edge("a", "b", undefined, "e1"),
        edge("b", "c", undefined, "e2"),
      ]),
    ).toBe(true);
  });

  test("rejects duplicate edge ids", () => {
    const constraint = new UniqueEdgeIdsConstraint();
    expect(
      constraint.validate([
        edge("a", "b", undefined, "same"),
        edge("b", "c", undefined, "same"),
      ]),
    ).toBe(false);
  });
});

void NodeDataMatchesNodeTypeConstraint.prototype.validate;
describe("validate", () => {
  test("accepts trigger data on a trigger node", () => {
    const constraint = new NodeDataMatchesNodeTypeConstraint();
    const node = trigger();
    expect(
      constraint.validate(node.data, {
        object: node,
      } as ValidationArguments),
    ).toBe(true);
  });

  test("rejects action data on a trigger node", () => {
    const constraint = new NodeDataMatchesNodeTypeConstraint();
    const node = trigger();
    expect(
      constraint.validate(
        { ...node.data, type: ActionType.WAIT },
        { object: node } as ValidationArguments,
      ),
    ).toBe(false);
  });

  test("rejects trigger data on an action node", () => {
    const constraint = new NodeDataMatchesNodeTypeConstraint();
    const node = action("a");
    expect(
      constraint.validate(
        { ...node.data, type: TriggerType.ORDER_CREATED },
        { object: node } as ValidationArguments,
      ),
    ).toBe(false);
  });
});

describe("CreateAutomationDto", () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(CreateAutomationDto, payload);
    return validate(dto);
  }

  test("accepts a valid linear automation payload", async () => {
    const errors = await validateDto({
      name: "Welcome",
      triggerType: TriggerType.ORDER_CREATED,
      flow: linearFlow(),
    });

    expect(errors).toEqual([]);
  });

  test("rejects a payload with fewer than two nodes", async () => {
    const errors = await validateDto({
      name: "Welcome",
      triggerType: TriggerType.ORDER_CREATED,
      flow: { nodes: [trigger()], edges: [] },
    });

    const nodeErrors = errors
      .find((error) => error.property === "flow")
      ?.children?.find((error) => error.property === "nodes");

    expect(nodeErrors?.constraints).toHaveProperty("arrayMinSize");
  });
});
