import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CelestialType, ConversationStar, StarFilterState, TokenMode } from '../../types/sky';
import { filterStarNodes, getDisplayTitle } from '../../logic/filters';
import { effectiveTokens } from '../../logic/metrics';
import { computeStarPositions, getModelSpectralColor, type StarNode } from '../../logic/starLayout';
import {
  computeFitCamera,
  exportSkyPng,
  StarCanvas,
  type CameraState,
} from './StarCanvas';
import {
  CELESTIAL_META,
  CELESTIAL_ORDER,
  CelestialEmblem,
  DetailDrawer,
  formatDateTimeRange,
  formatTokenCount,
} from './DetailDrawer';
import { PlaybackBar, type PlaybackSpeed } from './PlaybackBar';
import type { ExportSaveResult } from '../../services/transport';

export interface SkyTabProps {
  stars: ConversationStar[];
  tokenMode: TokenMode;
  privacyMode: boolean;
  highlightDate?: string | null;
  focusStarId?: string | null;
  onClearFocus?: () => void;
  onClearHighlightDate?: () => void;
  onJumpToStats: (starId: string) => void;
  onSaveExportPng?: (pngBase64: string, filename: string) => Promise<ExportSaveResult | null>;
  onNotify?: (message: string) => void;
}

const ROOT_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: '420px',
  overflow: 'hidden',
  background: '#02040a',
  color: '#e6efff',
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
};

const GLASS_PANEL_STYLE: CSSProperties = {
  background: 'rgba(6, 10, 20, 0.82)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid var(--color-border-primary, rgba(170, 198, 255, 0.14))',
  borderRadius: '12px',
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.5)',
};

const HUD_BTN_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 9px',
  borderRadius: '8px',
  border: '1px solid rgba(164, 194, 248, 0.16)',
  background: 'rgba(16, 26, 48, 0.52)',
  color: '#dce8ff',
  fontSize: '12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const DEFAULT_FALLBACK_VIEWPORT = { width: 1200, height: 720 };

/** Compute a calm 1x timeline playback rate (stars/sec) scaled gently with star count. */
export function computePlaybackBaseRate(totalNodes: number): number {
  if (totalNodes <= 0) return 0;
  return Math.max(1.3, totalNodes / 34);
}

