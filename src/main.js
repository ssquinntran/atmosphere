import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AtmosphereLayer, CLOUD_GENERA } from './layers/AtmosphereLayer.js';

const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

// Base scene (rendered to offscreen target so hardware depth is available to clouds)
const baseScene = new THREE.Scene();
baseScene.background = new THREE.Color(0x4f86c6);
baseScene.fog = new THREE.FogExp2(0x5b8ec8, 0.00055);

// Overlay scene containing only the volumetric AtmosphereLayer proxy slab
const atmosphereScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  54,
  window.innerWidth / window.innerHeight,
  1.0,
  3500.0
);
// Position camera slightly lower and tilted up toward the cloud deck so clouds are front-and-center
camera.position.set(-220, 68, 285);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 108, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 40;
controls.maxDistance = 950;
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

// Initialize AtmosphereLayer and expose handle on window for DevTools RTC/debug inspection
const atmosphere = new AtmosphereLayer({ mapExtent: 1200, maxSteps: 48 });
atmosphere.init(renderer, atmosphereScene);
atmosphere.setSceneDepthTexture(depthTexture);
atmosphere.resize(drawingSize.x, drawingSize.y);
window.atmosphereLayer = atmosphere;

// Lighting for maritime terrain & surface vessels
const sunLight = new THREE.DirectionalLight(0xfff5e0, 2.8);
baseScene.add(sunLight);

const hemiLight = new THREE.HemisphereLight(0x8ec5fc, 0x0b253a, 1.08);
baseScene.add(hemiLight);

// 1. Ocean Surface with RTC-Synchronized Drifting Cloud Shadows + Raindrop Ripple Rings
const sharedCloudUniforms = atmosphere.getSharedGroundUniforms();
const uRainSplashUniform = { value: 0.0 };

const oceanGeo = new THREE.PlaneGeometry(1400, 1400, 1, 1);
oceanGeo.rotateX(-Math.PI / 2);

const oceanMat = new THREE.MeshStandardMaterial({
  color: 0x0a3656,
  roughness: 0.22,
  metalness: 0.65,
});

