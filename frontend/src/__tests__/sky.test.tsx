import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationStar, RequestStar } from '../types/sky';
import { buildSubagentClusters, computeStarPositions } from '../logic/starLayout';
import {
  AUTO_COLLAPSE_ZOOM,
  AUTO_EXPAND_ZOOM,
  StarCanvas,
  buildConstellationSegments,
  computeDeepOut,
  computeFitCamera,
  exportSkyPng,
  generateBackgroundDust,
  getVisualScale,
  hitTestCluster,
  hitTestStar,
  screenToWorld,
  worldToScreen,
  type CameraState,
} from '../components/sky/StarCanvas';
import {
  WebGLSkyRenderer,
  computeDeepOut as computeDeepOutFromWebGL,
} from '../components/sky/webglSkyRenderer';
import { DetailDrawer } from '../components/sky/DetailDrawer';
import { PlaybackBar } from '../components/sky/PlaybackBar';
import { SkyTab, computePlaybackBaseRate } from '../components/sky/SkyTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeStar(overrides: Partial<ConversationStar> = {}): ConversationStar {
  const input = overrides.input_tokens ?? 1000;
  const cache = overrides.cache_read_tokens ?? 4000;
  const output = overrides.output_tokens ?? 500;
  return {
    id: 'star-alpha-1',
    source: 'antigravity',
    title: 'Confidential Refactoring Plan',
    started_at: '2026-06-15T09:00:00Z',
    ended_at: '2026-06-15T09:20:00Z',
    local_date: '2026-06-15',
    primary_model: 'gemini-2.5-pro',
    models: [
      {
        model: 'gemini-2.5-pro',
        input_tokens: input,
        cache_read_tokens: cache,
        output_tokens: output,
        total_tokens: input + cache + output,
        steps: 4,
      },
    ],
    input_tokens: input,
    cache_read_tokens: cache,
    output_tokens: output,
    total_tokens: overrides.total_tokens ?? input + cache + output,
    non_cache_tokens: overrides.non_cache_tokens ?? input + output,
    user_turns: 3,
    model_steps_count: 4,
    tool_calls_count: 6,
    subagent_calls_count: 0,
    subagents: [],
    is_orphan_subagent: false,
    error_steps_count: 0,
    last_status: 'COMPLETED',
    celestial_type: 'star',
    celestial_reason: '常规深度对话（3 轮交互）',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RequestStar> = {}): RequestStar {
  return {
    id: 'star-alpha-1:0',
    conversation_id: 'star-alpha-1',
    session_id: 'star-alpha-1',
    step_index: 0,
    turn_index: 1,
    created_at: '2026-06-15T09:00:00Z',
    local_date: '2026-06-15',
    model: 'gemini-2.5-pro',
    input_tokens: 400,
    cache_read_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1600,
    non_cache_tokens: 600,
    tool_calls_count: 1,
    subagent_calls_count: 0,
    status: 'COMPLETED',
    is_subagent: false,
    subagent_role: '',
    celestial_type: 'star',
    celestial_reason: '常规深度响应',
    ...overrides,
  };
}

function makeMockCanvasContext() {
  const gradientStub = {
    addColorStop: vi.fn(),
  };
  return {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 80 })),
    createRadialGradient: vi.fn(
      (_x0?: number, _y0?: number, _r0?: number, _x1?: number, _y1?: number, _r1?: number) =>
        gradientStub,
    ),
    createLinearGradient: vi.fn(() => gradientStub),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
}

