import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AtmosphereLayer, CLOUD_GENERA, STORM_TYPES } from './layers/AtmosphereLayer.js';
import {
  LagrangianVortexParticleSystem,
  analyzeTerrainTopologyUnionFind,
} from './physics/FluidClusterPhysics.js';

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
camera.position.set(-165, 64, 265);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 68, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 25;
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

// Lighting for maritime terrain & Saronic surface vessels
const sunLight = new THREE.DirectionalLight(0xfff5e0, 2.8);
baseScene.add(sunLight);

const hemiLight = new THREE.HemisphereLight(0x8ec5fc, 0x0b253a, 1.08);
baseScene.add(hemiLight);

// Shared analytical waterway centerline functions so gorges are ALWAYS flooded and boats follow them
function getMainFjordX(z) {
  return Math.sin(z * 0.0065) * 65.0 + Math.cos(z * 0.014) * 20.0;
}

function getCrossGorgeZ(x) {
  return Math.cos(x * 0.0068) * 48.0 - 10.0;
}

// Extreme Maritime & Atmospheric Hydrodynamics State
const hydroState = {
  tornadoStrength: 0.0,   // [0..1] Rankine waterspout / EF5 wedge tornado funnel
  hurricaneStrength: 0.0, // [0..1] Category 5 Hurricane eyewall, spiral bands & storm surge dome
  tornadoX: 0.0,
  tornadoZ: 65.0,
  tsunamiStrength: 0.0,   // [0..1] Soliton tsunami wave wall propagating through fjord channel
  tsunamiZ: 280.0,
  whirlpoolStrength: 0.0, // [0..1] Maelstrom vortex pit at central canyon junction (0, -10)
  whirlpoolX: 0.0,
  whirlpoolZ: -10.0,
  waterLevel: 0.0,        // [-5m..+12m] Tidal sea level (in & out)
};

// CPU/GPU synchronized water surface elevation & normal evaluator (for ASV pitch/roll & particle buoyancy)
function sampleWaterSurfaceHeight(x, z, elapsed) {
  let y = hydroState.waterLevel;

  // 1. Ambient Gerstner swell waves
  y +=
    Math.sin(x * 0.045 + elapsed * 1.9) * 0.55 +
    Math.cos(z * 0.038 - elapsed * 1.6) * 0.45;

  // 2. Tsunami soliton wave wall propagating Northward along Z
  if (hydroState.tsunamiStrength > 0.01) {
    const dz = z - hydroState.tsunamiZ;
    const soliton = Math.exp(-(dz * dz) / (2.0 * 34.0 * 34.0));
    const steepFront = 1.0 + 0.35 * Math.tanh(-dz * 0.08);
    y += 26.0 * hydroState.tsunamiStrength * soliton * steepFront;
  }

  // 3. Whirlpool maelstrom vortex pit at canyon junction
  if (hydroState.whirlpoolStrength > 0.01) {
    const dx = x - hydroState.whirlpoolX;
    const dz = z - hydroState.whirlpoolZ;
    const r2 = dx * dx + dz * dz;
    const pit = Math.exp(-r2 / (2.0 * 44.0 * 44.0));
    const rimWave = Math.sin(Math.sqrt(r2) * 0.16 - elapsed * 6.5) * Math.exp(-r2 / (2.0 * 75.0 * 75.0));
    y -= 15.5 * hydroState.whirlpoolStrength * pit;
    y += 1.8 * hydroState.whirlpoolStrength * rimWave;
  }

  // 4. Tornado touchdown spray mound / pressure depression
  if (hydroState.tornadoStrength > 0.01) {
    const dx = x - hydroState.tornadoX;
    const dz = z - hydroState.tornadoZ;
    const r = Math.sqrt(dx * dx + dz * dz);
    const ring = Math.exp(-Math.pow((r - 24.0) / 14.0, 2.0));
    y += 2.6 * hydroState.tornadoStrength * ring;
  }

  // 5. Category 5 Hurricane inverted-barometer storm surge dome + eyewall wave ring
  if (hydroState.hurricaneStrength > 0.01) {
    const dx = x - hydroState.tornadoX;
    const dz = z - hydroState.tornadoZ;
    const r2 = dx * dx + dz * dz;
    const r = Math.sqrt(r2);
    const surgeDome = Math.exp(-r2 / (2.0 * 115.0 * 115.0));
    const eyewallChop = Math.sin(r * 0.11 - elapsed * 5.2) * Math.exp(-Math.pow((r - 88.0) / 38.0, 2.0));
    y += (5.2 * surgeDome + 3.4 * eyewallChop) * hydroState.hurricaneStrength;
  }

  return y;
}

// 1. Subdivided Vertex-Displaced Ocean Surface (Tides, Tsunami Soliton Wave, Whirlpool Vortex & Cloud Shadows)
const sharedCloudUniforms = atmosphere.getSharedGroundUniforms();
const uRainSplashUniform = { value: 0.0 };
const uHydroParamsA = { value: new THREE.Vector4(0.0, 280.0, 0.0, 0.0) }; // x: tsunamiStrength, y: tsunamiZ, z: whirlpoolStrength, w: waterLevel
const uHydroParamsB = { value: new THREE.Vector4(0.0, -10.0, 0.0, 65.0) }; // xy: whirlpoolXZ, zw: tornadoXZ
const uTornadoStrengthUniform = { value: 0.0 };

const oceanGeo = new THREE.PlaneGeometry(1400, 1400, 180, 180);
oceanGeo.rotateX(-Math.PI / 2);

const oceanMat = new THREE.MeshStandardMaterial({
  color: 0x0a3656,
  roughness: 0.22,
  metalness: 0.65,
});

