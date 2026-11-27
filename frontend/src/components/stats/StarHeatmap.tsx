import { useMemo, useState } from 'react';
import type { ConversationStar, TokenMode } from '../../types/sky';
import {
  computeDailyHeatmap,
  getAvailableYears,
  type HeatmapCell,
} from '../../logic/metrics';
import { formatTokenCount } from '../sky/DetailDrawer';

export interface StarHeatmapProps {
  stars: ConversationStar[];
  tokenMode: TokenMode;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  onHighlightDateInSky: (date: string) => void;
}

const WEEKDAY_LABELS: Array<{ row: number; label: string }> = [
  { row: 1, label: '一' },
  { row: 3, label: '三' },
  { row: 5, label: '五' },
];

const HEATMAP_LEVEL_LABELS = ['无记录', '微光', '星云', '银辉', '鎏金'] as const;

interface MonthLabel {
  weekIndex: number;
  label: string;
}

function buildMonthLabels(weeks: HeatmapCell[][]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  let lastWeekIdx = -10;
  let seenMonths = new Set<number>();

  weeks.forEach((week, weekIndex) => {
    const firstDayCell = week.find((c) => c.inYear && c.date.endsWith('-01'));
    const fallbackJan =
      weekIndex === 0 ? week.find((c) => c.inYear && c.date.slice(5, 7) === '01') : undefined;
    const target = firstDayCell ?? fallbackJan;
    if (!target) return;
    const monthNum = Number(target.date.slice(5, 7));
    if (seenMonths.has(monthNum)) return;
    if (weekIndex - lastWeekIdx < 2 && labels.length > 0) return;
    seenMonths.add(monthNum);
    lastWeekIdx = weekIndex;
    labels.push({ weekIndex, label: `${monthNum}月` });
  });

  return labels;
}

