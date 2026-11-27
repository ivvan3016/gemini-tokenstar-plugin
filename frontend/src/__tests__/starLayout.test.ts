import { describe, expect, it } from 'vitest';
import type { ConversationStar, RequestStar } from '../types/sky';
import { buildConstellationSegments } from '../logic/constellations';
import {
  buildSubagentClusters,
  computeMagnitude,
  computeStarPositions,
  getModelSpectralColor,
} from '../logic/starLayout';

function makeRequest(overrides: Partial<RequestStar> = {}): RequestStar {
  return {
    id: 'conv-1:0',
    conversation_id: 'conv-1',
    session_id: 'conv-1',
    step_index: 0,
    turn_index: 1,
    created_at: '2026-01-01T10:00:00Z',
    local_date: '2026-01-01',
    model: 'gemini-2.5-pro',
    input_tokens: 2000,
    cache_read_tokens: 7000,
    output_tokens: 1000,
    total_tokens: 10000,
    non_cache_tokens: 3000,
    tool_calls_count: 1,
    subagent_calls_count: 0,
    status: 'COMPLETED',
    is_subagent: false,
    subagent_role: '',
    celestial_type: 'star',
    celestial_reason: '标准模型响应',
    ...overrides,
  };
}

function makeStar(
  id: string,
  started_at: string,
  total_tokens = 10_000,
  requests?: RequestStar[],
): ConversationStar {
  return {
    id,
    source: 'antigravity',
    title: `Title ${id}`,
    started_at,
    ended_at: started_at,
    local_date: started_at.slice(0, 10),
    primary_model: 'gemini-2.5-pro',
    models: [],
    input_tokens: Math.floor(total_tokens * 0.2),
    cache_read_tokens: Math.floor(total_tokens * 0.7),
    output_tokens: Math.floor(total_tokens * 0.1),
    total_tokens,
    non_cache_tokens: Math.floor(total_tokens * 0.3),
    user_turns: 2,
    model_steps_count: requests ? requests.length : 2,
    tool_calls_count: 1,
    subagent_calls_count: 0,
    subagents: [],
    is_orphan_subagent: false,
    error_steps_count: 0,
    last_status: 'COMPLETED',
    celestial_type: 'star',
    celestial_reason: '常规深度对话',
    requests,
  };
}

function makeBatchRequests(convId: string, baseDate: string, count: number): RequestStar[] {
  const list: RequestStar[] = [];
  for (let i = 0; i < count; i += 1) {
    const mins = String(Math.floor(i % 60)).padStart(2, '0');
    const hours = String(10 + Math.floor(i / 60)).padStart(2, '0');
    const isSub = i > 3 && i % 7 === 0;
    list.push(
      makeRequest({
        id: `${convId}:${i}`,
        conversation_id: convId,
        session_id: isSub ? `${convId}-sub-${Math.floor(i / 7)}` : convId,
        step_index: i,
        turn_index: i + 1,
        created_at: `${baseDate}T${hours}:${mins}:00Z`,
        local_date: baseDate,
        total_tokens: 2000 + (i % 9) * 8000,
        non_cache_tokens: 800 + (i % 5) * 1500,
        is_subagent: isSub,
        subagent_role: isSub ? 'explorer' : '',
        celestial_type: i % 5 === 0 ? 'pulsar' : 'star',
      }),
    );
  }
  return list;
}