oceanMat.onBeforeCompile = (shader) => {
  shader.uniforms.uWeatherMap = sharedCloudUniforms.uWeatherMap;
  shader.uniforms.uWindAndTime = sharedCloudUniforms.uWindAndTime;
  shader.uniforms.uBoundsMinAndFade = sharedCloudUniforms.uBoundsMinAndFade;
  shader.uniforms.uBoundsMaxAndCoverage = sharedCloudUniforms.uBoundsMaxAndCoverage;
  shader.uniforms.uSunDirAndElevation = sharedCloudUniforms.uSunDirAndElevation;
  shader.uniforms.uWorldOriginOffset = sharedCloudUniforms.uWorldOriginOffset;
  shader.uniforms.uRainIntensity = uRainSplashUniform;
  shader.uniforms.uHydroA = uHydroParamsA;
  shader.uniforms.uHydroB = uHydroParamsB;
  shader.uniforms.uTornadoStrength = uTornadoStrengthUniform;

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec3 vOceanWorldPos;
      varying float vFoamIntensity;
      uniform vec4 uWindAndTime;
      uniform vec4 uWorldOriginOffset;
      uniform vec4 uHydroA;
      uniform vec4 uHydroB;
      uniform float uTornadoStrength;

      float evalOceanHeight(vec2 xz, float t, out float outFoam) {
        outFoam = 0.0;
        float h = uHydroA.w; // Tidal sea level

        // Gerstner-style wind swells
        h += sin(xz.x * 0.045 + t * 1.9) * 0.55 + cos(xz.y * 0.038 - t * 1.6) * 0.45;

        // Tsunami soliton wave wall
        float tsunamiStr = uHydroA.x;
        if (tsunamiStr > 0.01) {
          float dz = xz.y - uHydroA.y;
          float soliton = exp(-(dz * dz) / (2.0 * 34.0 * 34.0));
          float steepFront = 1.0 + 0.35 * tanh(-dz * 0.08);
          float waveH = 26.0 * tsunamiStr * soliton * steepFront;
          h += waveH;
          outFoam += smoothstep(8.0, 22.0, waveH) * 0.95;
        }

        // Whirlpool maelstrom funnel pit
        float whirlStr = uHydroA.z;
        if (whirlStr > 0.01) {
          vec2 dW = xz - uHydroB.xy;
          float r2 = dot(dW, dW);
          float r = sqrt(r2);
          float pit = exp(-r2 / (2.0 * 44.0 * 44.0));
          float spiralAngle = atan(dW.y, dW.x) + t * 4.8 - r * 0.14;
          float spiralArm = sin(spiralAngle * 3.0) * 0.5 + 0.5;
          h -= 15.5 * whirlStr * pit;
          h += 1.8 * whirlStr * (spiralArm - 0.5) * exp(-r2 / (2.0 * 75.0 * 75.0));
          outFoam += whirlStr * exp(-r2 / (2.0 * 65.0 * 65.0)) * (0.35 + 0.65 * spiralArm);
        }

        // Tornado waterspout spray collar on water
        if (uTornadoStrength > 0.01) {
          vec2 dT = xz - uHydroB.zw;
          float rT = length(dT);
          float sprayRing = exp(-pow((rT - 24.0) / 14.0, 2.0));
          h += 2.6 * uTornadoStrength * sprayRing;
          outFoam += uTornadoStrength * exp(-rT / 48.0) * 0.9;
        }

        // Category 5 Hurricane storm surge dome & eyewall wave ring
        float hurricaneStr = uWorldOriginOffset.w;
        if (hurricaneStr > 0.01) {
          vec2 dH = xz - uHydroB.zw;
          float r2H = dot(dH, dH);
          float rH = sqrt(r2H);
          float surgeDome = exp(-r2H / (2.0 * 115.0 * 115.0));
          float eyewallRing = exp(-pow((rH - 88.0) / 38.0, 2.0));
          float eyewallChop = sin(rH * 0.11 - t * 5.2) * eyewallRing;
          h += (5.2 * surgeDome + 3.4 * eyewallChop) * hurricaneStr;
          outFoam += hurricaneStr * eyewallRing * 0.85;
        }

        return h;
      }`
    )
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      float tWave = uWindAndTime.z;
      float dummyF = 0.0;
      float hC = evalOceanHeight(position.xz, tWave, dummyF);
      float hX = evalOceanHeight(position.xz + vec2(2.5, 0.0), tWave, dummyF);
      float hZ = evalOceanHeight(position.xz + vec2(0.0, 2.5), tWave, dummyF);
      objectNormal = normalize(vec3(hC - hX, 2.5, hC - hZ));`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float foamVal = 0.0;
      transformed.y += evalOceanHeight(position.xz, uWindAndTime.z, foamVal);
      vFoamIntensity = clamp(foamVal, 0.0, 1.0);
      vOceanWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec3 vOceanWorldPos;
      varying float vFoamIntensity;
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

      vec2 globalWaveXZ = vOceanWorldPos.xz + uWorldOriginOffset.xy;
      float wave = sin(globalWaveXZ.x * 0.18 + uWindAndTime.z * 1.8) *
                   cos(globalWaveXZ.y * 0.18 - uWindAndTime.z * 1.4);
      gl_FragColor.rgb += vec3(0.015, 0.035, 0.05) * wave;

      // Blend whitewater foam on tsunami crest, whirlpool spiral arms, and tornado touchdown ring
      if (vFoamIntensity > 0.01) {
        float foamTex = 0.65 + 0.35 * sin(globalWaveXZ.x * 0.45 + uWindAndTime.z * 3.0) * cos(globalWaveXZ.y * 0.45);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.88, 0.96, 1.0), clamp(vFoamIntensity * foamTex, 0.0, 0.92));
      }

      if (uRainIntensity > 0.01) {
        float r1 = rainRingPattern(globalWaveXZ * 0.38, uWindAndTime.z);
        float r2 = rainRingPattern(globalWaveXZ * 0.52 + vec2(17.3, 9.1), uWindAndTime.z * 1.15);
        float splash = (r1 + r2) * uRainIntensity;
        gl_FragColor.rgb += vec3(0.18, 0.25, 0.32) * splash;
      }

      gl_FragColor.rgb *= mix(1.0, 0.42, cloudDensityShadow * 0.82);
      #include <dithering_fragment>`
    );
};

const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
baseScene.add(oceanMesh);

// 2. Continuous Morphable Landform System + GPU Topographic Height/Flow Map (uTerrainMap)
const terrainState = {
  morph: 0.65,
  peakHeight: 245.0,
  canyonDepth: 0.70,
  islandCount: 4,
  waterBasinCount: 1,
};

