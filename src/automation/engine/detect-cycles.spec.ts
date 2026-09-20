import { describe, expect, test } from "vitest";
import {
  findCircularDependency,
  formatCyclePath,
  getCycleEdgeIds,
  hasCircularDependency,
  type CycleFlow,
} from "./detect-cycles";

function createNode(id: string, label?: string) {
  return {
    id,
    data: {
      label: label ?? id,
    },
  };
}

function createEdge(source: string, target: string, id?: string) {
  return {
    id: id ?? `${source}-${target}`,
    source,
    target,
  };
}

function createFlow(nodeIds: string[], edges: CycleFlow["edges"]): CycleFlow {
  return {
    nodes: nodeIds.map((id) => createNode(id)),
    edges,
  };
}

void findCircularDependency;
describe("findCircularDependency", () => {
  test("returns null for a linear flow", () => {
    const flow = createFlow(
      ["A", "B", "C", "D"],
      [createEdge("A", "B"), createEdge("B", "C"), createEdge("C", "D")],
    );

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns a self-loop path for a node that points to itself", () => {
    const flow = createFlow(["A"], [createEdge("A", "A")]);

    expect(findCircularDependency(flow)).toEqual(["A", "A"]);
  });

  test("returns the cycle path for A to B to C to A", () => {
    const flow = createFlow(
      ["A", "B", "C"],
      [createEdge("A", "B"), createEdge("B", "C"), createEdge("C", "A")],
    );

    expect(findCircularDependency(flow)).toEqual(["A", "B", "C", "A"]);
  });

  test("returns the cycle path for a longer back-edge", () => {
    const flow = createFlow(
      ["A", "B", "C", "D", "E"],
      [
        createEdge("A", "B"),
        createEdge("B", "C"),
        createEdge("C", "D"),
        createEdge("D", "E"),
        createEdge("E", "B"),
      ],
    );

    expect(findCircularDependency(flow)).toEqual(["B", "C", "D", "E", "B"]);
  });

  test("returns null for a branching flow that merges", () => {
    const flow = createFlow(
      ["A", "B", "C", "D", "E"],
      [
        createEdge("A", "B"),
        createEdge("A", "C"),
        createEdge("B", "D"),
        createEdge("C", "D"),
        createEdge("D", "E"),
      ],
    );

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns null when multiple nodes point at the same step", () => {
    const flow = createFlow(
      ["A", "B", "C", "D"],
      [createEdge("A", "C"), createEdge("B", "C"), createEdge("C", "D")],
    );

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns a cycle when a merge later loops back", () => {
    const flow = createFlow(
      ["A", "B", "C", "D", "E"],
      [
        createEdge("A", "B"),
        createEdge("A", "C"),
        createEdge("B", "D"),
        createEdge("C", "D"),
        createEdge("D", "E"),
        createEdge("E", "B"),
      ],
    );

    expect(findCircularDependency(flow)).toEqual(["B", "D", "E", "B"]);
  });

  test("returns a cycle from a disconnected component", () => {
    const flow = createFlow(
      ["A", "B", "C", "X", "Y"],
      [
        createEdge("A", "B"),
        createEdge("B", "C"),
        createEdge("X", "Y"),
        createEdge("Y", "X"),
      ],
    );

    expect(findCircularDependency(flow)).toEqual(["X", "Y", "X"]);
  });

  test("returns null for disconnected components without cycles", () => {
    const flow = createFlow(
      ["A", "B", "X", "Y"],
      [createEdge("A", "B"), createEdge("X", "Y")],
    );

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns null for a diamond graph", () => {
    const flow = createFlow(
      ["A", "B", "C", "D"],
      [
        createEdge("A", "B"),
        createEdge("A", "C"),
        createEdge("B", "D"),
        createEdge("C", "D"),
      ],
    );

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns null for a complex acyclic graph", () => {
    const flow = createFlow(
      ["A", "B", "C", "D", "E", "F", "G"],
      [
        createEdge("A", "B"),
        createEdge("A", "C"),
        createEdge("B", "D"),
        createEdge("C", "D"),
        createEdge("C", "E"),
        createEdge("D", "F"),
        createEdge("E", "F"),
        createEdge("F", "G"),
      ],
    );

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns a cycle hidden deep in the graph", () => {
    const flow = createFlow(
      ["A", "B", "C", "D", "E", "F", "G", "H"],
      [
        createEdge("A", "B"),
        createEdge("B", "C"),
        createEdge("C", "D"),
        createEdge("D", "E"),
        createEdge("E", "F"),
        createEdge("F", "G"),
        createEdge("G", "H"),
        createEdge("H", "D"),
      ],
    );

    expect(findCircularDependency(flow)).toEqual(["D", "E", "F", "G", "H", "D"]);
  });

  test("returns a two-node cycle", () => {
    const flow = createFlow(
      ["A", "B"],
      [createEdge("A", "B"), createEdge("B", "A")],
    );

    expect(findCircularDependency(flow)).toEqual(["A", "B", "A"]);
  });

  test("ignores edges whose endpoints are missing from nodes", () => {
    const flow = createFlow(["A", "B"], [createEdge("A", "Z"), createEdge("A", "B")]);

    expect(findCircularDependency(flow)).toBeNull();
  });

  test("returns null for an empty flow", () => {
    expect(findCircularDependency({ nodes: [], edges: [] })).toBeNull();
  });

  test("returns a cycle whose first and last ids match", () => {
    const cycle = findCircularDependency(
      createFlow(
        ["A", "B", "C"],
        [createEdge("A", "B"), createEdge("B", "C"), createEdge("C", "A")],
      ),
    );

    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
  });
});

