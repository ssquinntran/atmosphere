import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AtmosphereLayer } from './layers/AtmosphereLayer.js';

const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// Base scene (rendered to offscreen target so hardware depth is available to clouds)
const baseScene = new THREE.Scene();
baseScene.background = new THREE.Color(0x6ea4d8);
baseScene.fog = new THREE.FogExp2(0x7aaad8, 0.00075);

// Overlay scene containing only the volumetric AtmosphereLayer proxy slab
const atmosphereScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  52,
  window.innerWidth / window.innerHeight,
  1.0,
  3500.0
);
camera.position.set(-210, 145, 290);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 45, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 40;
controls.maxDistance = 850;
controls.update();

// Offscreen WebGLRenderTarget with hardware DepthTexture
const drawingSize = new THREE.Vector2();
renderer.getDrawingBufferSize(drawingSize);

const depthTexture = new THREE.DepthTexture(drawingSize.x, drawingSize.y);
depthTexture.type = THREE.UnsignedIntType;

const sceneTarget = new THREE.WebGLRenderTarget(drawingSize.x, drawingSize.y, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
  depthTexture,
});

// Initialize AtmosphereLayer
const atmosphere = new AtmosphereLayer({ mapExtent: 1200, maxSteps: 36 });
atmosphere.init(renderer, atmosphereScene);
atmosphere.setSceneDepthTexture(depthTexture);
atmosphere.resize(drawingSize.x, drawingSize.y);

// Lighting for maritime terrain & surface vessels
const sunLight = new THREE.DirectionalLight(0xfff3dc, 2.6);
baseScene.add(sunLight);

const hemiLight = new THREE.HemisphereLight(0x8ec5fc, 0x0b253a, 1.05);
baseScene.add(hemiLight);

// 1. Ocean Surface with Projected Drifting Cloud Shadows
const sharedCloudUniforms = atmosphere.getSharedGroundUniforms();
const oceanGeo = new THREE.PlaneGeometry(1400, 1400, 1, 1);
oceanGeo.rotateX(-Math.PI / 2);

const oceanMat = new THREE.MeshStandardMaterial({
  color: 0x0a3656,
  roughness: 0.22,
  metalness: 0.65,
});

// Inject analytical ripples + cloud shadow projection onto y = uCloudMinY
oceanMat.onBeforeCompile = (shader) => {
  shader.uniforms.uWeatherMap = sharedCloudUniforms.uWeatherMap;
  shader.uniforms.uWindAndTime = sharedCloudUniforms.uWindAndTime;
  shader.uniforms.uBoundsMinAndFade = sharedCloudUniforms.uBoundsMinAndFade;
  shader.uniforms.uBoundsMaxAndCoverage = sharedCloudUniforms.uBoundsMaxAndCoverage;
  shader.uniforms.uSunDirAndElevation = sharedCloudUniforms.uSunDirAndElevation;

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec3 vOceanWorldPos;`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vOceanWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec3 vOceanWorldPos;
       uniform sampler2D uWeatherMap;
       uniform vec4 uWindAndTime;
       uniform vec4 uBoundsMinAndFade;
       uniform vec4 uBoundsMaxAndCoverage;
       uniform vec4 uSunDirAndElevation;`
    )
    .replace(
      '#include <dithering_fragment>',
      `
       // Project ocean point along sun ray onto cloud base plane (y = uBoundsMinAndFade.y)
       vec3 sunDir = normalize(uSunDirAndElevation.xyz);
       float tCloudPlane = max((uBoundsMinAndFade.y - vOceanWorldPos.y) / max(sunDir.y, 0.08), 0.0);
       vec2 shadowWorldXZ = vOceanWorldPos.xz + sunDir.xz * tCloudPlane;

       vec2 boxMinXZ = uBoundsMinAndFade.xz;
       vec2 boxSizeXZ = uBoundsMaxAndCoverage.xz - boxMinXZ;
       vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
       vec2 weatherUV = (shadowWorldXZ - boxMinXZ) / boxSizeXZ + windOffset * 0.00085;

       float weatherCov = texture2D(uWeatherMap, weatherUV).r;
       float cloudDensityShadow = smoothstep(
         1.0 - uBoundsMaxAndCoverage.w * 1.25,
         1.0,
         weatherCov
       );

       // Subtle procedural wave shimmer
       float wave = sin(vOceanWorldPos.x * 0.18 + uWindAndTime.z * 1.8) *
                    cos(vOceanWorldPos.z * 0.18 - uWindAndTime.z * 1.4);
       gl_FragColor.rgb += vec3(0.015, 0.035, 0.05) * wave;

       // Apply soft cloud shadow darkening on water surface
       gl_FragColor.rgb *= mix(1.0, 0.46, cloudDensityShadow * 0.78);
       #include <dithering_fragment>`
    );
};

