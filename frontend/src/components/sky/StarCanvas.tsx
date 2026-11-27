import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { CelestialType, TokenMode } from '../../types/sky';
import {
  buildConstellationSegments,
  type ConstellationSegment,
} from '../../logic/constellations';
import { getDisplayTitle } from '../../logic/filters';
import { fnv1a32, mulberry32, type StarNode, type SubagentCluster } from '../../logic/starLayout';
import {
  buildClusterNebulae,
  celestialTypeToId,
  computeDeepOut,
  hexToRgbNorm,
  renderWebGLSnapshot,
  WebGLSkyRenderer,
  type RenderableNebula,
  type RenderableStar,
} from './webglSkyRenderer';

export { buildConstellationSegments, computeDeepOut, type ConstellationSegment };

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface DustStar {
  xNorm: number;
  yNorm: number;
  radius: number;
  alpha: number;
  color: string;
}

export interface SkyExportOptions {
  mode: 'wallpaper' | 'card';
  width: number;
  height: number;
  camera: CameraState;
  tokenMode: TokenMode;
  privacyMode: boolean;
  totalTokens: number;
  dateRange: string;
  conversationCount?: number;
  showGrid?: boolean;
  showConstellations?: boolean;
  showNebulae?: boolean;
  clusters?: SubagentCluster[];
  expandedClusterIds?: Set<string>;
  expandAllSubagents?: boolean;
  skipDownload?: boolean;
}

export interface SkyExportResult {
  dataUrl: string;
  filename: string;
}

export interface StarCanvasProps {
  nodes: StarNode[];
  matchingIds: Set<string> | null;
  hasActiveFilter: boolean;
  selectedStarId: string | null;
  hoveredStarId: string | null;
  highlightDate: string | null;
  playbackVisibleCount: number | null;
  cameraRequest: { id: number; camera: CameraState } | null;
  privacyMode?: boolean;
  showGrid?: boolean;
  showConstellations?: boolean;
  showNebulae?: boolean;
  clusters?: SubagentCluster[];
  expandedClusterIds?: Set<string>;
  expandAllSubagents?: boolean;
  collapseAllSignal?: number;
  matchingClusterIds?: Set<string> | null;
  hoveredClusterId?: string | null;
  selectedClusterId?: string | null;
  onCameraChange?: (camera: CameraState) => void;
  onViewportSizeChange?: (size: { width: number; height: number }) => void;
  onHoverStar: (node: StarNode | null, screenPos: { x: number; y: number } | null) => void;
  onSelectStar: (node: StarNode | null) => void;
  onHoverCluster?: (
    cluster: SubagentCluster | null,
    screenPos: { x: number; y: number } | null,
  ) => void;
  onSelectCluster?: (cluster: SubagentCluster | null) => void;
  onZoomOutCollapse?: () => void;
  onResetView: () => void;
}

export const AUTO_EXPAND_ZOOM = 1.15;
export const AUTO_COLLAPSE_ZOOM = 0.88;

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 7.5;
const DEFAULT_CAMERA_LERP_RATE = 8.0;
const INTRO_DOLLY_RATE = 1.35;
const WHEEL_ZOOM_LERP_RATE = 11.5;
const DEFAULT_DUST_COUNT = 220;
const DEEP_FIELD_EXTRA_COUNT = 1180;
const DUST_SEED = 0x544f4b45;
const DEEP_FIELD_SEED = 0x41535452;
const COMET_TAIL_ANGLE = -Math.PI * 0.82;
const GALACTIC_BAND_TILT_RAD = (-12 * Math.PI) / 180;
const DUST_COLORS = ['#74acff', '#a4cbff', '#e4eeff', '#fff5df', '#ffdc88', '#ffa658', '#ff764e'] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function computeClusterIntroGate(clusterId: string, introProgress: number): number {
  if (introProgress >= 1) return 1;
  const introSeed = (fnv1a32(clusterId) & 0xffff) / 0xffff;
  return smoothstep01((introProgress - (0.30 + introSeed * 0.40)) / 0.25);
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.trim().replace('#', '');
  const a = clamp(alpha, 0, 1);
  if (clean.length === 3) {
    const r = Number.parseInt(clean[0] + clean[0], 16);
    const g = Number.parseInt(clean[1] + clean[1], 16);
    const b = Number.parseInt(clean[2] + clean[2], 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
  } else if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
  }
  return `rgba(210, 228, 255, ${a})`;
}

/** Generate fixed-seed faint decorative dust stars for 2D fallback & tests. */
export function generateBackgroundDust(count = DEFAULT_DUST_COUNT): DustStar[] {
  const clampedCount = clamp(Math.round(count), 180, 260);
  const rand = mulberry32(DUST_SEED);
  const stars: DustStar[] = [];
  for (let i = 0; i < clampedCount; i += 1) {
    const u = rand();
    const power = Math.pow(u, 2.4);
    stars.push({
      xNorm: rand(),
      yNorm: rand(),
      radius: 0.42 + power * 0.72,
      alpha: 0.18 + power * 0.56,
      color: DUST_COLORS[Math.floor(rand() * DUST_COLORS.length)],
    });
  }
  return stars;
}

function generateDeepFieldStars(count = DEEP_FIELD_EXTRA_COUNT): DustStar[] {
  const rand = mulberry32(DEEP_FIELD_SEED);
  const stars: DustStar[] = [];
  const tanTilt = Math.tan(GALACTIC_BAND_TILT_RAD);

  for (let i = 0; i < count; i += 1) {
    const xNorm = rand();
    const nearBand = rand() < 0.66;
    let yNorm: number;
    if (nearBand) {
      const tri = (rand() + rand() - 1) * 0.34;
      const bandCenter = 0.5 + (xNorm - 0.5) * tanTilt * 0.72;
      yNorm = clamp(bandCenter + tri, 0.005, 0.995);
    } else {
      yNorm = rand();
    }

    const p = Math.pow(rand(), 3.3);
    stars.push({
      xNorm,
      yNorm,
      radius: 0.28 + p * 0.85,
      alpha: 0.1 + p * 0.62,
      color: DUST_COLORS[Math.floor(rand() * DUST_COLORS.length)],
    });
  }
  return stars;
}

const DEEP_FIELD_STARS = generateDeepFieldStars(DEEP_FIELD_EXTRA_COUNT);

export function worldToScreen(
  wx: number,
  wy: number,
  camera: CameraState,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: (wx - camera.x) * camera.zoom + width / 2,
    y: (wy - camera.y) * camera.zoom + height / 2,
  };
}

export function screenToWorld(
  sx: number,
  sy: number,
  camera: CameraState,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: (sx - width / 2) / camera.zoom + camera.x,
    y: (sy - height / 2) / camera.zoom + camera.y,
  };
}

/** Compute a balanced camera state that frames all supplied star nodes comfortably. */
export function computeFitCamera(
  nodes: StarNode[],
  width: number,
  height: number,
): CameraState {
  const safeW = Math.max(width, 280);
  const safeH = Math.max(height, 240);
  if (nodes.length === 0) {
    return { x: 0, y: 0, zoom: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanX = Math.max(maxX - minX + 180, 320);
  const spanY = Math.max(maxY - minY + 180, 260);
  const zoom = clamp(Math.min((safeW * 0.86) / spanX, (safeH * 0.76) / spanY), MIN_ZOOM, 2.2);
  return { x: cx, y: cy, zoom };
}

export function getVisualScale(zoom: number): number {
  return clamp(Math.pow(Math.max(0.08, zoom), 0.53), 0.38, 2.25);
}

/** Hit-test the closest visible star within an ergonomic screen-space radius. */
export function hitTestStar(
  nodes: StarNode[],
  screenX: number,
  screenY: number,
  camera: CameraState,
  width: number,
  height: number,
  maxVisibleCount?: number,
  matchingIds?: Set<string> | null,
): StarNode | null {
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, nodes.length)
      : nodes.length;
  const visualScale = getVisualScale(camera.zoom);

  let bestMatched: StarNode | null = null;
  let bestMatchedDist = Number.POSITIVE_INFINITY;
  let bestAny: StarNode | null = null;
  let bestAnyDist = Number.POSITIVE_INFINITY;

  for (let i = 0; i < limit; i += 1) {
    const node = nodes[i];
    const pos = worldToScreen(node.x, node.y, camera, width, height);
    const dx = screenX - pos.x;
    const dy = screenY - pos.y;
    const dist = Math.hypot(dx, dy);
    const hitRadius = Math.max(12, node.radius * visualScale * 2.1 + 7);
    if (dist > hitRadius) continue;

    if (matchingIds && matchingIds.has(node.id)) {
      if (dist < bestMatchedDist) {
        bestMatchedDist = dist;
        bestMatched = node;
      }
    } else if (dist < bestAnyDist) {
      bestAnyDist = dist;
      bestAny = node;
    }
  }

  return bestMatched ?? bestAny;
}

/** Build the effective set of expanded subagent cluster IDs from global/manual/auto-LOD sets. */
export function getEffectiveExpandedSet(
  clusters: SubagentCluster[],
  expandAllSubagents = false,
  expandedClusterIds?: Set<string>,
  autoExpandedIds?: Set<string>,
): Set<string> {
  if (expandAllSubagents) {
    return new Set(clusters.map((c) => c.id));
  }
  const effective = new Set<string>();
  if (expandedClusterIds) {
    for (const id of expandedClusterIds) {
      effective.add(id);
    }
  }
  if (autoExpandedIds) {
    for (const id of autoExpandedIds) {
      effective.add(id);
    }
  }
  return effective;
}

/** Hit-test the closest collapsed subagent cluster within an ergonomic screen-space radius. */
export function hitTestCluster(
  clusters: SubagentCluster[],
  expandedClusterIds: Set<string>,
  screenX: number,
  screenY: number,
  camera: CameraState,
  width: number,
  height: number,
  maxVisibleCount?: number,
  matchingClusterIds?: Set<string> | null,
): SubagentCluster | null {
  const limit =
    typeof maxVisibleCount === 'number'
      ? Math.max(0, Math.floor(maxVisibleCount))
      : Number.POSITIVE_INFINITY;
  const visualScale = getVisualScale(camera.zoom);

  let bestMatched: SubagentCluster | null = null;
  let bestMatchedDist = Number.POSITIVE_INFINITY;
  let bestAny: SubagentCluster | null = null;
  let bestAnyDist = Number.POSITIVE_INFINITY;

  for (const c of clusters) {
    if (expandedClusterIds.has(c.id)) continue;
    if (c.firstNodeIndex >= limit) continue;

    const pos = worldToScreen(c.anchorX, c.anchorY, camera, width, height);
    const dist = Math.hypot(screenX - pos.x, screenY - pos.y);
    const hitRadius = Math.max(14, c.clusterRadius * visualScale * 1.85 + 7);
    if (dist > hitRadius) continue;

    if (matchingClusterIds && matchingClusterIds.has(c.id)) {
      if (dist < bestMatchedDist) {
        bestMatchedDist = dist;
        bestMatched = c;
      }
    } else if (dist < bestAnyDist) {
      bestAnyDist = dist;
      bestAny = c;
    }
  }

  return bestMatched ?? bestAny;
}

function getHitTestableNodes(
  nodes: StarNode[],
  clusterById: Map<string, SubagentCluster>,
  effectiveExpanded: Set<string>,
  maxVisibleCount?: number | null,
): StarNode[] {
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, nodes.length)
      : nodes.length;
  const visible = limit === nodes.length ? nodes : nodes.slice(0, limit);
  if (clusterById.size === 0) {
    return visible;
  }
  return visible.filter((node) => {
    if (!node.subagentClusterId || !clusterById.has(node.subagentClusterId)) {
      return true;
    }
    return effectiveExpanded.has(node.subagentClusterId);
  });
}