void hasCircularDependency;
describe("hasCircularDependency", () => {
  test("returns false when findCircularDependency returns null", () => {
    const flow = createFlow(["A", "B"], [createEdge("A", "B")]);

    expect(hasCircularDependency(flow)).toBe(false);
  });

  test("returns true when findCircularDependency returns a path", () => {
    const flow = createFlow(["A"], [createEdge("A", "A")]);

    expect(hasCircularDependency(flow)).toBe(true);
  });
});

void formatCyclePath;
describe("formatCyclePath", () => {
  test("joins node labels with arrows for English", () => {
    const nodes = [createNode("a1", "Send template"), createNode("a2", "Check status")];

    expect(formatCyclePath(["a1", "a2", "a1"], nodes, "en")).toBe(
      "Send template → Check status → Send template",
    );
  });

  test("joins node labels with reversed arrows for Arabic", () => {
    const nodes = [createNode("a1", "إرسال عرض"), createNode("a2", "فحص الحالة")];

    expect(formatCyclePath(["a1", "a2", "a1"], nodes, "ar")).toBe(
      "إرسال عرض ← فحص الحالة ← إرسال عرض",
    );
  });

  test("falls back to the node id when label is missing", () => {
    const nodes = [{ id: "a1", data: {} }, createNode("a2", "Check status")];

    expect(formatCyclePath(["a1", "a2", "a1"], nodes, "en")).toBe(
      "a1 → Check status → a1",
    );
  });

  test("returns an empty string for a missing cycle", () => {
    expect(formatCyclePath(null, [createNode("A")])).toBe("");
  });
});

void getCycleEdgeIds;
describe("getCycleEdgeIds", () => {
  test("returns ids of edges that form the cycle", () => {
    const edges = [
      createEdge("A", "B", "e-ab"),
      createEdge("B", "C", "e-bc"),
      createEdge("C", "A", "e-ca"),
      createEdge("A", "D", "e-ad"),
    ];

    expect(getCycleEdgeIds(["A", "B", "C", "A"], edges)).toEqual([
      "e-ab",
      "e-bc",
      "e-ca",
    ]);
  });

  test("returns an empty array for a missing cycle", () => {
    expect(getCycleEdgeIds(null, [createEdge("A", "B", "e-ab")])).toEqual([]);
  });
});
