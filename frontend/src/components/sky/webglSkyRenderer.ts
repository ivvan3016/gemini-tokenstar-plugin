import type { CelestialType } from '../../types/sky';
import { fnv1a32, mulberry32, type StarNode } from '../../logic/starLayout';

export interface CameraLike {
  x: number;
  y: number;
  zoom: number;
}

export interface RenderableStar {
  wx: number;
  wy: number;
  sr: number;
  magnitude: number;
  typeId: number; // 0: star, 1: black_hole, 2: binary, 3: pulsar, 4: comet
  r: number;
  g: number;
  b: number;
  alpha: number;
  emphasized: number;
  shimmer: number;
  seed: number;
  tailAngle: number;
}

export interface RenderableNebula {
  wx: number;
  wy: number;
  radius: number;
  r: number;
  g: number;
  b: number;
  intensity: number;
  seed: number;
}

export interface WebGLFrameParams {
  width: number;
  height: number;
  dpr: number;
  camera: CameraLike;
  /** Default-fit reference zoom used to compute deep zoom-out contrast compression. */
  referenceZoom?: number;
  timeSec: number;
  stars: RenderableStar[];
  nebulae?: RenderableNebula[];
  /** Optional override of the cinematic intro progress (0..1). Defaults to time since first frame. */
  intro?: number;
}

const CATALOG_STAR_COUNT = 4800;
const DUST_MOTE_COUNT = 40;
const CATALOG_TOTAL = CATALOG_STAR_COUNT + DUST_MOTE_COUNT;
const FLOATS_PER_NEBULA_VERTEX = 10;
const VERTICES_PER_NEBULA = 6;
const FLOATS_PER_BODY_VERTEX = 16;
const VERTICES_PER_BODY = 6;
const METEOR_PERIOD_PRIMARY = 4.8;
const METEOR_PERIOD_BOLIDE = 7.9;
const INTRO_DURATION_SEC = 4.2;
const GALACTIC_TILT_RAD = (-12 * Math.PI) / 180;

const QUAD_CORNERS: ReadonlyArray<[number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];

const PRECISION_HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
#else
  precision mediump float;
#endif
`;

const FULLSCREEN_VS = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* Program 1 · Deep-space galactic panorama                                   */
/* ------------------------------------------------------------------------- */
const SKY_FS = `${PRECISION_HEADER}
uniform vec2 u_resolution;
uniform float u_dpr;
uniform vec3 u_camera;
uniform float u_time;
uniform float u_intro;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    v += amp * noise(p);
    p = rot * p * 2.03 + vec2(13.7, 9.2);
    amp *= 0.5;
  }
  return v;
}

vec3 evalDistantGalaxy(vec2 uv, vec2 center, float tilt, float squash, float scale, vec3 coreTint, vec3 armTint) {
  vec2 d = (uv - center) / max(scale, 0.01);
  float cs = cos(tilt);
  float sn = sin(tilt);
  vec2 r = vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
  r.y *= squash;
  float rad = length(r);
  float core = exp(-rad * rad * 18.0);
  float disk = exp(-rad * 3.6);
  float ang = (abs(r.x) + abs(r.y) > 0.0001) ? atan(r.y, r.x) : 0.0;
  float spiral = 0.5 + 0.5 * sin(ang * 2.0 - 3.4 * log(max(rad, 0.02)) + u_time * 0.015);
  float mask = smoothstep(1.2, 0.12, rad);
  return coreTint * core + armTint * disk * (0.45 + 0.55 * spiral) * mask;
}

