import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkyDataResponse, TokenMode } from './types/sky';
import { createTransport, type DataTransport } from './services/transport';
import { TopBar, type ActiveTab } from './components/TopBar';
import { SkyTab } from './components/sky/SkyTab';
import { StatsTab } from './components/stats/StatsTab';

export interface AppProps {
  transportFactory?: () => Promise<DataTransport>;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const TOAST_DURATION_MS = 6_000;

function computeSkySignature(data: SkyDataResponse): string {
  const convSig = data.conversations
    .map(
      (c) =>
        `${c.id}|${c.total_tokens}|${c.non_cache_tokens}|${c.ended_at}|${c.last_status}|${c.subagent_calls_count}`,
    )
    .join(';');
  return `${data.conversations.length}::${convSig}`;
}

/** Root TokenStar Observatory application with dual-mode transport, silent 30s poll, and cross-tab linkage. */
export function App({
  transportFactory = () => createTransport(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: AppProps) {
  const [data, setData] = useState<SkyDataResponse | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('sky');
  const [tokenMode, setTokenMode] = useState<TokenMode>('total');
  const [privacyMode, setPrivacyMode] = useState(false);
  const [transportMode, setTransportMode] = useState<'mcp' | 'http'>('http');

  const [focusStarId, setFocusStarId] = useState<string | null>(null);
  const [focusStatsStarId, setFocusStatsStarId] = useState<string | null>(null);
  const [highlightDate, setHighlightDate] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const transportRef = useRef<DataTransport | null>(null);
  const dataRef = useRef<SkyDataResponse | null>(null);
  const signatureRef = useRef<string | null>(null);
  const pollInFlightRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const factoryRef = useRef(transportFactory);
  factoryRef.current = transportFactory;

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, TOAST_DURATION_MS);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastMessage(null);
  }, []);

