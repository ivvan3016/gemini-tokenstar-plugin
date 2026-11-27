import type { StarNode } from './starLayout';

export interface ConstellationSegment {
  conversationId: string;
  date: string;
  from: StarNode;
  to: StarNode;
  fromIndex: number;
  toIndex: number;
  isBranch: boolean;
  tier: 'primary' | 'secondary';
}

interface IndexedNode {
  node: StarNode;
  index: number;
}

const TEMPORAL_WEIGHT_STRENGTH = 0.42;
const CROSS_EPS = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compareChronologicalItems(a: IndexedNode, b: IndexedNode): number {
  const convOrder = a.node.requestIndexInConv - b.node.requestIndexInConv;
  if (convOrder !== 0) return convOrder;
  return a.index - b.index;
}

function orient2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Return true if open segments (a1, a2) and (b1, b2) cross cleanly at an interior point.
 * Shared endpoints are allowed so tree branches may meet freely at vertices.
 */
function segmentsProperlyIntersect(
  a1: StarNode,
  a2: StarNode,
  b1: StarNode,
  b2: StarNode,
): boolean {
  if (
    a1.id === b1.id ||
    a1.id === b2.id ||
    a2.id === b1.id ||
    a2.id === b2.id
  ) {
    return false;
  }

  if (
    Math.max(a1.x, a2.x) < Math.min(b1.x, b2.x) - CROSS_EPS ||
    Math.max(b1.x, b2.x) < Math.min(a1.x, a2.x) - CROSS_EPS ||
    Math.max(a1.y, a2.y) < Math.min(b1.y, b2.y) - CROSS_EPS ||
    Math.max(b1.y, b2.y) < Math.min(a1.y, a2.y) - CROSS_EPS
  ) {
    return false;
  }

  const d1 = orient2d(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d2 = orient2d(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  const d3 = orient2d(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d4 = orient2d(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);

  return (
    ((d1 > CROSS_EPS && d2 < -CROSS_EPS) || (d1 < -CROSS_EPS && d2 > CROSS_EPS)) &&
    ((d3 > CROSS_EPS && d4 < -CROSS_EPS) || (d3 < -CROSS_EPS && d4 > CROSS_EPS))
  );
}

function edgeCost(ordered: IndexedNode[], i: number, j: number): number {
  const a = ordered[i].node;
  const b = ordered[j].node;
  const spatial = Math.hypot(a.x - b.x, a.y - b.y);
  const stepGap = Math.max(0, Math.abs(i - j) - 1);
  return spatial * (1 + TEMPORAL_WEIGHT_STRENGTH * Math.log1p(stepGap));
}

function edgeCrossesExisting(
  ordered: IndexedNode[],
  edges: Array<{ u: number; v: number }>,
  candU: number,
  candV: number,
): boolean {
  const a1 = ordered[candU].node;
  const a2 = ordered[candV].node;
  for (const e of edges) {
    if (segmentsProperlyIntersect(a1, a2, ordered[e.u].node, ordered[e.v].node)) {
      return true;
    }
  }
  return false;
}

/**
 * Build a crossing-free spanning tree guided softly by chronological adjacency
 * so constellations branch organically without sharp temporal zig-zags.
 */
function buildTimeWeightedMstEdges(
  items: IndexedNode[],
): { ordered: IndexedNode[]; edges: Array<{ u: number; v: number }> } {
  const ordered = [...items].sort(compareChronologicalItems);
  const count = ordered.length;
  if (count < 2) return { ordered, edges: [] };

  const inTree = new Array<boolean>(count).fill(false);
  const minCost = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const parent = new Array<number>(count).fill(-1);

  inTree[0] = true;
  for (let i = 1; i < count; i += 1) {
    minCost[i] = edgeCost(ordered, 0, i);
    parent[i] = 0;
  }

  const edges: Array<{ u: number; v: number }> = [];

  for (let step = 1; step < count; step += 1) {
    let bestV = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      if (!inTree[i] && minCost[i] < bestCost) {
        bestCost = minCost[i];
        bestV = i;
      }
    }
    if (bestV === -1) break;

    let chosenU = parent[bestV];
    let chosenV = bestV;

    // Temporal edge weighting can occasionally favor a crossing chord; reroute cleanly
    if (edgeCrossesExisting(ordered, edges, chosenU, chosenV)) {
      let altBestCost = Number.POSITIVE_INFINITY;
      let altU = -1;
      for (let treeU = 0; treeU < count; treeU += 1) {
        if (!inTree[treeU]) continue;
        const c = edgeCost(ordered, treeU, bestV);
        if (c < altBestCost && !edgeCrossesExisting(ordered, edges, treeU, bestV)) {
          altBestCost = c;
          altU = treeU;
        }
      }

      if (altU !== -1) {
        chosenU = altU;
      } else {
        let globalAltCost = Number.POSITIVE_INFINITY;
        let globalAltU = -1;
        let globalAltV = -1;
        for (let treeU = 0; treeU < count; treeU += 1) {
          if (!inTree[treeU]) continue;
          for (let outV = 0; outV < count; outV += 1) {
            if (inTree[outV]) continue;
            const c = edgeCost(ordered, treeU, outV);
            if (c < globalAltCost && !edgeCrossesExisting(ordered, edges, treeU, outV)) {
              globalAltCost = c;
              globalAltU = treeU;
              globalAltV = outV;
            }
          }
        }
        if (globalAltU !== -1 && globalAltV !== -1) {
          chosenU = globalAltU;
          chosenV = globalAltV;
        }
      }
    }

    inTree[chosenV] = true;
    edges.push({ u: chosenU, v: chosenV });

    for (let out = 0; out < count; out += 1) {
      if (inTree[out]) continue;
      const cost = edgeCost(ordered, chosenV, out);
      if (cost < minCost[out]) {
        minCost[out] = cost;
        parent[out] = chosenV;
      }
    }
  }

  return { ordered, edges };
}

function findClosestPair(
  groupA: IndexedNode[],
  groupB: IndexedNode[],
): { a: IndexedNode; b: IndexedNode; dist: number } | null {
  let bestA: IndexedNode | null = null;
  let bestB: IndexedNode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const itemA of groupA) {
    for (const itemB of groupB) {
      const spatial = Math.hypot(itemA.node.x - itemB.node.x, itemA.node.y - itemB.node.y);
      const temporalPenalty =
        1 + 0.25 * Math.log1p(Math.max(0, Math.abs(itemB.index - itemA.index) - 1));
      const causalPenalty = itemA.index <= itemB.index ? 1.0 : 1.25;
      const score = spatial * temporalPenalty * causalPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestA = itemA;
        bestB = itemB;
      }
    }
  }

  return bestA && bestB ? { a: bestA, b: bestB, dist: bestScore } : null;
}

