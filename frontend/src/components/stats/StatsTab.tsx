import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationStar, SourceScanReport, TokenMode } from '../../types/sky';
import { computeSummary } from '../../logic/metrics';
import {
  CELESTIAL_META,
  CELESTIAL_ORDER,
  CelestialEmblem,
  formatCompactTokens,
  formatTokenCount,
} from '../sky/DetailDrawer';
import { StarHeatmap } from './StarHeatmap';
import { UsageTables } from './UsageTables';

export interface StatsTabProps {
  stars: ConversationStar[];
  sources: SourceScanReport[];
  scanDurationMs: number;
  tokenMode: TokenMode;
  privacyMode: boolean;
  focusStatsStarId?: string | null;
  onClearFocusStatsStar?: () => void;
  onLocateStarInSky: (starId: string) => void;
  onHighlightDateInSky: (date: string) => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLatestTimestamp(iso: string | null): string {
  if (!iso) return '暂无对话';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sourceLabel(source: SourceScanReport['source']): string {
  return source === 'antigravity' ? 'Antigravity' : 'Gemini CLI';
}

/** Observatory Statistics Tab with 4 KPI cards, starry heatmap, multi-dimensional tables, and diagnostics. */
export function StatsTab({
  stars,
  sources,
  scanDurationMs,
  tokenMode,
  privacyMode,
  focusStatsStarId = null,
  onClearFocusStatsStar,
  onLocateStarInSky,
  onHighlightDateInSky,
}: StatsTabProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [highlightedStarId, setHighlightedStarId] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const summary = useMemo(() => computeSummary(stars, tokenMode), [stars, tokenMode]);

  useEffect(() => {
    if (!focusStatsStarId) return;
    setHighlightedStarId(focusStatsStarId);
    const target = stars.find((s) => s.id === focusStatsStarId);
    if (selectedDate && target && target.local_date !== selectedDate) {
      setSelectedDate(null);
    }
    onClearFocusStatsStar?.();
  }, [focusStatsStarId, stars, selectedDate, onClearFocusStatsStar]);

  const handleClearDateFilter = useCallback(() => {
    setSelectedDate(null);
  }, []);

  const rawTokenSum =
    summary.inputTokens + summary.cacheReadTokens + summary.outputTokens;
  const rawDenom = rawTokenSum > 0 ? rawTokenSum : 1;
  const inputPct = rawTokenSum > 0 ? (summary.inputTokens / rawDenom) * 100 : 0;
  const cachePct = rawTokenSum > 0 ? (summary.cacheReadTokens / rawDenom) * 100 : 0;
  const outputPct = rawTokenSum > 0 ? (summary.outputTokens / rawDenom) * 100 : 0;
  const cacheHitPct = (summary.cacheHitRate * 100).toFixed(1);

  const scannedDirs =
    sources.length > 0
      ? sources.map((s) => s.directory).join(' · ')
      : '~/.gemini/antigravity/brain';
  const parsedCount =
    sources.length > 0
      ? sources.reduce((acc, s) => acc + s.parsed_conversations, 0)
      : stars.length;
  const totalWarnings = sources.reduce((acc, s) => acc + s.warnings.length, 0);

  return (
    <div className="ts-stats-tab">
      {/* 4 KPI Cards */}
      <section className="ts-kpi-grid" aria-label="核心用量指标总览">
        {/* Card 1: Total Tokens */}
        <article className="ts-panel ts-kpi-card">
          <div className="ts-kpi-head">
            <span className="ts-kpi-label">累计 Token</span>
            <span className="ts-mode-badge">
              {tokenMode === 'total' ? '含缓存' : '仅新增'}
            </span>
          </div>
          <div className="ts-kpi-value-row">
            <strong className="ts-kpi-value ts-tabular">
              {formatTokenCount(summary.totalTokens)}
            </strong>
            {summary.totalTokens >= 1_000 && (
              <span className="ts-kpi-compact ts-tabular">
                {formatCompactTokens(summary.totalTokens)}
              </span>
            )}
          </div>
          <div className="ts-kpi-sub ts-tabular">
            {tokenMode === 'total'
              ? `仅新增口径：${formatTokenCount(summary.alternateTokens)}`
              : `含缓存口径：${formatTokenCount(summary.alternateTokens)}`}
          </div>
        </article>

        {/* Card 2: Token Breakdown & Cache Hit Rate */}
        <article className="ts-panel ts-kpi-card">
          <div className="ts-kpi-head">
            <span className="ts-kpi-label">Token 构成与缓存命中率</span>
            <span className="ts-kpi-highlight ts-tabular">缓存命中率 {cacheHitPct}%</span>
          </div>
          <div className="ts-stacked-bar" aria-label="Token 构成比例">
            {inputPct > 0 && (
              <div
                className="ts-bar-seg is-input"
                style={{ width: `${inputPct}%` }}
                title={`Input: ${formatTokenCount(summary.inputTokens)}`}
              />
            )}
            {cachePct > 0 && (
              <div
                className="ts-bar-seg is-cache"
                style={{ width: `${cachePct}%` }}
                title={`Cache Read: ${formatTokenCount(summary.cacheReadTokens)}`}
              />
            )}
            {outputPct > 0 && (
              <div
                className="ts-bar-seg is-output"
                style={{ width: `${outputPct}%` }}
                title={`Output: ${formatTokenCount(summary.outputTokens)}`}
              />
            )}
          </div>
          <div className="ts-breakdown-grid">
            <div className="ts-breakdown-item">
              <span className="ts-breakdown-key">
                <span className="ts-swatch is-input" />
                Input
              </span>
              <span className="ts-breakdown-val ts-tabular">
                {formatTokenCount(summary.inputTokens)}
              </span>
            </div>
            <div className="ts-breakdown-item">
              <span className="ts-breakdown-key">
                <span className="ts-swatch is-cache" />
                Cache Read
              </span>
              <span className="ts-breakdown-val ts-tabular">
                {formatTokenCount(summary.cacheReadTokens)}
              </span>
            </div>
            <div className="ts-breakdown-item">
              <span className="ts-breakdown-key">
                <span className="ts-swatch is-output" />
                Output
              </span>
              <span className="ts-breakdown-val ts-tabular">
                {formatTokenCount(summary.outputTokens)}
              </span>
            </div>
          </div>
        </article>

        {/* Card 3: Celestial Bodies */}
        <article className="ts-panel ts-kpi-card">
          <div className="ts-kpi-head">
            <span className="ts-kpi-label">点亮天体总数</span>
            <span className="ts-kpi-sub-inline">颗星体 · {summary.totalConversations} 个星座</span>
          </div>
          <div className="ts-kpi-value-row">
            <strong className="ts-kpi-value ts-tabular">{summary.totalRequests}</strong>
          </div>
          <div className="ts-celestial-badges">
            {CELESTIAL_ORDER.map((type) => {
              const meta = CELESTIAL_META[type];
              return (
                <span key={type} className="ts-celestial-pill" title={meta.description}>
                  <CelestialEmblem type={type} color={meta.accent} size={13} />
                  <span>{meta.label}</span>
                  <strong className="ts-tabular">{summary.requestCelestialCounts[type]}</strong>
                </span>
              );
            })}
          </div>
        </article>

        {/* Card 4: Activity Cadence */}
        <article className="ts-panel ts-kpi-card">
          <div className="ts-kpi-head">
            <span className="ts-kpi-label">活跃节奏</span>
            <span className="ts-kpi-highlight ts-tabular">
              最长连续 {summary.longestStreak} 天
            </span>
          </div>
          <div className="ts-kpi-value-row">
            <strong className="ts-kpi-value ts-tabular">{summary.totalActiveDays}</strong>
            <span className="ts-kpi-unit">活跃天</span>
          </div>
          <div className="ts-kpi-sub ts-tabular">
            最近对话：{formatLatestTimestamp(summary.latestStartedAt)}
          </div>
        </article>
      </section>

      {/* Annual Starry Heatmap */}
      <StarHeatmap
        stars={stars}
        tokenMode={tokenMode}
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
        onHighlightDateInSky={onHighlightDateInSky}
      />

      {/* Multi-Dimensional Tables */}
      <UsageTables
        stars={stars}
        tokenMode={tokenMode}
        privacyMode={privacyMode}
        selectedDate={selectedDate}
        highlightedStarId={highlightedStarId}
        onClearDateFilter={handleClearDateFilter}
        onLocateStar={onLocateStarInSky}
        onHighlightDateInSky={onHighlightDateInSky}
      />

      {/* Collapsible Diagnostics Footer */}
      <footer className="ts-panel ts-diagnostics" aria-label="数据源状态与扫描诊断">
        <div className="ts-diagnostics-bar">
          <div className="ts-diagnostics-summary">
            <span className="ts-diag-chip">只读本地扫描</span>
            <span className="ts-diag-path" title={scannedDirs}>
              {scannedDirs}
            </span>
            <span className="ts-diag-meta ts-tabular">
              已解析 {parsedCount} 次对话 · 耗时 {Math.round(scanDurationMs)} ms
            </span>
            {totalWarnings > 0 && (
              <span className="ts-diag-warn-badge ts-tabular">
                {totalWarnings} 条提醒
              </span>
            )}
          </div>
          <button
            type="button"
            className="ts-ghost-btn"
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((v) => !v)}
          >
            {diagnosticsOpen ? '收起诊断' : '展开诊断'}
          </button>
        </div>

        {diagnosticsOpen && (
          <div className="ts-diagnostics-details">
            {sources.length === 0 ? (
              <div className="ts-diag-empty">尚未接收到数据源扫描报告。</div>
            ) : (
              sources.map((src) => (
                <div key={`${src.source}:${src.directory}`} className="ts-diag-source">
                  <div className="ts-diag-source-row">
                    <strong>{sourceLabel(src.source)}</strong>
                    <code className="ts-diag-code">{src.directory}</code>
                    <span className="ts-tabular">
                      状态: {src.exists ? '存在' : '目录不存在'} · 扫描 {src.scanned_files} · 解析{' '}
                      {src.parsed_conversations} · 跳过 {src.skipped_files}
                    </span>
                  </div>
                  {src.warnings.length > 0 && (
                    <ul className="ts-diag-warnings">
                      {src.warnings.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