// Inject analytical ripples + RTC-aware cloud shadow projection + raindrop splash rings onto y = 0
oceanMat.onBeforeCompile = (shader) => {
  shader.uniforms.uWeatherMap = sharedCloudUniforms.uWeatherMap;
  shader.uniforms.uWindAndTime = sharedCloudUniforms.uWindAndTime;
  shader.uniforms.uBoundsMinAndFade = sharedCloudUniforms.uBoundsMinAndFade;
  shader.uniforms.uBoundsMaxAndCoverage = sharedCloudUniforms.uBoundsMaxAndCoverage;
  shader.uniforms.uSunDirAndElevation = sharedCloudUniforms.uSunDirAndElevation;
  shader.uniforms.uWorldOriginOffset = sharedCloudUniforms.uWorldOriginOffset;
  shader.uniforms.uRainIntensity = uRainSplashUniform;

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
      uniform vec4 uSunDirAndElevation;
      uniform vec4 uWorldOriginOffset;
      uniform float uRainIntensity;

      float rainRingPattern(vec2 p, float t) {
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float h = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        float phase = fract(t * 1.85 + h);
        float rad = phase * 0.46;
        float ring = 1.0 - smoothstep(0.0, 0.055, abs(length(f) - rad));
        return ring * (1.0 - phase) * step(0.42, h);
      }`
    )
    .replace(
      '#include <dithering_fragment>',
      `
      // Project ocean point along sun ray onto cloud base plane (y = uBoundsMinAndFade.y)
      vec3 sunDir = normalize(uSunDirAndElevation.xyz);
      float tCloudPlane = max((uBoundsMinAndFade.y - vOceanWorldPos.y) / max(sunDir.y, 0.08), 0.0);
      vec2 shadowWorldXZ = vOceanWorldPos.xz + uWorldOriginOffset.xy + sunDir.xz * tCloudPlane;

      vec2 boxMinXZ = uBoundsMinAndFade.xz;
      vec2 boxSizeXZ = uBoundsMaxAndCoverage.xz - boxMinXZ;
      vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
      vec2 weatherUV = (shadowWorldXZ - boxMinXZ) / boxSizeXZ + windOffset * 0.00085;

      float weatherCov = texture2D(uWeatherMap, weatherUV).r;
      float cloudDensityShadow = smoothstep(
        1.0 - uBoundsMaxAndCoverage.w * 1.35,
        1.0,
        weatherCov
      );

      // Subtle procedural wave shimmer anchored to RTC world coordinates
      vec2 globalWaveXZ = vOceanWorldPos.xz + uWorldOriginOffset.xy;
      float wave = sin(globalWaveXZ.x * 0.18 + uWindAndTime.z * 1.8) *
                   cos(globalWaveXZ.y * 0.18 - uWindAndTime.z * 1.4);
      gl_FragColor.rgb += vec3(0.015, 0.035, 0.05) * wave;

      // Raindrop splash concentric ripples on water surface when raining
      if (uRainIntensity > 0.01) {
        float r1 = rainRingPattern(globalWaveXZ * 0.38, uWindAndTime.z);
        float r2 = rainRingPattern(globalWaveXZ * 0.52 + vec2(17.3, 9.1), uWindAndTime.z * 1.15);
        float splash = (r1 + r2) * uRainIntensity;
        gl_FragColor.rgb += vec3(0.18, 0.25, 0.32) * splash;
      }

      // Apply soft cloud shadow darkening on water surface
      gl_FragColor.rgb *= mix(1.0, 0.42, cloudDensityShadow * 0.82);
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

// 4. GPU-Accelerated 3D Rain Streak System (wind-slanted falling rain streaks around camera)
function createPrecipitationSystem(dropCount = 9000) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(dropCount * 6); // 2 vertices per raindrop streak
  const seeds = new Float32Array(dropCount * 2);     // 0 for top vertex, 1 for bottom tip

  for (let i = 0; i < dropCount; i++) {
    const rx = (Math.random() - 0.5) * 900;
    const ry = Math.random() * 260;
    const rz = (Math.random() - 0.5) * 900;

    const i6 = i * 6;
    positions[i6] = rx;
    positions[i6 + 1] = ry;
    positions[i6 + 2] = rz;

    positions[i6 + 3] = rx;
    positions[i6 + 4] = ry;
    positions[i6 + 5] = rz;

    seeds[i * 2] = 0.0;
    seeds[i * 2 + 1] = 1.0;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aTip', new THREE.BufferAttribute(seeds, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTime: { value: 0.0 },
      uRainIntensity: { value: 0.0 },
      uWindXZ: { value: new THREE.Vector2(8.0, 5.0) },
      uCameraPos: { value: new THREE.Vector3() },
      uCloudBaseY: { value: 95.0 },
    },
    vertexShader: /* glsl */ `
      attribute float aTip;
      uniform float uTime;
      uniform float uRainIntensity;
      uniform vec2 uWindXZ;
      uniform vec3 uCameraPos;
      uniform float uCloudBaseY;
      varying float vAlpha;

      void main() {
        float cellSpan = 750.0;
        float maxH = max(uCloudBaseY + 25.0, 90.0);

        // Wrap raindrops continuously around camera XZ so rain is always dense nearby
        vec3 basePos = position;
        float speed = 135.0 + fract(sin(basePos.x * 12.9898 + basePos.z * 78.233) * 43758.5453) * 45.0;

        float yFall = mod(basePos.y - uTime * speed, maxH);
        vec2 relXZ = mod(basePos.xz - uCameraPos.xz + cellSpan * 0.5, cellSpan) - cellSpan * 0.5;
        vec3 worldPos = vec3(uCameraPos.x + relXZ.x, yFall, uCameraPos.z + relXZ.z);

        // Slant streak along wind vector
        float streakLen = mix(4.5, 9.5, uRainIntensity);
        vec3 streakVec = normalize(vec3(uWindXZ.x * 0.35, -speed, uWindXZ.y * 0.35)) * streakLen;
        worldPos += streakVec * aTip;

        float dist = length(worldPos.xz - uCameraPos.xz);
        float distFade = 1.0 - smoothstep(140.0, 370.0, dist);
        vAlpha = uRainIntensity * distFade * (aTip > 0.5 ? 0.55 : 0.08);

        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.005) discard;
        gl_FragColor = vec4(0.78, 0.88, 0.98, vAlpha);
      }
    `,
  });

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.visible = false;
  return { lines, mat };
}