  const applySkyResponse = useCallback((next: SkyDataResponse) => {
    dataRef.current = next;
    signatureRef.current = computeSkySignature(next);
    setData(next);
    setLastUpdatedAt(next.generated_at || new Date().toISOString());
    setError(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const runInitialLoad = async () => {
      try {
        const transport = await factoryRef.current();
        if (disposed) {
          transport.dispose();
          return;
        }
        transportRef.current = transport;
        setTransportMode(transport.mode);

        const initial = await transport.getSkyData();
        if (disposed) return;
        applySkyResponse(initial);
      } catch (err) {
        if (disposed) return;
        const msg = err instanceof Error ? err.message : '加载本地星图数据失败';
        setError(msg);
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    void runInitialLoad();

    if (pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        const transport = transportRef.current;
        if (disposed || !transport || pollInFlightRef.current || !dataRef.current) {
          return;
        }
        pollInFlightRef.current = true;
        void transport
          .getSkyData()
          .then((next) => {
            if (disposed) return;
            const prevData = dataRef.current;
            const prevSig = signatureRef.current;
            const nextSig = computeSkySignature(next);

            setLastUpdatedAt(next.generated_at || new Date().toISOString());

            if (prevData && prevSig !== nextSig) {
              const added = next.conversations.length - prevData.conversations.length;
              applySkyResponse(next);
              showToast(
                added > 0
                  ? `✦ 发现 ${added} 个新对话，星空已点亮`
                  : '✦ 对话星图已同步更新，星空已点亮',
              );
            }
          })
          .catch(() => {
            // Silent poll failures stay non-blocking to preserve the active view.
          })
          .finally(() => {
            pollInFlightRef.current = false;
          });
      }, pollIntervalMs);
    }

    return () => {
      disposed = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
      }
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (transportRef.current) {
        transportRef.current.dispose();
        transportRef.current = null;
      }
    };
  }, [applySkyResponse, pollIntervalMs, showToast]);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing || loading) return;
    setIsRefreshing(true);
    try {
      let transport = transportRef.current;
      if (!transport) {
        transport = await factoryRef.current();
        transportRef.current = transport;
        setTransportMode(transport.mode);
      }
      const next = await transport.refresh();
      applySkyResponse(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '刷新数据失败';
      if (dataRef.current) {
        showToast(`刷新失败：${msg}`);
      } else {
        setError(msg);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, loading, applySkyResponse, showToast]);

  const handleTogglePrivacy = useCallback(() => {
    setPrivacyMode((prev) => !prev);
  }, []);

  const handleLocateStarInSky = useCallback((starId: string) => {
    setHighlightDate(null);
    setFocusStarId(starId);
    setActiveTab('sky');
  }, []);

  const handleHighlightDateInSky = useCallback((date: string) => {
    setFocusStarId(null);
    setHighlightDate(date);
    setActiveTab('sky');
  }, []);

  const handleJumpToStats = useCallback((starId: string) => {
    setFocusStatsStarId(starId);
    setActiveTab('stats');
  }, []);

  const handleClearFocus = useCallback(() => {
    setFocusStarId(null);
  }, []);

  const handleClearHighlightDate = useCallback(() => {
    setHighlightDate(null);
  }, []);

  const handleClearFocusStatsStar = useCallback(() => {
    setFocusStatsStarId(null);
  }, []);

  const handleSaveExportPng = useCallback(async (pngBase64: string, filename: string) => {
    const transport = transportRef.current;
    if (!transport?.saveExportPng) return null;
    return transport.saveExportPng(pngBase64, filename);
  }, []);

  const stars = data?.conversations ?? [];
  const sources = data?.sources ?? [];
  const scanDurationMs = data?.scan_duration_ms ?? 0;

  return (
    <div className="ts-app">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tokenMode={tokenMode}
        onTokenModeChange={setTokenMode}
        privacyMode={privacyMode}
        onTogglePrivacy={handleTogglePrivacy}
        lastUpdatedAt={lastUpdatedAt}
        sources={sources}
        isLoading={loading}
        isRefreshing={isRefreshing}
        onRefresh={() => void handleRefresh()}
      />

      {toastMessage && (
        <div className="ts-toast" role="status" aria-live="polite">
          <span>{toastMessage}</span>
          <button
            type="button"
            className="ts-icon-close"
            aria-label="关闭提示"
            onClick={dismissToast}
          >
            ×
          </button>
        </div>
      )}

      <main
        className={`ts-main ${activeTab === 'sky' ? 'ts-main--sky' : 'ts-main--stats'}`}
      >
        {loading && !data ? (
          <div className="ts-status-overlay">
            <div className="ts-panel ts-status-card">
              <div className="ts-status-emblem" aria-hidden="true">✦</div>
              <h2>正在观测本地对话星图…</h2>
              <p>正在以只读方式扫描并汇聚您的 Gemini 对话记录。</p>
            </div>
          </div>
        ) : error && !data ? (
          <div className="ts-status-overlay">
            <div className="ts-panel ts-status-card is-error">
              <h2>星图加载受阻</h2>
              <p>{error}</p>
              <button
                type="button"
                className="ts-accent-btn"
                onClick={() => void handleRefresh()}
              >
                重试加载
              </button>
            </div>
          </div>
        ) : activeTab === 'sky' ? (
          <SkyTab
            stars={stars}
            tokenMode={tokenMode}
            privacyMode={privacyMode}
            highlightDate={highlightDate}
            focusStarId={focusStarId}
            onClearFocus={handleClearFocus}
            onClearHighlightDate={handleClearHighlightDate}
            onJumpToStats={handleJumpToStats}
            onSaveExportPng={transportMode === 'mcp' ? handleSaveExportPng : undefined}
            onNotify={showToast}
          />
        ) : (
          <StatsTab
            stars={stars}
            sources={sources}
            scanDurationMs={scanDurationMs}
            tokenMode={tokenMode}
            privacyMode={privacyMode}
            focusStatsStarId={focusStatsStarId}
            onClearFocusStatsStar={handleClearFocusStatsStar}
            onLocateStarInSky={handleLocateStarInSky}
            onHighlightDateInSky={handleHighlightDateInSky}
          />
        )}
      </main>
    </div>
  );
}