describe('StarCanvas pure geometry & exportSkyPng', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates deterministic dust stars within 180-260 and builds Prim MST intra-conversation constellations', () => {
    const dustA = generateBackgroundDust();
    const dustB = generateBackgroundDust();
    expect(dustA.length).toBeGreaterThanOrEqual(180);
    expect(dustA.length).toBeLessThanOrEqual(260);
    expect(dustA).toEqual(dustB);
    expect(dustA.every((d) => d.xNorm >= 0 && d.xNorm <= 1 && d.yNorm >= 0 && d.yNorm <= 1)).toBe(true);

    // Separate single-request conversations on the same calendar day must NOT link together
    const s1 = makeStar({ id: 'd1-a', started_at: '2026-06-15T08:00:00Z', local_date: '2026-06-15' });
    const s2 = makeStar({ id: 'd1-b', started_at: '2026-06-15T12:00:00Z', local_date: '2026-06-15' });
    const singleNodes = computeStarPositions([s2, s1], 'total');
    expect(buildConstellationSegments(singleNodes)).toHaveLength(0);

    // Multi-request conversation connects 3 main stars + 2 subagent stars via Prim's MST (5 - 1 = 4 edges)
    const convMulti = makeStar({
      id: 'conv-multi',
      started_at: '2026-06-15T09:00:00Z',
      local_date: '2026-06-15',
      requests: [
        makeRequest({
          id: 'conv-multi:0',
          conversation_id: 'conv-multi',
          step_index: 0,
          created_at: '2026-06-15T09:00:00Z',
          celestial_type: 'star',
        }),
        makeRequest({
          id: 'conv-multi:1',
          conversation_id: 'conv-multi',
          step_index: 1,
          created_at: '2026-06-15T09:02:00Z',
          celestial_type: 'pulsar',
        }),
        makeRequest({
          id: 'conv-multi:2',
          conversation_id: 'conv-multi',
          step_index: 2,
          created_at: '2026-06-15T09:03:00Z',
          celestial_type: 'star',
        }),
        makeRequest({
          id: 'sub-1:0',
          conversation_id: 'conv-multi',
          session_id: 'sub-1',
          step_index: 0,
          created_at: '2026-06-15T09:04:00Z',
          is_subagent: true,
          subagent_role: 'research',
          celestial_type: 'binary',
        }),
        makeRequest({
          id: 'sub-1:1',
          conversation_id: 'conv-multi',
          session_id: 'sub-1',
          step_index: 1,
          created_at: '2026-06-15T09:05:00Z',
          is_subagent: true,
          subagent_role: 'research',
          celestial_type: 'star',
        }),
      ],
    });

    const nodes = computeStarPositions([convMulti], 'total');
    const segments = buildConstellationSegments(nodes);
    expect(segments).toHaveLength(4);
    expect(segments.every((s) => s.conversationId === 'conv-multi')).toBe(true);
    expect(segments.filter((s) => !s.isBranch)).toHaveLength(2);
    expect(segments.filter((s) => s.isBranch)).toHaveLength(2);

    // Playback limit reveals constellation edges progressively without altering MST structure
    expect(buildConstellationSegments(nodes, 1)).toHaveLength(0);
    expect(buildConstellationSegments(nodes, 5)).toHaveLength(4);
  });

  it('builds crossing-free, temporally coherent constellations with forward-time orientation across morphologies', () => {
    const properlyCrosses = (
      a1: { x: number; y: number; id: string },
      a2: { x: number; y: number; id: string },
      b1: { x: number; y: number; id: string },
      b2: { x: number; y: number; id: string },
    ) => {
      if (a1.id === b1.id || a1.id === b2.id || a2.id === b1.id || a2.id === b2.id) {
        return false;
      }
      const cross = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
        (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      const d1 = cross(a1, a2, b1);
      const d2 = cross(a1, a2, b2);
      const d3 = cross(b1, b2, a1);
      const d4 = cross(b1, b2, a2);
      return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) &&
        ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
    };

    const convIds = ['morph-alpha-1', 'morph-beta-2', 'morph-gamma-3', 'morph-delta-4', 'morph-epsilon-5', 'morph-zeta-6'];
    const convs = convIds.map((id, cIdx) => {
      const count = 20;
      const reqs: RequestStar[] = Array.from({ length: count }, (_, i) =>
        makeRequest({
          id: `${id}:${i}`,
          conversation_id: id,
          session_id: id,
          step_index: i,
          turn_index: i + 1,
          created_at: `2026-06-${String(10 + cIdx).padStart(2, '0')}T10:${String(i).padStart(2, '0')}:00Z`,
          local_date: `2026-06-${String(10 + cIdx).padStart(2, '0')}`,
          total_tokens: 4_000 + ((i * 3) % 7) * 12_000,
        }),
      );
      return makeStar({
        id,
        started_at: `2026-06-${String(10 + cIdx).padStart(2, '0')}T10:00:00Z`,
        ended_at: `2026-06-${String(10 + cIdx).padStart(2, '0')}T10:19:00Z`,
        local_date: `2026-06-${String(10 + cIdx).padStart(2, '0')}`,
        model_steps_count: count,
        requests: reqs,
      });
    });

    const nodes = computeStarPositions(convs, 'total');
    const allSegments = buildConstellationSegments(nodes);
    let anyBranchJumpOrFork = false;

    for (const id of convIds) {
      const segs = allSegments.filter((s) => s.conversationId === id);
      expect(segs).toHaveLength(19);

      // Every segment flows forward chronologically
      expect(segs.every((s) => s.fromIndex < s.toIndex)).toBe(true);

      // Verify connectivity (V - 1 edges spanning all 20 nodes)
      const adj = new Map<string, string[]>();
      for (const s of segs) {
        adj.set(s.from.id, [...(adj.get(s.from.id) ?? []), s.to.id]);
        adj.set(s.to.id, [...(adj.get(s.to.id) ?? []), s.from.id]);
        if (Math.abs(s.to.requestIndexInConv - s.from.requestIndexInConv) > 1) {
          anyBranchJumpOrFork = true;
        }
      }
      for (const neighbors of adj.values()) {
        if (neighbors.length >= 3) anyBranchJumpOrFork = true;
      }
      const seen = new Set<string>([`${id}:0`]);
      const queue = [`${id}:0`];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const nxt of adj.get(cur) ?? []) {
          if (!seen.has(nxt)) {
            seen.add(nxt);
            queue.push(nxt);
          }
        }
      }
      expect(seen.size).toBe(20);

      // Zero proper intersections among main-thread segments
      for (let i = 0; i < segs.length; i += 1) {
        for (let j = i + 1; j < segs.length; j += 1) {
          expect(properlyCrosses(segs[i].from, segs[i].to, segs[j].from, segs[j].to)).toBe(false);
        }
      }

      // Average chronological step delta remains strongly coherent without forcing a linear chain
      const avgDelta =
        segs.reduce((acc, s) => acc + Math.abs(s.to.requestIndexInConv - s.from.requestIndexInConv), 0) /
        segs.length;
      expect(avgDelta).toBeLessThan(4.0);
    }

    expect(anyBranchJumpOrFork).toBe(true);

    // Playback speed helper scales gently and runs calmer than legacy 2.4 / (n/18)
    expect(computePlaybackBaseRate(0)).toBe(0);
    expect(computePlaybackBaseRate(-5)).toBe(0);
    expect(computePlaybackBaseRate(20)).toBeCloseTo(1.3, 5);
    expect(computePlaybackBaseRate(170)).toBeCloseTo(5.0, 5);
  });

  it('computes fit camera, coordinate roundtrips, and hit testing accurately', () => {
    const emptyCam = computeFitCamera([], 1000, 600);
    expect(Number.isFinite(emptyCam.x)).toBe(true);
    expect(emptyCam.zoom).toBeGreaterThan(0);

    const s1 = makeStar({ id: 'hit-1', started_at: '2026-06-15T08:00:00Z' });
    const s2 = makeStar({ id: 'hit-2', started_at: '2026-06-16T08:00:00Z' });
    const nodes = computeStarPositions([s1, s2], 'total');
    const cam: CameraState = computeFitCamera(nodes, 1200, 720);

    const screen = worldToScreen(nodes[0].x, nodes[0].y, cam, 1200, 720);
    const back = screenToWorld(screen.x, screen.y, cam, 1200, 720);
    expect(back.x).toBeCloseTo(nodes[0].x, 6);
    expect(back.y).toBeCloseTo(nodes[0].y, 6);

    const hit = hitTestStar(nodes, screen.x + 2, screen.y - 2, cam, 1200, 720);
    expect(hit?.star.id).toBe('hit-1');

    // Hidden during playback (visibleCount = 0)
    expect(hitTestStar(nodes, screen.x, screen.y, cam, 1200, 720, 0)).toBeNull();
    // Outside hit radius
    expect(hitTestStar(nodes, -500, -500, cam, 1200, 720)).toBeNull();
  });

  it('exports 2x PNG in wallpaper mode (no text) and card mode (metadata without titles)', () => {
    const stars = [
      makeStar({
        id: 'secret-conv-1',
        title: 'ULTRA_SECRET_PROJECT_NAME',
        started_at: '2026-06-15T08:00:00Z',
        local_date: '2026-06-15',
        celestial_type: 'binary',
        subagent_calls_count: 2,
      }),
      makeStar({
        id: 'secret-conv-2',
        title: 'ANOTHER_PRIVATE_TITLE',
        started_at: '2026-06-16T10:00:00Z',
        local_date: '2026-06-16',
        celestial_type: 'black_hole',
      }),
    ];
    const nodes = computeStarPositions(stars, 'total');
    const camera = computeFitCamera(nodes, 1000, 600);

    const createdCanvases: Array<{ width: number; height: number; ctx: ReturnType<typeof makeMockCanvasContext> }> = [];
    const origCreateElement = document.createElement.bind(document);
    const clickMock = vi.fn();

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName.toLowerCase() === 'canvas') {
        const ctx = makeMockCanvasContext();
        const canvasObj = {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ctx),
          toDataURL: vi.fn(() => 'data:image/png;base64,ZmFrZQ=='),
          toBlob: undefined,
        };
        createdCanvases.push({
          get width() {
            return canvasObj.width;
          },
          get height() {
            return canvasObj.height;
          },
          ctx,
        });
        return canvasObj as unknown as HTMLElement;
      }
      if (tagName.toLowerCase() === 'a') {
        const el = origCreateElement('a');
        el.click = clickMock;
        return el;
      }
      return origCreateElement(tagName);
    });

    exportSkyPng(nodes, {
      mode: 'wallpaper',
      width: 1000,
      height: 600,
      camera,
      tokenMode: 'total',
      privacyMode: false,
      totalTokens: 11000,
      dateRange: '2026-06-15 ~ 2026-06-16',
    });

    // Main export canvas (last created if offscreen nebula canvas was created first)
    const wallpaperMain = createdCanvases.find((c) => c.width === 2000 && c.height === 1200);
    expect(wallpaperMain).toBeDefined();
    expect(wallpaperMain!.ctx.fillText).not.toHaveBeenCalled();
    expect(wallpaperMain!.ctx.strokeText).not.toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalledTimes(1);

    createdCanvases.length = 0;
    clickMock.mockClear();

    exportSkyPng(nodes, {
      mode: 'card',
      width: 1000,
      height: 600,
      camera,
      tokenMode: 'total',
      privacyMode: false,
      totalTokens: 11000,
      dateRange: '2026-06-15 ~ 2026-06-16',
    });

    const cardMain = createdCanvases.find((c) => c.width === 2000 && c.height === 1200);
    expect(cardMain).toBeDefined();
    const drawnTexts = cardMain!.ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(drawnTexts.some((t) => t.includes('TokenStar'))).toBe(true);
    expect(drawnTexts.some((t) => t.includes('2 个对话星座'))).toBe(true);
    expect(drawnTexts.some((t) => t.includes('2026-06-15 ~ 2026-06-16'))).toBe(true);
    expect(drawnTexts.some((t) => t.includes('ULTRA_SECRET_PROJECT_NAME'))).toBe(false);
    expect(drawnTexts.some((t) => t.includes('ANOTHER_PRIVATE_TITLE'))).toBe(false);
    expect(clickMock).toHaveBeenCalledTimes(1);
  });

  it('hit-tests collapsed clusters, ignores expanded clusters, and exports collapsed & expanded cluster layers', () => {
    expect(AUTO_EXPAND_ZOOM).toBe(1.15);
    expect(AUTO_COLLAPSE_ZOOM).toBe(0.88);

    const conv = makeStar({
      id: 'cluster-export-conv',
      title: 'PRIVATE_SUBAGENT_CONV',
      started_at: '2026-06-15T09:00:00Z',
      local_date: '2026-06-15',
      requests: [
        makeRequest({
          id: 'cluster-export-conv:0',
          conversation_id: 'cluster-export-conv',
          session_id: 'cluster-export-conv',
          step_index: 0,
          created_at: '2026-06-15T09:00:00Z',
        }),
        makeRequest({
          id: 'sub-exp-a:0',
          conversation_id: 'cluster-export-conv',
          session_id: 'sub-exp-a',
          step_index: 0,
          created_at: '2026-06-15T09:01:00Z',
          is_subagent: true,
          subagent_role: 'explorer',
          parent_session_id: 'cluster-export-conv',
          parent_request_id: 'cluster-export-conv:0',
        }),
        makeRequest({
          id: 'sub-exp-a:1',
          conversation_id: 'cluster-export-conv',
          session_id: 'sub-exp-a',
          step_index: 1,
          created_at: '2026-06-15T09:02:00Z',
          is_subagent: true,
          subagent_role: 'explorer',
        }),
        makeRequest({
          id: 'sub-exp-a:2',
          conversation_id: 'cluster-export-conv',
          session_id: 'sub-exp-a',
          step_index: 2,
          created_at: '2026-06-15T09:03:00Z',
          is_subagent: true,
          subagent_role: 'explorer',
        }),
      ],
    });

    const nodes = computeStarPositions([conv], 'total');
    const clusters = buildSubagentClusters(nodes, 'total');
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    const cam: CameraState = { x: 0, y: 0, zoom: 1 };
    const anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, cam, 1200, 720);

    // Collapsed cluster hits accurately and prefers matched clusters
    expect(
      hitTestCluster(clusters, new Set(), anchorScreen.x + 2, anchorScreen.y - 2, cam, 1200, 720),
    ).toBe(cluster);
    expect(
      hitTestCluster(clusters, new Set([cluster.id]), anchorScreen.x, anchorScreen.y, cam, 1200, 720),
    ).toBeNull();
    expect(
      hitTestCluster(
        clusters,
        new Set(),
        anchorScreen.x,
        anchorScreen.y,
        cam,
        1200,
        720,
        cluster.firstNodeIndex,
      ),
    ).toBeNull();

    // Overlapping cluster prefers matchingClusterIds when provided
    const twinCluster = { ...cluster, id: 'twin-matched-cluster' };
    expect(
      hitTestCluster(
        [cluster, twinCluster],
        new Set(),
        anchorScreen.x,
        anchorScreen.y,
        cam,
        1200,
        720,
        undefined,
        new Set(['twin-matched-cluster']),
      )?.id,
    ).toBe('twin-matched-cluster');

    // exportSkyPng renders cleanly with collapsed & expanded cluster options
    const createdCanvases: Array<{ width: number; height: number; ctx: ReturnType<typeof makeMockCanvasContext> }> = [];
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName.toLowerCase() === 'canvas') {
        const ctx = makeMockCanvasContext();
        const canvasObj = {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ctx),
          toDataURL: vi.fn(() => 'data:image/png;base64,ZmFrZQ=='),
          toBlob: undefined,
        };
        createdCanvases.push({
          get width() {
            return canvasObj.width;
          },
          get height() {
            return canvasObj.height;
          },
          ctx,
        });
        return canvasObj as unknown as HTMLElement;
      }
      return origCreateElement(tagName);
    });

    const collapsedRes = exportSkyPng(nodes, {
      mode: 'wallpaper',
      width: 1200,
      height: 720,
      camera: cam,
      tokenMode: 'total',
      privacyMode: false,
      totalTokens: 5000,
      dateRange: '2026-06-15',
      clusters,
      expandedClusterIds: new Set(),
      expandAllSubagents: false,
      skipDownload: true,
    });
    expect(collapsedRes?.dataUrl).toMatch(/^data:image\/png/);
    const collapsedMain = createdCanvases.find((c) => c.width === 2400 && c.height === 1440)!;
    expect(collapsedMain.ctx.quadraticCurveTo).toHaveBeenCalled();
    expect(collapsedMain.ctx.ellipse).not.toHaveBeenCalled();
    expect(collapsedMain.ctx.fillText).not.toHaveBeenCalled();

    createdCanvases.length = 0;

    const expandedRes = exportSkyPng(nodes, {
      mode: 'wallpaper',
      width: 1200,
      height: 720,
      camera: cam,
      tokenMode: 'total',
      privacyMode: false,
      totalTokens: 5000,
      dateRange: '2026-06-15',
      clusters,
      expandedClusterIds: new Set([cluster.id]),
      expandAllSubagents: false,
      skipDownload: true,
    });
    expect(expandedRes?.dataUrl).toMatch(/^data:image\/png/);
    const expandedMain = createdCanvases.find((c) => c.width === 2400 && c.height === 1440)!;
    expect(expandedMain.ctx.quadraticCurveTo).toHaveBeenCalled();
    expect(expandedMain.ctx.ellipse).toHaveBeenCalled();
    const ellipseCalls = expandedMain.ctx.ellipse.mock.calls;
    expect(ellipseCalls.length).toBeGreaterThan(0);
    for (const call of ellipseCalls) {
      const rx = Number(call[2]);
      const ry = Number(call[3]);
      expect(Math.min(rx, ry) / Math.max(rx, ry)).toBeGreaterThanOrEqual(0.82);
    }
    expect(expandedMain.ctx.fillText).not.toHaveBeenCalled();
  });

  it('scales visual size smoothly down to 0.38 at low zoom and fades unhighlighted subagent bridges in exportSkyPng', () => {
    expect(getVisualScale(1)).toBeCloseTo(1, 6);
    expect(getVisualScale(0.2)).toBeCloseTo(Math.pow(0.2, 0.53), 6);
    expect(getVisualScale(0.5)).toBeCloseTo(Math.pow(0.5, 0.53), 6);
    expect(getVisualScale(0.08)).toBe(0.38);
    expect(getVisualScale(10)).toBe(2.25);

    const conv = makeStar({
      id: 'zoom-fade-conv',
      started_at: '2026-06-15T09:00:00Z',
      local_date: '2026-06-15',
      requests: [
        makeRequest({
          id: 'zoom-fade-conv:0',
          conversation_id: 'zoom-fade-conv',
          session_id: 'zoom-fade-conv',
          step_index: 0,
          created_at: '2026-06-15T09:00:00Z',
        }),
        makeRequest({
          id: 'zoom-fade-sub:0',
          conversation_id: 'zoom-fade-conv',
          session_id: 'zoom-fade-sub',
          step_index: 0,
          created_at: '2026-06-15T09:01:00Z',
          is_subagent: true,
          subagent_role: 'explorer',
          parent_session_id: 'zoom-fade-conv',
          parent_request_id: 'zoom-fade-conv:0',
        }),
        makeRequest({
          id: 'zoom-fade-sub:1',
          conversation_id: 'zoom-fade-conv',
          session_id: 'zoom-fade-sub',
          step_index: 1,
          created_at: '2026-06-15T09:02:00Z',
          is_subagent: true,
          subagent_role: 'explorer',
        }),
      ],
    });

    const nodes = computeStarPositions([conv], 'total');
    const clusters = buildSubagentClusters(nodes, 'total');
    expect(clusters).toHaveLength(1);

    const createdCanvases: Array<{
      width: number;
      height: number;
      ctx: ReturnType<typeof makeMockCanvasContext>;
      compositeOps: string[];
    }> = [];
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName.toLowerCase() === 'canvas') {
        const ctx = makeMockCanvasContext();
        const compositeOps: string[] = [];
        let compOp = 'source-over';
        Object.defineProperty(ctx, 'globalCompositeOperation', {
          get: () => compOp,
          set: (val: string) => {
            compOp = val;
            compositeOps.push(val);
          },
        });
        const canvasObj = {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ctx),
          toDataURL: vi.fn(() => 'data:image/png;base64,ZmFrZQ=='),
          toBlob: undefined,
        };
        createdCanvases.push({
          get width() {
            return canvasObj.width;
          },
          get height() {
            return canvasObj.height;
          },
          ctx,
          compositeOps,
        });
        return canvasObj as unknown as HTMLElement;
      }
      return origCreateElement(tagName);
    });

    // At panoramic low zoom (0.18), unhighlighted subagent bridges fade out cleanly
    exportSkyPng(nodes, {
      mode: 'wallpaper',
      width: 1200,
      height: 720,
      camera: { x: 0, y: 0, zoom: 0.18 },
      tokenMode: 'total',
      privacyMode: false,
      totalTokens: 5000,
      dateRange: '2026-06-15',
      clusters,
      expandedClusterIds: new Set(),
      expandAllSubagents: false,
      skipDownload: true,
    });
    const lowMain = createdCanvases.find((c) => c.width === 2400 && c.height === 1440)!;
    expect(lowMain.ctx.quadraticCurveTo).not.toHaveBeenCalled();
    expect(lowMain.compositeOps).not.toContain('destination-out');

    createdCanvases.length = 0;

    // At zoom = 1.0, tidal bridges render cleanly without destination-out punch-through
    exportSkyPng(nodes, {
      mode: 'wallpaper',
      width: 1200,
      height: 720,
      camera: { x: 0, y: 0, zoom: 1.0 },
      tokenMode: 'total',
      privacyMode: false,
      totalTokens: 5000,
      dateRange: '2026-06-15',
      clusters,
      expandedClusterIds: new Set(),
      expandAllSubagents: false,
      skipDownload: true,
    });
    const midMain = createdCanvases.find((c) => c.width === 2400 && c.height === 1440)!;
    expect(midMain.ctx.quadraticCurveTo).toHaveBeenCalled();
    expect(midMain.compositeOps).not.toContain('destination-out');
  });
});

