import type { CelestialType, ConversationStar, RequestStar, TokenMode } from '../types/sky';
import { getModelSpectralColor } from './starLayout';

export interface SkySummary {
  totalTokens: number;
  alternateTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  totalConversations: number;
  totalRequests: number;
  celestialCounts: Record<CelestialType, number>;
  requestCelestialCounts: Record<CelestialType, number>;
  totalActiveDays: number;
  longestStreak: number;
  latestStartedAt: string | null;
}

export interface HeatmapCell {
  date: string;
  inYear: boolean;
  tokens: number;
  count: number;
  requestCount: number;
  conversations: ConversationStar[];
  level: 0 | 1 | 2 | 3 | 4;
}

export interface DailyHeatmapGrid {
  year: number;
  weeks: HeatmapCell[][];
  days: HeatmapCell[];
  byDate: Record<string, HeatmapCell>;
  maxTokens: number;
}

export interface ModelSummary {
  model: string;
  color: string;
  tokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  steps: number;
  conversationCount: number;
  share: number;
  cacheHitRate: number;
}

export interface DailySummary {
  date: string;
  conversationCount: number;
  requestCount: number;
  tokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  primaryModel: string;
  primaryModelColor: string;
  conversations: ConversationStar[];
}

export interface ConversationDateMetrics {
  tokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  requestCount: number;
  toolCallsCount: number;
  primaryModel: string;
  latestTime: string;
  earliestTime: string;
}

const MS_PER_DAY = 86_400_000;

/** Return the active token total for a conversation under the selected mode. */
export function effectiveTokens(star: ConversationStar, mode: TokenMode): number {
  return mode === 'total' ? star.total_tokens : star.non_cache_tokens;
}

/** Return the active token count for an individual request under the selected mode. */
export function requestEffectiveTokens(
  req: Pick<RequestStar, 'total_tokens' | 'non_cache_tokens'>,
  mode: TokenMode,
): number {
  return mode === 'total' ? req.total_tokens : req.non_cache_tokens;
}

/** Return cache hit rate (`cache_read / (input + cache_read)`) for a single request. */
export function requestCacheHitRate(
  req: Pick<RequestStar, 'input_tokens' | 'cache_read_tokens'>,
): number {
  const denom = req.input_tokens + req.cache_read_tokens;
  return denom > 0 ? req.cache_read_tokens / denom : 0;
}

/** Return the request list for a conversation, synthesizing a fallback entry if absent. */
export function getEffectiveRequests(star: ConversationStar): RequestStar[] {
  if (star.requests && star.requests.length > 0) {
    return star.requests;
  }
  return [
    {
      id: `${star.id}:0`,
      conversation_id: star.id,
      session_id: star.id,
      step_index: 0,
      turn_index: star.user_turns,
      created_at: star.started_at,
      local_date: star.local_date,
      model: star.primary_model,
      input_tokens: star.input_tokens,
      cache_read_tokens: star.cache_read_tokens,
      output_tokens: star.output_tokens,
      total_tokens: star.total_tokens,
      non_cache_tokens: star.non_cache_tokens,
      tool_calls_count: star.tool_calls_count,
      subagent_calls_count: star.subagent_calls_count,
      status: star.last_status,
      is_subagent: star.is_orphan_subagent,
      subagent_role: '',
      celestial_type: star.celestial_type,
      celestial_reason: star.celestial_reason,
    },
  ];
}

/** Return true if any request within the conversation occurred on `date`. */
export function starHasActivityOnDate(star: ConversationStar, date: string): boolean {
  if (!date) return true;
  for (const req of getEffectiveRequests(star)) {
    if ((req.local_date || star.local_date) === date) {
      return true;
    }
  }
  return false;
}

/** Compare two ISO timestamp strings ascending, falling back to string comparison. */
export function compareTimestampsAsc(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta - tb;
  }
  return a.localeCompare(b);
}

function pickBoundaryIso(current: string, candidate: string, mode: 'latest' | 'earliest'): string {
  if (!candidate) return current;
  if (!current) return candidate;
  const cmp = compareTimestampsAsc(candidate, current);
  return mode === 'latest' ? (cmp > 0 ? candidate : current) : cmp < 0 ? candidate : current;
}

/** Return the most recent activity timestamp for a conversation across all its requests. */
export function getConversationLatestTimestamp(star: ConversationStar): string {
  let latest = pickBoundaryIso(star.started_at || '', star.ended_at || '', 'latest');
  for (const req of getEffectiveRequests(star)) {
    latest = pickBoundaryIso(latest, req.created_at, 'latest');
  }
  return latest;
}

