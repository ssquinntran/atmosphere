/**
 * Automated Node.js Unit, Front-End DOM Contract, and 4-Phase Live Physics Test Runner.
 * Boots a mock browser DOM, executes all 14 suites, and prints a V8 code coverage report.
 */
import inspector from 'inspector';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/** Builds an in-memory mock DOM (elements, sliders, 2D canvas, RAF queue, and window events) for src/main.js. */
export function setupMockBrowserEnvironment() {
  const elementsById = new Map();
  const presetBtns = [];

  function createMockElement(id, tagName = 'DIV') {
    const listeners = {};
    const classListSet = new Set();
    const el = {
      id,
      tagName,
      value: '0',
      textContent: '',
      innerHTML: '',
      dataset: {},
      width: 512,
      height: 128,
      classList: {
        add: (c) => classListSet.add(c),
        remove: (c) => classListSet.delete(c),
        contains: (c) => classListSet.has(c),
      },
      addEventListener(type, cb) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(cb);
      },
      dispatchEvent(event) {
        for (const fn of listeners[event.type] || []) fn(event);
      },
      click() {
        el.dispatchEvent({ type: 'click', target: el });
      },
      getContext(ctxType) {
        if (ctxType !== '2d') return null;
        return {
          fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', letterSpacing: '', textAlign: 'left',
          fillRect() {}, strokeRect() {}, save() {}, restore() {}, translate() {},
          beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, fillText() {},
        };
      },
    };
    if (id) elementsById.set(id, el);
    return el;
  }

  createMockElement('viewport', 'CANVAS');
  for (const id of ['ctrl-storm', 'ctrl-genus', 'ctrl-debug']) createMockElement(id, 'SELECT');
  for (const key of ['tornado', 'hurricane', 'tsunami', 'whirlpool', 'tide', 'terrain-morph', 'peak-height', 'canyon-depth', 'coverage', 'density', 'rain', 'lightning', 'fog', 'base', 'sun', 'wind', 'steps']) {
    createMockElement(`ctrl-${key}`, 'INPUT');
    createMockElement(`val-${key}`, 'SPAN');
  }
  for (const id of ['genus-info', 'debug-caption', 'stat-fps', 'stat-gpu', 'stat-clusters', 'stat-topology']) {
    createMockElement(id, 'DIV');
  }

  for (const presetName of ['tradeWinds', 'clearPatrol', 'squall', 'hurricane']) {
    const btn = createMockElement(`btn-${presetName}`, 'BUTTON');
    btn.dataset.preset = presetName;
    if (presetName === 'tradeWinds') btn.classList.add('active');
    presetBtns.push(btn);
  }

  let rafCallback = null;
  let rafCounter = 1;
  const winListeners = {};

  globalThis.window = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    atmosphereLayer: null,
    addEventListener(type, cb) { if (!winListeners[type]) winListeners[type] = []; winListeners[type].push(cb); },
    dispatchEvent(event) { for (const fn of winListeners[event.type] || []) fn(event); },
  };

  globalThis.document = {
    getElementById: (id) => elementsById.get(id) || createMockElement(id),
    querySelectorAll: (sel) => (sel === '.preset-btn' ? presetBtns : []),
    createElement: (tag) => createMockElement(null, tag.toUpperCase()),
  };

  let nowTime = 1000;
  globalThis.performance = {
    now: () => nowTime,
    _advance: (ms) => (nowTime += ms),
  };

  globalThis.requestAnimationFrame = (cb) => { rafCallback = cb; return ++rafCounter; };
  globalThis.cancelAnimationFrame = () => { rafCallback = null; };

  return {
    elementsById,
    presetBtns,
    stepAnimationFrame(deltaMs = 16.67) {
      const t = globalThis.performance._advance(deltaMs);
      const cb = rafCallback;
      if (cb) cb(t);
    },
    getRafCallback: () => rafCallback,
  };
}

function startCoverageSession() {
  const session = new inspector.Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  return session;
}

