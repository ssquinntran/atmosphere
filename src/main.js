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
// Position camera looking across the fjord canyon entrance up into the mountain & cloud deck
camera.position.set(-225, 82, 295);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 105, 0);
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

// 2. Continuous Morphable Landform System (Islands <-> Merged Canyon Mountains <-> Alpine Massif)
const terrainState = {
  morph: 0.65,       // 0.0 = Scattered Islands, 0.5 = Fjord Canyon Range, 1.0 = Connected Alpine Massif
  peakHeight: 245.0, // Maximum peak elevation in meters (cuts right through low & mid cloud decks)
  canyonDepth: 0.70, // Depth of winding central fjord & cross-gorge carving [0..1]
};

function createMorphableTerrain() {
  const segs = 200;
  const geo = new THREE.PlaneGeometry(1200, 1200, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);

  // Precompute spatial basis fields once so real-time slider morphing runs at 60 FPS
  const islandBasis = new Float32Array(count);
  const massifBasis = new Float32Array(count);
  const canyonCarveBasis = new Float32Array(count);
  const ridgeDetailBasis = new Float32Array(count);

  const islands = [
    { x: -135, z: -85, radius: 185, weight: 1.0 },
    { x: 175, z: -135, radius: 155, weight: 0.84 },
    { x: 145, z: 155, radius: 140, weight: 0.68 },
    { x: -165, z: 145, radius: 130, weight: 0.74 },
  ];

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);

    // Multi-frequency ridge & crag noise
    const ridge =
      0.76 +
      0.16 * Math.sin(x * 0.028) * Math.cos(z * 0.028) +
      0.10 * Math.sin(x * 0.065 + z * 0.055) +
      0.05 * Math.cos(x * 0.13 - z * 0.11);
    ridgeDetailBasis[i] = ridge;

    // A) Detached archipelago islands field [0..1]
    let islH = 0.0;
    for (const isl of islands) {
      const dx = x - isl.x;
      const dz = z - isl.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < isl.radius) {
        const falloff = Math.cos((dist / isl.radius) * (Math.PI * 0.5));
        islH = Math.max(islH, Math.pow(falloff, 1.55) * isl.weight * ridge);
      }
    }
    islandBasis[i] = islH;

    // B) Continuous merged mountain massif envelope (two parallel curved cordilleras + central plateau)
    const radialDist = Math.sqrt(x * x + z * z);
    const mapEnvelope = Math.max(0.0, 1.0 - Math.pow(radialDist / 530.0, 2.2));

    // Twin mountain spines running NW-SE and NE-SW that merge as morph increases
    const spine1Dist = Math.abs((x + 125.0) + Math.sin(z * 0.0065) * 95.0);
    const spine2Dist = Math.abs((x - 135.0) - Math.sin(z * 0.0060 + 0.8) * 90.0);
    const spine1 = Math.exp(-(spine1Dist * spine1Dist) / (2.0 * 145.0 * 145.0));
    const spine2 = Math.exp(-(spine2Dist * spine2Dist) / (2.0 * 145.0 * 145.0));

    // High-altitude saddle connecting the ranges
    const saddle = Math.exp(-((x * x + z * z) / (2.0 * 280.0 * 280.0))) * 0.78;
    const rawMassif = Math.min(1.15, Math.max(spine1, spine2) * 0.95 + saddle * 0.55);
    massifBasis[i] = rawMassif * mapEnvelope * ridge;

    // C) Winding main fjord canyon + tributary side gorge (carves steep canyon walls)
    const mainMeander = Math.sin(z * 0.0075) * 68.0 + Math.cos(z * 0.016) * 24.0;
    const distMainCanyon = Math.abs(x - mainMeander);

    // Side gorge branching East-West so wind & clouds have intersecting canyon corridors
    const sideMeander = Math.cos(x * 0.008) * 52.0 - 15.0;
    const distSideGorge = Math.abs(z - sideMeander);

    // Steep V/U-shaped canyon wall profile
    const canyonWidth = 68.0;
    const sideWidth = 48.0;
    const mainCut = Math.exp(-Math.pow(distMainCanyon / canyonWidth, 2.4));
    const sideCut = Math.exp(-Math.pow(distSideGorge / sideWidth, 2.2)) * 0.78;

    canyonCarveBasis[i] = Math.min(1.0, Math.max(mainCut, sideCut));
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.06,
  });

  // Project RTC-synchronized drifting cloud shadows onto mountain peaks & canyon walls
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWeatherMap = sharedCloudUniforms.uWeatherMap;
    shader.uniforms.uWindAndTime = sharedCloudUniforms.uWindAndTime;
    shader.uniforms.uBoundsMinAndFade = sharedCloudUniforms.uBoundsMinAndFade;
    shader.uniforms.uBoundsMaxAndCoverage = sharedCloudUniforms.uBoundsMaxAndCoverage;
    shader.uniforms.uSunDirAndElevation = sharedCloudUniforms.uSunDirAndElevation;
    shader.uniforms.uWorldOriginOffset = sharedCloudUniforms.uWorldOriginOffset;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorldPos;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorldPos;
        uniform sampler2D uWeatherMap;
        uniform vec4 uWindAndTime;
        uniform vec4 uBoundsMinAndFade;
        uniform vec4 uBoundsMaxAndCoverage;
        uniform vec4 uSunDirAndElevation;
        uniform vec4 uWorldOriginOffset;`
      )
      .replace(
        '#include <dithering_fragment>',
        `
        vec3 sunDir = normalize(uSunDirAndElevation.xyz);
        float tCloudPlane = max((uBoundsMinAndFade.y - vTerrainWorldPos.y) / max(sunDir.y, 0.08), 0.0);
        vec2 shadowWorldXZ = vTerrainWorldPos.xz + uWorldOriginOffset.xy + sunDir.xz * tCloudPlane;

        vec2 boxMinXZ = uBoundsMinAndFade.xz;
        vec2 boxSizeXZ = uBoundsMaxAndCoverage.xz - boxMinXZ;
        vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
        vec2 weatherUV = (shadowWorldXZ - boxMinXZ) / boxSizeXZ + windOffset * 0.00085;

        float weatherCov = texture2D(uWeatherMap, weatherUV).r;
        float cloudShadow = smoothstep(
          1.0 - uBoundsMaxAndCoverage.w * 1.35,
          1.0,
          weatherCov
        );

        // Fade shadow above cloud top so peaks poking above low clouds stay sunlit
        float aboveCloudFade = 1.0 - smoothstep(uBoundsMinAndFade.y, uBoundsMaxAndCoverage.y, vTerrainWorldPos.y);
        gl_FragColor.rgb *= mix(1.0, 0.45, cloudShadow * aboveCloudFade * 0.78);
        #include <dithering_fragment>`
      );
  };

  const mesh = new THREE.Mesh(geo, mat);

  const colSand = new THREE.Color(0xc2b280);
  const colCanyonTerrace = new THREE.Color(0x7c5844);
  const colForest = new THREE.Color(0x2d4c39);
  const colRock = new THREE.Color(0x56606b);
  const colSnow = new THREE.Color(0xeef4f8);
  const colTemp = new THREE.Color();

  function updateGeometry() {
    const morph = terrainState.morph;
    const peakScale = terrainState.peakHeight;
    const canyonStrength = terrainState.canyonDepth;
    const colorAttr = geo.attributes.color;
    const colorArr = colorAttr.array;

    for (let i = 0; i < count; i++) {
      const isl = islandBasis[i];
      const massif = massifBasis[i];
      const cut = canyonCarveBasis[i];
      const ridge = ridgeDetailBasis[i];

      // Smoothly bridge islands into connected mountain massif as morph goes 0 -> 1
      const combinedLand = THREE.MathUtils.lerp(isl, Math.max(isl * 0.85, massif), morph);

      // Carve deep steep-walled canyons through the merged massif (strongest when morph > 0.15)
      const activeCanyonCut = cut * canyonStrength * THREE.MathUtils.smoothstep(morph, 0.05, 0.55);

      // Add terraced canyon cliff steps along vertical walls
      const rawNormalizedH = combinedLand * (1.0 - activeCanyonCut * 0.92);
      const terraceStep = Math.sin(rawNormalizedH * 22.0) * 0.018 * activeCanyonCut;

      const h = (rawNormalizedH + terraceStep) * peakScale - 8.0;
      pos.setY(i, h);

      // Elevation & canyon-wall biome coloring (Beach -> Forest / Canyon Red-Slate -> Alpine Rock -> Snow Caps)
      if (h < 4.5) {
        colTemp.copy(colSand);
      } else if (h < 88.0) {
        const t = (h - 4.5) / 83.5;
        // Blend warm canyon terracotta/slate into canyon walls when carved
        const wallTint = Math.min(1.0, activeCanyonCut * 1.6);
        colTemp.copy(colForest).lerp(colCanyonTerrace, wallTint * 0.65).lerp(colRock, t * 0.75);
      } else if (h < 185.0) {
        const t = (h - 88.0) / 97.0;
        colTemp.copy(colRock).lerp(colCanyonTerrace, activeCanyonCut * 0.35 * (1.0 - t));
      } else {
        const snowFactor = Math.min(1.0, (h - 185.0) / 55.0 + (ridge - 0.75) * 0.6);
        colTemp.copy(colRock).lerp(colSnow, Math.max(0.0, snowFactor));
      }

      colorArr[i * 3] = colTemp.r;
      colorArr[i * 3 + 1] = colTemp.g;
      colorArr[i * 3 + 2] = colTemp.b;
    }

    pos.needsUpdate = true;
    colorAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  updateGeometry();
  return { mesh, updateGeometry };
}