/** Compute conversation-level metrics either in full or sliced to requests on `date`. */
export function computeConversationDateMetrics(
  star: ConversationStar,
  date: string | null,
  mode: TokenMode,
): ConversationDateMetrics {
  const reqs = getEffectiveRequests(star);
  if (!date) {
    return {
      tokens: effectiveTokens(star, mode),
      inputTokens: star.input_tokens,
      cacheReadTokens: star.cache_read_tokens,
      outputTokens: star.output_tokens,
      requestCount:
        star.requests && star.requests.length > 0
          ? star.requests.length
          : Math.max(1, star.model_steps_count),
      toolCallsCount: star.tool_calls_count,
      primaryModel: star.primary_model || 'unknown',
      latestTime: getConversationLatestTimestamp(star),
      earliestTime: star.started_at,
    };
  }

  let tokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let requestCount = 0;
  let toolCallsCount = 0;
  let latestTime = '';
  let earliestTime = '';
  const modelTotals = new Map<string, number>();

  for (const req of reqs) {
    if ((req.local_date || star.local_date) !== date) {
      continue;
    }
    const eff = requestEffectiveTokens(req, mode);
    tokens += eff;
    inputTokens += req.input_tokens;
    cacheReadTokens += req.cache_read_tokens;
    outputTokens += req.output_tokens;
    requestCount += 1;
    toolCallsCount += req.tool_calls_count;
    latestTime = pickBoundaryIso(latestTime, req.created_at, 'latest');
    earliestTime = pickBoundaryIso(earliestTime, req.created_at, 'earliest');
    const modelName = req.model || star.primary_model || 'unknown';
    modelTotals.set(modelName, (modelTotals.get(modelName) ?? 0) + eff);
  }

  let primaryModel = star.primary_model || 'unknown';
  let bestTokens = -1;
  for (const [model, tok] of modelTotals.entries()) {
    if (tok > bestTokens) {
      bestTokens = tok;
      primaryModel = model;
    }
  }

  return {
    tokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    requestCount,
    toolCallsCount,
    primaryModel,
    latestTime: latestTime || getConversationLatestTimestamp(star),
    earliestTime: earliestTime || star.started_at,
  };
}

function parseUtcDayNumber(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMs = Date.UTC(year, month - 1, day);
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utcMs / MS_PER_DAY);
}

function formatUtcDate(utcMs: number): string {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function computeLongestStreak(dayNumbers: number[]): number {
  if (dayNumbers.length === 0) {
    return 0;
  }
  const sorted = [...dayNumbers].sort((a, b) => a - b);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1] + 1) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else if (sorted[i] !== sorted[i - 1]) {
      current = 1;
    }
  }
  return longest;
}

function computeQuantileThresholds(positiveValues: number[]): [number, number, number] {
  const sorted = [...positiveValues].sort((a, b) => a - b);
  const last = sorted.length - 1;
  return [
    sorted[Math.floor(last * 0.25)],
    sorted[Math.floor(last * 0.5)],
    sorted[Math.floor(last * 0.75)],
  ];
}

function assignHeatmapLevel(
  tokens: number,
  thresholds: [number, number, number] | null,
  allEqualPositive: boolean,
): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || thresholds === null) {
    return 0;
  }
  if (allEqualPositive) {
    return 4;
  }
  const [q25, q50, q75] = thresholds;
  if (tokens <= q25) return 1;
  if (tokens <= q50) return 2;
  if (tokens <= q75) return 3;
  return 4;
}

/** Derive top-level KPI summary metrics for the given conversations and token mode. */
export function computeSummary(stars: ConversationStar[], mode: TokenMode): SkySummary {
  const celestialCounts: Record<CelestialType, number> = {
    star: 0,
    black_hole: 0,
    binary: 0,
    pulsar: 0,
    comet: 0,
  };
  const requestCelestialCounts: Record<CelestialType, number> = {
    star: 0,
    black_hole: 0,
    binary: 0,
    pulsar: 0,
    comet: 0,
  };

  let totalTokens = 0;
  let alternateTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalRequests = 0;
  let latestStartedAt: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  const activeDayNumbers = new Set<number>();

  const considerTimestamp = (iso: string) => {
    if (!iso) return;
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) {
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestStartedAt = iso;
      }
    } else if (latestStartedAt === null) {
      latestStartedAt = iso;
    }
  };

  for (const star of stars) {
    totalTokens += effectiveTokens(star, mode);
    alternateTokens += effectiveTokens(star, mode === 'total' ? 'non_cache' : 'total');
    inputTokens += star.input_tokens;
    cacheReadTokens += star.cache_read_tokens;
    outputTokens += star.output_tokens;
    celestialCounts[star.celestial_type] += 1;

    considerTimestamp(star.started_at);
    considerTimestamp(star.ended_at);

    const reqs = getEffectiveRequests(star);
    totalRequests += reqs.length;
    for (const req of reqs) {
      requestCelestialCounts[req.celestial_type] += 1;
      const dayNum = parseUtcDayNumber(req.local_date || star.local_date);
      if (dayNum !== null) {
        activeDayNumbers.add(dayNum);
      }
      considerTimestamp(req.created_at);
    }
  }

  const cacheDenominator = inputTokens + cacheReadTokens;
  const cacheHitRate = cacheDenominator > 0 ? cacheReadTokens / cacheDenominator : 0;
  const dayList = Array.from(activeDayNumbers);

  return {
    totalTokens,
    alternateTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cacheHitRate,
    totalConversations: stars.length,
    totalRequests,
    celestialCounts,
    requestCelestialCounts,
    totalActiveDays: activeDayNumbers.size,
    longestStreak: computeLongestStreak(dayList),
    latestStartedAt,
  };
}