describe('starLayout', () => {
  it('produces finite coordinates and deterministic output independent of input ordering', () => {
    const s1 = makeStar('alpha-uuid-001', '2026-01-01T10:00:00Z');
    const singleNodes = computeStarPositions([s1], 'total');
    expect(singleNodes).toHaveLength(1);
    expect(singleNodes[0].id).toBe('alpha-uuid-001:0');
    expect(Number.isFinite(singleNodes[0].x)).toBe(true);
    expect(Number.isFinite(singleNodes[0].y)).toBe(true);
    expect(Number.isFinite(singleNodes[0].convCenterX)).toBe(true);
    expect(singleNodes[0].convRadius).toBeGreaterThan(0);

    const s2 = makeStar('beta-uuid-002', '2026-01-02T10:00:00Z');
    const s3 = makeStar('gamma-uuid-003', '2026-01-03T10:00:00Z');

    const orderA = computeStarPositions([s1, s2, s3], 'total');
    const orderB = computeStarPositions([s3, s1, s2], 'total');
    expect(orderA.map((n) => ({ id: n.id, x: n.x, y: n.y, index: n.index }))).toEqual(
      orderB.map((n) => ({ id: n.id, x: n.x, y: n.y, index: n.index })),
    );
  });

  it('maintains intra-conversation minimum spacing with natural density variation', () => {
    const reqs = makeBatchRequests('dense-conv', '2026-02-10', 22);
    const conv = makeStar('dense-conv', '2026-02-10T10:00:00Z', 120_000, reqs);
    const nodes = computeStarPositions([conv], 'total');
    expect(nodes).toHaveLength(22);

    const nnDists: number[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      let minD = Number.POSITIVE_INFINITY;
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue;
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (d < minD) minD = d;
        expect(d).toBeGreaterThanOrEqual(42);
      }
      nnDists.push(minD);
    }

    // Density variation: widest nearest-neighbor separation differs noticeably from tightest pair
    const minNN = Math.min(...nnDists);
    const maxNN = Math.max(...nnDists);
    expect(maxNN).toBeGreaterThan(minNN * 1.15);
  });

  it('strictly prevents any overlap while keeping neighboring constellations compactly close', () => {
    const c1 = makeStar('conv-large-a', '2026-03-01T10:00:00Z', 300_000, makeBatchRequests('conv-large-a', '2026-03-01', 25));
    const c2 = makeStar('conv-large-b', '2026-03-01T10:05:00Z', 420_000, makeBatchRequests('conv-large-b', '2026-03-01', 40));
    const c3 = makeStar('conv-large-c', '2026-03-01T10:10:00Z', 180_000, makeBatchRequests('conv-large-c', '2026-03-01', 15));
    const c4 = makeStar('conv-single-d', '2026-03-01T10:15:00Z', 10_000);

    const nodes = computeStarPositions([c1, c2, c3, c4], 'total');
    expect(nodes).toHaveLength(25 + 40 + 15 + 1);

    // Every cross-conversation pair of stars must remain cleanly separated
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (nodes[i].star.id === nodes[j].star.id) continue;
        const starDist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        expect(starDist).toBeGreaterThanOrEqual(50);
      }
    }

    // Bounding circles of distinct conversations must never overlap and sit close to neighbors
    const clusters = new Map<string, { x: number; y: number; r: number }>();
    for (const n of nodes) {
      if (!clusters.has(n.star.id)) {
        clusters.set(n.star.id, { x: n.convCenterX, y: n.convCenterY, r: n.convRadius });
      }
    }
    const list = Array.from(clusters.values());
    let minEdgeGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const centerDist = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
        const edgeGap = centerDist - (list[i].r + list[j].r);
        expect(edgeGap).toBeGreaterThanOrEqual(0);
        if (edgeGap < minEdgeGap) minEdgeGap = edgeGap;
      }
    }
    expect(minEdgeGap).toBeLessThan(260);
  });

  it('test_logarithmic_magnitude_bounds_and_spectral_colors', () => {
    expect(computeMagnitude(100)).toBe(0.12);
    expect(computeMagnitude(10_000_000)).toBe(1.0);
    expect(computeMagnitude(100_000_000)).toBe(1.0);

    const proColor = getModelSpectralColor('gemini-2.5-pro');
    const hydrogenColor = getModelSpectralColor('gemini-4-hydrogen-xhigh');
    const neonColor = getModelSpectralColor('gemini-4-neon-high');
    const opusColor = getModelSpectralColor('claude-opus-5-5-high');
    const flashColor = getModelSpectralColor('gemini-2.5-flash');
    const flashLiteColor = getModelSpectralColor('gemini-2.5-flash-lite');
    const thinkingFlashColor = getModelSpectralColor('gemini-2.0-flash-thinking');

    expect(proColor).toBe('#92c2ff');
    expect(hydrogenColor).toBe('#78b2ff');
    expect(neonColor).toBe('#ffce73');
    expect(opusColor).toBe('#ffa054');
    expect(flashColor).toBe('#fff3d6');
    expect(thinkingFlashColor).toBe('#8de2ec');
    expect(flashLiteColor).toBe('#dcebff');
    expect(proColor).not.toBe(flashColor);

    const unknown1 = getModelSpectralColor('custom-experimental-model');
    const unknown2 = getModelSpectralColor('custom-experimental-model');
    expect(unknown1).toBe(unknown2);
    expect([
      '#78b2ff',
      '#ffdc84',
      '#ffa458',
      '#98c8ff',
      '#ff744c',
      '#fff3d6',
      '#8de2ec',
    ]).toContain(unknown1);

    // Relative + nonlinear token contrast clearly separates small vs giant requests
    const contrastReqs = [
      makeRequest({
        id: 'contrast:low',
        created_at: '2026-04-01T10:00:00Z',
        total_tokens: 2_000,
        non_cache_tokens: 1_000,
      }),
      makeRequest({
        id: 'contrast:mid',
        created_at: '2026-04-01T10:01:00Z',
        total_tokens: 45_000,
        non_cache_tokens: 12_000,
      }),
      makeRequest({
        id: 'contrast:high',
        created_at: '2026-04-01T10:02:00Z',
        total_tokens: 500_000,
        non_cache_tokens: 240_000,
      }),
    ];
    const contrastNodes = computeStarPositions(
      [makeStar('contrast-conv', '2026-04-01T10:00:00Z', 547_000, contrastReqs)],
      'total',
    );
    const lowNode = contrastNodes.find((n) => n.id === 'contrast:low')!;
    const highNode = contrastNodes.find((n) => n.id === 'contrast:high')!;
    expect(highNode.magnitude - lowNode.magnitude).toBeGreaterThanOrEqual(0.45);
    expect(highNode.radius).toBeGreaterThanOrEqual(lowNode.radius * 2.5);

    // Stars sharing one model display realistic O-B-A-F-G-K-M blackbody color diversity
    const monoReqs = Array.from({ length: 24 }, (_, idx) =>
      makeRequest({
        id: `mono:${idx}`,
        step_index: idx,
        turn_index: idx + 1,
        created_at: `2026-04-02T10:${String(idx).padStart(2, '0')}:00Z`,
        model: 'gemini-4-hydrogen-xhigh',
        total_tokens: 8_000 + idx * 18_000,
      }),
    );
    const monoNodes = computeStarPositions(
      [makeStar('mono-conv', '2026-04-02T10:00:00Z', 500_000, monoReqs)],
      'total',
    );
    const uniqueColors = new Set(monoNodes.map((n) => n.color));
    expect(uniqueColors.size).toBeGreaterThanOrEqual(4);
  });

  it('builds one independent SubagentCluster per subagent session and keeps orphan subagents as normal stars', () => {
    const convWithSubs = makeStar(
      'conv-sub-multi',
      '2026-05-01T10:00:00Z',
      200_000,
      [
        makeRequest({
          id: 'conv-sub-multi:0',
          conversation_id: 'conv-sub-multi',
          session_id: 'conv-sub-multi',
          step_index: 0,
          created_at: '2026-05-01T10:00:00Z',
          local_date: '2026-05-01',
        }),
        makeRequest({
          id: 'conv-sub-multi:1',
          conversation_id: 'conv-sub-multi',
          session_id: 'conv-sub-multi',
          step_index: 1,
          created_at: '2026-05-01T10:01:00Z',
          local_date: '2026-05-01',
        }),
        makeRequest({
          id: 'sub-alpha:0',
          conversation_id: 'conv-sub-multi',
          session_id: 'sub-alpha',
          step_index: 0,
          created_at: '2026-05-01T10:01:10Z',
          local_date: '2026-05-01',
          model: 'gemini-2.5-flash',
          total_tokens: 18_000,
          non_cache_tokens: 6_000,
          is_subagent: true,
          subagent_role: 'explorer',
          parent_session_id: 'conv-sub-multi',
          parent_request_id: 'conv-sub-multi:1',
        }),
        makeRequest({
          id: 'sub-alpha:1',
          conversation_id: 'conv-sub-multi',
          session_id: 'sub-alpha',
          step_index: 1,
          created_at: '2026-05-01T10:01:30Z',
          local_date: '2026-05-01',
          model: 'gemini-2.5-flash',
          total_tokens: 22_000,
          non_cache_tokens: 8_000,
          is_subagent: true,
          subagent_role: 'explorer',
        }),
        makeRequest({
          id: 'sub-beta:0',
          conversation_id: 'conv-sub-multi',
          session_id: 'sub-beta',
          step_index: 0,
          created_at: '2026-05-01T10:02:10Z',
          local_date: '2026-05-01',
          model: 'claude-opus-4',
          total_tokens: 30_000,
          non_cache_tokens: 10_000,
          is_subagent: true,
          subagent_role: 'verifier',
          parent_session_id: 'conv-sub-multi',
          parent_request_id: 'conv-sub-multi:1',
        }),
        makeRequest({
          id: 'conv-sub-multi:2',
          conversation_id: 'conv-sub-multi',
          session_id: 'conv-sub-multi',
          step_index: 2,
          created_at: '2026-05-01T10:03:00Z',
          local_date: '2026-05-01',
        }),
      ],
    );
    convWithSubs.subagents = [
      {
        id: 'sub-alpha',
        role: 'Explorer',
        type_name: 'search',
        primary_model: 'gemini-2.5-flash',
        input_tokens: 10_000,
        cache_read_tokens: 26_000,
        output_tokens: 4_000,
        total_tokens: 40_000,
        non_cache_tokens: 14_000,
        last_status: 'COMPLETED',
        parent_session_id: 'conv-sub-multi',
        parent_request_id: 'conv-sub-multi:1',
        request_count: 2,
        started_at: '2026-05-01T10:01:10Z',
        ended_at: '2026-05-01T10:01:30Z',
      },
      {
        id: 'sub-beta',
        role: 'Verifier',
        type_name: 'qa',
        primary_model: 'claude-opus-4',
        input_tokens: 7_000,
        cache_read_tokens: 20_000,
        output_tokens: 3_000,
        total_tokens: 30_000,
        non_cache_tokens: 10_000,
        last_status: 'COMPLETED',
        parent_session_id: 'conv-sub-multi',
        parent_request_id: 'conv-sub-multi:1',
        request_count: 1,
        started_at: '2026-05-01T10:02:10Z',
        ended_at: '2026-05-01T10:02:10Z',
      },
    ];

    const orphanConv = makeStar(
      'conv-orphan',
      '2026-05-01T11:00:00Z',
      50_000,
      [
        makeRequest({
          id: 'conv-orphan:0',
          conversation_id: 'conv-orphan',
          session_id: 'conv-orphan',
          step_index: 0,
          created_at: '2026-05-01T11:00:00Z',
          local_date: '2026-05-01',
          is_subagent: true,
          subagent_role: 'orphan',
        }),
        makeRequest({
          id: 'conv-orphan:1',
          conversation_id: 'conv-orphan',
          session_id: 'conv-orphan',
          step_index: 1,
          created_at: '2026-05-01T11:01:00Z',
          local_date: '2026-05-01',
          is_subagent: true,
          subagent_role: 'orphan',
        }),
      ],
    );
    orphanConv.is_orphan_subagent = true;

    const nodes = computeStarPositions([convWithSubs, orphanConv], 'total');
    const clusters = buildSubagentClusters(nodes, 'total');
    const nonCacheClusters = buildSubagentClusters(nodes, 'non_cache');

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.id)).toEqual([
      'subcluster:conv-sub-multi:sub-alpha',
      'subcluster:conv-sub-multi:sub-beta',
    ]);

    const alpha = clusters[0];
    expect(alpha.sessionId).toBe('sub-alpha');
    expect(alpha.conversationId).toBe('conv-sub-multi');
    expect(alpha.parentSessionId).toBe('conv-sub-multi');
    expect(alpha.parentRequestId).toBe('conv-sub-multi:1');
    expect(alpha.parentNodeId).toBe('conv-sub-multi:1');
    expect(alpha.role).toBe('Explorer');
    expect(alpha.typeName).toBe('search');
    expect(alpha.primaryModel).toBe('gemini-2.5-flash');
    expect(alpha.requestCount).toBe(2);
    expect(alpha.totalTokens).toBe(40_000);
    expect(alpha.nonCacheTokens).toBe(14_000);
    expect(alpha.effectiveTokens).toBe(40_000);
    expect(alpha.memberIds).toEqual(['sub-alpha:0', 'sub-alpha:1']);
    expect(alpha.memberNodes).toHaveLength(2);
    expect(alpha.firstNodeIndex).toBeLessThan(alpha.lastNodeIndex);
    expect(alpha.clusterRadius).toBeGreaterThanOrEqual(4.6);
    expect(alpha.clusterRadius).toBeLessThanOrEqual(11.2);
    expect(alpha.color).toMatch(/^#[0-9a-f]{6}$/i);

    const parentNode = nodes.find((n) => n.id === 'conv-sub-multi:1')!;
    expect(Math.hypot(alpha.anchorX - parentNode.x, alpha.anchorY - parentNode.y)).toBeGreaterThanOrEqual(64 - 1e-6);
    for (const member of alpha.memberNodes) {
      expect(member.x).toBeGreaterThanOrEqual(alpha.streamBounds.minX);
      expect(member.x).toBeLessThanOrEqual(alpha.streamBounds.maxX);
      expect(member.y).toBeGreaterThanOrEqual(alpha.streamBounds.minY);
      expect(member.y).toBeLessThanOrEqual(alpha.streamBounds.maxY);
      expect(member.isCompanionMicroStar).toBe(true);
      expect(member.subagentClusterId).toBe('subcluster:conv-sub-multi:sub-alpha');
    }

    expect(nonCacheClusters[0].effectiveTokens).toBe(14_000);
    expect(nonCacheClusters[0].magnitude).toBe(computeMagnitude(14_000));

    // Main nodes and orphan subagent conversation nodes remain non-clustered normal stars
    for (const node of nodes.filter((n) => n.star.id === 'conv-orphan')) {
      expect(node.isCompanionMicroStar).toBe(false);
      expect(node.subagentClusterId).toBeNull();
    }
    const orphanSegments = buildConstellationSegments(nodes).filter((s) => s.conversationId === 'conv-orphan');
    expect(orphanSegments).toHaveLength(1);
    expect(orphanSegments[0].kind).toBe('main');
    expect(orphanSegments[0].isBranch).toBe(false);
    expect(orphanSegments[0].subagentClusterId).toBeNull();
  });

  it('fans parallel sibling subagents cleanly apart and bridges exact parent_request_id & parent_session_id', () => {
    const reqs: RequestStar[] = [
      makeRequest({
        id: 'conv-par:0',
        conversation_id: 'conv-par',
        session_id: 'conv-par',
        step_index: 0,
        created_at: '2026-05-02T10:00:00Z',
        local_date: '2026-05-02',
      }),
      makeRequest({
        id: 'conv-par:1',
        conversation_id: 'conv-par',
        session_id: 'conv-par',
        step_index: 1,
        created_at: '2026-05-02T10:01:00Z',
        local_date: '2026-05-02',
      }),
      makeRequest({
        id: 'conv-par:2',
        conversation_id: 'conv-par',
        session_id: 'conv-par',
        step_index: 2,
        created_at: '2026-05-02T10:05:00Z',
        local_date: '2026-05-02',
      }),
      makeRequest({
        id: 'conv-par:3',
        conversation_id: 'conv-par',
        session_id: 'conv-par',
        step_index: 3,
        created_at: '2026-05-02T10:08:00Z',
        local_date: '2026-05-02',
      }),
    ];

    // Four parallel siblings all spawned from exact parent_request_id 'conv-par:1'
    for (let s = 1; s <= 4; s += 1) {
      const subId = `par-sub-${s}`;
      for (let step = 0; step < 3; step += 1) {
        reqs.push(
          makeRequest({
            id: `${subId}:${step}`,
            conversation_id: 'conv-par',
            session_id: subId,
            step_index: step,
            created_at: `2026-05-02T10:0${1 + step}:${String(s * 10).padStart(2, '0')}Z`,
            local_date: '2026-05-02',
            is_subagent: true,
            subagent_role: `worker-${s}`,
            parent_session_id: 'conv-par',
            parent_request_id: 'conv-par:1',
          }),
        );
      }
    }

    // One subagent referencing only parent_session_id after conv-par:2
    reqs.push(
      makeRequest({
        id: 'sess-sub:0',
        conversation_id: 'conv-par',
        session_id: 'sess-sub',
        step_index: 0,
        created_at: '2026-05-02T10:06:00Z',
        local_date: '2026-05-02',
        is_subagent: true,
        subagent_role: 'summarizer',
        parent_session_id: 'conv-par',
      }),
    );

    // One nested subagent spawned from par-sub-2:1
    reqs.push(
      makeRequest({
        id: 'nested-sub:0',
        conversation_id: 'conv-par',
        session_id: 'nested-sub',
        step_index: 0,
        created_at: '2026-05-02T10:07:00Z',
        local_date: '2026-05-02',
        is_subagent: true,
        subagent_role: 'nested',
        parent_session_id: 'par-sub-2',
        parent_request_id: 'par-sub-2:1',
      }),
    );

    const conv = makeStar('conv-par', '2026-05-02T10:00:00Z', 300_000, reqs);
    const nodes = computeStarPositions([conv], 'total');
    const clusters = buildSubagentClusters(nodes, 'total');
    const segments = buildConstellationSegments(nodes);

    // Intra-conversation minimum distance invariant still holds across all 18 nodes
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        expect(d).toBeGreaterThanOrEqual(42);
      }
    }

    expect(clusters).toHaveLength(6);
    const parallelClusters = clusters.filter((c) => c.sessionId.startsWith('par-sub-'));
    expect(parallelClusters).toHaveLength(4);
    expect(parallelClusters.every((c) => c.parentNodeId === 'conv-par:1')).toBe(true);

    // Sibling outward angles from conv-par:1 fan cleanly apart
    const parent1 = nodes.find((n) => n.id === 'conv-par:1')!;
    const headAngles = parallelClusters.map((c) => {
      const head = c.memberNodes[0];
      return Math.atan2(head.y - parent1.y, head.x - parent1.x);
    });
    for (let i = 0; i < headAngles.length; i += 1) {
      for (let j = i + 1; j < headAngles.length; j += 1) {
        const diff = Math.abs(
          Math.atan2(
            Math.sin(headAngles[i] - headAngles[j]),
            Math.cos(headAngles[i] - headAngles[j]),
          ),
        );
        expect(diff).toBeGreaterThan(0.28);
      }
    }

    // Exact bridge checks
    const bridges = segments.filter((s) => s.kind === 'subagent_bridge');
    expect(bridges).toHaveLength(6);
    for (let s = 1; s <= 4; s += 1) {
      const bridge = bridges.find((b) => b.subagentClusterId === `subcluster:conv-par:par-sub-${s}`);
      expect(bridge).toBeDefined();
      expect(bridge!.isBranch).toBe(true);
      expect(bridge!.from.id).toBe('conv-par:1');
      expect(bridge!.to.id).toBe(`par-sub-${s}:0`);
    }

    const sessBridge = bridges.find((b) => b.subagentClusterId === 'subcluster:conv-par:sess-sub');
    expect(sessBridge?.from.id).toBe('conv-par:2');
    expect(sessBridge?.to.id).toBe('sess-sub:0');

    const nestedBridge = bridges.find((b) => b.subagentClusterId === 'subcluster:conv-par:nested-sub');
    expect(nestedBridge?.from.id).toBe('par-sub-2:1');
    expect(nestedBridge?.to.id).toBe('nested-sub:0');

    const streamSegs = segments.filter((s) => s.kind === 'subagent_stream');
    expect(streamSegs).toHaveLength(8);
    expect(streamSegs.every((s) => s.isBranch && Boolean(s.subagentClusterId))).toBe(true);

    const mainSegs = segments.filter((s) => s.kind === 'main');
    expect(mainSegs).toHaveLength(3);
    expect(mainSegs.every((s) => !s.isBranch && s.subagentClusterId === null)).toBe(true);
  });

  it('expands a 14-request subagent session as a near-circular globular cluster while preserving spacing invariants', () => {
    const reqs: RequestStar[] = [
      makeRequest({
        id: 'conv-round:0',
        conversation_id: 'conv-round',
        session_id: 'conv-round',
        step_index: 0,
        created_at: '2026-05-03T10:00:00Z',
        local_date: '2026-05-03',
      }),
      makeRequest({
        id: 'conv-round:1',
        conversation_id: 'conv-round',
        session_id: 'conv-round',
        step_index: 1,
        created_at: '2026-05-03T10:01:00Z',
        local_date: '2026-05-03',
      }),
      ...Array.from({ length: 14 }, (_, k) =>
        makeRequest({
          id: `sub-round:${k}`,
          conversation_id: 'conv-round',
          session_id: 'sub-round',
          step_index: k,
          created_at: `2026-05-03T10:02:${String(k).padStart(2, '0')}Z`,
          local_date: '2026-05-03',
          model: 'gemini-2.5-flash',
          total_tokens: 14_000 + k * 1_500,
          non_cache_tokens: 4_000 + k * 500,
          is_subagent: true,
          subagent_role: 'explorer',
          parent_session_id: 'conv-round',
          parent_request_id: 'conv-round:1',
        }),
      ),
    ];

    const conv = makeStar('conv-round', '2026-05-03T10:00:00Z', 400_000, reqs);
    const nodes = computeStarPositions([conv], 'total');
    const clusters = buildSubagentClusters(nodes, 'total');
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.memberNodes).toHaveLength(14);

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        expect(d).toBeGreaterThanOrEqual(42);
      }
    }

    const spanX = cluster.streamBounds.maxX - cluster.streamBounds.minX;
    const spanY = cluster.streamBounds.maxY - cluster.streamBounds.minY;
    expect(Math.max(spanX, spanY)).toBeGreaterThan(0);
    expect(Math.min(spanX, spanY) / Math.max(spanX, spanY)).toBeGreaterThanOrEqual(0.55);

    const meanX = cluster.memberNodes.reduce((acc, m) => acc + m.x, 0) / cluster.memberNodes.length;
    const meanY = cluster.memberNodes.reduce((acc, m) => acc + m.y, 0) / cluster.memberNodes.length;
    expect(cluster.anchorX).toBeCloseTo(meanX, 5);
    expect(cluster.anchorY).toBeCloseTo(meanY, 5);
  });
});
