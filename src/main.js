import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AtmosphereLayer, CLOUD_GENERA, STORM_TYPES } from './layers/AtmosphereLayer.js';
import { OceanLayer } from './layers/OceanLayer.js';
import {
  LagrangianVortexParticleSystem,
  analyzeTerrainTopologyUnionFind,
} from './physics/FluidClusterPhysics.js';

const $ = (id) => document.getElementById(id);

const canvas = $('viewport');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const baseScene = new THREE.Scene();
baseScene.background = new THREE.Color(0x4f86c6);
baseScene.fog = new THREE.FogExp2(0x5b8ec8, 0.00055);

const atmosphereScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 1.0, 3500.0);
camera.position.set(-165, 64, 265);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 68, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enableZoom = true;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.zoomSpeed = 1.35;
controls.panSpeed = 1.25;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 25;
controls.maxDistance = 950;
controls.update();

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

const CLOUD_RES_SCALE = 0.5;
const cloudTarget = new THREE.WebGLRenderTarget(
  Math.max(1, Math.floor(drawingSize.x * CLOUD_RES_SCALE)),
  Math.max(1, Math.floor(drawingSize.y * CLOUD_RES_SCALE)),
  {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
  }
);

const atmosphere = new AtmosphereLayer({ mapExtent: 1200, maxSteps: 36 });
atmosphere.init(renderer, atmosphereScene);
atmosphere.setSceneDepthTexture(depthTexture);
atmosphere.resize(cloudTarget.width, cloudTarget.height);
window.atmosphereLayer = atmosphere;

const sunLight = new THREE.DirectionalLight(0xfff5e0, 2.8);
baseScene.add(sunLight);
baseScene.add(new THREE.HemisphereLight(0x8ec5fc, 0x0b253a, 1.08));

const getMainFjordX = (z) => Math.sin(z * 0.0065) * 65.0 + Math.cos(z * 0.014) * 20.0;
const getCrossGorgeZ = (x) => Math.cos(x * 0.0068) * 48.0 - 10.0;

const hydroState = {
  tornadoStrength: 0.0,
  hurricaneStrength: 0.0,
  tornadoX: 0.0,
  tornadoZ: 65.0,
  tsunamiStrength: 0.0,
  tsunamiZ: 280.0,
  whirlpoolStrength: 0.0,
  whirlpoolX: 0.0,
  whirlpoolZ: -10.0,
  waterLevel: 0.0,
};

// 1. Subdivided Gerstner Ocean & Hydrodynamics Layer
const sharedCloudUniforms = atmosphere.getSharedGroundUniforms();
const uTemperatureUniform = { value: 18.0 };
const ocean = new OceanLayer({ sharedCloudUniforms, temperatureUniform: uTemperatureUniform });
ocean.init(baseScene);
const sampleWaterSurfaceHeight = (x, z, elapsed) => ocean.sampleWaterSurfaceHeight(x, z, elapsed);

// 2. Continuous Morphable Landform System + GPU Topographic Height/Flow Map (uTerrainMap)
const terrainState = {
  morph: 0.65,
  peakHeight: 245.0,
  canyonDepth: 0.70,
  islandCount: 4,
  waterBasinCount: 1,
};

