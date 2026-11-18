/**
 * Automated 10-Scenario Extreme Weather Video Studio:
 * Steps through SCENARIOS_10, animates camera sweeps, composites the HUD onto an offscreen 2D canvas,
 * and records 30 FPS .webm videos via MediaRecorder (saved locally by video_server.py).
 */
import { CLOUD_GENERA, STORM_TYPES } from './src/layers/AtmosphereLayer.js';

export const SCENARIOS_10 = [
  {
    id: 1,
    file: 'scenario_01_ef5_supercell_tornado.webm',
    title: '01 · EF5 Supercell Wedge Tornado & Branched 3D Lightning',
    presetBtn: 'EF5 Tornado',
    stormType: 'supercellTornado',
    cloudGenus: 'cumulonimbus',
    debugMode: 0,
    tornadoStrength: 0.95,
    hurricaneStrength: 0.0,
    tsunamiStrength: 0.35,
    whirlpoolStrength: 0.55,
    waterLevel: 1.0,
    morph: 0.65,
    peakHeight: 245,
    canyonDepth: 0.7,
    coverage: 0.84,
    densityMultiplier: 1.85,
    rainIntensity: 0.85,
    lightningIntensity: 0.95,
    fogDensity: 0.25,
    baseAltitude: 68,
    sunElevationDeg: 28,
    sunIntensity: 3.8,
    skyColor: 0x46688f,
    windSpeed: 36,
    maxSteps: 48,
    camStart: [-165, 64, 265],
    camEnd: [-110, 70, 240],
    target: [0, 68, 0],
  },
  {
    id: 2,
    file: 'scenario_02_cat5_hurricane_eyewall.webm',
    title: '02 · Category-5 Hurricane Eyewall & Spiral Rainbands',
    presetBtn: 'Cat-5 Hurricane',
    stormType: 'hurricane',
    cloudGenus: 'cumulonimbus',
    debugMode: 0,
    tornadoStrength: 0.0,
    hurricaneStrength: 1.0,
    tsunamiStrength: 0.65,
    whirlpoolStrength: 0.45,
    waterLevel: 4.5,
    morph: 0.55,
    peakHeight: 230,
    canyonDepth: 0.65,
    coverage: 0.88,
    densityMultiplier: 1.88,
    rainIntensity: 0.9,
    lightningIntensity: 0.9,
    fogDensity: 0.28,
    baseAltitude: 64,
    sunElevationDeg: 32,
    sunIntensity: 3.9,
    skyColor: 0x44678d,
    windSpeed: 40,
    maxSteps: 48,
    camStart: [-180, 74, 265],
    camEnd: [-125, 82, 235],
    target: [0, 75, 0],
  },
  {
    id: 3,
    file: 'scenario_03_waterspout_whirlpool_dsu.webm',
    title: '03 · Dual-Vortex Coupling: Maritime Waterspout + Whirlpool Maelstrom',
    presetBtn: 'EF5 Tornado',
    stormType: 'waterspout',
    cloudGenus: 'cumulonimbus',
    debugMode: 0,
    tornadoStrength: 0.92,
    hurricaneStrength: 0.0,
    tsunamiStrength: 0.2,
    whirlpoolStrength: 1.0,
    waterLevel: 0.0,
    morph: 0.45,
    peakHeight: 210,
    canyonDepth: 0.6,
    coverage: 0.76,
    densityMultiplier: 1.75,
    rainIntensity: 0.45,
    lightningIntensity: 0.65,
    fogDensity: 0.18,
    baseAltitude: 72,
    sunElevationDeg: 35,
    sunIntensity: 4.0,
    skyColor: 0x4f82bd,
    windSpeed: 28,
    maxSteps: 48,
    camStart: [-135, 84, 215],
    camEnd: [-75, 76, 195],
    target: [10, 42, -10],
  },
  {
    id: 4,
    file: 'scenario_04_derecho_arcus_tsunami.webm',
    title: '04 · Derecho Squall Line Shelf Cloud & Giant Tsunami Soliton Wave',
    presetBtn: 'EF5 Tornado',
    stormType: 'derecho',
    cloudGenus: 'cumulonimbus',
    debugMode: 0,
    tornadoStrength: 0.35,
    hurricaneStrength: 0.0,
    tsunamiStrength: 1.0,
    whirlpoolStrength: 0.3,
    waterLevel: 3.0,
    morph: 0.72,
    peakHeight: 265,
    canyonDepth: 0.78,
    coverage: 0.82,
    densityMultiplier: 1.8,
    rainIntensity: 0.75,
    lightningIntensity: 0.85,
    fogDensity: 0.22,
    baseAltitude: 68,
    sunElevationDeg: 30,
    sunIntensity: 3.9,
    skyColor: 0x4972a3,
    windSpeed: 36,
    maxSteps: 48,
    camStart: [-155, 56, 255],
    camEnd: [-95, 62, 225],
    target: [0, 52, 0],
  },
  {
    id: 5,
    file: 'scenario_05_noreaster_bomb_cyclone.webm',
    title: "05 · Nor'easter Bomb Cyclone & +11.5m King-Tide Canyon Surge",
    presetBtn: 'Cat-5 Hurricane',
    stormType: 'norEaster',
    cloudGenus: 'nimbostratus',
    debugMode: 0,
    tornadoStrength: 0.3,
    hurricaneStrength: 0.65,
    tsunamiStrength: 0.8,
    whirlpoolStrength: 0.5,
    waterLevel: 11.5,
    morph: 0.78,
    peakHeight: 280,
    canyonDepth: 0.82,
    coverage: 0.86,
    densityMultiplier: 1.78,
    rainIntensity: 0.82,
    lightningIntensity: 0.7,
    fogDensity: 0.35,
    baseAltitude: 64,
    sunElevationDeg: 28,
    sunIntensity: 3.8,
    skyColor: 0x486d99,
    windSpeed: 34,
    maxSteps: 48,
    camStart: [-165, 68, 250],
    camEnd: [-105, 64, 215],
    target: [0, 58, 0],
  },
  {
    id: 6,
    file: 'scenario_06_dusk_lightning_barrage.webm',
    title: '06 · Golden-Dusk Supercell & 100% Branched 3D Lightning Barrage',
    presetBtn: 'EF5 Tornado',
    stormType: 'supercellTornado',
    cloudGenus: 'cumulonimbus',
    debugMode: 0,
    tornadoStrength: 0.8,
    hurricaneStrength: 0.0,
    tsunamiStrength: 0.45,
    whirlpoolStrength: 0.4,
    waterLevel: 0.0,
    morph: 0.62,
    peakHeight: 245,
    canyonDepth: 0.7,
    coverage: 0.82,
    densityMultiplier: 1.82,
    rainIntensity: 0.7,
    lightningIntensity: 1.0,
    fogDensity: 0.2,
    baseAltitude: 68,
    sunElevationDeg: 22,
    sunColor: 0xffb870,
    sunIntensity: 4.2,
    skyColor: 0x4a6688,
    windSpeed: 32,
    maxSteps: 48,
    camStart: [-160, 62, 260],
    camEnd: [-100, 68, 230],
    target: [0, 68, 0],
  },
  {
    id: 7,
    file: 'scenario_07_dense_advection_sea_fog.webm',
    title: '07 · Heavy Beer-Lambert Advection Sea Fog & Low Stratus Deck',
    presetBtn: 'Trade Winds',
    stormType: 'none',
    cloudGenus: 'stratus',
    debugMode: 0,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.0,
    tsunamiStrength: 0.25,
    whirlpoolStrength: 0.0,
    waterLevel: 2.0,
    morph: 0.68,
    peakHeight: 255,
    canyonDepth: 0.72,
    coverage: 0.88,
    densityMultiplier: 1.65,
    rainIntensity: 0.25,
    lightningIntensity: 0.0,
    fogDensity: 1.0,
    baseAltitude: 55,
    sunElevationDeg: 32,
    sunIntensity: 3.9,
    skyColor: 0x628bb8,
    windSpeed: 14,
    maxSteps: 48,
    camStart: [-135, 48, 225],
    camEnd: [-80, 44, 195],
    target: [0, 48, 0],
  },
  {
    id: 8,
    file: 'scenario_08_golden_hour_archipelago.webm',
    title: '08 · Trade-Winds Coastal Archipelago & Silver-Lining Cumulus',
    presetBtn: 'Trade Winds',
    stormType: 'none',
    cloudGenus: 'cumulus',
    debugMode: 0,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.0,
    tsunamiStrength: 0.5,
    whirlpoolStrength: 0.5,
    waterLevel: -4.0,
    morph: 0.08,
    peakHeight: 185,
    canyonDepth: 0.35,
    coverage: 0.64,
    densityMultiplier: 1.72,
    rainIntensity: 0.0,
    lightningIntensity: 0.0,
    fogDensity: 0.14,
    baseAltitude: 92,
    sunElevationDeg: 34,
    sunIntensity: 4.1,
    skyColor: 0x4f86c6,
    windSpeed: 16,
    maxSteps: 48,
    camStart: [-165, 64, 265],
    camEnd: [-105, 70, 235],
    target: [0, 64, 0],
  },
  {
    id: 9,
    file: 'scenario_09_beer_lambert_transmittance.webm',
    title: '09 · Shader Pass 2: Beer-Lambert Optical Transmittance Heatmap',
    presetBtn: 'EF5 Tornado',
    stormType: 'supercellTornado',
    cloudGenus: 'cumulonimbus',
    debugMode: 1,
    tornadoStrength: 1.0,
    hurricaneStrength: 0.0,
    tsunamiStrength: 0.7,
    whirlpoolStrength: 0.85,
    waterLevel: 0.0,
    morph: 0.65,
    peakHeight: 245,
    canyonDepth: 0.7,
    coverage: 0.86,
    densityMultiplier: 2.1,
    rainIntensity: 0.85,
    lightningIntensity: 0.85,
    fogDensity: 0.22,
    baseAltitude: 66,
    sunElevationDeg: 28,
    sunIntensity: 3.6,
    skyColor: 0x46688f,
    windSpeed: 34,
    maxSteps: 48,
    camStart: [-165, 64, 260],
    camEnd: [-105, 72, 225],
    target: [0, 68, 0],
  },
  {
    id: 10,
    file: 'scenario_10_3d_noise_topographic_airflow.webm',
    title: '10 · Shader Pass 4: 3D Perlin-Worley Noise & Topographic Airflow Slice',
    presetBtn: 'Cat-5 Hurricane',
    stormType: 'hurricane',
    cloudGenus: 'altocumulus',
    debugMode: 3,
    tornadoStrength: 0.45,
    hurricaneStrength: 0.95,
    tsunamiStrength: 0.6,
    whirlpoolStrength: 0.6,
    waterLevel: 2.0,
    morph: 0.88,
    peakHeight: 325,
    canyonDepth: 0.85,
    coverage: 0.82,
    densityMultiplier: 2.0,
    rainIntensity: 0.4,
    lightningIntensity: 0.5,
    fogDensity: 0.18,
    baseAltitude: 85,
    sunElevationDeg: 34,
    sunIntensity: 3.8,
    skyColor: 0x4f86c6,
    windSpeed: 38,
    maxSteps: 48,
    camStart: [-170, 76, 255],
    camEnd: [-110, 84, 220],
    target: [0, 76, 0],
  },
];