function createMorphableTerrain() {
  const segs = 220;
  const gridRes = segs + 1;
  const geo = new THREE.PlaneGeometry(1200, 1200, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const heights = new Float32Array(count);

  const terrainTexData = new Uint8Array(count * 4);
  const terrainMapTex = new THREE.DataTexture(
    terrainTexData,
    gridRes,
    gridRes,
    THREE.RGBAFormat
  );
  terrainMapTex.wrapS = THREE.ClampToEdgeWrapping;
  terrainMapTex.wrapT = THREE.ClampToEdgeWrapping;
  terrainMapTex.minFilter = THREE.LinearFilter;
  terrainMapTex.magFilter = THREE.LinearFilter;
  terrainMapTex.flipY = false;

  const islandBasis = new Float32Array(count);
  const massifBasis = new Float32Array(count);
  const riverChannelMask = new Float32Array(count);
  const canyonSlopeBasis = new Float32Array(count);
  const ridgeDetailBasis = new Float32Array(count);

  const islands = [
    { x: -205, z: -165, radius: 155, weight: 1.0 },
    { x: 215, z: -160, radius: 145, weight: 0.88 },
    { x: 210, z: 175, radius: 140, weight: 0.78 },
    { x: -195, z: 175, radius: 145, weight: 0.84 },
  ];

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);

    const ridge =
      0.76 +
      0.16 * Math.sin(x * 0.028) * Math.cos(z * 0.028) +
      0.10 * Math.sin(x * 0.065 + z * 0.055) +
      0.05 * Math.cos(x * 0.13 - z * 0.11);
    ridgeDetailBasis[i] = ridge;

    const distMain = Math.abs(x - getMainFjordX(z));
    const distCross = Math.abs(z - getCrossGorgeZ(x));
    const minWaterDist = Math.min(distMain, distCross);

    const coreWater = 1.0 - THREE.MathUtils.smoothstep(minWaterDist, 28.0, 56.0);
    riverChannelMask[i] = coreWater;

    const mainWall = Math.exp(-Math.pow(distMain / 105.0, 2.1));
    const crossWall = Math.exp(-Math.pow(distCross / 88.0, 2.1)) * 0.88;
    canyonSlopeBasis[i] = Math.min(1.0, Math.max(mainWall, crossWall));

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
    islandBasis[i] = islH * (1.0 - coreWater);

    const radialDist = Math.sqrt(x * x + z * z);
    const mapEnvelope = Math.max(0.0, 1.0 - Math.pow(radialDist / 540.0, 2.2));

    const spine1Dist = Math.abs((x + 155.0) + Math.sin(z * 0.0065) * 75.0);
    const spine2Dist = Math.abs((x - 160.0) - Math.sin(z * 0.0060 + 0.8) * 75.0);
    const spine1 = Math.exp(-(spine1Dist * spine1Dist) / (2.0 * 155.0 * 155.0));
    const spine2 = Math.exp(-(spine2Dist * spine2Dist) / (2.0 * 155.0 * 155.0));

    const centralMass = Math.exp(-((x * x + z * z) / (2.0 * 320.0 * 320.0))) * 0.85;
    const rawMassif = Math.min(1.18, Math.max(spine1, spine2) * 0.96 + centralMass * 0.52);
    massifBasis[i] = rawMassif * mapEnvelope * ridge;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.06,
  });

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

        float aboveCloudFade = 1.0 - smoothstep(uBoundsMinAndFade.y, uBoundsMaxAndCoverage.y, vTerrainWorldPos.y);
        gl_FragColor.rgb *= mix(1.0, 0.45, cloudShadow * aboveCloudFade * 0.78);
        #include <dithering_fragment>`
      );
  };

  const mesh = new THREE.Mesh(geo, mat);

  const colWetShoal = new THREE.Color(0x8e7f5a);
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
    const waterLvl = hydroState.waterLevel;
    const colorAttr = geo.attributes.color;
    const colorArr = colorAttr.array;

    for (let i = 0; i < count; i++) {
      const isl = islandBasis[i];
      const massif = massifBasis[i];
      const riverCut = riverChannelMask[i];
      const slopeCut = canyonSlopeBasis[i];
      const ridge = ridgeDetailBasis[i];

      const combinedLand = THREE.MathUtils.lerp(isl, Math.max(isl * 0.85, massif), morph);
      const wallCarve = slopeCut * canyonStrength * THREE.MathUtils.smoothstep(morph, 0.05, 0.50);
      const totalCarve = Math.min(1.0, Math.max(riverCut, wallCarve * 0.92));

      const rawNormalizedH = combinedLand * (1.0 - totalCarve);
      const terraceStep = Math.sin(rawNormalizedH * 22.0) * 0.018 * wallCarve * (1.0 - riverCut);

      // Deepen river channel floor to -14m so even at Low Tide (-5m) the gorges remain navigable waterways
      const h = (rawNormalizedH + terraceStep) * peakScale - 9.5 - riverCut * 5.5;
      pos.setY(i, h);
      heights[i] = h;

      // Dynamic shoreline coloring relative to current Tidal Sea Level
      const relH = h - waterLvl;
      if (relH < 1.5) {
        colTemp.copy(colWetShoal);
      } else if (relH < 5.5) {
        colTemp.copy(colSand);
      } else if (h < 88.0) {
        const t = Math.max(0.0, (h - (waterLvl + 5.5)) / 82.5);
        const wallTint = Math.min(1.0, wallCarve * 1.6);
        colTemp.copy(colForest).lerp(colCanyonTerrace, wallTint * 0.65).lerp(colRock, t * 0.75);
      } else if (h < 185.0) {
        const t = (h - 88.0) / 97.0;
        colTemp.copy(colRock).lerp(colCanyonTerrace, wallCarve * 0.35 * (1.0 - t));
      } else {
        const snowFactor = Math.min(1.0, (h - 185.0) / 55.0 + (ridge - 0.75) * 0.6);
        colTemp.copy(colRock).lerp(colSnow, Math.max(0.0, snowFactor));
      }

      colorArr[i * 3] = colTemp.r;
      colorArr[i * 3 + 1] = colTemp.g;
      colorArr[i * 3 + 2] = colTemp.b;
    }

    const cellStepM = 1200.0 / segs;
    for (let iz = 0; iz < gridRes; iz++) {
      const zPrev = Math.max(0, iz - 1);
      const zNext = Math.min(segs, iz + 1);
      for (let ix = 0; ix < gridRes; ix++) {
        const xPrev = Math.max(0, ix - 1);
        const xNext = Math.min(segs, ix + 1);
        const idx = iz * gridRes + ix;

        const hCenter = Math.max(0.0, heights[idx]);
        const dhdx = (Math.max(0.0, heights[iz * gridRes + xNext]) - Math.max(0.0, heights[iz * gridRes + xPrev])) / (2.0 * cellStepM);
        const dhdz = (Math.max(0.0, heights[zNext * gridRes + ix]) - Math.max(0.0, heights[zPrev * gridRes + ix])) / (2.0 * cellStepM);

        const rByte = Math.min(255, Math.max(0, Math.round((hCenter / 380.0) * 255.0)));
        const gByte = Math.min(255, Math.max(0, Math.round((THREE.MathUtils.clamp(dhdx / 1.25, -1.0, 1.0) * 0.5 + 0.5) * 255.0)));
        const bByte = Math.min(255, Math.max(0, Math.round((THREE.MathUtils.clamp(dhdz / 1.25, -1.0, 1.0) * 0.5 + 0.5) * 255.0)));
        const funnel = Math.max(riverChannelMask[idx], canyonSlopeBasis[idx] * 0.65);
        const aByte = Math.min(255, Math.max(0, Math.round(funnel * 255.0)));

        const idx4 = idx * 4;
        terrainTexData[idx4] = rByte;
        terrainTexData[idx4 + 1] = gByte;
        terrainTexData[idx4 + 2] = bByte;
        terrainTexData[idx4 + 3] = aByte;
      }
    }
    terrainMapTex.needsUpdate = true;

    // Run Disjoint-Set Union-Find topological connectivity scan for Emerged Islands & Flooded Waterways
    const topo = analyzeTerrainTopologyUnionFind(heights, gridRes, waterLvl);
    terrainState.islandCount = topo.islandCount;
    terrainState.waterBasinCount = topo.waterBasinCount;

    pos.needsUpdate = true;
    colorAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function sampleHeightAndGradient(x, z) {
    const u = THREE.MathUtils.clamp((x + 600.0) / 1200.0, 0.0, 0.999);
    const v = THREE.MathUtils.clamp((z + 600.0) / 1200.0, 0.0, 0.999);
    const ix = Math.floor(u * segs);
    const iz = Math.floor(v * segs);
    const idx = iz * gridRes + ix;
    const h = Math.max(0.0, heights[idx]);
    const gx = (terrainTexData[idx * 4 + 1] / 255.0 - 0.5) * 2.5;
    const gz = (terrainTexData[idx * 4 + 2] / 255.0 - 0.5) * 2.5;
    const funnel = terrainTexData[idx * 4 + 3] / 255.0;
    return { h, gx, gz, funnel };
  }

  updateGeometry();
  return { mesh, terrainMapTex, updateGeometry, sampleHeightAndGradient };
}