/**
 * Builds the 112x112 morphable terrain mesh (0% Archipelago Islands -> 100% Alpine Fjord Massifs)
 * with GPU cloud-shadow & snowline shaders, and updates the 56x56 terrainMap + DSU topology counts.
 */
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
  const terrainMapTex = new THREE.DataTexture(terrainTexData, gridRes, gridRes, THREE.RGBAFormat);
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

    const ridge = 0.76 + 0.16 * Math.sin(x * 0.028) * Math.cos(z * 0.028) + 0.10 * Math.sin(x * 0.065 + z * 0.055) + 0.05 * Math.cos(x * 0.13 - z * 0.11);
    ridgeDetailBasis[i] = ridge;

    const distMain = Math.abs(x - getMainFjordX(z));
    const distCross = Math.abs(z - getCrossGorgeZ(x));
    const coreWater = 1.0 - THREE.MathUtils.smoothstep(Math.min(distMain, distCross), 28.0, 56.0);
    riverChannelMask[i] = coreWater;

    const mainWall = Math.exp(-Math.pow(distMain / 105.0, 2.1));
    const crossWall = Math.exp(-Math.pow(distCross / 88.0, 2.1)) * 0.88;
    canyonSlopeBasis[i] = Math.min(1.0, Math.max(mainWall, crossWall));

    let islH = 0.0;
    for (const isl of islands) {
      const dist = Math.hypot(x - isl.x, z - isl.z);
      if (dist < isl.radius) {
        const falloff = Math.cos((dist / isl.radius) * (Math.PI * 0.5));
        islH = Math.max(islH, Math.pow(falloff, 1.55) * isl.weight * ridge);
      }
    }
    islandBasis[i] = islH * (1.0 - coreWater);

    const r2 = x * x + z * z;
    const mapEnvelope = Math.max(0.0, 1.0 - Math.pow(Math.sqrt(r2) / 540.0, 2.2));
    const spine1Dist = Math.abs(x + 155.0 + Math.sin(z * 0.0065) * 75.0);
    const spine2Dist = Math.abs(x - 160.0 - Math.sin(z * 0.0060 + 0.8) * 75.0);
    const spine1 = Math.exp(-(spine1Dist * spine1Dist) / 48050.0);
    const spine2 = Math.exp(-(spine2Dist * spine2Dist) / 48050.0);
    const centralMass = Math.exp(-r2 / 204800.0) * 0.85;
    massifBasis[i] = Math.min(1.18, Math.max(spine1, spine2) * 0.96 + centralMass * 0.52) * mapEnvelope * ridge;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.06,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uWeatherMap: sharedCloudUniforms.uWeatherMap,
      uWindAndTime: sharedCloudUniforms.uWindAndTime,
      uBoundsMinAndFade: sharedCloudUniforms.uBoundsMinAndFade,
      uBoundsMaxAndCoverage: sharedCloudUniforms.uBoundsMaxAndCoverage,
      uSunDirAndElevation: sharedCloudUniforms.uSunDirAndElevation,
      uWorldOriginOffset: sharedCloudUniforms.uWorldOriginOffset,
      uTemperature: uTemperatureUniform,
    });

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

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
        uniform vec4 uWorldOriginOffset;
        uniform float uTemperature;`
      )
      .replace(
        '#include <dithering_fragment>',
        `
        vec3 sunDir = normalize(uSunDirAndElevation.xyz);
        float tCloudPlane = max((uBoundsMinAndFade.y - vTerrainWorldPos.y) / max(sunDir.y, 0.08), 0.0);
        vec2 shadowWorldXZ = vTerrainWorldPos.xz + uWorldOriginOffset.xy + sunDir.xz * tCloudPlane;
        vec2 weatherUV = (shadowWorldXZ - uBoundsMinAndFade.xz) / (uBoundsMaxAndCoverage.xz - uBoundsMinAndFade.xz) + uWindAndTime.xy * uWindAndTime.z * 0.00085;
        float cloudShadow = smoothstep(1.0 - uBoundsMaxAndCoverage.w * 1.35, 1.0, texture2D(uWeatherMap, weatherUV).r);
        float aboveCloudFade = 1.0 - smoothstep(uBoundsMinAndFade.y, uBoundsMaxAndCoverage.y, vTerrainWorldPos.y);
        float frost = clamp((4.0 - uTemperature) / 20.0, 0.0, 1.0);
        if (frost > 0.01) {
          float snowLine = smoothstep(mix(165.0, 10.0, frost), mix(210.0, 36.0, frost), vTerrainWorldPos.y);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.90, 0.95, 0.99), snowLine * (0.45 + 0.55 * frost));
        }
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
    const morphStep = THREE.MathUtils.smoothstep(morph, 0.05, 0.50);

    for (let i = 0; i < count; i++) {
      const isl = islandBasis[i];
      const riverCut = riverChannelMask[i];
      const wallCarve = canyonSlopeBasis[i] * canyonStrength * morphStep;
      const totalCarve = Math.min(1.0, Math.max(riverCut, wallCarve * 0.92));

      const rawNormalizedH = THREE.MathUtils.lerp(isl, Math.max(isl * 0.85, massifBasis[i]), morph) * (1.0 - totalCarve);
      const terraceStep = Math.sin(rawNormalizedH * 22.0) * 0.018 * wallCarve * (1.0 - riverCut);
      const h = (rawNormalizedH + terraceStep) * peakScale - 9.5 - riverCut * 5.5;
      pos.setY(i, h);
      heights[i] = h;

      const relH = h - waterLvl;
      if (relH < 1.5) {
        colTemp.copy(colWetShoal);
      } else if (relH < 5.5) {
        colTemp.copy(colSand);
      } else if (h < 88.0) {
        const t = Math.max(0.0, (h - (waterLvl + 5.5)) / 82.5);
        colTemp.copy(colForest).lerp(colCanyonTerrace, Math.min(1.0, wallCarve * 1.6) * 0.65).lerp(colRock, t * 0.75);
      } else if (h < 185.0) {
        colTemp.copy(colRock).lerp(colCanyonTerrace, wallCarve * 0.35 * (1.0 - (h - 88.0) / 97.0));
      } else {
        const snowFactor = Math.min(1.0, (h - 185.0) / 55.0 + (ridgeDetailBasis[i] - 0.75) * 0.6);
        colTemp.copy(colRock).lerp(colSnow, Math.max(0.0, snowFactor));
      }

      const i3 = i * 3;
      colorArr[i3] = colTemp.r;
      colorArr[i3 + 1] = colTemp.g;
      colorArr[i3 + 2] = colTemp.b;
    }

    const invTwoStepM = 1.0 / (2.0 * (1200.0 / segs));
    for (let iz = 0; iz < gridRes; iz++) {
      const zPrev = Math.max(0, iz - 1);
      const zNext = Math.min(segs, iz + 1);
      for (let ix = 0; ix < gridRes; ix++) {
        const xPrev = Math.max(0, ix - 1);
        const xNext = Math.min(segs, ix + 1);
        const idx = iz * gridRes + ix;

        const hCenter = Math.max(0.0, heights[idx]);
        const dhdx = (Math.max(0.0, heights[iz * gridRes + xNext]) - Math.max(0.0, heights[iz * gridRes + xPrev])) * invTwoStepM;
        const dhdz = (Math.max(0.0, heights[zNext * gridRes + ix]) - Math.max(0.0, heights[zPrev * gridRes + ix])) * invTwoStepM;

        const idx4 = idx * 4;
        terrainTexData[idx4] = Math.min(255, Math.max(0, Math.round((hCenter / 380.0) * 255.0)));
        terrainTexData[idx4 + 1] = Math.min(255, Math.max(0, Math.round((THREE.MathUtils.clamp(dhdx / 1.25, -1.0, 1.0) * 0.5 + 0.5) * 255.0)));
        terrainTexData[idx4 + 2] = Math.min(255, Math.max(0, Math.round((THREE.MathUtils.clamp(dhdz / 1.25, -1.0, 1.0) * 0.5 + 0.5) * 255.0)));
        terrainTexData[idx4 + 3] = Math.min(255, Math.max(0, Math.round(Math.max(riverChannelMask[idx], canyonSlopeBasis[idx] * 0.65) * 255.0)));
      }
    }
    terrainMapTex.needsUpdate = true;

    const topo = analyzeTerrainTopologyUnionFind(heights, gridRes, waterLvl);
    terrainState.islandCount = topo.islandCount;
    terrainState.waterBasinCount = topo.waterBasinCount;

    pos.needsUpdate = true;
    colorAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  const _sampleRing = [
    { h: 0.0, gx: 0.0, gz: 0.0, funnel: 0.0 },
    { h: 0.0, gx: 0.0, gz: 0.0, funnel: 0.0 },
  ];
  let _ringIdx = 0;

  function sampleHeightAndGradient(x, z) {
    const u = THREE.MathUtils.clamp((x + 600.0) / 1200.0, 0.0, 0.999);
    const v = THREE.MathUtils.clamp((z + 600.0) / 1200.0, 0.0, 0.999);
    const idx = Math.floor(v * segs) * gridRes + Math.floor(u * segs);
    const idx4 = idx * 4;
    const out = _sampleRing[(_ringIdx = (_ringIdx + 1) & 1)];
    out.h = Math.max(0.0, heights[idx]);
    out.gx = (terrainTexData[idx4 + 1] / 255.0 - 0.5) * 2.5;
    out.gz = (terrainTexData[idx4 + 2] / 255.0 - 0.5) * 2.5;
    out.funnel = terrainTexData[idx4 + 3] / 255.0;
    return out;
  }

  updateGeometry();
  return { mesh, terrainMapTex, updateGeometry, sampleHeightAndGradient };
}

const terrain = createMorphableTerrain();
baseScene.add(terrain.mesh);
atmosphere.setTerrainMap(terrain.terrainMapTex);

// 3. Lagrangian Particle Physics + Spatial Hash Grid + Disjoint-Set Union-Find Coalescence System
const fluidClusterParticles = new LagrangianVortexParticleSystem(512);
baseScene.add(fluidClusterParticles.points);

