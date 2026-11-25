import type { ConversationStar, RequestStar, TokenMode } from '../types/sky';

export interface StarNode {
  id: string;
  request: RequestStar;
  star: ConversationStar;
  index: number;
  convIndex: number;
  requestIndexInConv: number;
  convRequestCount: number;
  x: number;
  y: number;
  yOffset: number;
  convCenterX: number;
  convCenterY: number;
  convRadius: number;
  magnitude: number;
  radius: number;
  color: string;
  effectiveTokens: number;
}

// Real Morgan-Keenan O-B-A-F-G-K-M stellar blackbody stops (30,000K O-blue to 3,100K M-crimson)
const STELLAR_BLACKBODY_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0x68, 0xa4, 0xff], // O-type sapphire blue (~30,000K)
  [0x94, 0xc4, 0xff], // B-type luminous blue-white (~15,000K)
  [0xdc, 0xeb, 0xff], // A-type ice pearl-white (~9,000K)
  [0xff, 0xf5, 0xde], // F-type ivory white (~6,800K)
  [0xff, 0xdc, 0x84], // G-type solar gold (~5,600K)
  [0xff, 0xa6, 0x54], // K-type amber orange (~4,200K)
  [0xff, 0x6e, 0x46], // M-type deep coral red (~3,100K)
];
const FALLBACK_SPECTRAL_COLORS = [
  '#78b2ff',
  '#ffdc84',
  '#ffa458',
  '#98c8ff',
  '#ff744c',
  '#fff3d6',
  '#8de2ec',
] as const;
const MIN_MAGNITUDE = 0.12;
const MAX_MAGNITUDE = 1.0;
// Optical PSF core radii widened so token differences read clearly across the sky
const MIN_RADIUS = 0.9;
const MAX_RADIUS = 5.4;
const GALACTIC_TILT_RAD = (-12 * Math.PI) / 180;