const terrain = createMorphableTerrain();
baseScene.add(terrain.mesh);

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
  { mesh: createVesselMesh(0x38bdf8), cx: 0, cz: 215, rx: 165, rz: 65, speed: 0.11, phase: 0.0 },
  { mesh: createVesselMesh(0x38bdf8), cx: 0, cz: -215, rx: 165, rz: 65, speed: 0.10, phase: 1.4 },
  { mesh: createVesselMesh(0x34d399), cx: -10, cz: 0, rx: 22, rz: 240, speed: 0.08, phase: 0.6 },
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

// Wire up HUD presets, 10 WMO cloud genera selector, landform morph sliders, and 4-mode shader debug inspector
const ctrlGenus = document.getElementById('ctrl-genus');
const ctrlTerrainMorph = document.getElementById('ctrl-terrain-morph');
const ctrlPeakHeight = document.getElementById('ctrl-peak-height');
const ctrlCanyonDepth = document.getElementById('ctrl-canyon-depth');
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
  'Mode 3 (Radial Scene Depth tScene): Visualizes true 3D Euclidean distance to mountain ridges & canyons (50m contour rings) used for soft cloud-terrain occlusion.',
  'Mode 4 (3D Noise Slice RGB): Cross-section of the GPU-baked 3D noise textures (Red = Perlin-Worley base, Green = Worley lobes, Blue = high-freq detail, Cyan = active cloud boundary).',
];