const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
baseScene.add(oceanMesh);

// 2. Coastal Archipelago Terrain (peaks rise into [95m, 225m] to verify depth occlusion)
function buildArchipelagoTerrain() {
  const geo = new THREE.PlaneGeometry(1200, 1200, 180, 180);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const islands = [
    { x: -120, z: -90, radius: 190, peak: 148 },
    { x: 185, z: -150, radius: 150, peak: 118 },
    { x: 140, z: 165, radius: 130, peak: 82 },
  ];

  const colSand = new THREE.Color(0xc2b280);
  const colForest = new THREE.Color(0x2d4c39);
  const colRock = new THREE.Color(0x5a626a);
  const colTemp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let h = -8.0;

    for (const isl of islands) {
      const dx = x - isl.x;
      const dz = z - isl.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < isl.radius) {
        const falloff = Math.cos((dist / isl.radius) * (Math.PI * 0.5));
        const ridge =
          0.78 +
          0.14 * Math.sin(x * 0.035) * Math.cos(z * 0.035) +
          0.08 * Math.sin(x * 0.09 + z * 0.07);
        h = Math.max(h, Math.pow(falloff, 1.65) * isl.peak * ridge - 6.0);
      }
    }

    pos.setY(i, h);

    if (h < 4.5) {
      colTemp.copy(colSand);
    } else if (h < 78.0) {
      colTemp.copy(colForest).lerp(colRock, (h - 4.5) / 110.0);
    } else {
      colTemp.copy(colRock);
    }

    colors[i * 3] = colTemp.r;
    colors[i * 3 + 1] = colTemp.g;
    colors[i * 3 + 2] = colTemp.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.05,
  });

  return new THREE.Mesh(geo, mat);
}

baseScene.add(buildArchipelagoTerrain());

// 3. Autonomous Surface Vessel (USV) Fleet Markers
function createVesselMesh(accentHex) {
  const group = new THREE.Group();

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.35,
    metalness: 0.7,
  });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.2, 16.0), hullMat);
  hull.position.y = 1.1;
  group.add(hull);

  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.1, 3.6, 2.4), hullMat);
  mast.position.set(0, 3.4, -1.5);
  group.add(mast);

  const beaconMat = new THREE.MeshBasicMaterial({ color: accentHex });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.65, 10, 10), beaconMat);
  beacon.position.set(0, 5.5, -1.5);
  group.add(beacon);

  // V-shaped wake ribbon
  const wakeGeo = new THREE.PlaneGeometry(14, 48);
  wakeGeo.rotateX(-Math.PI / 2);
  const wakeMat = new THREE.MeshBasicMaterial({
    color: 0xbfe6ff,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const wake = new THREE.Mesh(wakeGeo, wakeMat);
  wake.position.set(0, 0.15, -28);
  group.add(wake);

  return group;
}

const fleet = [
  { mesh: createVesselMesh(0x38bdf8), cx: 20, cz: 30, rx: 140, rz: 95, speed: 0.11, phase: 0.0 },
  { mesh: createVesselMesh(0x38bdf8), cx: 35, cz: 45, rx: 155, rz: 110, speed: 0.11, phase: 0.45 },
  { mesh: createVesselMesh(0x34d399), cx: -40, cz: 140, rx: 120, rz: 70, speed: -0.09, phase: 1.8 },
];
fleet.forEach((v) => baseScene.add(v.mesh));

// Sync scene directional light & sky colors with AtmosphereLayer
function syncSceneLighting() {
  const sunDir = atmosphere.getSunDirection();
  sunLight.position.copy(sunDir).multiplyScalar(600);
  sunLight.color.setHex(atmosphere.state.sunColor);
  sunLight.intensity = atmosphere.state.sunIntensity * 0.85;

  const skyCol = new THREE.Color(atmosphere.state.skyColor);
  baseScene.background.copy(skyCol);
  baseScene.fog.color.copy(skyCol);
}
syncSceneLighting();

// Wire up HUD presets, sliders, and 4-mode shader debug inspector
const ctrlCoverage = document.getElementById('ctrl-coverage');
const ctrlBase = document.getElementById('ctrl-base');
const ctrlSun = document.getElementById('ctrl-sun');
const ctrlWind = document.getElementById('ctrl-wind');
const ctrlSteps = document.getElementById('ctrl-steps');
const ctrlDebug = document.getElementById('ctrl-debug');

function refreshControlReadouts() {
  ctrlCoverage.value = atmosphere.state.coverage;
  ctrlBase.value = atmosphere.state.baseAltitude;
  ctrlSun.value = atmosphere.state.sunElevationDeg;
  ctrlWind.value = atmosphere.state.windSpeed;
  ctrlSteps.value = atmosphere.state.maxSteps;
  ctrlDebug.value = String(atmosphere.state.debugMode);

  document.getElementById('val-coverage').textContent = `${Math.round(atmosphere.state.coverage * 100)}%`;
  document.getElementById('val-base').textContent = `${atmosphere.state.baseAltitude} m`;
  document.getElementById('val-sun').textContent = `${atmosphere.state.sunElevationDeg}°`;
  document.getElementById('val-wind').textContent = `${atmosphere.state.windSpeed} m/s`;
  document.getElementById('val-steps').textContent = `${atmosphere.state.maxSteps}`;
}

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    atmosphere.applyPreset(btn.dataset.preset);
    syncSceneLighting();
    refreshControlReadouts();
  });
});