void main() {
  vec2 cssPos = vec2(gl_FragCoord.x, u_resolution.y * u_dpr - gl_FragCoord.y) / max(u_dpr, 1.0);
  float minRes = max(min(u_resolution.x, u_resolution.y), 1.0);
  vec2 uv = (cssPos - 0.5 * u_resolution) / minRes;

  // Slow sidereal drift of the whole celestial sphere
  vec2 sidereal = vec2(u_time * 0.0011, u_time * 0.00018);
  float camScale = 0.72 / (1.0 + log(max(u_camera.z, 0.25)) * 0.16 + 0.35);
  vec2 skyUV = uv * camScale + u_camera.xy * 0.00024 + sidereal;

  // -12 deg galactic plane rotation
  float cs = 0.9781476;
  float sn = -0.2079117;
  vec2 gal = vec2(skyUV.x * cs - skyUV.y * sn, skyUV.x * sn + skyUV.y * cs);

  vec2 drift = vec2(u_time * 0.0022, -u_time * 0.0014);
  float warpA = fbm(gal * 2.6 + drift);
  float warpB = fbm(gal * 4.4 - drift + vec2(4.2, -1.7));
  vec2 warped = gal * 3.1 + vec2(warpA - 0.5, warpB - 0.5) * 0.95;

  float cloud = fbm(warped);
  float fine = fbm(warped * 2.6 + vec2(7.1, 3.3));
  float breath = 0.95 + 0.05 * sin(cloud * 7.5 + u_time * 0.32);

  float plane = exp(-gal.y * gal.y * 5.2);
  float coreBand = exp(-gal.y * gal.y * 13.0);

  // Granular bright star clouds (Scutum / Sagittarius style)
  float starCloud = smoothstep(0.46, 0.88, fbm(warped * 1.7 + vec2(3.1, -2.2))) * coreBand;

  // Warm galactic bulge
  vec2 bulgeVec = vec2(gal.x - 0.22, gal.y * 1.45);
  float bulgeDist = length(bulgeVec);
  float bulge = exp(-bulgeDist * bulgeDist * 3.4);

  // Great Rift dark lanes + ridged filamentary dust
  float riftNoise = fbm(vec2(gal.x * 2.3 + warpA * 0.6, gal.y * 6.4 + warpB * 0.9));
  float riftMask = smoothstep(0.45, 0.72, riftNoise) * exp(-gal.y * gal.y * 17.0);
  float ridge = 1.0 - abs(2.0 * fbm(warped * 1.25 + vec2(2.1, -4.3)) - 1.0);
  float filament = pow(max(ridge, 0.0), 7.0) * exp(-gal.y * gal.y * 8.0);
  float absorb = clamp(riftMask * 0.86 + filament * 0.5, 0.0, 0.93);

  // Large emission & reflection nebula complexes (H-alpha crimson, OIII teal, Pleiades sapphire)
  float nebA = smoothstep(0.42, 0.80, fbm(gal * 1.35 + vec2(5.2, 1.3) + warpA * 0.45));
  float nebB = smoothstep(0.40, 0.78, fbm(gal * 1.6 + vec2(-3.7, 6.1) - warpB * 0.4));
  float nebC = smoothstep(0.46, 0.82, fbm(gal * 2.15 - drift * 1.4 + vec2(-2.4, -3.1)));
  float nebPlane = exp(-gal.y * gal.y * 3.0);

  vec3 col = vec3(0.004, 0.008, 0.020);
  vec3 outerGlow = vec3(0.044, 0.074, 0.145) * plane * (0.45 + 0.90 * cloud) * breath;
  vec3 cloudGlow = vec3(0.112, 0.105, 0.114) * starCloud * (0.6 + 0.4 * fine);
  vec3 bulgeColor = vec3(0.160, 0.110, 0.082) * bulge * (0.55 + 0.65 * fine);
  vec3 hiiColor = vec3(0.320, 0.085, 0.135) * (coreBand * smoothstep(0.45, 0.80, fine) + nebA * nebPlane * 1.15) * breath;
  vec3 oiiiColor = vec3(0.065, 0.210, 0.280) * (plane * smoothstep(0.42, 0.78, cloud) * 0.85 + nebB * nebPlane * 1.05);
  vec3 pleiadesRefl = vec3(0.100, 0.180, 0.320) * plane * nebC * 0.72;
  vec3 filamentRim = vec3(0.280, 0.160, 0.090) * filament * exp(-gal.y * gal.y * 6.0) * 0.65;

  vec3 milkyWay = (outerGlow + cloudGlow + bulgeColor + hiiColor + oiiiColor + pleiadesRefl) * (1.0 - absorb)
    + filamentRim * (1.0 - riftMask * 0.5);

  // Volumetric god-rays radiating from the galactic core through the dust
  vec2 rayDir = bulgeVec / max(bulgeDist, 0.0001);
  float rayNoise = noise(rayDir * 3.6 + vec2(u_time * 0.035, -u_time * 0.021));
  float rayNoise2 = noise(rayDir * 7.3 - vec2(u_time * 0.018, u_time * 0.027));
  float rays = pow(max(rayNoise * 0.65 + rayNoise2 * 0.35, 0.0), 3.0)
    * exp(-bulgeDist * 1.9)
    * smoothstep(0.03, 0.22, bulgeDist)
    * (1.0 - absorb * 0.6);
  vec3 rayColor = vec3(0.200, 0.150, 0.105) * rays;

  // Distant Messier-style galaxies
  vec2 galTile = mod(gal + 1.5, 3.0) - 1.5;
  vec3 galaxies = evalDistantGalaxy(galTile, vec2(-0.46, -0.36), 0.48, 2.3, 0.16, vec3(0.12, 0.10, 0.08), vec3(0.045, 0.058, 0.095))
    + evalDistantGalaxy(galTile, vec2(0.56, 0.34), -0.62, 1.9, 0.12, vec3(0.08, 0.09, 0.12), vec3(0.032, 0.050, 0.085));

  // Cinematic intro: core light first, then the full galaxy unfolds
  float introCore = smoothstep(0.0, 0.40, u_intro);
  float introWide = smoothstep(0.12, 0.75, u_intro);

  col += milkyWay * introWide + rayColor * introCore + galaxies * introWide;

  // Filmic teal-shadow / warm-highlight grade
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col += vec3(0.0, 0.0035, 0.0075) * (1.0 - smoothstep(0.0, 0.08, lum));
  col = col * (1.0 + vec3(0.06, 0.02, -0.03) * smoothstep(0.02, 0.14, lum));

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* Program 2 · Parallax catalog starfield + foreground cosmic dust motes      */
/* ------------------------------------------------------------------------- */
const CATALOG_VS = `
attribute vec2 a_pos;
attribute float a_parallax;
attribute float a_size;
attribute float a_seed;
attribute vec3 a_color;

uniform vec2 u_resolution;
uniform float u_dpr;
uniform vec3 u_camera;
uniform float u_time;
uniform float u_intro;

varying vec3 v_color;
varying float v_alpha;
varying float v_chromaShift;
varying float v_mote;

void main() {
  float isMote = step(14.0, a_size);
  float tileW = max(2600.0, u_resolution.x * 1.35);
  float tileH = max(1700.0, u_resolution.y * 1.35);

  float zoomParallax = clamp(u_camera.z, 0.32, 2.4);
  float driftSpeed = 1.4 + a_parallax * 16.0;
  float sx = mod(a_pos.x * tileW - u_camera.x * a_parallax * zoomParallax - u_time * driftSpeed, tileW) - (tileW - u_resolution.x) * 0.5;
  float sy = mod(a_pos.y * tileH - u_camera.y * a_parallax * zoomParallax - u_time * driftSpeed * 0.18, tileH) - (tileH - u_resolution.y) * 0.5;

  float ndcX = (sx / max(u_resolution.x, 1.0)) * 2.0 - 1.0;
  float ndcY = 1.0 - (sy / max(u_resolution.y, 1.0)) * 2.0;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);

  float twinkleWave = sin(u_time * (1.1 + a_seed * 2.8) + a_seed * 62.8318);
  float twinkle = 0.82 + 0.18 * twinkleWave;
  float introGate = smoothstep(a_seed * 0.55, a_seed * 0.55 + 0.32, u_intro);

  float starSize = clamp(a_size * u_dpr * (0.9 + 0.12 * min(u_camera.z, 2.0)), 1.0, 18.0);
  float moteSize = clamp(a_size * u_dpr, 8.0, 56.0);
  gl_PointSize = mix(starSize, moteSize, isMote);

  float starAlpha = clamp((0.18 + a_size * 0.14) * twinkle, 0.06, 0.94);
  float moteAlpha = 0.026 + 0.012 * sin(u_time * 0.31 + a_seed * 20.0);

  v_color = a_color;
  v_mote = isMote;
  v_chromaShift = step(3.5, a_size) * (1.0 - isMote) * twinkleWave * 0.14;
  v_alpha = mix(starAlpha, moteAlpha, isMote) * introGate;
}
`;

const CATALOG_FS = `${PRECISION_HEADER}
varying vec3 v_color;
varying float v_alpha;
varying float v_chromaShift;
varying float v_mote;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;

  if (v_mote > 0.5) {
    // Out-of-focus foreground dust: soft disc with faint bokeh rim
    float disc = exp(-r2 * 2.4) * (1.0 - r2);
    float rim = smoothstep(0.55, 0.92, r2) * (1.0 - r2) * 1.6;
    gl_FragColor = vec4(v_color, clamp((disc + rim) * v_alpha, 0.0, 1.0));
    return;
  }

  float moffat = pow(1.0 + r2 * 8.0, -2.5);
  float edge = 1.0 - r2;
  float core = exp(-r2 * 10.0) * 0.58;
  float lum = moffat * edge + core * edge;

  vec3 scinCol = v_color * vec3(1.0 - v_chromaShift, 1.0, 1.0 + v_chromaShift);
  vec3 tint = mix(scinCol, vec3(1.0), clamp(core * 1.4, 0.0, 0.88));

  gl_FragColor = vec4(tint, clamp(lum * v_alpha, 0.0, 1.0));
}
`;

/* ------------------------------------------------------------------------- */
/* Program 3 · Telemetry celestial bodies                                     */
/* ------------------------------------------------------------------------- */
const BODY_VS = `
attribute vec2 a_quad;
attribute vec2 a_world;
attribute vec4 a_geom;   // halfExtent, sr, magnitude, seed
attribute vec3 a_color;
attribute vec4 a_meta;   // typeId, alpha, emphasized, shimmer
attribute float a_tailAngle;

uniform vec2 u_resolution;
uniform vec3 u_camera;

varying vec2 v_local;
varying vec4 v_geom;
varying vec3 v_color;
varying vec4 v_meta;
varying float v_tailAngle;

void main() {
  float cx = (a_world.x - u_camera.x) * u_camera.z + u_resolution.x * 0.5;
  float cy = (a_world.y - u_camera.y) * u_camera.z + u_resolution.y * 0.5;

  vec2 local = a_quad * a_geom.x;
  vec2 screenPos = vec2(cx, cy) + local;

  float ndcX = (screenPos.x / max(u_resolution.x, 1.0)) * 2.0 - 1.0;
  float ndcY = 1.0 - (screenPos.y / max(u_resolution.y, 1.0)) * 2.0;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);

  v_local = local;
  v_geom = a_geom;
  v_color = a_color;
  v_meta = a_meta;
  v_tailAngle = a_tailAngle;
}
`;

const BODY_FS = `${PRECISION_HEADER}
uniform float u_pass;
uniform float u_time;
uniform float u_intro;
uniform float u_deepOut;

varying vec2 v_local;
varying vec4 v_geom;   // halfExtent, sr, magnitude, seed
varying vec3 v_color;
varying vec4 v_meta;   // typeId, alpha, emphasized, shimmer
varying float v_tailAngle;

vec2 rot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float safeAtan(vec2 p) {
  return (abs(p.x) + abs(p.y) > 0.0001) ? atan(p.y, p.x) : 0.0;
}

float gaussBand(float x, float center, float width) {
  float t = (x - center) / max(width, 0.0001);
  return exp(-t * t);
}

vec4 evalPsfStar(vec2 p, float sr, float mag, float seed, vec3 col, float alpha, float emp, float allowSpikes) {
  float r = length(p);
  float ang = safeAtan(p);
  float twinkle = 0.90
    + 0.06 * sin(u_time * (1.8 + seed * 3.1) + seed * 43.1)
    + 0.04 * cos(u_time * (3.7 + seed * 2.3) + seed * 19.0);

  float lum = clamp((mag - 0.10) / 0.90, 0.0, 1.0);
  float lum2 = lum * lum;
  float lumBoost = clamp(lum + emp * 0.35, 0.0, 1.25);

  float deep = clamp(u_deepOut, 0.0, 1.0);
  float coreSr = sr * mix(1.0, 0.74, deep);
  float moffatExp = mix(-2.55, -3.50, deep);
  float coronaDecay = sr * (0.85 + 0.55 * lum) * mix(1.0, 0.48, deep);
  float coronaGate = mix(1.0, 0.14, deep);
  float haloGate = mix(1.0, 0.03, deep);
  float spikeGate = mix(1.0, 0.14, deep);
  float magSep = mix(1.0, 0.24 + 0.80 * pow(lum, 1.55), deep);

  float haloVis = mix(haloGate, 1.0, emp * 0.75);
  float moffat = pow(1.0 + (r * r) / max(0.18, coreSr * coreSr * 0.25), moffatExp);
  float moffatCore = moffat * (0.34 + 0.92 * lumBoost) * magSep;
  float corona = exp(-r / max(0.60, coronaDecay)) * (0.10 + 0.58 * lum2 + emp * 0.18) * mix(coronaGate, 1.0, emp * 0.7);
  float halo = exp(-r / max(1.4, sr * (2.2 + 1.5 * lum))) * (0.03 + 0.32 * lum2 + emp * 0.16) * haloVis;

  // Dynamic coronal micro-flare lobes on luminous giants
  float flare = 0.0;
  if (mag >= 0.62 || emp > 0.5) {
    float l = 0.5 + 0.5 * sin(ang * 3.0 + u_time * 1.4 + seed * 21.0);
    float lobe = l * l;
    flare = gaussBand(r, sr * 1.75, max(0.7, sr * 0.65)) * lobe * (0.16 + 0.14 * lum2) * haloVis;
  }

  // Preserve vivid blackbody hues while letting luminous cores burn white-hot
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 vividCol = clamp(mix(vec3(luma), col, 1.38), 0.0, 1.0);

  // Diffraction spikes with Hubble/JWST-style chromatic dispersion
  vec3 spikeCol = vividCol;
  float spikes = 0.0;
  if (allowSpikes > 0.5 && (mag >= 0.56 || emp > 0.5)) {
    float spikeLen = sr * (3.2 + lum * 4.4 + emp * 1.8);
    float thick = 0.54 + 0.14 * lum + emp * 0.16;
    float sxRay = exp(-abs(p.y) / thick) * exp(-abs(p.x) / max(2.0, spikeLen * 0.44)) * smoothstep(spikeLen, 0.0, abs(p.x));
    float syRay = exp(-abs(p.x) / thick) * exp(-abs(p.y) / max(2.0, spikeLen * 0.44)) * smoothstep(spikeLen, 0.0, abs(p.y));
    spikes += (sxRay + syRay) * (0.28 + 0.56 * lum2 + emp * 0.20);

    float edgeDisp = smoothstep(sr * 1.1, spikeLen * 0.8, r);
    spikeCol = mix(vividCol, mix(vec3(0.76, 0.90, 1.0), vec3(1.0, 0.82, 0.60), 0.5 + 0.5 * sin(ang * 2.0 + r * 0.35)), edgeDisp * 0.42);

    if (mag >= 0.80 || emp > 0.5) {
      vec2 d = rot2(p, 0.785398);
      float diagLen = spikeLen * 0.58;
      float dxRay = exp(-abs(d.y) / 0.48) * smoothstep(diagLen, 0.0, abs(d.x)) * exp(-abs(d.x) / max(2.0, diagLen * 0.42));
      float dyRay = exp(-abs(d.x) / 0.48) * smoothstep(diagLen, 0.0, abs(d.y)) * exp(-abs(d.y) / max(2.0, diagLen * 0.42));
      spikes += (dxRay + dyRay) * (0.26 + 0.16 * lum);
    }
  }

  // Cinematic anamorphic lens streak on the brightest / focused stars
  float streak = 0.0;
  if (mag >= 0.78 || emp > 0.5) {
    float sLen = sr * (5.2 + 3.2 * emp + 2.2 * lum);
    streak = exp(-abs(p.y) / max(0.55, sr * 0.2))
      * exp(-abs(p.x) / sLen)
      * (0.12 + 0.10 * emp)
      * (0.85 + 0.15 * sin(u_time * 0.7 + seed * 9.0));
  }

  // Faint chromatic lens ghost ring around the focused star
  float ghost = 0.0;
  if (emp > 0.5) {
    ghost = gaussBand(r, sr * 3.6, max(0.8, sr * 0.42)) * 0.07;
  }

  float spikeVis = mix(spikeGate, 1.0, emp * 0.8);
  float intensity = (moffatCore + corona + halo + flare) * twinkle;
  float spikeI = spikes * twinkle * spikeVis;
  streak *= spikeVis;
  float total = intensity + spikeI + streak + ghost;
  float whiteHot = clamp(moffatCore * (0.28 + 0.68 * lumBoost) * mix(1.0, 0.32 + 0.68 * lum2, deep), 0.0, 0.92);
  vec3 coreMix = mix(vividCol, vec3(1.0), whiteHot);
  vec3 ghostCol = mix(vec3(0.55, 0.85, 1.0), vec3(1.0, 0.72, 0.55), 0.5 + 0.5 * sin(ang + r * 0.2));
  vec3 rgb = coreMix * (moffatCore * twinkle)
    + vividCol * ((corona + halo + flare) * twinkle)
    + mix(spikeCol, vec3(1.0), 0.24) * spikeI
    + mix(vec3(0.62, 0.78, 1.0), vividCol, 0.45) * streak
    + ghostCol * ghost;
  return vec4(rgb / max(total, 0.001), clamp(total * alpha, 0.0, 1.0));
}

void main() {
  float he = max(1.0, v_geom.x);
  float sr = max(0.8, v_geom.y);
  float mag = v_geom.z;
  float seed = v_geom.w;
  float typeId = v_meta.x;
  float emp = v_meta.z;
  float shimmer = v_meta.w;

  // Staggered cinematic intro: telemetry stars ignite after the galaxy unfolds
  float introGate = smoothstep(0.30 + seed * 0.40, 0.55 + seed * 0.40, u_intro);
  float alpha = v_meta.y * introGate;

  // Soft fade toward quad bounds so no effect is ever hard-clipped
  float edgeM = max(abs(v_local.x), abs(v_local.y));
  float edgeFade = 1.0 - smoothstep(he * 0.72, he * 0.98, edgeM);

  // Pass 0: event-horizon occlusion for black holes
  if (u_pass < 0.5) {
    if (abs(typeId - 1.0) > 0.25) discard;
    float bhR = max(3.0, sr * 1.18);
    float r0 = length(v_local);
    float mask = 1.0 - smoothstep(bhR - 0.8, bhR + 0.4, r0);
    if (mask * alpha <= 0.002) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(mask * alpha, 0.0, 1.0));
    return;
  }

  vec4 outCol = vec4(0.0);
  float wideFade = mix(1.0, 0.38, clamp(u_deepOut, 0.0, 1.0));

  if (typeId < 0.5) {
    // 0 · Star
    outCol = evalPsfStar(v_local, sr, mag, seed, v_color, alpha, emp, 1.0);
  } else if (typeId < 1.5) {
    // 1 · Black hole — Interstellar-style lensed accretion disk
    float tilt = -0.32 + seed * 0.24;
    vec2 q = rot2(v_local, tilt);
    float bhR = max(3.0, sr * 1.18);
    float r = length(v_local);

    float photonRing = gaussBand(r, bhR * 1.04, max(0.6, bhR * 0.12));

    // Far side of the disk gravitationally bent over the top (and faintly under the bottom)
    float lensR = length(vec2(q.x * 0.94, q.y * 1.05));
    float lensBand = gaussBand(lensR, bhR * 1.42, max(0.8, bhR * 0.30));
    float topW = smoothstep(0.05, 0.9, -q.y / max(lensR, 0.001));
    float botW = smoothstep(0.25, 0.95, q.y / max(lensR, 0.001));
    float lAng = safeAtan(q);
    float lensSwirl = 0.75 + 0.25 * sin(lAng * 4.0 - u_time * 2.2 + seed * 7.0);
    float lensArc = lensBand * (topW * 0.85 + botW * 0.38) * lensSwirl;

    // Differentially rotating plasma disk
    vec2 diskCoord = vec2(q.x, q.y * 4.2);
    float dEll = length(diskCoord);
    float ang = safeAtan(diskCoord);
    float omega = 1.5 + 2.3 * (bhR / max(dEll, bhR * 0.8));
    float swirl = 0.66
      + 0.24 * sin(ang * 3.0 - u_time * omega - dEll / max(0.8, sr * 0.85) + seed * 14.0)
      + 0.16 * sin(ang * 5.0 + u_time * (omega * 1.25) - dEll / max(0.6, sr * 0.5));
    float knot = pow(max(0.0, sin(ang * 2.0 - u_time * (omega * 1.1) + seed * 11.0)), 4.0)
      * gaussBand(dEll, bhR * 1.85, max(0.8, bhR * 0.38)) * 0.55;
    float isco = gaussBand(dEll, bhR * 1.55, max(0.6, bhR * 0.22)) * 0.55;
    float diskRadial = gaussBand(dEll, bhR * 2.1, max(1.4, bhR * 0.75))
      + 0.5 * gaussBand(dEll, bhR * 3.0, max(1.8, bhR * 1.0));

    // Infalling spiral matter streams feeding the disk
    float spiral = pow(max(0.0, sin(ang * 2.0 + log(max(dEll, 0.5)) * 5.0 - u_time * 0.9 + seed * 5.0)), 3.0)
      * gaussBand(dEll, bhR * 3.9, max(2.0, bhR * 1.3)) * 0.22;

    float behindMask = (q.y < 0.0 && r < bhR * 1.05) ? 0.0 : 1.0;

    // Pulsing bipolar relativistic micro-jets
    float jetPulse = 0.75 + 0.25 * sin(u_time * 3.0 + seed * 19.0);
    float relJet = exp(-abs(q.x) / max(0.65, bhR * 0.34))
      * exp(-r / max(2.2, bhR * 2.7))
      * smoothstep(bhR * 0.9, bhR * 1.35, r)
      * 0.26 * jetPulse;

    // Relativistic Doppler beaming
    float beam = clamp(0.88 - 0.58 * clamp(q.x / max(bhR * 2.8, 1.0), -1.0, 1.0), 0.32, 1.52);
    vec3 diskTint = mix(vec3(0.76, 0.28, 0.22), vec3(1.0, 0.92, 0.78), clamp((beam - 0.32) / 1.15, 0.0, 1.0));

    float diskLum = (diskRadial * swirl + knot + spiral) * beam * behindMask * 0.9;
    float iscoLum = isco * beam * behindMask;
    float outerAura = exp(-r / max(2.2, bhR * 2.1)) * smoothstep(bhR * 0.92, bhR * 1.25, r) * 0.22 * wideFade;

    vec3 cTotal = vec3(1.0, 0.91, 0.78) * photonRing
      + mix(vec3(1.0, 0.86, 0.66), diskTint, 0.5) * lensArc
      + diskTint * diskLum
      + vec3(1.0, 0.96, 0.90) * iscoLum
      + vec3(0.68, 0.84, 1.0) * relJet
      + vec3(0.88, 0.48, 0.34) * outerAura;
    float aTotal = (photonRing + lensArc + diskLum + iscoLum + relJet + outerAura) * alpha;
    outCol = vec4(cTotal / max(photonRing + lensArc + diskLum + iscoLum + relJet + outerAura, 0.001), clamp(aTotal, 0.0, 1.0));
  } else if (typeId < 2.5) {
    // 2 · Binary — Keplerian pair + Roche-lobe plasma bridge
    float orb = seed * 6.28318 + u_time * 0.48;
    float sep = max(3.4, sr * 1.42);
    vec2 axis = vec2(cos(orb), sin(orb) * 0.76) * sep;
    vec2 p1 = v_local + axis * 0.42;
    vec2 p2 = v_local - axis * 0.72;

    float isWarm = step(v_color.b + 0.08, v_color.r);
    vec3 compCol = isWarm > 0.5 ? vec3(0.52, 0.76, 1.0) : vec3(1.0, 0.68, 0.36);

    float eclipseMod = 1.0 - 0.14 * max(0.0, -sin(orb)) * (1.0 - smoothstep(0.0, 0.4, abs(cos(orb))));

    vec4 sA = evalPsfStar(p1, sr * 0.95, mag, seed, v_color, alpha * eclipseMod, emp, emp);
    vec4 sB = evalPsfStar(p2, sr * 0.70, mag * 0.62, seed + 0.37, compCol, alpha * 0.96, 0.0, 0.0);

    vec2 seg = (-axis * 0.72) - (axis * 0.42);
    float segLen = max(length(seg), 0.001);
    vec2 segDir = seg / segLen;
    vec2 segPerp = vec2(-segDir.y, segDir.x);
    vec2 rel = v_local - axis * 0.42;
    float along = clamp(dot(rel, segDir) / segLen, 0.0, 1.0);
    float across = dot(rel, segPerp);
    float bend = sin(along * 3.14159) * sr * 0.36;
    float streamFlow = 0.72 + 0.28 * sin(along * 9.0 - u_time * 3.6 + seed * 12.0);
    float rocheStream = gaussBand(across, bend, max(0.65, sr * 0.28))
      * sin(along * 3.14159) * streamFlow * 0.45 * alpha;

    float tidal = exp(-length(v_local) / max(2.2, sep * 1.7)) * 0.20 * alpha * wideFade;
    vec3 streamCol = mix(v_color, compCol, along);

    vec3 rgb = sA.rgb * sA.a + sB.rgb * sB.a + streamCol * (rocheStream + tidal);
    float a = clamp(sA.a + sB.a + rocheStream + tidal, 0.0, 1.0);
    outCol = vec4(rgb / max(a, 0.001), a);
  } else if (typeId < 3.5) {
    // 3 · Pulsar — oblique rotator: fixed spin axis, gently precessing jets, relativistic beaming & faint Chandra torus
    vec2 p = v_local;
    float spinAxisAng = -0.95 + (seed - 0.5) * 2.4;
    float obliquity = 0.28 + 0.08 * fract(seed * 7.3);
    float rotPhase = u_time * 2.35 + seed * 6.28318;
    float wobbleAng = obliquity * cos(rotPhase);

    vec2 sp = rot2(p, spinAxisAng);
    vec2 jp = rot2(sp, wobbleAng);

    float sFlash = abs(sin(rotPhase));
    float sFlash2 = sFlash * sFlash;
    float sFlash4 = sFlash2 * sFlash2;
    float flashPeak = sFlash4 * sFlash4 * sFlash2;

    vec2 nA = sp + vec2(sr * 0.65, sr * 0.4);
    vec2 nB = sp - vec2(sr * 0.55, sr * 0.48);
    float wisp1 = exp(-length(vec2(nA.x, nA.y * 1.35)) / max(2.2, sr * 2.8)) * 0.17 * wideFade;
    float wisp2 = exp(-length(vec2(nB.x * 1.3, nB.y)) / max(1.9, sr * 2.4)) * 0.13 * wideFade;

    // Precessing collimated relativistic beams with per-pole line-of-sight Doppler beaming
    float jetReach = sr * (8.5 + emp * 2.2) + 8.0;
    float ax = abs(jp.x);
    float ay = abs(jp.y);
    float beamDir = step(0.0, jp.x) * 2.0 - 1.0;
    float towardViewer = beamDir * sin(rotPhase);
    float towardPos = max(0.0, towardViewer);
    float towardPow5 = towardPos * towardPos * towardPos * towardPos * towardPos;
    float beamBoost = 0.62 + 0.42 * towardPos + 0.68 * towardPow5;
    float lenScale = 1.0 - 0.16 * towardViewer;
    float effAx = ax / max(lenScale, 0.72);
    float axialFade = exp(-effAx / max(2.0, jetReach * 0.52)) * smoothstep(jetReach, 0.0, effAx);
    float coneHalfCore = max(0.45, ax * 0.045 + sr * 0.12);
    float coneHalfOuter = max(0.85, ax * 0.16 + sr * 0.34);
    float qCore = ay / coneHalfCore;
    float qOuter = ay / coneHalfOuter;
    float coreBeam = exp(-qCore * qCore) * axialFade * 0.88 * beamBoost * (0.86 + 0.26 * flashPeak);
    float sheathBeam = exp(-qOuter * qOuter) * axialFade * 0.36 * (0.76 + 0.34 * beamBoost) * wideFade;

    // Subtle spin-aligned Chandra-style equatorial wind torus with gentle azimuthal shimmer
    float eqD = length(vec2(sp.x * 2.6, sp.y));
    float spAng = safeAtan(vec2(sp.x * 2.6, sp.y));
    float torusShimmer = 0.82 + 0.18 * sin(spAng * 2.0 - rotPhase);
    float torus = gaussBand(eqD, sr * 1.85, max(0.85, sr * 0.52)) * 0.13 * torusShimmer * wideFade;

    vec4 core = evalPsfStar(p, sr * 0.92, max(0.70, mag), seed, vec3(0.76, 0.95, 1.0), alpha * clamp(0.92 + 0.34 * flashPeak, 0.0, 1.25), emp, 1.0);
    vec3 wispCol = vec3(0.46, 0.88, 0.96) * (wisp1 + sheathBeam)
      + vec3(0.88, 0.50, 0.68) * (wisp2 + torus * 0.45)
      + vec3(0.62, 0.84, 1.0) * (torus * 0.65)
      + vec3(0.92, 1.0, 1.0) * coreBeam;
    float extraA = (wisp1 + wisp2 + torus + coreBeam + sheathBeam) * alpha;
    float a = clamp(core.a + extraA, 0.0, 1.0);
    vec3 rgb = core.rgb * core.a + wispCol * alpha;
    outCol = vec4(rgb / max(a, 0.001), a);
  } else {
    // 4 · Comet — long razor CO+ ion stream with plasma wave knots + curved dust fan + bow shock
    vec2 tc = rot2(v_local, -v_tailAngle);
    float ionLen = sr * 12.0 + 26.0 + emp * 10.0;
    float dustLen = sr * 9.5 + 18.0 + emp * 7.0;
    float tx = max(0.0, tc.x);
    float forward = smoothstep(-sr * 0.9, sr * 1.3, tc.x);
    float fadeIon = exp(-tx / max(5.0, ionLen * 0.50)) * smoothstep(ionLen, 0.0, tc.x);

    // Subtle plasma magnetic ripple & traveling solar-wind disconnection knots
    float wobble = sin(tx * 0.14 - u_time * 3.4 + seed * 9.0) * tx * 0.014;
    float knots = 0.48 + 0.92 * pow(0.5 + 0.5 * sin(tx * 0.26 - u_time * 7.2 + seed * 19.0), 5.0);
    float ionHalfW = max(0.55, sr * 0.24 + tx * 0.022);
    float ionRay = exp(-pow((tc.y - wobble) / ionHalfW, 2.0))
      * fadeIon * forward * knots * 0.92;

    // Diverging curved warm pearlescent dust tail (semi-transparent to keep neighbor stars crisp)
    float curveOffset = 0.024 * tx * tx / max(1.2, sr * 1.4);
    float dustSpread = sr * 0.52 + tx * 0.15;
    float dustStriation = 0.84 + 0.16 * sin(tx * 0.95 + tc.y * 1.7 - u_time * 1.8 + seed * 13.0);
    float dustTail = gaussBand(tc.y, curveOffset, max(0.85, dustSpread))
      * exp(-tx / max(4.0, dustLen * 0.45)) * smoothstep(dustLen, 0.0, tc.x)
      * forward * dustStriation * 0.54 * wideFade;

    float r = length(v_local);
    float comaBreath = 0.90 + 0.10 * sin(u_time * 2.6 + seed * 15.0);
    float coma = exp(-r / max(1.1, sr * 1.55)) * comaBreath * 0.58 * wideFade;
    float sunwardBias = smoothstep(0.3, -sr * 1.1, tc.x);
    float bowShock = gaussBand(r, sr * 1.35, max(0.5, sr * 0.28)) * sunwardBias * 0.42;
    float nucleus = exp(-r * r / max(0.35, sr * sr * 0.40)) * 1.05;

    vec3 rgb = vec3(0.46, 0.84, 1.0) * ionRay
      + vec3(1.0, 0.92, 0.80) * dustTail
      + vec3(0.56, 0.98, 0.86) * (coma + bowShock)
      + vec3(1.0) * nucleus;
    float sumC = ionRay + dustTail + coma + bowShock + nucleus;
    outCol = vec4(rgb / max(sumC, 0.001), clamp(sumC * alpha, 0.0, 1.0));
  }

  // Stellar ignition during timeline playback: flash, twin shock rings, collapsing cross flare
  if (shimmer > 0.001 && shimmer < 0.999) {
    float r = length(v_local);
    float inv = 1.0 - shimmer;
    float flash = exp(-r / max(1.0, sr * 1.3)) * inv * inv * 1.1;
    float ring1 = gaussBand(r, sr * (1.2 + shimmer * 5.5), max(0.9, sr * 0.45)) * inv * 0.7;
    float ring2 = gaussBand(r, sr * (0.8 + shimmer * 3.2), max(0.7, sr * 0.3)) * inv * inv * 0.45;
    float cLen = sr * (2.0 + 9.0 * inv);
    float crossFlare = (exp(-abs(v_local.y) / 0.7) * exp(-abs(v_local.x) / cLen)
      + exp(-abs(v_local.x) / 0.7) * exp(-abs(v_local.y) / cLen)) * inv * 0.55;
    float add = (flash + ring1 + ring2 + crossFlare) * introGate;
    vec3 addCol = (mix(v_color, vec3(1.0), 0.55) * (flash + crossFlare)
      + v_color * ring1
      + vec3(0.7, 0.85, 1.0) * ring2) * introGate;
    vec3 mixed = outCol.rgb * outCol.a + addCol;
    float aMix = clamp(outCol.a + add, 0.0, 1.0);
    outCol = vec4(mixed / max(outCol.a + add, 0.001), aMix);
  }

  outCol.a *= edgeFade;
  if (outCol.a < 0.003) discard;
  gl_FragColor = vec4(outCol.rgb * outCol.a, outCol.a);
}
`;

/* ------------------------------------------------------------------------- */
/* Program 4 · Meteors & bolides                                              */
/* ------------------------------------------------------------------------- */
const METEOR_VS = `
attribute vec2 a_pos;
attribute float a_along;
uniform vec2 u_resolution;
varying float v_along;

void main() {
  float ndcX = (a_pos.x / max(u_resolution.x, 1.0)) * 2.0 - 1.0;
  float ndcY = 1.0 - (a_pos.y / max(u_resolution.y, 1.0)) * 2.0;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  v_along = a_along;
}
`;

const METEOR_FS = `${PRECISION_HEADER}
uniform float u_intensity;
uniform vec3 u_headColor;
uniform vec3 u_tailColor;
varying float v_along;

void main() {
  float tailFade = pow(clamp(v_along, 0.0, 1.0), 2.4);
  float headGlow = smoothstep(0.84, 1.0, v_along) * 0.82;
  vec3 col = mix(u_tailColor, u_headColor, clamp(v_along * 1.1, 0.0, 1.0));
  float a = clamp((tailFade * 0.85 + headGlow) * u_intensity, 0.0, 1.0);
  if (a < 0.005) discard;
  gl_FragColor = vec4(col, a);
}
`;

/* ------------------------------------------------------------------------- */
/* Program 5 · Cinematic lens vignette + animated film grain (multiply pass)  */
/* ------------------------------------------------------------------------- */
const POST_FS = `${PRECISION_HEADER}
uniform vec2 u_resolution;
uniform float u_dpr;
uniform float u_time;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 px = gl_FragCoord.xy / max(u_dpr, 1.0);
  vec2 uv = px / max(u_resolution, vec2(1.0));
  vec2 d = uv - 0.5;
  d.x *= u_resolution.x / max(u_resolution.y, 1.0);
  float vig = 1.0 - smoothstep(0.38, 1.08, length(d)) * 0.58;
  float grain = hash21(floor(px) + fract(u_time * 7.0) * vec2(91.3, 47.1));
  float mult = vig * (0.958 + 0.042 * grain);
  gl_FragColor = vec4(vec3(mult), 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* Program 6 · World-space FBM cluster nebulae enveloping constellations       */
/* ------------------------------------------------------------------------- */
const NEBULA_VS = `
attribute vec2 a_quad;
attribute vec3 a_center; // wx, wy, worldRadius
attribute vec3 a_color;
attribute vec2 a_params; // intensity, seed

uniform vec2 u_resolution;
uniform vec3 u_camera;

varying vec2 v_uv;
varying vec3 v_color;
varying vec2 v_params;

void main() {
  float cx = (a_center.x - u_camera.x) * u_camera.z + u_resolution.x * 0.5;
  float cy = (a_center.y - u_camera.y) * u_camera.z + u_resolution.y * 0.5;
  float rPx = a_center.z * u_camera.z;
  vec2 screenPos = vec2(cx, cy) + a_quad * rPx;

  float ndcX = (screenPos.x / max(u_resolution.x, 1.0)) * 2.0 - 1.0;
  float ndcY = 1.0 - (screenPos.y / max(u_resolution.y, 1.0)) * 2.0;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);

  v_uv = a_quad;
  v_color = a_color;
  v_params = a_params;
}
`;

const NEBULA_FS = `${PRECISION_HEADER}
uniform float u_time;
uniform float u_intro;