function formatMorphLabel(m) {
  const pct = Math.round(m * 100);
  if (m < 0.22) return `${pct}% (Islands)`;
  if (m < 0.52) return `${pct}% (Channel Ridges)`;
  if (m < 0.82) return `${pct}% (Fjord Canyon)`;
  return `${pct}% (Alpine Massif)`;
}

function refreshControlReadouts() {
  ctrlGenus.value = atmosphere.state.cloudGenus;
  ctrlTerrainMorph.value = terrainState.morph;
  ctrlPeakHeight.value = terrainState.peakHeight;
  ctrlCanyonDepth.value = terrainState.canyonDepth;
  ctrlCoverage.value = atmosphere.state.coverage;
  ctrlDensity.value = atmosphere.state.densityMultiplier;
  ctrlRain.value = atmosphere.state.rainIntensity;
  ctrlBase.value = atmosphere.state.baseAltitude;
  ctrlSun.value = atmosphere.state.sunElevationDeg;
  ctrlWind.value = atmosphere.state.windSpeed;
  ctrlSteps.value = atmosphere.state.maxSteps;
  ctrlDebug.value = String(atmosphere.state.debugMode);

  document.getElementById('val-terrain-morph').textContent = formatMorphLabel(terrainState.morph);
  document.getElementById('val-peak-height').textContent = `${Math.round(terrainState.peakHeight)} m`;
  document.getElementById('val-canyon-depth').textContent = `${Math.round(terrainState.canyonDepth * 100)}%`;

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

ctrlTerrainMorph.addEventListener('input', (e) => {
  terrainState.morph = parseFloat(e.target.value);
  terrain.updateGeometry();
  refreshControlReadouts();
});

ctrlPeakHeight.addEventListener('input', (e) => {
  terrainState.peakHeight = parseFloat(e.target.value);
  terrain.updateGeometry();
  refreshControlReadouts();
});

ctrlCanyonDepth.addEventListener('input', (e) => {
  terrainState.canyonDepth = parseFloat(e.target.value);
  terrain.updateGeometry();
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

  // Advance patrolling USV fleet along channel tracks (including through the central fjord canyon)
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