/** Immersive Canvas 2D Starry Sky Tab with request-level constellations, filter HUD, legend, playback, and 2x PNG export. */
export function SkyTab({
  stars,
  tokenMode,
  privacyMode,
  highlightDate = null,
  focusStarId = null,
  onClearFocus,
  onClearHighlightDate,
  onJumpToStats,
  onSaveExportPng,
  onNotify,
}: SkyTabProps) {
  const nodes = useMemo(() => computeStarPositions(stars, tokenMode), [stars, tokenMode]);

  const [filterOpen, setFilterOpen] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreview, setExportPreview] = useState<{
    dataUrl: string;
    filename: string;
    error?: string;
  } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showConstellations, setShowConstellations] = useState(true);
  const [showNebulae, setShowNebulae] = useState(true);

  const [query, setQuery] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<CelestialType[]>([]);

  // Stores selected StarNode.id (request star id)
  const [selectedStarId, setSelectedStarId] = useState<string | null>(null);
  const [hoveredState, setHoveredState] = useState<{
    node: StarNode;
    pos: { x: number; y: number };
  } | null>(null);

  // Playback state
  const [playbackActive, setPlaybackActive] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [playbackCount, setPlaybackCount] = useState(0);
  const playbackProgressRef = useRef(0);

  // Camera & viewport refs/requests
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>(
    DEFAULT_FALLBACK_VIEWPORT,
  );
  const viewportRef = useRef<{ width: number; height: number }>(DEFAULT_FALLBACK_VIEWPORT);
  const cameraRef = useRef<CameraState>({ x: 560, y: 0, zoom: 1 });
  const cameraReqSeqRef = useRef(1);
  const [cameraRequest, setCameraRequest] = useState<{ id: number; camera: CameraState } | null>(
    null,
  );
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  const requestCamera = useCallback((camera: CameraState) => {
    cameraReqSeqRef.current += 1;
    setCameraRequest({ id: cameraReqSeqRef.current, camera });
  }, []);

  // Available models sorted by request occurrence count then alphabetically
  const availableModels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const m = node.request.model || node.star.primary_model;
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([model]) => model);
  }, [nodes]);

  const filterState: StarFilterState = useMemo(
    () => ({
      query,
      models: selectedModels,
      celestialTypes: selectedTypes,
      date: null,
    }),
    [query, selectedModels, selectedTypes],
  );

  const hasActiveFilter = Boolean(
    query.trim() || selectedModels.length > 0 || selectedTypes.length > 0,
  );

  const matchedNodes = useMemo(
    () => (hasActiveFilter ? filterStarNodes(nodes, filterState, privacyMode) : nodes),
    [nodes, filterState, hasActiveFilter, privacyMode],
  );

  const matchingIds = useMemo(() => {
    if (!hasActiveFilter) return null;
    return new Set(matchedNodes.map((n) => n.id));
  }, [hasActiveFilter, matchedNodes]);

  const matchedConvCount = useMemo(
    () => new Set(matchedNodes.map((n) => n.star.id)).size,
    [matchedNodes],
  );

  // Resolve selected node from latest `nodes` so tokenMode / polling updates live
  const selectedNode = useMemo(
    () => (selectedStarId ? nodes.find((n) => n.id === selectedStarId) ?? null : null),
    [nodes, selectedStarId],
  );

  // Focus on externally requested request star or conversation (`focusStarId` from StatsTab)
  useEffect(() => {
    if (!focusStarId) return;
    const exactNode = nodes.find((n) => n.id === focusStarId);
    if (exactNode) {
      setPlaybackActive(false);
      setIsPlaying(false);
      setSelectedStarId(exactNode.id);
      requestCamera({
        x: exactNode.x,
        y: exactNode.y,
        zoom: Math.max(cameraRef.current.zoom, 1.85),
      });
      onClearFocus?.();
      return;
    }

    const convNodes = nodes.filter((n) => n.star.id === focusStarId);
    if (convNodes.length > 0) {
      const brightest = convNodes.reduce((best, curr) =>
        curr.effectiveTokens > best.effectiveTokens ? curr : best,
      );
      setPlaybackActive(false);
      setIsPlaying(false);
      setSelectedStarId(brightest.id);

      if (convNodes.length === 1) {
        requestCamera({
          x: brightest.x,
          y: brightest.y,
          zoom: Math.max(cameraRef.current.zoom, 1.85),
        });
      } else {
        const { width, height } = viewportRef.current;
        const w = width > 0 ? width : DEFAULT_FALLBACK_VIEWPORT.width;
        const h = height > 0 ? height : DEFAULT_FALLBACK_VIEWPORT.height;
        requestCamera(computeFitCamera(convNodes, w, h));
      }
    }
    onClearFocus?.();
  }, [focusStarId, nodes, onClearFocus, requestCamera]);

  // Smoothly frame highlighted date stars when `highlightDate` changes
  const prevHighlightDateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightDate || highlightDate === prevHighlightDateRef.current) {
      prevHighlightDateRef.current = highlightDate;
      return;
    }
    prevHighlightDateRef.current = highlightDate;
    if (focusStarId) return;
    const dateNodes = nodes.filter(
      (n) => (n.request.local_date || n.star.local_date) === highlightDate,
    );
    if (dateNodes.length > 0) {
      const { width, height } = viewportRef.current;
      const w = width > 0 ? width : DEFAULT_FALLBACK_VIEWPORT.width;
      const h = height > 0 ? height : DEFAULT_FALLBACK_VIEWPORT.height;
      if (dateNodes.length === 1) {
        requestCamera({ x: dateNodes[0].x, y: dateNodes[0].y, zoom: 1.55 });
      } else {
        requestCamera(computeFitCamera(dateNodes, w, h));
      }
    }
  }, [highlightDate, focusStarId, nodes, requestCamera]);

  // Playback animation loop
  useEffect(() => {
    if (!isPlaying || nodes.length === 0) return;
    let rafId = 0;
    let lastTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const baseRate = computePlaybackBaseRate(nodes.length);

    const step = (now: number) => {
      const dt = Math.min(0.08, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      const nextProgress = Math.min(
        nodes.length,
        playbackProgressRef.current + dt * baseRate * playbackSpeed,
      );
      playbackProgressRef.current = nextProgress;
      const nextCount = Math.min(nodes.length, Math.max(1, Math.floor(nextProgress)));
      setPlaybackCount(nextCount);

      if (nextProgress >= nodes.length) {
        setIsPlaying(false);
        return;
      }
      if (typeof requestAnimationFrame !== 'undefined') {
        rafId = requestAnimationFrame(step);
      }
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      rafId = requestAnimationFrame(step);
    }
    return () => {
      if (typeof cancelAnimationFrame !== 'undefined' && rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isPlaying, playbackSpeed, nodes.length]);

  // Close popovers / drawer on Escape and outside clicks for export menu
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (exportPreview) setExportPreview(null);
        else if (exportOpen) setExportOpen(false);
        else if (legendOpen) setLegendOpen(false);
        else if (selectedStarId) setSelectedStarId(null);
      }
    };
    const onDocClick = (e: MouseEvent) => {
      if (exportOpen && exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [exportPreview, exportOpen, legendOpen, selectedStarId]);

  const handleViewportSizeChange = useCallback((size: { width: number; height: number }) => {
    viewportRef.current = size;
    setViewportSize((prev) =>
      prev.width === size.width && prev.height === size.height ? prev : size,
    );
  }, []);

  const handleCameraChange = useCallback((cam: CameraState) => {
    cameraRef.current = cam;
  }, []);

  const handleHoverStar = useCallback(
    (node: StarNode | null, screenPos: { x: number; y: number } | null) => {
      if (node && screenPos) {
        setHoveredState({ node, pos: screenPos });
      } else {
        setHoveredState(null);
      }
    },
    [],
  );

  const handleSelectStar = useCallback((node: StarNode | null) => {
    setSelectedStarId(node ? node.id : null);
  }, []);

  const handleResetView = useCallback(() => {
    const { width, height } = viewportRef.current;
    const w = width > 0 ? width : DEFAULT_FALLBACK_VIEWPORT.width;
    const h = height > 0 ? height : DEFAULT_FALLBACK_VIEWPORT.height;
    requestCamera(computeFitCamera(nodes, w, h));
  }, [nodes, requestCamera]);

  const handleFocusMatched = () => {
    if (matchedNodes.length === 0) return;
    if (matchedNodes.length === 1) {
      const target = matchedNodes[0];
      setSelectedStarId(target.id);
      requestCamera({ x: target.x, y: target.y, zoom: 1.85 });
      return;
    }
    const { width, height } = viewportRef.current;
    const w = width > 0 ? width : DEFAULT_FALLBACK_VIEWPORT.width;
    const h = height > 0 ? height : DEFAULT_FALLBACK_VIEWPORT.height;
    requestCamera(computeFitCamera(matchedNodes, w, h));
  };

  const toggleModel = (model: string) => {
    setSelectedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model],
    );
  };

  const toggleCelestialType = (type: CelestialType) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const clearFilters = () => {
    setQuery('');
    setSelectedModels([]);
    setSelectedTypes([]);
  };

  const handleTogglePlay = () => {
    if (nodes.length === 0) return;
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    setPlaybackActive(true);
    if (!playbackActive || playbackCount >= nodes.length || playbackCount <= 0) {
      playbackProgressRef.current = 1;
      setPlaybackCount(1);
    } else {
      playbackProgressRef.current = playbackCount;
    }
    setIsPlaying(true);
  };

  const handleCycleSpeed = () => {
    setPlaybackSpeed((prev) => (prev === 1 ? 2 : prev === 2 ? 5 : 1));
  };

  const handleScrub = (count: number) => {
    const clamped = Math.min(nodes.length, Math.max(0, count));
    setPlaybackActive(true);
    playbackProgressRef.current = clamped;
    setPlaybackCount(clamped);
  };

  const handleExitPlayback = () => {
    setIsPlaying(false);
    setPlaybackActive(false);
    playbackProgressRef.current = nodes.length;
    setPlaybackCount(nodes.length);
  };

  const handleExportPng = async (mode: 'wallpaper' | 'card') => {
    const { width, height } = viewportRef.current;
    const w = width > 0 ? width : DEFAULT_FALLBACK_VIEWPORT.width;
    const h = height > 0 ? height : DEFAULT_FALLBACK_VIEWPORT.height;
    const totalTokens = stars.reduce((acc, s) => acc + effectiveTokens(s, tokenMode), 0);
    const firstDate = nodes[0]?.request.local_date ?? nodes[0]?.star.local_date ?? '';
    const lastDate =
      nodes[nodes.length - 1]?.request.local_date ?? nodes[nodes.length - 1]?.star.local_date ?? '';
    const dateRange =
      firstDate && lastDate
        ? firstDate === lastDate
          ? firstDate
          : `${firstDate} ~ ${lastDate}`
        : '—';

    const exportOptions = {
      mode,
      width: w,
      height: h,
      camera: cameraRef.current,
      tokenMode,
      privacyMode,
      totalTokens,
      dateRange,
      conversationCount: stars.length,
      showGrid: mode === 'wallpaper' ? false : showGrid,
      showConstellations,
      showNebulae,
    };

    setExportOpen(false);

    if (!onSaveExportPng) {
      const result = exportSkyPng(nodes, exportOptions);
      if (result) {
        onNotify?.(`✦ 已开始下载 ${result.filename}`);
      }
      return;
    }

    if (isExporting) return;
    const rendered = exportSkyPng(nodes, { ...exportOptions, skipDownload: true });
    if (!rendered || !rendered.dataUrl) {
      onNotify?.('导出失败：无法生成星图 PNG 图像');
      return;
    }

    setIsExporting(true);
    try {
      const saved = await onSaveExportPng(rendered.dataUrl, rendered.filename);
      if (saved && saved.path) {
        onNotify?.(`✦ 星图已保存至 ${saved.path}`);
        return;
      }
      setExportPreview({
        dataUrl: rendered.dataUrl,
        filename: rendered.filename,
      });
      onNotify?.('未能直接写入本地磁盘，已在预览窗口打开（可右键另存为）');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败';
      setExportPreview({
        dataUrl: rendered.dataUrl,
        filename: rendered.filename,
        error: msg,
      });
      onNotify?.(`导出保存受阻：${msg}`);
    } finally {
      setIsExporting(false);
    }
  };

  const playbackCurrentDate = useMemo(() => {
    if (nodes.length === 0) return null;
    if (!playbackActive) {
      const last = nodes[nodes.length - 1];
      return last?.request.local_date ?? last?.star.local_date ?? null;
    }
    if (playbackCount <= 0) {
      return nodes[0]?.request.local_date ?? nodes[0]?.star.local_date ?? null;
    }
    const curr = nodes[Math.min(playbackCount - 1, nodes.length - 1)];
    return curr?.request.local_date ?? curr?.star.local_date ?? null;
  }, [nodes, playbackActive, playbackCount]);

  // Tooltip coordinates clamped inside container bounds
  const isNarrowViewport = viewportSize.width > 0 && viewportSize.width < 760;

  const tooltipCoords = useMemo(() => {
    if (!hoveredState) return null;
    const vw = viewportSize.width || DEFAULT_FALLBACK_VIEWPORT.width;
    const vh = viewportSize.height || DEFAULT_FALLBACK_VIEWPORT.height;
    const cardW = 262;
    const cardH = 142;
    const rightReserve = selectedNode && !isNarrowViewport ? 388 : 16;
    const left =
      hoveredState.pos.x + 16 + cardW > vw - rightReserve
        ? Math.max(12, hoveredState.pos.x - cardW - 14)
        : hoveredState.pos.x + 16;
    const top =
      hoveredState.pos.y + 14 + cardH > vh - 70
        ? Math.max(12, hoveredState.pos.y - cardH - 12)
        : hoveredState.pos.y + 14;
    return { left, top };
  }, [hoveredState, selectedNode, viewportSize, isNarrowViewport]);

  return (
    <section className="ts-sky-tab" aria-label="星空画布视图" style={ROOT_STYLE}>
      <StarCanvas
        nodes={nodes}
        matchingIds={matchingIds}
        hasActiveFilter={hasActiveFilter}
        selectedStarId={selectedStarId}
        hoveredStarId={hoveredState?.node.id ?? null}
        highlightDate={highlightDate}
        playbackVisibleCount={playbackActive ? playbackCount : null}
        cameraRequest={cameraRequest}
        privacyMode={privacyMode}
        showGrid={showGrid}
        showConstellations={showConstellations}
        showNebulae={showNebulae}
        onCameraChange={handleCameraChange}
        onViewportSizeChange={handleViewportSizeChange}
        onHoverStar={handleHoverStar}
        onSelectStar={handleSelectStar}
        onResetView={handleResetView}
      />

      {/* Empty State */}
      {stars.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            pointerEvents: 'none',
            zIndex: 15,
          }}
        >
          <div
            style={{
              ...GLASS_PANEL_STYLE,
              maxWidth: '400px',
              padding: '22px 24px',
              textAlign: 'center',
              pointerEvents: 'auto',
            }}
          >
            <div style={{ fontSize: '20px', marginBottom: '8px', color: '#a8ceff' }}>✦</div>
            <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 600, color: '#f2f6ff' }}>
              这片夜空暂时还是安静的
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: '12.5px',
                lineHeight: 1.6,
                color: 'rgba(196, 214, 246, 0.78)',
              }}
            >
              尚未发现本地 Antigravity 对话星体日志（默认只读扫描 ~/.gemini/antigravity/brain）。
              发起新的对话后，这里将自动点亮属于你的第一颗星。
            </p>
          </div>
        </div>
      )}

      {/* Top Collapsible Filter & Action HUD */}
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '12px',
          right: '12px',
          maxWidth: selectedNode && !isNarrowViewport ? 'calc(100% - 400px)' : 'calc(100% - 24px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          pointerEvents: 'none',
          zIndex: 20,
        }}
      >
        <div
          style={{
            ...GLASS_PANEL_STYLE,
            padding: '7px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            pointerEvents: 'auto',
            width: 'fit-content',
            maxWidth: '100%',
          }}
        >
          {/* Compact Top Action Row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
              style={HUD_BTN_STYLE}
            >
              <span>{filterOpen ? '▾ 收起筛选' : '▸ 筛选与检索'}</span>
            </button>

            <span
              style={{
                fontSize: '11.5px',
                color: 'rgba(192, 212, 245, 0.84)',
                padding: '0 4px',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {hasActiveFilter
                ? `匹配 ${matchedNodes.length} / ${nodes.length}（${matchedConvCount} 星座）`
                : `共 ${nodes.length} 颗星体 · ${stars.length} 个对话星座`}
            </span>

            {hasActiveFilter && (
              <>
                <button
                  type="button"
                  onClick={handleFocusMatched}
                  disabled={matchedNodes.length === 0}
                  style={{
                    ...HUD_BTN_STYLE,
                    background: 'rgba(84, 134, 224, 0.25)',
                    borderColor: 'rgba(166, 206, 255, 0.35)',
                    opacity: matchedNodes.length === 0 ? 0.45 : 1,
                    cursor: matchedNodes.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  聚焦
                </button>
                <button type="button" onClick={clearFilters} style={HUD_BTN_STYLE}>
                  清除筛选
                </button>
              </>
            )}

            <button type="button" onClick={handleResetView} style={HUD_BTN_STYLE}>
              重置全景
            </button>

            <button
              type="button"
              aria-pressed={showGrid}
              onClick={() => setShowGrid((v) => !v)}
              style={{
                ...HUD_BTN_STYLE,
                background: showGrid ? 'rgba(84, 134, 224, 0.24)' : 'rgba(16, 26, 48, 0.52)',
                borderColor: showGrid ? 'rgba(166, 206, 255, 0.42)' : 'rgba(164, 194, 248, 0.16)',
                color: showGrid ? '#ffffff' : 'rgba(206, 222, 250, 0.78)',
              }}
            >
              网格
            </button>

            <button
              type="button"
              aria-pressed={showConstellations}
              onClick={() => setShowConstellations((v) => !v)}
              style={{
                ...HUD_BTN_STYLE,
                background: showConstellations ? 'rgba(84, 134, 224, 0.24)' : 'rgba(16, 26, 48, 0.52)',
                borderColor: showConstellations
                  ? 'rgba(166, 206, 255, 0.42)'
                  : 'rgba(164, 194, 248, 0.16)',
                color: showConstellations ? '#ffffff' : 'rgba(206, 222, 250, 0.78)',
              }}
            >
              连线
            </button>

            <button
              type="button"
              aria-pressed={showNebulae}
              onClick={() => setShowNebulae((v) => !v)}
              style={{
                ...HUD_BTN_STYLE,
                background: showNebulae ? 'rgba(84, 134, 224, 0.24)' : 'rgba(16, 26, 48, 0.52)',
                borderColor: showNebulae
                  ? 'rgba(166, 206, 255, 0.42)'
                  : 'rgba(164, 194, 248, 0.16)',
                color: showNebulae ? '#ffffff' : 'rgba(206, 222, 250, 0.78)',
              }}
            >
              星云
            </button>

            {/* PNG Export Dropdown */}
            <div ref={exportMenuRef} style={{ position: 'relative' }}>
              <button
                type="button"
                disabled={isExporting}
                onClick={() => setExportOpen((v) => !v)}
                aria-expanded={exportOpen}
                style={{
                  ...HUD_BTN_STYLE,
                  opacity: isExporting ? 0.65 : 1,
                  cursor: isExporting ? 'wait' : 'pointer',
                }}
              >
                {isExporting ? '导出中...' : '导出星图 ▾'}
              </button>
              {exportOpen && (
                <div
                  role="menu"
                  aria-label="PNG 导出模式"
                  style={{
                    ...GLASS_PANEL_STYLE,
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    left: 0,
                    minWidth: '176px',
                    padding: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    zIndex: 40,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isExporting}
                    onClick={() => void handleExportPng('wallpaper')}
                    style={{
                      ...HUD_BTN_STYLE,
                      width: '100%',
                      justifyContent: 'flex-start',
                      border: 'none',
                      background: 'transparent',
                      padding: '6px 8px',
                    }}
                  >
                    纯净壁纸（2x）
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isExporting}
                    onClick={() => void handleExportPng('card')}
                    style={{
                      ...HUD_BTN_STYLE,
                      width: '100%',
                      justifyContent: 'flex-start',
                      border: 'none',
                      background: 'transparent',
                      padding: '6px 8px',
                    }}
                  >
                    星图纪念卡（2x）
                  </button>
                </div>
              )}
            </div>

            {highlightDate && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 8px',
                  borderRadius: '999px',
                  background: 'rgba(130, 178, 255, 0.2)',
                  border: '1px solid rgba(176, 212, 255, 0.36)',
                  color: '#e8f2ff',
                  fontSize: '11.5px',
                }}
              >
                <span>✦ 高亮 {highlightDate}</span>
                <button
                  type="button"
                  onClick={() => onClearHighlightDate?.()}
                  aria-label="清除日期高亮"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#d8e8ff',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: '13px',
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            )}
          </div>

          {/* Expanded Filter Controls */}
          {filterOpen && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '7px',
                paddingTop: '6px',
                borderTop: '1px solid rgba(164, 194, 248, 0.12)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={privacyMode ? '搜索模型或日期（隐私模式）...' : '搜索对话标题、模型或日期...'}
                  aria-label="搜索星体"
                  style={{
                    minWidth: '180px',
                    flex: '1 1 200px',
                    maxWidth: '280px',
                    padding: '5px 10px',
                    borderRadius: '8px',
                    border: '1px solid rgba(164, 194, 248, 0.2)',
                    background: 'rgba(2, 5, 13, 0.8)',
                    color: '#eef4ff',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                />

                {/* 5 Celestial Type Toggles */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  {CELESTIAL_ORDER.map((type) => {
                    const meta = CELESTIAL_META[type];
                    const active = selectedTypes.includes(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleCelestialType(type)}
                        style={{
                          ...HUD_BTN_STYLE,
                          padding: '3px 8px',
                          fontSize: '11.5px',
                          background: active ? 'rgba(94, 146, 232, 0.26)' : 'rgba(12, 20, 38, 0.58)',
                          borderColor: active
                            ? 'rgba(170, 206, 255, 0.48)'
                            : 'rgba(164, 194, 248, 0.14)',
                          color: active ? '#ffffff' : 'rgba(206, 222, 250, 0.84)',
                        }}
                      >
                        <CelestialEmblem type={type} color={meta.accent} size={13} />
                        <span>{meta.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Model Filter Chips */}
              {availableModels.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: 'rgba(182, 204, 240, 0.68)' }}>模型:</span>
                  {availableModels.map((model) => {
                    const active = selectedModels.includes(model);
                    const color = getModelSpectralColor(model);
                    return (
                      <button
                        key={model}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleModel(model)}
                        style={{
                          ...HUD_BTN_STYLE,
                          padding: '2px 8px',
                          fontSize: '11px',
                          borderRadius: '999px',
                          background: active ? 'rgba(94, 146, 232, 0.26)' : 'rgba(12, 20, 38, 0.5)',
                          borderColor: active
                            ? 'rgba(170, 206, 255, 0.46)'
                            : 'rgba(164, 194, 248, 0.14)',
                        }}
                      >
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: color,
                            boxShadow: `0 0 6px ${color}`,
                            display: 'inline-block',
                          }}
                        />
                        <span>{model}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hover Star Tooltip */}
      {hoveredState && tooltipCoords && (
        <div
          role="tooltip"
          style={{
            ...GLASS_PANEL_STYLE,
            position: 'absolute',
            left: `${tooltipCoords.left}px`,
            top: `${tooltipCoords.top}px`,
            width: '262px',
            padding: '10px 12px',
            pointerEvents: 'none',
            zIndex: 35,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
            <CelestialEmblem
              type={hoveredState.node.request.celestial_type}
              color={hoveredState.node.color}
              size={18}
            />
            <span
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '999px',
                background: 'rgba(154, 184, 255, 0.14)',
                color: CELESTIAL_META[hoveredState.node.request.celestial_type].accent,
              }}
            >
              {CELESTIAL_META[hoveredState.node.request.celestial_type].label}
            </span>
            <span style={{ fontSize: '10.5px', color: 'rgba(186, 206, 240, 0.78)', fontVariantNumeric: 'tabular-nums' }}>
              {hoveredState.node.requestIndexInConv + 1}/{hoveredState.node.convRequestCount}
            </span>
            <span style={{ fontSize: '11px', color: 'rgba(186, 206, 240, 0.72)', marginLeft: 'auto' }}>
              {hoveredState.node.request.local_date}
            </span>
          </div>

          <div
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#f2f6ff',
              marginBottom: '3px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {getDisplayTitle(hoveredState.node.star, hoveredState.node.convIndex, privacyMode)}
          </div>

          <div style={{ fontSize: '11px', color: 'rgba(186, 206, 240, 0.74)', marginBottom: '6px' }}>
            {hoveredState.node.request.is_subagent
              ? `子代理 · ${hoveredState.node.request.subagent_role || 'Subagent'} · `
              : ''}
            {formatDateTimeRange(
              hoveredState.node.request.created_at,
              hoveredState.node.request.created_at,
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              fontSize: '11.5px',
              paddingTop: '5px',
              borderTop: '1px solid rgba(164, 194, 248, 0.12)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: hoveredState.node.color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#cfe0ff',
                }}
              >
                {hoveredState.node.request.model || hoveredState.node.star.primary_model}
              </span>
            </span>
            <span style={{ fontWeight: 700, color: '#ffffff', flexShrink: 0 }}>
              {formatTokenCount(hoveredState.node.effectiveTokens)}
            </span>
          </div>
        </div>
      )}

      {/* Right Floating Detail Drawer */}
      {selectedNode && (
        <DetailDrawer
          node={selectedNode}
          tokenMode={tokenMode}
          privacyMode={privacyMode}
          onClose={() => setSelectedStarId(null)}
          onJumpToStats={onJumpToStats}
        />
      )}

      {/* Bottom HUD Row: Collapsible Legend + Timeline PlaybackBar */}
      <div
        style={{
          position: 'absolute',
          left: '12px',
          right: '12px',
          bottom: '12px',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '10px',
          flexWrap: 'wrap',
          pointerEvents: 'none',
          zIndex: 25,
        }}
      >
        {/* Bottom-left Collapsible Legend Pill */}
        <div style={{ position: 'relative', pointerEvents: 'auto' }}>
          {legendOpen && (
            <div
              role="region"
              aria-label="天体与光谱图例"
              style={{
                ...GLASS_PANEL_STYLE,
                position: 'absolute',
                left: 0,
                bottom: 'calc(100% + 8px)',
                width: 'min(300px, calc(100vw - 32px))',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                zIndex: 35,
              }}
            >
              <div>
                <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#dce8ff', marginBottom: '6px' }}>
                  请求天体类型（每次模型请求为一颗星）
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {CELESTIAL_ORDER.map((type) => {
                    const meta = CELESTIAL_META[type];
                    return (
                      <div
                        key={type}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '11.5px',
                        }}
                      >
                        <CelestialEmblem type={type} color={meta.accent} size={18} />
                        <span style={{ fontWeight: 600, color: '#edf4ff', minWidth: '42px' }}>
                          {meta.label}
                        </span>
                        <span style={{ color: 'rgba(186, 206, 240, 0.76)' }}>{meta.description}</span>
                      </div>
                    );
                  })}
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: 'rgba(176, 198, 236, 0.72)',
                    marginTop: '7px',
                    lineHeight: 1.45,
                  }}
                >
                  WebGL 实时光学渲染星图；同一对话星群以无交叉最小生成树连线构成独立星座，彼此绝不重叠。
                </div>
              </div>

              <div style={{ borderTop: '1px solid rgba(164, 194, 248, 0.12)', paddingTop: '8px' }}>
                <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#dce8ff', marginBottom: '6px' }}>
                  模型光谱色
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {(availableModels.length > 0
                    ? availableModels
                    : ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
                  ).map((model) => {
                    const color = getModelSpectralColor(model);
                    return (
                      <span
                        key={model}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          fontSize: '11px',
                          color: '#d4e2ff',
                          background: 'rgba(14, 22, 42, 0.72)',
                          padding: '2px 7px',
                          borderRadius: '999px',
                        }}
                      >
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: color,
                            boxShadow: `0 0 6px ${color}`,
                          }}
                        />
                        {model}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setLegendOpen((v) => !v)}
            aria-expanded={legendOpen}
            style={{
              ...GLASS_PANEL_STYLE,
              padding: '6px 12px',
              borderRadius: '999px',
              color: '#dce8ff',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <span aria-hidden="true">✦</span>
            <span>图例</span>
          </button>
        </div>

        {/* Bottom Playback Bar */}
        <div style={{ pointerEvents: 'auto', marginLeft: 'auto', maxWidth: '100%' }}>
          <PlaybackBar
            isActive={playbackActive}
            isPlaying={isPlaying}
            speed={playbackSpeed}
            visibleCount={playbackCount}
            totalCount={nodes.length}
            currentDate={playbackCurrentDate}
            onTogglePlay={handleTogglePlay}
            onCycleSpeed={handleCycleSpeed}
            onScrub={handleScrub}
            onExitReset={handleExitPlayback}
          />
        </div>
      </div>

      {exportPreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="星图导出预览"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 60,
            background: 'rgba(2, 5, 14, 0.78)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setExportPreview(null)}
        >
          <div
            style={{
              ...GLASS_PANEL_STYLE,
              maxWidth: 'min(820px, 100%)',
              maxHeight: '100%',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#edf4ff' }}>
                {exportPreview.filename}
              </span>
              <button
                type="button"
                onClick={() => setExportPreview(null)}
                aria-label="关闭导出预览"
                style={HUD_BTN_STYLE}
              >
                关闭
              </button>
            </div>
            <div style={{ fontSize: '12px', color: exportPreview.error ? '#ffbfa8' : 'rgba(196, 214, 246, 0.84)' }}>
              {exportPreview.error
                ? `直接保存失败（${exportPreview.error}）。右键图片可另存为或复制：`
                : '右键图片可另存为或复制：'}
            </div>
            <img
              src={exportPreview.dataUrl}
              alt={exportPreview.filename}
              style={{
                maxWidth: '100%',
                maxHeight: 'calc(100vh - 200px)',
                borderRadius: '8px',
                border: '1px solid rgba(164, 194, 248, 0.2)',
                objectFit: 'contain',
                background: '#010205',
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