const terrain = createMorphableTerrain();
baseScene.add(terrain.mesh);
atmosphere.setTerrainMap(terrain.terrainMapTex);

// 3. Lagrangian Particle Physics + Spatial Hash Grid + Disjoint-Set Union-Find Coalescence System
const fluidClusterParticles = new LagrangianVortexParticleSystem(1100);
baseScene.add(fluidClusterParticles.points);

// 4. 3D Topographic Wind Streamlines (curves around mountain peaks, spirals into tornado & funnels through gorges)
function createAirflowStreamlines(streamCount = 260, segsPerStream = 10) {
  const totalVerts = streamCount * segsPerStream * 2;
  const positions = new Float32Array(totalVerts * 3);
  const alphas = new Float32Array(totalVerts);

  const particles = [];
  for (let i = 0; i < streamCount; i++) {
    particles.push({
      x: (Math.random() - 0.5) * 980,
      baseY: 38 + Math.random() * 145,
      z: (Math.random() - 0.5) * 980,
      speedScale: 0.85 + Math.random() * 0.35,
    });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.005) discard;
        gl_FragColor = vec4(0.84, 0.95, 1.0, vAlpha * 0.32);
      }
    `,
  });

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;

  function evalFlowVelocity(x, z, baseY, baseWx, baseWz, info) {
    let vx = baseWx * (1.0 + info.funnel * 0.45);
    let vz = baseWz * (1.0 + info.funnel * 0.45);

    if (info.h > baseY - 45.0) {
      const blk = THREE.MathUtils.clamp((info.h - (baseY - 45.0)) / 75.0, 0.0, 1.8);
      vx -= info.gx * 52.0 * blk;
      vz -= info.gz * 52.0 * blk;
    }

    // Swirl streamlines into Rankine tornado vortex when active
    if (hydroState.tornadoStrength > 0.01) {
      const dx = x - hydroState.tornadoX;
      const dz = z - hydroState.tornadoZ;
      const r = Math.sqrt(dx * dx + dz * dz) + 0.1;
      if (r < 220.0) {
        const swirl = (1.0 - r / 220.0) * 125.0 * hydroState.tornadoStrength;
        const inflow = (1.0 - r / 220.0) * 42.0 * hydroState.tornadoStrength;
        vx += (-dz / r) * swirl - (dx / r) * inflow;
        vz += (dx / r) * swirl - (dz / r) * inflow;
      }
    }

    return { vx, vz };
  }

  function update(dt, windSpeed) {
    const windAngle = THREE.MathUtils.degToRad(32);
    const baseWx = Math.cos(windAngle) * Math.max(windSpeed, 2.0) * 3.2;
    const baseWz = Math.sin(windAngle) * Math.max(windSpeed, 2.0) * 3.2;
    const posAttr = geo.attributes.position;
    const alphaAttr = geo.attributes.aAlpha;
    const posArr = posAttr.array;
    const alphaArr = alphaAttr.array;

    for (let i = 0; i < streamCount; i++) {
      const p = particles[i];
      const info0 = terrain.sampleHeightAndGradient(p.x, p.z);
      const flow0 = evalFlowVelocity(p.x, p.z, p.baseY, baseWx * p.speedScale, baseWz * p.speedScale, info0);

      p.x += flow0.vx * dt;
      p.z += flow0.vz * dt;

      if (p.x > 520) p.x -= 1040;
      if (p.x < -520) p.x += 1040;
      if (p.z > 520) p.z -= 1040;
      if (p.z < -520) p.z += 1040;

      let curX = p.x;
      let curZ = p.z;
      const baseVertIdx = i * segsPerStream * 2;

      for (let s = 0; s < segsPerStream; s++) {
        const tA = terrain.sampleHeightAndGradient(curX, curZ);
        const yA = Math.max(p.baseY + tA.h * 0.35, Math.max(tA.h, hydroState.waterLevel) + 16.0);
        const fStep = evalFlowVelocity(curX, curZ, p.baseY, baseWx, baseWz, tA);

        const nextX = curX - fStep.vx * 0.085;
        const nextZ = curZ - fStep.vz * 0.085;
        const tB = terrain.sampleHeightAndGradient(nextX, nextZ);
        const yB = Math.max(p.baseY + tB.h * 0.35, Math.max(tB.h, hydroState.waterLevel) + 16.0);

        const vIdx = (baseVertIdx + s * 2) * 3;
        posArr[vIdx] = curX;
        posArr[vIdx + 1] = yA;
        posArr[vIdx + 2] = curZ;

        posArr[vIdx + 3] = nextX;
        posArr[vIdx + 4] = yB;
        posArr[vIdx + 5] = nextZ;

        alphaArr[baseVertIdx + s * 2] = 1.0 - s / segsPerStream;
        alphaArr[baseVertIdx + s * 2 + 1] = 1.0 - (s + 1) / segsPerStream;

        curX = nextX;
        curZ = nextZ;
      }
    }

    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  return { lines, update };
}

const airflowStreams = createAirflowStreamlines(260, 10);
baseScene.add(airflowStreams.lines);

// 5. Saronic Autonomous Surface Vessels (ASVs: Corsair, Cutlass, Spyglass) with 6-DOF Wave-Riding Physics
function createSaronicLogoTexture(vesselClass, hullNumber, accentCss) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#111822';
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.fillStyle = accentCss;
  ctx.fillRect(0, 0, c.width, 4);
  ctx.fillRect(0, c.height - 4, c.width, 4);

  ctx.save();
  ctx.translate(28, 22);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(42, 4);
  ctx.lineTo(80, 26);
  ctx.lineTo(66, 76);
  ctx.lineTo(42, 60);
  ctx.lineTo(18, 76);
  ctx.lineTo(4, 26);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#111822';
  ctx.beginPath();
  ctx.moveTo(42, 18);
  ctx.lineTo(62, 32);
  ctx.lineTo(54, 58);
  ctx.lineTo(42, 48);
  ctx.lineTo(30, 58);
  ctx.lineTo(22, 32);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = accentCss;
  ctx.beginPath();
  ctx.moveTo(42, 24);
  ctx.lineTo(51, 46);
  ctx.lineTo(42, 40);
  ctx.lineTo(33, 46);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#f8fafc';
  ctx.font = '800 44px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.letterSpacing = '4px';
  ctx.fillText('SARONIC', 124, 64);

  ctx.fillStyle = accentCss;
  ctx.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`${vesselClass} // ${hullNumber}`, 126, 96);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createSaronicDeckEmblemTexture(accentCss) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#151e2b';
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.lineWidth = 4;
  ctx.strokeRect(14, 14, 228, 228);

  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.moveTo(128, 36);
  ctx.lineTo(204, 82);
  ctx.lineTo(176, 178);
  ctx.lineTo(128, 148);
  ctx.lineTo(80, 178);
  ctx.lineTo(52, 82);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#151e2b';
  ctx.beginPath();
  ctx.moveTo(128, 66);
  ctx.lineTo(168, 92);
  ctx.lineTo(152, 142);
  ctx.lineTo(128, 125);
  ctx.lineTo(104, 142);
  ctx.lineTo(88, 92);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = accentCss;
  ctx.beginPath();
  ctx.moveTo(128, 78);
  ctx.lineTo(146, 122);
  ctx.lineTo(128, 110);
  ctx.lineTo(110, 122);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SARONIC', 128, 222);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createSaronicASVMesh({ vesselClass, hullNumber, accentHex, accentCss, scale = 1.0 }) {
  const group = new THREE.Group();

  const hullPositions = new Float32Array([
    0.0, 2.3, 14.5,
    0.0, 0.1, 13.2,

    -2.6, 2.2, 5.5,
     2.6, 2.2, 5.5,
    -3.1, 1.1, 5.2,
     3.1, 1.1, 5.2,
    -2.2, 0.0, 5.0,
     2.2, 0.0, 5.0,

    -2.8, 2.1, -6.5,
     2.8, 2.1, -6.5,
    -3.4, 1.1, -6.8,
     3.4, 1.1, -6.8,
    -2.5, 0.0, -6.8,
     2.5, 0.0, -6.8,

    -2.3, 1.9, -11.5,
     2.3, 1.9, -11.5,
    -2.7, 0.9, -12.0,
     2.7, 0.9, -12.0,
    -2.0, 0.0, -11.8,
     2.0, 0.0, -11.8,
  ]);

  const hullIndices = [
    0, 2, 3,
    2, 8, 9,  2, 9, 3,
    8, 14, 15, 8, 15, 9,

    0, 4, 2,
    2, 4, 10, 2, 10, 8,
    8, 10, 16, 8, 16, 14,

    0, 3, 5,
    3, 11, 5, 3, 9, 11,
    9, 15, 17, 9, 17, 11,

    1, 6, 4,  0, 1, 4,
    4, 6, 12, 4, 12, 10,
    10, 12, 18, 10, 18, 16,

    1, 5, 7,  0, 5, 1,
    5, 11, 13, 5, 13, 7,
    11, 17, 19, 11, 19, 13,

    14, 16, 17, 14, 17, 15,
    16, 18, 19, 16, 19, 17,
  ];

  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.BufferAttribute(hullPositions, 3));
  hullGeo.setIndex(hullIndices);
  hullGeo.computeVertexNormals();

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x161f2c,
    roughness: 0.32,
    metalness: 0.72,
    flatShading: true,
  });
  const hullMesh = new THREE.Mesh(hullGeo, hullMat);
  group.add(hullMesh);

  const deckHouseGeo = new THREE.ConeGeometry(2.3, 1.6, 4);
  deckHouseGeo.rotateY(Math.PI * 0.25);
  deckHouseGeo.scale(1.0, 1.0, 2.4);
  const deckHouseMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.28,
    metalness: 0.78,
    flatShading: true,
  });
  const deckHouse = new THREE.Mesh(deckHouseGeo, deckHouseMat);
  deckHouse.position.set(0, 2.7, 0.2);
  group.add(deckHouse);

  const satcom = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.16, 2.2),
    new THREE.MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.2, metalness: 0.5 })
  );
  satcom.position.set(0, 3.52, 0.5);
  satcom.rotation.x = -0.08;
  group.add(satcom);

  const mastGeo = new THREE.BoxGeometry(0.75, 3.8, 1.4);
  const mast = new THREE.Mesh(mastGeo, hullMat);
  mast.position.set(0, 4.8, -1.2);
  mast.rotation.x = -0.18;
  group.add(mast);

  const eoirTurret = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 14, 14),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.18, metalness: 0.85 })
  );
  eoirTurret.position.set(0, 6.85, -1.55);
  group.add(eoirTurret);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 10, 10),
    new THREE.MeshBasicMaterial({ color: accentHex })
  );
  beacon.position.set(0, 7.65, -1.55);
  group.add(beacon);

  const sideLogoTex = createSaronicLogoTexture(vesselClass, hullNumber, accentCss);
  const sideLogoMat = new THREE.MeshBasicMaterial({
    map: sideLogoTex,
    side: THREE.DoubleSide,
  });
  const sidePlaneGeo = new THREE.PlaneGeometry(9.6, 2.2);

  const stbdLogo = new THREE.Mesh(sidePlaneGeo, sideLogoMat);
  stbdLogo.position.set(3.05, 1.55, -0.6);
  stbdLogo.rotation.y = Math.PI * 0.5;
  stbdLogo.rotation.z = 0.01;
  stbdLogo.rotation.x = -0.22;
  group.add(stbdLogo);

  const portLogo = new THREE.Mesh(sidePlaneGeo, sideLogoMat);
  portLogo.position.set(-3.05, 1.55, -0.6);
  portLogo.rotation.y = -Math.PI * 0.5;
  portLogo.rotation.x = 0.22;
  group.add(portLogo);

  const deckLogoTex = createSaronicDeckEmblemTexture(accentCss);
  const deckLogo = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.MeshBasicMaterial({ map: deckLogoTex })
  );
  deckLogo.rotation.x = -Math.PI * 0.5;
  deckLogo.position.set(0, 2.26, 6.2);
  group.add(deckLogo);

  const bannerMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(11.5, 2.8),
    new THREE.MeshBasicMaterial({
      map: sideLogoTex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.94,
    })
  );
  bannerMesh.position.set(0, 10.2, -1.5);
  group.add(bannerMesh);

  const wakeGeo = new THREE.PlaneGeometry(16, 56);
  wakeGeo.rotateX(-Math.PI / 2);
  const wakeMat = new THREE.MeshBasicMaterial({
    color: 0xd8f3ff,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const wake = new THREE.Mesh(wakeGeo, wakeMat);
  wake.position.set(0, 0.18, -36);
  group.add(wake);

  const sprayGeo = new THREE.PlaneGeometry(5.5, 22);
  sprayGeo.rotateX(-Math.PI / 2);
  const sprayMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
  });
  const spray = new THREE.Mesh(sprayGeo, sprayMat);
  spray.position.set(0, 0.24, -21);
  group.add(spray);

  group.scale.setScalar(scale);
  return { group, bannerMesh };
}