varying vec2 v_uv;
varying vec3 v_color;
varying vec2 v_params; // intensity, seed

float nHash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float nNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(nHash21(i), nHash21(i + vec2(1.0, 0.0)), u.x),
    mix(nHash21(i + vec2(0.0, 1.0)), nHash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float nFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += amp * nNoise(p);
    p = rot * p * 2.02 + vec2(9.2, 13.7);
    amp *= 0.5;
  }
  return v;
}

void main() {
  float r = length(v_uv);
  if (r > 1.0) discard;

  float intensity = v_params.x;
  float seed = v_params.y;
  float ang = seed * 6.28318;
  float cs = cos(ang);
  float sn = sin(ang);
  vec2 p = vec2(v_uv.x * cs - v_uv.y * sn, v_uv.x * sn + v_uv.y * cs);
  p.y *= 1.25;

  vec2 drift = vec2(u_time * 0.025, -u_time * 0.018);
  vec2 seedOff = vec2(seed * 23.0, seed * 41.0);
  vec2 warp = vec2(
    nFbm(p * 2.1 + drift + seedOff),
    nFbm(p * 2.1 - drift + seedOff + vec2(3.1, 7.4))
  );
  float cloud = nFbm(p * 2.7 + (warp - 0.5) * 1.15 + seedOff);
  float filament = nFbm(p * 4.2 - (warp - 0.5) * 0.8 + seedOff);
  float dustVein = smoothstep(0.47, 0.76, nFbm(p * 3.6 - warp * 0.65 + seedOff * 0.5));

  float radial = smoothstep(1.0, 0.14, r) * (0.42 + 0.58 * exp(-r * r * 2.2));
  float introFade = smoothstep(0.08, 0.65, u_intro);

  // Spectral reflection tint laced with H-alpha crimson & OIII ionized sapphire filaments
  vec3 tintCore = v_color;
  vec3 tintRim = mix(vec3(0.78, 0.24, 0.34), vec3(0.22, 0.62, 0.78), clamp(filament * 1.35 - 0.2, 0.0, 1.0));
  vec3 col = mix(tintCore, tintRim, clamp(r * 0.58 + (filament - 0.4) * 0.5, 0.0, 0.65));

  float lum = radial * (0.35 + 0.65 * smoothstep(0.25, 0.85, cloud)) * (1.0 - dustVein * 0.65);
  float a = clamp(lum * intensity * 0.36 * introFade, 0.0, 1.0);
  if (a < 0.002) discard;

  gl_FragColor = vec4(col, a);
}
`;

let lastShaderError: string | null = null;

/** Last WebGL shader compile/link diagnostic (null when all programs compiled cleanly). */
export function getLastShaderError(): string | null {
  return lastShaderError;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string, label: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    lastShaderError = `[${label}] ${gl.getShaderInfoLog(shader) ?? 'unknown compile error'}`;
    if (typeof console !== 'undefined') console.warn('TokenStar WebGL shader error', lastShaderError);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string, label: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vs`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.fs`);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    lastShaderError = `[${label}.link] ${gl.getProgramInfoLog(program) ?? 'unknown link error'}`;
    if (typeof console !== 'undefined') console.warn('TokenStar WebGL link error', lastShaderError);
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Compute normalized deep-zoom-out factor (0 at default/zoom-in, rising smoothly to 1 far below referenceZoom). */
export function computeDeepOut(zoom: number, referenceZoom: number): number {
  const refZoom = Math.max(0.10, referenceZoom);
  const relZoom = zoom / refZoom;
  return 1 - smoothstep01((relZoom - 0.24) / 0.72);
}

export function hexToRgbNorm(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  if (clean.length === 3) {
    const r = Number.parseInt(clean[0] + clean[0], 16) / 255;
    const g = Number.parseInt(clean[1] + clean[1], 16) / 255;
    const b = Number.parseInt(clean[2] + clean[2], 16) / 255;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
  } else if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
    const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
    const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
  }
  return [0.85, 0.91, 1.0];
}

export function celestialTypeToId(type: CelestialType): number {
  switch (type) {
    case 'black_hole':
      return 1;
    case 'binary':
      return 2;
    case 'pulsar':
      return 3;
    case 'comet':
      return 4;
    case 'star':
    default:
      return 0;
  }
}

function buildCatalogBufferData(): Float32Array {
  const rand = mulberry32(0x54534341);
  const palette: ReadonlyArray<[number, number, number]> = [
    hexToRgbNorm('#6ea8ff'),
    hexToRgbNorm('#9cc6ff'),
    hexToRgbNorm('#e2edff'),
    hexToRgbNorm('#fff4dc'),
    hexToRgbNorm('#ffd984'),
    hexToRgbNorm('#ffa458'),
    hexToRgbNorm('#ff744c'),
  ];
  const motePalette: ReadonlyArray<[number, number, number]> = [
    hexToRgbNorm('#8fb4ff'),
    hexToRgbNorm('#ffd2a6'),
    hexToRgbNorm('#b8e6ff'),
  ];
  const tanTilt = Math.tan(GALACTIC_TILT_RAD);
  const out = new Float32Array(CATALOG_TOTAL * 8);

  for (let i = 0; i < CATALOG_STAR_COUNT; i += 1) {
    const xNorm = rand();
    let yNorm: number;
    if (rand() < 0.62) {
      const bandCenter = 0.5 + (xNorm - 0.5) * tanTilt * 0.72;
      const tri = (rand() + rand() - 1) * 0.32;
      yNorm = Math.min(0.995, Math.max(0.005, bandCenter + tri));
    } else {
      yNorm = rand();
    }

    const voidWave = Math.sin(xNorm * 14.3 + yNorm * 7.1) + Math.cos(yNorm * 11.7 - xNorm * 6.4);
    const voidDamp = voidWave > 1.15 ? 0.58 : 1.0;

    const p = Math.pow(rand(), 3.6);
    const size = Math.min(12, (1.35 + p * 6.8) * voidDamp);
    const parallax = 0.04 + (i % 3) * 0.055;
    const seed = rand();
    const rgb = palette[Math.floor(rand() * palette.length)];

    const base = i * 8;
    out[base] = xNorm;
    out[base + 1] = yNorm;
    out[base + 2] = parallax;
    out[base + 3] = size;
    out[base + 4] = seed;
    out[base + 5] = rgb[0];
    out[base + 6] = rgb[1];
    out[base + 7] = rgb[2];
  }

  // Foreground out-of-focus cosmic dust motes (size > 14 flags them in the shader)
  for (let m = 0; m < DUST_MOTE_COUNT; m += 1) {
    const base = (CATALOG_STAR_COUNT + m) * 8;
    const rgb = motePalette[Math.floor(rand() * motePalette.length)];
    out[base] = rand();
    out[base + 1] = rand();
    out[base + 2] = 0.55 + rand() * 0.4;
    out[base + 3] = 16 + rand() * 18;
    out[base + 4] = rand();
    out[base + 5] = rgb[0];
    out[base + 6] = rgb[1];
    out[base + 7] = rgb[2];
  }
  return out;
}

/** Pure WebGL 1.0 GPU planetarium sky & animated optical celestial renderer. */
export class WebGLSkyRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly skyProg: WebGLProgram;
  private readonly catProg: WebGLProgram;
  private readonly nebulaProg: WebGLProgram;
  private readonly bodyProg: WebGLProgram;
  private readonly meteorProg: WebGLProgram;
  private readonly postProg: WebGLProgram;

  private readonly skyVbo: WebGLBuffer;
  private readonly catVbo: WebGLBuffer;
  private readonly nebulaVbo: WebGLBuffer;
  private readonly bodyVbo: WebGLBuffer;
  private readonly meteorVbo: WebGLBuffer;

  private nebulaFloatData: Float32Array;
  private bodyFloatData: Float32Array;
  private readonly meteorFloatData = new Float32Array(18);
  private introStartSec: number | null = null;
  private disposed = false;

  private readonly skyLoc: {
    pos: number;
    resolution: WebGLUniformLocation | null;
    dpr: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    intro: WebGLUniformLocation | null;
  };
  private readonly catLoc: {
    pos: number;
    parallax: number;
    size: number;
    seed: number;
    color: number;
    resolution: WebGLUniformLocation | null;
    dpr: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    intro: WebGLUniformLocation | null;
  };
  private readonly nebulaLoc: {
    quad: number;
    center: number;
    color: number;
    params: number;
    resolution: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    intro: WebGLUniformLocation | null;
  };
  private readonly bodyLoc: {
    quad: number;
    world: number;
    geom: number;
    color: number;
    meta: number;
    tailAngle: number;
    resolution: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    pass: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    intro: WebGLUniformLocation | null;
    deepOut: WebGLUniformLocation | null;
  };
  private readonly meteorLoc: {
    pos: number;
    along: number;
    resolution: WebGLUniformLocation | null;
    intensity: WebGLUniformLocation | null;
    headColor: WebGLUniformLocation | null;
    tailColor: WebGLUniformLocation | null;
  };
  private readonly postLoc: {
    pos: number;
    resolution: WebGLUniformLocation | null;
    dpr: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
  };

  private constructor(
    gl: WebGLRenderingContext,
    programs: {
      sky: WebGLProgram;
      cat: WebGLProgram;
      nebula: WebGLProgram;
      body: WebGLProgram;
      meteor: WebGLProgram;
      post: WebGLProgram;
    },
    buffers: {
      sky: WebGLBuffer;
      cat: WebGLBuffer;
      nebula: WebGLBuffer;
      body: WebGLBuffer;
      meteor: WebGLBuffer;
    },
  ) {
    this.gl = gl;
    this.skyProg = programs.sky;
    this.catProg = programs.cat;
    this.nebulaProg = programs.nebula;
    this.bodyProg = programs.body;
    this.meteorProg = programs.meteor;
    this.postProg = programs.post;
    this.skyVbo = buffers.sky;
    this.catVbo = buffers.cat;
    this.nebulaVbo = buffers.nebula;
    this.bodyVbo = buffers.body;
    this.meteorVbo = buffers.meteor;
    this.nebulaFloatData = new Float32Array(64 * VERTICES_PER_NEBULA * FLOATS_PER_NEBULA_VERTEX);
    this.bodyFloatData = new Float32Array(256 * VERTICES_PER_BODY * FLOATS_PER_BODY_VERTEX);

    const skyProg = this.skyProg;
    const catProg = this.catProg;
    const nebulaProg = this.nebulaProg;
    const bodyProg = this.bodyProg;
    const meteorProg = this.meteorProg;
    const postProg = this.postProg;

    this.skyLoc = {
      pos: gl.getAttribLocation(skyProg, 'a_pos'),
      resolution: gl.getUniformLocation(skyProg, 'u_resolution'),
      dpr: gl.getUniformLocation(skyProg, 'u_dpr'),
      camera: gl.getUniformLocation(skyProg, 'u_camera'),
      time: gl.getUniformLocation(skyProg, 'u_time'),
      intro: gl.getUniformLocation(skyProg, 'u_intro'),
    };
    this.catLoc = {
      pos: gl.getAttribLocation(catProg, 'a_pos'),
      parallax: gl.getAttribLocation(catProg, 'a_parallax'),
      size: gl.getAttribLocation(catProg, 'a_size'),
      seed: gl.getAttribLocation(catProg, 'a_seed'),
      color: gl.getAttribLocation(catProg, 'a_color'),
      resolution: gl.getUniformLocation(catProg, 'u_resolution'),
      dpr: gl.getUniformLocation(catProg, 'u_dpr'),
      camera: gl.getUniformLocation(catProg, 'u_camera'),
      time: gl.getUniformLocation(catProg, 'u_time'),
      intro: gl.getUniformLocation(catProg, 'u_intro'),
    };
    this.nebulaLoc = {
      quad: gl.getAttribLocation(nebulaProg, 'a_quad'),
      center: gl.getAttribLocation(nebulaProg, 'a_center'),
      color: gl.getAttribLocation(nebulaProg, 'a_color'),
      params: gl.getAttribLocation(nebulaProg, 'a_params'),
      resolution: gl.getUniformLocation(nebulaProg, 'u_resolution'),
      camera: gl.getUniformLocation(nebulaProg, 'u_camera'),
      time: gl.getUniformLocation(nebulaProg, 'u_time'),
      intro: gl.getUniformLocation(nebulaProg, 'u_intro'),
    };
    this.bodyLoc = {
      quad: gl.getAttribLocation(bodyProg, 'a_quad'),
      world: gl.getAttribLocation(bodyProg, 'a_world'),
      geom: gl.getAttribLocation(bodyProg, 'a_geom'),
      color: gl.getAttribLocation(bodyProg, 'a_color'),
      meta: gl.getAttribLocation(bodyProg, 'a_meta'),
      tailAngle: gl.getAttribLocation(bodyProg, 'a_tailAngle'),
      resolution: gl.getUniformLocation(bodyProg, 'u_resolution'),
      camera: gl.getUniformLocation(bodyProg, 'u_camera'),
      pass: gl.getUniformLocation(bodyProg, 'u_pass'),
      time: gl.getUniformLocation(bodyProg, 'u_time'),
      intro: gl.getUniformLocation(bodyProg, 'u_intro'),
      deepOut: gl.getUniformLocation(bodyProg, 'u_deepOut'),
    };
    this.meteorLoc = {
      pos: gl.getAttribLocation(meteorProg, 'a_pos'),
      along: gl.getAttribLocation(meteorProg, 'a_along'),
      resolution: gl.getUniformLocation(meteorProg, 'u_resolution'),
      intensity: gl.getUniformLocation(meteorProg, 'u_intensity'),
      headColor: gl.getUniformLocation(meteorProg, 'u_headColor'),
      tailColor: gl.getUniformLocation(meteorProg, 'u_tailColor'),
    };
    this.postLoc = {
      pos: gl.getAttribLocation(postProg, 'a_pos'),
      resolution: gl.getUniformLocation(postProg, 'u_resolution'),
      dpr: gl.getUniformLocation(postProg, 'u_dpr'),
      time: gl.getUniformLocation(postProg, 'u_time'),
    };
  }

  /** Try creating a WebGLSkyRenderer on `canvas`; returns `null` when WebGL is unavailable. */
  static create(canvas: HTMLCanvasElement): WebGLSkyRenderer | null {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const opts: WebGLContextAttributes = {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    };

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = (canvas.getContext('webgl', opts) ||
        canvas.getContext('experimental-webgl', opts)) as WebGLRenderingContext | null;
    } catch {
      return null;
    }
    if (!gl || typeof gl.createShader !== 'function' || typeof gl.createBuffer !== 'function') {
      return null;
    }

    lastShaderError = null;
    const sky = linkProgram(gl, FULLSCREEN_VS, SKY_FS, 'sky');
    const cat = linkProgram(gl, CATALOG_VS, CATALOG_FS, 'catalog');
    const nebula = linkProgram(gl, NEBULA_VS, NEBULA_FS, 'nebula');
    const body = linkProgram(gl, BODY_VS, BODY_FS, 'body');
    const meteor = linkProgram(gl, METEOR_VS, METEOR_FS, 'meteor');
    const post = linkProgram(gl, FULLSCREEN_VS, POST_FS, 'post');

    const programs = [sky, cat, nebula, body, meteor, post];
    if (!sky || !cat || !nebula || !body || !meteor || !post) {
      for (const p of programs) if (p) gl.deleteProgram(p);
      return null;
    }

    const skyVbo = gl.createBuffer();
    const catVbo = gl.createBuffer();
    const nebulaVbo = gl.createBuffer();
    const bodyVbo = gl.createBuffer();
    const meteorVbo = gl.createBuffer();
    if (!skyVbo || !catVbo || !nebulaVbo || !bodyVbo || !meteorVbo) {
      for (const p of programs) if (p) gl.deleteProgram(p);
      for (const b of [skyVbo, catVbo, nebulaVbo, bodyVbo, meteorVbo]) if (b) gl.deleteBuffer(b);
      return null;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, skyVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
      gl.STATIC_DRAW,
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, catVbo);
    gl.bufferData(gl.ARRAY_BUFFER, buildCatalogBufferData(), gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, nebulaVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 64 * VERTICES_PER_NEBULA * FLOATS_PER_NEBULA_VERTEX * 4, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, bodyVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 256 * VERTICES_PER_BODY * FLOATS_PER_BODY_VERTEX * 4, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, meteorVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 18 * 4, gl.DYNAMIC_DRAW);

    return new WebGLSkyRenderer(
      gl,
      { sky, cat, nebula, body, meteor, post },
      { sky: skyVbo, cat: catVbo, nebula: nebulaVbo, body: bodyVbo, meteor: meteorVbo },
    );
  }

  private enableAttrs(locs: number[]): void {
    const gl = this.gl;
    for (let i = 0; i < 8; i += 1) {
      if (locs.includes(i)) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
  }

  private drawFullscreen(posLoc: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyVbo);
    if (posLoc >= 0) {
      this.enableAttrs([posLoc]);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 8, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  render(frame: WebGLFrameParams): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return;

    const { width, height, dpr, camera, timeSec, stars } = frame;
    if (width <= 0 || height <= 0) return;

    const deepOut = computeDeepOut(camera.zoom, frame.referenceZoom ?? camera.zoom);

    if (this.introStartSec === null) this.introStartSec = timeSec;
    const intro =
      typeof frame.intro === 'number'
        ? Math.min(1, Math.max(0, frame.intro))
        : Math.min(1, Math.max(0, (timeSec - this.introStartSec) / INTRO_DURATION_SEC));

    const pxW = Math.max(1, Math.floor(width * dpr));
    const pxH = Math.max(1, Math.floor(height * dpr));
    gl.viewport(0, 0, pxW, pxH);
    gl.clearColor(0.004, 0.008, 0.02, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. Deep-space galactic panorama
    gl.disable(gl.BLEND);
    gl.useProgram(this.skyProg);
    gl.uniform2f(this.skyLoc.resolution, width, height);
    gl.uniform1f(this.skyLoc.dpr, dpr);
    gl.uniform3f(this.skyLoc.camera, camera.x, camera.y, camera.zoom);
    gl.uniform1f(this.skyLoc.time, timeSec);
    gl.uniform1f(this.skyLoc.intro, intro);
    this.drawFullscreen(this.skyLoc.pos);

    // 2. Parallax catalog stars + foreground dust motes (additive)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.catProg);
    gl.uniform2f(this.catLoc.resolution, width, height);
    gl.uniform1f(this.catLoc.dpr, dpr);
    gl.uniform3f(this.catLoc.camera, camera.x, camera.y, camera.zoom);
    gl.uniform1f(this.catLoc.time, timeSec);
    gl.uniform1f(this.catLoc.intro, intro);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.catVbo);
    const catStride = 8 * 4;
    const catUsed = [
      this.catLoc.pos,
      this.catLoc.parallax,
      this.catLoc.size,
      this.catLoc.seed,
      this.catLoc.color,
    ].filter((x) => x >= 0);
    this.enableAttrs(catUsed);
    if (this.catLoc.pos >= 0) gl.vertexAttribPointer(this.catLoc.pos, 2, gl.FLOAT, false, catStride, 0);
    if (this.catLoc.parallax >= 0) gl.vertexAttribPointer(this.catLoc.parallax, 1, gl.FLOAT, false, catStride, 8);
    if (this.catLoc.size >= 0) gl.vertexAttribPointer(this.catLoc.size, 1, gl.FLOAT, false, catStride, 12);
    if (this.catLoc.seed >= 0) gl.vertexAttribPointer(this.catLoc.seed, 1, gl.FLOAT, false, catStride, 16);
    if (this.catLoc.color >= 0) gl.vertexAttribPointer(this.catLoc.color, 3, gl.FLOAT, false, catStride, 20);
    gl.drawArrays(gl.POINTS, 0, CATALOG_TOTAL);

    // 2.5. World-space FBM cluster nebulae cradling conversation constellations
    const nebulae = frame.nebulae;
    if (nebulae && nebulae.length > 0) {
      const neededNebFloats = nebulae.length * VERTICES_PER_NEBULA * FLOATS_PER_NEBULA_VERTEX;
      if (this.nebulaFloatData.length < neededNebFloats) {
        this.nebulaFloatData = new Float32Array(Math.ceil(neededNebFloats * 1.4));
      }
      let nebCursor = 0;
      let visibleNebVerts = 0;
      const nebZoomFade = 1.0 - 0.56 * deepOut;
      for (let i = 0; i < nebulae.length; i += 1) {
        const neb = nebulae[i];
        const sx = (neb.wx - camera.x) * camera.zoom + width * 0.5;
        const sy = (neb.wy - camera.y) * camera.zoom + height * 0.5;
        const rPx = neb.radius * camera.zoom;
        if (sx + rPx < 0 || sx - rPx > width || sy + rPx < 0 || sy - rPx > height) {
          continue;
        }
        for (let v = 0; v < VERTICES_PER_NEBULA; v += 1) {
          const [qx, qy] = QUAD_CORNERS[v];
          this.nebulaFloatData[nebCursor] = qx;
          this.nebulaFloatData[nebCursor + 1] = qy;
          this.nebulaFloatData[nebCursor + 2] = neb.wx;
          this.nebulaFloatData[nebCursor + 3] = neb.wy;
          this.nebulaFloatData[nebCursor + 4] = neb.radius;
          this.nebulaFloatData[nebCursor + 5] = neb.r;
          this.nebulaFloatData[nebCursor + 6] = neb.g;
          this.nebulaFloatData[nebCursor + 7] = neb.b;
          this.nebulaFloatData[nebCursor + 8] = neb.intensity * nebZoomFade;
          this.nebulaFloatData[nebCursor + 9] = neb.seed;
          nebCursor += FLOATS_PER_NEBULA_VERTEX;
        }
        visibleNebVerts += VERTICES_PER_NEBULA;
      }

      if (visibleNebVerts > 0) {
        gl.useProgram(this.nebulaProg);
        gl.uniform2f(this.nebulaLoc.resolution, width, height);
        gl.uniform3f(this.nebulaLoc.camera, camera.x, camera.y, camera.zoom);
        gl.uniform1f(this.nebulaLoc.time, timeSec);
        gl.uniform1f(this.nebulaLoc.intro, intro);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.nebulaVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.nebulaFloatData.subarray(0, nebCursor), gl.DYNAMIC_DRAW);

        const nebStride = FLOATS_PER_NEBULA_VERTEX * 4;
        const usedNeb = [
          this.nebulaLoc.quad,
          this.nebulaLoc.center,
          this.nebulaLoc.color,
          this.nebulaLoc.params,
        ].filter((x) => x >= 0);
        this.enableAttrs(usedNeb);

        if (this.nebulaLoc.quad >= 0) gl.vertexAttribPointer(this.nebulaLoc.quad, 2, gl.FLOAT, false, nebStride, 0);
        if (this.nebulaLoc.center >= 0) gl.vertexAttribPointer(this.nebulaLoc.center, 3, gl.FLOAT, false, nebStride, 8);
        if (this.nebulaLoc.color >= 0) gl.vertexAttribPointer(this.nebulaLoc.color, 3, gl.FLOAT, false, nebStride, 20);
        if (this.nebulaLoc.params >= 0) gl.vertexAttribPointer(this.nebulaLoc.params, 2, gl.FLOAT, false, nebStride, 32);

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.drawArrays(gl.TRIANGLES, 0, visibleNebVerts);
      }
    }

    // 3. Two-pass animated telemetry bodies
    if (stars.length > 0) {
      const neededFloats = stars.length * VERTICES_PER_BODY * FLOATS_PER_BODY_VERTEX;
      if (this.bodyFloatData.length < neededFloats) {
        this.bodyFloatData = new Float32Array(Math.ceil(neededFloats * 1.4));
      }

      let hasBlackHoles = false;
      let cursor = 0;
      for (let i = 0; i < stars.length; i += 1) {
        const s = stars[i];
        if (s.typeId === 1) hasBlackHoles = true;
        let halfExtent: number;
        if (s.typeId === 4) {
          halfExtent = s.sr * 14.0 + 38.0;
        } else if (s.typeId === 1) {
          halfExtent = Math.max(s.sr * 7.0, 30.0);
        } else if (s.typeId === 3) {
          halfExtent = s.sr * 11.5 + 26.0;
        } else {
          halfExtent = s.sr * (s.emphasized > 0.5 || s.magnitude >= 0.70 ? 11.5 : 8.0) + 16.0;
        }
        if (s.shimmer > 0.001 && s.shimmer < 0.999) {
          halfExtent = Math.max(halfExtent, s.sr * 13.0 + 20.0);
        }

        for (let v = 0; v < VERTICES_PER_BODY; v += 1) {
          const [qx, qy] = QUAD_CORNERS[v];
          this.bodyFloatData[cursor] = qx;
          this.bodyFloatData[cursor + 1] = qy;
          this.bodyFloatData[cursor + 2] = s.wx;
          this.bodyFloatData[cursor + 3] = s.wy;
          this.bodyFloatData[cursor + 4] = halfExtent;
          this.bodyFloatData[cursor + 5] = s.sr;
          this.bodyFloatData[cursor + 6] = s.magnitude;
          this.bodyFloatData[cursor + 7] = s.seed;
          this.bodyFloatData[cursor + 8] = s.r;
          this.bodyFloatData[cursor + 9] = s.g;
          this.bodyFloatData[cursor + 10] = s.b;
          this.bodyFloatData[cursor + 11] = s.typeId;
          this.bodyFloatData[cursor + 12] = s.alpha;
          this.bodyFloatData[cursor + 13] = s.emphasized;
          this.bodyFloatData[cursor + 14] = s.shimmer;
          this.bodyFloatData[cursor + 15] = s.tailAngle;
          cursor += FLOATS_PER_BODY_VERTEX;
        }
      }

      gl.useProgram(this.bodyProg);
      gl.uniform2f(this.bodyLoc.resolution, width, height);
      gl.uniform3f(this.bodyLoc.camera, camera.x, camera.y, camera.zoom);
      gl.uniform1f(this.bodyLoc.time, timeSec);
      gl.uniform1f(this.bodyLoc.intro, intro);
      gl.uniform1f(this.bodyLoc.deepOut, deepOut);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bodyVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.bodyFloatData.subarray(0, cursor), gl.DYNAMIC_DRAW);

      const stride = FLOATS_PER_BODY_VERTEX * 4;
      const usedBody = [
        this.bodyLoc.quad,
        this.bodyLoc.world,
        this.bodyLoc.geom,
        this.bodyLoc.color,
        this.bodyLoc.meta,
        this.bodyLoc.tailAngle,
      ].filter((x) => x >= 0);
      this.enableAttrs(usedBody);

      if (this.bodyLoc.quad >= 0) gl.vertexAttribPointer(this.bodyLoc.quad, 2, gl.FLOAT, false, stride, 0);
      if (this.bodyLoc.world >= 0) gl.vertexAttribPointer(this.bodyLoc.world, 2, gl.FLOAT, false, stride, 8);
      if (this.bodyLoc.geom >= 0) gl.vertexAttribPointer(this.bodyLoc.geom, 4, gl.FLOAT, false, stride, 16);
      if (this.bodyLoc.color >= 0) gl.vertexAttribPointer(this.bodyLoc.color, 3, gl.FLOAT, false, stride, 32);
      if (this.bodyLoc.meta >= 0) gl.vertexAttribPointer(this.bodyLoc.meta, 4, gl.FLOAT, false, stride, 44);
      if (this.bodyLoc.tailAngle >= 0) gl.vertexAttribPointer(this.bodyLoc.tailAngle, 1, gl.FLOAT, false, stride, 60);

      const totalVerts = stars.length * VERTICES_PER_BODY;
      if (hasBlackHoles) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(this.bodyLoc.pass, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, totalVerts);
      }

      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      gl.uniform1f(this.bodyLoc.pass, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, totalVerts);
    }

    // 4. Meteor streams (only after the intro has settled)
    if (intro >= 0.85) {
      this.renderSporadicMeteors(width, height, timeSec);
    }

    // 5. Cinematic lens vignette + film grain (multiplicative)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    gl.useProgram(this.postProg);
    gl.uniform2f(this.postLoc.resolution, width, height);
    gl.uniform1f(this.postLoc.dpr, dpr);
    gl.uniform1f(this.postLoc.time, timeSec);
    this.drawFullscreen(this.postLoc.pos);
  }

  private drawMeteorStreak(
    width: number,
    height: number,
    slotSeed: number,
    progress: number,
    isBolide: boolean,
  ): void {
    const rand = mulberry32(slotSeed);
    const startX = (0.1 + rand() * 0.8) * width;
    const startY = (0.06 + rand() * 0.45) * height;
    const dir = rand() < 0.5 ? 0.32 + rand() * 0.48 : Math.PI - (0.32 + rand() * 0.48);
    const travel = (isBolide ? 260 : 190) + rand() * 145;
    const streakLen = ((isBolide ? 125 : 88) + rand() * 52) * Math.sin(progress * Math.PI);
    const headX = startX + Math.cos(dir) * travel * progress;
    const headY = startY + Math.sin(dir) * travel * progress;
    const tailX = headX - Math.cos(dir) * streakLen;
    const tailY = headY - Math.sin(dir) * streakLen;
    const halfW = isBolide ? 1.55 : 1.1;
    const nx = -Math.sin(dir) * halfW;
    const ny = Math.cos(dir) * halfW;

    const d = this.meteorFloatData;
    d[0] = tailX - nx; d[1] = tailY - ny; d[2] = 0;
    d[3] = headX - nx; d[4] = headY - ny; d[5] = 1;
    d[6] = headX + nx; d[7] = headY + ny; d[8] = 1;
    d[9] = tailX - nx; d[10] = tailY - ny; d[11] = 0;
    d[12] = headX + nx; d[13] = headY + ny; d[14] = 1;
    d[15] = tailX + nx; d[16] = tailY + ny; d[17] = 0;

    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.meteorProg);
    gl.uniform2f(this.meteorLoc.resolution, width, height);
    const intensity = isBolide
      ? Math.pow(Math.sin(progress * Math.PI), 1.45)
      : Math.sin(progress * Math.PI) * 0.82;
    gl.uniform1f(this.meteorLoc.intensity, intensity);
    if (isBolide) {
      gl.uniform3f(this.meteorLoc.headColor, 1.0, 0.94, 0.72);
      gl.uniform3f(this.meteorLoc.tailColor, 0.56, 0.95, 0.78);
    } else {
      gl.uniform3f(this.meteorLoc.headColor, 1.0, 0.96, 0.88);
      gl.uniform3f(this.meteorLoc.tailColor, 0.48, 0.78, 1.0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meteorVbo);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);

    const usedMeteor = [this.meteorLoc.pos, this.meteorLoc.along].filter((x) => x >= 0);
    this.enableAttrs(usedMeteor);
    if (this.meteorLoc.pos >= 0) gl.vertexAttribPointer(this.meteorLoc.pos, 2, gl.FLOAT, false, 12, 0);
    if (this.meteorLoc.along >= 0) gl.vertexAttribPointer(this.meteorLoc.along, 1, gl.FLOAT, false, 12, 8);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private renderSporadicMeteors(width: number, height: number, timeSec: number): void {
    const slotA = Math.floor(timeSec / METEOR_PERIOD_PRIMARY);
    const localA = timeSec - slotA * METEOR_PERIOD_PRIMARY;
    if (localA >= 0.65 && localA <= 1.45) {
      this.drawMeteorStreak(width, height, (slotA + 1) * 0x4d455445, (localA - 0.65) / 0.8, false);
    }

    const shiftedT = timeSec + 2.4;
    const slotB = Math.floor(shiftedT / METEOR_PERIOD_BOLIDE);
    const localB = shiftedT - slotB * METEOR_PERIOD_BOLIDE;
    if (localB >= 0.9 && localB <= 1.95) {
      this.drawMeteorStreak(width, height, (slotB + 11) * 0x424f4c49, (localB - 0.9) / 1.05, true);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteBuffer(this.skyVbo);
    gl.deleteBuffer(this.catVbo);
    gl.deleteBuffer(this.nebulaVbo);
    gl.deleteBuffer(this.bodyVbo);
    gl.deleteBuffer(this.meteorVbo);
    gl.deleteProgram(this.skyProg);
    gl.deleteProgram(this.catProg);
    gl.deleteProgram(this.nebulaProg);
    gl.deleteProgram(this.bodyProg);
    gl.deleteProgram(this.meteorProg);
    gl.deleteProgram(this.postProg);
  }
}

/** Build deterministic world-space cluster nebulae enveloping each conversation constellation. */
export function buildClusterNebulae(nodes: StarNode[]): RenderableNebula[] {
  const byConv = new Map<
    string,
    { cx: number; cy: number; r: number; rCol: number; gCol: number; bCol: number; tokens: number }
  >();

  for (const node of nodes) {
    const convId = node.star.id;
    let entry = byConv.get(convId);
    if (!entry) {
      const [rCol, gCol, bCol] = hexToRgbNorm(node.color);
      entry = {
        cx: node.convCenterX,
        cy: node.convCenterY,
        r: Math.max(96, node.convRadius * 1.45),
        rCol,
        gCol,
        bCol,
        tokens: node.star.total_tokens,
      };
      byConv.set(convId, entry);
    }
  }

  const nebulae: RenderableNebula[] = [];
  for (const [convId, item] of byConv.entries()) {
    const h = fnv1a32(`${convId}:neb`);
    const logScaled = Math.log10(Math.max(item.tokens, 1000)) - 3;
    const intensity = Math.min(0.95, Math.max(0.45, 0.48 + logScaled * 0.14));
    nebulae.push({
      wx: item.cx,
      wy: item.cy,
      radius: item.r,
      r: item.rCol,
      g: item.gCol,
      b: item.bCol,
      intensity,
      seed: (h & 0xffff) / 0xffff,
    });
  }
  return nebulae;
}

/**
 * Render an offscreen 2x WebGL snapshot of the sky & optical stars for high-DPI PNG export.
 * Returns `null` cleanly if WebGL is unavailable (e.g., JSDOM tests or headless fallback).
 */
export function renderWebGLSnapshot(
  nodes: StarNode[],
  width: number,
  height: number,
  camera: CameraLike,
  timeSec: number,
  showNebulae = true,
  referenceZoom = camera.zoom,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const glCanvas = document.createElement('canvas');
  glCanvas.width = Math.max(1, Math.round(width * 2));
  glCanvas.height = Math.max(1, Math.round(height * 2));

  const renderer = WebGLSkyRenderer.create(glCanvas);
  if (!renderer) return null;

  const visualScale = Math.min(2.25, Math.max(0.38, Math.pow(Math.max(0.08, camera.zoom), 0.53)));
  const renderStars: RenderableStar[] = [];
  for (const node of nodes) {
    const sx = (node.x - camera.x) * camera.zoom + width * 0.5;
    const sy = (node.y - camera.y) * camera.zoom + height * 0.5;
    const sr = node.radius * visualScale;
    if (sx + sr * 10 < 0 || sx - sr * 10 > width || sy + sr * 10 < 0 || sy - sr * 10 > height) {
      continue;
    }
    const h = fnv1a32(node.id);
    const [r, g, b] = hexToRgbNorm(node.color);
    renderStars.push({
      wx: node.x,
      wy: node.y,
      sr,
      magnitude: node.magnitude,
      typeId: celestialTypeToId(node.request.celestial_type),
      r,
      g,
      b,
      alpha: 1,
      emphasized: 0,
      shimmer: 0,
      seed: (h & 0xffff) / 0xffff,
      tailAngle: -Math.PI * 0.82 + (((h & 0xff) / 255) - 0.5) * 0.24,
    });
  }

  renderer.render({
    width,
    height,
    dpr: 2,
    camera,
    referenceZoom,
    timeSec,
    stars: renderStars,
    nebulae: showNebulae ? buildClusterNebulae(nodes) : [],
    intro: 1,
  });
  renderer.dispose();
  return glCanvas;
}