ctrlCoverage.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ coverage: parseFloat(e.target.value) });
  refreshControlReadouts();
});

ctrlBase.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ baseAltitude: parseFloat(e.target.value) });
  refreshControlReadouts();
});

ctrlSun.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ sunElevationDeg: parseFloat(e.target.value) });
  syncSceneLighting();
  refreshControlReadouts();
});

ctrlWind.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ windSpeed: parseFloat(e.target.value) });
  refreshControlReadouts();
});

ctrlSteps.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ maxSteps: parseInt(e.target.value, 10) });
  refreshControlReadouts();
});

ctrlDebug.addEventListener('change', (e) => {
  atmosphere.setDebugMode(parseInt(e.target.value, 10));
  refreshControlReadouts();
});

// Number keys 1-4 switch Shader Debug View modes (0..3)
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key >= '1' && e.key <= '4') {
    atmosphere.setDebugMode(parseInt(e.key, 10) - 1);
    refreshControlReadouts();
  }
});

// Full-screen quad blit for baseScene color buffer before compositing clouds
const blitScene = new THREE.Scene();
const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const blitMat = new THREE.MeshBasicMaterial({ map: sceneTarget.texture, depthTest: false, depthWrite: false });
blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat));

// Resize handling
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
  renderer.getDrawingBufferSize(drawingSize);
  sceneTarget.setSize(drawingSize.x, drawingSize.y);
  atmosphere.resize(drawingSize.x, drawingSize.y);
});

// Main render loop with rolling FPS & isolated GPU pass timing
const startTime = performance.now();
let lastFrameTime = startTime;
let frameCount = 0;
let fpsAccumTime = 0;

const elFps = document.getElementById('stat-fps');
const elGpu = document.getElementById('stat-gpu');
const elCalls = document.getElementById('stat-calls');

function animate(now) {
  requestAnimationFrame(animate);

  const dt = (now - lastFrameTime) * 0.001;
  lastFrameTime = now;
  const elapsed = (now - startTime) * 0.001;

  controls.update();

  // Advance patrolling USV fleet along elliptical channel tracks
  for (const v of fleet) {
    const angle = elapsed * v.speed + v.phase;
    const nextAngle = angle + (v.speed >= 0 ? 0.02 : -0.02);
    const x = v.cx + Math.cos(angle) * v.rx;
    const z = v.cz + Math.sin(angle) * v.rz;
    const nx = v.cx + Math.cos(nextAngle) * v.rx;
    const nz = v.cz + Math.sin(nextAngle) * v.rz;

    v.mesh.position.set(x, 0, z);
    v.mesh.lookAt(nx, 0, nz);
  }

  atmosphere.update(elapsed, camera);

  // Pass 1: Render opaque maritime scene into offscreen render target + DepthTexture
  renderer.setRenderTarget(sceneTarget);
  renderer.clear();
  renderer.render(baseScene, camera);

  // Pass 2: Blit base scene color to screen, then composite volumetric AtmosphereLayer
  renderer.setRenderTarget(null);
  renderer.autoClear = false;
  renderer.clear();
  renderer.render(blitScene, blitCam);

  atmosphere.beginGpuTimer();
  renderer.render(atmosphereScene, camera);
  atmosphere.endGpuTimer();
  renderer.autoClear = true;

  // Update telemetry every 300 ms
  frameCount++;
  fpsAccumTime += dt;
  if (fpsAccumTime >= 0.3) {
    const fps = Math.round(frameCount / fpsAccumTime);
    elFps.textContent = `${fps} FPS`;
    elGpu.textContent =
      atmosphere.lastGpuPassMs !== null
        ? `${atmosphere.lastGpuPassMs.toFixed(2)} ms`
        : `${(1000 / Math.max(fps, 1)).toFixed(1)} ms (CPU)`;
    elCalls.textContent = `${renderer.info.render.calls}`;
    frameCount = 0;
    fpsAccumTime = 0;
  }
}

requestAnimationFrame(animate);
