import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { CelestialType, TokenMode } from '../../types/sky';
import {
  buildConstellationSegments,
  type ConstellationSegment,
} from '../../logic/constellations';
import { getDisplayTitle } from '../../logic/filters';
import { fnv1a32, type StarNode } from '../../logic/starLayout';
import {
  buildClusterNebulae,
  celestialTypeToId,
  hexToRgbNorm,
  renderWebGLSnapshot,
  WebGLSkyRenderer,
  type RenderableNebula,
  type RenderableStar,
} from './webglSkyRenderer';

export { buildConstellationSegments, type ConstellationSegment };

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
  onCameraChange?: (camera: CameraState) => void;
  onViewportSizeChange?: (size: { width: number; height: number }) => void;
  onHoverStar: (node: StarNode | null, screenPos: { x: number; y: number } | null) => void;
  onSelectStar: (node: StarNode | null) => void;
  onResetView: () => void;
}

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 7.5;
const DEFAULT_CAMERA_LERP_RATE = 8.0;
const INTRO_DOLLY_RATE = 1.35;
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

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function getVisualScale(zoom: number): number {
  return clamp(Math.pow(Math.max(0.08, zoom), 0.52), 0.55, 2.25);
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
  const haloR = sr * (emphasized ? 5.6 : 2.8 + lum * 2.6);
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
): void {
  const limit =
    typeof maxVisibleCount === 'number'
      ? clamp(Math.floor(maxVisibleCount), 0, nodes.length)
      : nodes.length;
  const visualScale = getVisualScale(camera.zoom);

  ctx.save();
  ctx.lineCap = 'round';

  // Soft translucent ambient glow around active hovered/selected conversation bounding circle
  if (showActiveCaption && activeConvIds.size > 0) {
    for (const convId of activeConvIds) {
      let sampleNode: StarNode | null = null;
      for (let i = 0; i < limit; i += 1) {
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
  }

  if (drawLines) {
    for (const seg of allSegments) {
      if (seg.fromIndex >= limit || seg.toIndex >= limit) continue;

      const p1 = worldToScreen(seg.from.x, seg.from.y, camera, width, height);
      const p2 = worldToScreen(seg.to.x, seg.to.y, camera, width, height);

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
      const clipStart = seg.from.radius * visualScale * 2.1 + 3.5;
      const clipEnd = seg.to.radius * visualScale * 2.1 + 3.5;
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
        highlightedDates.has(seg.from.request.local_date) ||
        highlightedDates.has(seg.to.request.local_date) ||
        highlightedDates.has(seg.date);

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
          ctx.strokeStyle = 'rgba(164, 194, 240, 0.12)';
          ctx.lineWidth = 0.65;
        } else if (seg.tier === 'primary') {
          ctx.strokeStyle = 'rgba(192, 218, 255, 0.2)';
          ctx.lineWidth = 0.9;
        } else {
          ctx.strokeStyle = 'rgba(164, 194, 240, 0.11)';
          ctx.lineWidth = 0.65;
        }
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // Non-overlapping astrometric caption anchored above active conversation bounding circle
  if (showActiveCaption && activeConvIds.size > 0) {
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
export function exportSkyPng(nodes: StarNode[], options: SkyExportOptions): void {
  const logicalW = options.width > 0 ? options.width : 1280;
  const logicalH = options.height > 0 ? options.height : 720;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(logicalW * 2);
  canvas.height = Math.round(logicalH * 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(2, 0, 0, 2, 0, 0);

  const showNebulae = options.showNebulae ?? true;
  const glSnap = renderWebGLSnapshot(nodes, logicalW, logicalH, options.camera, 1.2, showNebulae);
  if (glSnap) {
    ctx.drawImage(glSnap, 0, 0, logicalW, logicalH);
  } else {
    const dust = generateBackgroundDust(DEFAULT_DUST_COUNT);
    drawBackdrop2D(ctx, logicalW, logicalH, dust);
    if (showNebulae) {
      drawNebulae2D(ctx, buildClusterNebulae(nodes), options.camera, logicalW, logicalH);
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
    );
  }

  if (!glSnap) {
    const visualScale = getVisualScale(options.camera.zoom);
    for (const node of nodes) {
      const pos = worldToScreen(node.x, node.y, options.camera, logicalW, logicalH);
      const sr = node.radius * visualScale;
      if (pos.x + sr * 8 < 0 || pos.x - sr * 8 > logicalW || pos.y + sr * 8 < 0 || pos.y - sr * 8 > logicalH) {
        continue;
      }
      drawCelestialBody2D(ctx, node, pos.x, pos.y, sr, 1, 0, false);
    }
  }

  if (options.mode === 'card') {
    const convCount =
      options.conversationCount ?? new Set(nodes.map((n) => n.star.id)).size;
    drawCommemorativeCardBadge(ctx, logicalW, logicalH, nodes.length, convCount, options);
  }

  const filename =
    options.mode === 'wallpaper' ? 'tokenstar-wallpaper-2x.png' : 'tokenstar-card-2x.png';
  triggerPngDownload(canvas, filename);
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
  onCameraChange,
  onViewportSizeChange,
  onHoverStar,
  onSelectStar,
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

  // Precompute Prim's MST constellation graph & world-space cluster nebulae once when `nodes` change
  const allSegments = useMemo(() => buildConstellationSegments(nodes), [nodes]);
  const clusterNebulae = useMemo(() => buildClusterNebulae(nodes), [nodes]);

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
    allSegments,
    clusterNebulae,
    preparedRenderMeta,
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
    onResetView,
  });
  stateRef.current = {
    nodes,
    allSegments,
    clusterNebulae,
    preparedRenderMeta,
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
    onResetView,
  };

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
    inertiaRef.current = { vx: 0, vy: 0 };
    lerpRateRef.current = DEFAULT_CAMERA_LERP_RATE;
    targetCameraRef.current = { ...cameraRequest.camera };
  }, [cameraRequest]);

  // Fit camera automatically once when initial stars first arrive
  useEffect(() => {
    if (nodes.length === 0 || hasInitializedCameraRef.current) return;
    const { width, height } = viewportRef.current;
    if (width > 0 && height > 0) {
      const fit = computeFitCamera(nodes, width, height);
      // Cinematic opening dolly-in from a wider vantage point
      cameraRef.current = { x: fit.x, y: fit.y, zoom: Math.max(MIN_ZOOM, fit.zoom * 0.58) };
      targetCameraRef.current = fit;
      lerpRateRef.current = INTRO_DOLLY_RATE;
      inertiaRef.current = { vx: 0, vy: 0 };
      hasInitializedCameraRef.current = true;
      onCameraChange?.(fit);
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

      if (!hasInitializedCameraRef.current && stateRef.current.nodes.length > 0 && width > 1 && height > 1) {
        const fit = computeFitCamera(stateRef.current.nodes, width, height);
        cameraRef.current = { x: fit.x, y: fit.y, zoom: Math.max(MIN_ZOOM, fit.zoom * 0.58) };
        targetCameraRef.current = fit;
        lerpRateRef.current = INTRO_DOLLY_RATE;
        hasInitializedCameraRef.current = true;
        stateRef.current.onCameraChange?.(fit);
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

      targetCameraRef.current = null;
      inertiaRef.current = { vx: 0, vy: 0 };
      const prev = cameraRef.current;
      const factor = Math.exp(-e.deltaY * 0.0012);
      const nextZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const wx = prev.x + (sx - width / 2) / prev.zoom;
      const wy = prev.y + (sy - height / 2) / prev.zoom;

      const nextCam: CameraState = {
        x: wx - (sx - width / 2) / nextZoom,
        y: wy - (sy - height / 2) / nextZoom,
        zoom: nextZoom,
      };
      cameraRef.current = nextCam;
      stateRef.current.onCameraChange?.(nextCam);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });

    let rafId = 0;
    let lastFrameTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const introStartMs = lastFrameTime;
    const renderableScratch: RenderableStar[] = [];

    const renderFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
      lastFrameTime = now;

      // Smoothly interpolate camera toward requested target or apply inertial pan glide
      const target = targetCameraRef.current;
      if (target) {
        const cam = cameraRef.current;
        const lerp = 1 - Math.exp(-dt * lerpRateRef.current);
        const nx = cam.x + (target.x - cam.x) * lerp;
        const ny = cam.y + (target.y - cam.y) * lerp;
        const nzoom = cam.zoom + (target.zoom - cam.zoom) * lerp;
        if (
          Math.abs(target.x - nx) < 0.35 &&
          Math.abs(target.y - ny) < 0.35 &&
          Math.abs(target.zoom - nzoom) < 0.002
        ) {
          cameraRef.current = { ...target };
          targetCameraRef.current = null;
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
          allSegments: currSegments,
          clusterNebulae: currNebulae,
          preparedRenderMeta: currMeta,
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

        const highlightedDates = new Set<string>();
        if (currHighlightDate) highlightedDates.add(currHighlightDate);

        const activeConvIds = new Set<string>();
        for (let i = 0; i < visibleLimit; i += 1) {
          const n = currNodes[i];
          if (n.id === currHoveredId || n.id === currSelectedId) {
            activeConvIds.add(n.star.id);
          }
        }

        const visualScale = getVisualScale(cam.zoom);
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
            const pos = worldToScreen(node.x, node.y, cam, width, height);
            const sr = node.radius * visualScale;
            if (pos.x + sr * 10 < 0 || pos.x - sr * 10 > width || pos.y + sr * 10 < 0 || pos.y - sr * 10 > height) {
              continue;
            }
            const meta = currMeta[i];
            const isSelected = node.id === currSelectedId;
            const isHovered = node.id === currHoveredId;
            const isInActiveConv = activeConvIds.has(node.star.id);
            const isDateHighlighted = Boolean(
              currHighlightDate &&
                (node.request.local_date === currHighlightDate || node.star.local_date === currHighlightDate),
            );
            const isMatch = !currFiltered || !currMatching || currMatching.has(node.id);
            const alpha = isDateHighlighted || isInActiveConv ? (isMatch ? 1 : 0.25) : isMatch ? 1 : 0.16;

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
              wx: node.x,
              wy: node.y,
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
          true,
          currShowConstellations,
          lineReveal,
        );

        // Draw date halo + reticle on top, plus 2D fallback bodies when WebGL is inactive
        for (let i = 0; i < visibleLimit; i += 1) {
          const node = currNodes[i];
          const pos = worldToScreen(node.x, node.y, cam, width, height);
          const sr = node.radius * visualScale;
          if (pos.x + sr * 8 < 0 || pos.x - sr * 8 > width || pos.y + sr * 8 < 0 || pos.y - sr * 8 > height) {
            continue;
          }

          const isSelected = node.id === currSelectedId;
          const isHovered = node.id === currHoveredId;
          const isInActiveConv = activeConvIds.has(node.star.id);
          const isDateHighlighted = Boolean(
            currHighlightDate &&
              (node.request.local_date === currHighlightDate || node.star.local_date === currHighlightDate),
          );
          const isMatch = !currFiltered || !currMatching || currMatching.has(node.id);
          const alpha = isDateHighlighted || isInActiveConv ? (isMatch ? 1 : 0.25) : isMatch ? 1 : 0.16;

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
        return;
      }
    }

    const { sx, sy } = getPointerCoords(e.clientX, e.clientY);
    const { width, height } = viewportRef.current;
    if (width <= 0 || height <= 0) return;
    const hit = hitTestStar(
      nodes,
      sx,
      sy,
      cameraRef.current,
      width,
      height,
      playbackVisibleCount ?? undefined,
      hasActiveFilter ? matchingIds : null,
    );
    onHoverStar(hit, hit ? { x: sx, y: sy } : null);
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
    e.currentTarget.style.cursor = hoveredStarId ? 'pointer' : 'grab';

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
    const hit = hitTestStar(
      nodes,
      sx,
      sy,
      cameraRef.current,
      width,
      height,
      playbackVisibleCount ?? undefined,
      hasActiveFilter ? matchingIds : null,
    );
    onSelectStar(hit);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    inertiaRef.current = { vx: 0, vy: 0 };
    finishPointerDrag(e);
  };

  const handlePointerLeave = () => {
    if (!dragRef.current.active) {
      onHoverStar(null, null);
    }
  };

  return (
    <div ref={containerRef} style={CANVAS_CONTAINER_STYLE}>
      <canvas ref={glCanvasRef} aria-hidden="true" style={GL_CANVAS_STYLE} />
      <canvas
        ref={canvasRef}
        style={{
          ...OVERLAY_CANVAS_STYLE,
          cursor: dragRef.current.active ? 'grabbing' : hoveredStarId ? 'pointer' : 'grab',
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