function sampleFleetWaterwayPath(routeType, t) {
  if (routeType === 'mainFjordNorthSouth') {
    const z = Math.sin(t) * 440.0;
    const x = getMainFjordX(z) + Math.cos(t * 2.0) * 8.0;
    return { x, z };
  } else if (routeType === 'crossGorgeEastWest') {
    const x = Math.sin(t) * 430.0;
    const z = getCrossGorgeZ(x) + Math.sin(t * 2.0) * 7.0;
    return { x, z };
  } else {
    const s = Math.sin(t);
    if (s >= 0.0) {
      const z = s * 420.0;
      return { x: getMainFjordX(z) - 9.0, z };
    } else {
      const x = -s * 420.0;
      return { x, z: getCrossGorgeZ(x) + 9.0 };
    }
  }
}

const fleet = [
  {
    ...createSaronicASVMesh({
      vesselClass: 'CORSAIR',
      hullNumber: 'ASV-01',
      accentHex: 0x38bdf8,
      accentCss: '#38bdf8',
      scale: 1.15,
    }),
    routeType: 'mainFjordNorthSouth',
    speed: 0.14,
    phase: 0.2,
  },
  {
    ...createSaronicASVMesh({
      vesselClass: 'CUTLASS',
      hullNumber: 'ASV-02',
      accentHex: 0x34d399,
      accentCss: '#34d399',
      scale: 1.0,
    }),
    routeType: 'crossGorgeEastWest',
    speed: 0.16,
    phase: 1.7,
  },
  {
    ...createSaronicASVMesh({
      vesselClass: 'SPYGLASS',
      hullNumber: 'ASV-03',
      accentHex: 0xf59e0b,
      accentCss: '#f59e0b',
      scale: 0.92,
    }),
    routeType: 'canyonJunctionWeave',
    speed: 0.13,
    phase: 3.4,
  },
];
fleet.forEach((v) => baseScene.add(v.group));

