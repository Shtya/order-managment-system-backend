export type CycleFlowNode = {
  id: string;
  data?: {
    label?: string;
  };
};

export type CycleFlowEdge = {
  id?: string;
  source: string;
  target: string;
};

export type CycleFlow = {
  nodes: CycleFlowNode[];
  edges: CycleFlowEdge[];
};

const hasCircularDependency = (flow: CycleFlow): boolean =>
  findCircularDependency(flow) !== null;

function findCircularDependency(flow: CycleFlow): string[] | null {
  const nodes = flow?.nodes || [];
  const edges = flow?.edges || [];
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    if (adjacency.has(edge.source) && adjacency.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const pathIndex = new Map<string, number>();

  for (const node of nodes) {
    state.set(node.id, 0);
  }

  function dfs(nodeId: string): string[] | null {
    state.set(nodeId, 1);
    pathIndex.set(nodeId, path.length);
    path.push(nodeId);

    for (const targetId of adjacency.get(nodeId) ?? []) {
      if (state.get(targetId) === 0) {
        const cycle = dfs(targetId);
        if (cycle) {
          return cycle;
        }
      } else if (state.get(targetId) === 1) {
        const startIndex = pathIndex.get(targetId)!;
        return [...path.slice(startIndex), targetId];
      }
    }

    path.pop();
    pathIndex.delete(nodeId);
    state.set(nodeId, 2);
    return null;
  }

  for (const node of nodes) {
    if (state.get(node.id) === 0) {
      const cycle = dfs(node.id);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}

function formatCyclePath(cycleIds: string[] | null, nodes: CycleFlowNode[], locale: string = 'ar'): string {
  if (!cycleIds?.length) {
    return "";
  }

  const labels = new Map(
    (nodes || []).map((node) => [node.id, node.data?.label?.trim() || node.id]),
  );

  const separator = locale === 'ar' ? " ← " : " → ";
  return cycleIds.map((id) => labels.get(id) || id).join(separator);
}

function getCycleEdgeIds(
  cycleIds: string[] | null,
  edges: CycleFlowEdge[],
): string[] {
  if (!cycleIds || cycleIds.length < 2) {
    return [];
  }

  const ids: string[] = [];
  for (let i = 0; i < cycleIds.length - 1; i++) {
    const source = cycleIds[i];
    const target = cycleIds[i + 1];
    for (const edge of edges || []) {
      if (edge.id && edge.source === source && edge.target === target) {
        ids.push(edge.id);
      }
    }
  }
  return ids;
}

export {
  hasCircularDependency,
  findCircularDependency,
  formatCyclePath,
  getCycleEdgeIds,
};