export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sampleBlackbodyHex(t: number): string {
  const safeT = clamp(Number.isFinite(t) ? t : 0.5, 0, 1);
  const maxIdx = STELLAR_BLACKBODY_STOPS.length - 1;
  const scaled = safeT * maxIdx;
  const i0 = Math.min(maxIdx - 1, Math.floor(scaled));
  const f = scaled - i0;
  const c0 = STELLAR_BLACKBODY_STOPS[i0];
  const c1 = STELLAR_BLACKBODY_STOPS[i0 + 1];
  const toHex = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${toHex(c0[0] + (c1[0] - c0[0]) * f)}${toHex(c0[1] + (c1[1] - c0[1]) * f)}${toHex(c0[2] + (c1[2] - c0[2]) * f)}`;
}

export function computeMagnitude(tokens: number): number {
  const safeTokens = Number.isFinite(tokens) ? Math.max(tokens, 500) : 500;
  const raw = (Math.log10(safeTokens) - 3.0) / 3.0;
  return Math.min(MAX_MAGNITUDE, Math.max(MIN_MAGNITUDE, raw));
}

export function getModelSpectralColor(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') {
    return '#ffdb8a';
  }
  if (
    normalized.includes('flash-lite') ||
    normalized.includes('flash_lite') ||
    normalized.includes('flash lite')
  ) {
    // Class A pearl-white (~9,000K)
    return '#dcebff';
  }
  if (normalized.includes('flash')) {
    if (
      normalized.includes('2.0') ||
      normalized.includes('thinking') ||
      normalized.includes('exp')
    ) {
      // Hot ionized cyan-white (~13,500K)
      return '#8de2ec';
    }
    // Class F warm ivory (~6,800K)
    return '#fff3d6';
  }
  if (normalized.includes('neon')) {
    // Class G/K golden amber (~5,200K)
    return '#ffce73';
  }
  if (normalized.includes('hydrogen')) {
    // Class O/B sapphire blue (~22,000K)
    return '#78b2ff';
  }
  if (normalized.includes('opus') || normalized.includes('claude')) {
    // Class K warm amber-orange giant (~4,100K)
    return '#ffa054';
  }
  if (normalized.includes('pro') || normalized.includes('ultra')) {
    // Class B luminous blue-white (~15,000K)
    return '#92c2ff';
  }
  const idx = fnv1a32(normalized) % FALLBACK_SPECTRAL_COLORS.length;
  return FALLBACK_SPECTRAL_COLORS[idx];
}

function getModelBlackbodyAnchor(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('hydrogen')) return 0.1;
  if (normalized.includes('pro') || normalized.includes('ultra')) return 0.2;
  if (
    normalized.includes('flash-lite') ||
    normalized.includes('flash_lite') ||
    normalized.includes('flash lite')
  ) {
    return 0.33;
  }
  if (normalized.includes('flash')) {
    if (
      normalized.includes('2.0') ||
      normalized.includes('thinking') ||
      normalized.includes('exp')
    ) {
      return 0.18;
    }
    return 0.48;
  }
  if (normalized.includes('neon')) return 0.66;
  if (normalized.includes('opus') || normalized.includes('claude')) return 0.83;
  const h = fnv1a32(normalized || 'unknown');
  return 0.08 + ((h % 100) / 99) * 0.84;
}

/**
 * Assign each individual star a realistic H-R blackbody temperature anchored
 * around its model's spectral band while spanning vivid O-B-A-F-G-K-M diversity.
 */
export function computeStarSpectralColor(
  model: string,
  starId: string,
  magnitude: number,
): string {
  const anchor = getModelBlackbodyAnchor(model);
  const rand = mulberry32(fnv1a32(`${starId}:spec`));
  const branch = rand();
  let t: number;
  if (branch < 0.55) {
    t = clamp(anchor + (rand() - 0.5) * 0.44, 0.02, 0.98);
  } else if (magnitude >= 0.72) {
    // Luminous supergiants tend toward Rigel-blue (O/B) or Betelgeuse-crimson/amber (K/M)
    t = rand() < 0.52 ? 0.02 + rand() * 0.16 : 0.74 + rand() * 0.24;
  } else {
    t = 0.02 + rand() * 0.96;
  }
  return sampleBlackbodyHex(t);
}

function compareConversationsChronological(a: ConversationStar, b: ConversationStar): number {
  const ta = Date.parse(a.started_at);
  const tb = Date.parse(b.started_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta - tb;
  }
  const timeOrder = a.started_at.localeCompare(b.started_at);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return a.id.localeCompare(b.id);
}

function compareRequestsChronological(a: RequestStar, b: RequestStar): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta - tb;
  }
  const timeOrder = a.created_at.localeCompare(b.created_at);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  if (a.is_subagent !== b.is_subagent) {
    return a.is_subagent ? 1 : -1;
  }
  if (a.step_index !== b.step_index) {
    return a.step_index - b.step_index;
  }
  return a.id.localeCompare(b.id);
}

function buildFallbackRequest(star: ConversationStar): RequestStar {
  return {
    id: `${star.id}:0`,
    conversation_id: star.id,
    session_id: star.id,
    step_index: 0,
    turn_index: 1,
    created_at: star.started_at,
    local_date: star.local_date,
    model: star.primary_model,
    input_tokens: star.input_tokens,
    cache_read_tokens: star.cache_read_tokens,
    output_tokens: star.output_tokens,
    total_tokens: star.total_tokens,
    non_cache_tokens: star.non_cache_tokens,
    tool_calls_count: star.tool_calls_count,
    subagent_calls_count: star.subagent_calls_count,
    status: star.last_status,
    is_subagent: star.is_orphan_subagent,
    subagent_role: star.is_orphan_subagent ? 'Subagent' : '',
    celestial_type: star.celestial_type,
    celestial_reason: star.celestial_reason,
  };
}

interface LocalOffset {
  dx: number;
  dy: number;
}

interface ClusterLayoutResult {
  offsets: LocalOffset[];
  boundRadius: number;
}

/**
 * Lay out requests inside one conversation with astronomical density variations
 * (filament arc, multi-pocket OB association, or core-halo open cluster) plus
 * pairwise minimum-distance relaxation so zero stars collide.
 */
function layoutConversationRequests(
  convId: string,
  orderedReqs: RequestStar[],
  radii: number[],
  magnitudes: number[],
): ClusterLayoutResult {
  const n = orderedReqs.length;
  if (n <= 1) {
    const r0 = radii[0] ?? 2.2;
    return {
      offsets: orderedReqs.map(() => ({ dx: 0, dy: 0 })),
      boundRadius: Math.max(38, r0 * 2.5 + 22),
    };
  }

  const rand = mulberry32(fnv1a32(`${convId}:morph`));
  const morphology = Math.floor(rand() * 3); // 0: filament arc, 1: OB association, 2: core-halo cluster
  const clusterRot = rand() * Math.PI * 2;
  const cosR = Math.cos(clusterRot);
  const sinR = Math.sin(clusterRot);

  const mainIndices: number[] = [];
  const subIndices: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (orderedReqs[i].is_subagent && mainIndices.length > 0) {
      subIndices.push(i);
    } else {
      mainIndices.push(i);
    }
  }
  if (mainIndices.length === 0) {
    for (let i = 0; i < n; i += 1) mainIndices.push(i);
    subIndices.length = 0;
  }

  const offsets: LocalOffset[] = new Array(n);
  const mainCount = mainIndices.length;

  if (morphology === 0 || mainCount < 4) {
    // Morphology 0: Elongated astronomical filament / open airy arc
    const lengthScale = 150 + Math.sqrt(mainCount) * 96;
    const widthSpread = 62 + Math.sqrt(mainCount) * 30;
    const curveAmp = (rand() - 0.5) * widthSpread * 1.25;
    const rawT: number[] = [];
    let tCursor = 0;
    for (let k = 0; k < mainCount; k += 1) {
      const gap = 0.25 + Math.pow(rand(), 1.35) * 1.6;
      tCursor += gap;
      rawT.push(tCursor);
    }
    const maxT = rawT[rawT.length - 1] || 1;
    for (let k = 0; k < mainCount; k += 1) {
      const idx = mainIndices[k];
      const u = (rawT[k] / maxT - 0.5) * 2; // [-1, 1]
      const lx = u * lengthScale * 0.55 + (rand() - 0.5) * 72;
      const arcY = curveAmp * (u * u - 0.35);
      const scatterY = ((rand() + rand() - 1) * 0.68) * widthSpread;
      const ly = arcY + scatterY;
      offsets[idx] = {
        dx: lx * cosR - ly * sinR,
        dy: lx * sinR + ly * cosR,
      };
    }
  } else if (morphology === 1) {
    // Morphology 1: Irregular multi-pocket OB association with wide dark gaps between pockets
    const pocketCount = clamp(Math.round(2 + rand() * 1.5 + mainCount / 22), 2, 5);
    const associationSpan = 165 + Math.sqrt(mainCount) * 86;
    const pockets: LocalOffset[] = [];
    for (let p = 0; p < pocketCount; p += 1) {
      const angle = (p / pocketCount) * Math.PI * 2 + (rand() - 0.5) * 0.9;
      const dist = associationSpan * (0.42 + rand() * 0.58);
      pockets.push({
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist * (0.68 + rand() * 0.4),
      });
    }

    for (let k = 0; k < mainCount; k += 1) {
      const idx = mainIndices[k];
      const isOutlier = rand() < 0.18;
      const pocket = pockets[(k + Math.floor(rand() * 2)) % pockets.length];
      const scatterR = isOutlier ? 105 + rand() * 95 : 28 + Math.pow(rand(), 1.35) * 76;
      const ang = rand() * Math.PI * 2;
      const lx = pocket.dx + Math.cos(ang) * scatterR;
      const ly = pocket.dy + Math.sin(ang) * scatterR * (0.7 + rand() * 0.35);
      offsets[idx] = {
        dx: lx * cosR - ly * sinR,
        dy: lx * sinR + ly * cosR,
      };
    }
  } else {
    // Morphology 2: Open core-halo cluster (airier separation across core and wide halo)
    const clusterRadius = 150 + Math.sqrt(mainCount) * 88;
    const flattenY = 0.65 + rand() * 0.32;
    for (let k = 0; k < mainCount; k += 1) {
      const idx = mainIndices[k];
      const mag = magnitudes[idx] ?? 0.35;
      const radialBias = clamp(1.12 - mag * 0.45, 0.45, 1.15);
      const r = Math.pow(rand(), 1.55) * clusterRadius * radialBias + 32;
      const ang = rand() * Math.PI * 2;
      const lx = Math.cos(ang) * r;
      const ly = Math.sin(ang) * r * flattenY;
      offsets[idx] = {
        dx: lx * cosR - ly * sinR,
        dy: lx * sinR + ly * cosR,
      };
    }
  }

  // Place subagent sessions in open satellite sub-pockets off their preceding main-thread vertex
  if (subIndices.length > 0) {
    const subPocketCenters = new Map<string, LocalOffset>();
    for (const idx of subIndices) {
      const req = orderedReqs[idx];
      const sessKey = req.session_id || req.id;
      let center = subPocketCenters.get(sessKey);
      if (!center) {
        let anchorIdx = mainIndices[0];
        for (let m = 0; m < mainIndices.length; m += 1) {
          if (mainIndices[m] < idx) anchorIdx = mainIndices[m];
          else break;
        }
        const anchor = offsets[anchorIdx] ?? { dx: 0, dy: 0 };
        const outwardAng =
          Math.hypot(anchor.dx, anchor.dy) > 6
            ? Math.atan2(anchor.dy, anchor.dx) + (rand() - 0.5) * 1.1
            : rand() * Math.PI * 2;
        const satDist = 92 + rand() * 88;
        center = {
          dx: anchor.dx + Math.cos(outwardAng) * satDist,
          dy: anchor.dy + Math.sin(outwardAng) * satDist,
        };
        subPocketCenters.set(sessKey, center);
      }
      const jitterR = 26 + Math.pow(rand(), 1.2) * 54;
      const jitterA = rand() * Math.PI * 2;
      offsets[idx] = {
        dx: center.dx + Math.cos(jitterA) * jitterR,
        dy: center.dy + Math.sin(jitterA) * jitterR,
      };
    }
  }

  // Iterative pairwise minimum-distance relaxation inside the cluster (sparse & airy, zero stacked stars)
  for (let pass = 0; pass < 24; pass += 1) {
    let anyMoved = false;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = offsets[j].dx - offsets[i].dx;
        const dy = offsets[j].dy - offsets[i].dy;
        const dist = Math.hypot(dx, dy);
        const minDist = Math.max(54, ((radii[i] ?? 2) + (radii[j] ?? 2)) * 7.2 + 32);
        if (dist < minDist) {
          anyMoved = true;
          const overlap = minDist - dist;
          let ux: number;
          let uy: number;
          if (dist > 1e-4) {
            ux = dx / dist;
            uy = dy / dist;
          } else {
            const tieAngle = (i * 2.39996 + j * 1.17) % (Math.PI * 2);
            ux = Math.cos(tieAngle);
            uy = Math.sin(tieAngle);
          }
          const shift = overlap * 0.52;
          offsets[i].dx -= ux * shift;
          offsets[i].dy -= uy * shift;
          offsets[j].dx += ux * shift;
          offsets[j].dy += uy * shift;
        }
      }
    }
    if (!anyMoved) break;
  }

  // Center offsets around (0, 0) and compute compact bounding circle radius
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += offsets[i].dx;
    sumY += offsets[i].dy;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let maxExtent = 0;
  for (let i = 0; i < n; i += 1) {
    offsets[i].dx -= meanX;
    offsets[i].dy -= meanY;
    const extent = Math.hypot(offsets[i].dx, offsets[i].dy) + (radii[i] ?? 2) * 2.5 + 8;
    if (extent > maxExtent) maxExtent = extent;
  }

  return {
    offsets,
    boundRadius: Math.max(38, maxExtent + 14),
  };
}

/**
 * Lay out every model request as an individual star inside its conversation's
 * astronomical constellation, using low-fill 2D circle-packing separation so
 * constellations exhibit natural voids and strictly never overlap.
 */
export function computeStarPositions(
  stars: ConversationStar[],
  mode: TokenMode,
): StarNode[] {
  if (stars.length === 0) {
    return [];
  }

  const sortedConvs = [...stars].sort(compareConversationsChronological);
  const convCount = sortedConvs.length;

  const rawConvEntries = sortedConvs.map((star) => {
    const rawReqs =
      star.requests && star.requests.length > 0 ? star.requests : [buildFallbackRequest(star)];
    const orderedReqs = [...rawReqs].sort(compareRequestsChronological);
    const tokensList: number[] = [];
    const logTokensList: number[] = [];
    for (const req of orderedReqs) {
      const tokens = mode === 'total' ? req.total_tokens : req.non_cache_tokens;
      tokensList.push(tokens);
      logTokensList.push(Math.log10(Number.isFinite(tokens) ? Math.max(tokens, 500) : 500));
    }
    return { star, orderedReqs, tokensList, logTokensList };
  });

  const sortedLogTokens: number[] = [];
  for (const entry of rawConvEntries) {
    for (const lt of entry.logTokensList) {
      sortedLogTokens.push(lt);
    }
  }
  sortedLogTokens.sort((a, b) => a - b);
  const p05Idx = Math.min(
    sortedLogTokens.length - 1,
    Math.floor((sortedLogTokens.length - 1) * 0.05),
  );
  const p98Idx = Math.min(
    sortedLogTokens.length - 1,
    Math.floor((sortedLogTokens.length - 1) * 0.98),
  );
  const p05 = sortedLogTokens[p05Idx] ?? 3;
  const p98 = sortedLogTokens[p98Idx] ?? 5.5;
  const logSpan = p98 - p05;

  const prepared = rawConvEntries.map((entry) => {
    const magnitudes: number[] = [];
    const radii: number[] = [];

    for (let i = 0; i < entry.orderedReqs.length; i += 1) {
      const tokens = entry.tokensList[i];
      const absMag = computeMagnitude(tokens);
      let mag = absMag;
      if (logSpan > 0.08) {
        const relNorm = clamp((entry.logTokensList[i] - p05) / logSpan, 0, 1);
        const relMag = MIN_MAGNITUDE + Math.pow(relNorm, 1.15) * (MAX_MAGNITUDE - MIN_MAGNITUDE);
        mag = clamp(relMag * 0.82 + absMag * 0.18, MIN_MAGNITUDE, MAX_MAGNITUDE);
      }
      const magNorm = (mag - MIN_MAGNITUDE) / (MAX_MAGNITUDE - MIN_MAGNITUDE);
      const rad = MIN_RADIUS + Math.pow(magNorm, 1.35) * (MAX_RADIUS - MIN_RADIUS);
      magnitudes.push(mag);
      radii.push(rad);
    }

    const layout = layoutConversationRequests(entry.star.id, entry.orderedReqs, radii, magnitudes);
    return {
      star: entry.star,
      orderedReqs: entry.orderedReqs,
      tokensList: entry.tokensList,
      magnitudes,
      radii,
      offsets: layout.offsets,
      boundRadius: layout.boundRadius,
    };
  });

  // Compute cohesive 2D sky canvas dimensions (0.56 packing density = cozy neighboring constellations)
  let totalArea = 0;
  for (const item of prepared) {
    totalArea += Math.PI * Math.pow(item.boundRadius + 18, 2);
  }
  const skyArea = Math.max(220_000, totalArea / 0.56);
  const skyWidth = Math.sqrt(skyArea * 1.72);
  const skyHeight = skyArea / skyWidth;
  const tanTilt = Math.tan(GALACTIC_TILT_RAD);

  const centersX = new Array<number>(convCount);
  const centersY = new Array<number>(convCount);

  if (convCount === 1) {
    centersX[0] = 0;
    centersY[0] = 0;
  } else {
    for (let k = 0; k < convCount; k += 1) {
      const item = prepared[k];
      const rand = mulberry32(fnv1a32(`${item.star.id}:skycenter`));
      const t = k / (convCount - 1);
      // Mix chronological west-to-east drift with cohesive 2D cosmic scatter
      const chronoX = (t - 0.5) * skyWidth * 0.58;
      const randX = (rand() - 0.5) * skyWidth * 0.36;
      const cx = chronoX + randX;

      const bandY = cx * tanTilt * 0.35;
      const spreadMix =
        rand() < 0.72
          ? ((rand() + rand() - 1) * 0.5) * skyHeight * 0.76
          : (rand() - 0.5) * skyHeight * 0.92;
      const cy = bandY + spreadMix;

      centersX[k] = cx;
      centersY[k] = cy;
    }

    // Iterative deterministic circle-packing compaction + separation between conversation constellations
    const minReqDist = (a: number, b: number) => {
      const rA = prepared[a].boundRadius;
      const rB = prepared[b].boundRadius;
      return rA + rB + Math.max(26, 0.08 * (rA + rB));
    };

    for (let pass = 0; pass < 230; pass += 1) {
      if (pass < 110) {
        const pullStrength = 1 - pass / 110;
        const pullX = 1 - 0.018 * pullStrength;
        const pullY = 1 - 0.024 * pullStrength;
        for (let k = 0; k < convCount; k += 1) {
          centersX[k] *= pullX;
          centersY[k] *= pullY;
        }
      }

      let maxOverlap = 0;
      for (let i = 0; i < convCount; i += 1) {
        for (let j = i + 1; j < convCount; j += 1) {
          const dx = centersX[j] - centersX[i];
          const dy = centersY[j] - centersY[i];
          const dist = Math.hypot(dx, dy);
          const minDist = minReqDist(i, j);
          if (dist < minDist) {
            const overlap = minDist - dist;
            if (overlap > maxOverlap) maxOverlap = overlap;
            let ux: number;
            let uy: number;
            if (dist > 1e-4) {
              ux = dx / dist;
              uy = dy / dist;
            } else {
              const ang = (i * 2.39996 + j * 0.91) % (Math.PI * 2);
              ux = Math.cos(ang);
              uy = Math.sin(ang);
            }
            const shift = overlap * 0.54;
            centersX[i] -= ux * shift;
            centersY[i] -= uy * shift;
            centersX[j] += ux * shift;
            centersY[j] += uy * shift;
          }
        }
      }
      if (pass >= 110 && maxOverlap <= 0.01) break;
    }

    // Exact greedy geometric fallback guard if dense clusters still touch slightly
    for (let i = 0; i < convCount; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const dx = centersX[i] - centersX[j];
        const dy = centersY[i] - centersY[j];
        const dist = Math.hypot(dx, dy);
        const minDist = minReqDist(i, j);
        if (dist < minDist) {
          const ang = dist > 1e-4 ? Math.atan2(dy, dx) : (i * 2.39996) % (Math.PI * 2);
          centersX[i] = centersX[j] + Math.cos(ang) * (minDist + 2);
          centersY[i] = centersY[j] + Math.sin(ang) * (minDist + 2);
        }
      }
    }

    // Re-center whole sky cluster centroid to (0, 0) for symmetrical world space
    let globalMeanX = 0;
    let globalMeanY = 0;
    for (let k = 0; k < convCount; k += 1) {
      globalMeanX += centersX[k];
      globalMeanY += centersY[k];
    }
    globalMeanX /= convCount;
    globalMeanY /= convCount;
    for (let k = 0; k < convCount; k += 1) {
      centersX[k] -= globalMeanX;
      centersY[k] -= globalMeanY;
    }
  }

  const nodes: StarNode[] = [];
  for (let convIndex = 0; convIndex < convCount; convIndex += 1) {
    const item = prepared[convIndex];
    const cx = centersX[convIndex];
    const cy = centersY[convIndex];

    for (let reqIdx = 0; reqIdx < item.orderedReqs.length; reqIdx += 1) {
      const request = item.orderedReqs[reqIdx];
      const off = item.offsets[reqIdx];
      nodes.push({
        id: request.id,
        request,
        star: item.star,
        index: 0,
        convIndex,
        requestIndexInConv: reqIdx,
        convRequestCount: item.orderedReqs.length,
        x: cx + off.dx,
        y: cy + off.dy,
        yOffset: cy + off.dy,
        convCenterX: cx,
        convCenterY: cy,
        convRadius: item.boundRadius,
        magnitude: item.magnitudes[reqIdx],
        radius: item.radii[reqIdx],
        color: computeStarSpectralColor(
          request.model || item.star.primary_model,
          request.id,
          item.magnitudes[reqIdx],
        ),
        effectiveTokens: item.tokensList[reqIdx],
      });
    }
  }

  // Sort globally in request chronological order so timeline playback animates step-by-step
  nodes.sort((a, b) => {
    const reqOrder = compareRequestsChronological(a.request, b.request);
    if (reqOrder !== 0) {
      return reqOrder;
    }
    return a.convIndex - b.convIndex;
  });

  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].index = i;
  }

  return nodes;
}