// 4. 100% GPU Hardware-Accelerated Topographic Wind Streamlines
/** Builds 240 GPU-advected wind ribbons that deflect around mountains and swirl into cyclones. */
function createAirflowStreamlines(streamCount = 240, segsPerStream = 8) {
  const totalVerts = streamCount * segsPerStream * 2;
  const positions = new Float32Array(totalVerts * 3);
  const seeds = new Float32Array(totalVerts * 4);
  const segFracs = new Float32Array(totalVerts);

  for (let i = 0; i < streamCount; i++) {
    const sx = (Math.random() - 0.5) * 980;
    const sy = 38 + Math.random() * 145;
    const sz = (Math.random() - 0.5) * 980;
    const spd = 0.85 + Math.random() * 0.35;
    const baseVert = i * segsPerStream * 2;

    for (let s = 0; s < segsPerStream; s++) {
      const v0 = baseVert + s * 2;
      for (let k = 0; k < 2; k++) {
        const v = v0 + k;
        const v4 = v * 4;
        seeds[v4] = sx;
        seeds[v4 + 1] = sy;
        seeds[v4 + 2] = sz;
        seeds[v4 + 3] = spd;
        segFracs[v] = (s + k) / segsPerStream;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geo.setAttribute('aSegFrac', new THREE.BufferAttribute(segFracs, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTerrainMap: sharedCloudUniforms.uTerrainMap,
      uWindAndTime: sharedCloudUniforms.uWindAndTime,
      uVortexAndTide: sharedCloudUniforms.uVortexAndTide,
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute float aSegFrac;
      uniform sampler2D uTerrainMap;
      uniform vec4 uWindAndTime;
      uniform vec4 uVortexAndTide;
      varying float vAlpha;

      vec2 evalStreamVelocity(vec2 xz, float baseY, vec2 baseWind) {
        vec4 tSample = texture2D(uTerrainMap, clamp((xz + 600.0) / 1200.0, 0.002, 0.998));
        float terrH = tSample.r * 380.0;
        vec2 gradXZ = (tSample.gb - 0.5) * 2.5;
        vec2 vel = baseWind * (1.0 + tSample.a * 0.45);
        if (terrH > baseY - 45.0) {
          vel -= gradXZ * (52.0 * clamp((terrH - (baseY - 45.0)) / 75.0, 0.0, 1.8));
        }
        if (uVortexAndTide.z > 0.01) {
          vec2 dV = xz - uVortexAndTide.xy;
          float r = length(dV) + 0.1;
          if (r < 220.0) {
            float factor = (1.0 - r / 220.0) * uVortexAndTide.z / r;
            vel += vec2(-dV.y, dV.x) * (125.0 * factor) - dV * (42.0 * factor);
          }
        }
        return vel;
      }

      void main() {
        vec2 baseWind = uWindAndTime.xy * (3.2 * aSeed.w);
        vec2 headXZ = mod(aSeed.xz + baseWind * uWindAndTime.z + 520.0, 1040.0) - 520.0;
        vec2 v0 = evalStreamVelocity(headXZ, aSeed.y, baseWind);
        vec2 v1 = evalStreamVelocity(headXZ - v0 * (aSegFrac * 0.42), aSeed.y, baseWind);
        vec2 posXZ = headXZ - 0.5 * (v0 + v1) * (aSegFrac * 0.85);

        float finalH = texture2D(uTerrainMap, clamp((posXZ + 600.0) / 1200.0, 0.002, 0.998)).r * 380.0;
        float y = max(aSeed.y + finalH * 0.35, max(finalH, uVortexAndTide.w) + 16.0);
        vAlpha = 1.0 - aSegFrac;
        gl_Position = projectionMatrix * viewMatrix * vec4(posXZ.x, y, posXZ.y, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.005) discard;
        gl_FragColor = vec4(0.84, 0.95, 1.0, vAlpha * 0.18);
      }
    `,
  });

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  return { lines };
}

baseScene.add(createAirflowStreamlines(240, 8).lines);

// 5. Saronic Autonomous Surface Vessels (ASVs: Corsair, Cutlass, Spyglass) with 6-DOF Wave-Riding Physics
function drawSaronicEmblem(ctx, accentCss) {
  const poly = (pts, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  };
  poly([[42, 4], [80, 26], [66, 76], [42, 60], [18, 76], [4, 26]], '#ffffff');
  poly([[42, 18], [62, 32], [54, 58], [42, 48], [30, 58], [22, 32]], '#111822');
  poly([[42, 24], [51, 46], [42, 40], [33, 46]], accentCss);
}

function createSaronicLogoTexture(vesselClass, hullNumber, accentCss) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#111822';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = accentCss;
  ctx.fillRect(0, 0, 512, 4);
  ctx.fillRect(0, 124, 512, 4);

  ctx.save();
  ctx.translate(28, 22);
  drawSaronicEmblem(ctx, accentCss);
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

  ctx.save();
  ctx.translate(44, 28);
  drawSaronicEmblem(ctx, accentCss);
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SARONIC', 128, 222);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Assembles a 3D Saronic Autonomous Surface Vessel (hull, deckhouse, radar mast, nav lights). */
function createSaronicASVMesh({ vesselClass, hullNumber, accentHex, accentCss, scale = 1.0 }) {
  const group = new THREE.Group();

  const hullPositions = new Float32Array([
    0.0, 2.3, 14.5,  0.0, 0.1, 13.2,
    -2.6, 2.2, 5.5,  2.6, 2.2, 5.5,  -3.1, 1.1, 5.2,  3.1, 1.1, 5.2,  -2.2, 0.0, 5.0,  2.2, 0.0, 5.0,
    -2.8, 2.1, -6.5, 2.8, 2.1, -6.5, -3.4, 1.1, -6.8, 3.4, 1.1, -6.8, -2.5, 0.0, -6.8, 2.5, 0.0, -6.8,
    -2.3, 1.9, -11.5, 2.3, 1.9, -11.5, -2.7, 0.9, -12.0, 2.7, 0.9, -12.0, -2.0, 0.0, -11.8, 2.0, 0.0, -11.8,
  ]);

  const hullIndices = [
    0,2,3, 2,8,9, 2,9,3, 8,14,15, 8,15,9,
    0,4,2, 2,4,10, 2,10,8, 8,10,16, 8,16,14,
    0,3,5, 3,11,5, 3,9,11, 9,15,17, 9,17,11,
    1,6,4, 0,1,4, 4,6,12, 4,12,10, 10,12,18, 10,18,16,
    1,5,7, 0,5,1, 5,11,13, 5,13,7, 11,17,19, 11,19,13,
    14,16,17, 14,17,15, 16,18,19, 16,19,17,
  ];

  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.BufferAttribute(hullPositions, 3));
  hullGeo.setIndex(hullIndices);
  hullGeo.computeVertexNormals();

  const hullMat = new THREE.MeshStandardMaterial({ color: 0x161f2c, roughness: 0.32, metalness: 0.72, flatShading: true });
  group.add(new THREE.Mesh(hullGeo, hullMat));

  const deckHouseGeo = new THREE.ConeGeometry(2.3, 1.6, 4);
  deckHouseGeo.rotateY(Math.PI * 0.25);
  deckHouseGeo.scale(1.0, 1.0, 2.4);
  const deckHouse = new THREE.Mesh(deckHouseGeo, new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.28, metalness: 0.78, flatShading: true }));
  deckHouse.position.set(0, 2.7, 0.2);
  group.add(deckHouse);

  const satcom = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.16, 2.2), new THREE.MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.2, metalness: 0.5 }));
  satcom.position.set(0, 3.52, 0.5);
  satcom.rotation.x = -0.08;
  group.add(satcom);

  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.75, 3.8, 1.4), hullMat);
  mast.position.set(0, 4.8, -1.2);
  mast.rotation.x = -0.18;
  group.add(mast);

  const eoirTurret = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 14), new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.18, metalness: 0.85 }));
  eoirTurret.position.set(0, 6.85, -1.55);
  group.add(eoirTurret);

  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 10), new THREE.MeshBasicMaterial({ color: accentHex }));
  beacon.position.set(0, 7.65, -1.55);
  group.add(beacon);

  const sideLogoTex = createSaronicLogoTexture(vesselClass, hullNumber, accentCss);
  const sideLogoMat = new THREE.MeshBasicMaterial({ map: sideLogoTex, side: THREE.DoubleSide });
  const sidePlaneGeo = new THREE.PlaneGeometry(9.6, 2.2);

  const stbdLogo = new THREE.Mesh(sidePlaneGeo, sideLogoMat);
  stbdLogo.position.set(3.05, 1.55, -0.6);
  stbdLogo.rotation.set(-0.22, Math.PI * 0.5, 0.01);
  group.add(stbdLogo);

  const portLogo = new THREE.Mesh(sidePlaneGeo, sideLogoMat);
  portLogo.position.set(-3.05, 1.55, -0.6);
  portLogo.rotation.set(0.22, -Math.PI * 0.5, 0);
  group.add(portLogo);

  const deckLogo = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({ map: createSaronicDeckEmblemTexture(accentCss) }));
  deckLogo.rotation.x = -Math.PI * 0.5;
  deckLogo.position.set(0, 2.26, 6.2);
  group.add(deckLogo);

  const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(11.5, 2.8), new THREE.MeshBasicMaterial({ map: sideLogoTex, side: THREE.DoubleSide, transparent: true, opacity: 0.94 }));
  bannerMesh.position.set(0, 10.2, -1.5);
  group.add(bannerMesh);

  const wakeGeo = new THREE.PlaneGeometry(16, 56);
  wakeGeo.rotateX(-Math.PI / 2);
  const wake = new THREE.Mesh(wakeGeo, new THREE.MeshBasicMaterial({ color: 0xd8f3ff, transparent: true, opacity: 0.34, depthWrite: false }));
  wake.position.set(0, 0.18, -36);
  group.add(wake);

  const sprayGeo = new THREE.PlaneGeometry(5.5, 22);
  sprayGeo.rotateX(-Math.PI / 2);
  const spray = new THREE.Mesh(sprayGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.52, depthWrite: false }));
  spray.position.set(0, 0.24, -21);
  group.add(spray);

  group.scale.setScalar(scale);
  return { group, bannerMesh };
}

/** Returns parametric (x, z) patrol coordinates keeping each vessel centered in the fjord channels. */
function sampleFleetWaterwayPath(routeType, t) {
  if (routeType === 'mainFjordNorthSouth') {
    const z = Math.sin(t) * 440.0;
    return { x: getMainFjordX(z) + Math.cos(t * 2.0) * 8.0, z };
  }
  if (routeType === 'crossGorgeEastWest') {
    const x = Math.sin(t) * 430.0;
    return { x, z: getCrossGorgeZ(x) + Math.sin(t * 2.0) * 7.0 };
  }
  const s = Math.sin(t);
  if (s >= 0.0) {
    const z = s * 420.0;
    return { x: getMainFjordX(z) - 9.0, z };
  }
  const x = -s * 420.0;
  return { x, z: getCrossGorgeZ(x) + 9.0 };
}

const fleet = [
  { ...createSaronicASVMesh({ vesselClass: 'CORSAIR',  hullNumber: 'ASV-01', accentHex: 0x38bdf8, accentCss: '#38bdf8', scale: 1.15 }), routeType: 'mainFjordNorthSouth', speed: 0.14, phase: 0.2 },
  { ...createSaronicASVMesh({ vesselClass: 'CUTLASS',  hullNumber: 'ASV-02', accentHex: 0x34d399, accentCss: '#34d399', scale: 1.00 }), routeType: 'crossGorgeEastWest',  speed: 0.16, phase: 1.7 },
  { ...createSaronicASVMesh({ vesselClass: 'SPYGLASS', hullNumber: 'ASV-03', accentHex: 0xf59e0b, accentCss: '#f59e0b', scale: 0.92 }), routeType: 'canyonJunctionWeave', speed: 0.13, phase: 3.4 },
];
fleet.forEach((v) => {
  v.fwd = new THREE.Vector3(0, 0, 1);
  baseScene.add(v.group);
});

// 5b. Secret -20°C North Pole & Santa Sleigh Easter Egg (hidden unless temp <= -20°C)
function createNorthPoleEasterEgg() {
  const redMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.35, metalness: 0.15 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.25, metalness: 0.75 });
  const brownMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
  const rudolphMat = new THREE.MeshBasicMaterial({ color: 0xff1e1e });
  const giftMats = [
    new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.4 }),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.4 }),
    goldMat,
  ];

  // Dress up every ASV boat as Santa / Santa's Sleigh
  const boatOverlays = fleet.map((v) => {
    const g = new THREE.Group();
    g.visible = false;
    for (const sx of [-1.75, 1.75]) {
      const runner = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.38, 12.5), goldMat);
      runner.position.set(sx, 0.25, 0.0);
      g.add(runner);
    }
    const trim = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.55, 8.8), redMat);
    trim.position.set(0, 1.35, -0.4);
    g.add(trim);
    const hatCone = new THREE.Mesh(new THREE.ConeGeometry(1.15, 2.5, 10), redMat);
    hatCone.position.set(0, 5.2, -0.8);
    g.add(hatCone);
    const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.38, 10), whiteMat);
    hatBrim.position.set(0, 4.05, -0.8);
    g.add(hatBrim);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.36, 8, 8), whiteMat);
    pom.position.set(0, 6.45, -0.8);
    g.add(pom);
    giftMats.forEach((gm, idx) => {
      const gift = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.95), gm);
      gift.position.set((idx - 1) * 0.95, 2.15, -3.2);
      g.add(gift);
    });
    v.group.add(g);
    return g;
  });

  // Barber-shop candy-cane North Pole on a mountain peak
  const stripeCanvas = document.createElement('canvas');
  stripeCanvas.width = 64;
  stripeCanvas.height = 64;
  const sctx = stripeCanvas.getContext('2d');
  sctx.fillStyle = '#f8fafc';
  sctx.fillRect(0, 0, 64, 64);
  sctx.fillStyle = '#dc2626';
  for (let i = -64; i < 128; i += 24) {
    sctx.beginPath();
    sctx.moveTo(i, 0);
    sctx.lineTo(i + 12, 0);
    sctx.lineTo(i + 76, 64);
    sctx.lineTo(i + 64, 64);
    sctx.closePath();
    sctx.fill();
  }
  const caneTex = new THREE.CanvasTexture(stripeCanvas);
  caneTex.wrapS = THREE.RepeatWrapping;
  caneTex.wrapT = THREE.RepeatWrapping;
  const caneMat = new THREE.MeshStandardMaterial({ map: caneTex, roughness: 0.25, metalness: 0.1 });

  const northPoleGroup = new THREE.Group();
  northPoleGroup.visible = false;
  const poleMesh = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 28, 14), caneMat);
  poleMesh.position.y = 14;
  northPoleGroup.add(poleMesh);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10), goldMat);
  orb.position.y = 29;
  northPoleGroup.add(orb);
  const signBoard = new THREE.Mesh(new THREE.BoxGeometry(9.5, 2.4, 0.6), redMat);
  signBoard.position.set(0, 22, 1.6);
  northPoleGroup.add(signBoard);
  baseScene.add(northPoleGroup);

  // Flying Santa's Sleigh & 5 Reindeer (with Rudolph leading)
  const flyingSleigh = new THREE.Group();
  flyingSleigh.visible = false;
  const sleighBody = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.0, 6.2), redMat);
  sleighBody.position.set(0, 1.2, -3.5);
  flyingSleigh.add(sleighBody);
  for (const sx of [-1.7, 1.7]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 7.6), goldMat);
    rail.position.set(sx, 0.1, -3.5);
    flyingSleigh.add(rail);
  }
  const santaTorso = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.15, 2.2, 8), redMat);
  santaTorso.position.set(0, 2.7, -2.5);
  flyingSleigh.add(santaTorso);
  const santaBeard = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 8), whiteMat);
  santaBeard.position.set(0, 4.0, -2.2);
  flyingSleigh.add(santaBeard);
  const santaHat = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 8), redMat);
  santaHat.position.set(0, 4.9, -2.4);
  flyingSleigh.add(santaHat);

  const reindeerMeshes = [];
  const deerOffsets = [
    [-1.6, 4.0], [1.6, 4.0],
    [-1.6, 9.0], [1.6, 9.0],
    [0.0, 14.0], // Rudolph in front
  ];
  deerOffsets.forEach(([dx, dz], idx) => {
    const deer = new THREE.Group();
    deer.position.set(dx, 1.4, dz);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 2.4), brownMat);
    deer.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.65, 1.0), brownMat);
    head.position.set(0, 0.75, 1.25);
    deer.add(head);
    if (idx === deerOffsets.length - 1) {
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), rudolphMat);
      nose.position.set(0, 0.75, 1.85);
      deer.add(nose);
    }
    flyingSleigh.add(deer);
    reindeerMeshes.push(deer);
  });
  baseScene.add(flyingSleigh);

  return { boatOverlays, northPoleGroup, poleMesh, flyingSleigh, reindeerMeshes, sleighFwd: new THREE.Vector3(0, 0, 1) };
}

const northPoleEgg = createNorthPoleEasterEgg();
const optCameraSanta = document.getElementById('opt-camera-santa');

function updateNorthPoleEasterEgg(elapsed) {
  const active = atmosphere.state.temperature <= -20;
  for (const g of northPoleEgg.boatOverlays) g.visible = active;
  northPoleEgg.northPoleGroup.visible = active;
  northPoleEgg.flyingSleigh.visible = active;
  optCameraSanta.hidden = !active;
  if (!active) {
    if (activeCameraView === 'santa') {
      ctrlCameraView.value = 'free';
      applyCameraView('free', true);
    }
    return;
  }

  const peakPos = terrain.sampleHeightAndGradient(-155, -40);
  northPoleEgg.northPoleGroup.position.set(-155, Math.max(peakPos.h - 1.0, 10.0), -40);
  northPoleEgg.poleMesh.rotation.y = elapsed * 1.4;

  const ang = elapsed * 0.28;
  const rx = Math.cos(ang) * 185;
  const rz = Math.sin(ang) * 155;
  const ry = 112 + Math.sin(elapsed * 0.85) * 14;
  const nx = Math.cos(ang + 0.02) * 185;
  const nz = Math.sin(ang + 0.02) * 155;
  northPoleEgg.flyingSleigh.position.set(rx, ry, rz);
  northPoleEgg.flyingSleigh.lookAt(nx, ry, nz);
  northPoleEgg.sleighFwd.set(nx - rx, 0, nz - rz).normalize();
  northPoleEgg.reindeerMeshes.forEach((d, idx) => {
    d.position.y = 1.4 + Math.sin(elapsed * 6.5 + idx * 0.9) * 0.45;
  });

  if (activeCameraView === 'santa') {
    if (_hasPrevBoatPos) {
      const dx = rx - _prevBoatPos.x;
      const dy = ry - _prevBoatPos.y;
      const dz = rz - _prevBoatPos.z;
      camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
      controls.target.set(controls.target.x + dx, controls.target.y + dy, controls.target.z + dz);
      controls.update();
    }
    _prevBoatPos.set(rx, ry, rz);
    _hasPrevBoatPos = true;
  }
}

// 6. GPU-Accelerated 3D Rain Streak System
/** Builds 9,000 camera-wrapped GPU precipitation lines that morph from rain -> sleet -> snowflakes. */
function createPrecipitationSystem(dropCount = 9000) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(dropCount * 6);
  const seeds = new Float32Array(dropCount * 2);

  for (let i = 0; i < dropCount; i++) {
    const rx = (Math.random() - 0.5) * 900;
    const ry = Math.random() * 260;
    const rz = (Math.random() - 0.5) * 900;
    const i6 = i * 6;
    positions[i6] = positions[i6 + 3] = rx;
    positions[i6 + 1] = positions[i6 + 4] = ry;
    positions[i6 + 2] = positions[i6 + 5] = rz;
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
      uTemperature: uTemperatureUniform,
    },
    vertexShader: /* glsl */ `
      attribute float aTip;
      uniform float uTime;
      uniform float uRainIntensity;
      uniform vec2 uWindXZ;
      uniform vec3 uCameraPos;
      uniform float uCloudBaseY;
      uniform float uTemperature;
      varying float vAlpha;

      void main() {
        float cellSpan = 750.0;
        float maxH = max(uCloudBaseY + 25.0, 90.0);
        vec3 basePos = position;
        float snowMix = clamp((3.0 - uTemperature) / 5.0, 0.0, 1.0);
        float speed = mix(135.0, 24.0, snowMix) + fract(sin(basePos.x * 12.9898 + basePos.z * 78.233) * 43758.5453) * mix(45.0, 14.0, snowMix);
        float yFall = mod(basePos.y - uTime * speed, maxH);
        vec2 relXZ = mod(basePos.xz - uCameraPos.xz + cellSpan * 0.5, cellSpan) - cellSpan * 0.5;
        vec3 flutter = vec3(sin(uTime * 1.9 + basePos.x) * 3.5, 0.0, cos(uTime * 1.6 + basePos.z) * 3.5) * snowMix;
        vec3 worldPos = vec3(uCameraPos.x + relXZ.x, yFall, uCameraPos.z + relXZ.z) + flutter;
        worldPos += normalize(vec3(uWindXZ.x * 0.35, -speed, uWindXZ.y * 0.35)) * mix(mix(4.5, 9.5, uRainIntensity), 0.9, snowMix) * aTip;
        float distFade = 1.0 - smoothstep(140.0, 370.0, length(worldPos.xz - uCameraPos.xz));
        vAlpha = uRainIntensity * distFade * (aTip > 0.5 ? 0.55 : mix(0.08, 0.35, snowMix));
        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTemperature;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.005) discard;
        float snowMix = clamp((3.0 - uTemperature) / 5.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(vec3(0.78, 0.88, 0.98), vec3(0.95, 0.98, 1.0), snowMix), vAlpha);
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

// 7. GPU-Accelerated 3D Branched Cloud-to-Ground & Intra-Cloud Lightning Bolt System
/** Builds 6 jagged cloud-to-sea lightning bolts with diagonal branches flickering via uLightningIntensity. */
function createLightningBoltSystem(boltCount = 6, segsPerBolt = 18) {
  const segsTotalPerBolt = segsPerBolt + 12;
  const totalVerts = boltCount * segsTotalPerBolt * 2;
  const positions = new Float32Array(totalVerts * 3);
  const boltMeta = new Float32Array(totalVerts * 4);

  let vCursor = 0;
  const pushVert = (b, h, bOff, seed) => {
    const v4 = vCursor * 4;
    boltMeta[v4] = b;
    boltMeta[v4 + 1] = h;
    boltMeta[v4 + 2] = bOff;
    boltMeta[v4 + 3] = seed;
    vCursor++;
  };

  for (let b = 0; b < boltCount; b++) {
    for (let s = 0; s < segsPerBolt; s++) {
      const seed = s * 1.37 + b * 7.13;
      pushVert(b, s / segsPerBolt, 0.0, seed);
      pushVert(b, (s + 1) / segsPerBolt, 0.0, seed);
    }
    for (let br = 0; br < 2; br++) {
      const startH = br === 0 ? 0.32 : 0.58;
      const dirSign = br === 0 ? 1.0 : -1.0;
      for (let s = 0; s < 6; s++) {
        const seed = (s + 20) * 2.11 + b * 11.3;
        pushVert(b, startH + (s / 6) * 0.28, dirSign * (s / 6) * 34.0, seed);
        pushVert(b, startH + ((s + 1) / 6) * 0.28, dirSign * ((s + 1) / 6) * 34.0, seed);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aBoltMeta', new THREE.BufferAttribute(boltMeta, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0.0 },
      uLightningIntensity: { value: 0.0 },
      uCloudBaseY: { value: 92.0 },
      uVortexAndTide: sharedCloudUniforms.uVortexAndTide,
    },
    vertexShader: /* glsl */ `
      attribute vec4 aBoltMeta;
      uniform float uTime;
      uniform float uLightningIntensity;
      uniform float uCloudBaseY;
      uniform vec4 uVortexAndTide;
      varying float vBoltAlpha;
      varying float vIsBranch;

      float hash12(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        float boltId = aBoltMeta.x;
        float hFrac = aBoltMeta.y;
        float branchOff = aBoltMeta.z;

        float cycleRate = 2.6 + boltId * 0.45;
        float strikeCycle = floor(uTime * cycleRate + boltId * 1.9);
        float cyclePhase = fract(uTime * cycleRate + boltId * 1.9);

        float inWindow = step(cyclePhase, 0.14 + uLightningIntensity * 0.28);
        float flicker = sin(cyclePhase * 62.0) * 0.5 + 0.5;
        vBoltAlpha = inWindow * (0.45 + 0.55 * flicker) * smoothstep(0.0, 0.08, uLightningIntensity);
        vIsBranch = abs(branchOff) > 0.1 ? 1.0 : 0.0;

        float angle = hash12(vec2(boltId, strikeCycle)) * 6.2831853;
        float radius = 30.0 + hash12(vec2(strikeCycle, boltId + 3.7)) * 210.0;
        vec2 strikeOriginXZ = uVortexAndTide.xy + vec2(cos(angle), sin(angle)) * radius;

        float jagScale = 28.0 * sin(hFrac * 3.14159);
        float jagX = (hash12(vec2(hFrac * 18.0, strikeCycle + boltId)) - 0.5) * jagScale;
        float jagZ = (hash12(vec2(strikeCycle - boltId, hFrac * 18.0)) - 0.5) * jagScale;

        vec3 worldPos = vec3(
          strikeOriginXZ.x + jagX + branchOff,
          mix(uCloudBaseY + 38.0, uVortexAndTide.w, hFrac),
          strikeOriginXZ.y + jagZ + branchOff * 0.65
        );
        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vBoltAlpha;
      varying float vIsBranch;
      void main() {
        if (vBoltAlpha <= 0.01) discard;
        vec3 coreCol = mix(vec3(0.85, 0.94, 1.0), vec3(0.48, 0.76, 1.0), vIsBranch * 0.55);
        gl_FragColor = vec4(coreCol, vBoltAlpha * mix(0.95, 0.65, vIsBranch));
      }
    `,
  });

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.visible = false;
  return { lines, mat };
}

const lightningSystem = createLightningBoltSystem(6, 18);
baseScene.add(lightningSystem.lines);

/** Synchronizes directional sun, exponential fog, temperature uniforms, rain/snow, and lightning. */
function syncSceneLighting() {
  const s = atmosphere.state;
  sunLight.position.copy(atmosphere.getSunDirection()).multiplyScalar(600);
  sunLight.color.setHex(s.sunColor);
  sunLight.intensity = s.sunIntensity * 0.82 * (1.0 - Math.max(s.rainIntensity, hydroState.tornadoStrength * 0.8) * 0.38);

  baseScene.background.setHex(s.skyColor);
  baseScene.fog.color.copy(baseScene.background);
  baseScene.fog.density = 0.00005 + s.fogDensity * 0.0022 + s.rainIntensity * 0.00035;

  uTemperatureUniform.value = s.temperature;
  const effectivePrecip = Math.max(s.rainIntensity, s.temperature <= 0 ? 0.45 : 0.0);
  ocean.setRainIntensity(s.temperature <= 0 ? 0.0 : s.rainIntensity);
  ocean.setHydroState(hydroState);

  rainSystem.lines.visible = effectivePrecip > 0.01;
  rainSystem.mat.uniforms.uRainIntensity.value = effectivePrecip;
  rainSystem.mat.uniforms.uCloudBaseY.value = s.baseAltitude;

  lightningSystem.lines.visible = s.lightningIntensity > 0.01;
  lightningSystem.mat.uniforms.uLightningIntensity.value = s.lightningIntensity;
  lightningSystem.mat.uniforms.uCloudBaseY.value = s.baseAltitude;
}
syncSceneLighting();

// Wire up HUD controls concisely
const ctrlStorm = $('ctrl-storm');
const ctrlGenus = $('ctrl-genus');
const ctrlTornado = $('ctrl-tornado');
const ctrlHurricane = $('ctrl-hurricane');
const ctrlTsunami = $('ctrl-tsunami');
const ctrlWhirlpool = $('ctrl-whirlpool');
const ctrlTide = $('ctrl-tide');
const ctrlTerrainMorph = $('ctrl-terrain-morph');
const ctrlPeakHeight = $('ctrl-peak-height');
const ctrlCanyonDepth = $('ctrl-canyon-depth');
const ctrlCoverage = $('ctrl-coverage');
const ctrlDensity = $('ctrl-density');
const ctrlRain = $('ctrl-rain');
const ctrlLightning = $('ctrl-lightning');
const ctrlFog = $('ctrl-fog');
const ctrlTemp = $('ctrl-temp');
const ctrlBase = $('ctrl-base');
const ctrlSun = $('ctrl-sun');
const ctrlWind = $('ctrl-wind');
const ctrlSteps = $('ctrl-steps');
const ctrlDebug = $('ctrl-debug');
const elGenusInfo = $('genus-info');
const elDebugCaption = $('debug-caption');
const elFps = $('stat-fps');
const elGpu = $('stat-gpu');
const elClusters = $('stat-clusters');
const elTopo = $('stat-topology');

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

function formatTempLabel(temp) {
  if (temp <= -10) return `${temp}°C (Polar Freeze / Snow)`;
  if (temp <= 2) return `${temp}°C (Freezing / Sleet & Ice)`;
  if (temp >= 34) return `${temp}°C (Extreme Heat / High CAPE)`;
  if (temp >= 25) return `${temp}°C (Warm / Convective)`;
  return `${temp}°C (Temperate)`;
}

function refreshControlReadouts() {
  const s = atmosphere.state;
  ctrlStorm.value = s.stormType;
  ctrlGenus.value = s.cloudGenus;
  ctrlTornado.value = hydroState.tornadoStrength;
  ctrlHurricane.value = hydroState.hurricaneStrength;
  ctrlTsunami.value = hydroState.tsunamiStrength;
  ctrlWhirlpool.value = hydroState.whirlpoolStrength;
  ctrlTide.value = hydroState.waterLevel;
  ctrlTerrainMorph.value = terrainState.morph;
  ctrlPeakHeight.value = terrainState.peakHeight;
  ctrlCanyonDepth.value = terrainState.canyonDepth;
  ctrlCoverage.value = s.coverage;
  ctrlDensity.value = s.densityMultiplier;
  ctrlRain.value = s.rainIntensity;
  ctrlLightning.value = s.lightningIntensity;
  ctrlFog.value = s.fogDensity;
  ctrlTemp.value = s.temperature;
  optCameraSanta.hidden = s.temperature > -20;
  ctrlBase.value = s.baseAltitude;
  ctrlSun.value = s.sunElevationDeg;
  ctrlWind.value = s.windSpeed;
  ctrlSteps.value = s.maxSteps;
  ctrlDebug.value = String(s.debugMode);

  $('val-tornado').textContent = `${Math.round(hydroState.tornadoStrength * 100)}%`;
  $('val-hurricane').textContent = `${Math.round(hydroState.hurricaneStrength * 100)}%`;
  $('val-tsunami').textContent = `${Math.round(hydroState.tsunamiStrength * 100)}%`;
  $('val-whirlpool').textContent = `${Math.round(hydroState.whirlpoolStrength * 100)}%`;
  $('val-tide').textContent = formatTideLabel(hydroState.waterLevel);
  $('val-terrain-morph').textContent = formatMorphLabel(terrainState.morph);
  $('val-peak-height').textContent = `${Math.round(terrainState.peakHeight)} m`;
  $('val-canyon-depth').textContent = `${Math.round(terrainState.canyonDepth * 100)}%`;
  $('val-coverage').textContent = `${Math.round(s.coverage * 100)}%`;
  $('val-density').textContent = `${s.densityMultiplier.toFixed(2)}×`;
  $('val-rain').textContent = `${Math.round(s.rainIntensity * 100)}%`;
  $('val-lightning').textContent = `${Math.round(s.lightningIntensity * 100)}%`;
  $('val-fog').textContent = `${Math.round(s.fogDensity * 100)}%`;
  $('val-temp').textContent = formatTempLabel(s.temperature);
  $('val-base').textContent = `${s.baseAltitude} m`;
  $('val-sun').textContent = `${s.sunElevationDeg}°`;
  $('val-wind').textContent = `${s.windSpeed} m/s`;
  $('val-steps').textContent = `${s.maxSteps}`;
  elTopo.textContent = `${terrainState.islandCount} Isl / ${terrainState.waterBasinCount} Sea`;

  const genusMeta = CLOUD_GENERA[s.cloudGenus];
  const stormMeta = STORM_TYPES[s.stormType];
  const stormBanner = stormMeta && s.stormType !== 'none' ? `<strong>[${stormMeta.name}]</strong> ${stormMeta.description}<br/>` : '';
  elGenusInfo.innerHTML = `${stormBanner}<strong>${genusMeta.name} · ${genusMeta.etage}:</strong> ${genusMeta.description}`;
  elDebugCaption.textContent = DEBUG_CAPTIONS[s.debugMode];
}
refreshControlReadouts();

const clearActivePresets = () => document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
const syncVortexAndUI = () => {
  atmosphere.setVortexAndTide(hydroState.tornadoX, hydroState.tornadoZ, hydroState.tornadoStrength, hydroState.waterLevel);
  syncSceneLighting();
  refreshControlReadouts();
};

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    clearActivePresets();
    btn.classList.add('active');
    atmosphere.applyPreset(btn.dataset.preset);
    hydroState.tornadoStrength = atmosphere.state.tornadoStrength;
    hydroState.hurricaneStrength = atmosphere.state.hurricaneStrength;
    syncVortexAndUI();
  });
});

ctrlStorm.addEventListener('change', (e) => {
  clearActivePresets();
  atmosphere.setStormType(e.target.value);
  hydroState.tornadoStrength = atmosphere.state.tornadoStrength;
  hydroState.hurricaneStrength = atmosphere.state.hurricaneStrength;
  syncVortexAndUI();
});

ctrlGenus.addEventListener('change', (e) => {
  clearActivePresets();
  atmosphere.setCloudGenus(e.target.value);
  syncSceneLighting();
  refreshControlReadouts();
});

ctrlTornado.addEventListener('input', (e) => {
  hydroState.tornadoStrength = parseFloat(e.target.value);
  syncVortexAndUI();
});

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
  atmosphere.setVortexAndTide(hydroState.tornadoX, hydroState.tornadoZ, hydroState.tornadoStrength, hydroState.waterLevel);
  terrain.updateGeometry();
  refreshControlReadouts();
});