/** Build a Sun–Sat weekly GitHub-style contribution heatmap attributed by each request's actual date. */
export function computeDailyHeatmap(
  stars: ConversationStar[],
  year: number,
  mode: TokenMode,
): DailyHeatmapGrid {
  const yearPrefix = `${year}-`;
  const buckets = new Map<
    string,
    { tokens: number; requestCount: number; convIds: Set<string>; conversations: ConversationStar[] }
  >();

  for (const star of stars) {
    for (const req of getEffectiveRequests(star)) {
      const reqDate = req.local_date || star.local_date;
      if (!reqDate.startsWith(yearPrefix)) {
        continue;
      }
      let bucket = buckets.get(reqDate);
      if (!bucket) {
        bucket = { tokens: 0, requestCount: 0, convIds: new Set(), conversations: [] };
        buckets.set(reqDate, bucket);
      }
      bucket.tokens += requestEffectiveTokens(req, mode);
      bucket.requestCount += 1;
      if (!bucket.convIds.has(star.id)) {
        bucket.convIds.add(star.id);
        bucket.conversations.push(star);
      }
    }
  }

  const positiveTotals: number[] = [];
  let maxTokens = 0;
  for (const bucket of buckets.values()) {
    if (bucket.tokens > 0) {
      positiveTotals.push(bucket.tokens);
      if (bucket.tokens > maxTokens) {
        maxTokens = bucket.tokens;
      }
    }
  }

  const thresholds =
    positiveTotals.length > 0 ? computeQuantileThresholds(positiveTotals) : null;
  const minPositive =
    positiveTotals.length > 0 ? Math.min(...positiveTotals) : 0;
  const allEqualPositive = positiveTotals.length > 0 && minPositive === maxTokens;

  const jan1Ms = Date.UTC(year, 0, 1);
  const dec31Ms = Date.UTC(year, 11, 31);
  const startDow = new Date(jan1Ms).getUTCDay();
  const endDow = new Date(dec31Ms).getUTCDay();

  const gridStartMs = jan1Ms - startDow * MS_PER_DAY;
  const gridEndMs = dec31Ms + (6 - endDow) * MS_PER_DAY;

  const days: HeatmapCell[] = [];
  const byDate: Record<string, HeatmapCell> = {};
  const weeks: HeatmapCell[][] = [];
  let currentWeek: HeatmapCell[] = [];

  for (let ms = gridStartMs; ms <= gridEndMs; ms += MS_PER_DAY) {
    const inYear = ms >= jan1Ms && ms <= dec31Ms;
    const date = formatUtcDate(ms);
    const bucket = inYear ? buckets.get(date) : undefined;
    const tokens = bucket?.tokens ?? 0;
    const conversations = bucket?.conversations ?? [];
    const cell: HeatmapCell = {
      date,
      inYear,
      tokens,
      count: conversations.length,
      requestCount: bucket?.requestCount ?? 0,
      conversations,
      level: inYear ? assignHeatmapLevel(tokens, thresholds, allEqualPositive) : 0,
    };

    if (inYear) {
      days.push(cell);
      byDate[date] = cell;
    }

    currentWeek.push(cell);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  return { year, weeks, days, byDate, maxTokens };
}

/** Aggregate per-model usage metrics under the active token mode. */
export function computeModelSummaries(
  stars: ConversationStar[],
  mode: TokenMode,
): ModelSummary[] {
  const map = new Map<
    string,
    {
      inputTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      tokens: number;
      steps: number;
      conversationCount: number;
    }
  >();

  const ensureEntry = (modelName: string) => {
    let entry = map.get(modelName);
    if (!entry) {
      entry = {
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        tokens: 0,
        steps: 0,
        conversationCount: 0,
      };
      map.set(modelName, entry);
    }
    return entry;
  };

  for (const star of stars) {
    if (star.models.length > 0) {
      const seenInStar = new Set<string>();
      for (const item of star.models) {
        const modelName = item.model || 'unknown';
        const entry = ensureEntry(modelName);
        entry.inputTokens += item.input_tokens;
        entry.cacheReadTokens += item.cache_read_tokens;
        entry.outputTokens += item.output_tokens;
        entry.tokens +=
          mode === 'total'
            ? item.total_tokens
            : item.input_tokens + item.output_tokens;
        entry.steps += item.steps;
        if (!seenInStar.has(modelName)) {
          seenInStar.add(modelName);
          entry.conversationCount += 1;
        }
      }
    } else {
      const modelName = star.primary_model || 'unknown';
      const entry = ensureEntry(modelName);
      entry.inputTokens += star.input_tokens;
      entry.cacheReadTokens += star.cache_read_tokens;
      entry.outputTokens += star.output_tokens;
      entry.tokens += effectiveTokens(star, mode);
      entry.steps += star.model_steps_count;
      entry.conversationCount += 1;
    }
  }

  let grandTotal = 0;
  for (const entry of map.values()) {
    grandTotal += entry.tokens;
  }

  const summaries: ModelSummary[] = [];
  for (const [model, entry] of map.entries()) {
    const cacheDenom = entry.inputTokens + entry.cacheReadTokens;
    summaries.push({
      model,
      color: getModelSpectralColor(model),
      tokens: entry.tokens,
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      outputTokens: entry.outputTokens,
      steps: entry.steps,
      conversationCount: entry.conversationCount,
      share: grandTotal > 0 ? entry.tokens / grandTotal : 0,
      cacheHitRate: cacheDenom > 0 ? entry.cacheReadTokens / cacheDenom : 0,
    });
  }

  return summaries.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.conversationCount !== a.conversationCount) {
      return b.conversationCount - a.conversationCount;
    }
    return a.model.localeCompare(b.model);
  });
}