function applyScenarioState(ctx, sc) {
  const { atmosphere, hydroState, terrainState, terrain, syncVortexAndUI, syncSceneLighting, refreshControlReadouts } = ctx;
  atmosphere.setStormType(sc.stormType);
  atmosphere.setCloudGenus(sc.cloudGenus);
  atmosphere.setDebugMode(sc.debugMode);
  hydroState.tornadoStrength = sc.tornadoStrength;
  hydroState.hurricaneStrength = sc.hurricaneStrength;
  hydroState.tsunamiStrength = sc.tsunamiStrength;
  hydroState.whirlpoolStrength = sc.whirlpoolStrength;
  hydroState.waterLevel = sc.waterLevel;
  terrainState.morph = sc.morph;
  terrainState.peakHeight = sc.peakHeight;
  terrainState.canyonDepth = sc.canyonDepth;
  terrain.updateGeometry();

  atmosphere.setEnvironment({
    tornadoStrength: sc.tornadoStrength,
    hurricaneStrength: sc.hurricaneStrength,
    coverage: sc.coverage,
    densityMultiplier: sc.densityMultiplier,
    rainIntensity: sc.rainIntensity,
    lightningIntensity: sc.lightningIntensity,
    fogDensity: sc.fogDensity,
    baseAltitude: sc.baseAltitude,
    sunElevationDeg: sc.sunElevationDeg,
    sunColor: sc.sunColor ?? 0xfff5e0,
    sunIntensity: sc.sunIntensity ?? 3.8,
    skyColor: sc.skyColor ?? 0x4f86c6,
    windSpeed: sc.windSpeed,
    maxSteps: sc.maxSteps,
  });
  syncVortexAndUI();
  syncSceneLighting();
  refreshControlReadouts();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    if (ctx.measureText(testLine).width > maxWidth && n > 0) {
      ctx.fillText(line, x, curY);
      line = words[n] + ' ';
      curY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, curY);
  return curY + lineHeight;
}