function makeConstellationSegment(
  conversationId: string,
  a: IndexedNode,
  b: IndexedNode,
  isBranch: boolean,
  tier: 'primary' | 'secondary',
): ConstellationSegment {
  // Orient every segment forward in global chronological order for draw-on & sweep flow
  const [fromItem, toItem] = a.index <= b.index ? [a, b] : [b, a];
  return {
    conversationId,
    date: toItem.node.request.local_date || toItem.node.star.local_date,
    from: fromItem.node,
    to: toItem.node,
    fromIndex: fromItem.index,
    toIndex: toItem.index,
    isBranch,
    tier,
  };
}

/**
 * Build crossing-free astronomical constellation graphs per conversation using a
 * time-weighted Prim's Minimum Spanning Tree on ALL nodes first so MST topology
 * never jumps or rewires while scrubbing timeline playback.
 */
export function buildConstellationSegments(
  nodes: StarNode[],
  maxVisibleCount?: number,
): ConstellationSegment[] {
  if (nodes.length < 2) return [];

  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, nodes.length)
      : nodes.length;

  const byConv = new Map<string, IndexedNode[]>();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const convId = node.star.id;
    if (!convId) continue;
    let bucket = byConv.get(convId);
    if (!bucket) {
      bucket = [];
      byConv.set(convId, bucket);
    }
    bucket.push({ node, index: i });
  }

  const allSegments: ConstellationSegment[] = [];

  for (const [conversationId, list] of byConv.entries()) {
    if (list.length < 2) continue;

    const mainItems: IndexedNode[] = [];
    const subItemsBySession = new Map<string, IndexedNode[]>();

    for (const item of list) {
      if (!item.node.request.is_subagent) {
        mainItems.push(item);
      } else {
        const subKey = item.node.request.session_id || item.node.id;
        let subList = subItemsBySession.get(subKey);
        if (!subList) {
          subList = [];
          subItemsBySession.set(subKey, subList);
        }
        subList.push(item);
      }
    }

    // Main-thread time-weighted Prim MST spine
    if (mainItems.length >= 2) {
      const { ordered, edges } = buildTimeWeightedMstEdges(mainItems);
      const degrees = new Array<number>(ordered.length).fill(0);
      for (const e of edges) {
        degrees[e.u] += 1;
        degrees[e.v] += 1;
      }

      for (const e of edges) {
        const itemFrom = ordered[e.u];
        const itemTo = ordered[e.v];
        const bothBright =
          itemFrom.node.magnitude >= 0.45 && itemTo.node.magnitude >= 0.45;
        const bothSpine = degrees[e.u] >= 2 && degrees[e.v] >= 2;
        const tier: 'primary' | 'secondary' =
          ordered.length <= 3 || bothBright || bothSpine ? 'primary' : 'secondary';

        allSegments.push(
          makeConstellationSegment(conversationId, itemFrom, itemTo, false, tier),
        );
      }
    }

    // Subagent MST pockets bridged cleanly to temporally/spatially close parent anchor
    if (subItemsBySession.size > 0) {
      const anchorPool: IndexedNode[] = [...mainItems];

      for (const subList of subItemsBySession.values()) {
        if (subList.length >= 2) {
          const { ordered, edges } = buildTimeWeightedMstEdges(subList);
          for (const e of edges) {
            allSegments.push(
              makeConstellationSegment(
                conversationId,
                ordered[e.u],
                ordered[e.v],
                true,
                'secondary',
              ),
            );
          }
        }

        if (anchorPool.length > 0) {
          const bridge = findClosestPair(anchorPool, subList);
          if (bridge) {
            allSegments.push(
              makeConstellationSegment(
                conversationId,
                bridge.a,
                bridge.b,
                true,
                'secondary',
              ),
            );
          }
        }

        for (const s of subList) {
          anchorPool.push(s);
        }
      }
    }
  }

  if (limit === nodes.length) {
    return allSegments;
  }

  return allSegments.filter((seg) => seg.fromIndex < limit && seg.toIndex < limit);
}
