import type { CSSProperties } from 'react';
import type { CelestialType, TokenMode } from '../../types/sky';
import { getDisplayTitle } from '../../logic/filters';
import { effectiveTokens } from '../../logic/metrics';
import { getModelSpectralColor, type StarNode, type SubagentCluster } from '../../logic/starLayout';

export interface CelestialMeta {
  type: CelestialType;
  label: string;
  description: string;
  accent: string;
}

export const CELESTIAL_ORDER: CelestialType[] = [
  'star',
  'black_hole',
  'binary',
  'pulsar',
  'comet',
];

export const CELESTIAL_META: Record<CelestialType, CelestialMeta> = {
  star: {
    type: 'star',
    label: '恒星',
    description: '常规深度响应',
    accent: '#ffd89b',
  },
  black_hole: {
    type: 'black_hole',
    label: '黑洞',
    description: '异常中断或错误响应',
    accent: '#d97f6c',
  },
  binary: {
    type: 'binary',
    label: '双星',
    description: '触发子代理协同探索',
    accent: '#a8ceff',
  },
  pulsar: {
    type: 'pulsar',
    label: '脉冲星',
    description: '高频工具调用任务',
    accent: '#b6e5e8',
  },
  comet: {
    type: 'comet',
    label: '彗星',
    description: '轻量快问快答',
    accent: '#e6f0ff',
  },
};

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0';
  return Math.max(0, Math.round(tokens)).toLocaleString('en-US');
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocalTimestamp(iso: string): { date: string; time: string } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
  };
}

export function formatDateTimeRange(startedAt: string, endedAt: string): string {
  const start = formatLocalTimestamp(startedAt);
  const end = formatLocalTimestamp(endedAt);
  if (!start && !end) return startedAt || endedAt || '—';
  if (start && !end) return `${start.date} ${start.time}`;
  if (!start && end) return `${end.date} ${end.time}`;
  if (start && end) {
    if (start.date === end.date) {
      if (start.time === end.time) {
        return `${start.date} ${start.time}`;
      }
      return `${start.date} ${start.time} – ${end.time}`;
    }
    return `${start.date} ${start.time} – ${end.date} ${end.time}`;
  }
  return '—';
}

export function CelestialEmblem({
  type,
  color,
  size = 24,
}: {
  type: CelestialType;
  color: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}
    >
      {type === 'star' && (
        <g>
          <circle cx="16" cy="16" r="8.5" fill={color} fillOpacity="0.18" />
          <line x1="16" y1="3" x2="16" y2="29" stroke={color} strokeWidth="0.9" strokeOpacity="0.82" />
          <line x1="3" y1="16" x2="29" y2="16" stroke={color} strokeWidth="0.9" strokeOpacity="0.82" />
          <circle cx="16" cy="16" r="4.8" fill={color} fillOpacity="0.45" />
          <circle cx="16" cy="16" r="2.7" fill="#ffffff" />
        </g>
      )}

      {type === 'black_hole' && (
        <g>
          <path
            d="M 8.5 15 A 7.5 7.5 0 0 1 23.5 15"
            fill="none"
            stroke="#ffd49c"
            strokeWidth="1.4"
            strokeOpacity="0.65"
          />
          <ellipse
            cx="16"
            cy="16"
            rx="13"
            ry="3.6"
            transform="rotate(-18 16 16)"
            fill="none"
            stroke="#e89464"
            strokeWidth="1.9"
            strokeOpacity="0.85"
          />
          <circle cx="16" cy="16" r="5.2" fill="#000000" stroke="#ffe5bd" strokeWidth="1" />
        </g>
      )}

      {type === 'binary' && (
        <g>
          <circle cx="16" cy="16" r="9.5" fill={color} fillOpacity="0.14" />
          <circle cx="13.2" cy="17.8" r="4.8" fill={color} fillOpacity="0.34" />
          <circle cx="13.2" cy="17.8" r="2.7" fill="#ffffff" />
          <circle cx="20.4" cy="13.2" r="3.4" fill="#ffd8a8" fillOpacity="0.4" />
          <circle cx="20.4" cy="13.2" r="1.9" fill="#fff6eb" />
        </g>
      )}

      {type === 'pulsar' && (
        <g>
          <ellipse cx="14" cy="14" rx="7.5" ry="5.5" transform="rotate(-24 14 14)" fill="#7fdce6" fillOpacity="0.16" />
          <ellipse cx="18.5" cy="18" rx="6.2" ry="4.5" transform="rotate(18 18.5 18)" fill="#d87a92" fillOpacity="0.12" />
          <polygon points="16,16 26,4.5 27.8,6.6" fill="#bceef4" fillOpacity="0.55" />
          <polygon points="16,16 6,27.5 4.2,25.4" fill="#bceef4" fillOpacity="0.55" />
          <circle cx="16" cy="16" r="2.6" fill="#ffffff" />
        </g>
      )}

      {type === 'comet' && (
        <g>
          <path
            d="M 21.5 19.5 Q 13 18 5 15 L 7 12.2 Q 14.5 15.8 21.5 19.5 Z"
            fill="#ffe8cb"
            fillOpacity="0.38"
          />
          <line
            x1="21.5"
            y1="19.5"
            x2="6"
            y2="9.5"
            stroke="#94ceff"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeOpacity="0.72"
          />
          <circle cx="21.5" cy="19.5" r="4.6" fill="#c8f0ef" fillOpacity="0.35" />
          <circle cx="21.5" cy="19.5" r="2.2" fill="#ffffff" />
        </g>
      )}
    </svg>
  );
}

