import { describe, expect, it } from 'vitest';
import type { ConversationStar, RequestStar } from '../types/sky';
import {
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
});
