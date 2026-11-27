import { describe, expect, it } from 'vitest';
import type { ConversationStar } from '../types/sky';
import {
  computeDailyHeatmap,
  computeDailySummaries,
  computeModelSummaries,
  computeSummary,
  effectiveTokens,
  getAvailableYears,
} from '../logic/metrics';

function makeStar(overrides: Partial<ConversationStar> = {}): ConversationStar {
  const input = overrides.input_tokens ?? 100;
  const cache = overrides.cache_read_tokens ?? 200;
  const output = overrides.output_tokens ?? 50;
  return {
    id: 'conv-1',
    source: 'antigravity',
    title: 'Test conversation',
    started_at: '2026-06-15T10:00:00Z',
    ended_at: '2026-06-15T10:05:00Z',
    local_date: '2026-06-15',
    primary_model: 'gemini-2.5-pro',
    models: [
      {
        model: 'gemini-2.5-pro',
        input_tokens: input,
        cache_read_tokens: cache,
        output_tokens: output,
        total_tokens: input + cache + output,
        steps: 1,
      },
    ],
    input_tokens: input,
    cache_read_tokens: cache,
    output_tokens: output,
    total_tokens: overrides.total_tokens ?? input + cache + output,
    non_cache_tokens: overrides.non_cache_tokens ?? input + output,
    user_turns: 1,
    model_steps_count: 1,
    tool_calls_count: 0,
    subagent_calls_count: 0,
    subagents: [],
    is_orphan_subagent: false,
    error_steps_count: 0,
    last_status: 'COMPLETED',
    celestial_type: 'comet',
    celestial_reason: '轻量快问快答（1 轮对话）',
    ...overrides,
  };
}

