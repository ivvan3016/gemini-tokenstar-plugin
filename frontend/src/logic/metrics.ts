import type { CelestialType, ConversationStar, TokenMode } from '../types/sky';
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
  tokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  primaryModel: string;
  primaryModelColor: string;
  conversations: ConversationStar[];
}

const MS_PER_DAY = 86_400_000;

/** Return the active token total for a conversation under the selected mode. */
export function effectiveTokens(star: ConversationStar, mode: TokenMode): number {
  return mode === 'total' ? star.total_tokens : star.non_cache_tokens;
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

  for (const star of stars) {
    totalTokens += effectiveTokens(star, mode);
    alternateTokens += effectiveTokens(star, mode === 'total' ? 'non_cache' : 'total');
    inputTokens += star.input_tokens;
    cacheReadTokens += star.cache_read_tokens;
    outputTokens += star.output_tokens;
    celestialCounts[star.celestial_type] += 1;

    if (star.requests && star.requests.length > 0) {
      totalRequests += star.requests.length;
      for (const req of star.requests) {
        requestCelestialCounts[req.celestial_type] += 1;
      }
    } else {
      totalRequests += 1;
      requestCelestialCounts[star.celestial_type] += 1;
    }

    const dayNum = parseUtcDayNumber(star.local_date);
    if (dayNum !== null) {
      activeDayNumbers.add(dayNum);
    }

    const ts = Date.parse(star.started_at);
    if (Number.isFinite(ts)) {
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestStartedAt = star.started_at;
      }
    } else if (latestStartedAt === null && star.started_at) {
      latestStartedAt = star.started_at;
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

/** Build a Sun–Sat weekly GitHub-style contribution heatmap for the target year. */
export function computeDailyHeatmap(
  stars: ConversationStar[],
  year: number,
  mode: TokenMode,
): DailyHeatmapGrid {
  const yearPrefix = `${year}-`;
  const buckets = new Map<string, { tokens: number; conversations: ConversationStar[] }>();

  for (const star of stars) {
    if (!star.local_date.startsWith(yearPrefix)) {
      continue;
    }
    let bucket = buckets.get(star.local_date);
    if (!bucket) {
      bucket = { tokens: 0, conversations: [] };
      buckets.set(star.local_date, bucket);
    }
    bucket.tokens += effectiveTokens(star, mode);
    bucket.conversations.push(star);
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

/** Aggregate per-day usage metrics sorted reverse-chronologically. */
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
      modelTotals: Map<string, number>;
      conversations: ConversationStar[];
    }
  >();

  for (const star of stars) {
    if (!star.local_date) continue;
    let bucket = byDate.get(star.local_date);
    if (!bucket) {
      bucket = {
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        modelTotals: new Map(),
        conversations: [],
      };
      byDate.set(star.local_date, bucket);
    }
    const eff = effectiveTokens(star, mode);
    bucket.tokens += eff;
    bucket.inputTokens += star.input_tokens;
    bucket.cacheReadTokens += star.cache_read_tokens;
    bucket.outputTokens += star.output_tokens;
    bucket.conversations.push(star);
    const model = star.primary_model || 'unknown';
    bucket.modelTotals.set(model, (bucket.modelTotals.get(model) ?? 0) + eff);
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

/** Return distinct calendar years present in `local_date`, sorted descending. */
export function getAvailableYears(stars: ConversationStar[]): number[] {
  const years = new Set<number>();
  for (const star of stars) {
    const match = /^(\d{4})-/.exec(star.local_date);
    if (match) {
      years.add(Number(match[1]));
    }
  }
  if (years.size === 0) {
    years.add(new Date().getFullYear());
  }
  return Array.from(years).sort((a, b) => b - a);
}