for (const [el, key] of [
  [ctrlTerrainMorph, 'morph'],
  [ctrlPeakHeight, 'peakHeight'],
  [ctrlCanyonDepth, 'canyonDepth'],
]) {
  el.addEventListener('input', (e) => {
    terrainState[key] = parseFloat(e.target.value);
    terrain.updateGeometry();
    refreshControlReadouts();
  });
}

for (const [el, key, needsLightSync] of [
  [ctrlCoverage, 'coverage', false],
  [ctrlDensity, 'densityMultiplier', false],
  [ctrlRain, 'rainIntensity', true],
  [ctrlLightning, 'lightningIntensity', true],
  [ctrlFog, 'fogDensity', true],
  [ctrlTemp, 'temperature', true],
  [ctrlBase, 'baseAltitude', true],
  [ctrlSun, 'sunElevationDeg', true],
  [ctrlWind, 'windSpeed', false],
  [ctrlSteps, 'maxSteps', false],
]) {
  el.addEventListener('input', (e) => {
    atmosphere.setEnvironment({ [key]: parseFloat(e.target.value) });
    if (needsLightSync) syncSceneLighting();
    refreshControlReadouts();
  });
}

ctrlDebug.addEventListener('change', (e) => {
  atmosphere.setDebugMode(parseInt(e.target.value, 10));
  refreshControlReadouts();
});

