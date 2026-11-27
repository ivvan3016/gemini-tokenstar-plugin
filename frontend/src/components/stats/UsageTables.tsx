import { useEffect, useMemo, useRef, useState } from 'react';
import type { CelestialType, ConversationStar, RequestStar, TokenMode } from '../../types/sky';
import { filterConversations, getDisplayTitle } from '../../logic/filters';
import {
  compareTimestampsAsc,
  computeConversationDateMetrics,
  computeDailySummaries,
  computeModelSummaries,
  getEffectiveRequests,
  requestCacheHitRate,
  requestEffectiveTokens,
  starHasActivityOnDate,
} from '../../logic/metrics';
import { getModelSpectralColor } from '../../logic/starLayout';
import {
  CELESTIAL_META,
  CELESTIAL_ORDER,
  CelestialEmblem,
  formatTokenCount,
} from '../sky/DetailDrawer';

export type UsageSubTab = 'conversations' | 'requests' | 'daily' | 'models';
type SortKey = 'time' | 'tokens' | 'cache' | 'turns' | 'tools';
type SortDir = 'asc' | 'desc';

export interface UsageTablesProps {
  stars: ConversationStar[];
  tokenMode: TokenMode;
  privacyMode: boolean;
  selectedDate: string | null;
  highlightedStarId?: string | null;
  onClearDateFilter: () => void;
  onLocateStar: (starId: string) => void;
  onHighlightDateInSky: (date: string) => void;
}

interface RequestRowEntry {
  req: RequestStar;
  star: ConversationStar;
  convIndex: number;
  actualDate: string;
}

const REQUEST_PAGE_SIZE = 100;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocalTimestamp(iso: string, withSeconds = false): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso || '—';
  const d = new Date(ms);
  const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

function compareConversationStartAsc(a: ConversationStar, b: ConversationStar): number {
  const cmp = compareTimestampsAsc(a.started_at, b.started_at);
  if (cmp !== 0) return cmp;
  return a.id.localeCompare(b.id);
}

function BreakdownCell({
  inputTokens,
  cacheReadTokens,
  outputTokens,
}: {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}) {
  return (
    <td data-label="明细" className="ts-tabular ts-cell-breakdown">
      <span className="ts-breakdown-values">
        <span title="Input">{formatTokenCount(inputTokens)}</span>
        <span className="ts-sep">/</span>
        <span title="Cache Read">{formatTokenCount(cacheReadTokens)}</span>
        <span className="ts-sep">/</span>
        <span title="Output">{formatTokenCount(outputTokens)}</span>
      </span>
    </td>
  );
}