/** Aggregate per-day usage metrics grouped by each request's actual `local_date`. */
export function computeDailySummaries(
  stars: ConversationStar[],
  mode: TokenMode,
): DailySummary[] {
  const byDate = new Map<
    string,
    {
      tokens: number;
      inputTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      requestCount: number;
      modelTotals: Map<string, number>;
      convIds: Set<string>;
      conversations: ConversationStar[];
    }
  >();

  for (const star of stars) {
    for (const req of getEffectiveRequests(star)) {
      const reqDate = req.local_date || star.local_date;
      if (!reqDate) continue;
      let bucket = byDate.get(reqDate);
      if (!bucket) {
        bucket = {
          tokens: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          requestCount: 0,
          modelTotals: new Map(),
          convIds: new Set(),
          conversations: [],
        };
        byDate.set(reqDate, bucket);
      }
      const eff = requestEffectiveTokens(req, mode);
      bucket.tokens += eff;
      bucket.inputTokens += req.input_tokens;
      bucket.cacheReadTokens += req.cache_read_tokens;
      bucket.outputTokens += req.output_tokens;
      bucket.requestCount += 1;
      if (!bucket.convIds.has(star.id)) {
        bucket.convIds.add(star.id);
        bucket.conversations.push(star);
      }
      const model = req.model || star.primary_model || 'unknown';
      bucket.modelTotals.set(model, (bucket.modelTotals.get(model) ?? 0) + eff);
    }
  }

  const rows: DailySummary[] = [];
  for (const [date, bucket] of byDate.entries()) {
    let primaryModel = 'unknown';
    let bestTokens = -1;
    for (const [model, tok] of bucket.modelTotals.entries()) {
      if (tok > bestTokens) {
        bestTokens = tok;
        primaryModel = model;
      }
    }
    rows.push({
      date,
      conversationCount: bucket.conversations.length,
      requestCount: bucket.requestCount,
      tokens: bucket.tokens,
      inputTokens: bucket.inputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      outputTokens: bucket.outputTokens,
      primaryModel,
      primaryModelColor: getModelSpectralColor(primaryModel),
      conversations: bucket.conversations,
    });
  }

  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/** Return distinct calendar years present across request and conversation dates, sorted descending. */
export function getAvailableYears(stars: ConversationStar[]): number[] {
  const years = new Set<number>();
  const addDateYear = (dateStr: string) => {
    const match = /^(\d{4})-/.exec(dateStr);
    if (match) {
      years.add(Number(match[1]));
    }
  };
  for (const star of stars) {
    addDateYear(star.local_date);
    if (star.requests) {
      for (const req of star.requests) {
        addDateYear(req.local_date);
      }
    }
  }
  if (years.size === 0) {
    years.add(new Date().getFullYear());
  }
  return Array.from(years).sort((a, b) => b - a);
}