export interface DetailDrawerProps {
  node: StarNode;
  tokenMode: TokenMode;
  privacyMode: boolean;
  clusters?: SubagentCluster[];
  expandedClusterIds?: Set<string>;
  expandAllSubagents?: boolean;
  onToggleCluster?: (clusterId: string) => void;
  onFocusCluster?: (cluster: SubagentCluster) => void;
  onClose: () => void;
  onJumpToStats: (starId: string) => void;
}

const CLUSTER_ACTION_BTN_STYLE: CSSProperties = {
  fontSize: '10.5px',
  padding: '2px 8px',
  borderRadius: '999px',
  border: '1px solid rgba(168, 206, 255, 0.34)',
  background: 'rgba(84, 134, 224, 0.2)',
  color: '#dceaff',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const DRAWER_STYLE: CSSProperties = {
  position: 'absolute',
  top: '12px',
  right: '12px',
  width: 'min(372px, calc(100% - 24px))',
  maxHeight: 'calc(100% - 82px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(6, 10, 20, 0.88)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  border: '1px solid var(--color-border-primary, rgba(170, 198, 255, 0.16))',
  borderRadius: '14px',
  color: '#e8f0ff',
  boxShadow: '0 16px 44px rgba(0, 0, 0, 0.65)',
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  zIndex: 30,
  overflow: 'hidden',
};

const SECTION_CARD_STYLE: CSSProperties = {
  background: 'rgba(11, 18, 34, 0.62)',
  border: '1px solid rgba(164, 194, 248, 0.12)',
  borderRadius: '10px',
  padding: '10px 12px',
};

/** Right floating observatory inspection drawer for a selected request star & its parent constellation. */
export function DetailDrawer({
  node,
  tokenMode,
  privacyMode,
  clusters,
  expandedClusterIds,
  expandAllSubagents = false,
  onToggleCluster,
  onFocusCluster,
  onClose,
  onJumpToStats,
}: DetailDrawerProps) {
  const { request, star } = node;
  const meta = CELESTIAL_META[request.celestial_type];
  const nodeColor = node.color || getModelSpectralColor(request.model || star.primary_model);
  const displayTitle = getDisplayTitle(star, node.convIndex, privacyMode);
  const convActiveTokens = effectiveTokens(star, tokenMode);

  const rawTotal = request.input_tokens + request.cache_read_tokens + request.output_tokens;
  const denom = rawTotal > 0 ? rawTotal : 1;
  const inputPct = rawTotal > 0 ? (request.input_tokens / denom) * 100 : 0;
  const cachePct = rawTotal > 0 ? (request.cache_read_tokens / denom) * 100 : 0;
  const outputPct = rawTotal > 0 ? (request.output_tokens / denom) * 100 : 0;

  const modelItems =
    star.models.length > 0
      ? star.models
      : [
          {
            model: star.primary_model || 'unknown',
            input_tokens: star.input_tokens,
            cache_read_tokens: star.cache_read_tokens,
            output_tokens: star.output_tokens,
            total_tokens: star.total_tokens,
            steps: star.model_steps_count,
          },
        ];

  return (
    <aside
      className="ts-detail-drawer"
      aria-label="星体详情抽屉"
      style={DRAWER_STYLE}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          padding: '14px 14px 10px',
          borderBottom: '1px solid rgba(164, 194, 248, 0.12)',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: 'rgba(3, 6, 14, 0.92)',
            border: '1px solid rgba(170, 198, 255, 0.16)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <CelestialEmblem type={request.celestial_type} color={nodeColor} size={30} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 7px',
                borderRadius: '999px',
                background: 'rgba(154, 184, 255, 0.12)',
                color: meta.accent,
                border: '1px solid rgba(154, 184, 255, 0.2)',
                fontWeight: 600,
              }}
            >
              {meta.label}
            </span>
            <span
              style={{
                fontSize: '10.5px',
                padding: '1px 6px',
                borderRadius: '999px',
                background: 'rgba(255, 255, 255, 0.06)',
                color: '#d4e4ff',
                border: '1px solid rgba(170, 198, 255, 0.14)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              第 {node.requestIndexInConv + 1} / {node.convRequestCount} 次请求
            </span>
            {request.is_subagent && (
              <span
                style={{
                  fontSize: '10px',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  background: 'rgba(168, 206, 255, 0.14)',
                  color: '#b8d7ff',
                }}
              >
                {request.subagent_role || '子代理'}
              </span>
            )}
            {request.is_subagent &&
              node.subagentClusterId &&
              onToggleCluster &&
              !expandAllSubagents && (
                <button
                  type="button"
                  onClick={() => onToggleCluster(node.subagentClusterId!)}
                  style={CLUSTER_ACTION_BTN_STYLE}
                >
                  收起为伴星团
                </button>
              )}
            {star.is_orphan_subagent && (
              <span
                style={{
                  fontSize: '10px',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  background: 'rgba(255, 210, 140, 0.14)',
                  color: '#ffd79a',
                }}
              >
                孤儿子代理
              </span>
            )}
          </div>
          <h3
            style={{
              margin: '5px 0 3px',
              fontSize: '14px',
              fontWeight: 600,
              lineHeight: 1.35,
              color: '#f2f6ff',
              wordBreak: 'break-word',
            }}
          >
            {displayTitle}
          </h3>
          <div style={{ fontSize: '11.5px', color: 'rgba(186, 206, 240, 0.76)' }}>
            请求时间：{formatDateTimeRange(request.created_at, request.created_at)}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          style={{
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(164, 196, 255, 0.15)',
            color: '#c7d8ff',
            borderRadius: '8px',
            width: '28px',
            height: '28px',
            cursor: 'pointer',
            fontSize: '15px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>

      {/* Scrollable Body */}
      <div
        style={{
          padding: '12px 14px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div
          style={{
            fontSize: '12px',
            color: '#c6d8fa',
            background: 'rgba(128, 166, 255, 0.07)',
            border: '1px solid rgba(128, 166, 255, 0.14)',
            borderRadius: '8px',
            padding: '7px 10px',
          }}
        >
          星体归类：{request.celestial_reason || meta.description}
        </div>

        {/* Single-Request Token Breakdown */}
        <div style={SECTION_CARD_STYLE}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '8px',
            }}
          >
            <span style={{ fontSize: '12px', color: 'rgba(196, 214, 246, 0.8)' }}>
              {tokenMode === 'total' ? '本步请求（含缓存）' : '本步请求（仅新增）'}
            </span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff' }}>
              {formatTokenCount(node.effectiveTokens)}
            </span>
          </div>

          <div
            aria-label="Token 构成比例条"
            style={{
              height: '8px',
              borderRadius: '999px',
              background: 'rgba(255, 255, 255, 0.06)',
              overflow: 'hidden',
              display: 'flex',
              marginBottom: '9px',
            }}
          >
            {inputPct > 0 && (
              <div
                style={{ width: `${inputPct}%`, background: '#68a8ff' }}
                title={`Input: ${formatTokenCount(request.input_tokens)}`}
              />
            )}
            {cachePct > 0 && (
              <div
                style={{ width: `${cachePct}%`, background: '#516799' }}
                title={`Cache Read: ${formatTokenCount(request.cache_read_tokens)}`}
              />
            )}
            {outputPct > 0 && (
              <div
                style={{ width: `${outputPct}%`, background: '#ffd27d' }}
                title={`Output: ${formatTokenCount(request.output_tokens)}`}
              />
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: '6px',
              fontSize: '11.5px',
            }}
          >
            <div>
              <div style={{ color: 'rgba(184, 206, 244, 0.72)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: '#68a8ff', display: 'inline-block' }} />
                Input
              </div>
              <div style={{ fontWeight: 600, marginTop: '2px' }}>{formatTokenCount(request.input_tokens)}</div>
            </div>
            <div>
              <div style={{ color: 'rgba(184, 206, 244, 0.72)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: '#516799', display: 'inline-block' }} />
                Cache Read
              </div>
              <div style={{ fontWeight: 600, marginTop: '2px' }}>{formatTokenCount(request.cache_read_tokens)}</div>
            </div>
            <div>
              <div style={{ color: 'rgba(184, 206, 244, 0.72)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: '#ffd27d', display: 'inline-block' }} />
                Output
              </div>
              <div style={{ fontWeight: 600, marginTop: '2px' }}>{formatTokenCount(request.output_tokens)}</div>
            </div>
          </div>
        </div>

        {/* Single-Request Metrics Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '8px',
            fontSize: '12px',
          }}
        >
          <div style={SECTION_CARD_STYLE}>
            <div style={{ fontSize: '11px', color: 'rgba(184, 206, 244, 0.68)' }}>响应模型</div>
            <div
              style={{
                fontWeight: 600,
                marginTop: '2px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                overflow: 'hidden',
              }}
              title={request.model || star.primary_model}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: nodeColor,
                  boxShadow: `0 0 6px ${nodeColor}`,
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {request.model || star.primary_model || 'unknown'}
              </span>
            </div>
          </div>
          <div style={SECTION_CARD_STYLE}>
            <div style={{ fontSize: '11px', color: 'rgba(184, 206, 244, 0.68)' }}>所属轮次</div>
            <div style={{ fontWeight: 600, marginTop: '2px' }}>
              {request.turn_index > 0 ? `第 ${request.turn_index} 轮` : '模型响应'}
            </div>
          </div>
          <div style={SECTION_CARD_STYLE}>
            <div style={{ fontSize: '11px', color: 'rgba(184, 206, 244, 0.68)' }}>本步工具 / 子代理</div>
            <div style={{ fontWeight: 600, marginTop: '2px' }}>
              {request.tool_calls_count} 工具 · {request.subagent_calls_count} 子代理
            </div>
          </div>
          <div style={SECTION_CARD_STYLE}>
            <div style={{ fontSize: '11px', color: 'rgba(184, 206, 244, 0.68)' }}>请求状态</div>
            <div style={{ fontWeight: 600, marginTop: '2px' }}>{request.status || 'UNKNOWN'}</div>
          </div>
        </div>

        {/* Parent Conversation Constellation Overview */}
        <div style={SECTION_CARD_STYLE}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '8px',
              marginBottom: '6px',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#dce8ff' }}>
              所属对话星座总览
            </span>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#edf4ff' }}>
              {formatTokenCount(convActiveTokens)}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(184, 206, 244, 0.72)', marginBottom: '7px' }}>
            {formatDateTimeRange(star.started_at, star.ended_at)} · {star.user_turns} 轮对话 · {node.convRequestCount} 颗星体
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', paddingTop: '6px', borderTop: '1px solid rgba(154, 184, 255, 0.09)' }}>
            {modelItems.map((m) => {
              const mColor = getModelSpectralColor(m.model);
              const mTokens =
                tokenMode === 'total' ? m.total_tokens : m.input_tokens + m.output_tokens;
              return (
                <div
                  key={m.model}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    fontSize: '11.5px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: mColor,
                        boxShadow: `0 0 5px ${mColor}`,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={m.model}
                    >
                      {m.model}
                    </span>
                  </div>
                  <span style={{ color: 'rgba(196, 214, 246, 0.78)', flexShrink: 0 }}>
                    {m.steps} 步 · {formatTokenCount(mTokens)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Companion Subagents */}
        {star.subagents.length > 0 && (
          <div style={SECTION_CARD_STYLE}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '7px', color: '#dce8ff' }}>
              伴星（子代理）消耗明细
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {star.subagents.map((sub) => {
                const subColor = getModelSpectralColor(sub.primary_model);
                const subTokens =
                  tokenMode === 'total' ? sub.total_tokens : sub.non_cache_tokens;
                const roleLabel = sub.role || sub.type_name || '子代理';
                const cluster = clusters?.find(
                  (c) => c.conversationId === star.id && c.sessionId === sub.id,
                );
                const stepCount = sub.request_count || cluster?.requestCount || 0;
                const isExpanded = cluster
                  ? Boolean(expandAllSubagents || expandedClusterIds?.has(cluster.id))
                  : false;
                return (
                  <div
                    key={sub.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      fontSize: '11.5px',
                      padding: '4px 0',
                      borderTop: '1px solid rgba(154, 184, 255, 0.08)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: '#e5eeff', wordBreak: 'break-word' }}>
                        {roleLabel}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          color: 'rgba(184, 206, 244, 0.72)',
                          marginTop: '1px',
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: subColor,
                            display: 'inline-block',
                          }}
                        />
                        <span>{sub.primary_model || 'unknown'}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <span
                        style={{
                          fontWeight: 600,
                          color: '#dce8ff',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {stepCount} 步 · {formatTokenCount(subTokens)}
                      </span>
                      {cluster && !isExpanded && (onFocusCluster || onToggleCluster) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (onFocusCluster) {
                              onFocusCluster(cluster);
                            } else {
                              onToggleCluster?.(cluster.id);
                            }
                          }}
                          style={CLUSTER_ACTION_BTN_STYLE}
                        >
                          展开轨迹
                        </button>
                      )}
                      {cluster && isExpanded && !expandAllSubagents && onToggleCluster && (
                        <button
                          type="button"
                          onClick={() => onToggleCluster(cluster.id)}
                          style={{
                            ...CLUSTER_ACTION_BTN_STYLE,
                            background: 'rgba(16, 26, 48, 0.65)',
                            borderColor: 'rgba(164, 194, 248, 0.24)',
                          }}
                        >
                          收起星团
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer Action */}
      <div
        style={{
          padding: '10px 14px 12px',
          borderTop: '1px solid rgba(164, 194, 248, 0.12)',
          background: 'rgba(4, 7, 15, 0.65)',
        }}
      >
        <button
          type="button"
          onClick={() => onJumpToStats(star.id)}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '9px',
            border: '1px solid rgba(170, 204, 255, 0.3)',
            background: 'rgba(84, 134, 224, 0.2)',
            color: '#edf4ff',
            fontSize: '12.5px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          在统计列表中查看该对话
        </button>
      </div>
    </aside>
  );
}