function stopAndComputeCoverage(session) {
  let result = null;
  session.post('Profiler.takePreciseCoverage', (err, data) => {
    if (err) throw err;
    result = data.result;
  });
  session.post('Profiler.stopPreciseCoverage');
  session.disconnect();

  const srcDir = path.join(projectRoot, 'src');
  const fileStats = [];

  for (const entry of result) {
    if (!entry.url.startsWith('file://')) continue;
    const filePath = fileURLToPath(entry.url);
    if (!filePath.startsWith(srcDir)) continue;

    const relPath = path.relative(projectRoot, filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const lines = source.split('\n');

    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }

    const charCounts = new Int32Array(source.length).fill(1);
    const allRanges = [];
    for (const fn of entry.functions) {
      for (const r of fn.ranges) allRanges.push(r);
    }
    allRanges.sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    for (let idx = allRanges.length - 1; idx >= 0; idx--) {
      const r = allRanges[idx];
      const start = Math.max(0, r.startOffset);
      const end = Math.min(source.length, r.endOffset);
      for (let c = start; c < end; c++) charCounts[c] = r.count;
    }

    let executableLines = 0, coveredLines = 0;
    const uncoveredLineNumbers = [];

    for (let l = 0; l < lines.length; l++) {
      const trimmed = lines[l].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '};' || trimmed === '}') continue;
      executableLines++;
      const lStart = lineStarts[l], lEnd = lStart + lines[l].length;
      let lineHit = false;
      for (let c = lStart; c < lEnd; c++) {
        if (charCounts[c] > 0) { lineHit = true; break; }
      }
      if (lineHit) coveredLines++;
      else uncoveredLineNumbers.push(l + 1);
    }

    const totalFns = entry.functions.filter((f) => f.functionName !== '').length || 1;
    const coveredFns =
      entry.functions.filter((f) => f.functionName !== '' && f.ranges.some((r) => r.count > 0)).length ||
      (entry.functions.every((f) => f.ranges.some((r) => r.count > 0)) ? 1 : 0);

    const totalBranches = allRanges.length;
    const coveredBranches = allRanges.filter((r) => r.count > 0).length;

    fileStats.push({
      file: relPath,
      executableLines,
      coveredLines,
      linePct: executableLines ? (coveredLines / executableLines) * 100 : 100,
      totalFns,
      coveredFns,
      fnPct: totalFns ? (coveredFns / totalFns) * 100 : 100,
      totalBranches,
      coveredBranches,
      branchPct: totalBranches ? (coveredBranches / totalBranches) * 100 : 100,
      uncoveredLineNumbers,
    });
  }

  return fileStats.sort((a, b) => a.file.localeCompare(b.file));
}