/** Draw subtle Stellarium-style equatorial RA/Dec astrometric coordinate graticule. */
function drawEquatorialGraticule(
  ctx: CanvasRenderingContext2D,
  camera: CameraState,
  width: number,
  height: number,
  drawLabels: boolean,
): void {
  const targetScreenStep = 145;
  const rawWorldStep = targetScreenStep / Math.max(0.05, camera.zoom);
  const pow2 = Math.pow(2, Math.round(Math.log2(Math.max(40, rawWorldStep / 80))));
  const worldStep = clamp(80 * pow2, 80, 2560);

  const topLeft = screenToWorld(0, 0, camera, width, height);
  const bottomRight = screenToWorld(width, height, camera, width, height);

  const startX = Math.floor(topLeft.x / worldStep) * worldStep;
  const endX = Math.ceil(bottomRight.x / worldStep) * worldStep;
  const startY = Math.floor(topLeft.y / worldStep) * worldStep;
  const endY = Math.ceil(bottomRight.y / worldStep) * worldStep;

  ctx.save();
  ctx.strokeStyle = 'rgba(116, 156, 220, 0.085)';
  ctx.lineWidth = 0.7;
  ctx.setLineDash([]);

  ctx.beginPath();
  for (let wx = startX; wx <= endX; wx += worldStep) {
    const sx = (wx - camera.x) * camera.zoom + width * 0.5;
    if (sx < -2 || sx > width + 2) continue;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
  }
  for (let wy = startY; wy <= endY; wy += worldStep) {
    const sy = (wy - camera.y) * camera.zoom + height * 0.5;
    if (sy < -2 || sy > height + 2) continue;
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
  }
  ctx.stroke();

  if (drawLabels) {
    ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(136, 174, 232, 0.34)';

    // Right Ascension edge labels along bottom
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let wx = startX; wx <= endX; wx += worldStep) {
      const sx = (wx - camera.x) * camera.zoom + width * 0.5;
      if (sx < 56 || sx > width - 56) continue;
      const totalMins = (((Math.round(wx / 20) + 720) % 1440) + 1440) % 1440;
      const raH = String(Math.floor(totalMins / 60)).padStart(2, '0');
      const raM = String(totalMins % 60).padStart(2, '0');
      ctx.fillText(`${raH}h ${raM}m`, sx, height - 6);
    }

    // Declination edge labels along left
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let wy = startY; wy <= endY; wy += worldStep) {
      const sy = (wy - camera.y) * camera.zoom + height * 0.5;
      if (sy < 72 || sy > height - 48) continue;
      const deg = clamp(Math.round(-wy / 18), -89, 89);
      const sign = deg >= 0 ? '+' : '';
      ctx.fillText(`${sign}${deg}°`, 8, sy);
    }
  }

  ctx.restore();
}

/** 2D fallback deep-space backdrop for JSDOM tests or no-WebGL environments. */
function drawBackdrop2D(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dust: DustStar[],
): void {
  const base = ctx.createLinearGradient(0, height * 0.15, width, height * 0.85);
  base.addColorStop(0, '#010205');
  base.addColorStop(0.5, '#03060f');
  base.addColorStop(1, '#010205');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width * 0.5, height * 0.5);
  ctx.rotate(GALACTIC_BAND_TILT_RAD);
  const bandH = Math.max(160, height * 0.36);
  const band = ctx.createLinearGradient(0, -bandH, 0, bandH);
  band.addColorStop(0, 'rgba(3, 6, 14, 0)');
  band.addColorStop(0.5, 'rgba(32, 42, 68, 0.22)');
  band.addColorStop(1, 'rgba(3, 6, 14, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(-width, -bandH, width * 2, bandH * 2);
  ctx.restore();

  const renderPinpoint = (d: DustStar) => {
    const px = d.xNorm * width;
    const py = d.yNorm * height;
    ctx.fillStyle = hexToRgba(d.color, d.alpha);
    ctx.beginPath();
    ctx.arc(px, py, d.radius, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const d of DEEP_FIELD_STARS) renderPinpoint(d);
  for (const d of dust) renderPinpoint(d);
}

/** 2D fallback cluster nebulae when WebGL is disabled or unavailable. */
function drawNebulae2D(
  ctx: CanvasRenderingContext2D,
  nebulae: RenderableNebula[],
  camera: CameraState,
  width: number,
  height: number,
): void {
  if (nebulae.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const neb of nebulae) {
    const pos = worldToScreen(neb.wx, neb.wy, camera, width, height);
    const r = neb.radius * camera.zoom;
    if (pos.x + r < 0 || pos.x - r > width || pos.y + r < 0 || pos.y - r > height) continue;
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
    const rr = Math.round(neb.r * 255);
    const gg = Math.round(neb.g * 255);
    const bb = Math.round(neb.b * 255);
    grad.addColorStop(0, `rgba(${rr}, ${gg}, ${bb}, ${(neb.intensity * 0.22).toFixed(3)})`);
    grad.addColorStop(0.55, `rgba(60, 110, 175, ${(neb.intensity * 0.08).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(2, 4, 10, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 2D fallback celestial renderer when WebGL is unavailable (e.g., JSDOM tests). */
function drawCelestialBody2D(
  ctx: CanvasRenderingContext2D,
  node: StarNode,
  sx: number,
  sy: number,
  sr: number,
  alpha: number,
  tSec: number,
  emphasized: boolean,
  zoom = 1,
): void {
  const type: CelestialType = node.request.celestial_type;
  ctx.save();
  if (type === 'black_hole') {
    const bhR = Math.max(2.8, sr * 1.15);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-0.28);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255, 198, 128, ${alpha * 0.7})`;
    ctx.lineWidth = Math.max(1.2, bhR * 0.4);
    ctx.beginPath();
    ctx.ellipse(0, 0, bhR * 3.0, bhR * 0.68, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.beginPath();
    ctx.arc(0, 0, bhR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 232, 194, ${alpha * 0.9})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    ctx.restore();
    return;
  }

  ctx.globalCompositeOperation = 'lighter';
  const lum = clamp((node.magnitude - 0.1) / 0.9, 0, 1);
  const haloScale = emphasized ? 1 : 0.5 + 0.5 * smoothstep01((zoom - 0.15) / 0.65);
  const haloR = sr * (emphasized ? 5.6 : (2.8 + lum * 2.6) * haloScale);
  const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, haloR);
  grad.addColorStop(0, `rgba(255, 255, 255, ${clamp(alpha * (0.48 + lum * 0.52), 0, 1)})`);
  grad.addColorStop(0.28, hexToRgba(node.color, alpha * (0.28 + lum * 0.52)));
  grad.addColorStop(1, hexToRgba(node.color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy, haloR, 0, Math.PI * 2);
  ctx.fill();

  if (type === 'comet') {
    const ang = COMET_TAIL_ANGLE;
    const len = sr * 6 + 12;
    ctx.strokeStyle = `rgba(148, 206, 255, ${alpha * 0.5})`;
    ctx.lineWidth = Math.max(1, sr * 0.4);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
    ctx.stroke();
  } else if (type === 'pulsar') {
    const spin = tSec * 0.9;
    const len = sr * 4.2;
    ctx.strokeStyle = `rgba(182, 236, 244, ${alpha * 0.5})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sx - Math.cos(spin) * len, sy - Math.sin(spin) * len);
    ctx.lineTo(sx + Math.cos(spin) * len, sy + Math.sin(spin) * len);
    ctx.stroke();
  } else if (type === 'binary') {
    const off = Math.max(3, sr * 1.2);
    ctx.fillStyle = hexToRgba('#ffd8a8', alpha * 0.85);
    ctx.beginPath();
    ctx.arc(sx + off, sy - off * 0.5, Math.max(1.2, sr * 0.65), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function getInterpolatedNodePos(
  node: StarNode,
  clusterById: Map<string, SubagentCluster>,
  clusterAnimMap: Map<string, number>,
): { x: number; y: number } {
  if (!node.subagentClusterId) {
    return { x: node.x, y: node.y };
  }
  const cluster = clusterById.get(node.subagentClusterId);
  if (!cluster) {
    return { x: node.x, y: node.y };
  }
  const animP = clusterAnimMap.get(cluster.id) ?? 0;
  return {
    x: cluster.anchorX + (node.x - cluster.anchorX) * animP,
    y: cluster.anchorY + (node.y - cluster.anchorY) * animP,
  };
}

function drawExpandedCompanionNebulae(
  ctx: CanvasRenderingContext2D,
  clusters: SubagentCluster[],
  clusterAnimMap: Map<string, number>,
  camera: CameraState,
  width: number,
  height: number,
  maxVisibleCount: number | null,
  totalNodeCount: number,
  hasActiveFilter: boolean,
  matchingClusterIds: Set<string> | null,
  activeConvIds: Set<string>,
  activeClusterIds: Set<string>,
  introProgress = 1,
): void {
  if (clusters.length === 0) return;
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, totalNodeCount)
      : totalNodeCount;
  const visualScale = getVisualScale(camera.zoom);

  for (const c of clusters) {
    if (c.firstNodeIndex >= limit) continue;
    const animP = clusterAnimMap.get(c.id) ?? 0;
    if (animP <= 0.04) continue;
    const introGate = computeClusterIntroGate(c.id, introProgress);
    if (introGate <= 0.005) continue;

    const pts: Array<{ x: number; y: number }> = [];
    for (const m of c.memberNodes) {
      if (m.index >= limit) continue;
      const wx = c.anchorX + (m.x - c.anchorX) * animP;
      const wy = c.anchorY + (m.y - c.anchorY) * animP;
      pts.push(worldToScreen(wx, wy, camera, width, height));
    }
    if (pts.length === 0) continue;

    let meanX = 0;
    let meanY = 0;
    for (const pt of pts) {
      meanX += pt.x;
      meanY += pt.y;
    }
    meanX /= pts.length;
    meanY /= pts.length;

    let angle = c.outwardAngle;
    let rx = Math.max(22, c.clusterRadius * visualScale * 2.2);
    let ry = Math.max(15, c.clusterRadius * visualScale * 1.5);

    if (pts.length >= 2) {
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (const pt of pts) {
        const dx = pt.x - meanX;
        const dy = pt.y - meanY;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
      if (Math.abs(sxx - syy) + Math.abs(sxy) > 1e-3) {
        angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      }

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      let maxU = 0;
      let maxV = 0;
      for (const pt of pts) {
        const dx = pt.x - meanX;
        const dy = pt.y - meanY;
        const u = Math.abs(dx * cosA + dy * sinA);
        const v = Math.abs(-dx * sinA + dy * cosA);
        if (u > maxU) maxU = u;
        if (v > maxV) maxV = v;
      }
      rx = Math.max(22, maxU + 14 * visualScale + 8);
      ry = Math.max(15, maxV + 10 * visualScale + 6);
    }

    const minCircularR = Math.max(rx, ry) * 0.85;
    rx = Math.max(rx, minCircularR);
    ry = Math.max(ry, minCircularR);

    const maxR = Math.max(rx, ry);
    if (
      meanX + maxR < -20 ||
      meanX - maxR > width + 20 ||
      meanY + maxR < -20 ||
      meanY - maxR > height + 20
    ) {
      continue;
    }

    const isActive = activeClusterIds.has(c.id) || activeConvIds.has(c.conversationId);
    const isMatched = !hasActiveFilter || !matchingClusterIds || matchingClusterIds.has(c.id);
    const veilAlpha = animP * introGate * (isMatched ? (isActive ? 1.25 : 1.0) : 0.24);
    if (veilAlpha <= 0.005) continue;

    ctx.save();
    ctx.translate(meanX, meanY);
    ctx.rotate(angle);
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.scale(1, ry / Math.max(1, rx));
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, hexToRgba(c.color, clamp(0.14 * veilAlpha, 0, 0.36)));
    grad.addColorStop(0.58, hexToRgba(c.color, clamp(0.055 * veilAlpha, 0, 0.22)));
    grad.addColorStop(1, hexToRgba(c.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hexToRgba(c.color, clamp((isActive ? 0.22 : 0.09) * veilAlpha, 0, 0.35));
    ctx.lineWidth = isActive ? 1.0 : 0.7;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.94, ry * 0.94, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawSubagentTidalBridges(
  ctx: CanvasRenderingContext2D,
  nodeById: Map<string, StarNode>,
  clusters: SubagentCluster[],
  clusterById: Map<string, SubagentCluster>,
  clusterAnimMap: Map<string, number>,
  camera: CameraState,
  width: number,
  height: number,
  maxVisibleCount: number | null,
  totalNodeCount: number,
  matchingIds: Set<string> | null,
  matchingClusterIds: Set<string> | null,
  hasActiveFilter: boolean,
  activeConvIds: Set<string>,
  activeClusterIds: Set<string>,
  selectedStarId: string | null,
  hoveredStarId: string | null,
  highlightedDates: Set<string>,
  tSec: number,
  revealProgress = 1,
): void {
  if (clusters.length === 0) return;
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, totalNodeCount)
      : totalNodeCount;
  const visualScale = getVisualScale(camera.zoom);
  const bridgeZoomFade = smoothstep01((camera.zoom - 0.22) / 0.56);

  ctx.save();
  ctx.lineCap = 'round';

  for (const c of clusters) {
    if (c.firstNodeIndex >= limit || !c.parentNodeId) continue;
    const parentNode = nodeById.get(c.parentNodeId);
    if (!parentNode || parentNode.index >= limit) continue;
    const firstMember = c.memberNodes[0];
    if (!firstMember) continue;

    const animP = clusterAnimMap.get(c.id) ?? 0;
    const parentPosW = getInterpolatedNodePos(parentNode, clusterById, clusterAnimMap);
    const targetWx = c.anchorX + (firstMember.x - c.anchorX) * animP;
    const targetWy = c.anchorY + (firstMember.y - c.anchorY) * animP;

    const pStart = worldToScreen(parentPosW.x, parentPosW.y, camera, width, height);
    const pEnd = worldToScreen(targetWx, targetWy, camera, width, height);

    if (
      (pStart.x < -120 && pEnd.x < -120) ||
      (pStart.x > width + 120 && pEnd.x > width + 120) ||
      (pStart.y < -120 && pEnd.y < -120) ||
      (pStart.y > height + 120 && pEnd.y > height + 120)
    ) {
      continue;
    }

    const dx = pEnd.x - pStart.x;
    const dy = pEnd.y - pStart.y;
    const dist = Math.hypot(dx, dy);

    let parentEffectiveR = parentNode.radius;
    if (parentNode.subagentClusterId) {
      const pCluster = clusterById.get(parentNode.subagentClusterId);
      const pAnim = pCluster ? (clusterAnimMap.get(pCluster.id) ?? 0) : 1;
      parentEffectiveR = pCluster
        ? pCluster.clusterRadius * (1 - pAnim) + parentNode.radius * 0.62 * pAnim
        : parentNode.radius * 0.62;
    }
    const clipStart = parentEffectiveR * visualScale * 1.9 + 4;
    const endClusterR = c.clusterRadius * visualScale * 1.35 + 4;
    const endMemberR = firstMember.radius * 0.62 * visualScale * 2.0 + 4;
    const clipEnd = endClusterR + (endMemberR - endClusterR) * animP;
    if (dist <= clipStart + clipEnd + 2) continue;

    const ux = dx / dist;
    const uy = dy / dist;
    const sx = pStart.x + ux * clipStart;
    const sy = pStart.y + uy * clipStart;
    const fullEx = pEnd.x - ux * clipEnd;
    const fullEy = pEnd.y - uy * clipEnd;

    const segReveal =
      revealProgress >= 1
        ? 1
        : clamp(revealProgress * 1.5 - ((c.firstNodeIndex * 5) % 10) * 0.05, 0, 1);
    if (segReveal <= 0) continue;

    const curveSign = fnv1a32(`${c.id}:bridge`) % 2 === 0 ? 1 : -1;
    const bend = Math.min(34, dist * 0.14) * curveSign;
    const ctrlX = (sx + fullEx) * 0.5 - uy * bend;
    const ctrlY = (sy + fullEy) * 0.5 + ux * bend;

    const qx = sx + (ctrlX - sx) * segReveal;
    const qy = sy + (ctrlY - sy) * segReveal;
    const rx = ctrlX + (fullEx - ctrlX) * segReveal;
    const ry = ctrlY + (fullEy - ctrlY) * segReveal;
    const ex = qx + (rx - qx) * segReveal;
    const ey = qy + (ry - qy) * segReveal;

    const isClusterFocused = activeClusterIds.has(c.id);
    const isParentActive =
      activeConvIds.has(c.conversationId) ||
      parentNode.id === hoveredStarId ||
      parentNode.id === selectedStarId ||
      highlightedDates.has(c.localDate);
    const isHighlighted = isClusterFocused || isParentActive;
    const isMatched =
      !hasActiveFilter ||
      Boolean(matchingClusterIds?.has(c.id)) ||
      Boolean(matchingIds?.has(parentNode.id));

    if (!isHighlighted && bridgeZoomFade <= 0.03) {
      continue;
    }

    if (isHighlighted && isMatched) {
      const hiZoomFade = Math.max(0.55, bridgeZoomFade);
      const breath = 0.86 + 0.14 * Math.sin(tSec * 2.4 + (c.firstNodeIndex % 7));
      ctx.setLineDash([]);
      ctx.strokeStyle = hexToRgba(
        c.color,
        clamp((isClusterFocused ? 0.28 : 0.18) * breath * hiZoomFade, 0, 0.45),
      );
      ctx.lineWidth = isClusterFocused ? 4.4 : 3.2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, ex, ey);
      ctx.stroke();

      const grad = ctx.createLinearGradient(sx, sy, ex, ey);
      grad.addColorStop(0, `rgba(182, 222, 255, ${(isClusterFocused ? 0.85 : 0.65) * hiZoomFade})`);
      grad.addColorStop(0.55, hexToRgba(c.color, (isClusterFocused ? 0.96 : 0.82) * hiZoomFade));
      grad.addColorStop(1, `rgba(255, 246, 224, ${0.92 * hiZoomFade})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = isClusterFocused ? 1.45 : 1.15;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, ex, ey);
      ctx.stroke();
    } else if (!isMatched) {
      const dimZoomFade = isHighlighted ? Math.max(0.55, bridgeZoomFade) : bridgeZoomFade;
      ctx.strokeStyle = `rgba(138, 174, 228, ${(0.055 * dimZoomFade).toFixed(4)})`;
      ctx.lineWidth = 0.6;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, ex, ey);
      ctx.stroke();
    } else {
      const grad = ctx.createLinearGradient(sx, sy, ex, ey);
      grad.addColorStop(0, `rgba(162, 204, 255, ${(0.16 * bridgeZoomFade).toFixed(3)})`);
      grad.addColorStop(1, hexToRgba(c.color, 0.26 * bridgeZoomFade));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 0.7;
      ctx.setLineDash([3.5, 3.5]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, ex, ey);
      ctx.stroke();
    }
  }

  ctx.setLineDash([]);
  ctx.restore();
}