const rainSystem = createPrecipitationSystem(9000);
baseScene.add(rainSystem.lines);

// Sync scene directional light, sky colors, and rain state with AtmosphereLayer
function syncSceneLighting() {
  const sunDir = atmosphere.getSunDirection();
  sunLight.position.copy(sunDir).multiplyScalar(600);
  sunLight.color.setHex(atmosphere.state.sunColor);

  const rainDampen = 1.0 - atmosphere.state.rainIntensity * 0.38;
  sunLight.intensity = atmosphere.state.sunIntensity * 0.82 * rainDampen;

  const skyCol = new THREE.Color(atmosphere.state.skyColor);
  baseScene.background.copy(skyCol);
  baseScene.fog.color.copy(skyCol);
  baseScene.fog.density = 0.00055 + atmosphere.state.rainIntensity * 0.00065;

  uRainSplashUniform.value = atmosphere.state.rainIntensity;
  rainSystem.lines.visible = atmosphere.state.rainIntensity > 0.01;
  rainSystem.mat.uniforms.uRainIntensity.value = atmosphere.state.rainIntensity;
  rainSystem.mat.uniforms.uCloudBaseY.value = atmosphere.state.baseAltitude;
}
syncSceneLighting();

// Wire up HUD presets, 10 WMO cloud genera selector, sliders, and 4-mode shader debug inspector
const ctrlGenus = document.getElementById('ctrl-genus');
const ctrlCoverage = document.getElementById('ctrl-coverage');
const ctrlDensity = document.getElementById('ctrl-density');
const ctrlRain = document.getElementById('ctrl-rain');
const ctrlBase = document.getElementById('ctrl-base');
const ctrlSun = document.getElementById('ctrl-sun');
const ctrlWind = document.getElementById('ctrl-wind');
const ctrlSteps = document.getElementById('ctrl-steps');
const ctrlDebug = document.getElementById('ctrl-debug');
const elGenusInfo = document.getElementById('genus-info');
const elDebugCaption = document.getElementById('debug-caption');

const DEBUG_CAPTIONS = [
  'Mode 1 (Final Composite): Full physically-based volumetric clouds with sunlight scattering, self-shadowing, and rain.',
  'Mode 2 (Optical Transmittance T): Shows how much background light passes through the clouds (1.0 = clear sky, 0.0 = opaque cloud core in coral).',
  'Mode 3 (Radial Scene Depth tScene): Visualizes true 3D Euclidean distance to terrain & ocean (50m contour rings) used for soft cloud-terrain occlusion.',
  'Mode 4 (3D Noise Slice RGB): Cross-section of the GPU-baked 3D noise textures (Red = Perlin-Worley base, Green = Worley lobes, Blue = high-freq detail, Cyan = active cloud boundary).',
];