// 6. GPU-Accelerated 3D Rain Streak System (wind-slanted falling rain streaks around camera)
function createPrecipitationSystem(dropCount = 9000) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(dropCount * 6);
  const seeds = new Float32Array(dropCount * 2);

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

        vec3 basePos = position;
        float speed = 135.0 + fract(sin(basePos.x * 12.9898 + basePos.z * 78.233) * 43758.5453) * 45.0;

        float yFall = mod(basePos.y - uTime * speed, maxH);
        vec2 relXZ = mod(basePos.xz - uCameraPos.xz + cellSpan * 0.5, cellSpan) - cellSpan * 0.5;
        vec3 worldPos = vec3(uCameraPos.x + relXZ.x, yFall, uCameraPos.z + relXZ.z);

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

// Sync scene directional light, sky colors, and rain/vortex state with AtmosphereLayer
function syncSceneLighting() {
  const sunDir = atmosphere.getSunDirection();
  sunLight.position.copy(sunDir).multiplyScalar(600);
  sunLight.color.setHex(atmosphere.state.sunColor);

  const stormDampen = 1.0 - Math.max(atmosphere.state.rainIntensity, hydroState.tornadoStrength * 0.8) * 0.38;
  sunLight.intensity = atmosphere.state.sunIntensity * 0.82 * stormDampen;

  const skyCol = new THREE.Color(atmosphere.state.skyColor);
  baseScene.background.copy(skyCol);
  baseScene.fog.color.copy(skyCol);
  baseScene.fog.density = 0.00055 + atmosphere.state.rainIntensity * 0.00065;

  uRainSplashUniform.value = atmosphere.state.rainIntensity;
  uTornadoStrengthUniform.value = hydroState.tornadoStrength;
  rainSystem.lines.visible = atmosphere.state.rainIntensity > 0.01;
  rainSystem.mat.uniforms.uRainIntensity.value = atmosphere.state.rainIntensity;
  rainSystem.mat.uniforms.uCloudBaseY.value = atmosphere.state.baseAltitude;
}
syncSceneLighting();