describe('metrics', () => {
  it('test_zero_and_single_star_edge_cases', () => {
    const emptySummary = computeSummary([], 'total');
    expect(emptySummary.totalTokens).toBe(0);
    expect(emptySummary.inputTokens).toBe(0);
    expect(emptySummary.cacheReadTokens).toBe(0);
    expect(emptySummary.outputTokens).toBe(0);
    expect(emptySummary.cacheHitRate).toBe(0);
    expect(Number.isNaN(emptySummary.cacheHitRate)).toBe(false);
    expect(emptySummary.totalConversations).toBe(0);
    expect(emptySummary.totalActiveDays).toBe(0);
    expect(emptySummary.longestStreak).toBe(0);

    const emptyHeatmap = computeDailyHeatmap([], 2026, 'total');
    expect(emptyHeatmap.days.length).toBe(365);
    expect(emptyHeatmap.days.every((d) => d.level === 0 && d.tokens === 0)).toBe(true);

    const tinyStar = makeStar({
      id: 'tiny-1',
      local_date: '2026-03-10',
      started_at: '2026-03-10T08:00:00Z',
      ended_at: '2026-03-10T08:01:00Z',
      input_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 100,
      total_tokens: 100,
      non_cache_tokens: 100,
    });
    const singleSummary = computeSummary([tinyStar], 'total');
    expect(singleSummary.totalTokens).toBe(100);
    expect(singleSummary.cacheHitRate).toBe(0);
    expect(Number.isFinite(singleSummary.cacheHitRate)).toBe(true);
    expect(singleSummary.totalActiveDays).toBe(1);
    expect(singleSummary.longestStreak).toBe(1);

    const singleHeatmap = computeDailyHeatmap([tinyStar], 2026, 'total');
    const targetDay = singleHeatmap.byDate['2026-03-10'];
    expect(targetDay).toBeDefined();
    expect(targetDay.tokens).toBe(100);
    expect(targetDay.count).toBe(1);
    expect(targetDay.level).toBeGreaterThan(0);
  });

  it('test_streak_across_year_boundary', () => {
    const stars = [
      makeStar({ id: 'd1', local_date: '2026-12-30', started_at: '2026-12-30T10:00:00Z' }),
      makeStar({ id: 'd2', local_date: '2026-12-31', started_at: '2026-12-31T10:00:00Z' }),
      makeStar({ id: 'd3', local_date: '2027-01-01', started_at: '2027-01-01T10:00:00Z' }),
      makeStar({ id: 'd3b', local_date: '2027-01-01', started_at: '2027-01-01T14:00:00Z' }),
    ];

    const summary = computeSummary(stars, 'total');
    expect(summary.longestStreak).toBe(3);
    expect(summary.totalActiveDays).toBe(3);
  });

  it('test_token_mode_switches_summary_and_models', () => {
    const starA = makeStar({
      id: 'a',
      primary_model: 'gemini-2.5-pro',
      input_tokens: 100,
      cache_read_tokens: 900,
      output_tokens: 50,
      total_tokens: 1050,
      non_cache_tokens: 150,
      models: [
        {
          model: 'gemini-2.5-pro',
          input_tokens: 100,
          cache_read_tokens: 900,
          output_tokens: 50,
          total_tokens: 1050,
          steps: 2,
        },
      ],
    });
    const starB = makeStar({
      id: 'b',
      primary_model: 'gemini-2.5-flash',
      input_tokens: 200,
      cache_read_tokens: 300,
      output_tokens: 100,
      total_tokens: 600,
      non_cache_tokens: 300,
      models: [
        {
          model: 'gemini-2.5-flash',
          input_tokens: 200,
          cache_read_tokens: 300,
          output_tokens: 100,
          total_tokens: 600,
          steps: 1,
        },
      ],
    });

    expect(effectiveTokens(starA, 'total')).toBe(1050);
    expect(effectiveTokens(starA, 'non_cache')).toBe(150);

    const totalSummary = computeSummary([starA, starB], 'total');
    const nonCacheSummary = computeSummary([starA, starB], 'non_cache');
    expect(totalSummary.totalTokens).toBe(1650);
    expect(nonCacheSummary.totalTokens).toBe(450);

    const totalModels = computeModelSummaries([starA, starB], 'total');
    expect(totalModels[0].model).toBe('gemini-2.5-pro');
    expect(totalModels[0].tokens).toBe(1050);
    expect(totalModels[1].model).toBe('gemini-2.5-flash');
    expect(totalModels[1].tokens).toBe(600);

    const nonCacheModels = computeModelSummaries([starA, starB], 'non_cache');
    expect(nonCacheModels[0].model).toBe('gemini-2.5-flash');
    expect(nonCacheModels[0].tokens).toBe(300);
    expect(nonCacheModels[1].model).toBe('gemini-2.5-pro');
    expect(nonCacheModels[1].tokens).toBe(150);
  });

  it('aggregates request-level star counts and celestial distributions in SkySummary', () => {
    const conv = makeStar({
      id: 'multi',
      celestial_type: 'star',
      requests: [
        {
          id: 'multi:0',
          conversation_id: 'multi',
          session_id: 'multi',
          step_index: 0,
          turn_index: 1,
          created_at: '2026-06-15T10:00:00Z',
          local_date: '2026-06-15',
          model: 'gemini-2.5-pro',
          input_tokens: 100,
          cache_read_tokens: 0,
          output_tokens: 50,
          total_tokens: 150,
          non_cache_tokens: 150,
          tool_calls_count: 0,
          subagent_calls_count: 0,
          status: 'COMPLETED',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'comet',
          celestial_reason: '轻量请求',
        },
        {
          id: 'multi:1',
          conversation_id: 'multi',
          session_id: 'multi',
          step_index: 1,
          turn_index: 2,
          created_at: '2026-06-15T10:01:00Z',
          local_date: '2026-06-15',
          model: 'gemini-2.5-pro',
          input_tokens: 500,
          cache_read_tokens: 0,
          output_tokens: 200,
          total_tokens: 700,
          non_cache_tokens: 700,
          tool_calls_count: 4,
          subagent_calls_count: 0,
          status: 'ERROR',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'black_hole',
          celestial_reason: '模型调用异常',
        },
      ],
    });

    const summary = computeSummary([conv], 'total');
    expect(summary.totalConversations).toBe(1);
    expect(summary.totalRequests).toBe(2);
    expect(summary.requestCelestialCounts.comet).toBe(1);
    expect(summary.requestCelestialCounts.black_hole).toBe(1);
    expect(summary.requestCelestialCounts.star).toBe(0);
  });

  it('attributes multi-day conversation requests to their actual local dates across summary, heatmap, and daily summaries', () => {
    const multiDay = makeStar({
      id: 'cross-year',
      started_at: '2025-12-31T23:00:00Z',
      ended_at: '2026-01-02T09:30:00Z',
      local_date: '2025-12-31',
      primary_model: 'gemini-2.5-pro',
      input_tokens: 1000,
      cache_read_tokens: 2000,
      output_tokens: 500,
      total_tokens: 3500,
      non_cache_tokens: 1500,
      requests: [
        {
          id: 'cross-year:0',
          conversation_id: 'cross-year',
          session_id: 'cross-year',
          step_index: 0,
          turn_index: 1,
          created_at: '2025-12-31T23:00:00Z',
          local_date: '2025-12-31',
          model: 'gemini-2.5-pro',
          input_tokens: 100,
          cache_read_tokens: 400,
          output_tokens: 50,
          total_tokens: 550,
          non_cache_tokens: 150,
          tool_calls_count: 1,
          subagent_calls_count: 0,
          status: 'COMPLETED',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'star',
          celestial_reason: '发起轮',
        },
        {
          id: 'cross-year:1',
          conversation_id: 'cross-year',
          session_id: 'cross-year',
          step_index: 1,
          turn_index: 2,
          created_at: '2026-01-01T12:00:00Z',
          local_date: '2026-01-01',
          model: 'gemini-2.5-flash',
          input_tokens: 300,
          cache_read_tokens: 600,
          output_tokens: 150,
          total_tokens: 1050,
          non_cache_tokens: 450,
          tool_calls_count: 2,
          subagent_calls_count: 0,
          status: 'COMPLETED',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'star',
          celestial_reason: '次日续写',
        },
        {
          id: 'cross-year:2',
          conversation_id: 'cross-year',
          session_id: 'cross-year',
          step_index: 2,
          turn_index: 3,
          created_at: '2026-01-02T09:30:00Z',
          local_date: '2026-01-02',
          model: 'gemini-2.5-flash',
          input_tokens: 600,
          cache_read_tokens: 1000,
          output_tokens: 300,
          total_tokens: 1900,
          non_cache_tokens: 900,
          tool_calls_count: 3,
          subagent_calls_count: 0,
          status: 'COMPLETED',
          is_subagent: false,
          subagent_role: '',
          celestial_type: 'star',
          celestial_reason: '第三天收尾',
        },
      ],
    });

    const summary = computeSummary([multiDay], 'total');
    expect(summary.totalActiveDays).toBe(3);
    expect(summary.longestStreak).toBe(3);
    expect(summary.latestStartedAt).toBe('2026-01-02T09:30:00Z');
    expect(getAvailableYears([multiDay])).toEqual([2026, 2025]);

    const hm2025 = computeDailyHeatmap([multiDay], 2025, 'total');
    expect(hm2025.byDate['2025-12-31'].tokens).toBe(550);
    expect(hm2025.byDate['2025-12-31'].count).toBe(1);
    expect(hm2025.byDate['2025-12-31'].requestCount).toBe(1);

    const hm2026 = computeDailyHeatmap([multiDay], 2026, 'total');
    expect(hm2026.byDate['2026-01-01'].tokens).toBe(1050);
    expect(hm2026.byDate['2026-01-01'].count).toBe(1);
    expect(hm2026.byDate['2026-01-02'].tokens).toBe(1900);

    const daily = computeDailySummaries([multiDay], 'total');
    expect(daily.map((d) => [d.date, d.tokens, d.requestCount, d.primaryModel])).toEqual([
      ['2026-01-02', 1900, 1, 'gemini-2.5-flash'],
      ['2026-01-01', 1050, 1, 'gemini-2.5-flash'],
      ['2025-12-31', 550, 1, 'gemini-2.5-pro'],
    ]);
  });
});
