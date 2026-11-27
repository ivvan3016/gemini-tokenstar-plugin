import { describe, expect, it } from 'vitest';
import type { ConversationStar, RequestStar, StarFilterState } from '../types/sky';
import { filterConversations, filterStarNodes, getDisplayTitle } from '../logic/filters';
import { computeStarPositions } from '../logic/starLayout';

function makeStar(overrides: Partial<ConversationStar> = {}): ConversationStar {
  return {
    id: 'conv-1',
    source: 'antigravity',
    title: 'Secret Architecture Plan',
    started_at: '2026-06-15T10:00:00Z',
    ended_at: '2026-06-15T10:05:00Z',
    local_date: '2026-06-15',
    primary_model: 'gemini-2.5-pro',
    models: [
      {
        model: 'gemini-2.5-pro',
        input_tokens: 100,
        cache_read_tokens: 0,
        output_tokens: 50,
        total_tokens: 150,
        steps: 1,
      },
    ],
    input_tokens: 100,
    cache_read_tokens: 0,
    output_tokens: 50,
    total_tokens: 150,
    non_cache_tokens: 150,
    user_turns: 1,
    model_steps_count: 1,
    tool_calls_count: 0,
    subagent_calls_count: 0,
    subagents: [],
    is_orphan_subagent: false,
    error_steps_count: 0,
    last_status: 'COMPLETED',
    celestial_type: 'star',
    celestial_reason: '常规深度对话',
    ...overrides,
  };
}

describe('filters', () => {
  it('masks titles with 1-based zero-padded numbering in privacyMode', () => {
    const star = makeStar();
    expect(getDisplayTitle(star, 0, false)).toBe('Secret Architecture Plan');
    expect(getDisplayTitle(star, 0, true)).toBe('星体 #001');
    expect(getDisplayTitle(star, 999, true)).toBe('星体 #1000');
  });

  it('filters by model, celestial type, date, and respects privacyMode for query', () => {
    const s1 = makeStar({
      id: '1',
      title: 'Alpha Secret',
      primary_model: 'gemini-2.5-pro',
      celestial_type: 'star',
      local_date: '2026-06-15',
    });
    const s2 = makeStar({
      id: '2',
      title: 'Beta Work',
      primary_model: 'gemini-2.5-flash',
      models: [],
      celestial_type: 'comet',
      local_date: '2026-06-16',
    });

    const base: StarFilterState = {
      query: '',
      models: [],
      celestialTypes: [],
      date: null,
    };

    expect(filterConversations([s1, s2], { ...base, models: ['gemini-2.5-flash'] }, false)).toEqual([s2]);
    expect(filterConversations([s1, s2], { ...base, celestialTypes: ['comet'] }, false)).toEqual([s2]);
    expect(filterConversations([s1, s2], { ...base, date: '2026-06-15' }, false)).toEqual([s1]);

    // Keyword matches title when privacyMode is false, but NOT when privacyMode is true
    expect(filterConversations([s1, s2], { ...base, query: 'Secret' }, false)).toEqual([s1]);
    expect(filterConversations([s1, s2], { ...base, query: 'Secret' }, true)).toEqual([]);

    // Model and date still match in privacyMode
    expect(filterConversations([s1, s2], { ...base, query: 'flash' }, true)).toEqual([s2]);
    expect(filterConversations([s1, s2], { ...base, query: '2026-06-15' }, true)).toEqual([s1]);
  });

  it('filters individual request StarNodes and keeps privacy guarantees', () => {
    const req1: RequestStar = {
      id: 'c1:0',
      conversation_id: 'c1',
      session_id: 'c1',
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
    };
    const req2: RequestStar = {
      ...req1,
      id: 'c1:1',
      step_index: 1,
      turn_index: 2,
      created_at: '2026-06-15T10:02:00Z',
      model: 'gemini-2.5-flash',
      status: 'ERROR',
      celestial_type: 'black_hole',
      celestial_reason: '模型调用异常',
      is_subagent: true,
      subagent_role: 'research',
    };

    const conv = makeStar({
      id: 'c1',
      title: 'Classified Operation',
      requests: [req1, req2],
    });
    const nodes = computeStarPositions([conv], 'total');
    const base: StarFilterState = {
      query: '',
      models: [],
      celestialTypes: [],
      date: null,
    };

    expect(filterStarNodes(nodes, { ...base, celestialTypes: ['black_hole'] }, false).map((n) => n.id)).toEqual(['c1:1']);
    expect(filterStarNodes(nodes, { ...base, models: ['gemini-2.5-pro'] }, false).map((n) => n.id)).toEqual(['c1:0']);
    expect(filterStarNodes(nodes, { ...base, query: 'Classified' }, false)).toHaveLength(2);
    expect(filterStarNodes(nodes, { ...base, query: 'Classified' }, true)).toHaveLength(0);
    expect(filterStarNodes(nodes, { ...base, query: 'research' }, true).map((n) => n.id)).toEqual(['c1:1']);
  });

  it('matches multi-day conversations and individual request StarNodes strictly by actual request local_date', () => {
    const reqDay1: RequestStar = {
      id: 'm1:0',
      conversation_id: 'm1',
      session_id: 'm1',
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
      celestial_type: 'star',
      celestial_reason: '首日请求',
    };
    const reqDay2: RequestStar = {
      ...reqDay1,
      id: 'm1:1',
      step_index: 1,
      turn_index: 2,
      created_at: '2026-06-18T15:30:00Z',
      local_date: '2026-06-18',
    };
    const conv = makeStar({
      id: 'm1',
      started_at: '2026-06-15T10:00:00Z',
      ended_at: '2026-06-18T15:30:00Z',
      local_date: '2026-06-15',
      requests: [reqDay1, reqDay2],
    });

    const base: StarFilterState = {
      query: '',
      models: [],
      celestialTypes: [],
      date: null,
    };

    expect(filterConversations([conv], { ...base, date: '2026-06-18' }, false)).toEqual([conv]);
    expect(filterConversations([conv], { ...base, date: '2026-06-17' }, false)).toEqual([]);

    const nodes = computeStarPositions([conv], 'total');
    expect(filterStarNodes(nodes, { ...base, date: '2026-06-15' }, false).map((n) => n.id)).toEqual(['m1:0']);
    expect(filterStarNodes(nodes, { ...base, date: '2026-06-18' }, false).map((n) => n.id)).toEqual(['m1:1']);
  });
});