const DEBUG_NAMES = [
  '1: Final Composite (Lit Clouds + Rain)',
  '2: Optical Transmittance T (Cloud Opacity Map)',
  '3: Radial Scene Depth tScene (50m Contours)',
  '4: 3D Noise & Topographic Airflow Slice',
];

// Renders the exact left .hud-header card and right .hud-controls panel from the screenshots
function drawScreenshotStyleHud(ctx2d, w, h, sc, simCtx) {
  const s = simCtx.atmosphere.state;
  const p = simCtx.fluidClusterParticles;
  const t = simCtx.terrainState;
  const hs = simCtx.hydroState;
  const genusMeta = CLOUD_GENERA[s.cloudGenus] || CLOUD_GENERA.cumulus;
  const stormMeta = STORM_TYPES[s.stormType] || STORM_TYPES.none;

  // 1. Left .hud-header Card (matches index.html .hud-header)
  const lx = 14, ly = 14, lw = 350, lh = 165;
  roundRect(ctx2d, lx, ly, lw, lh, 8);
  ctx2d.fillStyle = 'rgba(11, 17, 26, 0.88)';
  ctx2d.fill();
  ctx2d.strokeStyle = 'rgba(110, 168, 224, 0.28)';
  ctx2d.lineWidth = 1;
  ctx2d.stroke();

  ctx2d.fillStyle = '#38bdf8';
  ctx2d.font = '600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx2d.fillText('ATMOSPHERE LAYER // WEBGL2', lx + 14, ly + 24);

  ctx2d.fillStyle = '#94a3b8';
  ctx2d.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  let nextY = wrapText(
    ctx2d,
    'Volumetric clouds (10 WMO genera), 6 storm regimes, 3D lightning, vertex-displaced tsunami & whirlpool waves, Spatial-Hash + Union-Find physics, and Saronic ASV fleet.',
    lx + 14,
    ly + 42,
    lw - 28,
    15
  );

  ctx2d.strokeStyle = 'rgba(110, 168, 224, 0.18)';
  ctx2d.beginPath();
  ctx2d.moveTo(lx + 14, nextY - 4);
  ctx2d.lineTo(lx + lw - 14, nextY - 4);
  ctx2d.stroke();

  ctx2d.fillStyle = '#38bdf8';
  ctx2d.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx2d.fillText(sc.title, lx + 14, nextY + 12);

  ctx2d.fillStyle = '#cbd5e1';
  ctx2d.font = '10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  wrapText(
    ctx2d,
    `[${stormMeta.name}] ${genusMeta.name} · ${genusMeta.etage}: ${genusMeta.description}`,
    lx + 14,
    nextY + 28,
    lw - 28,
    14
  );

  // 2. Right .hud-controls Panel (matches index.html .hud-controls)
  const rw = 296, rx = w - rw - 14, ry = 14, rh = h - 28;
  roundRect(ctx2d, rx, ry, rw, rh, 8);
  ctx2d.fillStyle = 'rgba(11, 17, 26, 0.88)';
  ctx2d.fill();
  ctx2d.strokeStyle = 'rgba(110, 168, 224, 0.28)';
  ctx2d.stroke();

  let cy = ry + 18;
  ctx2d.fillStyle = '#94a3b8';
  ctx2d.font = '700 9.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx2d.fillText('OPERATIONAL WEATHER & STORM PRESETS', rx + 12, cy);
  cy += 8;

  const presets = ['Trade Winds', 'High Cirrus', 'EF5 Tornado', 'Cat-5 Hurricane'];
  const bw = (rw - 30) / 2, bh = 22;
  presets.forEach((name, idx) => {
    const col = idx % 2, row = Math.floor(idx / 2);
    const bx = rx + 12 + col * (bw + 6);
    const by = cy + row * (bh + 5);
    const active = sc.presetBtn === name;
    roundRect(ctx2d, bx, by, bw, bh, 4);
    ctx2d.fillStyle = active ? 'rgba(56, 189, 248, 0.18)' : 'rgba(30, 41, 59, 0.75)';
    ctx2d.fill();
    ctx2d.strokeStyle = active ? '#38bdf8' : 'rgba(110, 168, 224, 0.24)';
    ctx2d.stroke();
    ctx2d.fillStyle = active ? '#ffffff' : '#e2e8f0';
    ctx2d.font = `${active ? '600' : '400'} 10.5px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx2d.fillText(name, bx + 10, by + 15);
  });
  cy += 60;

  // Select boxes (Storm, Genus, Debug View)
  const selects = [
    ['STORM SYSTEM REGIME (6 TYPES)', stormMeta.name],
    ['WMO CLOUD GENUS (10 TYPES)', genusMeta.name],
    ['SHADER DEBUG VIEW (KEYS 1–4)', DEBUG_NAMES[s.debugMode] || DEBUG_NAMES[0]],
  ];
  for (const [label, val] of selects) {
    ctx2d.fillStyle = '#94a3b8';
    ctx2d.font = '700 9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx2d.fillText(label, rx + 12, cy);
    cy += 5;
    roundRect(ctx2d, rx + 12, cy, rw - 24, 21, 4);
    ctx2d.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx2d.fill();
    ctx2d.strokeStyle = 'rgba(110, 168, 224, 0.26)';
    ctx2d.stroke();
    ctx2d.fillStyle = '#e2e8f0';
    ctx2d.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx2d.fillText(val, rx + 18, cy + 14);
    cy += 29;
  }

  // Sliders (Vortex, Hurricane, Tsunami, Whirlpool, Tide, Morph, Coverage, Lightning, Fog)
  ctx2d.fillStyle = '#94a3b8';
  ctx2d.font = '700 9px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx2d.fillText('VORTEX, TSUNAMI, WHIRLPOOL, LIGHTNING & FOG', rx + 12, cy);
  cy += 8;

  const sliders = [
    ['Tornado / Waterspout Vortex', `${Math.round(hs.tornadoStrength * 100)}%`, hs.tornadoStrength],
    ['Hurricane Eyewall & Bands', `${Math.round(hs.hurricaneStrength * 100)}%`, hs.hurricaneStrength],
    ['Tsunami Soliton Wave', `${Math.round(hs.tsunamiStrength * 100)}%`, hs.tsunamiStrength],
    ['Whirlpool Maelstrom', `${Math.round(hs.whirlpoolStrength * 100)}%`, hs.whirlpoolStrength],
    ['Tidal Sea Level', simCtx.formatTideLabel(hs.waterLevel), (hs.waterLevel + 5) / 17],
    ['Islands → Canyon Morph', simCtx.formatMorphLabel(t.morph), t.morph],
    ['Cloud Coverage', `${Math.round(s.coverage * 100)}%`, s.coverage],
    ['Lightning Bolts & Flash', `${Math.round(s.lightningIntensity * 100)}%`, s.lightningIntensity],
    ['Atmospheric Fog & Haze', `${Math.round(s.fogDensity * 100)}%`, s.fogDensity],
  ];

  const sw = rw - 24;
  for (const [label, valStr, norm] of sliders) {
    ctx2d.fillStyle = '#e2e8f0';
    ctx2d.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx2d.fillText(label, rx + 12, cy + 8);
    ctx2d.fillStyle = '#38bdf8';
    ctx2d.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx2d.measureText(valStr).width;
    ctx2d.fillText(valStr, rx + rw - 12 - tw, cy + 8);

    // Slider track
    const ty = cy + 13;
    const clamped = Math.min(1, Math.max(0, norm));
    roundRect(ctx2d, rx + 12, ty, sw, 4, 2);
    ctx2d.fillStyle = 'rgba(51, 65, 85, 0.85)';
    ctx2d.fill();
    roundRect(ctx2d, rx + 12, ty, Math.max(4, sw * clamped), 4, 2);
    ctx2d.fillStyle = '#38bdf8';
    ctx2d.fill();

    ctx2d.beginPath();
    ctx2d.arc(rx + 12 + sw * clamped, ty + 2, 4.5, 0, Math.PI * 2);
    ctx2d.fillStyle = '#38bdf8';
    ctx2d.fill();

    cy += 22;
  }

  // Bottom 2x2 Telemetry Grid (matches .telemetry-grid)
  cy += 4;
  ctx2d.fillStyle = '#94a3b8';
  ctx2d.font = '700 9px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx2d.fillText('LIVE FRAME & UNION-FIND TELEMETRY', rx + 12, cy);
  cy += 5;

  roundRect(ctx2d, rx + 12, cy, rw - 24, 52, 6);
  ctx2d.fillStyle = 'rgba(7, 13, 20, 0.78)';
  ctx2d.fill();
  ctx2d.strokeStyle = 'rgba(110, 168, 224, 0.18)';
  ctx2d.stroke();

  const tele = [
    ['Frame Rate', document.getElementById('stat-fps')?.textContent || '30 FPS', 0, 0],
    ['Cloud GPU Pass', document.getElementById('stat-gpu')?.textContent || '14.2 ms', 1, 0],
    ['Union-Find Clusters', `${p.activeClusters} (Max: ${p.largestCluster})`, 0, 1],
    ['DSU Land / Water', `${t.islandCount} Isl / ${t.waterBasinCount} Sea`, 1, 1],
  ];
  for (const [k, v, col, row] of tele) {
    const tx = rx + 20 + col * ((rw - 36) / 2);
    const ty = cy + 13 + row * 22;
    ctx2d.fillStyle = '#94a3b8';
    ctx2d.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx2d.fillText(k, tx, ty);
    ctx2d.fillStyle = '#f8fafc';
    ctx2d.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx2d.fillText(v, tx, ty + 11);
  }
}

async function recordSingleScenario(simCtx, sc, recCanvas, recCtx, durationMs = 2300) {
  applyScenarioState(simCtx, sc);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';

  const stream = recCanvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

  recorder.start(100);
  const t0 = performance.now();

  await new Promise((resolve) => {
    function stepFrame() {
      const now = performance.now();
      const u = Math.min(1, (now - t0) / durationMs);

      const cx = sc.camStart[0] + (sc.camEnd[0] - sc.camStart[0]) * u;
      const cy = sc.camStart[1] + (sc.camEnd[1] - sc.camStart[1]) * u;
      const cz = sc.camStart[2] + (sc.camEnd[2] - sc.camStart[2]) * u;
      simCtx.camera.position.set(cx, cy, cz);
      simCtx.controls.target.set(sc.target[0], sc.target[1], sc.target[2]);
      simCtx.controls.update();

      recCtx.drawImage(simCtx.renderer.domElement, 0, 0, recCanvas.width, recCanvas.height);
      drawScreenshotStyleHud(recCtx, recCanvas.width, recCanvas.height, sc, simCtx);

      if (u < 1) {
        requestAnimationFrame(stepFrame);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(stepFrame);
  });

  recorder.stop();
  const blob = await stopped;

  await fetch(`/save-video?name=${encodeURIComponent(sc.file)}`, {
    method: 'POST',
    body: blob,
  });
  return blob.size;
}

/** Mounts the "Record 10 Extreme Weather Videos" studio panel into the HUD and binds MediaRecorder. */
function initScenarioRecorderUI() {
  const simCtx = window.simulationContext;
  if (!simCtx) return;

  const aside = document.querySelector('.hud-controls');
  if (!aside) return;

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="section-title">10-Scenario Extreme Weather Video Studio</div>
    <button id="btn-record-10" class="preset-btn" style="width:100%;font-weight:600;border-color:#38bdf8;color:#38bdf8;">
      Record 10 Extreme Weather Videos
    </button>
    <div id="record-10-status" style="margin-top:4px;font-family:var(--mono);font-size:11px;color:#34d399;">
      READY (10 Scenarios)
    </div>
  `;
  aside.insertBefore(box, aside.firstChild);

  const btn = document.getElementById('btn-record-10');
  const statusEl = document.getElementById('record-10-status');

  const recCanvas = document.createElement('canvas');
  recCanvas.width = 960;
  recCanvas.height = 540;
  const recCtx = recCanvas.getContext('2d');

  let running = false;
  async function runAll10() {
    if (running) return;
    running = true;
    btn.disabled = true;
    for (let i = 0; i < SCENARIOS_10.length; i++) {
      const sc = SCENARIOS_10[i];
      statusEl.textContent = `RECORDING ${i + 1}/10: ${sc.file}...`;
      await recordSingleScenario(simCtx, sc, recCanvas, recCtx, 2300);
    }
    statusEl.textContent = '10/10 VIDEOS SAVED';
    btn.disabled = false;
    running = false;
  }

  btn.addEventListener('click', runAll10);

  if (window.location.search.includes('record10=1')) {
    setTimeout(runAll10, 500);
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initScenarioRecorderUI);
} else {
  initScenarioRecorderUI();
}