function drawCollapsedGlobularClusters(
  ctx: CanvasRenderingContext2D,
  clusters: SubagentCluster[],
  clusterAnimMap: Map<string, number>,
  camera: CameraState,
  width: number,
  height: number,
  maxVisibleCount: number | null,
  totalNodeCount: number,
  hasActiveFilter: boolean,
  matchingClusterIds: Set<string> | null,
  hoveredClusterId: string | null,
  selectedClusterId: string | null,
  selectedStarId: string | null,
  hoveredStarId: string | null,
  highlightDate: string | null,
  tSec: number,
  introProgress = 1,
  deepOut = 0,
): void {
  if (clusters.length === 0) return;
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, totalNodeCount)
      : totalNodeCount;
  const visualScale = getVisualScale(camera.zoom);
  const currentPlaybackIndex = maxVisibleCount !== null ? limit - 1 : -1;

  for (const c of clusters) {
    if (c.firstNodeIndex >= limit) continue;
    const animP = clusterAnimMap.get(c.id) ?? 0;
    if (animP >= 0.98) continue;
    const introGate = computeClusterIntroGate(c.id, introProgress);
    if (introGate <= 0.005) continue;

    const collapseAlpha = clamp(1 - animP, 0, 1);
    const isSelected = c.id === selectedClusterId;
    const isHovered = c.id === hoveredClusterId;
    const isParentActive = Boolean(
      c.parentNodeId && (c.parentNodeId === selectedStarId || c.parentNodeId === hoveredStarId),
    );
    const isDateHighlighted = Boolean(highlightDate && c.localDate === highlightDate);
    const isMatched = !hasActiveFilter || !matchingClusterIds || matchingClusterIds.has(c.id);
    const filterAlpha = isMatched
      ? 1
      : isDateHighlighted || isSelected || isHovered || isParentActive
        ? 0.25
        : 0.16;
    const alpha = collapseAlpha * filterAlpha * introGate;
    if (alpha <= 0.01) continue;

    const pos = worldToScreen(c.anchorX, c.anchorY, camera, width, height);
    const baseR =
      c.clusterRadius * visualScale * (1 + animP * 0.25) * (0.78 + 0.22 * introGate);
    const haloScale = 1 - deepOut * 0.25;
    const haloMult = (2.1 + 1.3 * smoothstep01((camera.zoom - 0.18) / 0.65)) * haloScale;
    const haloR = baseR * haloMult;
    if (
      pos.x + haloR < -10 ||
      pos.x - haloR > width + 10 ||
      pos.y + haloR < -10 ||
      pos.y - haloR > height + 10
    ) {
      continue;
    }

    const isPlaybackActive =
      maxVisibleCount !== null &&
      currentPlaybackIndex >= c.firstNodeIndex &&
      currentPlaybackIndex <= c.lastNodeIndex;
    const pulseWave = isPlaybackActive ? 0.5 + 0.5 * Math.sin(tSec * 6.0) : 0;
    const pulseScale = isPlaybackActive ? 1 + 0.16 * pulseWave : 1;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Scaled radial halo
    const glowR = haloR * (isHovered || isSelected ? 1.24 : 1.0) * pulseScale;
    const haloGrad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, glowR);
    haloGrad.addColorStop(0, hexToRgba('#ffffff', clamp(alpha * (0.54 + pulseWave * 0.22) * haloScale, 0, 1)));
    haloGrad.addColorStop(0.24, hexToRgba(c.color, clamp(alpha * (0.46 + pulseWave * 0.18) * haloScale, 0, 1)));
    haloGrad.addColorStop(0.6, hexToRgba(c.color, clamp(alpha * 0.15 * haloScale, 0, 1)));
    haloGrad.addColorStop(1, hexToRgba(c.color, 0));
    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Deterministic stippled micro-dust dots in King-profile radial distribution
    const dotCount = clamp(Math.round(5 + Math.log2(c.requestCount + 1) * 3.5), 6, 22);
    const rand = mulberry32(fnv1a32(c.id));
    for (let k = 0; k < dotCount; k += 1) {
      const u = rand();
      const kingR = clamp(0.34 * Math.tan(u * 1.18), 0.12, 1.0);
      const dotAngle = rand() * Math.PI * 2 + tSec * 0.04 * (k % 2 === 0 ? 1 : -1);
      const dotDist = kingR * baseR * 2.15 * (1 + animP * 0.65) * pulseScale;
      const dotR = (0.55 + rand() * 0.95) * clamp(visualScale * 0.72, 0.55, 1.5);
      const dotAlpha = clamp(alpha * (0.44 + 0.5 * (1 - kingR)), 0, 1);
      const dx = pos.x + Math.cos(dotAngle) * dotDist;
      const dy = pos.y + Math.sin(dotAngle) * dotDist;
      ctx.fillStyle = hexToRgba(k % 3 === 0 ? '#eef5ff' : c.color, dotAlpha);
      ctx.beginPath();
      ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bright compact core
    const coreR = Math.max(1.8, baseR * 0.36) * pulseScale;
    const coreGrad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, coreR * 1.85);
    coreGrad.addColorStop(0, `rgba(255, 255, 255, ${clamp(alpha * 0.95, 0, 1)})`);
    coreGrad.addColorStop(0.45, hexToRgba(c.color, clamp(alpha * 0.75, 0, 1)));
    coreGrad.addColorStop(1, hexToRgba(c.color, 0));
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, coreR * 1.85, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    if (isHovered || isSelected) {
      drawSelectionReticle(ctx, pos.x, pos.y, baseR * 0.9, isSelected, tSec);
    }
  }
}

