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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildPrimMstEdges(items: IndexedNode[]): Array<{ u: number; v: number }> {
  const count = items.length;
  if (count < 2) return [];

  const inTree = new Array<boolean>(count).fill(false);
  const minDist = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const parent = new Array<number>(count).fill(-1);

  minDist[0] = 0;
  const edges: Array<{ u: number; v: number }> = [];

  for (let step = 0; step < count; step += 1) {
    let bestV = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      if (!inTree[i] && minDist[i] < bestD) {
        bestD = minDist[i];
        bestV = i;
      }
    }
    if (bestV === -1) break;

    inTree[bestV] = true;
    if (parent[bestV] !== -1) {
      edges.push({ u: parent[bestV], v: bestV });
    }

    const vNode = items[bestV].node;
    for (let u = 0; u < count; u += 1) {
      if (inTree[u]) continue;
      const uNode = items[u].node;
      const dist = Math.hypot(uNode.x - vNode.x, uNode.y - vNode.y);
      if (dist < minDist[u]) {
        minDist[u] = dist;
        parent[u] = bestV;
      }
    }
  }

  return edges;
}

function findClosestPair(
  groupA: IndexedNode[],
  groupB: IndexedNode[],
): { a: IndexedNode; b: IndexedNode; dist: number } | null {
  let bestA: IndexedNode | null = null;
  let bestB: IndexedNode | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const itemA of groupA) {
    for (const itemB of groupB) {
      const d = Math.hypot(itemA.node.x - itemB.node.x, itemA.node.y - itemB.node.y);
      if (d < bestDist) {
        bestDist = d;
        bestA = itemA;
        bestB = itemB;
      }
    }
  }

  return bestA && bestB ? { a: bestA, b: bestB, dist: bestDist } : null;
}

/**
 * Build crossing-free astronomical constellation graphs per conversation using
 * Euclidean Prim's Minimum Spanning Tree on ALL nodes first so MST topology never
 * jumps or rewires while scrubbing timeline playback.
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

    // Main-thread Prim MST spine
    if (mainItems.length >= 2) {
      const mainEdges = buildPrimMstEdges(mainItems);
      const degrees = new Array<number>(mainItems.length).fill(0);
      for (const e of mainEdges) {
        degrees[e.u] += 1;
        degrees[e.v] += 1;
      }

      for (const e of mainEdges) {
        const itemFrom = mainItems[e.u];
        const itemTo = mainItems[e.v];
        const bothBright =
          itemFrom.node.magnitude >= 0.45 && itemTo.node.magnitude >= 0.45;
        const bothSpine = degrees[e.u] >= 2 && degrees[e.v] >= 2;
        const tier: 'primary' | 'secondary' =
          mainItems.length <= 3 || bothBright || bothSpine ? 'primary' : 'secondary';

        allSegments.push({
          conversationId,
          date: itemTo.node.star.local_date,
          from: itemFrom.node,
          to: itemTo.node,
          fromIndex: itemFrom.index,
          toIndex: itemTo.index,
          isBranch: false,
          tier,
        });
      }
    }

    // Subagent MST pockets bridged cleanly to closest main-thread anchor (or sibling session)
    if (subItemsBySession.size > 0) {
      const anchorPool: IndexedNode[] = [...mainItems];

      for (const subList of subItemsBySession.values()) {
        if (subList.length >= 2) {
          const subEdges = buildPrimMstEdges(subList);
          for (const e of subEdges) {
            const itemFrom = subList[e.u];
            const itemTo = subList[e.v];
            allSegments.push({
              conversationId,
              date: itemTo.node.star.local_date,
              from: itemFrom.node,
              to: itemTo.node,
              fromIndex: itemFrom.index,
              toIndex: itemTo.index,
              isBranch: true,
              tier: 'secondary',
            });
          }
        }

        if (anchorPool.length > 0) {
          const bridge = findClosestPair(anchorPool, subList);
          if (bridge) {
            allSegments.push({
              conversationId,
              date: bridge.b.node.star.local_date,
              from: bridge.a.node,
              to: bridge.b.node,
              fromIndex: bridge.a.index,
              toIndex: bridge.b.index,
              isBranch: true,
              tier: 'secondary',
            });
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