async function runAllSuites() {
  const domEnv = setupMockBrowserEnvironment();
  const covSession = startCoverageSession();
  const results = [];

  async function runTest(suiteName, testName, fn) {
    try {
      await fn();
      results.push({ suiteName, testName, passed: true });
      console.log(`  ✓ [${suiteName}] ${testName}`);
    } catch (err) {
      results.push({ suiteName, testName, passed: false, error: err });
      console.error(`  ✗ [${suiteName}] ${testName}: ${err.message}`);
    }
  }

  console.log('\n======================================================================');
  console.log(' ATMOSPHERE LAYER — UNIT & INTEGRATION TEST SUITE');
  console.log('======================================================================\n');

  const THREE = await import('three');
  const { atmosphereVertexShader } = await import('../src/shaders/atmosphere.vert.js');
  const { atmosphereFragmentShader } = await import('../src/shaders/atmosphere.frag.js');
  const { CloudNoiseBaker } = await import('../src/noise/CloudNoiseBaker.js');
  const {
    DisjointSetUnion,
    SpatialHashGrid3D,
    analyzeTerrainTopologyUnionFind,
    LagrangianVortexParticleSystem,
  } = await import('../src/physics/FluidClusterPhysics.js');
  const {
    AtmosphereLayer,
    CLOUD_GENERA,
    STORM_TYPES,
    WEATHER_PRESETS,
    DEBUG_MODES,
  } = await import('../src/layers/AtmosphereLayer.js');
  const { OceanLayer } = await import('../src/layers/OceanLayer.js');

  await runTest('Unit: DisjointSetUnion', 'Initializes singleton sets & handles reset(0) edge case', () => {
    const dsu = new DisjointSetUnion(8);
    assert.strictEqual(dsu.numComponents, 8);
    assert.strictEqual(dsu.maxClusterSize, 1);
    for (let i = 0; i < 8; i++) {
      assert.strictEqual(dsu.find(i), i);
      assert.strictEqual(dsu.getComponentSize(i), 1);
    }
    dsu.reset(0);
    assert.strictEqual(dsu.numComponents, 0);
    assert.strictEqual(dsu.maxClusterSize, 0);
  });

  await runTest('Unit: DisjointSetUnion', 'Performs Union by Size (both branches) and Path Compression', () => {
    const dsu = new DisjointSetUnion(10);
    dsu.union(0, 1);
    dsu.union(2, 3);
    dsu.union(2, 4);
    assert.strictEqual(dsu.getComponentSize(0), 2);
    assert.strictEqual(dsu.getComponentSize(2), 3);

    const mergedRoot = dsu.union(0, 2);
    assert.strictEqual(dsu.getComponentSize(mergedRoot), 5);
    assert.strictEqual(dsu.maxClusterSize, 5);
    assert.strictEqual(dsu.numComponents, 6);
    assert.strictEqual(dsu.union(1, 4), mergedRoot);

    dsu.union(5, 6);
    dsu.union(7, 8);
    dsu.union(5, 7);
    assert.strictEqual(dsu.find(8), dsu.find(5));
    assert.strictEqual(dsu.parent[8], dsu.find(5));
  });

  await runTest('Unit: SpatialHashGrid3D', 'Hashes 3D particles & clusters neighbors in O(N) with momentum coupling', () => {
    const count = 6;
    const grid = new SpatialHashGrid3D(count, 20.0, 256);
    const dsu = new DisjointSetUnion(count);
    grid.clear();

    const positions = new Float32Array([0, 10, 0, 4, 11, 3, -3, 10, -2, 200, 10, 200, -200, 50, -200, 400, 80, -400]);
    const velocities = new Float32Array([10, 0, 0, 0, 0, 10, 5, 0, 5, 1, 0, 1, -1, 0, -1, 0, 1, 0]);

    for (let i = 0; i < count; i++) grid.insert(i, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    grid.clusterNeighbors(positions, velocities, count, 12.0, dsu);

    assert.strictEqual(dsu.getComponentSize(0), 3);
    assert.strictEqual(dsu.find(0), dsu.find(1));
    assert.strictEqual(dsu.find(1), dsu.find(2));
    assert.strictEqual(dsu.getComponentSize(3), 1);
    assert.strictEqual(dsu.numComponents, 4);
  });

  await runTest('Unit: analyzeTerrainTopologyUnionFind', 'Counts connected islands and flooded sea basins across tide levels', () => {
    const gridRes = 41;
    const heights = new Float32Array(gridRes * gridRes).fill(-10.0);
    for (let z = 4; z <= 14; z++) for (let x = 4; x <= 14; x++) heights[z * gridRes + x] = 50.0;
    for (let z = 24; z <= 34; z++) for (let x = 24; x <= 34; x++) heights[z * gridRes + x] = 20.0;

    const meanTopo = analyzeTerrainTopologyUnionFind(heights, gridRes, 0.0);
    assert.strictEqual(meanTopo.islandCount, 2);
    assert.strictEqual(meanTopo.waterBasinCount, 1);

    const floodTopo = analyzeTerrainTopologyUnionFind(heights, gridRes, 25.0);
    assert.strictEqual(floodTopo.islandCount, 1);
    assert.strictEqual(floodTopo.waterBasinCount, 1);
  });

  await runTest('Unit: LagrangianVortexParticleSystem', 'Simulates Rankine tornado, whirlpool, tsunami, buoyancy & terrain collision', () => {
    const sys = new LagrangianVortexParticleSystem(60);
    sys.positions.set([
      5, 15, 5,       // 0: tornado inner core
      85, 25, 0,      // 1: tornado outer swirl
      2, 5, -8,       // 2: whirlpool inner core
      60, 8, -10,     // 3: whirlpool outer core
      0, 10, 100,     // 4: tsunami front
      -50, -5, -50,   // 5: below water surface
      150, 20, 150,   // 6: mountain slope collision
      550, 30, 0,     // 7: out of bounds respawn
      0, 1, -10,      // 8: whirlpool center sink
    ]);
    sys.velocities[16] = -12.0;

    for (let step = 0; step < 6; step++) {
      sys.update(0.016, {
        windVecXZ: { x: 12.0, y: 8.0 },
        tornadoStrength: 0.9,
        tornadoCenterXZ: { x: 0.0, y: 0.0 },
        hurricaneStrength: 0.9,
        whirlpoolStrength: 0.85,
        whirlpoolCenterXZ: { x: 0.0, y: -10.0 },
        tsunamiStrength: 0.9,
        tsunamiZ: 100.0,
        waterLevel: 0.0,
        cloudBaseY: 90.0,
        sampleTerrain: (x, z) => (x > 120 && z > 120 ? { h: 85.0, gx: 0.6, gz: 0.5, funnel: 0.0 } : { h: 0.0, gx: 0.0, gz: 0.0, funnel: 0.8 }),
        sampleWaterHeight: () => 0.0,
      });
    }
    assert.ok(sys.activeClusters >= 1 && sys.activeClusters <= 60);
    assert.ok(sys.largestCluster >= 1);
  });

  await runTest('Unit: CloudNoiseBaker', 'Bakes 3D Perlin-Worley volume textures, weather map & blue noise jitter', () => {
    const renderer = new THREE.WebGLRenderer();
    const macroTex = CloudNoiseBaker.bakeVolumeTexture(renderer, 16, 4, 4.0);
    assert.strictEqual(macroTex.width, 16);
    assert.strictEqual(macroTex.data.length, 16 * 16 * 16 * 4);

    const weatherTex = CloudNoiseBaker.createWeatherMap(64);
    assert.strictEqual(weatherTex.data.length, 64 * 64 * 4);

    const blueTex = CloudNoiseBaker.createBlueNoiseJitter(32);
    assert.strictEqual(blueTex.data.length, 32 * 32 * 4);
  });

  await runTest('Unit: Custom GLSL3 Shaders', 'Validates vertex & fragment shader uniforms, 10 WMO genera & Rankine vortex', () => {
    assert.ok(atmosphereVertexShader.includes('vWorldPos = worldPos.xyz'));
    for (const token of ['uniform sampler2D uTerrainMap', 'uniform vec4 uVortexAndTide', 'evaluateTopographicAirflow', 'evaluateTornadoFunnel', 'computeGenusHeightProfile']) {
      assert.ok(atmosphereFragmentShader.includes(token));
    }
    for (let g = 0; g <= 8; g++) assert.ok(atmosphereFragmentShader.includes(`genusId == ${g}`));
  });

  await runTest('Unit: AtmosphereLayer', 'Handles uninitialized guard methods & custom constructor options', () => {
    const rawLayer = new AtmosphereLayer({ mapExtent: 1600, maxSteps: 64, debugMode: 2 });
    assert.strictEqual(rawLayer.mapExtent, 1600);
    assert.strictEqual(rawLayer.state.maxSteps, 64);
    assert.strictEqual(rawLayer.state.debugMode, 2);

    rawLayer.applyPreset('tradeWinds');
    rawLayer.setStormType('hurricane');
    rawLayer.setWorldOriginOffset(100, -200);
    rawLayer.setSceneDepthTexture(null);
    rawLayer.setDebugMode('transmittance');
    rawLayer.setTerrainMap(new THREE.DataTexture(new Uint8Array(16), 2, 2));
    rawLayer.setVortexAndTide(10, 20, 0.5, 2.0);
    rawLayer.update(1.0, new THREE.PerspectiveCamera());
    rawLayer.resize(800, 600);
    rawLayer.beginGpuTimer();
    rawLayer.endGpuTimer();
    rawLayer.onContextRestored(new THREE.WebGLRenderer());
    rawLayer.init(new THREE.WebGLRenderer(), new THREE.Scene());
    rawLayer.dispose();
  });

  await runTest('Unit: OceanLayer', 'Evaluates 4-wave Gerstner swells, tsunami soliton, whirlpool & storm surge', () => {
    const ocean = new OceanLayer();
    ocean.dispose(); // guard when uninitialized
    ocean.init(new THREE.Scene());
    ocean.setRainIntensity(0.75);
    const hCalm = ocean.sampleWaterSurfaceHeight(0, 0, 1.0);
    assert.ok(Number.isFinite(hCalm));

    ocean.setHydroState({
      waterLevel: 2.0,
      tsunamiStrength: 0.9,
      tsunamiZ: 0.0,
      whirlpoolStrength: 0.8,
      whirlpoolX: 0.0,
      whirlpoolZ: 0.0,
      tornadoStrength: 0.9,
      tornadoX: 24.0,
      tornadoZ: 0.0,
      hurricaneStrength: 0.9,
    });
    const hStorm = ocean.sampleWaterSurfaceHeight(0, 0, 1.0);
    assert.ok(Number.isFinite(hStorm) && hStorm !== hCalm);
    ocean.dispose();
  });

  await runTest('Unit: AtmosphereLayer', 'Switches across all 10 WMO cloud genera, presets, debug modes & GPU timer states', () => {
    const renderer = new THREE.WebGLRenderer();
    const layer = new AtmosphereLayer();
    layer.init(renderer, new THREE.Scene());

    for (const genusKey of Object.keys(CLOUD_GENERA)) {
      layer.setCloudGenus(genusKey);
      assert.strictEqual(layer.state.cloudGenusId, CLOUD_GENERA[genusKey].id);
    }
    layer.setCloudGenus('nonExistentGenus');

    for (const stormKey of Object.keys(STORM_TYPES)) {
      layer.setStormType(stormKey);
      assert.strictEqual(layer.state.stormTypeId, STORM_TYPES[stormKey].id);
    }
    layer.setStormType('nonExistentStorm');

    for (const presetKey of Object.keys(WEATHER_PRESETS)) layer.applyPreset(presetKey);
    layer.applyPreset('invalidPreset');

    for (const key of Object.keys(DEBUG_MODES)) {
      layer.setDebugMode(key);
      assert.strictEqual(layer.state.debugMode, DEBUG_MODES[key]);
    }
    layer.setDebugMode('unknownMode');
    assert.strictEqual(layer.state.debugMode, 0);
    layer.setDebugMode(99);
    assert.strictEqual(layer.state.debugMode, 3);
    layer.setDebugMode(NaN);
    assert.strictEqual(layer.state.debugMode, 0);

    layer.setWorldOriginOffset(450, -320);
    layer.setVortexAndTide(25, -40, 0.85, 4.0);
    layer.setVortexAndTide(0, 0, 0.0, 0.0);
    layer.setEnvironment({ rainIntensity: 0.0, tornadoStrength: 0.0 });
    assert.ok(layer.getSunDirection());
    assert.ok(layer.getWeatherMap());
    assert.ok(layer.getSharedGroundUniforms().uTerrainMap);

    layer.update(12.5, new THREE.PerspectiveCamera());
    layer.resize(1920, 1080);

    const gl = renderer.getContext();
    gl._setQueryAvailable(false);
    for (let i = 0; i < 6; i++) { layer.beginGpuTimer(); layer.endGpuTimer(); }
    assert.strictEqual(layer.pendingQueries.length, 4);

    gl._setQueryAvailable(true);
    layer.beginGpuTimer();
    layer.endGpuTimer();
    assert.strictEqual(layer.lastGpuPassMs, 2.45);

    gl._setDisjoint(true);
    layer.beginGpuTimer();
    layer.endGpuTimer();
    gl._setDisjoint(false);

    layer.onContextLost();
    assert.strictEqual(layer.macroNoise, null);
    layer.onContextRestored(renderer);
    assert.ok(layer.macroNoise !== null);
    layer.dispose();
  });

  await runTest('Integration: Full Application Boot & Render Loop', 'Boots src/main.js, compiles custom shaders & runs frames', async () => {
    await import('../src/main.js');
    assert.ok(globalThis.window.atmosphereLayer instanceof AtmosphereLayer);

    for (let f = 0; f < 10; f++) domEnv.stepAnimationFrame(40.0);

    assert.ok(globalThis.document.getElementById('stat-fps').textContent.includes('FPS'));
    assert.ok(globalThis.document.getElementById('stat-clusters').textContent.includes('Max:'));
    assert.ok(globalThis.document.getElementById('stat-topology').textContent.includes('Isl'));
  });

  await runTest('Integration: HUD Controls, Landform Morph, Vortex, Tsunami, Whirlpool & Tides', 'Exercises all interactive UI sliders, presets & keyboard shortcuts', () => {
    for (const btn of domEnv.presetBtns) { btn.click(); domEnv.stepAnimationFrame(35.0); }

    const ctrlStorm = globalThis.document.getElementById('ctrl-storm');
    for (const stormKey of Object.keys(STORM_TYPES)) {
      ctrlStorm.value = stormKey;
      ctrlStorm.dispatchEvent({ type: 'change', target: ctrlStorm });
      domEnv.stepAnimationFrame(25.0);
    }

    const ctrlGenus = globalThis.document.getElementById('ctrl-genus');
    for (const genusKey of Object.keys(CLOUD_GENERA)) {
      ctrlGenus.value = genusKey;
      ctrlGenus.dispatchEvent({ type: 'change', target: ctrlGenus });
      domEnv.stepAnimationFrame(25.0);
    }

    const fireInput = (id, val) => {
      const el = globalThis.document.getElementById(id);
      el.value = val;
      el.dispatchEvent({ type: 'input', target: el });
    };

    fireInput('ctrl-tornado', '0.90');
    fireInput('ctrl-hurricane', '0.92');
    domEnv.stepAnimationFrame(25.0);
    fireInput('ctrl-hurricane', '0.00');
    fireInput('ctrl-tsunami', '0.85');
    fireInput('ctrl-whirlpool', '0.80');

    for (const tideVal of ['-3.5', '0.0', '2.5', '8.0']) fireInput('ctrl-tide', tideVal);
    domEnv.stepAnimationFrame(35.0);

    for (const morphVal of ['0.10', '0.35', '0.65', '0.92']) fireInput('ctrl-terrain-morph', morphVal);
    fireInput('ctrl-peak-height', '310');
    fireInput('ctrl-canyon-depth', '0.85');

    for (const [id, val] of [
      ['ctrl-coverage', '0.78'], ['ctrl-density', '2.20'], ['ctrl-rain', '0.75'],
      ['ctrl-lightning', '0.85'], ['ctrl-fog', '0.60'], ['ctrl-temp', '-20'],
      ['ctrl-temp', '0'], ['ctrl-temp', '28'], ['ctrl-temp', '40'], ['ctrl-temp', '18'],
      ['ctrl-base', '110'], ['ctrl-sun', '42'], ['ctrl-wind', '24'], ['ctrl-steps', '56'],
    ]) {
      fireInput(id, val);
      if (id === 'ctrl-temp' && val === '-20') {
        const cv = globalThis.document.getElementById('ctrl-camera-view');
        cv.value = 'santa';
        cv.dispatchEvent({ type: 'change', target: cv });
        domEnv.stepAnimationFrame(35.0);
        domEnv.stepAnimationFrame(35.0);
      }
      if (id === 'ctrl-temp' && val === '0') domEnv.stepAnimationFrame(35.0);
    }

    const ctrlCameraView = globalThis.document.getElementById('ctrl-camera-view');
    const btnResetCamera = globalThis.document.getElementById('btn-reset-camera');
    ctrlCameraView.value = 'boat-0';
    ctrlCameraView.dispatchEvent({ type: 'change', target: ctrlCameraView });
    domEnv.stepAnimationFrame(35.0);
    domEnv.stepAnimationFrame(35.0);
    btnResetCamera.dispatchEvent({ type: 'click', target: btnResetCamera });
    ctrlCameraView.value = 'free';
    ctrlCameraView.dispatchEvent({ type: 'change', target: ctrlCameraView });

    const ctrlDebug = globalThis.document.getElementById('ctrl-debug');
    for (const modeVal of ['0', '1', '2', '3']) {
      ctrlDebug.value = modeVal;
      ctrlDebug.dispatchEvent({ type: 'change', target: ctrlDebug });
    }
    for (const key of ['1', '2', '3', '4', '9', 'w', 's', 'a', 'd', 'e', 'q', 'r']) {
      globalThis.window.dispatchEvent({ type: 'keydown', key, shiftKey: key === 'w', target: { tagName: 'BODY' } });
    }
    globalThis.window.dispatchEvent({ type: 'keydown', key: '2', target: { tagName: 'INPUT' } });

    globalThis.window.innerWidth = 1920;
    globalThis.window.innerHeight = 1080;
    globalThis.window.dispatchEvent({ type: 'resize' });

    const viewportCanvas = globalThis.document.getElementById('viewport');
    const savedRafCb = domEnv.getRafCallback();
    viewportCanvas.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    if (savedRafCb) savedRafCb(globalThis.performance.now());
    assert.strictEqual(globalThis.document.getElementById('stat-fps').textContent, 'CTX LOST');

    viewportCanvas.dispatchEvent({ type: 'webglcontextrestored' });
    globalThis.window.atmosphereLayer.lastGpuPassMs = null;
    for (let f = 0; f < 12; f++) domEnv.stepAnimationFrame(2500.0);
  });

  await runTest('Front-End Unit: index.html Markup & DOM Schema Contract', 'Validates importmap, canvas, 10 WMO genus options, 18 sliders & telemetry badges', () => {
    const html = fs.readFileSync(path.resolve(projectRoot, 'index.html'), 'utf8');
    assert.ok(html.includes('<script type="importmap">'));
    assert.ok(html.includes('three@0.187.0/build/three.module.js'));
    assert.ok(html.includes('<canvas id="viewport"></canvas>'));

    for (const preset of ['tradeWinds', 'clearPatrol', 'squall', 'hurricane']) assert.ok(html.includes(`data-preset="${preset}"`));
    for (const stormKey of Object.keys(STORM_TYPES)) assert.ok(html.includes(`<option value="${stormKey}"`));
    for (const genusKey of Object.keys(CLOUD_GENERA)) assert.ok(html.includes(`<option value="${genusKey}"`));

    for (const key of ['tornado', 'hurricane', 'tsunami', 'whirlpool', 'tide', 'terrain-morph', 'peak-height', 'canyon-depth', 'coverage', 'density', 'rain', 'lightning', 'fog', 'base', 'sun', 'wind', 'steps']) {
      assert.ok(html.includes(`id="ctrl-${key}"`));
      assert.ok(html.includes(`id="val-${key}"`));
    }
    for (const statId of ['stat-fps', 'stat-gpu', 'stat-clusters', 'stat-topology']) assert.ok(html.includes(`id="${statId}"`));
  });

  await runTest('Front-End Unit: UI Readout Formatters, Preset Exclusivity & Keyboard Guard', 'Unit-tests formatMorphLabel, formatTideLabel, DOM readouts & active button state', () => {
    const ctx = globalThis.window.simulationContext;
    assert.ok(ctx);

    assert.strictEqual(ctx.formatMorphLabel(0.05), '5% (Islands)');
    assert.strictEqual(ctx.formatMorphLabel(0.35), '35% (Channel Ridges)');
    assert.strictEqual(ctx.formatMorphLabel(0.65), '65% (Fjord Canyon)');
    assert.strictEqual(ctx.formatMorphLabel(0.95), '95% (Alpine Massif)');

    assert.strictEqual(ctx.formatTideLabel(-3.5), '-3.5 m (Low Tide)');
    assert.strictEqual(ctx.formatTideLabel(0.0), '0.0 m (Mean Tide)');
    assert.strictEqual(ctx.formatTideLabel(2.5), '+2.5 m (High Tide)');
    assert.strictEqual(ctx.formatTideLabel(8.5), '+8.5 m (King Tide)');

    const squallBtn = domEnv.presetBtns[2];
    squallBtn.click();
    assert.strictEqual(squallBtn.classList.contains('active'), true);
    assert.strictEqual(domEnv.presetBtns[0].classList.contains('active'), false);
    assert.strictEqual(globalThis.document.getElementById('ctrl-genus').value, 'cumulonimbus');
    assert.strictEqual(globalThis.document.getElementById('val-tornado').textContent, '85%');

    const ctrlGenus = globalThis.document.getElementById('ctrl-genus');
    ctrlGenus.value = 'cirrus';
    ctrlGenus.dispatchEvent({ type: 'change', target: ctrlGenus });
    for (const btn of domEnv.presetBtns) assert.strictEqual(btn.classList.contains('active'), false);
    assert.ok(globalThis.document.getElementById('genus-info').innerHTML.includes('Cirrus (Ci)'));
  });

  const experimentRows = [];

  await runTest('Integration Live Experiment: 4-Phase Coupled Atmosphere–Vortex–Hydrodynamics–UnionFind Trial', 'Runs controlled multi-frame physical experiments & validates physical invariants', () => {
    const { atmosphere, terrain, fluidClusterParticles, fleet, hydroState, terrainState } = globalThis.window.simulationContext;
    const ctrlMorph = globalThis.document.getElementById('ctrl-terrain-morph');
    const ctrlCanyon = globalThis.document.getElementById('ctrl-canyon-depth');
    const ctrlTide = globalThis.document.getElementById('ctrl-tide');

    ctrlTide.value = '0.0';
    ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    ctrlCanyon.value = '0.80';
    ctrlCanyon.dispatchEvent({ type: 'input', target: ctrlCanyon });

    const computeMeanElevation = () => {
      let sumH = 0, countSamples = 0;
      for (let x = -350; x <= 350; x += 50) {
        for (let z = -350; z <= 350; z += 50) {
          sumH += terrain.sampleHeightAndGradient(x, z).h;
          countSamples++;
        }
      }
      return sumH / countSamples;
    };

    ctrlMorph.value = '0.00';
    ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });
    const archMeanH = computeMeanElevation();

    ctrlMorph.value = '0.80';
    ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });
    const canyonMeanH = computeMeanElevation();
    const gorgeCenter = terrain.sampleHeightAndGradient(20.0, 0.0);
    const openOcean = terrain.sampleHeightAndGradient(450.0, 450.0);

    assert.strictEqual(gorgeCenter.h, 0.0);
    assert.ok(gorgeCenter.funnel > openOcean.funnel + 0.5);
    assert.ok(canyonMeanH > archMeanH * 1.25);

    experimentRows.push({
      phase: 'Phase 1: Canyon Venturi & Gorge Carve',
      condition: 'Morph 0% -> 80% (Fjord)',
      metricA: `Gorge Floor: ${gorgeCenter.h.toFixed(1)}m | Mean Massif Elevation: ${archMeanH.toFixed(1)}m -> ${canyonMeanH.toFixed(1)}m`,
      metricB: `Venturi Funnel (Open Sea vs Gorge): ${openOcean.funnel.toFixed(2)} -> ${gorgeCenter.funnel.toFixed(2)}`,
    });

    const measureParticleMetrics = (tornadoVal, hurricaneVal, whirlpoolVal, steps) => {
      hydroState.tornadoStrength = tornadoVal;
      hydroState.hurricaneStrength = hurricaneVal;
      hydroState.whirlpoolStrength = whirlpoolVal;
      hydroState.tsunamiStrength = 0.0;
      atmosphere.setVortexAndTide(hydroState.tornadoX, hydroState.tornadoZ, tornadoVal, 0.0);
      for (let s = 0; s < steps; s++) domEnv.stepAnimationFrame(16.0);

      let sumSpeed = 0, maxUpdraft = -Infinity;
      const vels = fluidClusterParticles.velocities;
      const n = fluidClusterParticles.count;
      for (let i = 0; i < n; i++) {
        const vx = vels[i * 3], vy = vels[i * 3 + 1], vz = vels[i * 3 + 2];
        sumSpeed += Math.hypot(vx, vy, vz);
        if (vy > maxUpdraft) maxUpdraft = vy;
      }
      return { meanSpeed: sumSpeed / n, maxUpdraft, activeClusters: fluidClusterParticles.activeClusters, largestCluster: fluidClusterParticles.largestCluster };
    };

    const calmTrial = measureParticleMetrics(0.0, 0.0, 0.0, 20);
    const stormTrial = measureParticleMetrics(0.95, 0.95, 0.90, 25);
    hydroState.hurricaneStrength = 0.0;

    assert.ok(stormTrial.meanSpeed > calmTrial.meanSpeed);
    assert.ok(stormTrial.maxUpdraft > 20.0);
    assert.ok(stormTrial.largestCluster >= 2);

    experimentRows.push({
      phase: 'Phase 2: Tornado & Cat-5 Hurricane + DSU',
      condition: 'Calm (0%) -> Tornado/Hurricane (95%)',
      metricA: `Speed: ${calmTrial.meanSpeed.toFixed(1)} -> ${stormTrial.meanSpeed.toFixed(1)} m/s (Updraft ${stormTrial.maxUpdraft.toFixed(1)} m/s)`,
      metricB: `DSU Clusters: ${stormTrial.activeClusters} (Max Eddy: ${stormTrial.largestCluster} parcels)`,
    });

    hydroState.tornadoStrength = 0.0;
    hydroState.whirlpoolStrength = 0.0;
    hydroState.tsunamiStrength = 0.0;
    let calmMaxBoatY = -Infinity;
    for (let s = 0; s < 15; s++) {
      domEnv.stepAnimationFrame(30.0);
      for (const v of fleet) if (v.group.position.y > calmMaxBoatY) calmMaxBoatY = v.group.position.y;
    }

    hydroState.tsunamiStrength = 0.95;
    let tsunamiMaxBoatY = -Infinity, tsunamiMaxTiltRad = 0;
    for (let s = 0; s < 45; s++) {
      domEnv.stepAnimationFrame(250.0);
      for (const v of fleet) {
        if (v.group.position.y > tsunamiMaxBoatY) tsunamiMaxBoatY = v.group.position.y;
        const tiltRad = Math.acos(Math.min(1.0, Math.max(-1.0, v.group.quaternion.y)));
        if (tiltRad > tsunamiMaxTiltRad) tsunamiMaxTiltRad = tiltRad;
        assert.ok(terrain.sampleHeightAndGradient(v.group.position.x, v.group.position.z).h <= hydroState.waterLevel + 0.5);
      }
    }

    assert.ok(tsunamiMaxBoatY > calmMaxBoatY + 12.0);
    assert.ok(tsunamiMaxTiltRad > 0.08);

    experimentRows.push({
      phase: 'Phase 3: Tsunami Soliton & 6-DOF ASV Fleet',
      condition: 'Tsunami 0% -> 95% Soliton',
      metricA: `Peak ASV Heave Y: ${calmMaxBoatY.toFixed(1)}m -> +${tsunamiMaxBoatY.toFixed(1)}m`,
      metricB: `Peak Hull Pitch/Roll: ${((tsunamiMaxTiltRad * 180) / Math.PI).toFixed(1)} deg | Waterway Safe: 100%`,
    });

    ctrlMorph.value = '0.25';
    ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });
    ctrlTide.value = '-4.5';
    ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    const lowTideIslands = terrainState.islandCount;
    const lowTideBasins = terrainState.waterBasinCount;

    ctrlTide.value = '11.5';
    ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    const kingTideIslands = terrainState.islandCount;
    const kingTideBasins = terrainState.waterBasinCount;

    assert.ok(lowTideIslands >= kingTideIslands);
    assert.ok(lowTideIslands >= 1 && kingTideBasins >= 1);

    experimentRows.push({
      phase: 'Phase 4: Tidal Sweep & DSU Land/Sea Topology',
      condition: 'Tide -4.5m -> +11.5m Flood',
      metricA: `Emerged Islands: ${lowTideIslands} Isl -> ${kingTideIslands} Isl`,
      metricB: `Connected Sea Basins: ${lowTideBasins} Sea -> ${kingTideBasins} Sea`,
    });
  });

  console.log('\n----------------------------------------------------------------------');
  console.log(' LIVE 4-PHASE SCIENTIFIC EXPERIMENT TELEMETRY REPORT');
  console.log('----------------------------------------------------------------------');
  for (const row of experimentRows) {
    console.log(`  • ${row.phase} [${row.condition}]\n      ├─ ${row.metricA}\n      └─ ${row.metricB}`);
  }
  console.log('----------------------------------------------------------------------');

  const covStats = stopAndComputeCoverage(covSession);
  console.log('\n----------------------------------------------------------------------');
  console.log(' V8 CODE COVERAGE REPORT (src/)');
  console.log('----------------------------------------------------------------------');
  console.log(`${'File'.padEnd(36)} | ${'Lines'.padStart(8)} | ${'Funcs'.padStart(8)} | ${'Branches'.padStart(8)}`);
  console.log('----------------------------------------------------------------------');

  let totalExecLines = 0, totalCovLines = 0, totalFns = 0, totalCovFns = 0, totalBr = 0, totalCovBr = 0;
  for (const s of covStats) {
    totalExecLines += s.executableLines;
    totalCovLines += s.coveredLines;
    totalFns += s.totalFns;
    totalCovFns += s.coveredFns;
    totalBr += s.totalBranches;
    totalCovBr += s.coveredBranches;
    console.log(`${s.file.padEnd(36)} | ${(s.linePct.toFixed(1) + '%').padStart(8)} | ${(s.fnPct.toFixed(1) + '%').padStart(8)} | ${(s.branchPct.toFixed(1) + '%').padStart(8)}`);
  }

  const overallLinePct = totalExecLines ? (totalCovLines / totalExecLines) * 100 : 100;
  const overallFnPct = totalFns ? (totalCovFns / totalFns) * 100 : 100;
  const overallBrPct = totalBr ? (totalCovBr / totalBr) * 100 : 100;

  console.log('----------------------------------------------------------------------');
  console.log(`${'ALL FILES (TOTAL)'.padEnd(36)} | ${(overallLinePct.toFixed(1) + '%').padStart(8)} | ${(overallFnPct.toFixed(1) + '%').padStart(8)} | ${(overallBrPct.toFixed(1) + '%').padStart(8)}`);
  console.log('----------------------------------------------------------------------\n');

  const failed = results.filter((r) => !r.passed);
  console.log(`Tests Passed: ${results.length - failed.length} / ${results.length}`);
  if (failed.length > 0) process.exit(1);
}

runAllSuites();