function drawActiveConversationCaptions(
  ctx: CanvasRenderingContext2D,
  nodes: StarNode[],
  limit: number,
  camera: CameraState,
  width: number,
  height: number,
  activeConvIds: Set<string>,
  privacyMode: boolean,
): void {
  if (activeConvIds.size === 0) return;
  ctx.save();
  for (const convId of activeConvIds) {
    let sampleNode: StarNode | null = null;
    for (let i = 0; i < limit; i += 1) {
      if (nodes[i].star.id === convId) {
        sampleNode = nodes[i];
        break;
      }
    }
    if (!sampleNode) continue;

    const anchorTop = worldToScreen(
      sampleNode.convCenterX,
      sampleNode.convCenterY - sampleNode.convRadius * 0.78,
      camera,
      width,
      height,
    );
    const labelX = clamp(anchorTop.x, 90, width - 90);
    const labelY = clamp(anchorTop.y, 70, height - 48);

    const label = getDisplayTitle(sampleNode.star, sampleNode.convIndex, privacyMode);
    const caption = label.length > 26 ? `${label.slice(0, 25)}…` : label;

    ctx.font = '500 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(2, 4, 10, 0.82)';
    ctx.fillText(caption, labelX + 1, labelY + 1);
    ctx.fillStyle = 'rgba(222, 236, 255, 0.88)';
    ctx.fillText(caption, labelX, labelY);
  }
  ctx.restore();
}

function drawActiveConversationAura(
  ctx: CanvasRenderingContext2D,
  nodes: StarNode[],
  limit: number,
  camera: CameraState,
  width: number,
  height: number,
  activeConvIds: Set<string>,
  tSec: number,
): void {
  if (activeConvIds.size === 0) return;
  const safeLimit = clamp(Math.floor(limit), 0, nodes.length);
  ctx.save();
  for (const convId of activeConvIds) {
    let sampleNode: StarNode | null = null;
    for (let i = 0; i < safeLimit; i += 1) {
      if (nodes[i].star.id === convId) {
        sampleNode = nodes[i];
        break;
      }
    }
    if (!sampleNode) continue;
    const centerPos = worldToScreen(
      sampleNode.convCenterX,
      sampleNode.convCenterY,
      camera,
      width,
      height,
    );
    const auraR = Math.max(36, sampleNode.convRadius * camera.zoom * 0.92);
    if (
      centerPos.x + auraR < 0 ||
      centerPos.x - auraR > width ||
      centerPos.y + auraR < 0 ||
      centerPos.y - auraR > height
    ) {
      continue;
    }
    const breath = 0.9 + 0.1 * Math.sin(tSec * 2.1);
    const aura = ctx.createRadialGradient(
      centerPos.x,
      centerPos.y,
      0,
      centerPos.x,
      centerPos.y,
      auraR,
    );
    aura.addColorStop(0, `rgba(148, 198, 255, ${0.075 * breath})`);
    aura.addColorStop(0.65, `rgba(128, 178, 245, ${0.025 * breath})`);
    aura.addColorStop(1, 'rgba(128, 178, 245, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(centerPos.x, centerPos.y, auraR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function punchOutOverlayAroundStars(
  ctx: CanvasRenderingContext2D,
  nodes: StarNode[],
  visibleLimit: number,
  clusterById: Map<string, SubagentCluster>,
  clusterAnimMap: Map<string, number>,
  camera: CameraState,
  width: number,
  height: number,
  deepSrScale = 1,
): void {
  if (visibleLimit <= 0) return;
  const visualScale = getVisualScale(camera.zoom);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';

  for (let i = 0; i < visibleLimit; i += 1) {
    const node = nodes[i];
    let wx = node.x;
    let wy = node.y;
    let srScale = 1;
    if (node.subagentClusterId && clusterById.has(node.subagentClusterId)) {
      const cluster = clusterById.get(node.subagentClusterId)!;
      const animP = clusterAnimMap.get(cluster.id) ?? 0;
      if (animP <= 0.02) {
        continue;
      }
      wx = cluster.anchorX + (node.x - cluster.anchorX) * animP;
      wy = cluster.anchorY + (node.y - cluster.anchorY) * animP;
      srScale = 0.62;
    }

    const pos = worldToScreen(wx, wy, camera, width, height);
    const sr = Math.max(0.72, node.radius * visualScale * srScale * deepSrScale);
    const clearR = Math.max(1.8, sr * 1.35 + 1.0);
    if (
      pos.x + clearR < 0 ||
      pos.x - clearR > width ||
      pos.y + clearR < 0 ||
      pos.y - clearR > height
    ) {
      continue;
    }

    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, clearR);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, clearR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawConstellationLayer(
  ctx: CanvasRenderingContext2D,
  nodes: StarNode[],
  allSegments: ConstellationSegment[],
  camera: CameraState,
  width: number,
  height: number,
  matchingIds: Set<string> | null,
  hasActiveFilter: boolean,
  activeConvIds: Set<string>,
  highlightedDates: Set<string>,
  maxVisibleCount: number | null,
  tSec: number,
  privacyMode: boolean,
  showActiveCaption: boolean,
  drawLines: boolean,
  revealProgress = 1,
  clusters?: SubagentCluster[],
  clusterById?: Map<string, SubagentCluster>,
  clusterAnimMap?: Map<string, number>,
  activeClusterIds?: Set<string>,
): void {
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, nodes.length)
      : nodes.length;
  const visualScale = getVisualScale(camera.zoom);
  const lineZoomFade = 0.35 + 0.65 * smoothstep01((camera.zoom - 0.18) / 0.48);
  const hasClusters = Boolean(clusters && clusters.length > 0 && clusterById && clusterAnimMap);

  ctx.save();
  ctx.lineCap = 'round';

  if (drawLines) {
    for (const seg of allSegments) {
      if (seg.fromIndex >= limit || seg.toIndex >= limit) continue;
      if (hasClusters && seg.kind === 'subagent_bridge') continue;

      let fromWx = seg.from.x;
      let fromWy = seg.from.y;
      let toWx = seg.to.x;
      let toWy = seg.to.y;
      let fromRadScale = 1;
      let toRadScale = 1;
      let streamAnimAlpha = 1;

      if (hasClusters && seg.kind === 'subagent_stream' && seg.subagentClusterId) {
        const cluster = clusterById!.get(seg.subagentClusterId);
        if (cluster) {
          const animP = clusterAnimMap!.get(cluster.id) ?? 0;
          if (animP <= 0.02) continue;
          fromWx = cluster.anchorX + (seg.from.x - cluster.anchorX) * animP;
          fromWy = cluster.anchorY + (seg.from.y - cluster.anchorY) * animP;
          toWx = cluster.anchorX + (seg.to.x - cluster.anchorX) * animP;
          toWy = cluster.anchorY + (seg.to.y - cluster.anchorY) * animP;
          fromRadScale = 0.62;
          toRadScale = 0.62;
          streamAnimAlpha = animP;
        }
      }

      const p1 = worldToScreen(fromWx, fromWy, camera, width, height);
      const p2 = worldToScreen(toWx, toWy, camera, width, height);

      if (
        (p1.x < -80 && p2.x < -80) ||
        (p1.x > width + 80 && p2.x > width + 80) ||
        (p1.y < -80 && p2.y < -80) ||
        (p1.y > height + 80 && p2.y > height + 80)
      ) {
        continue;
      }

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy);
      const clipStart = seg.from.radius * fromRadScale * visualScale * 2.1 + 3.5;
      const clipEnd = seg.to.radius * toRadScale * visualScale * 2.1 + 3.5;
      if (dist <= clipStart + clipEnd + 1) continue;

      const ux = dx / dist;
      const uy = dy / dist;
      const sx = p1.x + ux * clipStart;
      const sy = p1.y + uy * clipStart;
      const fullEx = p2.x - ux * clipEnd;
      const fullEy = p2.y - uy * clipEnd;
      // Cinematic draw-on: each constellation edge traces itself in, slightly staggered
      const segReveal =
        revealProgress >= 1
          ? 1
          : clamp(revealProgress * 1.5 - ((seg.fromIndex * 7 + seg.toIndex * 3) % 10) * 0.05, 0, 1);
      if (segReveal <= 0) continue;
      const ex = sx + (fullEx - sx) * segReveal;
      const ey = sy + (fullEy - sy) * segReveal;

      const bothMatched =
        !hasActiveFilter ||
        !matchingIds ||
        (matchingIds.has(seg.from.id) && matchingIds.has(seg.to.id));

      const isHighlighted =
        activeConvIds.has(seg.conversationId) ||
        Boolean(seg.subagentClusterId && activeClusterIds?.has(seg.subagentClusterId)) ||
        highlightedDates.has(seg.from.request.local_date) ||
        highlightedDates.has(seg.to.request.local_date) ||
        highlightedDates.has(seg.date);

      if (streamAnimAlpha < 1) {
        ctx.save();
        ctx.globalAlpha *= streamAnimAlpha;
      }
      ctx.setLineDash(seg.isBranch ? [3, 3] : []);

      if (isHighlighted && bothMatched) {
        const breath = 0.85 + 0.15 * Math.sin(tSec * 2.1 + (seg.fromIndex % 5));
        // Soft celestial silk veil behind active constellation filament
        ctx.strokeStyle = `rgba(146, 194, 255, ${(0.12 * breath).toFixed(3)})`;
        ctx.lineWidth = seg.isBranch ? 3.2 : 4.6;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        // Sweeping luminous silk-starlight wave across the filament (no circular beads)
        const rawWave = ((tSec * 0.36 - (seg.fromIndex % 12) * 0.07) % 1.5 + 1.5) % 1.5 - 0.25;
        const crest = clamp(rawWave, 0, 1);
        const lead = clamp(crest - 0.24, 0, 1);
        const trail = clamp(crest + 0.24, 0, 1);
        const baseAlpha = seg.isBranch ? 0.36 : 0.44;
        const peakAlpha = seg.isBranch ? 0.84 : 0.96;

        const sweepGrad = ctx.createLinearGradient(sx, sy, ex, ey);
        sweepGrad.addColorStop(0, `rgba(192, 222, 255, ${baseAlpha})`);
        if (lead > 0.001) {
          sweepGrad.addColorStop(lead, `rgba(196, 226, 255, ${baseAlpha})`);
        }
        sweepGrad.addColorStop(crest, `rgba(255, 246, 224, ${peakAlpha})`);
        if (trail < 0.999) {
          sweepGrad.addColorStop(trail, `rgba(196, 226, 255, ${baseAlpha})`);
        }
        sweepGrad.addColorStop(1, `rgba(192, 222, 255, ${baseAlpha})`);

        ctx.strokeStyle = sweepGrad;
        ctx.lineWidth = seg.isBranch ? 1.05 : 1.35;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        // Subtle astrometric diamond end-ticks anchoring the illuminated filament
        if (segReveal >= 0.95) {
          ctx.fillStyle = 'rgba(255, 246, 226, 0.72)';
          const pip = 1.6;
          ctx.beginPath();
          ctx.moveTo(sx, sy - pip);
          ctx.lineTo(sx + pip, sy);
          ctx.lineTo(sx, sy + pip);
          ctx.lineTo(sx - pip, sy);
          ctx.closePath();
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(ex, ey - pip);
          ctx.lineTo(ex + pip, ey);
          ctx.lineTo(ex, ey + pip);
          ctx.lineTo(ex - pip, ey);
          ctx.closePath();
          ctx.fill();
        }
      } else if (!bothMatched) {
        ctx.strokeStyle = 'rgba(148, 174, 218, 0.045)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      } else {
        if (seg.isBranch) {
          ctx.strokeStyle = `rgba(164, 194, 240, ${(0.12 * lineZoomFade).toFixed(3)})`;
          ctx.lineWidth = 0.65;
        } else if (seg.tier === 'primary') {
          ctx.strokeStyle = `rgba(192, 218, 255, ${(0.2 * lineZoomFade).toFixed(3)})`;
          ctx.lineWidth = 0.9;
        } else {
          ctx.strokeStyle = `rgba(164, 194, 240, ${(0.11 * lineZoomFade).toFixed(3)})`;
          ctx.lineWidth = 0.65;
        }
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }

      if (streamAnimAlpha < 1) {
        ctx.restore();
      }
    }
    ctx.setLineDash([]);
  }

  // Non-overlapping astrometric caption anchored above active conversation bounding circle
  if (showActiveCaption && activeConvIds.size > 0) {
    drawActiveConversationCaptions(
      ctx,
      nodes,
      limit,
      camera,
      width,
      height,
      activeConvIds,
      privacyMode,
    );
  }

  ctx.restore();
}

/** Stellarium-style animated rotating/breathing 4-arc precision reticle. */
function drawSelectionReticle(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sr: number,
  isSelected: boolean,
  tSec: number,
): void {
  const breathe = 1 + 0.06 * Math.sin(tSec * 3.0);
  const r = Math.max(12, (sr * 2.5 + 5) * breathe);
  const rot = tSec * (isSelected ? 0.35 : 0.22);
  const arcSpan = Math.PI * 0.24;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(rot);
  ctx.strokeStyle = isSelected ? 'rgba(222, 238, 255, 0.9)' : 'rgba(186, 214, 252, 0.56)';
  ctx.lineWidth = isSelected ? 1.25 : 0.9;
  ctx.setLineDash([]);

  for (let q = 0; q < 4; q += 1) {
    const start = q * (Math.PI / 2) - arcSpan * 0.5;
    const end = start + arcSpan;
    ctx.beginPath();
    ctx.arc(0, 0, r, start, end);
    ctx.stroke();

    // Fine radial pointer tick on each quadrant
    const mid = (start + end) * 0.5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(mid) * (r + 1), Math.sin(mid) * (r + 1));
    ctx.lineTo(Math.cos(mid) * (r + 4.5), Math.sin(mid) * (r + 4.5));
    ctx.stroke();
  }

  ctx.restore();
}

function formatExportTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

function drawCommemorativeCardBadge(
  ctx: CanvasRenderingContext2D,
  logicalWidth: number,
  logicalHeight: number,
  starCount: number,
  convCount: number,
  options: SkyExportOptions,
): void {
  const padX = 24;
  const boxH = 66;
  const boxY = Math.max(16, logicalHeight - boxH - 22);
  const modeLabel = options.tokenMode === 'total' ? '含缓存总处理量' : '仅新增消耗';
  const line1 = `TokenStar · ${modeLabel}`;
  const line2 = `${options.dateRange || '—'}  ·  ${starCount} 颗星体（${convCount} 个对话星座）  ·  ${formatExportTokens(options.totalTokens)} Tokens`;

  ctx.save();
  ctx.font = '600 13px sans-serif';
  const w1 = ctx.measureText(line1).width;
  ctx.font = '400 11.5px sans-serif';
  const w2 = ctx.measureText(line2).width;
  const boxW = Math.min(Math.max(270, Math.max(w1, w2) + 38), Math.max(280, logicalWidth - padX * 2));

  ctx.fillStyle = 'rgba(4, 7, 16, 0.78)';
  ctx.strokeStyle = 'rgba(170, 198, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(padX, boxY, boxW, boxH, 10);
  } else {
    ctx.rect(padX, boxY, boxW, boxH);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#edf4ff';
  ctx.font = '600 13px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(line1, padX + 16, boxY + 14);

  ctx.fillStyle = 'rgba(196, 214, 245, 0.82)';
  ctx.font = '400 11.5px sans-serif';
  ctx.fillText(line2, padX + 16, boxY + 37);
  ctx.restore();
}

function triggerPngDownload(canvas: HTMLCanvasElement, filename: string): void {
  const downloadFromUrl = (url: string, revokeAfter: boolean) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (revokeAfter && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  if (
    typeof canvas.toBlob === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    canvas.toBlob((blob) => {
      if (blob) {
        downloadFromUrl(URL.createObjectURL(blob), true);
      } else if (typeof canvas.toDataURL === 'function') {
        downloadFromUrl(canvas.toDataURL('image/png'), false);
      }
    }, 'image/png');
    return;
  }

  if (typeof canvas.toDataURL === 'function') {
    downloadFromUrl(canvas.toDataURL('image/png'), false);
  }
}

/**
 * Export the starry sky at 2x resolution as either a clean wallpaper (`wallpaper`)
 * or a discreet commemorative card (`card`) that never leaks conversation titles.
 */
export function exportSkyPng(
  nodes: StarNode[],
  options: SkyExportOptions,
): SkyExportResult | null {
  const logicalW = options.width > 0 ? options.width : 1280;
  const logicalH = options.height > 0 ? options.height : 720;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(logicalW * 2);
  canvas.height = Math.round(logicalH * 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(2, 0, 0, 2, 0, 0);

  const clusters = options.clusters ?? [];
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const effectiveExpanded = getEffectiveExpandedSet(
    clusters,
    Boolean(options.expandAllSubagents),
    options.expandedClusterIds,
  );
  const clusterAnimMap = new Map<string, number>();
  for (const c of clusters) {
    clusterAnimMap.set(c.id, effectiveExpanded.has(c.id) ? 1 : 0);
  }

  const exportNodes: StarNode[] =
    clusters.length === 0
      ? nodes
      : nodes.flatMap((node) => {
          if (node.subagentClusterId && clusterById.has(node.subagentClusterId)) {
            if (!effectiveExpanded.has(node.subagentClusterId)) {
              return [];
            }
            return [{ ...node, radius: node.radius * 0.62 }];
          }
          return [node];
        });

  const showNebulae = options.showNebulae ?? true;
  const glSnap = renderWebGLSnapshot(exportNodes, logicalW, logicalH, options.camera, 1.2, showNebulae);
  if (glSnap) {
    ctx.drawImage(glSnap, 0, 0, logicalW, logicalH);
  } else {
    const dust = generateBackgroundDust(DEFAULT_DUST_COUNT);
    drawBackdrop2D(ctx, logicalW, logicalH, dust);
    if (showNebulae) {
      drawNebulae2D(ctx, buildClusterNebulae(exportNodes), options.camera, logicalW, logicalH);
    }
  }

  const showGrid = options.showGrid ?? false;
  const showConstellations = options.showConstellations ?? true;
  if (showGrid) {
    drawEquatorialGraticule(ctx, options.camera, logicalW, logicalH, false);
  }

  if (showConstellations) {
    const allSegments = buildConstellationSegments(nodes);
    drawConstellationLayer(
      ctx,
      nodes,
      allSegments,
      options.camera,
      logicalW,
      logicalH,
      null,
      false,
      new Set<string>(),
      new Set<string>(),
      null,
      1.2,
      options.privacyMode,
      false,
      true,
      1,
      clusters,
      clusterById,
      clusterAnimMap,
    );
    if (clusters.length > 0) {
      drawSubagentTidalBridges(
        ctx,
        nodeById,
        clusters,
        clusterById,
        clusterAnimMap,
        options.camera,
        logicalW,
        logicalH,
        null,
        nodes.length,
        null,
        null,
        false,
        new Set<string>(),
        new Set<string>(),
        null,
        null,
        new Set<string>(),
        1.2,
        1,
      );
    }
  }

  if (clusters.length > 0) {
    drawExpandedCompanionNebulae(
      ctx,
      clusters,
      clusterAnimMap,
      options.camera,
      logicalW,
      logicalH,
      null,
      nodes.length,
      false,
      null,
      new Set<string>(),
      new Set<string>(),
    );
  }

  drawActiveConversationAura(
    ctx,
    nodes,
    nodes.length,
    options.camera,
    logicalW,
    logicalH,
    new Set<string>(),
    1.2,
  );

  if (clusters.length > 0) {
    drawCollapsedGlobularClusters(
      ctx,
      clusters,
      clusterAnimMap,
      options.camera,
      logicalW,
      logicalH,
      null,
      nodes.length,
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      1.2,
    );
  }

  if (!glSnap) {
    const visualScale = getVisualScale(options.camera.zoom);
    for (const node of exportNodes) {
      const pos = worldToScreen(node.x, node.y, options.camera, logicalW, logicalH);
      const sr = node.radius * visualScale;
      if (pos.x + sr * 8 < 0 || pos.x - sr * 8 > logicalW || pos.y + sr * 8 < 0 || pos.y - sr * 8 > logicalH) {
        continue;
      }
      drawCelestialBody2D(ctx, node, pos.x, pos.y, sr, 1, 0, false, options.camera.zoom);
    }
  }

  if (options.mode === 'card') {
    const convCount =
      options.conversationCount ?? new Set(nodes.map((n) => n.star.id)).size;
    drawCommemorativeCardBadge(ctx, logicalW, logicalH, nodes.length, convCount, options);
  }

  const filename =
    options.mode === 'wallpaper' ? 'tokenstar-wallpaper-2x.png' : 'tokenstar-card-2x.png';
  const dataUrl = typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : '';
  if (!options.skipDownload) {
    triggerPngDownload(canvas, filename);
  }
  return { dataUrl, filename };
}

const CANVAS_CONTAINER_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  background: '#010205',
  userSelect: 'none',
  touchAction: 'none',
};

const GL_CANVAS_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 0,
  display: 'block',
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
};