const ctrlCameraView = document.getElementById('ctrl-camera-view');
const btnResetCamera = document.getElementById('btn-reset-camera');
let activeCameraView = 'free';
const _prevBoatPos = new THREE.Vector3();
let _hasPrevBoatPos = false;

/** Switches camera perspective between Free Orbit, ASV-01..03 Deck View, and -20°C Santa's Sleigh. */
function applyCameraView(view, snap = true) {
  activeCameraView = view;
  if (view === 'free') {
    _hasPrevBoatPos = false;
    if (snap) {
      camera.position.set(-165, 64, 265);
      controls.target.set(0, 68, 0);
    }
    controls.update();
    return;
  }
  if (view === 'santa') {
    const p = northPoleEgg.flyingSleigh.position;
    const f = northPoleEgg.sleighFwd;
    if (snap) {
      camera.position.set(p.x - f.x * 16, p.y + 8.5, p.z - f.z * 16);
      controls.target.set(p.x + f.x * 24, p.y + 2.5, p.z + f.z * 24);
    }
    _prevBoatPos.copy(p);
    _hasPrevBoatPos = true;
    controls.update();
    return;
  }
  const idx = parseInt(view.slice(5), 10);
  const vessel = fleet[idx] || fleet[0];
  if (snap) {
    const p = vessel.group.position;
    const f = vessel.fwd;
    camera.position.set(p.x - f.x * 12, p.y + 7.5, p.z - f.z * 12);
    controls.target.set(p.x + f.x * 26, p.y + 4.5, p.z + f.z * 26);
  }
  _prevBoatPos.copy(vessel.group.position);
  _hasPrevBoatPos = true;
  controls.update();
}