/** Multi-dimensional statistics lists: Conversations, Per-Request Details, Daily Summary, and Model Summary. */
export function UsageTables({
  stars,
  tokenMode,
  privacyMode,
  selectedDate,
  highlightedStarId = null,
  onClearDateFilter,
  onLocateStar,
  onHighlightDateInSky,
}: UsageTablesProps) {
  const [subTab, setSubTab] = useState<UsageSubTab>('conversations');
  const [query, setQuery] = useState('');
  const [celestialFilter, setCelestialFilter] = useState<CelestialType | ''>('');
  const [modelFilter, setModelFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [requestLimit, setRequestLimit] = useState<number>(REQUEST_PAGE_SIZE);

  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const prevHighlightedRef = useRef<string | null>(null);
  const pendingScrollIdRef = useRef<string | null>(null);

  // Maintain exact chronological index alignment with SkyTab so `星体 #001` matches everywhere.
  const chronologicalIndexById = useMemo(() => {
    const sorted = [...stars].sort(compareConversationStartAsc);
    const map = new Map<string, number>();
    sorted.forEach((s, idx) => map.set(s.id, idx));
    return map;
  }, [stars]);

  const availableModels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const star of stars) {
      if (star.models.length > 0) {
        for (const m of star.models) {
          if (m.model) counts.set(m.model, (counts.get(m.model) ?? 0) + 1);
        }
      } else if (star.primary_model) {
        counts.set(star.primary_model, (counts.get(star.primary_model) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([model]) => model);
  }, [stars]);

  const allRequestEntries = useMemo<RequestRowEntry[]>(() => {
    const entries: RequestRowEntry[] = [];
    for (const star of stars) {
      const convIndex = chronologicalIndexById.get(star.id) ?? 0;
      for (const req of getEffectiveRequests(star)) {
        entries.push({
          req,
          star,
          convIndex,
          actualDate: req.local_date || star.local_date,
        });
      }
    }
    return entries;
  }, [stars, chronologicalIndexById]);

  // Reset pagination whenever active view, filters, sorting, or dataset changes.
  useEffect(() => {
    setRequestLimit(REQUEST_PAGE_SIZE);
  }, [subTab, query, celestialFilter, modelFilter, selectedDate, sortKey, sortDir, stars]);

  // When jumping from SkyTab DetailDrawer, switch to conversations, clear obscuring filters, and queue one-shot scroll.
  useEffect(() => {
    if (!highlightedStarId) {
      prevHighlightedRef.current = null;
      pendingScrollIdRef.current = null;
      return;
    }
    if (highlightedStarId !== prevHighlightedRef.current) {
      prevHighlightedRef.current = highlightedStarId;
      pendingScrollIdRef.current = highlightedStarId;
      setSubTab('conversations');
      setQuery('');
      setCelestialFilter('');
      setModelFilter('');
      const targetStar = stars.find((s) => s.id === highlightedStarId);
      if (selectedDate && targetStar && !starHasActivityOnDate(targetStar, selectedDate)) {
        onClearDateFilter();
      }
    }
  }, [highlightedStarId, stars, selectedDate, onClearDateFilter]);

  const conversationSortKey = sortKey === 'cache' ? 'time' : sortKey;

  const filteredConversations = useMemo(() => {
    const filtered = filterConversations(
      stars,
      {
        query,
        models: modelFilter ? [modelFilter] : [],
        celestialTypes: celestialFilter ? [celestialFilter] : [],
        date: selectedDate,
      },
      privacyMode,
    );

    const rows = filtered.map((star) => ({
      star,
      metrics: computeConversationDateMetrics(star, selectedDate, tokenMode),
    }));

    const dir = sortDir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      let cmp = 0;
      if (conversationSortKey === 'time') {
        cmp = compareTimestampsAsc(a.metrics.latestTime, b.metrics.latestTime);
      } else if (conversationSortKey === 'tokens') {
        cmp = a.metrics.tokens - b.metrics.tokens;
      } else if (conversationSortKey === 'turns') {
        cmp = selectedDate
          ? a.metrics.requestCount - b.metrics.requestCount
          : a.star.user_turns - b.star.user_turns;
      } else if (conversationSortKey === 'tools') {
        cmp = a.metrics.toolCallsCount - b.metrics.toolCallsCount;
      }
      if (cmp !== 0) return cmp * dir;
      return compareConversationStartAsc(a.star, b.star) * dir;
    });
  }, [stars, query, modelFilter, celestialFilter, selectedDate, privacyMode, conversationSortKey, sortDir, tokenMode]);

  const requestSortKey = sortKey === 'turns' ? 'time' : sortKey;

  const filteredRequests = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allRequestEntries.filter(({ req, star, actualDate }) => {
      const modelName = req.model || star.primary_model || 'unknown';
      if (modelFilter && modelName !== modelFilter) return false;
      if (celestialFilter && req.celestial_type !== celestialFilter) return false;
      if (selectedDate && actualDate !== selectedDate) return false;

      if (q) {
        const modelMatch = modelName.toLowerCase().includes(q);
        const dateMatch = actualDate.toLowerCase().includes(q);
        const roleMatch = req.subagent_role.toLowerCase().includes(q);
        if (privacyMode) {
          return modelMatch || dateMatch || roleMatch;
        }
        const titleMatch = star.title.toLowerCase().includes(q);
        return titleMatch || modelMatch || dateMatch || roleMatch;
      }
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (requestSortKey === 'tokens') {
        cmp =
          requestEffectiveTokens(a.req, tokenMode) -
          requestEffectiveTokens(b.req, tokenMode);
      } else if (requestSortKey === 'cache') {
        cmp = requestCacheHitRate(a.req) - requestCacheHitRate(b.req);
      } else if (requestSortKey === 'tools') {
        cmp = a.req.tool_calls_count - b.req.tool_calls_count;
      }
      if (cmp === 0) {
        cmp = compareTimestampsAsc(a.req.created_at, b.req.created_at);
      }
      if (cmp === 0) {
        cmp = a.req.step_index - b.req.step_index;
      }
      if (cmp !== 0) return cmp * dir;
      return a.req.id.localeCompare(b.req.id) * dir;
    });
  }, [
    allRequestEntries,
    query,
    modelFilter,
    celestialFilter,
    selectedDate,
    privacyMode,
    requestSortKey,
    sortDir,
    tokenMode,
  ]);

  const visibleRequests = useMemo(
    () => filteredRequests.slice(0, requestLimit),
    [filteredRequests, requestLimit],
  );

  useEffect(() => {
    const pendingId = pendingScrollIdRef.current;
    if (!pendingId || subTab !== 'conversations') {
      return;
    }
    const row = rowRefs.current.get(pendingId);
    if (!row) {
      return;
    }
    pendingScrollIdRef.current = null;
    if (typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [subTab, filteredConversations, highlightedStarId]);

  const dailySummaries = useMemo(
    () => computeDailySummaries(stars, tokenMode),
    [stars, tokenMode],
  );

  const modelSummaries = useMemo(
    () => computeModelSummaries(stars, tokenMode),
    [stars, tokenMode],
  );

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const renderSortIndicator = (key: SortKey, activeKey: SortKey = sortKey) => {
    if (activeKey !== key) return ' ↕';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  };

  const showFilterBar = subTab === 'conversations' || subTab === 'requests';

  return (
    <section className="ts-panel ts-tables-section" aria-label="多维度用量明细列表">
      <div className="ts-tables-header">
        <div className="ts-subtabs" role="tablist" aria-label="统计维度切换">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'conversations'}
            className={`ts-subtab-btn${subTab === 'conversations' ? ' is-active' : ''}`}
            onClick={() => setSubTab('conversations')}
          >
            按对话 ({stars.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'requests'}
            className={`ts-subtab-btn${subTab === 'requests' ? ' is-active' : ''}`}
            onClick={() => setSubTab('requests')}
          >
            按请求明细 ({allRequestEntries.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'daily'}
            className={`ts-subtab-btn${subTab === 'daily' ? ' is-active' : ''}`}
            onClick={() => setSubTab('daily')}
          >
            按天汇总 ({dailySummaries.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'models'}
            className={`ts-subtab-btn${subTab === 'models' ? ' is-active' : ''}`}
            onClick={() => setSubTab('models')}
          >
            按模型汇总 ({modelSummaries.length})
          </button>
        </div>

        {showFilterBar && (
          <div className="ts-table-filters">
            <input
              type="search"
              className="ts-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                privacyMode ? '搜索模型或实际日期（隐私模式）...' : '搜索对话标题、模型或实际日期...'
              }
              aria-label="搜索对话列表"
            />

            <select
              className="ts-select"
              aria-label="按天体类型筛选"
              value={celestialFilter}
              onChange={(e) => setCelestialFilter(e.target.value as CelestialType | '')}
            >
              <option value="">全部天体</option>
              {CELESTIAL_ORDER.map((t) => (
                <option key={t} value={t}>
                  {CELESTIAL_META[t].label}
                </option>
              ))}
            </select>

            <select
              className="ts-select"
              aria-label="按模型筛选"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
            >
              <option value="">全部模型</option>
              {availableModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>

            {selectedDate && (
              <span className="ts-date-chip">
                <span>日期: {selectedDate}</span>
                <button
                  type="button"
                  className="ts-icon-close"
                  aria-label="清除日期筛选"
                  onClick={onClearDateFilter}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Sub-view 1: Conversations */}
      {subTab === 'conversations' && (
        <div className="ts-table-wrap">
          {filteredConversations.length === 0 ? (
            <div className="ts-empty-state">
              {stars.length === 0
                ? '暂无可展示的对话记录。'
                : '当前筛选条件下没有匹配的对话记录。'}
            </div>
          ) : (
            <table className="ts-table ts-table--responsive">
              <thead>
                <tr>
                  <th scope="col" className="ts-col-static">对话标题</th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${conversationSortKey === 'time' ? ' is-active' : ''}`}
                      onClick={() => handleSort('time')}
                    >
                      {selectedDate ? '当日最近时间' : '最近时间'}
                      {renderSortIndicator('time', conversationSortKey)}
                    </button>
                  </th>
                  <th scope="col" className="ts-col-static">天体</th>
                  <th scope="col" className="ts-col-static">主模型</th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${conversationSortKey === 'tokens' ? ' is-active' : ''}`}
                      onClick={() => handleSort('tokens')}
                    >
                      有效 Token{renderSortIndicator('tokens', conversationSortKey)}
                    </button>
                  </th>
                  <th scope="col" className="ts-col-static">Input / Cache / Output</th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${conversationSortKey === 'turns' ? ' is-active' : ''}`}
                      onClick={() => handleSort('turns')}
                    >
                      {selectedDate ? '当日请求' : '轮次'}
                      {renderSortIndicator('turns', conversationSortKey)}
                    </button>
                  </th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${conversationSortKey === 'tools' ? ' is-active' : ''}`}
                      onClick={() => handleSort('tools')}
                    >
                      工具{renderSortIndicator('tools', conversationSortKey)}
                    </button>
                  </th>
                  <th scope="col" className="ts-col-static">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredConversations.map(({ star, metrics }) => {
                  const starIdx = chronologicalIndexById.get(star.id) ?? 0;
                  const title = getDisplayTitle(star, starIdx, privacyMode);
                  const meta = CELESTIAL_META[star.celestial_type];
                  const modelColor = getModelSpectralColor(metrics.primaryModel);
                  const isHighlighted = highlightedStarId === star.id;
                  const timeRangeTip = `发起: ${formatLocalTimestamp(star.started_at)} · 最近: ${formatLocalTimestamp(metrics.latestTime)}`;

                  return (
                    <tr
                      key={star.id}
                      data-star-id={star.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(star.id, el);
                        else rowRefs.current.delete(star.id);
                      }}
                      className={isHighlighted ? 'is-highlighted' : undefined}
                    >
                      <td data-label="对话标题" className="ts-cell-title">
                        <span className="ts-title-text" title={title}>
                          {title}
                        </span>
                      </td>
                      <td
                        data-label={selectedDate ? '当日最近时间' : '最近时间'}
                        className="ts-tabular ts-cell-muted"
                        title={timeRangeTip}
                      >
                        {formatLocalTimestamp(metrics.latestTime)}
                      </td>
                      <td data-label="天体">
                        <span className="ts-celestial-badge" style={{ color: meta.accent }}>
                          <CelestialEmblem type={star.celestial_type} color={meta.accent} size={14} />
                          <span>{meta.label}</span>
                        </span>
                      </td>
                      <td data-label="主模型">
                        <span className="ts-model-cell">
                          <span
                            className="ts-spectral-dot"
                            style={{ background: modelColor, boxShadow: `0 0 6px ${modelColor}` }}
                          />
                          <span className="ts-model-name" title={metrics.primaryModel}>
                            {metrics.primaryModel}
                          </span>
                        </span>
                      </td>
                      <td data-label="有效 Token" className="ts-tabular ts-cell-strong">
                        {formatTokenCount(metrics.tokens)}
                      </td>
                      <BreakdownCell
                        inputTokens={metrics.inputTokens}
                        cacheReadTokens={metrics.cacheReadTokens}
                        outputTokens={metrics.outputTokens}
                      />
                      <td
                        data-label={selectedDate ? '当日请求' : '轮次'}
                        className="ts-tabular"
                        title={selectedDate ? `所属对话共 ${star.user_turns} 轮` : undefined}
                      >
                        {selectedDate ? `${metrics.requestCount} 次请求` : star.user_turns}
                      </td>
                      <td data-label="工具" className="ts-tabular">
                        {metrics.toolCallsCount}
                      </td>
                      <td data-label="操作" className="ts-cell-action">
                        <button
                          type="button"
                          className="ts-link-btn"
                          onClick={() => onLocateStar(star.id)}
                        >
                          定位星体
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Sub-view 2: Per-Request Details */}
      {subTab === 'requests' && (
        <div className="ts-table-wrap">
          {filteredRequests.length === 0 ? (
            <div className="ts-empty-state">
              {allRequestEntries.length === 0
                ? '暂无可展示的请求记录。'
                : '当前筛选条件下没有匹配的请求记录。'}
            </div>
          ) : (
            <>
              <table className="ts-table ts-table--responsive">
                <thead>
                  <tr>
                    <th scope="col" className="ts-col-static">所属对话</th>
                    <th scope="col">
                      <button
                        type="button"
                        className={`ts-sort-btn${requestSortKey === 'time' ? ' is-active' : ''}`}
                        onClick={() => handleSort('time')}
                      >
                        实际时间{renderSortIndicator('time', requestSortKey)}
                      </button>
                    </th>
                    <th scope="col" className="ts-col-static">天体</th>
                    <th scope="col" className="ts-col-static">模型</th>
                    <th scope="col">
                      <button
                        type="button"
                        className={`ts-sort-btn${requestSortKey === 'tokens' ? ' is-active' : ''}`}
                        onClick={() => handleSort('tokens')}
                      >
                        有效 Token{renderSortIndicator('tokens', requestSortKey)}
                      </button>
                    </th>
                    <th scope="col" className="ts-col-static">Input / Cache / Output</th>
                    <th scope="col">
                      <button
                        type="button"
                        className={`ts-sort-btn${requestSortKey === 'cache' ? ' is-active' : ''}`}
                        onClick={() => handleSort('cache')}
                      >
                        缓存命中率{renderSortIndicator('cache', requestSortKey)}
                      </button>
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        className={`ts-sort-btn${requestSortKey === 'tools' ? ' is-active' : ''}`}
                        onClick={() => handleSort('tools')}
                      >
                        工具{renderSortIndicator('tools', requestSortKey)}
                      </button>
                    </th>
                    <th scope="col" className="ts-col-static">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRequests.map((entry, idx) => {
                    const { req, star, convIndex } = entry;
                    const title = getDisplayTitle(star, convIndex, privacyMode);
                    const meta = CELESTIAL_META[req.celestial_type];
                    const modelName = req.model || star.primary_model || 'unknown';
                    const modelColor = getModelSpectralColor(modelName);
                    const eff = requestEffectiveTokens(req, tokenMode);
                    const stepBadge = req.is_subagent
                      ? `子代理${req.subagent_role ? ` · ${req.subagent_role}` : ''}`
                      : `第 ${req.turn_index > 0 ? req.turn_index : req.step_index + 1} 轮`;

                    return (
                      <tr key={`${req.id}:${idx}`} data-request-id={req.id}>
                        <td data-label="所属对话" className="ts-cell-title">
                          <div className="ts-title-stack">
                            <span className="ts-title-text" title={title}>
                              {title}
                            </span>
                            <span className="ts-title-sub ts-tabular">{stepBadge}</span>
                          </div>
                        </td>
                        <td data-label="实际时间" className="ts-tabular ts-cell-muted">
                          {formatLocalTimestamp(req.created_at, true)}
                        </td>
                        <td data-label="天体">
                          <span className="ts-celestial-badge" style={{ color: meta.accent }}>
                            <CelestialEmblem type={req.celestial_type} color={meta.accent} size={14} />
                            <span>{meta.label}</span>
                          </span>
                        </td>
                        <td data-label="模型">
                          <span className="ts-model-cell">
                            <span
                              className="ts-spectral-dot"
                              style={{ background: modelColor, boxShadow: `0 0 6px ${modelColor}` }}
                            />
                            <span className="ts-model-name" title={modelName}>
                              {modelName}
                            </span>
                          </span>
                        </td>
                        <td data-label="有效 Token" className="ts-tabular ts-cell-strong">
                          {formatTokenCount(eff)}
                        </td>
                        <BreakdownCell
                          inputTokens={req.input_tokens}
                          cacheReadTokens={req.cache_read_tokens}
                          outputTokens={req.output_tokens}
                        />
                        <td data-label="缓存命中率" className="ts-tabular">
                          {(requestCacheHitRate(req) * 100).toFixed(1)}%
                        </td>
                        <td data-label="工具" className="ts-tabular">
                          {req.tool_calls_count}
                        </td>
                        <td data-label="操作" className="ts-cell-action">
                          <button
                            type="button"
                            className="ts-link-btn"
                            onClick={() => onLocateStar(req.id)}
                          >
                            定位星体
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {filteredRequests.length > visibleRequests.length && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    flexWrap: 'wrap',
                    padding: '10px 4px 2px',
                    fontSize: '12px',
                    color: 'rgba(186, 206, 240, 0.78)',
                  }}
                >
                  <span className="ts-tabular">
                    已显示 {visibleRequests.length} / {filteredRequests.length} 条请求
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button
                      type="button"
                      className="ts-ghost-btn"
                      onClick={() => setRequestLimit((n) => n + REQUEST_PAGE_SIZE)}
                    >
                      加载更多 (+{REQUEST_PAGE_SIZE})
                    </button>
                    <button
                      type="button"
                      className="ts-link-btn"
                      onClick={() => setRequestLimit(filteredRequests.length)}
                    >
                      显示全部
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Sub-view 3: Daily Summary */}
      {subTab === 'daily' && (
        <div className="ts-table-wrap">
          {dailySummaries.length === 0 ? (
            <div className="ts-empty-state">暂无按天汇总数据。</div>
          ) : (
            <table className="ts-table ts-table--responsive">
              <thead>
                <tr>
                  <th scope="col" className="ts-col-static">日期</th>
                  <th scope="col" className="ts-col-static">对话 / 请求数</th>
                  <th scope="col" className="ts-col-static">当日有效 Token</th>
                  <th scope="col" className="ts-col-static">Input / Cache / Output</th>
                  <th scope="col" className="ts-col-static">当日主模型</th>
                  <th scope="col" className="ts-col-static">操作</th>
                </tr>
              </thead>
              <tbody>
                {dailySummaries.map((row) => (
                  <tr key={row.date} data-date-row={row.date}>
                    <td data-label="日期" className="ts-tabular ts-cell-strong">
                      {row.date}
                    </td>
                    <td data-label="对话 / 请求数" className="ts-tabular">
                      {row.conversationCount} 次对话 · {row.requestCount} 次请求
                    </td>
                    <td data-label="当日有效 Token" className="ts-tabular ts-cell-strong">
                      {formatTokenCount(row.tokens)}
                    </td>
                    <BreakdownCell
                      inputTokens={row.inputTokens}
                      cacheReadTokens={row.cacheReadTokens}
                      outputTokens={row.outputTokens}
                    />
                    <td data-label="当日主模型">
                      <span className="ts-model-cell">
                        <span
                          className="ts-spectral-dot"
                          style={{
                            background: row.primaryModelColor,
                            boxShadow: `0 0 6px ${row.primaryModelColor}`,
                          }}
                        />
                        <span className="ts-model-name" title={row.primaryModel}>
                          {row.primaryModel}
                        </span>
                      </span>
                    </td>
                    <td data-label="操作" className="ts-cell-action">
                      <button
                        type="button"
                        className="ts-link-btn"
                        onClick={() => onHighlightDateInSky(row.date)}
                      >
                        高亮当天星群
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Sub-view 4: Model Summary */}
      {subTab === 'models' && (
        <div className="ts-table-wrap">
          {modelSummaries.length === 0 ? (
            <div className="ts-empty-state">暂无按模型汇总数据。</div>
          ) : (
            <table className="ts-table ts-table--responsive">
              <thead>
                <tr>
                  <th scope="col" className="ts-col-static">模型名称</th>
                  <th scope="col" className="ts-col-static">对话数</th>
                  <th scope="col" className="ts-col-static">有效 Token 与占比</th>
                  <th scope="col" className="ts-col-static">Input / Cache / Output</th>
                  <th scope="col" className="ts-col-static">缓存命中率</th>
                </tr>
              </thead>
              <tbody>
                {modelSummaries.map((row) => {
                  const sharePct = Math.max(0, Math.min(100, row.share * 100));
                  const cachePct = Math.max(0, Math.min(100, row.cacheHitRate * 100));
                  return (
                    <tr key={row.model} data-model-row={row.model}>
                      <td data-label="模型名称">
                        <span className="ts-model-cell">
                          <span
                            className="ts-spectral-dot"
                            style={{
                              background: row.color,
                              boxShadow: `0 0 6px ${row.color}`,
                            }}
                          />
                          <span className="ts-model-name" title={row.model}>
                            {row.model}
                          </span>
                        </span>
                      </td>
                      <td data-label="对话数" className="ts-tabular">
                        {row.conversationCount} 次
                      </td>
                      <td data-label="有效 Token 与占比" className="ts-cell-share">
                        <div className="ts-share-head">
                          <span className="ts-tabular ts-cell-strong">
                            {formatTokenCount(row.tokens)}
                          </span>
                          <span className="ts-tabular ts-cell-muted">
                            {sharePct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="ts-progress-track" aria-hidden="true">
                          <div
                            className="ts-progress-fill"
                            style={{ width: `${sharePct}%`, background: row.color }}
                          />
                        </div>
                      </td>
                      <BreakdownCell
                        inputTokens={row.inputTokens}
                        cacheReadTokens={row.cacheReadTokens}
                        outputTokens={row.outputTokens}
                      />
                      <td data-label="缓存命中率" className="ts-tabular">
                        {cachePct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
