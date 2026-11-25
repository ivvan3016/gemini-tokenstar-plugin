import type { CSSProperties } from 'react';

export type PlaybackSpeed = 1 | 2 | 5;

export interface PlaybackBarProps {
  isActive: boolean;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  visibleCount: number;
  totalCount: number;
  currentDate: string | null;
  onTogglePlay: () => void;
  onCycleSpeed: () => void;
  onScrub: (count: number) => void;
  onExitReset: () => void;
}

const BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  padding: '6px 10px',
  background: 'rgba(8, 14, 30, 0.82)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid var(--color-border-primary, rgba(164, 196, 255, 0.2))',
  borderRadius: '12px',
  color: '#dce8ff',
  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.42)',
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  fontSize: '12px',
  maxWidth: '100%',
};

const PILL_BTN_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 9px',
  borderRadius: '8px',
  border: '1px solid rgba(154, 184, 255, 0.22)',
  background: 'rgba(26, 44, 84, 0.45)',
  color: '#eaf2ff',
  fontSize: '12px',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/** Compact timeline playback controller for chronological star and constellation evolution. */
export function PlaybackBar({
  isActive,
  isPlaying,
  speed,
  visibleCount,
  totalCount,
  currentDate,
  onTogglePlay,
  onCycleSpeed,
  onScrub,
  onExitReset,
}: PlaybackBarProps) {
  const disabled = totalCount === 0;
  const displayCount = isActive ? visibleCount : totalCount;

  return (
    <div
      className="ts-playback-bar"
      role="region"
      aria-label="星空演化回放控制"
      style={BAR_STYLE}
    >
      <button
        type="button"
        onClick={onTogglePlay}
        disabled={disabled}
        aria-label={isPlaying ? '暂停回放' : '播放演化'}
        style={{
          ...PILL_BTN_STYLE,
          background: isPlaying ? 'rgba(98, 152, 245, 0.32)' : PILL_BTN_STYLE.background,
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span aria-hidden="true">{isPlaying ? '❚❚' : '▶'}</span>
        <span>{isPlaying ? '暂停' : '播放'}</span>
      </button>

      <button
        type="button"
        onClick={onCycleSpeed}
        disabled={disabled}
        aria-label={`切换回放倍速（当前 ${speed}x）`}
        style={{
          ...PILL_BTN_STYLE,
          minWidth: '42px',
          justifyContent: 'center',
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {speed}x
      </button>

      <input
        type="range"
        min={0}
        max={Math.max(1, totalCount)}
        step={1}
        value={disabled ? 0 : displayCount}
        disabled={disabled}
        aria-label="时间轴回放进度"
        onChange={(e) => onScrub(Number(e.target.value))}
        style={{
          width: '130px',
          minWidth: '84px',
          flex: '1 1 110px',
          accentColor: '#9ecbff',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      />

      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          color: '#cfe0ff',
          whiteSpace: 'nowrap',
        }}
      >
        {currentDate || '—'}
      </span>

      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          color: 'rgba(186, 206, 242, 0.72)',
          whiteSpace: 'nowrap',
        }}
      >
        {displayCount} / {totalCount}
      </span>

      {(isActive || displayCount < totalCount) && (
        <button
          type="button"
          onClick={onExitReset}
          aria-label="退出并重置回放"
          style={{
            ...PILL_BTN_STYLE,
            background: 'rgba(255, 255, 255, 0.06)',
            color: '#c7d8ff',
          }}
        >
          退出回放
        </button>
      )}
    </div>
  );
}