ctrlCameraView.addEventListener('change', (e) => applyCameraView(e.target.value, true));
btnResetCamera.addEventListener('click', () => applyCameraView(activeCameraView, true));

const _navFwd = new THREE.Vector3();
const _navRight = new THREE.Vector3();
const _navUp = new THREE.Vector3(0, 1, 0);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key >= '1' && e.key <= '4') {
    atmosphere.setDebugMode(parseInt(e.key, 10) - 1);
    refreshControlReadouts();
    return;
  }
  const k = e.key.toLowerCase();
  camera.getWorldDirection(_navFwd);
  _navRight.crossVectors(_navFwd, _navUp).normalize();
  const step = e.shiftKey ? 28 : 14;
  if (k === 'w' || e.key === 'ArrowUp') {
    camera.position.addScaledVector(_navFwd, step);
    controls.target.addScaledVector(_navFwd, step);
  } else if (k === 's' || e.key === 'ArrowDown') {
    camera.position.addScaledVector(_navFwd, -step);
    controls.target.addScaledVector(_navFwd, -step);
  } else if (k === 'a' || e.key === 'ArrowLeft') {
    camera.position.addScaledVector(_navRight, -step);
    controls.target.addScaledVector(_navRight, -step);
  } else if (k === 'd' || e.key === 'ArrowRight') {
    camera.position.addScaledVector(_navRight, step);
    controls.target.addScaledVector(_navRight, step);
  } else if (k === 'e' || k === '=' || k === '+') {
    camera.position.lerp(controls.target, 0.14);
  } else if (k === 'q' || k === '-') {
    camera.position.lerp(controls.target, -0.16);
  } else if (k === 'r') {
    applyCameraView(activeCameraView, true);
    return;
  }
  controls.update();
});