// Wire up HUD controls
const ctrlStorm = document.getElementById('ctrl-storm');
const ctrlGenus = document.getElementById('ctrl-genus');
const ctrlTornado = document.getElementById('ctrl-tornado');
const ctrlHurricane = document.getElementById('ctrl-hurricane');
const ctrlTsunami = document.getElementById('ctrl-tsunami');
const ctrlWhirlpool = document.getElementById('ctrl-whirlpool');
const ctrlTide = document.getElementById('ctrl-tide');
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
  'Mode 1 (Final Composite): Full volumetric clouds, Rankine tornado funnel, vertex-displaced tsunami/whirlpool waves, and DSU particle physics.',
  'Mode 2 (Optical Transmittance T): Shows how much background light passes through the clouds & tornado funnel (1.0 = clear sky, 0.0 = opaque core in coral).',
  'Mode 3 (Radial Scene Depth tScene): Visualizes true 3D Euclidean distance to mountains, tsunami waves & vessels (50m contour rings).',
  'Mode 4 (3D Noise & Airflow Slice): Cross-section of 3D noise + solid mountain rock cores (amber rim) showing air streamlines splitting around peaks.',
];

function formatMorphLabel(m) {
  const pct = Math.round(m * 100);
  if (m < 0.22) return `${pct}% (Islands)`;
  if (m < 0.52) return `${pct}% (Channel Ridges)`;
  if (m < 0.82) return `${pct}% (Fjord Canyon)`;
  return `${pct}% (Alpine Massif)`;
}

function formatTideLabel(lvl) {
  const sign = lvl > 0 ? '+' : '';
  if (lvl <= -2.0) return `${sign}${lvl.toFixed(1)} m (Low Tide)`;
  if (lvl >= 4.0) return `${sign}${lvl.toFixed(1)} m (King Tide)`;
  if (lvl >= 1.5) return `${sign}${lvl.toFixed(1)} m (High Tide)`;
  return `${sign}${lvl.toFixed(1)} m (Mean Tide)`;
}

function refreshControlReadouts() {
  if (ctrlStorm) ctrlStorm.value = atmosphere.state.stormType;
  ctrlGenus.value = atmosphere.state.cloudGenus;
  ctrlTornado.value = hydroState.tornadoStrength;
  if (ctrlHurricane) ctrlHurricane.value = hydroState.hurricaneStrength;
  ctrlTsunami.value = hydroState.tsunamiStrength;
  ctrlWhirlpool.value = hydroState.whirlpoolStrength;
  ctrlTide.value = hydroState.waterLevel;
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

  document.getElementById('val-tornado').textContent = `${Math.round(hydroState.tornadoStrength * 100)}%`;
  const elValHurr = document.getElementById('val-hurricane');
  if (elValHurr) {
    elValHurr.textContent = `${Math.round(hydroState.hurricaneStrength * 100)}%`;
  }
  document.getElementById('val-tsunami').textContent = `${Math.round(hydroState.tsunamiStrength * 100)}%`;
  document.getElementById('val-whirlpool').textContent = `${Math.round(hydroState.whirlpoolStrength * 100)}%`;
  document.getElementById('val-tide').textContent = formatTideLabel(hydroState.waterLevel);

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

  const elTopo = document.getElementById('stat-topology');
  if (elTopo) {
    elTopo.textContent = `${terrainState.islandCount} Isl / ${terrainState.waterBasinCount} Sea`;
  }

  const genusMeta = CLOUD_GENERA[atmosphere.state.cloudGenus];
  const stormMeta = STORM_TYPES[atmosphere.state.stormType];
  if (genusMeta && elGenusInfo) {
    const stormBanner =
      stormMeta && atmosphere.state.stormType !== 'none'
        ? `<strong>[${stormMeta.name}]</strong> ${stormMeta.description}<br/>`
        : '';
    elGenusInfo.innerHTML = `${stormBanner}<strong>${genusMeta.name} · ${genusMeta.etage}:</strong> ${genusMeta.description}`;
  }

  if (elDebugCaption) {
    elDebugCaption.textContent = DEBUG_CAPTIONS[atmosphere.state.debugMode];
  }
}
refreshControlReadouts();

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    atmosphere.applyPreset(btn.dataset.preset);
    hydroState.tornadoStrength = atmosphere.state.tornadoStrength;
    hydroState.hurricaneStrength = atmosphere.state.hurricaneStrength;
    atmosphere.setVortexAndTide(
      hydroState.tornadoX,
      hydroState.tornadoZ,
      hydroState.tornadoStrength,
      hydroState.waterLevel
    );
    syncSceneLighting();
    refreshControlReadouts();
  });
});

if (ctrlStorm) {
  ctrlStorm.addEventListener('change', (e) => {
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    atmosphere.setStormType(e.target.value);
    hydroState.tornadoStrength = atmosphere.state.tornadoStrength;
    hydroState.hurricaneStrength = atmosphere.state.hurricaneStrength;
    atmosphere.setVortexAndTide(
      hydroState.tornadoX,
      hydroState.tornadoZ,
      hydroState.tornadoStrength,
      hydroState.waterLevel
    );
    syncSceneLighting();
    refreshControlReadouts();
  });
}

ctrlGenus.addEventListener('change', (e) => {
  document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  atmosphere.setCloudGenus(e.target.value);
  syncSceneLighting();
  refreshControlReadouts();
});

ctrlTornado.addEventListener('input', (e) => {
  hydroState.tornadoStrength = parseFloat(e.target.value);
  atmosphere.setVortexAndTide(
    hydroState.tornadoX,
    hydroState.tornadoZ,
    hydroState.tornadoStrength,
    hydroState.waterLevel
  );
  syncSceneLighting();
  refreshControlReadouts();
});

if (ctrlHurricane) {
  ctrlHurricane.addEventListener('input', (e) => {
    hydroState.hurricaneStrength = parseFloat(e.target.value);
    atmosphere.setEnvironment({
      hurricaneStrength: hydroState.hurricaneStrength,
      stormType: hydroState.hurricaneStrength > 0.05 ? 'hurricane' : 'none',
      stormTypeId: hydroState.hurricaneStrength > 0.05 ? 3 : 0,
    });
    syncSceneLighting();
    refreshControlReadouts();
  });
}