describe('SkyTab, DetailDrawer & PlaybackBar components', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => makeMockCanvasContext() as unknown as RenderingContext,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => 'data:image/png;base64,ZmFrZQ==',
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders observatory empty state when stars list is empty', () => {
    act(() => {
      root.render(
        <SkyTab
          stars={[]}
          tokenMode="total"
          privacyMode={false}
          highlightDate={null}
          focusStarId={null}
          onClearFocus={vi.fn()}
          onClearHighlightDate={vi.fn()}
          onJumpToStats={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('Antigravity');
    expect(container.textContent).toContain('星体');
  });

  it('renders DetailDrawer for a request node with parent conversation summary, privacy title, and jump-to-stats button', () => {
    const star = makeStar({
      id: 'binary-1',
      title: 'Hidden Sensitive Title',
      celestial_type: 'binary',
      celestial_reason: '调用了 2 次子代理协作',
      subagent_calls_count: 2,
      requests: [
        makeRequest({
          id: 'binary-1:0',
          conversation_id: 'binary-1',
          step_index: 0,
          turn_index: 1,
          created_at: '2026-06-15T09:00:00Z',
          total_tokens: 1500,
          celestial_type: 'star',
          celestial_reason: '常规深度响应',
        }),
        makeRequest({
          id: 'binary-1:1',
          conversation_id: 'binary-1',
          step_index: 1,
          turn_index: 2,
          created_at: '2026-06-15T09:03:00Z',
          input_tokens: 300,
          cache_read_tokens: 2000,
          output_tokens: 400,
          total_tokens: 2700,
          non_cache_tokens: 700,
          subagent_calls_count: 2,
          celestial_type: 'binary',
          celestial_reason: '本步协同派发 2 个子代理',
        }),
      ],
      subagents: [
        {
          id: 'sub-1',
          role: 'Explorer',
          type_name: 'search',
          primary_model: 'gemini-2.5-flash',
          input_tokens: 200,
          cache_read_tokens: 300,
          output_tokens: 100,
          total_tokens: 600,
          non_cache_tokens: 300,
          last_status: 'COMPLETED',
        },
      ],
    });
    const nodes = computeStarPositions([star], 'total');
    const secondReqNode = nodes[1];
    const onJump = vi.fn();
    const onClose = vi.fn();

    act(() => {
      root.render(
        <DetailDrawer
          node={secondReqNode}
          tokenMode="total"
          privacyMode={true}
          onClose={onClose}
          onJumpToStats={onJump}
        />,
      );
    });

    expect(container.textContent).toContain('星体 #001');
    expect(container.textContent).toContain('第 2 / 2 次请求');
    expect(container.textContent).toContain('2,700');
    expect(container.textContent).toContain('所属对话星座总览');
    expect(container.textContent).not.toContain('Hidden Sensitive Title');
    expect(container.textContent).toContain('伴星（子代理）消耗明细');
    expect(container.textContent).toContain('Explorer');
    expect(container.textContent).toContain('Input');
    expect(container.textContent).toContain('Cache Read');
    expect(container.textContent).toContain('Output');

    const jumpBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('在统计列表中查看'),
    );
    expect(jumpBtn).toBeDefined();
    act(() => {
      jumpBtn!.click();
    });
    expect(onJump).toHaveBeenCalledWith('binary-1');
  });

  it('renders PlaybackBar controls and handles play, speed cycle, scrub, and exit/reset', () => {
    const onTogglePlay = vi.fn();
    const onCycleSpeed = vi.fn();
    const onScrub = vi.fn();
    const onExitReset = vi.fn();

    act(() => {
      root.render(
        <PlaybackBar
          isActive={true}
          isPlaying={false}
          speed={2}
          visibleCount={3}
          totalCount={10}
          currentDate="2026-06-15"
          onTogglePlay={onTogglePlay}
          onCycleSpeed={onCycleSpeed}
          onScrub={onScrub}
          onExitReset={onExitReset}
        />,
      );
    });

    expect(container.textContent).toContain('2x');
    expect(container.textContent).toContain('2026-06-15');
    expect(container.textContent).toContain('3 / 10');

    const buttons = Array.from(container.querySelectorAll('button'));
    act(() => {
      buttons.find((b) => b.textContent?.includes('播放'))?.click();
      buttons.find((b) => b.textContent?.includes('2x'))?.click();
      buttons.find((b) => b.textContent?.includes('退出'))?.click();
    });

    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    expect(onCycleSpeed).toHaveBeenCalledTimes(1);
    expect(onExitReset).toHaveBeenCalledTimes(1);
  });

  it('handles SkyTab focusStarId opening drawer and filtering respecting privacyMode', () => {
    const stars = [
      makeStar({
        id: 's1',
        title: 'Secret Architecture',
        primary_model: 'gemini-2.5-pro',
        celestial_type: 'star',
        local_date: '2026-06-15',
      }),
      makeStar({
        id: 's2',
        title: 'Public Fix',
        primary_model: 'gemini-2.5-flash',
        models: [],
        celestial_type: 'comet',
        local_date: '2026-06-16',
        started_at: '2026-06-16T10:00:00Z',
        ended_at: '2026-06-16T10:05:00Z',
      }),
    ];
    const onClearFocus = vi.fn();
    const onJumpToStats = vi.fn();

    act(() => {
      root.render(
        <SkyTab
          stars={stars}
          tokenMode="total"
          privacyMode={true}
          highlightDate={null}
          focusStarId="s2"
          onClearFocus={onClearFocus}
          onClearHighlightDate={vi.fn()}
          onJumpToStats={onJumpToStats}
        />,
      );
    });

    // Focus opens DetailDrawer for s2 (chronological #002 in privacy mode)
    expect(onClearFocus).toHaveBeenCalled();
    expect(container.textContent).toContain('星体 #002');
    expect(container.textContent).toContain('共 2 颗星体 · 2 个对话星座');
    expect(container.textContent).not.toContain('Public Fix');

    // Filter by celestial type 'comet' updates match counter to 1 / 2
    const cometToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('彗星'),
    );
    expect(cometToggle).toBeDefined();
    act(() => {
      cometToggle!.click();
    });
    expect(container.textContent).toContain('1 / 2');

    // Toggle legend pill opens 5 celestial types & spectral color legend
    const legendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('图例'),
    );
    expect(legendBtn).toBeDefined();
    act(() => {
      legendBtn!.click();
    });
    expect(container.textContent).toContain('模型光谱色');
    expect(container.textContent).toContain('高频工具调用任务');
    expect(container.textContent).toContain('无交叉最小生成树连线');

    // Toggle planetarium grid, constellation lines & nebula HUD controls cleanly
    const gridBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '网格',
    );
    const linesBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '连线',
    );
    const nebulaBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '星云',
    );
    expect(gridBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(linesBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(nebulaBtn?.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      gridBtn!.click();
      linesBtn!.click();
      nebulaBtn!.click();
    });
    expect(gridBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(linesBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(nebulaBtn?.getAttribute('aria-pressed')).toBe('false');
  });

  it('supports highlightDate banner, privacy-safe search, and 2x PNG export menu in SkyTab', () => {
    const stars = [
      makeStar({
        id: 's1',
        title: 'Classified Kernel Fix',
        primary_model: 'gemini-2.5-pro',
        celestial_type: 'pulsar',
        local_date: '2026-06-15',
      }),
      makeStar({
        id: 's2',
        title: 'Public Docs Update',
        primary_model: 'gemini-2.5-flash',
        models: [],
        celestial_type: 'black_hole',
        local_date: '2026-06-16',
        started_at: '2026-06-16T10:00:00Z',
        ended_at: '2026-06-16T10:05:00Z',
      }),
    ];
    const onClearHighlightDate = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    act(() => {
      root.render(
        <SkyTab
          stars={stars}
          tokenMode="total"
          privacyMode={true}
          highlightDate="2026-06-15"
          focusStarId={null}
          onClearFocus={vi.fn()}
          onClearHighlightDate={onClearHighlightDate}
          onJumpToStats={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('✦ 高亮 2026-06-15');
    const clearHighlightBtn = container.querySelector('button[aria-label="清除日期高亮"]') as HTMLButtonElement | null;
    expect(clearHighlightBtn).not.toBeNull();
    act(() => {
      clearHighlightBtn!.click();
    });
    expect(onClearHighlightDate).toHaveBeenCalledTimes(1);

    // Export dropdown triggers 2x PNG download without throwing
    const exportBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('导出星图'),
    );
    expect(exportBtn).toBeDefined();
    act(() => {
      exportBtn!.click();
    });
    const cardMenuItem = Array.from(container.querySelectorAll('button[role="menuitem"]')).find((b) =>
      b.textContent?.includes('星图纪念卡（2x）'),
    );
    expect(cardMenuItem).toBeDefined();
    act(() => {
      (cardMenuItem as HTMLButtonElement).click();
    });
    expect(clickSpy).toHaveBeenCalled();
  });

  it('uses MCP export callback in host mode and opens preview modal fallback on error', async () => {
    const stars = [makeStar({ id: 'mcp-export-star', local_date: '2026-06-15' })];
    const onSaveExportPng = vi.fn().mockResolvedValue({
      status: 'saved',
      path: 'C:/Users/demo/Downloads/tokenstar-wallpaper-2x.png',
      filename: 'tokenstar-wallpaper-2x.png',
      bytes: 2048,
    });
    const onNotify = vi.fn();

    act(() => {
      root.render(
        <SkyTab
          stars={stars}
          tokenMode="total"
          privacyMode={false}
          highlightDate={null}
          focusStarId={null}
          onClearFocus={vi.fn()}
          onClearHighlightDate={vi.fn()}
          onJumpToStats={vi.fn()}
          onSaveExportPng={onSaveExportPng}
          onNotify={onNotify}
        />,
      );
    });

    const exportBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('导出星图'),
    );
    expect(exportBtn).toBeDefined();
    act(() => {
      exportBtn!.click();
    });

    const wallpaperItem = Array.from(container.querySelectorAll('button[role="menuitem"]')).find((b) =>
      b.textContent?.includes('纯净壁纸（2x）'),
    ) as HTMLButtonElement | undefined;
    expect(wallpaperItem).toBeDefined();

    await act(async () => {
      wallpaperItem!.click();
      await Promise.resolve();
    });

    expect(onSaveExportPng).toHaveBeenCalledWith(
      expect.stringMatching(/^data:image\/png;base64,/),
      'tokenstar-wallpaper-2x.png',
    );
    expect(onNotify).toHaveBeenCalledWith(
      '✦ 星图已保存至 C:/Users/demo/Downloads/tokenstar-wallpaper-2x.png',
    );
    expect(container.querySelector('div[role="dialog"][aria-label="星图导出预览"]')).toBeNull();

    // Rejection falls back to preview modal so the user can save or copy manually
    onSaveExportPng.mockRejectedValueOnce(new Error('Disk full'));
    act(() => {
      exportBtn!.click();
    });
    const cardItem = Array.from(container.querySelectorAll('button[role="menuitem"]')).find((b) =>
      b.textContent?.includes('星图纪念卡（2x）'),
    ) as HTMLButtonElement | undefined;
    expect(cardItem).toBeDefined();

    await act(async () => {
      cardItem!.click();
      await Promise.resolve();
    });

    const previewDialog = container.querySelector('div[role="dialog"][aria-label="星图导出预览"]');
    expect(previewDialog).not.toBeNull();
    const img = previewDialog!.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('alt')).toBe('tokenstar-card-2x.png');
    expect(img!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(onNotify).toHaveBeenCalledWith('导出保存受阻：Disk full');
  });

  it('releases pointer capture and resets drag state on pointercancel without calling onSelectStar', () => {
    const nodes = computeStarPositions([makeStar({ id: 'cancel-star-1' })], 'total');
    const onSelectStar = vi.fn();
    const onHoverStar = vi.fn();

    act(() => {
      root.render(
        <StarCanvas
          nodes={nodes}
          matchingIds={null}
          hasActiveFilter={false}
          selectedStarId={null}
          hoveredStarId={null}
          highlightDate={null}
          playbackVisibleCount={null}
          cameraRequest={null}
          onHoverStar={onHoverStar}
          onSelectStar={onSelectStar}
          onResetView={vi.fn()}
        />,
      );
    });

    const canvases = container.querySelectorAll('canvas');
    expect(canvases.length).toBe(2);
    const canvas = container.querySelector('canvas[aria-label="TokenStar 交互式星空画布"]') as HTMLCanvasElement | null;
    expect(canvas).not.toBeNull();
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    canvas!.setPointerCapture = setCapture;
    canvas!.releasePointerCapture = releaseCapture;

    const makePointerEvent = (type: string) =>
      Object.assign(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 50, clientY: 50 }),
        { pointerId: 7 },
      );

    act(() => {
      canvas!.dispatchEvent(makePointerEvent('pointerdown'));
    });
    expect(setCapture).toHaveBeenCalledWith(7);
    expect(canvas!.style.cursor).toBe('grabbing');

    act(() => {
      canvas!.dispatchEvent(makePointerEvent('pointercancel'));
    });
    expect(releaseCapture).toHaveBeenCalledWith(7);
    expect(canvas!.style.cursor).toBe('grab');
    expect(onSelectStar).not.toHaveBeenCalled();

    // Subsequent pointerup should be ignored since dragRef was reset by pointercancel
    act(() => {
      canvas!.dispatchEvent(makePointerEvent('pointerup'));
    });
    expect(onSelectStar).not.toHaveBeenCalled();
  });

  it('excludes collapsed cluster micro-stars from pointer hits until expanded in StarCanvas', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'ptr-cluster-conv',
        requests: [
          makeRequest({
            id: 'ptr-cluster-conv:0',
            conversation_id: 'ptr-cluster-conv',
            session_id: 'ptr-cluster-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          ...Array.from({ length: 4 }, (_, k) =>
            makeRequest({
              id: `ptr-sub:${k}`,
              conversation_id: 'ptr-cluster-conv',
              session_id: 'ptr-sub',
              step_index: k,
              created_at: `2026-06-15T09:0${k + 1}:00Z`,
              is_subagent: true,
              subagent_role: 'explorer',
              parent_session_id: 'ptr-cluster-conv',
              parent_request_id: 'ptr-cluster-conv:0',
            }),
          ),
        ],
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      const cluster = clusters[0];
      const tailMember = cluster.memberNodes[cluster.memberNodes.length - 1];
      const fitCam = computeFitCamera(nodes, 1200, 720);
      // Keep zoom below AUTO_EXPAND_ZOOM so manual expandedClusterIds controls collapse/expand cleanly
      const fixedCam: CameraState = { x: fitCam.x, y: fitCam.y, zoom: Math.min(fitCam.zoom, 1.1) };

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const onSelectStar = vi.fn();
      const onHoverStar = vi.fn();
      const onSelectCluster = vi.fn();
      const onHoverCluster = vi.fn();

      const renderCanvas = (expandedClusterIds: Set<string>) => {
        act(() => {
          root.render(
            <StarCanvas
              nodes={nodes}
              clusters={clusters}
              expandedClusterIds={expandedClusterIds}
              matchingIds={null}
              hasActiveFilter={false}
              selectedStarId={null}
              hoveredStarId={null}
              highlightDate={null}
              playbackVisibleCount={null}
              cameraRequest={{ id: 1, camera: fixedCam }}
              onHoverStar={onHoverStar}
              onSelectStar={onSelectStar}
              onHoverCluster={onHoverCluster}
              onSelectCluster={onSelectCluster}
              onResetView={vi.fn()}
            />,
          );
        });
      };

      renderCanvas(new Set());
      act(() => {
        vi.advanceTimersByTime(2500);
      });

      const canvas = container.querySelector(
        'canvas[aria-label="TokenStar 交互式星空画布"]',
      ) as HTMLCanvasElement;
      expect(canvas).not.toBeNull();

      const clickAt = (sx: number, sy: number) => {
        const makeEvt = (type: string) =>
          Object.assign(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: sx,
              clientY: sy,
            }),
            { pointerId: 3 },
          );
        act(() => {
          canvas.dispatchEvent(makeEvt('pointerdown'));
          canvas.dispatchEvent(makeEvt('pointerup'));
        });
      };

      // Clicking hidden tail member while collapsed must NOT select that micro-star
      const tailScreen = worldToScreen(tailMember.x, tailMember.y, fixedCam, 1200, 720);
      clickAt(tailScreen.x, tailScreen.y);
      expect(onSelectStar).toHaveBeenCalledWith(null);
      expect(onSelectCluster).toHaveBeenCalledWith(null);

      // Hovering & clicking cluster anchor hits the collapsed cluster
      onSelectStar.mockClear();
      onSelectCluster.mockClear();
      onHoverStar.mockClear();
      onHoverCluster.mockClear();
      const anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, fixedCam, 1200, 720);
      act(() => {
        canvas.dispatchEvent(
          Object.assign(
            new MouseEvent('pointermove', {
              bubbles: true,
              cancelable: true,
              clientX: anchorScreen.x,
              clientY: anchorScreen.y,
            }),
            { pointerId: 3 },
          ),
        );
      });
      expect(onHoverCluster).toHaveBeenCalledWith(cluster, { x: anchorScreen.x, y: anchorScreen.y });
      expect(onHoverStar).toHaveBeenCalledWith(null, null);

      clickAt(anchorScreen.x, anchorScreen.y);
      expect(onSelectCluster).toHaveBeenCalledWith(cluster);
      expect(onSelectStar).not.toHaveBeenCalled();

      // Once expanded, clicking tail member selects the micro-star directly
      onSelectStar.mockClear();
      onSelectCluster.mockClear();
      renderCanvas(new Set([cluster.id]));
      clickAt(tailScreen.x, tailScreen.y);
      expect(onSelectStar).toHaveBeenCalledWith(tailMember);
      expect(onSelectCluster).not.toHaveBeenCalled();

      // Close-zoom auto-LOD hysteresis: >= AUTO_EXPAND_ZOOM auto-expands, hysteresis band preserves, < AUTO_COLLAPSE_ZOOM collapses
      onSelectStar.mockClear();
      onSelectCluster.mockClear();
      const renderWithZoom = (reqId: number, camState: CameraState) => {
        act(() => {
          root.render(
            <StarCanvas
              nodes={nodes}
              clusters={clusters}
              expandedClusterIds={new Set()}
              matchingIds={null}
              hasActiveFilter={false}
              selectedStarId={null}
              hoveredStarId={null}
              highlightDate={null}
              playbackVisibleCount={null}
              cameraRequest={{ id: reqId, camera: camState }}
              onHoverStar={onHoverStar}
              onSelectStar={onSelectStar}
              onHoverCluster={onHoverCluster}
              onSelectCluster={onSelectCluster}
              onResetView={vi.fn()}
            />,
          );
        });
        act(() => {
          vi.advanceTimersByTime(2500);
        });
      };

      const zoomedInCam: CameraState = { x: cluster.anchorX, y: cluster.anchorY, zoom: 1.4 };
      renderWithZoom(2, zoomedInCam);
      const tailZoomedIn = worldToScreen(tailMember.x, tailMember.y, zoomedInCam, 1200, 720);
      clickAt(tailZoomedIn.x, tailZoomedIn.y);
      expect(onSelectStar).toHaveBeenCalledWith(tailMember);

      onSelectStar.mockClear();
      const midBandCam: CameraState = { x: cluster.anchorX, y: cluster.anchorY, zoom: 1.0 };
      renderWithZoom(3, midBandCam);
      const tailMidBand = worldToScreen(tailMember.x, tailMember.y, midBandCam, 1200, 720);
      clickAt(tailMidBand.x, tailMidBand.y);
      expect(onSelectStar).toHaveBeenCalledWith(tailMember);

      onSelectStar.mockClear();
      onSelectCluster.mockClear();
      const zoomedOutCam: CameraState = { x: cluster.anchorX, y: cluster.anchorY, zoom: 0.7 };
      renderWithZoom(4, zoomedOutCam);
      const anchorZoomedOut = worldToScreen(cluster.anchorX, cluster.anchorY, zoomedOutCam, 1200, 720);
      clickAt(anchorZoomedOut.x, anchorZoomedOut.y);
      expect(onSelectCluster).toHaveBeenCalledWith(cluster);
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles SkyTab subagent HUD pill and DetailDrawer cluster actions', () => {
    const conv = makeStar({
      id: 'hud-sub-conv',
      title: 'Subagent Constellation',
      subagent_calls_count: 1,
      requests: [
        makeRequest({
          id: 'hud-sub-conv:0',
          conversation_id: 'hud-sub-conv',
          session_id: 'hud-sub-conv',
          step_index: 0,
          created_at: '2026-06-15T09:00:00Z',
        }),
        makeRequest({
          id: 'sub-hud:0',
          conversation_id: 'hud-sub-conv',
          session_id: 'sub-hud',
          step_index: 0,
          created_at: '2026-06-15T09:01:00Z',
          is_subagent: true,
          subagent_role: 'Planner',
          parent_session_id: 'hud-sub-conv',
          parent_request_id: 'hud-sub-conv:0',
        }),
      ],
      subagents: [
        {
          id: 'sub-hud',
          role: 'Planner',
          type_name: 'plan',
          primary_model: 'gemini-2.5-flash',
          input_tokens: 400,
          cache_read_tokens: 1000,
          output_tokens: 200,
          total_tokens: 1600,
          non_cache_tokens: 600,
          last_status: 'COMPLETED',
          request_count: 1,
        },
      ],
    });

    act(() => {
      root.render(
        <SkyTab
          stars={[conv]}
          tokenMode="total"
          privacyMode={false}
          highlightDate={null}
          focusStarId={null}
          onClearFocus={vi.fn()}
          onClearHighlightDate={vi.fn()}
          onJumpToStats={vi.fn()}
        />,
      );
    });

    const clusterToggleBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '子代理：星团',
    );
    expect(clusterToggleBtn).toBeDefined();
    expect(clusterToggleBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(clusterToggleBtn?.getAttribute('title')).toContain('伴星团');
    expect(clusterToggleBtn?.getAttribute('title')).toContain('子代理');
    expect(container.textContent).toContain('共 2 颗星体 · 1 个对话星座');

    act(() => {
      clusterToggleBtn!.click();
    });
    expect(clusterToggleBtn?.textContent).toBe('子代理：展开');
    expect(clusterToggleBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(clusterToggleBtn?.getAttribute('title')).toContain('伴星团');
    expect(clusterToggleBtn?.getAttribute('title')).toContain('子代理');

    // DetailDrawer renders 展开轨迹 when collapsed and 收起为伴星团 / 收起星团 when expanded
    const nodes = computeStarPositions([conv], 'total');
    const clusters = buildSubagentClusters(nodes, 'total');
    const mainNode = nodes[0];
    const subNode = nodes[1];
    const onToggleCluster = vi.fn();
    const onFocusCluster = vi.fn();

    act(() => {
      root.render(
        <DetailDrawer
          node={mainNode}
          tokenMode="total"
          privacyMode={false}
          clusters={clusters}
          expandedClusterIds={new Set()}
          expandAllSubagents={false}
          onToggleCluster={onToggleCluster}
          onFocusCluster={onFocusCluster}
          onClose={vi.fn()}
          onJumpToStats={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('1 步');
    const expandTraceBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '展开轨迹',
    );
    expect(expandTraceBtn).toBeDefined();
    act(() => {
      expandTraceBtn!.click();
    });
    expect(onFocusCluster).toHaveBeenCalledWith(clusters[0]);

    act(() => {
      root.render(
        <DetailDrawer
          node={subNode}
          tokenMode="total"
          privacyMode={false}
          clusters={clusters}
          expandedClusterIds={new Set([clusters[0].id])}
          expandAllSubagents={false}
          onToggleCluster={onToggleCluster}
          onFocusCluster={onFocusCluster}
          onClose={vi.fn()}
          onJumpToStats={vi.fn()}
        />,
      );
    });

    const collapseHeaderBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '收起为伴星团',
    );
    const collapseRowBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === '收起星团',
    );
    expect(collapseHeaderBtn).toBeDefined();
    expect(collapseRowBtn).toBeDefined();

    act(() => {
      collapseHeaderBtn!.click();
      collapseRowBtn!.click();
    });
    expect(onToggleCluster).toHaveBeenNthCalledWith(1, clusters[0].id);
    expect(onToggleCluster).toHaveBeenNthCalledWith(2, clusters[0].id);
  });

  it('renders SkyTab cluster hover tooltip and expands cluster into DetailDrawer on click', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'tooltip-cluster-conv',
        title: 'Tooltip Cluster Conv',
        subagent_calls_count: 1,
        requests: [
          makeRequest({
            id: 'tooltip-cluster-conv:0',
            conversation_id: 'tooltip-cluster-conv',
            session_id: 'tooltip-cluster-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          makeRequest({
            id: 'sub-tip:0',
            conversation_id: 'tooltip-cluster-conv',
            session_id: 'sub-tip',
            step_index: 0,
            created_at: '2026-06-15T09:01:00Z',
            model: 'gemini-2.5-flash',
            total_tokens: 1600,
            non_cache_tokens: 600,
            is_subagent: true,
            subagent_role: 'Planner',
            parent_session_id: 'tooltip-cluster-conv',
            parent_request_id: 'tooltip-cluster-conv:0',
          }),
        ],
        subagents: [
          {
            id: 'sub-tip',
            role: 'Planner',
            type_name: 'plan',
            primary_model: 'gemini-2.5-flash',
            input_tokens: 400,
            cache_read_tokens: 1000,
            output_tokens: 200,
            total_tokens: 1600,
            non_cache_tokens: 600,
            last_status: 'COMPLETED',
            request_count: 1,
          },
        ],
      });

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      act(() => {
        root.render(
          <SkyTab
            stars={[conv]}
            tokenMode="total"
            privacyMode={false}
            highlightDate={null}
            focusStarId={null}
            onClearFocus={vi.fn()}
            onClearHighlightDate={vi.fn()}
            onJumpToStats={vi.fn()}
          />,
        );
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      const cluster = clusters[0];
      const fitCam = computeFitCamera(nodes, 1200, 720);
      // Wait for intro dolly to settle; note computeFitCamera for 2 close stars could be 2.2 so check actual zoom:
      // Wait: if fitCam.zoom >= AUTO_EXPAND_ZOOM (1.15), auto-LOD would auto-expand! Zoom out via wheel to ensure collapsed state.
      const canvas = container.querySelector(
        'canvas[aria-label="TokenStar 交互式星空画布"]',
      ) as HTMLCanvasElement;
      expect(canvas).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      // Zoom out with wheel at center until zoom < AUTO_COLLAPSE_ZOOM (0.88)
      act(() => {
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 360,
            deltaY: 950,
          }),
        );
        vi.advanceTimersByTime(900);
      });

      const zoomedOutZoom = Math.max(0.08, fitCam.zoom * Math.exp(-950 * 0.0012));
      const curCam: CameraState = {
        x: fitCam.x + (600 - 600) / fitCam.zoom - (600 - 600) / zoomedOutZoom,
        y: fitCam.y + (360 - 360) / fitCam.zoom - (360 - 360) / zoomedOutZoom,
        zoom: zoomedOutZoom,
      };
      const anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, curCam, 1200, 720);

      act(() => {
        canvas.dispatchEvent(
          Object.assign(
            new MouseEvent('pointermove', {
              bubbles: true,
              cancelable: true,
              clientX: anchorScreen.x,
              clientY: anchorScreen.y,
            }),
            { pointerId: 9 },
          ),
        );
      });

      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip!.textContent).toContain('伴星团');
      expect(tooltip!.textContent).toContain('Planner');
      expect(tooltip!.textContent).toContain('请求数 1 步');
      expect(tooltip!.textContent).toContain('gemini-2.5-flash');
      expect(tooltip!.textContent).toContain('1,600');
      expect(tooltip!.textContent).toContain('点击展开子代理微星链');

      // Clicking the cluster expands it and opens DetailDrawer on its member star
      act(() => {
        canvas.dispatchEvent(
          Object.assign(
            new MouseEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: anchorScreen.x,
              clientY: anchorScreen.y,
            }),
            { pointerId: 9 },
          ),
        );
        canvas.dispatchEvent(
          Object.assign(
            new MouseEvent('pointerup', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: anchorScreen.x,
              clientY: anchorScreen.y,
            }),
            { pointerId: 9 },
          ),
        );
      });

      expect(container.querySelector('[role="tooltip"]')).toBeNull();
      expect(container.textContent).toContain('收起为伴星团');
      expect(container.textContent).toContain('收起星团');
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses expanded subagent cluster on empty canvas click, wheel zoom-out, reset view, and HUD button toggle', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'collapse-triggers-conv',
        title: 'Collapse Triggers Conv',
        subagent_calls_count: 1,
        requests: [
          makeRequest({
            id: 'collapse-triggers-conv:0',
            conversation_id: 'collapse-triggers-conv',
            session_id: 'collapse-triggers-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          ...Array.from({ length: 4 }, (_, k) =>
            makeRequest({
              id: `sub-trig:${k}`,
              conversation_id: 'collapse-triggers-conv',
              session_id: 'sub-trig',
              step_index: k,
              created_at: `2026-06-15T09:0${k + 1}:00Z`,
              model: 'gemini-2.5-flash',
              total_tokens: 1600,
              non_cache_tokens: 600,
              is_subagent: true,
              subagent_role: 'Planner',
              parent_session_id: 'collapse-triggers-conv',
              parent_request_id: 'collapse-triggers-conv:0',
            }),
          ),
        ],
        subagents: [
          {
            id: 'sub-trig',
            role: 'Planner',
            type_name: 'plan',
            primary_model: 'gemini-2.5-flash',
            input_tokens: 1600,
            cache_read_tokens: 4000,
            output_tokens: 800,
            total_tokens: 6400,
            non_cache_tokens: 2400,
            last_status: 'COMPLETED',
            request_count: 4,
          },
        ],
      });

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      act(() => {
        root.render(
          <SkyTab
            stars={[conv]}
            tokenMode="total"
            privacyMode={false}
            highlightDate={null}
            focusStarId={null}
            onClearFocus={vi.fn()}
            onClearHighlightDate={vi.fn()}
            onJumpToStats={vi.fn()}
          />,
        );
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      const cluster = clusters[0];
      const tailMember = cluster.memberNodes[cluster.memberNodes.length - 1];
      const canvas = container.querySelector(
        'canvas[aria-label="TokenStar 交互式星空画布"]',
      ) as HTMLCanvasElement;
      expect(canvas).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      const curCam: CameraState = { ...computeFitCamera(nodes, 1200, 720) };
      const wheelBy = (deltaY: number, advanceMs = 900) => {
        act(() => {
          canvas.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: 600,
              clientY: 360,
              deltaY,
            }),
          );
          vi.advanceTimersByTime(advanceMs);
        });
        curCam.zoom = Math.min(7.5, Math.max(0.08, curCam.zoom * Math.exp(-deltaY * 0.0012)));
      };

      const moveTo = (sx: number, sy: number) => {
        act(() => {
          canvas.dispatchEvent(
            Object.assign(
              new MouseEvent('pointermove', {
                bubbles: true,
                cancelable: true,
                clientX: sx,
                clientY: sy,
              }),
              { pointerId: 11 },
            ),
          );
        });
      };

      const clickAt = (sx: number, sy: number, advanceMs = 50) => {
        act(() => {
          canvas.dispatchEvent(
            Object.assign(
              new MouseEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: sx,
                clientY: sy,
              }),
              { pointerId: 11 },
            ),
          );
          canvas.dispatchEvent(
            Object.assign(
              new MouseEvent('pointerup', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: sx,
                clientY: sy,
              }),
              { pointerId: 11 },
            ),
          );
          if (advanceMs > 0) vi.advanceTimersByTime(advanceMs);
        });
      };

      const findHudClusterBtn = () =>
        Array.from(container.querySelectorAll('button')).find((b) =>
          b.textContent?.startsWith('子代理：'),
        );

      // Zoom below AUTO_COLLAPSE_ZOOM so cluster starts collapsed
      wheelBy(950);
      expect(curCam.zoom).toBeLessThan(AUTO_COLLAPSE_ZOOM);

      let anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, curCam, 1200, 720);
      let tailScreen = worldToScreen(tailMember.x, tailMember.y, curCam, 1200, 720);

      // 1) Click cluster to expand, then click empty canvas to collapse
      clickAt(anchorScreen.x, anchorScreen.y);
      expect(container.querySelector('[aria-label="星体详情抽屉"]')).not.toBeNull();
      expect(container.textContent).toContain('收起为伴星团');
      expect(findHudClusterBtn()?.textContent).toBe('子代理：收起 (1)');
      expect(findHudClusterBtn()?.getAttribute('aria-pressed')).toBe('true');
      expect(findHudClusterBtn()?.getAttribute('title')).toContain('伴星团');
      expect(findHudClusterBtn()?.getAttribute('title')).toContain('子代理');

      clickAt(20, 20);
      expect(container.querySelector('[aria-label="星体详情抽屉"]')).toBeNull();
      expect(findHudClusterBtn()?.textContent).toBe('子代理：星团');
      expect(findHudClusterBtn()?.getAttribute('aria-pressed')).toBe('false');

      moveTo(anchorScreen.x, anchorScreen.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      // Micro-star stays collapsed (not hit-testable)
      clickAt(tailScreen.x, tailScreen.y);
      expect(container.querySelector('[aria-label="星体详情抽屉"]')).toBeNull();

      // 2) Top HUD button collapses manual expansion (`子代理：收起 (1)` -> `子代理：星团`) and `子代理：展开` -> `子代理：星团`
      clickAt(anchorScreen.x, anchorScreen.y);
      expect(findHudClusterBtn()?.textContent).toBe('子代理：收起 (1)');
      act(() => {
        findHudClusterBtn()!.click();
      });
      expect(findHudClusterBtn()?.textContent).toBe('子代理：星团');
      expect(findHudClusterBtn()?.getAttribute('aria-pressed')).toBe('false');
      expect(container.textContent).not.toContain('收起为伴星团');
      expect(container.textContent).toContain('展开轨迹');
      moveTo(anchorScreen.x, anchorScreen.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      act(() => {
        findHudClusterBtn()!.click();
      });
      expect(findHudClusterBtn()?.textContent).toBe('子代理：展开');
      expect(findHudClusterBtn()?.getAttribute('aria-pressed')).toBe('true');
      moveTo(anchorScreen.x, anchorScreen.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent ?? '').not.toContain('伴星团');

      act(() => {
        findHudClusterBtn()!.click();
      });
      expect(findHudClusterBtn()?.textContent).toBe('子代理：星团');
      expect(findHudClusterBtn()?.getAttribute('aria-pressed')).toBe('false');
      moveTo(anchorScreen.x, anchorScreen.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      // 3) Wheel zoom-out below AUTO_COLLAPSE_ZOOM collapses manually expanded cluster
      const zoomToHysteresisDelta = -Math.log(1.0 / curCam.zoom) / 0.0012;
      wheelBy(zoomToHysteresisDelta);
      expect(curCam.zoom).toBeGreaterThan(AUTO_COLLAPSE_ZOOM);
      expect(curCam.zoom).toBeLessThan(AUTO_EXPAND_ZOOM);

      anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, curCam, 1200, 720);
      clickAt(anchorScreen.x, anchorScreen.y);
      expect(findHudClusterBtn()?.textContent).toBe('子代理：收起 (1)');
      expect(container.textContent).toContain('收起为伴星团');

      wheelBy(350);
      expect(curCam.zoom).toBeLessThan(AUTO_COLLAPSE_ZOOM);
      expect(findHudClusterBtn()?.textContent).toBe('子代理：星团');
      expect(container.textContent).not.toContain('收起为伴星团');
      expect(container.textContent).toContain('展开轨迹');

      anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, curCam, 1200, 720);
      moveTo(anchorScreen.x, anchorScreen.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      // 4) Reset view collapses manually expanded cluster
      clickAt(anchorScreen.x, anchorScreen.y);
      expect(findHudClusterBtn()?.textContent).toBe('子代理：收起 (1)');
      const resetBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === '重置全景',
      );
      expect(resetBtn).toBeDefined();
      act(() => {
        resetBtn!.click();
      });
      expect(findHudClusterBtn()?.textContent).toBe('子代理：星团');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps explicitly collapsed subagent clusters collapsed when zoom >= AUTO_EXPAND_ZOOM until zooming out or zooming in', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'high-zoom-suppress-conv',
        title: 'High Zoom Suppress Conv',
        subagent_calls_count: 1,
        requests: [
          makeRequest({
            id: 'high-zoom-suppress-conv:0',
            conversation_id: 'high-zoom-suppress-conv',
            session_id: 'high-zoom-suppress-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          ...Array.from({ length: 4 }, (_, k) =>
            makeRequest({
              id: `sub-hz:${k}`,
              conversation_id: 'high-zoom-suppress-conv',
              session_id: 'sub-hz',
              step_index: k,
              created_at: `2026-06-15T09:0${k + 1}:00Z`,
              model: 'gemini-2.5-flash',
              total_tokens: 1600,
              non_cache_tokens: 600,
              is_subagent: true,
              subagent_role: 'Researcher',
              parent_session_id: 'high-zoom-suppress-conv',
              parent_request_id: 'high-zoom-suppress-conv:0',
            }),
          ),
        ],
        subagents: [
          {
            id: 'sub-hz',
            role: 'Researcher',
            type_name: 'search',
            primary_model: 'gemini-2.5-flash',
            input_tokens: 1600,
            cache_read_tokens: 4000,
            output_tokens: 800,
            total_tokens: 6400,
            non_cache_tokens: 2400,
            last_status: 'COMPLETED',
            request_count: 4,
          },
        ],
      });

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      act(() => {
        root.render(
          <SkyTab
            stars={[conv]}
            tokenMode="total"
            privacyMode={false}
            highlightDate={null}
            focusStarId={null}
            onClearFocus={vi.fn()}
            onClearHighlightDate={vi.fn()}
            onJumpToStats={vi.fn()}
          />,
        );
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      const cluster = clusters[0];
      const tailMember = cluster.memberNodes[cluster.memberNodes.length - 1];
      const canvas = container.querySelector(
        'canvas[aria-label="TokenStar 交互式星空画布"]',
      ) as HTMLCanvasElement;
      expect(canvas).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      const curCam: CameraState = { ...computeFitCamera(nodes, 1200, 720) };
      const wheelBy = (deltaY: number, advanceMs = 900) => {
        act(() => {
          canvas.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: 600,
              clientY: 360,
              deltaY,
            }),
          );
          vi.advanceTimersByTime(advanceMs);
        });
        curCam.zoom = Math.min(7.5, Math.max(0.08, curCam.zoom * Math.exp(-deltaY * 0.0012)));
      };

      const moveTo = (sx: number, sy: number) => {
        act(() => {
          canvas.dispatchEvent(
            Object.assign(
              new MouseEvent('pointermove', {
                bubbles: true,
                cancelable: true,
                clientX: sx,
                clientY: sy,
              }),
              { pointerId: 12 },
            ),
          );
        });
      };

      const clickAt = (sx: number, sy: number, advanceMs = 50) => {
        act(() => {
          canvas.dispatchEvent(
            Object.assign(
              new MouseEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: sx,
                clientY: sy,
              }),
              { pointerId: 12 },
            ),
          );
          canvas.dispatchEvent(
            Object.assign(
              new MouseEvent('pointerup', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: sx,
                clientY: sy,
              }),
              { pointerId: 12 },
            ),
          );
          if (advanceMs > 0) vi.advanceTimersByTime(advanceMs);
        });
      };

      // Start zoomed in above AUTO_EXPAND_ZOOM so auto-LOD expands the cluster
      wheelBy(-250);
      expect(curCam.zoom).toBeGreaterThanOrEqual(AUTO_EXPAND_ZOOM);

      const anchorHigh = worldToScreen(cluster.anchorX, cluster.anchorY, curCam, 1200, 720);
      const tailHigh = worldToScreen(tailMember.x, tailMember.y, curCam, 1200, 720);

      // 1) Click auto-expanded micro-star, then click `收起为伴星团` while zoomed in
      clickAt(tailHigh.x, tailHigh.y);
      expect(container.textContent).toContain('收起为伴星团');
      const collapseHeaderBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === '收起为伴星团',
      );
      expect(collapseHeaderBtn).toBeDefined();
      act(() => {
        collapseHeaderBtn!.click();
        vi.advanceTimersByTime(2000);
      });

      expect(container.textContent).not.toContain('收起为伴星团');
      expect(container.textContent).toContain('展开轨迹');
      moveTo(anchorHigh.x, anchorHigh.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');
      clickAt(tailHigh.x, tailHigh.y);
      expect(container.textContent).not.toContain('收起为伴星团');

      // 2) Manually click collapsed cluster while zoomed in, then press Escape -> stays collapsed across rAF frames
      clickAt(anchorHigh.x, anchorHigh.y);
      expect(container.textContent).toContain('收起为伴星团');
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        vi.advanceTimersByTime(2000);
      });
      expect(container.querySelector('[aria-label="星体详情抽屉"]')).toBeNull();
      moveTo(anchorHigh.x, anchorHigh.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      // 3) Manually click collapsed cluster while zoomed in, then click empty canvas -> stays collapsed across rAF frames
      clickAt(anchorHigh.x, anchorHigh.y);
      expect(container.textContent).toContain('收起为伴星团');
      clickAt(20, 20, 2000);
      expect(container.querySelector('[aria-label="星体详情抽屉"]')).toBeNull();
      moveTo(anchorHigh.x, anchorHigh.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      // 4) Closing DetailDrawer on a subagent star while zoomed in -> stays collapsed across rAF frames
      clickAt(anchorHigh.x, anchorHigh.y);
      expect(container.textContent).toContain('收起为伴星团');
      const closeDrawerBtn = container.querySelector(
        'button[aria-label="关闭详情"]',
      ) as HTMLButtonElement | null;
      expect(closeDrawerBtn).not.toBeNull();
      act(() => {
        closeDrawerBtn!.click();
        vi.advanceTimersByTime(2000);
      });
      expect(container.querySelector('[aria-label="星体详情抽屉"]')).toBeNull();
      moveTo(anchorHigh.x, anchorHigh.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      // 5) Actively zooming in while >= AUTO_EXPAND_ZOOM clears suppression and re-enables auto-LOD
      wheelBy(-120, 900);
      expect(curCam.zoom).toBeGreaterThanOrEqual(AUTO_EXPAND_ZOOM);
      const anchorZoomedMore = worldToScreen(cluster.anchorX, cluster.anchorY, curCam, 1200, 720);
      const tailZoomedMore = worldToScreen(tailMember.x, tailMember.y, curCam, 1200, 720);
      moveTo(anchorZoomedMore.x, anchorZoomedMore.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent ?? '').not.toContain('伴星团');
      clickAt(tailZoomedMore.x, tailZoomedMore.y);
      expect(container.textContent).toContain('收起为伴星团');

      // 6) Collapse via Escape, zoom out < AUTO_COLLAPSE_ZOOM, then zoom back in >= AUTO_EXPAND_ZOOM -> auto-LOD resumes
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        vi.advanceTimersByTime(300);
      });
      moveTo(anchorZoomedMore.x, anchorZoomedMore.y);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('伴星团');

      wheelBy(1350, 900);
      expect(curCam.zoom).toBeLessThan(AUTO_COLLAPSE_ZOOM);
      wheelBy(-1350, 900);
      expect(curCam.zoom).toBeGreaterThanOrEqual(AUTO_EXPAND_ZOOM);

      const tailFinal = worldToScreen(tailMember.x, tailMember.y, curCam, 1200, 720);
      clickAt(tailFinal.x, tailFinal.y);
      expect(container.textContent).toContain('收起为伴星团');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fades in collapsed globular clusters during opening intro from t=0 to >4500ms', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'intro-cluster-conv',
        requests: [
          makeRequest({
            id: 'intro-cluster-conv:0',
            conversation_id: 'intro-cluster-conv',
            session_id: 'intro-cluster-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          makeRequest({
            id: 'intro-sub:0',
            conversation_id: 'intro-cluster-conv',
            session_id: 'intro-sub',
            step_index: 0,
            created_at: '2026-06-15T09:01:00Z',
            is_subagent: true,
            subagent_role: 'explorer',
            parent_session_id: 'intro-cluster-conv',
            parent_request_id: 'intro-cluster-conv:0',
          }),
        ],
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      expect(clusters).toHaveLength(1);
      const cluster = clusters[0];
      const fixedCam: CameraState = { x: 0, y: 0, zoom: 1.0 };
      const mainNode = nodes.find((n) => !n.request.is_subagent)!;
      const mainScreen = worldToScreen(mainNode.x, mainNode.y, fixedCam, 1200, 720);
      const anchorScreen = worldToScreen(cluster.anchorX, cluster.anchorY, fixedCam, 1200, 720);

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const shared2dCtx = makeMockCanvasContext();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) =>
        contextId === '2d' ? (shared2dCtx as unknown as RenderingContext) : null,
      );

      act(() => {
        root.render(
          <StarCanvas
            nodes={nodes}
            clusters={clusters}
            expandedClusterIds={new Set()}
            matchingIds={null}
            hasActiveFilter={false}
            selectedStarId={null}
            hoveredStarId={null}
            highlightDate={null}
            playbackVisibleCount={null}
            cameraRequest={{ id: 1, camera: fixedCam }}
            showNebulae={false}
            onHoverStar={vi.fn()}
            onSelectStar={vi.fn()}
            onResetView={vi.fn()}
          />,
        );
      });

      // Warm up offscreen backdrop cache on frame 1 (t=16ms), then inspect early intro frame (t=32ms, webglIntro ~ 0)
      act(() => {
        vi.advanceTimersByTime(16);
      });
      shared2dCtx.createRadialGradient.mockClear();
      shared2dCtx.arc.mockClear();
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const earlyMainGrads = shared2dCtx.createRadialGradient.mock.calls.filter(
        (c) => Math.hypot(Number(c[0]) - mainScreen.x, Number(c[1]) - mainScreen.y) < 1,
      );
      const earlyClusterGrads = shared2dCtx.createRadialGradient.mock.calls.filter(
        (c) => Math.hypot(Number(c[0]) - anchorScreen.x, Number(c[1]) - anchorScreen.y) < 1,
      );
      const earlyClusterArcs = shared2dCtx.arc.mock.calls.filter(
        (c) => Math.hypot(Number(c[0]) - anchorScreen.x, Number(c[1]) - anchorScreen.y) < 30,
      );
      expect(earlyMainGrads.length).toBeGreaterThanOrEqual(1);
      expect(earlyClusterGrads).toHaveLength(0);
      expect(earlyClusterArcs).toHaveLength(0);

      // After > 4500ms (webglIntro = 1): cluster fades in and draws halo + core radial gradients & stipple arcs
      act(() => {
        vi.advanceTimersByTime(4600);
      });
      shared2dCtx.createRadialGradient.mockClear();
      shared2dCtx.arc.mockClear();
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const lateClusterGrads = shared2dCtx.createRadialGradient.mock.calls.filter(
        (c) => Math.hypot(Number(c[0]) - anchorScreen.x, Number(c[1]) - anchorScreen.y) < 1,
      );
      const lateClusterArcs = shared2dCtx.arc.mock.calls.filter(
        (c) => Math.hypot(Number(c[0]) - anchorScreen.x, Number(c[1]) - anchorScreen.y) < 30,
      );
      expect(lateClusterGrads.length).toBeGreaterThanOrEqual(2);
      expect(lateClusterArcs.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('punches out star cores with destination-out and draws captions cleanly in live mock GPU render path', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'gpu-punchout-conv',
        title: 'Live GPU Knockout Test',
        requests: [
          makeRequest({
            id: 'gpu-punchout-conv:0',
            conversation_id: 'gpu-punchout-conv',
            session_id: 'gpu-punchout-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          makeRequest({
            id: 'gpu-punchout-conv:1',
            conversation_id: 'gpu-punchout-conv',
            session_id: 'gpu-punchout-conv',
            step_index: 1,
            created_at: '2026-06-15T09:01:00Z',
          }),
          makeRequest({
            id: 'gpu-punchout-sub:0',
            conversation_id: 'gpu-punchout-conv',
            session_id: 'gpu-punchout-sub',
            step_index: 0,
            created_at: '2026-06-15T09:02:00Z',
            is_subagent: true,
            subagent_role: 'explorer',
            parent_session_id: 'gpu-punchout-conv',
            parent_request_id: 'gpu-punchout-conv:0',
          }),
        ],
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      const fixedCam: CameraState = { x: 0, y: 0, zoom: 1.0 };

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const compositeOps: string[] = [];
      const shared2dCtx = makeMockCanvasContext();
      let currentCompOp = 'source-over';
      Object.defineProperty(shared2dCtx, 'globalCompositeOperation', {
        get: () => currentCompOp,
        set: (val: string) => {
          currentCompOp = val;
          compositeOps.push(val);
        },
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) =>
        contextId === '2d' ? (shared2dCtx as unknown as RenderingContext) : null,
      );

      const glRenderMock = vi.fn();
      const glDisposeMock = vi.fn();
      vi.spyOn(WebGLSkyRenderer, 'create').mockReturnValue({
        render: glRenderMock,
        dispose: glDisposeMock,
      } as unknown as WebGLSkyRenderer);

      act(() => {
        root.render(
          <StarCanvas
            nodes={nodes}
            clusters={clusters}
            expandedClusterIds={new Set()}
            matchingIds={null}
            hasActiveFilter={false}
            selectedStarId={nodes[0].id}
            hoveredStarId={null}
            highlightDate={null}
            playbackVisibleCount={null}
            cameraRequest={{ id: 1, camera: fixedCam }}
            showConstellations={true}
            showNebulae={true}
            onHoverStar={vi.fn()}
            onSelectStar={vi.fn()}
            onResetView={vi.fn()}
          />,
        );
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(glRenderMock).toHaveBeenCalled();
      expect(compositeOps).toContain('destination-out');
      expect(shared2dCtx.fillText).toHaveBeenCalled();

      act(() => {
        root.unmount();
      });
      expect(glDisposeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws expanded companion nebulae and active conversation aura AFTER destination-out star knockout in GPU mode', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'gpu-nebula-order-conv',
        title: 'GPU Order Test',
        requests: [
          makeRequest({
            id: 'gpu-nebula-order-conv:0',
            conversation_id: 'gpu-nebula-order-conv',
            session_id: 'gpu-nebula-order-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
          makeRequest({
            id: 'gpu-nebula-order-conv:1',
            conversation_id: 'gpu-nebula-order-conv',
            session_id: 'gpu-nebula-order-conv',
            step_index: 1,
            created_at: '2026-06-15T09:01:00Z',
          }),
          makeRequest({
            id: 'gpu-nebula-order-sub:0',
            conversation_id: 'gpu-nebula-order-conv',
            session_id: 'gpu-nebula-order-sub',
            step_index: 0,
            created_at: '2026-06-15T09:02:00Z',
            is_subagent: true,
            subagent_role: 'explorer',
            parent_session_id: 'gpu-nebula-order-conv',
            parent_request_id: 'gpu-nebula-order-conv:0',
          }),
          makeRequest({
            id: 'gpu-nebula-order-sub:1',
            conversation_id: 'gpu-nebula-order-conv',
            session_id: 'gpu-nebula-order-sub',
            step_index: 1,
            created_at: '2026-06-15T09:03:00Z',
            is_subagent: true,
            subagent_role: 'explorer',
          }),
        ],
      });

      const nodes = computeStarPositions([conv], 'total');
      const clusters = buildSubagentClusters(nodes, 'total');
      expect(clusters).toHaveLength(1);
      const cluster = clusters[0];
      const fixedCam: CameraState = { x: 0, y: 0, zoom: 1.0 };

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const frameOps: string[] = [];
      const shared2dCtx = makeMockCanvasContext();
      let currentCompOp = 'source-over';
      Object.defineProperty(shared2dCtx, 'globalCompositeOperation', {
        get: () => currentCompOp,
        set: (val: string) => {
          currentCompOp = val;
          frameOps.push(`comp:${val}`);
        },
      });
      shared2dCtx.clearRect.mockImplementation(() => {
        frameOps.push('clearRect');
      });
      shared2dCtx.lineTo.mockImplementation(() => {
        frameOps.push('lineTo');
      });
      shared2dCtx.quadraticCurveTo.mockImplementation(() => {
        frameOps.push('quadraticCurveTo');
      });
      shared2dCtx.ellipse.mockImplementation(() => {
        frameOps.push('ellipse');
      });
      shared2dCtx.fillText.mockImplementation((text: unknown) => {
        frameOps.push(`fillText:${String(text)}`);
      });
      const convCenterScreen = worldToScreen(
        nodes[0].convCenterX,
        nodes[0].convCenterY,
        fixedCam,
        1200,
        720,
      );
      shared2dCtx.createRadialGradient.mockImplementation(
        (x0?: number, y0?: number) => {
          if (
            currentCompOp === 'source-over' &&
            typeof x0 === 'number' &&
            typeof y0 === 'number' &&
            Math.hypot(x0 - convCenterScreen.x, y0 - convCenterScreen.y) < 1
          ) {
            frameOps.push('auraGrad');
          } else {
            frameOps.push('otherGrad');
          }
          return { addColorStop: vi.fn() };
        },
      );

      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) =>
        contextId === '2d' ? (shared2dCtx as unknown as RenderingContext) : null,
      );

      const glRenderMock = vi.fn();
      const glDisposeMock = vi.fn();
      vi.spyOn(WebGLSkyRenderer, 'create').mockReturnValue({
        render: glRenderMock,
        dispose: glDisposeMock,
      } as unknown as WebGLSkyRenderer);

      act(() => {
        root.render(
          <StarCanvas
            nodes={nodes}
            clusters={clusters}
            expandedClusterIds={new Set([cluster.id])}
            matchingIds={null}
            hasActiveFilter={false}
            selectedStarId={nodes[0].id}
            hoveredStarId={null}
            highlightDate={null}
            playbackVisibleCount={null}
            cameraRequest={{ id: 1, camera: fixedCam }}
            showConstellations={true}
            showNebulae={true}
            onHoverStar={vi.fn()}
            onSelectStar={vi.fn()}
            onResetView={vi.fn()}
          />,
        );
      });

      // Settle intro & cluster expansion animation to animP = 1, then trace one full frame
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      frameOps.length = 0;
      act(() => {
        vi.advanceTimersByTime(16);
      });

      const lastKnockoutIdx = frameOps.lastIndexOf('comp:destination-out');
      const firstEdgeIdx = frameOps.indexOf('lineTo');
      const firstBridgeIdx = frameOps.indexOf('quadraticCurveTo');
      const companionGlowIdx = frameOps.indexOf('comp:lighter');
      const firstEllipseIdx = frameOps.indexOf('ellipse');
      const auraGradIdx = frameOps.indexOf('auraGrad');
      const captionIdx = frameOps.indexOf('fillText:GPU Order Test');

      expect(lastKnockoutIdx).toBeGreaterThan(-1);
      expect(firstEdgeIdx).toBeGreaterThan(-1);
      expect(firstBridgeIdx).toBeGreaterThan(-1);
      expect(companionGlowIdx).toBeGreaterThan(lastKnockoutIdx);
      expect(firstEllipseIdx).toBeGreaterThan(lastKnockoutIdx);
      expect(auraGradIdx).toBeGreaterThan(lastKnockoutIdx);
      expect(captionIdx).toBeGreaterThan(auraGradIdx);
      expect(firstEdgeIdx).toBeLessThan(lastKnockoutIdx);
      expect(firstBridgeIdx).toBeLessThan(lastKnockoutIdx);
      expect(frameOps.slice(companionGlowIdx)).not.toContain('comp:destination-out');

      act(() => {
        root.unmount();
      });
      expect(glDisposeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes deep-zoom-out factor monotonically from referenceZoom without altering default/zoom-in views', () => {
    expect(computeDeepOut).toBe(computeDeepOutFromWebGL);

    const refZoom = 1.25;
    expect(computeDeepOut(refZoom, refZoom)).toBe(0);
    expect(computeDeepOut(refZoom * 2.0, refZoom)).toBe(0);
    expect(computeDeepOut(refZoom * 0.96, refZoom)).toBe(0);

    const midHigh = computeDeepOut(refZoom * 0.75, refZoom);
    const mid = computeDeepOut(refZoom * 0.55, refZoom);
    const midLow = computeDeepOut(refZoom * 0.35, refZoom);
    expect(midHigh).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(midHigh);
    expect(midLow).toBeGreaterThan(mid);
    expect(midLow).toBeLessThan(1);

    expect(computeDeepOut(refZoom * 0.24, refZoom)).toBe(1);
    expect(computeDeepOut(0.08, refZoom)).toBe(1);
    expect(computeDeepOut(0.02, 0.04)).toBe(1);
    expect(computeDeepOut(0.10, 0.04)).toBe(0);
  });

  it('smoothly animates wheel zoom in log space without 0ms snap while pinning cursor world anchor', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'smooth-wheel-conv',
        requests: [
          makeRequest({
            id: 'smooth-wheel-conv:0',
            conversation_id: 'smooth-wheel-conv',
            session_id: 'smooth-wheel-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
        ],
      });
      const nodes = computeStarPositions([conv], 'total');
      const initialCam: CameraState = { x: 120, y: -40, zoom: 0.8 };

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const onCameraChange = vi.fn();
      act(() => {
        root.render(
          <StarCanvas
            nodes={nodes}
            clusters={[]}
            matchingIds={null}
            hasActiveFilter={false}
            selectedStarId={null}
            hoveredStarId={null}
            highlightDate={null}
            playbackVisibleCount={null}
            cameraRequest={{ id: 1, camera: initialCam }}
            onCameraChange={onCameraChange}
            onHoverStar={vi.fn()}
            onSelectStar={vi.fn()}
            onResetView={vi.fn()}
          />,
        );
      });

      act(() => {
        vi.advanceTimersByTime(2500);
      });

      const canvas = container.querySelector(
        'canvas[aria-label="TokenStar 交互式星空画布"]',
      ) as HTMLCanvasElement;
      expect(canvas).not.toBeNull();

      const cursorX = 870;
      const cursorY = 210;
      const anchorWorld = screenToWorld(cursorX, cursorY, initialCam, 1200, 720);
      const expectedTargetZoom = initialCam.zoom * Math.exp(-(-450) * 0.0012);

      onCameraChange.mockClear();
      act(() => {
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: cursorX,
            clientY: cursorY,
            deltaY: -450,
          }),
        );
      });

      // Must NOT snap camera synchronously on wheel dispatch
      expect(onCameraChange).not.toHaveBeenCalled();

      // Advance one short slice (~48ms): zoom moves partway toward target & anchor stays pinned
      act(() => {
        vi.advanceTimersByTime(48);
      });
      expect(onCameraChange).toHaveBeenCalled();
      const midCam1 = onCameraChange.mock.calls[onCameraChange.mock.calls.length - 1][0] as CameraState;
      expect(midCam1.zoom).toBeGreaterThan(initialCam.zoom);
      expect(midCam1.zoom).toBeLessThan(expectedTargetZoom);
      const midScreen1 = worldToScreen(anchorWorld.x, anchorWorld.y, midCam1, 1200, 720);
      expect(midScreen1.x).toBeCloseTo(cursorX, 4);
      expect(midScreen1.y).toBeCloseTo(cursorY, 4);

      // Advance another ~48ms: zoom continues smoothly approaching target while keeping anchor fixed
      act(() => {
        vi.advanceTimersByTime(48);
      });
      const midCam2 = onCameraChange.mock.calls[onCameraChange.mock.calls.length - 1][0] as CameraState;
      expect(midCam2.zoom).toBeGreaterThan(midCam1.zoom);
      expect(midCam2.zoom).toBeLessThan(expectedTargetZoom);
      const midScreen2 = worldToScreen(anchorWorld.x, anchorWorld.y, midCam2, 1200, 720);
      expect(midScreen2.x).toBeCloseTo(cursorX, 4);
      expect(midScreen2.y).toBeCloseTo(cursorY, 4);

      // Settle completely
      act(() => {
        vi.advanceTimersByTime(900);
      });
      const settledCam = onCameraChange.mock.calls[onCameraChange.mock.calls.length - 1][0] as CameraState;
      expect(settledCam.zoom).toBeCloseTo(expectedTargetZoom, 4);
      const settledScreen = worldToScreen(anchorWorld.x, anchorWorld.y, settledCam, 1200, 720);
      expect(settledScreen.x).toBeCloseTo(cursorX, 3);
      expect(settledScreen.y).toBeCloseTo(cursorY, 3);

      // Line-mode wheel (deltaMode === 1) normalizes deltaY * 16 and accumulates onto active target
      const lineBaseZoom = settledCam.zoom;
      const expectedLineZoom = lineBaseZoom * Math.exp(-(20 * 16) * 0.0012);
      act(() => {
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: cursorX,
            clientY: cursorY,
            deltaY: 10,
            deltaMode: 1,
          }),
        );
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: cursorX,
            clientY: cursorY,
            deltaY: 10,
            deltaMode: 1,
          }),
        );
        vi.advanceTimersByTime(900);
      });
      const afterLineCam = onCameraChange.mock.calls[onCameraChange.mock.calls.length - 1][0] as CameraState;
      expect(afterLineCam.zoom).toBeCloseTo(expectedLineZoom, 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes default-fit referenceZoom to WebGL renderer and compresses star radii only during deep zoom-out', () => {
    vi.useFakeTimers();
    try {
      const conv = makeStar({
        id: 'deep-zoom-webgl-conv',
        requests: [
          makeRequest({
            id: 'deep-zoom-webgl-conv:0',
            conversation_id: 'deep-zoom-webgl-conv',
            session_id: 'deep-zoom-webgl-conv',
            step_index: 0,
            created_at: '2026-06-15T09:00:00Z',
          }),
        ],
      });
      const nodes = computeStarPositions([conv], 'total');
      const fitCam = computeFitCamera(nodes, 1200, 720);

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1200,
        height: 720,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const shared2dCtx = makeMockCanvasContext();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) =>
        contextId === '2d' ? (shared2dCtx as unknown as RenderingContext) : null,
      );

      const glRenderMock = vi.fn();
      const glDisposeMock = vi.fn();
      vi.spyOn(WebGLSkyRenderer, 'create').mockReturnValue({
        render: glRenderMock,
        dispose: glDisposeMock,
      } as unknown as WebGLSkyRenderer);

      act(() => {
        root.render(
          <StarCanvas
            nodes={nodes}
            clusters={[]}
            matchingIds={null}
            hasActiveFilter={false}
            selectedStarId={null}
            hoveredStarId={null}
            highlightDate={null}
            playbackVisibleCount={null}
            cameraRequest={{ id: 1, camera: fitCam }}
            onHoverStar={vi.fn()}
            onSelectStar={vi.fn()}
            onResetView={vi.fn()}
          />,
        );
      });

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(glRenderMock).toHaveBeenCalled();
      const defaultFrame = glRenderMock.mock.calls[glRenderMock.mock.calls.length - 1][0];
      expect(defaultFrame.referenceZoom).toBeCloseTo(fitCam.zoom, 6);
      expect(computeDeepOut(defaultFrame.camera.zoom, defaultFrame.referenceZoom)).toBe(0);
      expect(defaultFrame.stars[0].sr).toBeCloseTo(nodes[0].radius * getVisualScale(fitCam.zoom), 5);

      // Jump to minimum zoom (0.08): referenceZoom stays fitCam.zoom and star sr compresses by (1 - deepOut * 0.44)
      glRenderMock.mockClear();
      act(() => {
        root.render(
          <StarCanvas
            nodes={nodes}
            clusters={[]}
            matchingIds={null}
            hasActiveFilter={false}
            selectedStarId={null}
            hoveredStarId={null}
            highlightDate={null}
            playbackVisibleCount={null}
            cameraRequest={{ id: 2, camera: { x: fitCam.x, y: fitCam.y, zoom: 0.08 } }}
            onHoverStar={vi.fn()}
            onSelectStar={vi.fn()}
            onResetView={vi.fn()}
          />,
        );
      });
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      const minZoomFrame = glRenderMock.mock.calls[glRenderMock.mock.calls.length - 1][0];
      expect(minZoomFrame.referenceZoom).toBeCloseTo(fitCam.zoom, 6);
      const expectedDeepOut = computeDeepOut(0.08, fitCam.zoom);
      expect(expectedDeepOut).toBeGreaterThan(0);
      expect(minZoomFrame.stars[0].sr).toBeCloseTo(
        Math.max(0.72, nodes[0].radius * getVisualScale(0.08) * (1 - expectedDeepOut * 0.44)),
        5,
      );

      act(() => {
        root.unmount();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
