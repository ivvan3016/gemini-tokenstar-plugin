import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationStar, RequestStar } from '../types/sky';
import { computeStarPositions } from '../logic/starLayout';
import {
  StarCanvas,
  buildConstellationSegments,
  computeFitCamera,
  exportSkyPng,
  generateBackgroundDust,
  hitTestStar,
  screenToWorld,
  worldToScreen,
  type CameraState,
} from '../components/sky/StarCanvas';
import { DetailDrawer } from '../components/sky/DetailDrawer';
import { PlaybackBar } from '../components/sky/PlaybackBar';
import { SkyTab } from '../components/sky/SkyTab';

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
    createRadialGradient: vi.fn(() => gradientStub),
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
});