ctrlTsunami.addEventListener('input', (e) => {
  hydroState.tsunamiStrength = parseFloat(e.target.value);
  refreshControlReadouts();
});

ctrlWhirlpool.addEventListener('input', (e) => {
  hydroState.whirlpoolStrength = parseFloat(e.target.value);
  refreshControlReadouts();
});

ctrlTide.addEventListener('input', (e) => {
  hydroState.waterLevel = parseFloat(e.target.value);
  atmosphere.setVortexAndTide(
    hydroState.tornadoX,
    hydroState.tornadoZ,
    hydroState.tornadoStrength,
    hydroState.waterLevel
  );
  terrain.updateGeometry();
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

const startTime = performance.now();
let lastFrameTime = startTime;
let frameCount = 0;
let fpsAccumTime = 0;
let isContextLost = false;
let rafId = null;

const elFps = document.getElementById('stat-fps');
const elGpu = document.getElementById('stat-gpu');
const elClusters = document.getElementById('stat-clusters');

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

const _upVec = new THREE.Vector3();
const _fwdVec = new THREE.Vector3();
const _rightVec = new THREE.Vector3();
const _rotMat = new THREE.Matrix4();

function animate(now) {
  if (isContextLost) return;
  rafId = requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) * 0.001, 0.05);
  lastFrameTime = now;
  const elapsed = (now - startTime) * 0.001;

  controls.update();

  // 1. Update Tornado path (patrols along the central fjord waterway) & Tsunami wave propagation
  const tornadoZ = Math.sin(elapsed * 0.22) * 165.0 + 40.0;
  const tornadoX = getMainFjordX(tornadoZ);
  hydroState.tornadoX = tornadoX;
  hydroState.tornadoZ = tornadoZ;

  // Propagate Tsunami soliton wave from +380m (South fjord mouth) to -380m (North canyon)
  hydroState.tsunamiZ = 380.0 - ((elapsed * 75.0) % 760.0);

  // Sync ocean vertex shader uniforms & volumetric atmosphere vortex uniforms
  uHydroParamsA.value.set(
    hydroState.tsunamiStrength,
    hydroState.tsunamiZ,
    hydroState.whirlpoolStrength,
    hydroState.waterLevel
  );
  uHydroParamsB.value.set(
    hydroState.whirlpoolX,
    hydroState.whirlpoolZ,
    hydroState.tornadoX,
    hydroState.tornadoZ
  );
  atmosphere.setVortexAndTide(
    hydroState.tornadoX,
    hydroState.tornadoZ,
    hydroState.tornadoStrength,
    hydroState.waterLevel
  );

  // 2. Advance Saronic ASV fleet along flooded gorges with 6-DOF wave-riding heave, pitch & roll
  for (const v of fleet) {
    const t = elapsed * v.speed + v.phase;
    const pNow = sampleFleetWaterwayPath(v.routeType, t);
    const pNext = sampleFleetWaterwayPath(v.routeType, t + 0.015);

    const hCenter = sampleWaterSurfaceHeight(pNow.x, pNow.z, elapsed);
    const hRight = sampleWaterSurfaceHeight(pNow.x + 3.0, pNow.z, elapsed);
    const hFwd = sampleWaterSurfaceHeight(pNow.x, pNow.z + 3.0, elapsed);

    v.group.position.set(pNow.x, hCenter + 0.15, pNow.z);

    // Compute wave surface normal and align vessel orientation (heading + wave pitch/roll)
    _upVec.set(hCenter - hRight, 3.0, hCenter - hFwd).normalize();
    _fwdVec.set(pNext.x - pNow.x, 0.0, pNext.z - pNow.z).normalize();
    _rightVec.crossVectors(_upVec, _fwdVec).normalize();
    _fwdVec.crossVectors(_rightVec, _upVec).normalize();

    _rotMat.makeBasis(_rightVec, _upVec, _fwdVec);
    v.group.quaternion.setFromRotationMatrix(_rotMat);
  }

  // 3. Advance 3D Topographic Airflow Streamlines
  airflowStreams.update(dt, atmosphere.state.windSpeed);

  // 4. Advance Lagrangian Vortex/Wave Particles + Spatial Hash Grid + Disjoint-Set Union-Find Clustering
  const windAngle = THREE.MathUtils.degToRad(32);
  const windVecXZ = {
    x: Math.cos(windAngle) * atmosphere.state.windSpeed,
    y: Math.sin(windAngle) * atmosphere.state.windSpeed,
  };
  fluidClusterParticles.update(dt, {
    windVecXZ,
    tornadoStrength: hydroState.tornadoStrength,
    tornadoCenterXZ: { x: hydroState.tornadoX, y: hydroState.tornadoZ },
    hurricaneStrength: hydroState.hurricaneStrength,
    whirlpoolStrength: hydroState.whirlpoolStrength,
    whirlpoolCenterXZ: { x: hydroState.whirlpoolX, y: hydroState.whirlpoolZ },
    tsunamiStrength: hydroState.tsunamiStrength,
    tsunamiZ: hydroState.tsunamiZ,
    waterLevel: hydroState.waterLevel,
    cloudBaseY: atmosphere.state.baseAltitude,
    sampleTerrain: terrain.sampleHeightAndGradient,
    sampleWaterHeight: (x, z) => sampleWaterSurfaceHeight(x, z, elapsed),
  });

  // 5. Update 3D rain streaks around camera
  if (rainSystem.lines.visible) {
    rainSystem.mat.uniforms.uTime.value = elapsed;
    rainSystem.mat.uniforms.uCameraPos.value.copy(camera.position);
    rainSystem.mat.uniforms.uWindXZ.value.set(windVecXZ.x, windVecXZ.y);
  }

  atmosphere.update(elapsed, camera);

  // Pass 1: Render opaque maritime scene + vertex-displaced ocean + DSU particles into offscreen target
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
    if (elClusters) {
      elClusters.textContent = `${fluidClusterParticles.activeClusters} (Max: ${fluidClusterParticles.largestCluster})`;
    }
    frameCount = 0;
    fpsAccumTime = 0;
  }
}

window.simulationContext = {
  atmosphere,
  terrain,
  fluidClusterParticles,
  fleet,
  hydroState,
  terrainState,
  sampleWaterSurfaceHeight,
  formatMorphLabel,
  formatTideLabel,
  refreshControlReadouts,
};

rafId = requestAnimationFrame(animate);
