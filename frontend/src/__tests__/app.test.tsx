import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationStar,
  SkyDataResponse,
  SourceScanReport,
  UpdateApplyResult,
  UpdateCheckResult,
} from '../types/sky';
import type { DataTransport } from '../services/transport';
import { TopBar } from '../components/TopBar';
import { StarHeatmap } from '../components/stats/StarHeatmap';
import { UsageTables } from '../components/stats/UsageTables';
import { StatsTab } from '../components/stats/StatsTab';
import { App } from '../App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeStar(overrides: Partial<ConversationStar> = {}): ConversationStar {
  const input = overrides.input_tokens ?? 1200;
  const cache = overrides.cache_read_tokens ?? 4800;
  const output = overrides.output_tokens ?? 600;
  const primaryModel = overrides.primary_model ?? 'gemini-2.5-pro';
  return {
    id: 'conv-alpha-1',
    source: 'antigravity',
    title: 'Confidential Architecture Review',
    started_at: '2026-06-15T09:00:00Z',
    ended_at: '2026-06-15T09:20:00Z',
    local_date: '2026-06-15',
    primary_model: primaryModel,
    models: overrides.models ?? [
      {
        model: primaryModel,
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
    user_turns: 4,
    model_steps_count: 5,
    tool_calls_count: 8,
    subagent_calls_count: 0,
    subagents: [],
    is_orphan_subagent: false,
    error_steps_count: 0,
    last_status: 'COMPLETED',
    celestial_type: 'star',
    celestial_reason: '常规深度对话（4 轮交互）',
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceScanReport> = {}): SourceScanReport {
  return {
    source: 'antigravity',
    directory: 'C:/Users/demo/.gemini/antigravity/brain',
    exists: true,
    scanned_files: 3,
    parsed_conversations: 3,
    skipped_files: 0,
    warnings: [],
    ...overrides,
  };
}

function makeSkyResponse(
  conversations: ConversationStar[],
  overrides: Partial<SkyDataResponse> = {},
): SkyDataResponse {
  return {
    schema_version: '1.0',
    generated_at: '2026-06-16T12:34:56Z',
    scan_duration_ms: 18,
    sources: [makeSource({ parsed_conversations: conversations.length })],
    conversations,
    ...overrides,
  };
}

function makeMockCanvasContext() {
  const gradientStub = { addColorStop: vi.fn() };
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

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  );
}

describe('TopBar, StarHeatmap, UsageTables, StatsTab & App Integration', () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders TopBar controls, toggles modes, and shows non-blocking warnings popover', () => {
    const onTabChange = vi.fn();
    const onTokenModeChange = vi.fn();
    const onTogglePrivacy = vi.fn();
    const onRefresh = vi.fn();

    act(() => {
      root.render(
        <TopBar
          activeTab="sky"
          onTabChange={onTabChange}
          tokenMode="total"
          onTokenModeChange={onTokenModeChange}
          privacyMode={false}
          onTogglePrivacy={onTogglePrivacy}
          lastUpdatedAt="2026-06-16T08:05:09"
          sources={[
            makeSource({
              warnings: ['Skipped unreadable directory: locked-conv'],
            }),
          ]}
          isRefreshing={false}
          onRefresh={onRefresh}
        />,
      );
    });

    expect(container.textContent).toContain('TokenStar');
    expect(container.textContent).toContain('✦ 星空');
    expect(container.textContent).toContain('◈ 统计');
    expect(container.textContent).toContain('含缓存');
    expect(container.textContent).toContain('仅新增');
    expect(container.textContent).toContain('隐私模式');
    expect(container.textContent).toContain('最近更新于 08:05:09');

    act(() => {
      findButtonByText(container, '◈ 统计')?.click();
      findButtonByText(container, '仅新增')?.click();
      findButtonByText(container, '隐私模式')?.click();
      findButtonByText(container, '刷新')?.click();
    });

    expect(onTabChange).toHaveBeenCalledWith('stats');
    expect(onTokenModeChange).toHaveBeenCalledWith('non_cache');
    expect(onTogglePrivacy).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const warnBtn = container.querySelector('button[aria-label="扫描警告"]') as HTMLButtonElement | null;
    expect(warnBtn).not.toBeNull();
    act(() => {
      warnBtn!.click();
    });
    expect(container.textContent).toContain('Skipped unreadable directory: locked-conv');
  });

  it('renders StarHeatmap with year switch, hover tooltip, date selection, and sky highlight action', () => {
    const stars = [
      makeStar({ id: 'y25', local_date: '2025-11-10', started_at: '2025-11-10T10:00:00Z' }),
      makeStar({ id: 'y26-1', local_date: '2026-06-15', started_at: '2026-06-15T09:00:00Z', total_tokens: 6600 }),
      makeStar({ id: 'y26-2', local_date: '2026-06-15', started_at: '2026-06-15T14:00:00Z', total_tokens: 3400 }),
    ];
    const onSelectDate = vi.fn();
    const onHighlightDateInSky = vi.fn();

    act(() => {
      root.render(
        <StarHeatmap
          stars={stars}
          tokenMode="total"
          selectedDate="2026-06-15"
          onSelectDate={onSelectDate}
          onHighlightDateInSky={onHighlightDateInSky}
        />,
      );
    });

    expect(container.textContent).toContain('2026');
    expect(container.textContent).toContain('2025');

    const dayBtn = container.querySelector(
      'button[data-date="2026-06-15"]',
    ) as HTMLButtonElement | null;
    expect(dayBtn).not.toBeNull();

    // Hover triggers tooltip text
    act(() => {
      dayBtn!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.textContent).toContain('2026-06-15 · 2 次对话 · 10,000 Tokens');

    // Clicking selected date toggles it off (calls onSelectDate(null))
    act(() => {
      dayBtn!.click();
    });
    expect(onSelectDate).toHaveBeenCalledWith(null);

    // Quick button in header calls onHighlightDateInSky
    const highlightBtn = findButtonByText(container, '在星空页高亮这一天');
    expect(highlightBtn).toBeDefined();
    act(() => {
      highlightBtn!.click();
    });
    expect(onHighlightDateInSky).toHaveBeenCalledWith('2026-06-15');

    // Switch year to 2025
    const year2025Btn = findButtonByText(container, '2025');
    expect(year2025Btn).toBeDefined();
    act(() => {
      year2025Btn!.click();
    });
    expect(container.querySelector('button[data-date="2025-11-10"]')).not.toBeNull();
  });

  it('renders StatsTab KPI cards, diagnostics, and UsageTables 3 views with privacy masking & sorting', () => {
    const stars = [
      makeStar({
        id: 's1',
        title: 'Secret Payment Gateway',
        started_at: '2026-06-14T08:00:00Z',
        ended_at: '2026-06-14T08:15:00Z',
        local_date: '2026-06-14',
        primary_model: 'gemini-2.5-pro',
        input_tokens: 1000,
        cache_read_tokens: 4000,
        output_tokens: 500,
        total_tokens: 5500,
        non_cache_tokens: 1500,
        user_turns: 3,
        tool_calls_count: 5,
        celestial_type: 'star',
      }),
      makeStar({
        id: 's2',
        title: 'Public Quick Prompt',
        started_at: '2026-06-15T10:00:00Z',
        ended_at: '2026-06-15T10:02:00Z',
        local_date: '2026-06-15',
        primary_model: 'gemini-2.5-flash',
        models: [
          {
            model: 'gemini-2.5-flash',
            input_tokens: 200,
            cache_read_tokens: 800,
            output_tokens: 100,
            total_tokens: 1100,
            steps: 2,
          },
        ],
        input_tokens: 200,
        cache_read_tokens: 800,
        output_tokens: 100,
        total_tokens: 1100,
        non_cache_tokens: 300,
        user_turns: 1,
        tool_calls_count: 20,
        celestial_type: 'pulsar',
      }),
    ];

    const onLocate = vi.fn();
    const onHighlightDate = vi.fn();

    act(() => {
      root.render(
        <StatsTab
          stars={stars}
          sources={[makeSource({ parsed_conversations: 2, warnings: ['Minor parse notice'] })]}
          scanDurationMs={24}
          tokenMode="total"
          privacyMode={true}
          onLocateStarInSky={onLocate}
          onHighlightDateInSky={onHighlightDate}
        />,
      );
    });

    // 4 KPI cards & zero USD/CNY cost strings
    expect(container.textContent).toContain('累计 Token');
    expect(container.textContent).toContain('6,600');
    expect(container.textContent).toContain('仅新增');
    expect(container.textContent).toContain('1,800');
    expect(container.textContent).toContain('Token 构成与缓存命中率');
    expect(container.textContent).toContain('缓存命中率 80.0%');
    expect(container.textContent).toContain('点亮天体总数');
    expect(container.textContent).toContain('颗星体 · 2 个星座');
    expect(container.textContent).toContain('活跃节奏');
    expect(container.textContent).toContain('最长连续 2 天');
    expect(container.textContent).not.toMatch(/USD|CNY|\$/);

    // Privacy mode masks titles in conversation table
    expect(container.textContent).toContain('星体 #001');
    expect(container.textContent).toContain('星体 #002');
    expect(container.textContent).not.toContain('Secret Payment Gateway');
    expect(container.textContent).not.toContain('Public Quick Prompt');

    // Locate star button
    const locateBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('定位星体'),
    );
    expect(locateBtns.length).toBe(2);
    act(() => {
      locateBtns[0].click();
    });
    // Default sort is time desc so s2 (June 15) is first
    expect(onLocate).toHaveBeenCalledWith('s2');

    // Switch to 按天汇总
    act(() => {
      findButtonByText(container, '按天汇总')?.click();
    });
    expect(container.textContent).toContain('2026-06-15');
    expect(container.textContent).toContain('2026-06-14');
    const highlightDayBtn = findButtonByText(container, '高亮当天星群');
    expect(highlightDayBtn).toBeDefined();
    act(() => {
      highlightDayBtn!.click();
    });
    expect(onHighlightDate).toHaveBeenCalledWith('2026-06-15');

    // Switch to 按模型汇总
    act(() => {
      findButtonByText(container, '按模型汇总')?.click();
    });
    expect(container.textContent).toContain('gemini-2.5-pro');
    expect(container.textContent).toContain('gemini-2.5-flash');

    // Diagnostics footer expandable
    expect(container.textContent).toContain('C:/Users/demo/.gemini/antigravity/brain');
    expect(container.textContent).toContain('24 ms');
    const diagBtn = findButtonByText(container, '展开诊断');
    expect(diagBtn).toBeDefined();
    act(() => {
      diagBtn!.click();
    });
    expect(container.textContent).toContain('Minor parse notice');
  });

  it('supports App mount, cross-tab sky<->stats navigation, manual refresh, and 30s silent poll', async () => {
    vi.useFakeTimers();

    const star1 = makeStar({
      id: 'star-1',
      title: 'Alpha Nebula Task',
      local_date: '2026-06-15',
      started_at: '2026-06-15T09:00:00Z',
    });
    const star2 = makeStar({
      id: 'star-2',
      title: 'Beta Pulsar Task',
      local_date: '2026-06-16',
      started_at: '2026-06-16T11:00:00Z',
      celestial_type: 'pulsar',
      tool_calls_count: 18,
    });

    const getSkyData = vi
      .fn<() => Promise<SkyDataResponse>>()
      .mockResolvedValueOnce(makeSkyResponse([star1], { generated_at: '2026-06-16T12:00:00Z' }))
      // First 30s poll: identical data, new timestamp -> no toast
      .mockResolvedValueOnce(makeSkyResponse([star1], { generated_at: '2026-06-16T12:00:30Z' }))
      // Second 30s poll: new star appears -> toast + UI updates
      .mockResolvedValueOnce(
        makeSkyResponse([star1, star2], { generated_at: '2026-06-16T12:01:00Z' }),
      );

    const refresh = vi
      .fn<() => Promise<SkyDataResponse>>()
      .mockResolvedValue(
        makeSkyResponse([star1, star2], { generated_at: '2026-06-16T12:01:10Z' }),
      );
    const dispose = vi.fn();

    const transport: DataTransport = {
      mode: 'http',
      getSkyData,
      refresh,
      dispose,
    };

    const transportFactory = vi.fn().mockResolvedValue(transport);

    await act(async () => {
      root.render(<App transportFactory={transportFactory} pollIntervalMs={30_000} />);
    });

    expect(getSkyData).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('共 1 颗星体');

    // First 30s silent poll: unchanged conversations -> no toast
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getSkyData).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('星空已点亮');

    // Second 30s silent poll: new conversation -> toast appears & count updates
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getSkyData).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('共 2 颗星体');
    expect(container.textContent).toContain('星空已点亮');

    // Switch to Stats tab -> click day in Heatmap -> highlight in Sky tab
    act(() => {
      findButtonByText(container, '◈ 统计')?.click();
    });
    expect(container.textContent).toContain('累计 Token');

    const june16Cell = container.querySelector('button[data-date="2026-06-16"]') as HTMLButtonElement | null;
    expect(june16Cell).not.toBeNull();
    act(() => {
      june16Cell!.click();
    });
    const highlightBtn = findButtonByText(container, '在星空页高亮这一天');
    expect(highlightBtn).toBeDefined();
    act(() => {
      highlightBtn!.click();
    });
    expect(container.textContent).toContain('✦ 高亮 2026-06-16');

    // Switch to Stats -> Locate star-1 -> opens DetailDrawer in Sky -> jump back to Stats
    act(() => {
      findButtonByText(container, '◈ 统计')?.click();
    });
    const locateBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('定位星体'),
    );
    // star-2 is newer (row 0), star-1 is row 1
    expect(locateBtns.length).toBe(2);
    act(() => {
      locateBtns[1].click();
    });
    expect(container.textContent).toContain('Alpha Nebula Task');

    const jumpStatsBtn = findButtonByText(container, '在统计列表中查看');
    expect(jumpStatsBtn).toBeDefined();
    act(() => {
      jumpStatsBtn!.click();
    });
    expect(container.textContent).toContain('按对话');
    const highlightedRow = container.querySelector('[data-star-id="star-1"].is-highlighted');
    expect(highlightedRow).not.toBeNull();

    // Toggle global tokenMode to non_cache ('仅新增') -> KPI total switches immediately (13,200 -> 3,600)
    expect(container.textContent).toContain('13,200');
    act(() => {
      findButtonByText(container, '仅新增')?.click();
    });
    expect(container.textContent).toContain('3,600');

    // Toggle global privacyMode -> titles mask cleanly across StatsTab
    expect(container.textContent).toContain('Alpha Nebula Task');
    act(() => {
      findButtonByText(container, '隐私模式')?.click();
    });
    expect(container.textContent).not.toContain('Alpha Nebula Task');
    expect(container.textContent).toContain('星体 #001');

    // Manual refresh calls transport.refresh()
    await act(async () => {
      findButtonByText(container, '刷新')?.click();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Unmount disposes transport
    act(() => {
      root.unmount();
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    // Re-create root for afterEach cleanup safety
    root = createRoot(container);
  });

  it('shows recoverable error screen when initial load fails and retries cleanly', async () => {
    const getSkyData = vi
      .fn<() => Promise<SkyDataResponse>>()
      .mockRejectedValueOnce(new Error('Scan connection refused'));
    const refresh = vi
      .fn<() => Promise<SkyDataResponse>>()
      .mockResolvedValueOnce(makeSkyResponse([makeStar({ id: 'recovered-1' })]));
    const transport: DataTransport = {
      mode: 'http',
      getSkyData,
      refresh,
      dispose: vi.fn(),
    };

    await act(async () => {
      root.render(
        <App transportFactory={vi.fn().mockResolvedValue(transport)} pollIntervalMs={0} />,
      );
    });

    expect(container.textContent).toContain('星图加载受阻');
    expect(container.textContent).toContain('Scan connection refused');

    await act(async () => {
      findButtonByText(container, '重试加载')?.click();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('共 1 颗星体');
  });

  it('filters UsageTables by search, celestial type, and sorts columns cleanly', () => {
    const stars = [
      makeStar({
        id: 'a',
        title: 'Low Token Chat',
        total_tokens: 1000,
        non_cache_tokens: 500,
        user_turns: 2,
        tool_calls_count: 1,
        celestial_type: 'comet',
        primary_model: 'gemini-2.5-flash',
      }),
      makeStar({
        id: 'b',
        title: 'High Token Chat',
        total_tokens: 9000,
        non_cache_tokens: 3000,
        user_turns: 10,
        tool_calls_count: 25,
        celestial_type: 'pulsar',
        primary_model: 'gemini-2.5-pro',
      }),
    ];

    act(() => {
      root.render(
        <UsageTables
          stars={stars}
          tokenMode="total"
          privacyMode={false}
          selectedDate={null}
          onClearDateFilter={vi.fn()}
          onLocateStar={vi.fn()}
          onHighlightDateInSky={vi.fn()}
        />,
      );
    });

    const sortTokensBtn = findButtonByText(container, '有效 Token');
    expect(sortTokensBtn).toBeDefined();
    act(() => {
      sortTokensBtn!.click();
    });
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows[0].getAttribute('data-star-id')).toBe('b');

    // Filter by celestial type comet
    const typeSelect = container.querySelector(
      'select[aria-label="按天体类型筛选"]',
    ) as HTMLSelectElement | null;
    expect(typeSelect).not.toBeNull();
    act(() => {
      typeSelect!.value = 'comet';
      typeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const filteredRows = Array.from(container.querySelectorAll('tbody tr'));
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0].getAttribute('data-star-id')).toBe('a');
  });

  it('scrolls highlighted star into view once on jump (even from another sub-tab) and never re-triggers on polls or heatmap clicks', async () => {
    const origScrollIntoViewDesc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
    });

    try {
      const s1 = makeStar({
        id: 'jump-1',
        title: 'Target Jump Star',
        local_date: '2026-06-15',
        started_at: '2026-06-15T09:00:00Z',
      });
      const s2 = makeStar({
        id: 'other-2',
        title: 'Other Day Star',
        local_date: '2026-06-16',
        started_at: '2026-06-16T10:00:00Z',
      });
      const s3 = makeStar({
        id: 'poll-3',
        title: 'New Poll Star',
        local_date: '2026-06-17',
        started_at: '2026-06-17T10:00:00Z',
      });

      const onClearDateFilter = vi.fn();

      // Render UsageTables initially on another sub-tab ('按模型汇总') with an obscuring date filter
      act(() => {
        root.render(
          <UsageTables
            stars={[s1, s2]}
            tokenMode="total"
            privacyMode={false}
            selectedDate="2026-06-16"
            highlightedStarId={null}
            onClearDateFilter={onClearDateFilter}
            onLocateStar={vi.fn()}
            onHighlightDateInSky={vi.fn()}
          />,
        );
      });

      act(() => {
        findButtonByText(container, '按模型汇总')?.click();
      });
      expect(container.querySelector('[data-star-id="jump-1"]')).toBeNull();
      expect(scrollIntoViewMock).not.toHaveBeenCalled();

      // Jump arrives targeting 'jump-1' while UsageTables is on '按模型汇总' and selectedDate='2026-06-16'
      act(() => {
        root.render(
          <UsageTables
            stars={[s1, s2]}
            tokenMode="total"
            privacyMode={false}
            selectedDate="2026-06-16"
            highlightedStarId="jump-1"
            onClearDateFilter={onClearDateFilter}
            onLocateStar={vi.fn()}
            onHighlightDateInSky={vi.fn()}
          />,
        );
      });
      expect(onClearDateFilter).toHaveBeenCalledTimes(1);

      // Host clears selectedDate in response to onClearDateFilter -> target row mounts & scrolls ONCE
      act(() => {
        root.render(
          <UsageTables
            stars={[s1, s2]}
            tokenMode="total"
            privacyMode={false}
            selectedDate={null}
            highlightedStarId="jump-1"
            onClearDateFilter={onClearDateFilter}
            onLocateStar={vi.fn()}
            onHighlightDateInSky={vi.fn()}
          />,
        );
      });

      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-star-id="jump-1"].is-highlighted'),
      ).not.toBeNull();

      // Subsequent 30s poll adds a new star (stars array updates) -> must NOT re-trigger scrollIntoView
      act(() => {
        root.render(
          <UsageTables
            stars={[s1, s2, s3]}
            tokenMode="total"
            privacyMode={false}
            selectedDate={null}
            highlightedStarId="jump-1"
            onClearDateFilter={onClearDateFilter}
            onLocateStar={vi.fn()}
            onHighlightDateInSky={vi.fn()}
          />,
        );
      });
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      // Subsequent heatmap date selection updates selectedDate -> must NOT re-trigger scrollIntoView
      act(() => {
        root.render(
          <UsageTables
            stars={[s1, s2, s3]}
            tokenMode="total"
            privacyMode={false}
            selectedDate="2026-06-15"
            highlightedStarId="jump-1"
            onClearDateFilter={onClearDateFilter}
            onLocateStar={vi.fn()}
            onHighlightDateInSky={vi.fn()}
          />,
        );
      });
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      // Full App flow: verify jumping from DetailDrawer scrolls once and 30s poll + heatmap click do not re-trigger
      scrollIntoViewMock.mockClear();
      vi.useFakeTimers();
      const getSkyData = vi
        .fn<() => Promise<SkyDataResponse>>()
        .mockResolvedValueOnce(makeSkyResponse([s1, s2]))
        .mockResolvedValueOnce(makeSkyResponse([s1, s2, s3]));
      const transport: DataTransport = {
        mode: 'http',
        getSkyData,
        refresh: vi.fn().mockResolvedValue(makeSkyResponse([s1, s2, s3])),
        dispose: vi.fn(),
      };

      await act(async () => {
        root.render(
          <App transportFactory={vi.fn().mockResolvedValue(transport)} pollIntervalMs={30_000} />,
        );
      });

      // Open Stats -> Locate jump-1 in Sky -> jump back to Stats from DetailDrawer
      act(() => {
        findButtonByText(container, '◈ 统计')?.click();
      });
      const locateBtn = container.querySelector(
        '[data-star-id="jump-1"] button',
      ) as HTMLButtonElement | null;
      expect(locateBtn).not.toBeNull();
      act(() => {
        locateBtn!.click();
      });
      act(() => {
        findButtonByText(container, '在统计列表中查看')?.click();
      });
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      // 30s silent poll updates stars -> scrollIntoView stays at 1
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      // Heatmap date click updates selectedDate -> scrollIntoView stays at 1
      const june15Cell = container.querySelector(
        'button[data-date="2026-06-15"]',
      ) as HTMLButtonElement | null;
      expect(june15Cell).not.toBeNull();
      act(() => {
        june15Cell!.click();
      });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    } finally {
      if (origScrollIntoViewDesc) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origScrollIntoViewDesc);
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });

  it('prevents a second createTransport() call when clicking refresh while initial startup load is still pending', async () => {
    let resolveTransport!: (transport: DataTransport) => void;
    const transportFactory = vi.fn(
      () =>
        new Promise<DataTransport>((resolve) => {
          resolveTransport = resolve;
        }),
    );

    const getSkyData = vi
      .fn<() => Promise<SkyDataResponse>>()
      .mockResolvedValueOnce(makeSkyResponse([makeStar({ id: 'startup-1' })]));
    const refresh = vi
      .fn<() => Promise<SkyDataResponse>>()
      .mockResolvedValueOnce(makeSkyResponse([makeStar({ id: 'startup-1' })]));
    const transport: DataTransport = {
      mode: 'http',
      getSkyData,
      refresh,
      dispose: vi.fn(),
    };

    await act(async () => {
      root.render(<App transportFactory={transportFactory} pollIntervalMs={0} />);
    });

    expect(transportFactory).toHaveBeenCalledTimes(1);
    const refreshBtn = findButtonByText(container, '刷新');
    expect(refreshBtn).toBeDefined();
    expect(refreshBtn!.disabled).toBe(true);

    await act(async () => {
      refreshBtn!.click();
    });

    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      resolveTransport(transport);
    });

    expect(getSkyData).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('共 1 颗星体');
    expect(refreshBtn!.disabled).toBe(false);

    await act(async () => {
      refreshBtn!.click();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(transportFactory).toHaveBeenCalledTimes(1);
  });

  it('marks all static headers in UsageTables daily and models views with ts-col-static', () => {
    const stars = [
      makeStar({ id: 'u1', local_date: '2026-06-15', primary_model: 'gemini-2.5-pro' }),
    ];

    act(() => {
      root.render(
        <UsageTables
          stars={stars}
          tokenMode="total"
          privacyMode={false}
          selectedDate={null}
          onClearDateFilter={vi.fn()}
          onLocateStar={vi.fn()}
          onHighlightDateInSky={vi.fn()}
        />,
      );
    });

    act(() => {
      findButtonByText(container, '按天汇总')?.click();
    });
    const dailyHeaders = Array.from(container.querySelectorAll('thead th'));
    expect(dailyHeaders).toHaveLength(6);
    expect(dailyHeaders.every((th) => th.classList.contains('ts-col-static'))).toBe(true);

    act(() => {
      findButtonByText(container, '按模型汇总')?.click();
    });
    const modelHeaders = Array.from(container.querySelectorAll('thead th'));
    expect(modelHeaders).toHaveLength(5);
    expect(modelHeaders.every((th) => th.classList.contains('ts-col-static'))).toBe(true);
  });

  it('derives StarHeatmap hovered cell from hoveredDate so tooltip updates when tokenMode changes', () => {
    const stars = [
      makeStar({
        id: 'hm-1',
        local_date: '2026-06-15',
        started_at: '2026-06-15T09:00:00Z',
        total_tokens: 10000,
        non_cache_tokens: 2500,
      }),
    ];

    act(() => {
      root.render(
        <StarHeatmap
          stars={stars}
          tokenMode="total"
          selectedDate={null}
          onSelectDate={vi.fn()}
          onHighlightDateInSky={vi.fn()}
        />,
      );
    });

    const dayBtn = container.querySelector('button[data-date="2026-06-15"]') as HTMLButtonElement | null;
    expect(dayBtn).not.toBeNull();

    act(() => {
      dayBtn!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.textContent).toContain('2026-06-15 · 1 次对话 · 10,000 Tokens');

    act(() => {
      root.render(
        <StarHeatmap
          stars={stars}
          tokenMode="non_cache"
          selectedDate={null}
          onSelectDate={vi.fn()}
          onHighlightDateInSky={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain('2026-06-15 · 1 次对话 · 2,500 Tokens');
  });

  it('supports per-request 按请求明细 view, slices 按对话 metrics by selectedDate, and locates exact request star', () => {
    const conv = makeStar({
      id: 'multi-day-conv',
      title: 'Confidential Multi-Day Task',
      started_at: '2026-06-15T09:00:00Z',
      ended_at: '2026-06-17T14:20:05Z',
      local_date: '2026-06-15',
      total_tokens: 9000,
      non_cache_tokens: 3000,
      requests: [
        {
          id: 'multi-day-conv:0',
          conversation_id: 'multi-day-conv',
          session_id: 'multi-day-conv',
          step_index: 0,
          turn_index: 1,
          created_at: '2026-06-15T09:00:00Z',
          local_date: '2026-06-15',
          model: 'gemini-2.5-pro',
          input_tokens: 1000,
          cache_read_tokens: 2000,
          output_tokens: 500,
          total_tokens: 3500,
          non_cache_tokens: 1500,
          tool_calls_count: 1,
          subagent_calls_count: 0,
          status: 'COMPLETED',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'star',
          celestial_reason: '第一轮',
        },
        {
          id: 'multi-day-conv:1',
          conversation_id: 'multi-day-conv',
          session_id: 'multi-day-conv',
          step_index: 1,
          turn_index: 2,
          created_at: '2026-06-17T14:20:05Z',
          local_date: '2026-06-17',
          model: 'gemini-2.5-flash',
          input_tokens: 1000,
          cache_read_tokens: 4000,
          output_tokens: 500,
          total_tokens: 5500,
          non_cache_tokens: 1500,
          tool_calls_count: 4,
          subagent_calls_count: 0,
          status: 'COMPLETED',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'pulsar',
          celestial_reason: '跨天继续',
        },
      ],
    });
    const onLocateStar = vi.fn();

    act(() => {
      root.render(
        <UsageTables
          stars={[conv]}
          tokenMode="total"
          privacyMode={true}
          selectedDate="2026-06-17"
          onClearDateFilter={vi.fn()}
          onLocateStar={onLocateStar}
          onHighlightDateInSky={vi.fn()}
        />,
      );
    });

    // Under selectedDate='2026-06-17', 按对话 slices tokens & request counts strictly to June 17
    expect(container.textContent).toContain('5,500');
    expect(container.textContent).toContain('1 次请求');
    expect(container.textContent).not.toContain('9,000');

    // Switch to 按请求明细 tab -> respects privacyMode and selectedDate, locates exact request id
    const reqTabBtn = findButtonByText(container, '按请求明细 (2)');
    expect(reqTabBtn).toBeDefined();
    act(() => {
      reqTabBtn!.click();
    });
    const reqRows = Array.from(container.querySelectorAll('tbody tr'));
    expect(reqRows).toHaveLength(1);
    expect(reqRows[0].getAttribute('data-request-id')).toBe('multi-day-conv:1');
    expect(container.textContent).toContain('80.0%');
    expect(container.textContent).toContain('星体 #001');
    expect(container.textContent).not.toContain('Confidential Multi-Day Task');

    const locateBtn = reqRows[0].querySelector('button');
    expect(locateBtn).not.toBeNull();
    act(() => {
      locateBtn!.click();
    });
    expect(onLocateStar).toHaveBeenCalledWith('multi-day-conv:1');

    // Clear selectedDate and verify per-request 缓存命中率 values & sorting (66.7% vs 80.0%)
    act(() => {
      root.render(
        <UsageTables
          stars={[conv]}
          tokenMode="total"
          privacyMode={true}
          selectedDate={null}
          onClearDateFilter={vi.fn()}
          onLocateStar={onLocateStar}
          onHighlightDateInSky={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain('66.7%');
    expect(container.textContent).toContain('80.0%');

    const sortCacheBtn = findButtonByText(container, '缓存命中率');
    expect(sortCacheBtn).toBeDefined();
    act(() => {
      sortCacheBtn!.click();
    });
    let sortedIds = Array.from(container.querySelectorAll('tbody tr')).map((r) =>
      r.getAttribute('data-request-id'),
    );
    expect(sortedIds).toEqual(['multi-day-conv:1', 'multi-day-conv:0']);

    act(() => {
      sortCacheBtn!.click();
    });
    sortedIds = Array.from(container.querySelectorAll('tbody tr')).map((r) =>
      r.getAttribute('data-request-id'),
    );
    expect(sortedIds).toEqual(['multi-day-conv:0', 'multi-day-conv:1']);
  });

  it('checks updates only on user click, applies update, and instructs reopening Antigravity on backend changes', async () => {
    const checkResult: UpdateCheckResult = {
      status: 'ok',
      current_version: '0.1.1',
      latest_version: '0.2.0',
      tag_name: 'v0.2.0',
      has_update: true,
      can_self_update: true,
      has_bundle_asset: true,
      release_url: 'https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/tag/v0.2.0',
      published_at: '2026-11-27T10:00:00Z',
      release_notes: '- In-plugin updater support',
      error: null,
    };
    const applyResult: UpdateApplyResult = {
      status: 'updated',
      previous_version: '0.1.1',
      updated_version: '0.2.0',
      backend_changed: true,
      restart_required: true,
      sync_deferred: true,
      message: '已更新至 v0.2.0（包含后端改动），请关闭并重新打开 Antigravity 即可生效。',
    };

    const checkUpdate = vi.fn<() => Promise<UpdateCheckResult>>().mockResolvedValue(checkResult);
    const applyUpdate = vi.fn<(tag?: string) => Promise<UpdateApplyResult>>().mockResolvedValue(applyResult);
    const openExternalUrl = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);

    const transport: DataTransport = {
      mode: 'mcp',
      getSkyData: vi.fn().mockResolvedValue(makeSkyResponse([makeStar({ id: 'upd-1' })])),
      refresh: vi.fn().mockResolvedValue(makeSkyResponse([makeStar({ id: 'upd-1' })])),
      checkUpdate,
      applyUpdate,
      openExternalUrl,
      dispose: vi.fn(),
    };

    await act(async () => {
      root.render(<App transportFactory={vi.fn().mockResolvedValue(transport)} pollIntervalMs={0} />);
    });

    // Zero automatic background update checks on mount
    expect(checkUpdate).not.toHaveBeenCalled();

    const updateBtn = container.querySelector('button[aria-label="检查更新"]') as HTMLButtonElement | null;
    expect(updateBtn).not.toBeNull();
    await act(async () => {
      updateBtn!.click();
    });

    expect(checkUpdate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('版本与更新');
    expect(container.textContent).toContain('v0.1.1');
    expect(container.textContent).toContain('v0.2.0');
    expect(container.textContent).toContain('In-plugin updater support');

    const releaseBtn = findButtonByText(container, '查看 GitHub Release');
    expect(releaseBtn).toBeDefined();
    act(() => {
      releaseBtn!.click();
    });
    expect(openExternalUrl).toHaveBeenCalledWith(checkResult.release_url);

    const applyBtn = findButtonByText(container, '立即更新');
    expect(applyBtn).toBeDefined();
    await act(async () => {
      applyBtn!.click();
    });

    expect(applyUpdate).toHaveBeenCalledWith('v0.2.0');
    expect(container.textContent).toContain('关闭并重新打开 Antigravity');
  });

  it('hides one-click update button and shows Release/git pull guidance when can_self_update is false', async () => {
    const checkResult: UpdateCheckResult = {
      status: 'ok',
      current_version: '0.1.1',
      latest_version: '0.2.0',
      tag_name: 'v0.2.0',
      has_update: true,
      can_self_update: false,
      has_bundle_asset: true,
      release_url: 'https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/tag/v0.2.0',
      published_at: '2026-11-27T10:00:00Z',
      release_notes: 'Web fallback test',
      error: null,
    };

    const transport: DataTransport = {
      mode: 'http',
      getSkyData: vi.fn().mockResolvedValue(makeSkyResponse([makeStar({ id: 'upd-2' })])),
      refresh: vi.fn().mockResolvedValue(makeSkyResponse([makeStar({ id: 'upd-2' })])),
      checkUpdate: vi.fn().mockResolvedValue(checkResult),
      applyUpdate: vi.fn(),
      openExternalUrl: vi.fn(),
      dispose: vi.fn(),
    };

    await act(async () => {
      root.render(<App transportFactory={vi.fn().mockResolvedValue(transport)} pollIntervalMs={0} />);
    });

    await act(async () => {
      findButtonByText(container, '检查更新')?.click();
    });

    expect(findButtonByText(container, '立即更新')).toBeUndefined();
    expect(container.textContent).toContain('git pull');
    expect(findButtonByText(container, '查看 GitHub Release')).toBeDefined();
  });
});