const OVERLAY_CANVAS_STYLE: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'block',
  width: '100%',
  height: '100%',
};

const EMPTY_CLUSTERS: SubagentCluster[] = [];

/** Dual-layer GPU WebGL planetarium & HiDPI astrometric constellation canvas. */
export function StarCanvas({
  nodes,
  matchingIds,
  hasActiveFilter,
  selectedStarId,
  hoveredStarId,
  highlightDate,
  playbackVisibleCount,
  cameraRequest,
  privacyMode = false,
  showGrid = true,
  showConstellations = true,
  showNebulae = true,
  clusters = EMPTY_CLUSTERS,
  expandedClusterIds,
  expandAllSubagents = false,
  collapseAllSignal = 0,
  matchingClusterIds = null,
  hoveredClusterId = null,
  selectedClusterId = null,
  onCameraChange,
  onViewportSizeChange,
  onHoverStar,
  onSelectStar,
  onHoverCluster,
  onSelectCluster,
  onZoomOutCollapse,
  onResetView,
}: StarCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const glRendererRef = useRef<WebGLSkyRenderer | null>(null);
  const dustRef = useRef<DustStar[]>(generateBackgroundDust(DEFAULT_DUST_COUNT));
  const backdropCacheRef = useRef<{
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    dpr: number;
  } | null>(null);

  const viewportRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const cameraRef = useRef<CameraState>({ x: 0, y: 0, zoom: 1 });
  const targetCameraRef = useRef<CameraState | null>(null);
  const wheelAnchorRef = useRef<{ wx: number; wy: number; sx: number; sy: number } | null>(null);
  const defaultFitZoomRef = useRef<number>(1);
  const lerpRateRef = useRef<number>(DEFAULT_CAMERA_LERP_RATE);
  const hasInitializedCameraRef = useRef<boolean>(false);

  const dragRef = useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    lastTime: number;
    vx: number;
    vy: number;
    moved: boolean;
  }>({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastTime: 0,
    vx: 0,
    vy: 0,
    moved: false,
  });

  const inertiaRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });
  const revealedAtRef = useRef<Map<string, number>>(new Map());
  const prevPlaybackCountRef = useRef<number | null>(null);
  const autoExpandedRef = useRef<Set<string>>(new Set());
  const suppressedAutoExpandRef = useRef<Set<string>>(new Set());
  const prevExpandedIdsRef = useRef<Set<string>>(new Set());
  const prevCollapseSignalRef = useRef<number>(collapseAllSignal ?? 0);
  const clusterAnimRef = useRef<Map<string, number>>(new Map());

  // Precompute Prim's MST constellation graph & world-space cluster nebulae once when `nodes` change
  const allSegments = useMemo(() => buildConstellationSegments(nodes), [nodes]);
  const clusterNebulae = useMemo(() => buildClusterNebulae(nodes), [nodes]);
  const clusterById = useMemo(
    () => new Map(clusters.map((c) => [c.id, c])),
    [clusters],
  );
  const nodeById = useMemo(
    () => new Map(nodes.map((n) => [n.id, n])),
    [nodes],
  );

  // Pre-parse static per-star properties once when `nodes` change for fast per-frame WebGL batching
  const preparedRenderMeta = useMemo(
    () =>
      nodes.map((node) => {
        const h = fnv1a32(node.id);
        const [r, g, b] = hexToRgbNorm(node.color);
        return {
          r,
          g,
          b,
          typeId: celestialTypeToId(node.request.celestial_type),
          seed: (h & 0xffff) / 0xffff,
          tailAngle: COMET_TAIL_ANGLE + (((h & 0xff) / 255) - 0.5) * 0.24,
        };
      }),
    [nodes],
  );

  // Latest props ref for smooth 60fps requestAnimationFrame loop without re-binding listeners
  const stateRef = useRef({
    nodes,
    nodeById,
    allSegments,
    clusterNebulae,
    preparedRenderMeta,
    clusters,
    clusterById,
    expandedClusterIds,
    expandAllSubagents,
    matchingClusterIds,
    hoveredClusterId,
    selectedClusterId,
    matchingIds,
    hasActiveFilter,
    selectedStarId,
    hoveredStarId,
    highlightDate,
    playbackVisibleCount,
    privacyMode,
    showGrid,
    showConstellations,
    showNebulae,
    onCameraChange,
    onHoverStar,
    onSelectStar,
    onHoverCluster,
    onSelectCluster,
    onZoomOutCollapse,
    onResetView,
  });
  stateRef.current = {
    nodes,
    nodeById,
    allSegments,
    clusterNebulae,
    preparedRenderMeta,
    clusters,
    clusterById,
    expandedClusterIds,
    expandAllSubagents,
    matchingClusterIds,
    hoveredClusterId,
    selectedClusterId,
    matchingIds,
    hasActiveFilter,
    selectedStarId,
    hoveredStarId,
    highlightDate,
    playbackVisibleCount,
    privacyMode,
    showGrid,
    showConstellations,
    showNebulae,
    onCameraChange,
    onHoverStar,
    onSelectStar,
    onHoverCluster,
    onSelectCluster,
    onZoomOutCollapse,
    onResetView,
  };

  // Sync manual cluster expand/collapse with close-zoom auto-LOD suppression
  useEffect(() => {
    const nextExpanded = expandedClusterIds ?? new Set<string>();
    const prevExpanded = prevExpandedIdsRef.current;

    for (const id of prevExpanded) {
      if (!nextExpanded.has(id)) {
        autoExpandedRef.current.delete(id);
        if (cameraRef.current.zoom >= AUTO_EXPAND_ZOOM) {
          suppressedAutoExpandRef.current.add(id);
        }
      }
    }

    for (const id of nextExpanded) {
      if (!prevExpanded.has(id)) {
        suppressedAutoExpandRef.current.delete(id);
      }
    }

    prevExpandedIdsRef.current = new Set(nextExpanded);
  }, [expandedClusterIds]);

  useEffect(() => {
    if (expandAllSubagents) {
      suppressedAutoExpandRef.current.clear();
    }
  }, [expandAllSubagents]);

  useEffect(() => {
    if (collapseAllSignal > prevCollapseSignalRef.current) {
      prevCollapseSignalRef.current = collapseAllSignal;
      autoExpandedRef.current.clear();
      if (cameraRef.current.zoom >= AUTO_EXPAND_ZOOM) {
        for (const c of clusters) {
          suppressedAutoExpandRef.current.add(c.id);
        }
      }
    }
  }, [collapseAllSignal, clusters]);

  // Track playback reveal timestamps per request node for entry shimmer
  useEffect(() => {
    if (playbackVisibleCount === null) {
      revealedAtRef.current.clear();
      prevPlaybackCountRef.current = null;
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = prevPlaybackCountRef.current ?? 0;
    const limit = clamp(Math.floor(playbackVisibleCount), 0, nodes.length);
    const jumped = limit - prev > 3;

    for (let i = limit; i < nodes.length; i += 1) {
      revealedAtRef.current.delete(nodes[i].id);
    }

    for (let i = 0; i < limit; i += 1) {
      const id = nodes[i].id;
      if (!revealedAtRef.current.has(id)) {
        const stamp = jumped && i < limit - 2 ? now - 2000 : now;
        revealedAtRef.current.set(id, stamp);
      }
    }
    prevPlaybackCountRef.current = limit;
  }, [nodes, playbackVisibleCount]);

  // Apply external camera requests (focus star, highlight date, focus search, reset view)
  useEffect(() => {
    if (!cameraRequest) return;
    hasInitializedCameraRef.current = true;
    wheelAnchorRef.current = null;
    inertiaRef.current = { vx: 0, vy: 0 };
    lerpRateRef.current = DEFAULT_CAMERA_LERP_RATE;
    targetCameraRef.current = { ...cameraRequest.camera };
  }, [cameraRequest]);

  // Fit camera automatically once when initial stars first arrive, and keep defaultFitZoomRef fresh
  useEffect(() => {
    if (nodes.length === 0) return;
    const { width, height } = viewportRef.current;
    if (width > 0 && height > 0) {
      const fit = computeFitCamera(nodes, width, height);
      defaultFitZoomRef.current = fit.zoom;
      if (!hasInitializedCameraRef.current) {
        wheelAnchorRef.current = null;
        // Cinematic opening dolly-in from a wider vantage point
        cameraRef.current = { x: fit.x, y: fit.y, zoom: Math.max(MIN_ZOOM, fit.zoom * 0.58) };
        targetCameraRef.current = fit;
        lerpRateRef.current = INTRO_DOLLY_RATE;
        inertiaRef.current = { vx: 0, vy: 0 };
        hasInitializedCameraRef.current = true;
        onCameraChange?.(fit);
      }
    }
  }, [nodes, onCameraChange]);

  // Dual-canvas lifecycle, WebGL init/fallback, ResizeObserver & 60fps loop
  useEffect(() => {
    const container = containerRef.current;
    const glCanvas = glCanvasRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    if (glCanvas) {
      glRendererRef.current = WebGLSkyRenderer.create(glCanvas);
    }

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      glRendererRef.current?.dispose();
      glRendererRef.current = null;
    };
    const handleContextRestored = () => {
      if (glCanvas) {
        glRendererRef.current = WebGLSkyRenderer.create(glCanvas);
      }
    };

    if (glCanvas) {
      glCanvas.addEventListener('webglcontextlost', handleContextLost);
      glCanvas.addEventListener('webglcontextrestored', handleContextRestored);
    }

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (width === viewportRef.current.width && height === viewportRef.current.height) {
        return;
      }
      viewportRef.current = { width, height };
      onViewportSizeChange?.({ width, height });

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const pxW = Math.max(1, Math.floor(width * dpr));
      const pxH = Math.max(1, Math.floor(height * dpr));
      canvas.width = pxW;
      canvas.height = pxH;
      if (glCanvas) {
        glCanvas.width = pxW;
        glCanvas.height = pxH;
      }

      if (stateRef.current.nodes.length > 0 && width > 1 && height > 1) {
        const fit = computeFitCamera(stateRef.current.nodes, width, height);
        defaultFitZoomRef.current = fit.zoom;
        if (!hasInitializedCameraRef.current) {
          wheelAnchorRef.current = null;
          cameraRef.current = { x: fit.x, y: fit.y, zoom: Math.max(MIN_ZOOM, fit.zoom * 0.58) };
          targetCameraRef.current = fit;
          lerpRateRef.current = INTRO_DOLLY_RATE;
          hasInitializedCameraRef.current = true;
          stateRef.current.onCameraChange?.(fit);
        }
      }
    };

    updateSize();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateSize);
      observer.observe(container);
    } else {
      window.addEventListener('resize', updateSize);
    }

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { width, height } = viewportRef.current;
      if (width <= 0 || height <= 0) return;

      const normDelta =
        e.deltaMode === 1
          ? e.deltaY * 16
          : e.deltaMode === 2
            ? e.deltaY * 480
            : e.deltaY;
      const baseZoom = targetCameraRef.current?.zoom ?? cameraRef.current.zoom;
      const factor = Math.exp(-normDelta * 0.0012);
      const targetZoom = clamp(baseZoom * factor, MIN_ZOOM, MAX_ZOOM);

      const cur = cameraRef.current;
      const wx = cur.x + (sx - width / 2) / cur.zoom;
      const wy = cur.y + (sy - height / 2) / cur.zoom;

      wheelAnchorRef.current = { wx, wy, sx, sy };
      lerpRateRef.current = WHEEL_ZOOM_LERP_RATE;
      inertiaRef.current = { vx: 0, vy: 0 };
      targetCameraRef.current = {
        x: wx - (sx - width / 2) / targetZoom,
        y: wy - (sy - height / 2) / targetZoom,
        zoom: targetZoom,
      };

      if (normDelta > 0 && targetZoom < AUTO_COLLAPSE_ZOOM) {
        autoExpandedRef.current.clear();
        suppressedAutoExpandRef.current.clear();
        stateRef.current.onZoomOutCollapse?.();
      } else if (normDelta < 0 && targetZoom >= AUTO_EXPAND_ZOOM) {
        suppressedAutoExpandRef.current.clear();
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });

    let rafId = 0;
    let lastFrameTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const introStartMs = lastFrameTime;
    const renderableScratch: RenderableStar[] = [];

    const renderFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
      lastFrameTime = now;

      // Smoothly interpolate camera toward requested target (in log zoom space) or apply inertial pan glide
      const target = targetCameraRef.current;
      if (target) {
        const cam = cameraRef.current;
        const { width: viewW, height: viewH } = viewportRef.current;
        const lerp = 1 - Math.exp(-dt * lerpRateRef.current);
        const logZoom = Math.log(Math.max(MIN_ZOOM, cam.zoom));
        const targetLogZoom = Math.log(Math.max(MIN_ZOOM, target.zoom));
        const nzoom = Math.exp(logZoom + (targetLogZoom - logZoom) * lerp);
        const anchor = wheelAnchorRef.current;
        const nx = anchor
          ? anchor.wx - (anchor.sx - viewW / 2) / nzoom
          : cam.x + (target.x - cam.x) * lerp;
        const ny = anchor
          ? anchor.wy - (anchor.sy - viewH / 2) / nzoom
          : cam.y + (target.y - cam.y) * lerp;
        if (
          Math.abs(target.x - nx) < 0.35 &&
          Math.abs(target.y - ny) < 0.35 &&
          Math.abs(Math.log(Math.max(MIN_ZOOM, target.zoom) / Math.max(MIN_ZOOM, nzoom))) < 0.002
        ) {
          cameraRef.current = { ...target };
          targetCameraRef.current = null;
          wheelAnchorRef.current = null;
        } else {
          cameraRef.current = { x: nx, y: ny, zoom: nzoom };
        }
        stateRef.current.onCameraChange?.(cameraRef.current);
      } else if (!dragRef.current.active) {
        const vel = inertiaRef.current;
        if (Math.hypot(vel.vx, vel.vy) > 4) {
          const cam = cameraRef.current;
          cameraRef.current = {
            x: cam.x + vel.vx * dt,
            y: cam.y + vel.vy * dt,
            zoom: cam.zoom,
          };
          const damp = Math.exp(-dt * 6.5);
          vel.vx *= damp;
          vel.vy *= damp;
          stateRef.current.onCameraChange?.(cameraRef.current);
        } else {
          vel.vx = 0;
          vel.vy = 0;
        }
      }

      const { width, height } = viewportRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx && width > 0 && height > 0) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const cam = cameraRef.current;
        const tSec = now / 1000;

        const {
          nodes: currNodes,
          nodeById: currNodeById,
          allSegments: currSegments,
          clusterNebulae: currNebulae,
          preparedRenderMeta: currMeta,
          clusters: currClusters,
          clusterById: currClusterById,
          expandedClusterIds: currExpandedIds,
          expandAllSubagents: currExpandAll,
          matchingClusterIds: currMatchingClusters,
          hoveredClusterId: currHoveredClusterId,
          selectedClusterId: currSelectedClusterId,
          matchingIds: currMatching,
          hasActiveFilter: currFiltered,
          selectedStarId: currSelectedId,
          hoveredStarId: currHoveredId,
          highlightDate: currHighlightDate,
          playbackVisibleCount: currPlaybackCount,
          privacyMode: currPrivacy,
          showGrid: currShowGrid,
          showConstellations: currShowConstellations,
          showNebulae: currShowNebulae,
        } = stateRef.current;

        const visibleLimit =
          currPlaybackCount !== null
            ? clamp(Math.floor(currPlaybackCount), 0, currNodes.length)
            : currNodes.length;

        // Close-zoom auto-LOD hysteresis & smooth per-cluster collapse/expand animation
        if (currClusters.length > 0) {
          const validClusterIds = new Set<string>();
          const zoomingOutToCollapse =
            targetCameraRef.current !== null && targetCameraRef.current.zoom < AUTO_COLLAPSE_ZOOM;
          for (const c of currClusters) {
            validClusterIds.add(c.id);
            const anchorScreen = worldToScreen(c.anchorX, c.anchorY, cam, width, height);
            const inExpandBounds =
              anchorScreen.x >= -80 &&
              anchorScreen.x <= width + 80 &&
              anchorScreen.y >= -80 &&
              anchorScreen.y <= height + 80;
            const outCollapseBounds =
              anchorScreen.x < -160 ||
              anchorScreen.x > width + 160 ||
              anchorScreen.y < -160 ||
              anchorScreen.y > height + 160;

            if (cam.zoom >= AUTO_EXPAND_ZOOM && inExpandBounds && !zoomingOutToCollapse) {
              if (!suppressedAutoExpandRef.current.has(c.id)) {
                autoExpandedRef.current.add(c.id);
              }
            } else if (cam.zoom < AUTO_COLLAPSE_ZOOM || outCollapseBounds) {
              autoExpandedRef.current.delete(c.id);
              suppressedAutoExpandRef.current.delete(c.id);
            }
          }
          for (const id of Array.from(autoExpandedRef.current)) {
            if (!validClusterIds.has(id)) autoExpandedRef.current.delete(id);
          }
          for (const id of Array.from(suppressedAutoExpandRef.current)) {
            if (!validClusterIds.has(id)) suppressedAutoExpandRef.current.delete(id);
          }
          for (const id of Array.from(clusterAnimRef.current.keys())) {
            if (!validClusterIds.has(id)) clusterAnimRef.current.delete(id);
          }

          const effectiveExpanded = getEffectiveExpandedSet(
            currClusters,
            currExpandAll,
            currExpandedIds,
            autoExpandedRef.current,
          );
          const animLerp = 1 - Math.exp(-dt * 9);
          for (const c of currClusters) {
            const targetP = effectiveExpanded.has(c.id) ? 1 : 0;
            const prevP = clusterAnimRef.current.get(c.id) ?? targetP;
            let nextP = prevP + (targetP - prevP) * animLerp;
            if (Math.abs(targetP - nextP) < 0.004) {
              nextP = targetP;
            }
            clusterAnimRef.current.set(c.id, nextP);
          }
        } else {
          autoExpandedRef.current.clear();
          suppressedAutoExpandRef.current.clear();
          clusterAnimRef.current.clear();
        }

        const highlightedDates = new Set<string>();
        if (currHighlightDate) highlightedDates.add(currHighlightDate);

        const activeConvIds = new Set<string>();
        const activeClusterIds = new Set<string>();
        if (currHoveredClusterId) activeClusterIds.add(currHoveredClusterId);
        if (currSelectedClusterId) activeClusterIds.add(currSelectedClusterId);

        for (let i = 0; i < visibleLimit; i += 1) {
          const n = currNodes[i];
          if (n.id === currHoveredId || n.id === currSelectedId) {
            activeConvIds.add(n.star.id);
            if (n.subagentClusterId) {
              activeClusterIds.add(n.subagentClusterId);
            }
          }
        }
        for (const c of currClusters) {
          if (c.firstNodeIndex >= visibleLimit) continue;
          if (c.id === currHoveredClusterId || c.id === currSelectedClusterId) {
            activeConvIds.add(c.conversationId);
          }
        }

        const visualScale = getVisualScale(cam.zoom);
        const deepOut = computeDeepOut(cam.zoom, defaultFitZoomRef.current);
        const deepSrScale = 1 - deepOut * 0.44;
        const glRenderer = glRendererRef.current;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const introElapsed = Math.max(0, (now - introStartMs) / 1000);
        const webglIntro = clamp(introElapsed / 4.2, 0, 1);

        if (glRenderer) {
          // GPU path: clear transparent 2D overlay canvas, render WebGL backdrop & animated optics below
          ctx.clearRect(0, 0, width, height);

          renderableScratch.length = 0;
          for (let i = 0; i < visibleLimit; i += 1) {
            const node = currNodes[i];
            let wx = node.x;
            let wy = node.y;
            let srScale = 1;
            let clusterAlpha = 1;
            if (node.subagentClusterId && currClusterById.has(node.subagentClusterId)) {
              const cluster = currClusterById.get(node.subagentClusterId)!;
              const animP = clusterAnimRef.current.get(cluster.id) ?? 0;
              if (animP <= 0.02) {
                continue;
              }
              wx = cluster.anchorX + (node.x - cluster.anchorX) * animP;
              wy = cluster.anchorY + (node.y - cluster.anchorY) * animP;
              srScale = 0.62;
              clusterAlpha = animP;
            }

            const pos = worldToScreen(wx, wy, cam, width, height);
            const sr = Math.max(0.72, node.radius * visualScale * srScale * deepSrScale);
            if (pos.x + sr * 10 < 0 || pos.x - sr * 10 > width || pos.y + sr * 10 < 0 || pos.y - sr * 10 > height) {
              continue;
            }
            const meta = currMeta[i];
            const isSelected = node.id === currSelectedId;
            const isHovered = node.id === currHoveredId;
            const isInActiveConv = activeConvIds.has(node.star.id);
            const isDateHighlighted = Boolean(
              currHighlightDate &&
                (node.request.local_date || node.star.local_date) === currHighlightDate,
            );
            const isMatch = !currFiltered || !currMatching || currMatching.has(node.id);
            const baseAlpha = isDateHighlighted || isInActiveConv ? (isMatch ? 1 : 0.25) : isMatch ? 1 : 0.16;
            const alpha = baseAlpha * clusterAlpha;

            let shimmer = 0;
            if (currPlaybackCount !== null) {
              const stamped = revealedAtRef.current.get(node.id);
              if (typeof stamped === 'number') {
                const ageMs = now - stamped;
                if (ageMs >= 0 && ageMs < 800) {
                  shimmer = clamp(ageMs / 800, 0, 1);
                }
              }
            }

            const emp = isSelected || isHovered || isInActiveConv || isDateHighlighted ? 1 : 0;
            renderableScratch.push({
              wx,
              wy,
              sr: sr * (1 + (shimmer > 0 ? (1 - shimmer) * 0.35 : 0)),
              magnitude: node.magnitude,
              typeId: meta.typeId,
              r: meta.r,
              g: meta.g,
              b: meta.b,
              alpha,
              emphasized: emp,
              shimmer,
              seed: meta.seed,
              tailAngle: meta.tailAngle,
            });
          }

          glRenderer.render({
            width,
            height,
            dpr,
            camera: cam,
            referenceZoom: defaultFitZoomRef.current,
            timeSec: tSec,
            stars: renderableScratch,
            nebulae: currShowNebulae ? currNebulae : [],
            intro: webglIntro,
          });
        } else {
          // 2D fallback backdrop (for JSDOM or disabled WebGL)
          let backdrop = backdropCacheRef.current;
          if (
            !backdrop ||
            backdrop.width !== width ||
            backdrop.height !== height ||
            backdrop.dpr !== dpr
          ) {
            const off = document.createElement('canvas');
            off.width = Math.max(1, Math.floor(width * dpr));
            off.height = Math.max(1, Math.floor(height * dpr));
            const octx = off.getContext('2d');
            if (octx) {
              octx.setTransform(dpr, 0, 0, dpr, 0, 0);
              drawBackdrop2D(octx, width, height, dustRef.current);
              backdrop = { canvas: off, width, height, dpr };
              backdropCacheRef.current = backdrop;
            }
          }

          if (backdrop) {
            ctx.drawImage(backdrop.canvas, 0, 0, width, height);
          } else {
            drawBackdrop2D(ctx, width, height, dustRef.current);
          }

          if (currShowNebulae) {
            drawNebulae2D(ctx, currNebulae, cam, width, height);
          }
        }

        // Top HiDPI Vector Astrometric Layer (grid fades in, constellations trace themselves in)
        const gridIntro = smoothstep01((introElapsed - 1.4) / 1.8);
        const lineReveal = clamp((introElapsed - 2.2) / 2.4, 0, 1);

        if (currShowGrid && gridIntro > 0) {
          ctx.save();
          ctx.globalAlpha = gridIntro;
          drawEquatorialGraticule(ctx, cam, width, height, true);
          ctx.restore();
        }

        drawConstellationLayer(
          ctx,
          currNodes,
          currSegments,
          cam,
          width,
          height,
          currMatching,
          currFiltered,
          activeConvIds,
          highlightedDates,
          currPlaybackCount,
          tSec,
          currPrivacy,
          !glRenderer,
          currShowConstellations,
          lineReveal,
          currClusters,
          currClusterById,
          clusterAnimRef.current,
          activeClusterIds,
        );

        if (currShowConstellations && currClusters.length > 0) {
          drawSubagentTidalBridges(
            ctx,
            currNodeById,
            currClusters,
            currClusterById,
            clusterAnimRef.current,
            cam,
            width,
            height,
            currPlaybackCount,
            currNodes.length,
            currMatching,
            currMatchingClusters,
            currFiltered,
            activeConvIds,
            activeClusterIds,
            currSelectedId,
            currHoveredId,
            highlightedDates,
            tSec,
            lineReveal,
          );
        }

        if (glRenderer) {
          punchOutOverlayAroundStars(
            ctx,
            currNodes,
            visibleLimit,
            currClusterById,
            clusterAnimRef.current,
            cam,
            width,
            height,
            deepSrScale,
          );
        }

        if (currClusters.length > 0) {
          drawExpandedCompanionNebulae(
            ctx,
            currClusters,
            clusterAnimRef.current,
            cam,
            width,
            height,
            currPlaybackCount,
            currNodes.length,
            currFiltered,
            currMatchingClusters,
            activeConvIds,
            activeClusterIds,
            webglIntro,
          );
        }

        drawActiveConversationAura(
          ctx,
          currNodes,
          visibleLimit,
          cam,
          width,
          height,
          activeConvIds,
          tSec,
        );

        if (currClusters.length > 0) {
          drawCollapsedGlobularClusters(
            ctx,
            currClusters,
            clusterAnimRef.current,
            cam,
            width,
            height,
            currPlaybackCount,
            currNodes.length,
            currFiltered,
            currMatchingClusters,
            currHoveredClusterId,
            currSelectedClusterId,
            currSelectedId,
            currHoveredId,
            currHighlightDate,
            tSec,
            webglIntro,
            deepOut,
          );
        }

        if (glRenderer) {
          drawActiveConversationCaptions(
            ctx,
            currNodes,
            visibleLimit,
            cam,
            width,
            height,
            activeConvIds,
            currPrivacy,
          );
        }

        // Draw date halo + reticle on top, plus 2D fallback bodies when WebGL is inactive
        for (let i = 0; i < visibleLimit; i += 1) {
          const node = currNodes[i];
          let wx = node.x;
          let wy = node.y;
          let srScale = 1;
          let clusterAlpha = 1;
          if (node.subagentClusterId && currClusterById.has(node.subagentClusterId)) {
            const cluster = currClusterById.get(node.subagentClusterId)!;
            const animP = clusterAnimRef.current.get(cluster.id) ?? 0;
            if (animP <= 0.02) {
              continue;
            }
            wx = cluster.anchorX + (node.x - cluster.anchorX) * animP;
            wy = cluster.anchorY + (node.y - cluster.anchorY) * animP;
            srScale = 0.62;
            clusterAlpha = animP;
          }

          const pos = worldToScreen(wx, wy, cam, width, height);
          const sr = node.radius * visualScale * srScale;
          if (pos.x + sr * 8 < 0 || pos.x - sr * 8 > width || pos.y + sr * 8 < 0 || pos.y - sr * 8 > height) {
            continue;
          }

          const isSelected = node.id === currSelectedId;
          const isHovered = node.id === currHoveredId;
          const isInActiveConv = activeConvIds.has(node.star.id);
          const isDateHighlighted = Boolean(
            currHighlightDate &&
              (node.request.local_date || node.star.local_date) === currHighlightDate,
          );
          const isMatch = !currFiltered || !currMatching || currMatching.has(node.id);
          const baseAlpha = isDateHighlighted || isInActiveConv ? (isMatch ? 1 : 0.25) : isMatch ? 1 : 0.16;
          const alpha = baseAlpha * clusterAlpha;

          if (!glRenderer) {
            drawCelestialBody2D(
              ctx,
              node,
              pos.x,
              pos.y,
              sr,
              alpha,
              tSec,
              isSelected || isHovered || isInActiveConv || isDateHighlighted,
              cam.zoom,
            );
          }

          if (isSelected || isHovered) {
            drawSelectionReticle(ctx, pos.x, pos.y, sr, isSelected, tSec);
          }
        }
      }

      if (typeof requestAnimationFrame !== 'undefined') {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      rafId = requestAnimationFrame(renderFrame);
    }

    return () => {
      if (typeof cancelAnimationFrame !== 'undefined' && rafId) {
        cancelAnimationFrame(rafId);
      }
      canvas.removeEventListener('wheel', handleWheel);
      if (glCanvas) {
        glCanvas.removeEventListener('webglcontextlost', handleContextLost);
        glCanvas.removeEventListener('webglcontextrestored', handleContextRestored);
      }
      glRendererRef.current?.dispose();
      glRendererRef.current = null;
      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', updateSize);
      }
    };
  }, [onViewportSizeChange]);

  const getPointerCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { sx: 0, sy: 0 };
    const rect = canvas.getBoundingClientRect();
    return { sx: clientX - rect.left, sy: clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    targetCameraRef.current = null;
    wheelAnchorRef.current = null;
    inertiaRef.current = { vx: 0, vy: 0 };
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    dragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lastTime: now,
      vx: 0,
      vy: 0,
      moved: false,
    };
    e.currentTarget.style.cursor = 'grabbing';
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in synthetic test environments
      }
    }
  };

  const hitTestAtScreenPos = (sx: number, sy: number, width: number, height: number) => {
    const effectiveExpanded = getEffectiveExpandedSet(
      clusters,
      expandAllSubagents,
      expandedClusterIds,
      autoExpandedRef.current,
    );
    const hitTestableNodes = getHitTestableNodes(
      nodes,
      clusterById,
      effectiveExpanded,
      playbackVisibleCount,
    );
    const hitStar = hitTestStar(
      hitTestableNodes,
      sx,
      sy,
      cameraRef.current,
      width,
      height,
      undefined,
      hasActiveFilter ? matchingIds : null,
    );
    if (hitStar) {
      return { star: hitStar, cluster: null };
    }
    const hitCluster =
      clusters.length > 0
        ? hitTestCluster(
            clusters,
            effectiveExpanded,
            sx,
            sy,
            cameraRef.current,
            width,
            height,
            playbackVisibleCount ?? undefined,
            hasActiveFilter ? matchingClusterIds : null,
          )
        : null;
    return { star: null, cluster: hitCluster };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.active && drag.pointerId === e.pointerId) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      const dt = Math.max(0.004, (now - drag.lastTime) / 1000);
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) {
        drag.moved = true;
      }
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.lastTime = now;
      if (drag.moved) {
        const prev = cameraRef.current;
        const worldDx = -dx / prev.zoom;
        const worldDy = -dy / prev.zoom;
        drag.vx = drag.vx * 0.4 + (worldDx / dt) * 0.6;
        drag.vy = drag.vy * 0.4 + (worldDy / dt) * 0.6;

        const next: CameraState = {
          x: prev.x + worldDx,
          y: prev.y + worldDy,
          zoom: prev.zoom,
        };
        cameraRef.current = next;
        onCameraChange?.(next);
        onHoverStar(null, null);
        onHoverCluster?.(null, null);
        return;
      }
    }

    const { sx, sy } = getPointerCoords(e.clientX, e.clientY);
    const { width, height } = viewportRef.current;
    if (width <= 0 || height <= 0) return;
    const { star, cluster } = hitTestAtScreenPos(sx, sy, width, height);
    if (star) {
      onHoverCluster?.(null, null);
      onHoverStar(star, { x: sx, y: sy });
    } else if (cluster) {
      onHoverStar(null, null);
      onHoverCluster?.(cluster, { x: sx, y: sy });
    } else {
      onHoverStar(null, null);
      onHoverCluster?.(null, null);
    }
  };

  const finishPointerDrag = (e: React.PointerEvent<HTMLCanvasElement>): { wasActive: boolean; vx: number; vy: number } => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== e.pointerId) {
      return { wasActive: false, vx: 0, vy: 0 };
    }
    const vx = drag.vx;
    const vy = drag.vy;
    drag.active = false;
    drag.pointerId = -1;
    drag.moved = false;
    drag.vx = 0;
    drag.vy = 0;
    e.currentTarget.style.cursor = hoveredStarId || hoveredClusterId ? 'pointer' : 'grab';

    if (typeof e.currentTarget.releasePointerCapture === 'function') {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore in synthetic test environments
      }
    }
    return { wasActive: true, vx, vy };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasMoved = dragRef.current.moved;
    const { wasActive, vx, vy } = finishPointerDrag(e);
    if (!wasActive) return;

    if (wasMoved) {
      if (Math.hypot(vx, vy) > 25) {
        inertiaRef.current = { vx, vy };
      }
      return;
    }

    const { sx, sy } = getPointerCoords(e.clientX, e.clientY);
    const { width, height } = viewportRef.current;
    if (width <= 0 || height <= 0) return;
    const { star, cluster } = hitTestAtScreenPos(sx, sy, width, height);
    if (star) {
      if (!star.subagentClusterId) {
        onSelectCluster?.(null);
      }
      onSelectStar(star);
    } else if (cluster) {
      onSelectCluster?.(cluster);
    } else {
      onSelectCluster?.(null);
      onSelectStar(null);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    inertiaRef.current = { vx: 0, vy: 0 };
    finishPointerDrag(e);
  };

  const handlePointerLeave = () => {
    if (!dragRef.current.active) {
      onHoverStar(null, null);
      onHoverCluster?.(null, null);
    }
  };

  return (
    <div ref={containerRef} style={CANVAS_CONTAINER_STYLE}>
      <canvas ref={glCanvasRef} aria-hidden="true" style={GL_CANVAS_STYLE} />
      <canvas
        ref={canvasRef}
        style={{
          ...OVERLAY_CANVAS_STYLE,
          cursor: dragRef.current.active
            ? 'grabbing'
            : hoveredStarId || hoveredClusterId
              ? 'pointer'
              : 'grab',
        }}
        aria-label="TokenStar 交互式星空画布"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={onResetView}
      />
    </div>
  );
}