// Single-pass hardware bilinear upsample & premultiplied-alpha composite shader
const blitScene = new THREE.Scene();
const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const blitMat = new THREE.ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  uniforms: {
    tBaseScene: { value: sceneTarget.texture },
    tCloudLayer: { value: cloudTarget.texture },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tBaseScene;
    uniform sampler2D tCloudLayer;
    void main() {
      vec4 baseCol = texture2D(tBaseScene, vUv);
      vec4 cloudCol = texture2D(tCloudLayer, vUv);
      gl_FragColor = vec4(baseCol.rgb * (1.0 - cloudCol.a) + cloudCol.rgb, 1.0);
    }
  `,
});
blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat));

/** Resizes full-res sceneTarget and half-res (0.5x) cloudTarget after window resize or context restore. */
function syncRenderTargets() {
  renderer.getDrawingBufferSize(drawingSize);
  sceneTarget.setSize(drawingSize.x, drawingSize.y);
  const cw = Math.max(1, Math.floor(drawingSize.x * CLOUD_RES_SCALE));
  const ch = Math.max(1, Math.floor(drawingSize.y * CLOUD_RES_SCALE));
  cloudTarget.setSize(cw, ch);
  atmosphere.resize(cw, ch);
}

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  syncRenderTargets();
});

const startTime = performance.now();
let lastFrameTime = startTime;
let frameCount = 0;
let fpsAccumTime = 0;
let isContextLost = false;
let rafId = null;

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  isContextLost = true;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  atmosphere.onContextLost();
  elFps.textContent = 'CTX LOST';
  elGpu.textContent = '-- ms';
}, false);

canvas.addEventListener('webglcontextrestored', () => {
  isContextLost = false;
  atmosphere.onContextRestored(renderer);
  atmosphere.setSceneDepthTexture(depthTexture);
  syncRenderTargets();
  syncSceneLighting();
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(animate);
}, false);

const _upVec = new THREE.Vector3();
const _fwdVec = new THREE.Vector3();
const _rightVec = new THREE.Vector3();
const _rotMat = new THREE.Matrix4();
const _windVecXZ = { x: 0.0, y: 0.0 };
const _tornadoCenterXZ = { x: 0.0, y: 0.0 };
const _whirlpoolCenterXZ = { x: 0.0, y: -10.0 };
let _currentElapsed = 0.0;
const _sampleWaterNow = (x, z) => sampleWaterSurfaceHeight(x, z, _currentElapsed);
const _particleParams = {
  windVecXZ: _windVecXZ,
  tornadoStrength: 0.0,
  tornadoCenterXZ: _tornadoCenterXZ,
  hurricaneStrength: 0.0,
  whirlpoolStrength: 0.0,
  whirlpoolCenterXZ: _whirlpoolCenterXZ,
  tsunamiStrength: 0.0,
  tsunamiZ: 280.0,
  waterLevel: 0.0,
  cloudBaseY: 92.0,
  sampleTerrain: terrain.sampleHeightAndGradient,
  sampleWaterHeight: _sampleWaterNow,
};

/**
 * Zero-allocation main render loop driven by requestAnimationFrame:
 * 1) Updates 6-DOF boat wave riding + follow-camera delta
 * 2) Steps 3D Spatial Hash + Union-Find fluid particle physics
 * 3) Runs 3 GPU passes: baseScene -> 0.5x cloudTarget -> bilinear blitScene composite
 */
function animate(now) {
  if (isContextLost) return;
  rafId = requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) * 0.001, 0.05);
  lastFrameTime = now;
  const elapsed = (now - startTime) * 0.001;
  _currentElapsed = elapsed;

  controls.update();

  const tornadoZ = Math.sin(elapsed * 0.22) * 165.0 + 40.0;
  const tornadoX = getMainFjordX(tornadoZ);
  hydroState.tornadoX = tornadoX;
  hydroState.tornadoZ = tornadoZ;
  hydroState.tsunamiZ = 380.0 - ((elapsed * 75.0) % 760.0);

  ocean.setHydroState(hydroState);
  atmosphere.setVortexAndTide(tornadoX, tornadoZ, hydroState.tornadoStrength, hydroState.waterLevel);

  for (const v of fleet) {
    const t = elapsed * v.speed + v.phase;
    const pNow = sampleFleetWaterwayPath(v.routeType, t);
    const pNext = sampleFleetWaterwayPath(v.routeType, t + 0.015);

    const hCenter = sampleWaterSurfaceHeight(pNow.x, pNow.z, elapsed);
    const hRight = sampleWaterSurfaceHeight(pNow.x + 3.0, pNow.z, elapsed);
    const hFwd = sampleWaterSurfaceHeight(pNow.x, pNow.z + 3.0, elapsed);

    v.group.position.set(pNow.x, hCenter + 0.15, pNow.z);
    _upVec.set(hCenter - hRight, 3.0, hCenter - hFwd).normalize();
    _fwdVec.set(pNext.x - pNow.x, 0.0, pNext.z - pNow.z).normalize();
    _rightVec.crossVectors(_upVec, _fwdVec).normalize();
    _fwdVec.crossVectors(_rightVec, _upVec).normalize();
    _rotMat.makeBasis(_rightVec, _upVec, _fwdVec);
    v.group.quaternion.setFromRotationMatrix(_rotMat);
    v.fwd.copy(_fwdVec);
  }

  if (activeCameraView.startsWith('boat-')) {
    const vessel = fleet[parseInt(activeCameraView.slice(5), 10)] || fleet[0];
    const bp = vessel.group.position;
    if (_hasPrevBoatPos) {
      const dx = bp.x - _prevBoatPos.x;
      const dy = bp.y - _prevBoatPos.y;
      const dz = bp.z - _prevBoatPos.z;
      camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
      controls.target.set(controls.target.x + dx, controls.target.y + dy, controls.target.z + dz);
      controls.update();
    }
    _prevBoatPos.copy(bp);
    _hasPrevBoatPos = true;
  }

  const temp = atmosphere.state.temperature;
  const thermalScale = 1.0 + Math.max(0, Math.min(1, (temp - 24) / 21)) * 0.42 - Math.max(0, Math.min(1, (2 - temp) / 22)) * 0.18;
  const windAngle = THREE.MathUtils.degToRad(32);
  _windVecXZ.x = Math.cos(windAngle) * atmosphere.state.windSpeed * thermalScale;
  _windVecXZ.y = Math.sin(windAngle) * atmosphere.state.windSpeed * thermalScale;
  _tornadoCenterXZ.x = tornadoX;
  _tornadoCenterXZ.y = tornadoZ;
  _whirlpoolCenterXZ.x = hydroState.whirlpoolX;
  _whirlpoolCenterXZ.y = hydroState.whirlpoolZ;

  _particleParams.tornadoStrength = hydroState.tornadoStrength;
  _particleParams.hurricaneStrength = hydroState.hurricaneStrength;
  _particleParams.whirlpoolStrength = hydroState.whirlpoolStrength;
  _particleParams.tsunamiStrength = hydroState.tsunamiStrength;
  _particleParams.tsunamiZ = hydroState.tsunamiZ;
  _particleParams.waterLevel = hydroState.waterLevel;
  _particleParams.cloudBaseY = atmosphere.state.baseAltitude;
  fluidClusterParticles.update(dt, _particleParams);
  updateNorthPoleEasterEgg(elapsed);

  if (rainSystem.lines.visible) {
    rainSystem.mat.uniforms.uTime.value = elapsed;
    rainSystem.mat.uniforms.uCameraPos.value.copy(camera.position);
    rainSystem.mat.uniforms.uWindXZ.value.set(_windVecXZ.x, _windVecXZ.y);
  }
  if (lightningSystem.lines.visible) {
    lightningSystem.mat.uniforms.uTime.value = elapsed;
  }

  atmosphere.update(elapsed, camera);

  // Pass 1: Opaque terrain, vertex-displaced ocean, GPU streamlines, 3D lightning, ASVs & DSU particles
  renderer.setRenderTarget(sceneTarget);
  renderer.clear();
  renderer.render(baseScene, camera);

  // Pass 2: Half-resolution (0.5x) volumetric cloud raymarching pass
  renderer.setRenderTarget(cloudTarget);
  renderer.setClearColor(0x000000, 0.0);
  renderer.clear();
  atmosphere.beginGpuTimer();
  renderer.render(atmosphereScene, camera);
  atmosphere.endGpuTimer();

  // Pass 3: Single-pass hardware bilinear upsample & premultiplied-alpha composite
  renderer.setRenderTarget(null);
  renderer.render(blitScene, blitCam);

  frameCount++;
  fpsAccumTime += dt;
  if (fpsAccumTime >= 0.3) {
    const fps = Math.round(frameCount / fpsAccumTime);
    elFps.textContent = `${fps} FPS`;
    elGpu.textContent =
      atmosphere.lastGpuPassMs !== null
        ? `${atmosphere.lastGpuPassMs.toFixed(2)} ms`
        : `${(1000 / Math.max(fps, 1)).toFixed(1)} ms (CPU)`;
    elClusters.textContent = `${fluidClusterParticles.activeClusters} (Max: ${fluidClusterParticles.largestCluster})`;
    frameCount = 0;
    fpsAccumTime = 0;
  }
}

window.simulationContext = {
  renderer,
  camera,
  controls,
  atmosphere,
  ocean,
  terrain,
  fluidClusterParticles,
  fleet,
  hydroState,
  terrainState,
  sampleWaterSurfaceHeight,
  formatMorphLabel,
  formatTideLabel,
  refreshControlReadouts,
  syncVortexAndUI,
  syncSceneLighting,
};

rafId = requestAnimationFrame(animate);
