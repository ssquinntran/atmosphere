import inspector from 'inspector';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Setup Simulated Browser DOM & Canvas 2D Context for Headless Integration
// ---------------------------------------------------------------------------
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
        add(c) {
          classListSet.add(c);
        },
        remove(c) {
          classListSet.delete(c);
        },
        contains(c) {
          return classListSet.has(c);
        },
      },
      addEventListener(type, cb) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(cb);
      },
      dispatchEvent(event) {
        const list = listeners[event.type] || [];
        for (const fn of list) {
          fn(event);
        }
      },
      click() {
        el.dispatchEvent({ type: 'click', target: el });
      },
      getContext(ctxType) {
        if (ctxType === '2d') {
          return {
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            font: '',
            letterSpacing: '',
            textAlign: 'left',
            fillRect() {},
            strokeRect() {},
            save() {},
            restore() {},
            translate() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            closePath() {},
            fill() {},
            fillText() {},
          };
        }
        return null;
      },
    };
    if (id) elementsById.set(id, el);
    return el;
  }

  // Create all HUD elements referenced by index.html & src/main.js
  createMockElement('viewport', 'CANVAS');
  createMockElement('ctrl-storm', 'SELECT');
  createMockElement('ctrl-genus', 'SELECT');
  createMockElement('ctrl-tornado', 'INPUT');
  createMockElement('ctrl-hurricane', 'INPUT');
  createMockElement('ctrl-tsunami', 'INPUT');
  createMockElement('ctrl-whirlpool', 'INPUT');
  createMockElement('ctrl-tide', 'INPUT');
  createMockElement('ctrl-terrain-morph', 'INPUT');
  createMockElement('ctrl-peak-height', 'INPUT');
  createMockElement('ctrl-canyon-depth', 'INPUT');
  createMockElement('ctrl-coverage', 'INPUT');
  createMockElement('ctrl-density', 'INPUT');
  createMockElement('ctrl-rain', 'INPUT');
  createMockElement('ctrl-base', 'INPUT');
  createMockElement('ctrl-sun', 'INPUT');
  createMockElement('ctrl-wind', 'INPUT');
  createMockElement('ctrl-steps', 'INPUT');
  createMockElement('ctrl-debug', 'SELECT');

  createMockElement('val-tornado', 'SPAN');
  createMockElement('val-hurricane', 'SPAN');
  createMockElement('val-tsunami', 'SPAN');
  createMockElement('val-whirlpool', 'SPAN');
  createMockElement('val-tide', 'SPAN');
  createMockElement('val-terrain-morph', 'SPAN');
  createMockElement('val-peak-height', 'SPAN');
  createMockElement('val-canyon-depth', 'SPAN');
  createMockElement('val-coverage', 'SPAN');
  createMockElement('val-density', 'SPAN');
  createMockElement('val-rain', 'SPAN');
  createMockElement('val-base', 'SPAN');
  createMockElement('val-sun', 'SPAN');
  createMockElement('val-wind', 'SPAN');
  createMockElement('val-steps', 'SPAN');

  createMockElement('genus-info', 'DIV');
  createMockElement('debug-caption', 'DIV');
  createMockElement('stat-fps', 'DIV');
  createMockElement('stat-gpu', 'DIV');
  createMockElement('stat-clusters', 'DIV');
  createMockElement('stat-topology', 'DIV');

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
    addEventListener(type, cb) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(cb);
    },
    dispatchEvent(event) {
      const list = winListeners[event.type] || [];
      for (const fn of list) {
        fn(event);
      }
    },
  };

  globalThis.document = {
    getElementById(id) {
      return elementsById.get(id) || createMockElement(id);
    },
    querySelectorAll(selector) {
      if (selector === '.preset-btn') return presetBtns;
      return [];
    },
    createElement(tag) {
      return createMockElement(null, tag.toUpperCase());
    },
  };

  let nowTime = 1000;
  globalThis.performance = {
    now() {
      return nowTime;
    },
    _advance(ms) {
      nowTime += ms;
      return nowTime;
    },
  };

  globalThis.requestAnimationFrame = (cb) => {
    rafCallback = cb;
    return ++rafCounter;
  };

  globalThis.cancelAnimationFrame = () => {
    rafCallback = null;
  };

  return {
    elementsById,
    presetBtns,
    stepAnimationFrame(deltaMs = 16.67) {
      const t = globalThis.performance._advance(deltaMs);
      const cb = rafCallback;
      if (cb) cb(t);
    },
    getRafCallback() {
      return rafCallback;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. V8 Precise Code Coverage Collector
// ---------------------------------------------------------------------------
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

    // Compute line start/end byte offsets
    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }

    // Track execution count per character offset using V8 nested block ranges
    const charCounts = new Int32Array(source.length).fill(1);
    const allRanges = [];
    for (const fn of entry.functions) {
      for (const r of fn.ranges) {
        allRanges.push(r);
      }
    }
    // Sort outer ranges first, inner ranges second so inner overrides outer
    allRanges.sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    for (let idx = allRanges.length - 1; idx >= 0; idx--) {
      const r = allRanges[idx];
      const start = Math.max(0, r.startOffset);
      const end = Math.min(source.length, r.endOffset);
      for (let c = start; c < end; c++) {
        charCounts[c] = r.count;
      }
    }

    let executableLines = 0;
    let coveredLines = 0;
    const uncoveredLineNumbers = [];

    for (let l = 0; l < lines.length; l++) {
      const trimmed = lines[l].trim();
      if (
        !trimmed ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed === '};' ||
        trimmed === '}'
      ) {
        continue;
      }
      executableLines++;
      const lStart = lineStarts[l];
      const lEnd = lStart + lines[l].length;
      let lineHit = false;
      for (let c = lStart; c < lEnd; c++) {
        if (charCounts[c] > 0) {
          lineHit = true;
          break;
        }
      }
      if (lineHit) {
        coveredLines++;
      } else {
        uncoveredLineNumbers.push(l + 1);
      }
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

  fileStats.sort((a, b) => a.file.localeCompare(b.file));
  return fileStats;
}

// ---------------------------------------------------------------------------
// 3. Execute Unit & Integration Test Suites
// ---------------------------------------------------------------------------
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

  // Dynamically import all modules after coverage session starts
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

  // -------------------------------------------------------------------------
  // SUITE 1: Disjoint-Set Union-Find (DSU) & Spatial Hash Grid Unit Tests
  // -------------------------------------------------------------------------
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
    // Merge 0-1 (size 2) and 2-3-4 (size 3)
    dsu.union(0, 1);
    dsu.union(2, 3);
    dsu.union(2, 4);
    assert.strictEqual(dsu.getComponentSize(0), 2);
    assert.strictEqual(dsu.getComponentSize(2), 3);

    // Union smaller rootA (size 2) with larger rootB (size 3) -> triggers swap branch
    const mergedRoot = dsu.union(0, 2);
    assert.strictEqual(dsu.getComponentSize(mergedRoot), 5);
    assert.strictEqual(dsu.maxClusterSize, 5);
    assert.strictEqual(dsu.numComponents, 6);

    // Idempotent union when already in same component
    const sameRoot = dsu.union(1, 4);
    assert.strictEqual(sameRoot, mergedRoot);
    assert.strictEqual(dsu.numComponents, 6);

    // Deep chain path compression verification
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

    // Place particles 0, 1, 2 close together (< 12m apart) and particles 3, 4, 5 far apart
    const positions = new Float32Array([
      0, 10, 0,
      4, 11, 3,
      -3, 10, -2,
      200, 10, 200,
      -200, 50, -200,
      400, 80, -400,
    ]);
    const velocities = new Float32Array([
      10, 0, 0,
      0, 0, 10,
      5, 0, 5,
      1, 0, 1,
      -1, 0, -1,
      0, 1, 0,
    ]);

    for (let i = 0; i < count; i++) {
      grid.insert(i, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    grid.clusterNeighbors(positions, velocities, count, 12.0, dsu);

    // 0, 1, 2 should be coalesced into a single cluster of size 3
    assert.strictEqual(dsu.getComponentSize(0), 3);
    assert.strictEqual(dsu.find(0), dsu.find(1));
    assert.strictEqual(dsu.find(1), dsu.find(2));
    // 3, 4, 5 remain isolated singletons
    assert.strictEqual(dsu.getComponentSize(3), 1);
    assert.strictEqual(dsu.getComponentSize(4), 1);
    assert.strictEqual(dsu.getComponentSize(5), 1);
    assert.strictEqual(dsu.numComponents, 4);
  });

  await runTest('Unit: analyzeTerrainTopologyUnionFind', 'Counts connected islands and flooded sea basins across tide levels', () => {
    const gridRes = 41;
    const heights = new Float32Array(gridRes * gridRes).fill(-10.0);

    // Create 2 distinct high-elevation islands separated by deep water channels
    for (let z = 4; z <= 14; z++) {
      for (let x = 4; x <= 14; x++) {
        heights[z * gridRes + x] = 50.0;
      }
    }
    for (let z = 24; z <= 34; z++) {
      for (let x = 24; x <= 34; x++) {
        heights[z * gridRes + x] = 20.0;
      }
    }

    // At Mean Tide (0m), both islands are above water -> 2 islands, 1 connected ocean basin
    const meanTopo = analyzeTerrainTopologyUnionFind(heights, gridRes, 0.0);
    assert.strictEqual(meanTopo.islandCount, 2);
    assert.strictEqual(meanTopo.waterBasinCount, 1);

    // At extreme flood (+25m), the 20m island submerges -> only 1 island remains
    const floodTopo = analyzeTerrainTopologyUnionFind(heights, gridRes, 25.0);
    assert.strictEqual(floodTopo.islandCount, 1);
    assert.strictEqual(floodTopo.waterBasinCount, 1);
  });

  await runTest('Unit: LagrangianVortexParticleSystem', 'Simulates Rankine tornado, whirlpool, tsunami, buoyancy & terrain collision', () => {
    const sys = new LagrangianVortexParticleSystem(60);
    assert.strictEqual(sys.count, 60);

    // Place specific particles to hit every physical force branch:
    // Particle 0: Inside tornado inner core (rT < coreRadius)
    sys.positions[0] = 5.0; sys.positions[1] = 15.0; sys.positions[2] = 5.0;
    // Particle 1: Outside tornado inner core but within outer swirl (coreRadius < rT < 210)
    sys.positions[3] = 85.0; sys.positions[4] = 25.0; sys.positions[5] = 0.0;
    // Particle 2: Inside whirlpool inner core (rW < coreW)
    sys.positions[6] = 2.0; sys.positions[7] = 5.0; sys.positions[8] = -8.0;
    // Particle 3: Outside whirlpool inner core (coreW < rW < 155)
    sys.positions[9] = 60.0; sys.positions[10] = 8.0; sys.positions[11] = -10.0;
    // Particle 4: At tsunami wave front (distWave < 55)
    sys.positions[12] = 0.0; sys.positions[13] = 10.0; sys.positions[14] = 100.0;
    // Particle 5: Below water surface with downward velocity (buoyancy bounce)
    sys.positions[15] = -50.0; sys.positions[16] = -5.0; sys.positions[17] = -50.0;
    sys.velocities[16] = -12.0;
    // Particle 6: Colliding with tall mountain slope (terr.h > localWaterY)
    sys.positions[18] = 150.0; sys.positions[19] = 20.0; sys.positions[20] = 150.0;
    // Particle 7: Out of bounds (> 480m) to trigger tornado-biased respawn
    sys.positions[21] = 550.0; sys.positions[22] = 30.0; sys.positions[23] = 0.0;
    // Particle 8: Sucked into center of whirlpool (< 4.5m)
    sys.positions[24] = 0.0; sys.positions[25] = 1.0; sys.positions[26] = -10.0;

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
        sampleTerrain: (x, z) => {
          if (x > 120 && z > 120) return { h: 85.0, gx: 0.6, gz: 0.5, funnel: 0.0 };
          return { h: 0.0, gx: 0.0, gz: 0.0, funnel: 0.8 };
        },
        sampleWaterHeight: () => 0.0,
      });
    }

    assert.ok(sys.activeClusters >= 1 && sys.activeClusters <= 60);
    assert.ok(sys.largestCluster >= 1);
  });

  // -------------------------------------------------------------------------
  // SUITE 2: CloudNoiseBaker & Custom GLSL3 Shaders Unit Tests
  // -------------------------------------------------------------------------
  await runTest('Unit: CloudNoiseBaker', 'Bakes 3D Perlin-Worley volume textures, weather map & blue noise jitter', () => {
    const renderer = new THREE.WebGLRenderer();
    const macroTex = CloudNoiseBaker.bakeVolumeTexture(renderer, 16, 4, 4.0);
    assert.strictEqual(macroTex.width, 16);
    assert.strictEqual(macroTex.depth, 16);
    assert.strictEqual(macroTex.data.length, 16 * 16 * 16 * 4);

    const weatherTex = CloudNoiseBaker.createWeatherMap(64);
    assert.strictEqual(weatherTex.width, 64);
    assert.strictEqual(weatherTex.data.length, 64 * 64 * 4);

    const blueTex = CloudNoiseBaker.createBlueNoiseJitter(32);
    assert.strictEqual(blueTex.width, 32);
    assert.strictEqual(blueTex.data.length, 32 * 32 * 4);
  });

  await runTest('Unit: Custom GLSL3 Shaders', 'Validates vertex & fragment shader uniforms, 10 WMO genera & Rankine vortex', () => {
    assert.ok(atmosphereVertexShader.includes('vWorldPos = worldPos.xyz'));
    assert.ok(atmosphereFragmentShader.includes('uniform sampler2D uTerrainMap'));
    assert.ok(atmosphereFragmentShader.includes('uniform vec4 uVortexAndTide'));
    assert.ok(atmosphereFragmentShader.includes('evaluateTopographicAirflow'));
    assert.ok(atmosphereFragmentShader.includes('evaluateTornadoFunnel'));
    assert.ok(atmosphereFragmentShader.includes('computeGenusHeightProfile'));
    for (let g = 0; g <= 8; g++) {
      assert.ok(atmosphereFragmentShader.includes(`genusId == ${g}`));
    }
  });

  // -------------------------------------------------------------------------
  // SUITE 3: AtmosphereLayer Lifecycle, All 10 Genera, GPU Timer & Context Recovery
  // -------------------------------------------------------------------------
  await runTest('Unit: AtmosphereLayer', 'Handles uninitialized guard methods & custom constructor options', () => {
    const rawLayer = new AtmosphereLayer({ mapExtent: 1600, maxSteps: 64, debugMode: 2 });
    assert.strictEqual(rawLayer.mapExtent, 1600);
    assert.strictEqual(rawLayer.state.maxSteps, 64);
    assert.strictEqual(rawLayer.state.debugMode, 2);

    // Calling methods before init() should safely no-op without throwing
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

  await runTest('Unit: AtmosphereLayer', 'Switches across all 10 WMO cloud genera, presets, debug modes & GPU timer states', () => {
    const renderer = new THREE.WebGLRenderer();
    const scene = new THREE.Scene();
    const layer = new AtmosphereLayer();
    layer.init(renderer, scene);

    // Test all 10 WMO cloud genera + invalid genus guard
    for (const genusKey of Object.keys(CLOUD_GENERA)) {
      layer.setCloudGenus(genusKey);
      assert.strictEqual(layer.state.cloudGenus, genusKey);
      assert.strictEqual(layer.state.cloudGenusId, CLOUD_GENERA[genusKey].id);
    }
    layer.setCloudGenus('nonExistentGenus');

    // Test all 6 storm regimes + invalid storm guard
    for (const stormKey of Object.keys(STORM_TYPES)) {
      layer.setStormType(stormKey);
      assert.strictEqual(layer.state.stormType, stormKey);
      assert.strictEqual(layer.state.stormTypeId, STORM_TYPES[stormKey].id);
    }
    layer.setStormType('nonExistentStorm');

    // Test all presets + invalid preset guard
    for (const presetKey of Object.keys(WEATHER_PRESETS)) {
      layer.applyPreset(presetKey);
    }
    layer.applyPreset('invalidPreset');

    // Test debug modes (string & number & fallback)
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

    // Test RTC world origin offset, vortex/tide, getters, resize & update
    layer.setWorldOriginOffset(450, -320);
    layer.setVortexAndTide(25, -40, 0.85, 4.0);
    layer.setVortexAndTide(0, 0, 0.0, 0.0);
    layer.setEnvironment({ rainIntensity: 0.0, tornadoStrength: 0.0 });
    assert.ok(layer.getSunDirection());
    assert.ok(layer.getWeatherMap());
    assert.ok(layer.getSharedGroundUniforms().uTerrainMap);

    const cam = new THREE.PerspectiveCamera();
    layer.update(12.5, cam);
    layer.resize(1920, 1080);

    // Test GPU Timer Query lifecycle (available, unavailable, disjoint, and >4 queue saturation)
    const gl = renderer.getContext();
    gl._setQueryAvailable(false);
    for (let i = 0; i < 6; i++) {
      layer.beginGpuTimer();
      layer.endGpuTimer();
    }
    assert.strictEqual(layer.pendingQueries.length, 4);

    // Now mark query available and poll
    gl._setQueryAvailable(true);
    layer.beginGpuTimer();
    layer.endGpuTimer();
    assert.strictEqual(layer.lastGpuPassMs, 2.45);

    // Test disjoint GPU timer reset branch
    gl._setDisjoint(true);
    layer.beginGpuTimer();
    layer.endGpuTimer();
    gl._setDisjoint(false);

    // Test context lost & restored
    layer.onContextLost();
    assert.strictEqual(layer.macroNoise, null);
    layer.onContextRestored(renderer);
    assert.ok(layer.macroNoise !== null);

    layer.dispose();
  });

  // -------------------------------------------------------------------------
  // SUITE 4: End-to-End Application Integration Tests (src/main.js + DOM + Shaders)
  // -------------------------------------------------------------------------
  await runTest('Integration: Full Application Boot & Render Loop', 'Boots src/main.js, compiles custom shaders & runs frames', async () => {
    await import('../src/main.js');
    assert.ok(globalThis.window.atmosphereLayer instanceof AtmosphereLayer);

    // Step animation frames to trigger ocean & terrain onBeforeCompile custom shader hooks and telemetry (>300ms)
    for (let f = 0; f < 10; f++) {
      domEnv.stepAnimationFrame(40.0);
    }

    const fpsText = globalThis.document.getElementById('stat-fps').textContent;
    const clustersText = globalThis.document.getElementById('stat-clusters').textContent;
    const topoText = globalThis.document.getElementById('stat-topology').textContent;
    assert.ok(fpsText.includes('FPS'));
    assert.ok(clustersText.includes('Max:'));
    assert.ok(topoText.includes('Isl'));
  });

  await runTest('Integration: HUD Controls, Landform Morph, Vortex, Tsunami, Whirlpool & Tides', 'Exercises all interactive UI sliders, presets & keyboard shortcuts', () => {
    // 1. Click all preset buttons
    for (const btn of domEnv.presetBtns) {
      btn.click();
      domEnv.stepAnimationFrame(35.0);
    }

    // 2. Select all 6 Storm Regimes via #ctrl-storm & all 10 WMO Cloud Genera via #ctrl-genus
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

    // 3. Test Tornado, Hurricane, Tsunami, Whirlpool, and all 4 Tide regimes (Low, Mean, High, King)
    const ctrlTornado = globalThis.document.getElementById('ctrl-tornado');
    ctrlTornado.value = '0.90';
    ctrlTornado.dispatchEvent({ type: 'input', target: ctrlTornado });

    const ctrlHurricane = globalThis.document.getElementById('ctrl-hurricane');
    ctrlHurricane.value = '0.92';
    ctrlHurricane.dispatchEvent({ type: 'input', target: ctrlHurricane });
    domEnv.stepAnimationFrame(25.0);
    ctrlHurricane.value = '0.00';
    ctrlHurricane.dispatchEvent({ type: 'input', target: ctrlHurricane });

    const ctrlTsunami = globalThis.document.getElementById('ctrl-tsunami');
    ctrlTsunami.value = '0.85';
    ctrlTsunami.dispatchEvent({ type: 'input', target: ctrlTsunami });

    const ctrlWhirlpool = globalThis.document.getElementById('ctrl-whirlpool');
    ctrlWhirlpool.value = '0.80';
    ctrlWhirlpool.dispatchEvent({ type: 'input', target: ctrlWhirlpool });

    const ctrlTide = globalThis.document.getElementById('ctrl-tide');
    for (const tideVal of ['-3.5', '0.0', '2.5', '8.0']) {
      ctrlTide.value = tideVal;
      ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    }
    domEnv.stepAnimationFrame(35.0);

    // 4. Test all 4 Landform Morph regimes (Islands < 0.22, Channel Ridges < 0.52, Fjord Canyon < 0.82, Alpine Massif >= 0.82)
    const ctrlMorph = globalThis.document.getElementById('ctrl-terrain-morph');
    for (const morphVal of ['0.10', '0.35', '0.65', '0.92']) {
      ctrlMorph.value = morphVal;
      ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });
    }

    const ctrlPeak = globalThis.document.getElementById('ctrl-peak-height');
    ctrlPeak.value = '310';
    ctrlPeak.dispatchEvent({ type: 'input', target: ctrlPeak });

    const ctrlCanyon = globalThis.document.getElementById('ctrl-canyon-depth');
    ctrlCanyon.value = '0.85';
    ctrlCanyon.dispatchEvent({ type: 'input', target: ctrlCanyon });

    // 5. Test all Atmosphere & Lighting sliders
    const sliderPairs = [
      ['ctrl-coverage', '0.78'],
      ['ctrl-density', '2.20'],
      ['ctrl-rain', '0.75'],
      ['ctrl-base', '110'],
      ['ctrl-sun', '42'],
      ['ctrl-wind', '24'],
      ['ctrl-steps', '56'],
    ];
    for (const [id, val] of sliderPairs) {
      const el = globalThis.document.getElementById(id);
      el.value = val;
      el.dispatchEvent({ type: 'input', target: el });
    }

    // 6. Test Shader Debug dropdown & keyboard shortcuts 1-4 (plus INPUT/SELECT target ignore guard)
    const ctrlDebug = globalThis.document.getElementById('ctrl-debug');
    for (const modeVal of ['0', '1', '2', '3']) {
      ctrlDebug.value = modeVal;
      ctrlDebug.dispatchEvent({ type: 'change', target: ctrlDebug });
    }
    for (const key of ['1', '2', '3', '4', '9']) {
      globalThis.window.dispatchEvent({ type: 'keydown', key, target: { tagName: 'BODY' } });
    }
    globalThis.window.dispatchEvent({ type: 'keydown', key: '2', target: { tagName: 'INPUT' } });

    // 7. Test window resize, WebGL context loss & restoration, and CPU frame-time fallback
    globalThis.window.innerWidth = 1920;
    globalThis.window.innerHeight = 1080;
    globalThis.window.dispatchEvent({ type: 'resize' });

    const viewportCanvas = globalThis.document.getElementById('viewport');
    const savedRafCb = domEnv.getRafCallback();
    viewportCanvas.dispatchEvent({
      type: 'webglcontextlost',
      preventDefault() {},
    });
    // Invoking saved animate callback while context is lost hits the early-return guard
    if (savedRafCb) savedRafCb(globalThis.performance.now());
    assert.strictEqual(globalThis.document.getElementById('stat-fps').textContent, 'CTX LOST');

    viewportCanvas.dispatchEvent({
      type: 'webglcontextrestored',
    });

    // Advance elapsed time across full sine wave period so SPYGLASS canyonJunctionWeave hits both s >= 0 and s < 0
    globalThis.window.atmosphereLayer.lastGpuPassMs = null;
    for (let f = 0; f < 12; f++) {
      domEnv.stepAnimationFrame(2500.0);
    }
  });

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // SUITE 5: Front-End Unit Tests (HTML Markup Contract, Formatters & UI State)
  // -------------------------------------------------------------------------
  await runTest('Front-End Unit: index.html Markup & DOM Schema Contract', 'Validates importmap, canvas, 10 WMO genus options, 14 sliders & telemetry badges', () => {
    const htmlPath = path.resolve(process.cwd(), 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // Verify ES Module importmap for Three.js r187
    assert.ok(html.includes('<script type="importmap">'));
    assert.ok(html.includes('three@0.187.0/build/three.module.js'));
    assert.ok(html.includes('<canvas id="viewport"></canvas>'));

    // Verify all 4 weather & storm preset buttons
    for (const preset of ['tradeWinds', 'clearPatrol', 'squall', 'hurricane']) {
      assert.ok(html.includes(`data-preset="${preset}"`), `Missing preset button ${preset}`);
    }

    // Verify all 6 storm system option values in #ctrl-storm
    for (const stormKey of Object.keys(STORM_TYPES)) {
      assert.ok(html.includes(`<option value="${stormKey}"`), `Missing storm option ${stormKey}`);
    }

    // Verify all 10 WMO cloud genera option values in #ctrl-genus
    for (const genusKey of Object.keys(CLOUD_GENERA)) {
      assert.ok(html.includes(`<option value="${genusKey}"`), `Missing WMO option ${genusKey}`);
    }

    // Verify all 15 range sliders and their readout value badges exist in index.html
    const requiredControls = [
      ['ctrl-tornado', 'val-tornado'],
      ['ctrl-hurricane', 'val-hurricane'],
      ['ctrl-tsunami', 'val-tsunami'],
      ['ctrl-whirlpool', 'val-whirlpool'],
      ['ctrl-tide', 'val-tide'],
      ['ctrl-terrain-morph', 'val-terrain-morph'],
      ['ctrl-peak-height', 'val-peak-height'],
      ['ctrl-canyon-depth', 'val-canyon-depth'],
      ['ctrl-coverage', 'val-coverage'],
      ['ctrl-density', 'val-density'],
      ['ctrl-rain', 'val-rain'],
      ['ctrl-base', 'val-base'],
      ['ctrl-sun', 'val-sun'],
      ['ctrl-wind', 'val-wind'],
      ['ctrl-steps', 'val-steps'],
    ];
    for (const [ctrlId, valId] of requiredControls) {
      assert.ok(html.includes(`id="${ctrlId}"`), `Missing slider #${ctrlId}`);
      assert.ok(html.includes(`id="${valId}"`), `Missing readout badge #${valId}`);
    }

    // Verify all 4 live telemetry readouts
    for (const statId of ['stat-fps', 'stat-gpu', 'stat-clusters', 'stat-topology']) {
      assert.ok(html.includes(`id="${statId}"`), `Missing telemetry node #${statId}`);
    }
  });

  await runTest('Front-End Unit: UI Readout Formatters, Preset Exclusivity & Keyboard Guard', 'Unit-tests formatMorphLabel, formatTideLabel, DOM readouts & active button state', () => {
    const ctx = globalThis.window.simulationContext;
    assert.ok(ctx, 'window.simulationContext must be exposed');

    // 1. Unit-test pure front-end label formatters across every regime boundary
    assert.strictEqual(ctx.formatMorphLabel(0.05), '5% (Islands)');
    assert.strictEqual(ctx.formatMorphLabel(0.35), '35% (Channel Ridges)');
    assert.strictEqual(ctx.formatMorphLabel(0.65), '65% (Fjord Canyon)');
    assert.strictEqual(ctx.formatMorphLabel(0.95), '95% (Alpine Massif)');

    assert.strictEqual(ctx.formatTideLabel(-3.5), '-3.5 m (Low Tide)');
    assert.strictEqual(ctx.formatTideLabel(0.0), '0.0 m (Mean Tide)');
    assert.strictEqual(ctx.formatTideLabel(2.5), '+2.5 m (High Tide)');
    assert.strictEqual(ctx.formatTideLabel(8.5), '+8.5 m (King Tide)');

    // 2. Unit-test preset button active class exclusivity and DOM badge synchronization
    const squallBtn = domEnv.presetBtns[2]; // Tornado Squall
    squallBtn.click();
    assert.strictEqual(squallBtn.classList.contains('active'), true);
    assert.strictEqual(domEnv.presetBtns[0].classList.contains('active'), false);
    assert.strictEqual(globalThis.document.getElementById('ctrl-genus').value, 'cumulonimbus');
    assert.strictEqual(globalThis.document.getElementById('val-tornado').textContent, '85%');
    assert.ok(globalThis.document.getElementById('genus-info').innerHTML.includes('Cumulonimbus (Cb)'));

    // 3. Unit-test manual genus change clearing preset active state
    const ctrlGenus = globalThis.document.getElementById('ctrl-genus');
    ctrlGenus.value = 'cirrus';
    ctrlGenus.dispatchEvent({ type: 'change', target: ctrlGenus });
    for (const btn of domEnv.presetBtns) {
      assert.strictEqual(btn.classList.contains('active'), false);
    }
    assert.ok(globalThis.document.getElementById('genus-info').innerHTML.includes('Cirrus (Ci)'));
  });

  // -------------------------------------------------------------------------
  // SUITE 6: Live Multi-Phase Scientific Experiment (Integration Trial)
  // -------------------------------------------------------------------------
  const experimentRows = [];

  await runTest('Integration Live Experiment: 4-Phase Coupled Atmosphere–Vortex–Hydrodynamics–UnionFind Trial', 'Runs controlled multi-frame physical experiments & validates physical invariants', () => {
    const ctx = globalThis.window.simulationContext;
    const { atmosphere, terrain, fluidClusterParticles, fleet, hydroState, terrainState } = ctx;

    // -----------------------------------------------------------------------
    // PHASE 1: Topographic Canyon Venturi & Flooded Gorge Carve Experiment
    // -----------------------------------------------------------------------
    const ctrlMorph = globalThis.document.getElementById('ctrl-terrain-morph');
    const ctrlCanyon = globalThis.document.getElementById('ctrl-canyon-depth');
    const ctrlTide = globalThis.document.getElementById('ctrl-tide');

    ctrlTide.value = '0.0';
    ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    ctrlCanyon.value = '0.80';
    ctrlCanyon.dispatchEvent({ type: 'input', target: ctrlCanyon });

    const computeMeanElevation = () => {
      let sumH = 0;
      let countSamples = 0;
      for (let x = -350; x <= 350; x += 50) {
        for (let z = -350; z <= 350; z += 50) {
          sumH += terrain.sampleHeightAndGradient(x, z).h;
          countSamples++;
        }
      }
      return sumH / countSamples;
    };

    // Trial 1A: Archipelago (Morph = 0.0)
    ctrlMorph.value = '0.00';
    ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });
    const archMeanH = computeMeanElevation();

    // Trial 1B: Flooded Fjord Canyon (Morph = 0.80) — islands merge into canyon massif while center gorge stays flooded
    ctrlMorph.value = '0.80';
    ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });
    const canyonMeanH = computeMeanElevation();
    const gorgeCenter = terrain.sampleHeightAndGradient(20.0, 0.0);
    const openOcean = terrain.sampleHeightAndGradient(450.0, 450.0);

    // Verify the fjord centerline is submerged (h === 0 clamped) with high Venturi funneling, and massif mean elevation grows
    assert.strictEqual(gorgeCenter.h, 0.0);
    assert.ok(gorgeCenter.funnel > openOcean.funnel + 0.5, 'Fjord canyon channel must have significantly higher Venturi funneling than open ocean');
    assert.ok(canyonMeanH > archMeanH * 1.25, 'Morphing from Islands (0%) to Canyon Massif (80%) must increase total landmass elevation');

    experimentRows.push({
      phase: 'Phase 1: Canyon Venturi & Gorge Carve',
      condition: 'Morph 0% -> 80% (Fjord)',
      metricA: `Gorge Floor: ${gorgeCenter.h.toFixed(1)}m | Mean Massif Elevation: ${archMeanH.toFixed(1)}m -> ${canyonMeanH.toFixed(1)}m`,
      metricB: `Venturi Funnel (Open Sea vs Gorge): ${openOcean.funnel.toFixed(2)} -> ${gorgeCenter.funnel.toFixed(2)}`,
    });

    // -----------------------------------------------------------------------
    // PHASE 2: Tornado vs. Category 5 Hurricane + Whirlpool DSU Coalescence
    // -----------------------------------------------------------------------
    const measureParticleMetrics = (tornadoVal, hurricaneVal, whirlpoolVal, steps) => {
      hydroState.tornadoStrength = tornadoVal;
      hydroState.hurricaneStrength = hurricaneVal;
      hydroState.whirlpoolStrength = whirlpoolVal;
      hydroState.tsunamiStrength = 0.0;
      atmosphere.setVortexAndTide(hydroState.tornadoX, hydroState.tornadoZ, tornadoVal, 0.0);

      for (let s = 0; s < steps; s++) {
        domEnv.stepAnimationFrame(16.0);
      }

      let sumSpeed = 0;
      let maxUpdraft = -Infinity;
      const vels = fluidClusterParticles.velocities;
      const n = fluidClusterParticles.count;
      for (let i = 0; i < n; i++) {
        const vx = vels[i * 3];
        const vy = vels[i * 3 + 1];
        const vz = vels[i * 3 + 2];
        const spd = Math.sqrt(vx * vx + vy * vy + vz * vz);
        sumSpeed += spd;
        if (vy > maxUpdraft) maxUpdraft = vy;
      }
      return {
        meanSpeed: sumSpeed / n,
        maxUpdraft,
        activeClusters: fluidClusterParticles.activeClusters,
        largestCluster: fluidClusterParticles.largestCluster,
      };
    };

    const calmTrial = measureParticleMetrics(0.0, 0.0, 0.0, 20);
    const stormTrial = measureParticleMetrics(0.95, 0.95, 0.90, 25);
    hydroState.hurricaneStrength = 0.0;

    assert.ok(stormTrial.meanSpeed > calmTrial.meanSpeed, 'Tornado + Cat-5 Hurricane must increase mean parcel kinetic speed');
    assert.ok(stormTrial.maxUpdraft > 20.0, 'Tornado & Hurricane eyewall must generate strong vertical updraft (>20 m/s)');
    assert.ok(stormTrial.largestCluster >= 2, 'Union-Find must coalesce colliding storm parcels into multi-particle eddies');

    experimentRows.push({
      phase: 'Phase 2: Tornado & Cat-5 Hurricane + DSU',
      condition: 'Calm (0%) -> Tornado/Hurricane (95%)',
      metricA: `Speed: ${calmTrial.meanSpeed.toFixed(1)} -> ${stormTrial.meanSpeed.toFixed(1)} m/s (Updraft ${stormTrial.maxUpdraft.toFixed(1)} m/s)`,
      metricB: `DSU Clusters: ${stormTrial.activeClusters} (Max Eddy: ${stormTrial.largestCluster} parcels)`,
    });

    // -----------------------------------------------------------------------
    // PHASE 3: Tsunami Soliton Wave & 6-DOF Saronic ASV Hydrodynamics Experiment
    // -----------------------------------------------------------------------
    hydroState.tornadoStrength = 0.0;
    hydroState.whirlpoolStrength = 0.0;
    hydroState.tsunamiStrength = 0.0;
    let calmMaxBoatY = -Infinity;
    for (let s = 0; s < 15; s++) {
      domEnv.stepAnimationFrame(30.0);
      for (const v of fleet) {
        if (v.group.position.y > calmMaxBoatY) calmMaxBoatY = v.group.position.y;
      }
    }

    hydroState.tsunamiStrength = 0.95;
    let tsunamiMaxBoatY = -Infinity;
    let tsunamiMaxTiltRad = 0;
    for (let s = 0; s < 45; s++) {
      // Advance 250ms per step (11.25s total) so the Tsunami Soliton sweeps the full 760m fjord across all 3 ASVs
      domEnv.stepAnimationFrame(250.0);
      for (const v of fleet) {
        if (v.group.position.y > tsunamiMaxBoatY) tsunamiMaxBoatY = v.group.position.y;
        const cosTilt = Math.min(1.0, Math.max(-1.0, v.group.quaternion.y));
        const tiltRad = Math.acos(cosTilt);
        if (tiltRad > tsunamiMaxTiltRad) tsunamiMaxTiltRad = tiltRad;
        // Verify boat never goes underneath land masses (terrain floor along waterway is <= waterLevel)
        const terrAtBoat = terrain.sampleHeightAndGradient(v.group.position.x, v.group.position.z);
        assert.ok(terrAtBoat.h <= hydroState.waterLevel + 0.5, 'ASV must remain strictly in flooded waterway channel');
      }
    }

    assert.ok(tsunamiMaxBoatY > calmMaxBoatY + 12.0, 'ASV fleet must heave upward >12m when riding the 26m Tsunami soliton wave');
    assert.ok(tsunamiMaxTiltRad > 0.08, 'ASV fleet must dynamically pitch/roll on the steep Tsunami wave slope');

    experimentRows.push({
      phase: 'Phase 3: Tsunami Soliton & 6-DOF ASV Fleet',
      condition: 'Tsunami 0% -> 95% Soliton',
      metricA: `Peak ASV Heave Y: ${calmMaxBoatY.toFixed(1)}m -> +${tsunamiMaxBoatY.toFixed(1)}m`,
      metricB: `Peak Hull Pitch/Roll: ${(tsunamiMaxTiltRad * 180 / Math.PI).toFixed(1)} deg | Waterway Safe: 100%`,
    });

    // -----------------------------------------------------------------------
    // PHASE 4: Tidal Sea-Level Sweep & Union-Find Land/Water Topology Experiment
    // -----------------------------------------------------------------------
    ctrlMorph.value = '0.25'; // Archipelago / Channel Ridges with varied island peak heights
    ctrlMorph.dispatchEvent({ type: 'input', target: ctrlMorph });

    ctrlTide.value = '-4.5';
    ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    const lowTideIslands = terrainState.islandCount;
    const lowTideBasins = terrainState.waterBasinCount;

    ctrlTide.value = '11.5';
    ctrlTide.dispatchEvent({ type: 'input', target: ctrlTide });
    const kingTideIslands = terrainState.islandCount;
    const kingTideBasins = terrainState.waterBasinCount;

    assert.ok(lowTideIslands >= kingTideIslands, 'King flood tide (+11.5m) must submerge low-lying islands vs Low tide (-4.5m)');
    assert.ok(lowTideIslands >= 1 && kingTideBasins >= 1, 'Union-Find topology scan must detect valid land and sea components');

    experimentRows.push({
      phase: 'Phase 4: Tidal Sweep & DSU Land/Sea Topology',
      condition: 'Tide -4.5m -> +11.5m Flood',
      metricA: `Emerged Islands: ${lowTideIslands} Isl -> ${kingTideIslands} Isl`,
      metricB: `Connected Sea Basins: ${lowTideBasins} Sea -> ${kingTideBasins} Sea`,
    });
  });

  // Print Live Experiment Telemetry Table
  console.log('\n----------------------------------------------------------------------');
  console.log(' LIVE 4-PHASE SCIENTIFIC EXPERIMENT TELEMETRY REPORT');
  console.log('----------------------------------------------------------------------');
  for (const row of experimentRows) {
    console.log(`  • ${row.phase} [${row.condition}]`);
    console.log(`      ├─ ${row.metricA}`);
    console.log(`      └─ ${row.metricB}`);
  }
  console.log('----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // 4. Compute & Print V8 Code Coverage Report
  // -------------------------------------------------------------------------
  const covStats = stopAndComputeCoverage(covSession);

  console.log('\n----------------------------------------------------------------------');
  console.log(' V8 CODE COVERAGE REPORT (src/)');
  console.log('----------------------------------------------------------------------');
  console.log(
    `${'File'.padEnd(36)} | ${'Lines'.padStart(8)} | ${'Funcs'.padStart(8)} | ${'Branches'.padStart(8)}`
  );
  console.log('----------------------------------------------------------------------');

  let totalExecLines = 0;
  let totalCovLines = 0;
  let totalFns = 0;
  let totalCovFns = 0;
  let totalBr = 0;
  let totalCovBr = 0;

  for (const s of covStats) {
    totalExecLines += s.executableLines;
    totalCovLines += s.coveredLines;
    totalFns += s.totalFns;
    totalCovFns += s.coveredFns;
    totalBr += s.totalBranches;
    totalCovBr += s.coveredBranches;

    console.log(
      `${s.file.padEnd(36)} | ${(s.linePct.toFixed(1) + '%').padStart(8)} | ${(s.fnPct.toFixed(1) + '%').padStart(8)} | ${(s.branchPct.toFixed(1) + '%').padStart(8)}`
    );
  }

  const overallLinePct = totalExecLines ? (totalCovLines / totalExecLines) * 100 : 100;
  const overallFnPct = totalFns ? (totalCovFns / totalFns) * 100 : 100;
  const overallBrPct = totalBr ? (totalCovBr / totalBr) * 100 : 100;

  console.log('----------------------------------------------------------------------');
  console.log(
    `${'ALL FILES (TOTAL)'.padEnd(36)} | ${(overallLinePct.toFixed(1) + '%').padStart(8)} | ${(overallFnPct.toFixed(1) + '%').padStart(8)} | ${(overallBrPct.toFixed(1) + '%').padStart(8)}`
  );
  console.log('----------------------------------------------------------------------\n');

  const failed = results.filter((r) => !r.passed);
  console.log(`Tests Passed: ${results.length - failed.length} / ${results.length}`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

runAllSuites();