function refreshControlReadouts() {
  ctrlGenus.value = atmosphere.state.cloudGenus;
  ctrlCoverage.value = atmosphere.state.coverage;
  ctrlDensity.value = atmosphere.state.densityMultiplier;
  ctrlRain.value = atmosphere.state.rainIntensity;
  ctrlBase.value = atmosphere.state.baseAltitude;
  ctrlSun.value = atmosphere.state.sunElevationDeg;
  ctrlWind.value = atmosphere.state.windSpeed;
  ctrlSteps.value = atmosphere.state.maxSteps;
  ctrlDebug.value = String(atmosphere.state.debugMode);

  document.getElementById('val-coverage').textContent = `${Math.round(atmosphere.state.coverage * 100)}%`;
  document.getElementById('val-density').textContent = `${atmosphere.state.densityMultiplier.toFixed(2)}×`;
  document.getElementById('val-rain').textContent = `${Math.round(atmosphere.state.rainIntensity * 100)}%`;
  document.getElementById('val-base').textContent = `${atmosphere.state.baseAltitude} m`;
  document.getElementById('val-sun').textContent = `${atmosphere.state.sunElevationDeg}°`;
  document.getElementById('val-wind').textContent = `${atmosphere.state.windSpeed} m/s`;
  document.getElementById('val-steps').textContent = `${atmosphere.state.maxSteps}`;

  const genusMeta = CLOUD_GENERA[atmosphere.state.cloudGenus];
  if (genusMeta && elGenusInfo) {
    elGenusInfo.innerHTML = `<strong>${genusMeta.name} · ${genusMeta.etage}:</strong> ${genusMeta.description}`;
  }

  if (elDebugCaption) {
    elDebugCaption.textContent = DEBUG_CAPTIONS[atmosphere.state.debugMode] ?? DEBUG_CAPTIONS[0];
  }
}
refreshControlReadouts();

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    atmosphere.applyPreset(btn.dataset.preset);
    syncSceneLighting();
    refreshControlReadouts();
  });
});

ctrlGenus.addEventListener('change', (e) => {
  document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  atmosphere.setCloudGenus(e.target.value);
  syncSceneLighting();
  refreshControlReadouts();
});

ctrlCoverage.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ coverage: parseFloat(e.target.value) });
  refreshControlReadouts();
});

ctrlDensity.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ densityMultiplier: parseFloat(e.target.value) });
  refreshControlReadouts();
});

ctrlRain.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ rainIntensity: parseFloat(e.target.value) });
  syncSceneLighting();
  refreshControlReadouts();
});

ctrlBase.addEventListener('input', (e) => {
  atmosphere.setEnvironment({ baseAltitude: parseFloat(e.target.value) });
  syncSceneLighting();
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

// Main render loop state & WebGL2 context loss/recovery lifecycle
const startTime = performance.now();
let lastFrameTime = startTime;
let frameCount = 0;
let fpsAccumTime = 0;
let isContextLost = false;
let rafId = null;

const elFps = document.getElementById('stat-fps');
const elGpu = document.getElementById('stat-gpu');
const elCalls = document.getElementById('stat-calls');

canvas.addEventListener(
  'webglcontextlost',
  (event) => {
    event.preventDefault();
    isContextLost = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    atmosphere.onContextLost();
    elFps.textContent = 'CTX LOST';
    elGpu.textContent = '-- ms';
  },
  false
);

canvas.addEventListener(
  'webglcontextrestored',
  () => {
    isContextLost = false;
    renderer.getDrawingBufferSize(drawingSize);
    sceneTarget.setSize(drawingSize.x, drawingSize.y);

    atmosphere.onContextRestored(renderer);
    atmosphere.setSceneDepthTexture(depthTexture);
    atmosphere.resize(drawingSize.x, drawingSize.y);
    syncSceneLighting();

    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(animate);
  },
  false
);

function animate(now) {
  if (isContextLost) return;
  rafId = requestAnimationFrame(animate);

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

  // Update 3D rain streaks around camera
  if (rainSystem.lines.visible) {
    rainSystem.mat.uniforms.uTime.value = elapsed;
    rainSystem.mat.uniforms.uCameraPos.value.copy(camera.position);
    const windAngle = THREE.MathUtils.degToRad(32);
    rainSystem.mat.uniforms.uWindXZ.value.set(
      Math.cos(windAngle) * atmosphere.state.windSpeed,
      Math.sin(windAngle) * atmosphere.state.windSpeed
    );
  }

  atmosphere.update(elapsed, camera);

  // Pass 1: Render opaque maritime scene + 3D rainfall into offscreen render target + DepthTexture
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

rafId = requestAnimationFrame(animate);
