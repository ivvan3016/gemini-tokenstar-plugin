import { useEffect, useMemo, useRef, useState } from 'react';
import type { CelestialType, ConversationStar, TokenMode } from '../../types/sky';
import { filterConversations, getDisplayTitle } from '../../logic/filters';
import {
  computeDailySummaries,
  computeModelSummaries,
  effectiveTokens,
} from '../../logic/metrics';
import { getModelSpectralColor } from '../../logic/starLayout';
import {
  CELESTIAL_META,
  CELESTIAL_ORDER,
  CelestialEmblem,
  formatTokenCount,
} from '../sky/DetailDrawer';

export type UsageSubTab = 'conversations' | 'daily' | 'models';
type SortKey = 'time' | 'tokens' | 'turns' | 'tools';
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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatCompactLocalTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso || '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function compareChronological(a: ConversationStar, b: ConversationStar): number {
  const ta = Date.parse(a.started_at);
  const tb = Date.parse(b.started_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta - tb;
  }
  const timeOrder = a.started_at.localeCompare(b.started_at);
  if (timeOrder !== 0) return timeOrder;
  return a.id.localeCompare(b.id);
}

/** Multi-dimensional statistics lists: Conversations, Daily Summary, and Model Summary. */
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

  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const prevHighlightedRef = useRef<string | null>(null);
  const pendingScrollIdRef = useRef<string | null>(null);

  // Maintain exact chronological index alignment with SkyTab so `星体 #001` matches everywhere.
  const chronologicalIndexById = useMemo(() => {
    const sorted = [...stars].sort(compareChronological);
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
      if (selectedDate && targetStar && targetStar.local_date !== selectedDate) {
        onClearDateFilter();
      }
    }
  }, [highlightedStarId, stars, selectedDate, onClearDateFilter]);

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

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'time') {
        cmp = compareChronological(a, b);
      } else if (sortKey === 'tokens') {
        cmp = effectiveTokens(a, tokenMode) - effectiveTokens(b, tokenMode);
      } else if (sortKey === 'turns') {
        cmp = a.user_turns - b.user_turns;
      } else if (sortKey === 'tools') {
        cmp = a.tool_calls_count - b.tool_calls_count;
      }
      if (cmp !== 0) return cmp * dir;
      return compareChronological(a, b) * dir;
    });
  }, [stars, query, modelFilter, celestialFilter, selectedDate, privacyMode, sortKey, sortDir, tokenMode]);

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

  const renderSortIndicator = (key: SortKey) => {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  };

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

        {subTab === 'conversations' && (
          <div className="ts-table-filters">
            <input
              type="search"
              className="ts-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                privacyMode ? '搜索模型或日期（隐私模式）...' : '搜索对话标题、模型或日期...'
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
                      className={`ts-sort-btn${sortKey === 'time' ? ' is-active' : ''}`}
                      onClick={() => handleSort('time')}
                    >
                      开始时间{renderSortIndicator('time')}
                    </button>
                  </th>
                  <th scope="col" className="ts-col-static">天体</th>
                  <th scope="col" className="ts-col-static">主模型</th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${sortKey === 'tokens' ? ' is-active' : ''}`}
                      onClick={() => handleSort('tokens')}
                    >
                      有效 Token{renderSortIndicator('tokens')}
                    </button>
                  </th>
                  <th scope="col" className="ts-col-static">Input / Cache / Output</th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${sortKey === 'turns' ? ' is-active' : ''}`}
                      onClick={() => handleSort('turns')}
                    >
                      轮次{renderSortIndicator('turns')}
                    </button>
                  </th>
                  <th scope="col">
                    <button
                      type="button"
                      className={`ts-sort-btn${sortKey === 'tools' ? ' is-active' : ''}`}
                      onClick={() => handleSort('tools')}
                    >
                      工具{renderSortIndicator('tools')}
                    </button>
                  </th>
                  <th scope="col" className="ts-col-static">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredConversations.map((star) => {
                  const starIdx = chronologicalIndexById.get(star.id) ?? 0;
                  const title = getDisplayTitle(star, starIdx, privacyMode);
                  const meta = CELESTIAL_META[star.celestial_type];
                  const modelColor = getModelSpectralColor(star.primary_model);
                  const eff = effectiveTokens(star, tokenMode);
                  const isHighlighted = highlightedStarId === star.id;

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
                      <td data-label="开始时间" className="ts-tabular ts-cell-muted">
                        {formatCompactLocalTime(star.started_at)}
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
                          <span className="ts-model-name" title={star.primary_model}>
                            {star.primary_model}
                          </span>
                        </span>
                      </td>
                      <td data-label="有效 Token" className="ts-tabular ts-cell-strong">
                        {formatTokenCount(eff)}
                      </td>
                      <td data-label="明细" className="ts-tabular ts-cell-breakdown">
                        <span title="Input">{formatTokenCount(star.input_tokens)}</span>
                        <span className="ts-sep">/</span>
                        <span title="Cache Read">{formatTokenCount(star.cache_read_tokens)}</span>
                        <span className="ts-sep">/</span>
                        <span title="Output">{formatTokenCount(star.output_tokens)}</span>
                      </td>
                      <td data-label="轮次" className="ts-tabular">
                        {star.user_turns}
                      </td>
                      <td data-label="工具" className="ts-tabular">
                        {star.tool_calls_count}
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

      {/* Sub-view 2: Daily Summary */}
      {subTab === 'daily' && (
        <div className="ts-table-wrap">
          {dailySummaries.length === 0 ? (
            <div className="ts-empty-state">暂无按天汇总数据。</div>
          ) : (
            <table className="ts-table ts-table--responsive">
              <thead>
                <tr>
                  <th scope="col" className="ts-col-static">日期</th>
                  <th scope="col" className="ts-col-static">对话数</th>
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
                    <td data-label="对话数" className="ts-tabular">
                      {row.conversationCount} 次对话
                    </td>
                    <td data-label="当日有效 Token" className="ts-tabular ts-cell-strong">
                      {formatTokenCount(row.tokens)}
                    </td>
                    <td data-label="明细" className="ts-tabular ts-cell-breakdown">
                      <span>{formatTokenCount(row.inputTokens)}</span>
                      <span className="ts-sep">/</span>
                      <span>{formatTokenCount(row.cacheReadTokens)}</span>
                      <span className="ts-sep">/</span>
                      <span>{formatTokenCount(row.outputTokens)}</span>
                    </td>
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

      {/* Sub-view 3: Model Summary */}
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
                      <td data-label="明细" className="ts-tabular ts-cell-breakdown">
                        <span>{formatTokenCount(row.inputTokens)}</span>
                        <span className="ts-sep">/</span>
                        <span>{formatTokenCount(row.cacheReadTokens)}</span>
                        <span className="ts-sep">/</span>
                        <span>{formatTokenCount(row.outputTokens)}</span>
                      </td>
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
