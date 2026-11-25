import { useEffect, useRef, useState } from 'react';
import type { SourceScanReport, TokenMode } from '../types/sky';

export type ActiveTab = 'sky' | 'stats';

export interface TopBarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  tokenMode: TokenMode;
  onTokenModeChange: (mode: TokenMode) => void;
  privacyMode: boolean;
  onTogglePrivacy: () => void;
  lastUpdatedAt: string | null;
  sources: SourceScanReport[];
  isLoading?: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatClockTime(iso: string | null): string {
  if (!iso) return '--:--:--';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--:--:--';
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function sourceDisplayName(source: SourceScanReport['source']): string {
  return source === 'antigravity' ? 'Antigravity 日志' : 'Gemini CLI 日志';
}

/** Global single-row observatory HUD with tab switch, token mode, privacy mode, and sync controls. */
export function TopBar({
  activeTab,
  onTabChange,
  tokenMode,
  onTokenModeChange,
  privacyMode,
  onTogglePrivacy,
  lastUpdatedAt,
  sources,
  isLoading = false,
  isRefreshing,
  onRefresh,
}: TopBarProps) {
  const [warningsOpen, setWarningsOpen] = useState(false);
  const warningsWrapRef = useRef<HTMLDivElement | null>(null);

  const sourcesWithWarnings = sources.filter((s) => s.warnings.length > 0);
  const totalWarnings = sourcesWithWarnings.reduce((sum, s) => sum + s.warnings.length, 0);
  const formattedTime = formatClockTime(lastUpdatedAt);

  useEffect(() => {
    if (!warningsOpen) return;
    const handleDocMouseDown = (event: MouseEvent) => {
      if (
        warningsWrapRef.current &&
        !warningsWrapRef.current.contains(event.target as Node)
      ) {
        setWarningsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWarningsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [warningsOpen]);

  useEffect(() => {
    if (totalWarnings === 0 && warningsOpen) {
      setWarningsOpen(false);
    }
  }, [totalWarnings, warningsOpen]);

  return (
    <header className="ts-topbar" role="banner">
      <div className="ts-topbar-left">
        <div className="ts-brand" title="TokenStar · 对话星空与用量观测台">
          <svg
            className="ts-brand-emblem"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9.5" fill="rgba(158, 203, 255, 0.12)" stroke="rgba(158, 203, 255, 0.35)" strokeWidth="1" />
            <path
              d="M12 3.5 L13.4 10.6 L20.5 12 L13.4 13.4 L12 20.5 L10.6 13.4 L3.5 12 L10.6 10.6 Z"
              fill="#ffe3a3"
            />
            <circle cx="12" cy="12" r="2.2" fill="#ffffff" />
          </svg>
          <span className="ts-brand-name">TokenStar</span>
        </div>

        <nav className="ts-tab-switch" role="tablist" aria-label="主视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sky'}
            className={`ts-tab-btn${activeTab === 'sky' ? ' is-active' : ''}`}
            onClick={() => onTabChange('sky')}
          >
            ✦ 星空
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'stats'}
            className={`ts-tab-btn${activeTab === 'stats' ? ' is-active' : ''}`}
            onClick={() => onTabChange('stats')}
          >
            ◈ 统计
          </button>
        </nav>
      </div>

      <div className="ts-topbar-right">
        <div className="ts-segmented" role="group" aria-label="Token 统计口径">
          <button
            type="button"
            aria-pressed={tokenMode === 'total'}
            className={`ts-seg-btn${tokenMode === 'total' ? ' is-active' : ''}`}
            onClick={() => onTokenModeChange('total')}
            title="含缓存：Input + Cache Read + Output"
          >
            含缓存
          </button>
          <button
            type="button"
            aria-pressed={tokenMode === 'non_cache'}
            className={`ts-seg-btn${tokenMode === 'non_cache' ? ' is-active' : ''}`}
            onClick={() => onTokenModeChange('non_cache')}
            title="仅新增：Input + Output"
          >
            仅新增
          </button>
        </div>

        <button
          type="button"
          aria-pressed={privacyMode}
          className={`ts-hud-pill${privacyMode ? ' is-active' : ''}`}
          onClick={onTogglePrivacy}
          title="隐藏对话标题，统一脱敏为星体编号"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {privacyMode ? (
              <>
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.77 21.77 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-3.16 4.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </>
            ) : (
              <>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
          <span>隐私模式</span>
        </button>

        <div className="ts-sync-group">
          <span className="ts-sync-time" title={`最近更新于 ${formattedTime}`}>
            <span className="ts-sync-label">最近更新于 </span>
            <span className="ts-tabular">{formattedTime}</span>
          </span>

          {totalWarnings > 0 && (
            <div className="ts-warnings-wrap" ref={warningsWrapRef}>
              <button
                type="button"
                aria-label="扫描警告"
                aria-expanded={warningsOpen}
                className={`ts-warn-btn${warningsOpen ? ' is-active' : ''}`}
                onClick={() => setWarningsOpen((v) => !v)}
                title={`存在 ${totalWarnings} 条非阻塞扫描提醒`}
              >
                <span aria-hidden="true">⚠</span>
                <span className="ts-tabular">{totalWarnings}</span>
              </button>

              {warningsOpen && (
                <div
                  className="ts-warnings-popover"
                  role="dialog"
                  aria-label="数据源扫描警告详情"
                >
                  <div className="ts-warnings-header">
                    <span>数据源扫描提醒（{totalWarnings}）</span>
                    <button
                      type="button"
                      className="ts-icon-close"
                      aria-label="关闭警告弹窗"
                      onClick={() => setWarningsOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="ts-warnings-list">
                    {sourcesWithWarnings.map((src) => (
                      <div key={`${src.source}:${src.directory}`} className="ts-warning-source">
                        <div className="ts-warning-source-title">{sourceDisplayName(src.source)}</div>
                        <div className="ts-warning-source-dir">{src.directory}</div>
                        <ul>
                          {src.warnings.map((w, idx) => (
                            <li key={idx}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className={`ts-hud-pill ts-refresh-btn${isRefreshing ? ' is-refreshing' : ''}`}
            disabled={isRefreshing || isLoading}
            onClick={onRefresh}
            aria-label="刷新数据"
          >
            <svg
              className={isRefreshing ? 'ts-spin' : undefined}
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>{isRefreshing ? '刷新中' : '刷新'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