/** Starry GitHub-style 52/53-week annual contribution heatmap with year switch and sky linkage. */
export function StarHeatmap({
  stars,
  tokenMode,
  selectedDate,
  onSelectDate,
  onHighlightDateInSky,
}: StarHeatmapProps) {
  const availableYears = useMemo(() => getAvailableYears(stars), [stars]);
  const [userYear, setUserYear] = useState<number | null>(null);
  const activeYear =
    userYear !== null && availableYears.includes(userYear) ? userYear : availableYears[0];

  const [hoveredDate, setHoveredDate] = useState<string | null>(null);

  const grid = useMemo(
    () => computeDailyHeatmap(stars, activeYear, tokenMode),
    [stars, activeYear, tokenMode],
  );

  const hoveredCell = hoveredDate ? (grid.byDate[hoveredDate] ?? null) : null;

  const monthLabels = useMemo(() => buildMonthLabels(grid.weeks), [grid.weeks]);
  const monthByWeek = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of monthLabels) {
      map.set(m.weekIndex, m.label);
    }
    return map;
  }, [monthLabels]);

  const { yearTokens, yearConversations, yearRequests, activeDaysInYear } = useMemo(() => {
    let tokens = 0;
    let requests = 0;
    let activeDays = 0;
    const convIds = new Set<string>();
    for (const day of grid.days) {
      tokens += day.tokens;
      requests += day.requestCount;
      for (const conv of day.conversations) {
        convIds.add(conv.id);
      }
      if (day.requestCount > 0 || day.count > 0) activeDays += 1;
    }
    return {
      yearTokens: tokens,
      yearConversations: convIds.size,
      yearRequests: requests,
      activeDaysInYear: activeDays,
    };
  }, [grid.days]);

  const formatCellSummary = (cell: HeatmapCell) =>
    `${cell.date} · ${cell.count} 次对话${cell.requestCount > cell.count ? `（${cell.requestCount} 次请求）` : ''} · ${formatTokenCount(cell.tokens)} Tokens`;

  return (
    <section className="ts-panel ts-heatmap-section" aria-label="年度星光贡献热力图">
      <div className="ts-heatmap-header">
        <div className="ts-heatmap-title-group">
          <h2 className="ts-section-title">年度星光贡献图</h2>
          <p className="ts-heatmap-subtitle">
            {activeYear} 年 · <span className="ts-tabular">{yearConversations}</span> 次对话
            {yearRequests > yearConversations && (
              <>
                {' · '}
                <span className="ts-tabular">{yearRequests}</span> 次请求
              </>
            )}
            {' · '}
            <span className="ts-tabular">{activeDaysInYear}</span> 活跃天 ·{' '}
            <span className="ts-tabular">{formatTokenCount(yearTokens)}</span> Tokens
          </p>
        </div>

        <div className="ts-heatmap-actions">
          {selectedDate && (
            <div className="ts-heatmap-selection-actions">
              <button
                type="button"
                className="ts-accent-btn"
                onClick={() => onHighlightDateInSky(selectedDate)}
              >
                ✦ 在星空页高亮这一天
              </button>
              <button
                type="button"
                className="ts-ghost-btn"
                onClick={() => onSelectDate(null)}
                aria-label="取消日期筛选"
              >
                清除 ({selectedDate})
              </button>
            </div>
          )}

          {availableYears.length <= 6 ? (
            <div className="ts-year-chips" role="group" aria-label="选择年份">
              {availableYears.map((year) => (
                <button
                  key={year}
                  type="button"
                  aria-pressed={year === activeYear}
                  className={`ts-year-chip${year === activeYear ? ' is-active' : ''}`}
                  onClick={() => setUserYear(year)}
                >
                  {year}
                </button>
              ))}
            </div>
          ) : (
            <select
              aria-label="选择年份"
              className="ts-select"
              value={activeYear}
              onChange={(e) => setUserYear(Number(e.target.value))}
            >
              {availableYears.map((year) => (
                <option key={year} value={year}>
                  {year} 年
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="ts-heatmap-tooltip-bar">
        {hoveredCell ? (
          <div className="ts-heatmap-tooltip" role="tooltip">
            <span className={`ts-heatmap-dot level-${hoveredCell.level}`} aria-hidden="true" />
            <span>{formatCellSummary(hoveredCell)}</span>
          </div>
        ) : (
          <div className="ts-heatmap-hint">
            悬停格子查看当日实际请求消耗，点击任意日期可联动筛选下方列表与高亮星空。
          </div>
        )}
      </div>

      <div className="ts-heatmap-scroll">
        <div
          className="ts-heatmap-matrix-wrap"
          style={{ ['--ts-week-count' as string]: grid.weeks.length }}
        >
          {/* Month axis */}
          <div className="ts-heatmap-months" aria-hidden="true">
            <div className="ts-heatmap-axis-spacer" />
            <div className="ts-heatmap-months-row">
              {grid.weeks.map((_week, wIdx) => (
                <div key={wIdx} className="ts-heatmap-month-slot">
                  {monthByWeek.get(wIdx) ?? ''}
                </div>
              ))}
            </div>
          </div>

          <div className="ts-heatmap-body">
            {/* Weekday axis */}
            <div className="ts-heatmap-weekdays" aria-hidden="true">
              {Array.from({ length: 7 }, (_, row) => {
                const found = WEEKDAY_LABELS.find((item) => item.row === row);
                return (
                  <div key={row} className="ts-heatmap-weekday-label">
                    {found ? found.label : ''}
                  </div>
                );
              })}
            </div>

            {/* 52/53 weeks x 7 days grid */}
            <div className="ts-heatmap-weeks" role="grid" aria-label={`${activeYear} 年每日消耗矩阵`}>
              {grid.weeks.map((week, wIdx) => (
                <div key={wIdx} className="ts-heatmap-week-col">
                  {week.map((cell) => {
                    if (!cell.inYear) {
                      return (
                        <span
                          key={cell.date}
                          className="ts-heatmap-cell is-outside"
                          aria-hidden="true"
                        />
                      );
                    }
                    const isSelected = selectedDate === cell.date;
                    const label = formatCellSummary(cell);
                    return (
                      <button
                        key={cell.date}
                        type="button"
                        data-date={cell.date}
                        data-level={cell.level}
                        aria-label={label}
                        aria-pressed={isSelected}
                        title={label}
                        className={`ts-heatmap-cell level-${cell.level}${isSelected ? ' is-selected' : ''}`}
                        onMouseEnter={() => setHoveredDate(cell.date)}
                        onMouseOver={() => setHoveredDate(cell.date)}
                        onMouseLeave={() => setHoveredDate((prev) => (prev === cell.date ? null : prev))}
                        onFocus={() => setHoveredDate(cell.date)}
                        onBlur={() => setHoveredDate((prev) => (prev === cell.date ? null : prev))}
                        onClick={() => onSelectDate(isSelected ? null : cell.date)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="ts-heatmap-footer">
        <span className="ts-heatmap-legend-text">星等强度</span>
        <div className="ts-heatmap-legend" aria-label="热力图图例">
          <span>少</span>
          {([0, 1, 2, 3, 4] as const).map((lvl) => (
            <span
              key={lvl}
              className={`ts-heatmap-cell is-legend level-${lvl}`}
              title={HEATMAP_LEVEL_LABELS[lvl]}
            />
          ))}
          <span>多</span>
        </div>
      </div>
    </section>
  );
}
