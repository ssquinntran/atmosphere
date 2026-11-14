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
// Position camera looking along the flooded fjord canyon entrance toward the Saronic ASV fleet & cloud deck
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

// 1. Ocean & Flooded Canyon River Surface with RTC Cloud Shadows + Raindrop Ripple Rings
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

// Shared analytical waterway centerline functions so gorges are ALWAYS flooded and boats follow them exactly
function getMainFjordX(z) {
  return Math.sin(z * 0.0065) * 65.0 + Math.cos(z * 0.014) * 20.0;
}

function getCrossGorgeZ(x) {
  return Math.cos(x * 0.0068) * 48.0 - 10.0;
}

// 2. Continuous Morphable Landform System + GPU Topographic Height/Flow Map (uTerrainMap)
const terrainState = {
  morph: 0.65,       // 0.0 = Scattered Islands, 0.5 = Fjord Canyon Range, 1.0 = Connected Alpine Massif
  peakHeight: 245.0, // Maximum peak elevation in meters (cuts right through low & mid cloud decks)
  canyonDepth: 0.70, // Width & wall steepness of winding central fjord & cross-gorge carving [0..1]
};

function createMorphableTerrain() {
  const segs = 220;
  const gridRes = segs + 1; // 221 x 221 vertices
  const geo = new THREE.PlaneGeometry(1200, 1200, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const heights = new Float32Array(count);

  // GPU Terrain Height & Gradient Map (R: height/380m, G: dH/dx, B: dH/dz, A: canyonFunnelMask)
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

  // Precompute spatial basis fields once so real-time slider morphing runs at 60 FPS
  const islandBasis = new Float32Array(count);
  const massifBasis = new Float32Array(count);
  const riverChannelMask = new Float32Array(count); // 1.0 in core waterway, 0.0 outside
  const canyonSlopeBasis = new Float32Array(count); // Wider canyon wall carve
  const ridgeDetailBasis = new Float32Array(count);

  // 4 quadrant islands placed cleanly outside the central North-South & East-West waterways
  const islands = [
    { x: -205, z: -165, radius: 155, weight: 1.0 },
    { x: 215, z: -160, radius: 145, weight: 0.88 },
    { x: 210, z: 175, radius: 140, weight: 0.78 },
    { x: -195, z: 175, radius: 145, weight: 0.84 },
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

    // Distance to Main North-South Fjord Waterway & East-West Cross Gorge Waterway
    const distMain = Math.abs(x - getMainFjordX(z));
    const distCross = Math.abs(z - getCrossGorgeZ(x));
    const minWaterDist = Math.min(distMain, distCross);

    // Core navigable water channel (always stays underwater so boats travel through flooded gorges)
    const coreWater = 1.0 - THREE.MathUtils.smoothstep(minWaterDist, 28.0, 56.0);
    riverChannelMask[i] = coreWater;

    // Wider canyon gorge walls that widen/steepen as Canyon Gorge Carve slider increases
    const mainWall = Math.exp(-Math.pow(distMain / 105.0, 2.1));
    const crossWall = Math.exp(-Math.pow(distCross / 88.0, 2.1)) * 0.88;
    canyonSlopeBasis[i] = Math.min(1.0, Math.max(mainWall, crossWall));

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
    islandBasis[i] = islH * (1.0 - coreWater);

    // B) Continuous merged mountain massif envelope divided by the flooded gorges
    const radialDist = Math.sqrt(x * x + z * z);
    const mapEnvelope = Math.max(0.0, 1.0 - Math.pow(radialDist / 540.0, 2.2));

    // Twin mountain cordilleras flanking the central fjord
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
      const riverCut = riverChannelMask[i];
      const slopeCut = canyonSlopeBasis[i];
      const ridge = ridgeDetailBasis[i];

      // Smoothly bridge islands into connected mountain massif as morph goes 0 -> 1
      const combinedLand = THREE.MathUtils.lerp(isl, Math.max(isl * 0.85, massif), morph);

      // Guaranteed flooded gorge waterway in the center + adjustable wider canyon wall carving
      const wallCarve = slopeCut * canyonStrength * THREE.MathUtils.smoothstep(morph, 0.05, 0.50);
      const totalCarve = Math.min(1.0, Math.max(riverCut, wallCarve * 0.92));

      // Add terraced canyon cliff steps along vertical gorge walls
      const rawNormalizedH = combinedLand * (1.0 - totalCarve);
      const terraceStep = Math.sin(rawNormalizedH * 22.0) * 0.018 * wallCarve * (1.0 - riverCut);

      // Force river channel floor below sea level (-9.5m) so ocean water always fills the gorges
      const h = (rawNormalizedH + terraceStep) * peakScale - 8.0 - riverCut * 4.5;
      pos.setY(i, h);
      heights[i] = Math.max(0.0, h);

      // Elevation & canyon-wall biome coloring (Riverbank Sand -> Forest / Canyon Slate -> Alpine Rock -> Snow Caps)
      if (h < 3.5) {
        colTemp.copy(colSand);
      } else if (h < 88.0) {
        const t = (h - 3.5) / 84.5;
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

    // Populate GPU uTerrainMap with height + central-difference slope gradients + canyon funnel mask
    const cellStepM = 1200.0 / segs;
    for (let iz = 0; iz < gridRes; iz++) {
      const zPrev = Math.max(0, iz - 1);
      const zNext = Math.min(segs, iz + 1);
      for (let ix = 0; ix < gridRes; ix++) {
        const xPrev = Math.max(0, ix - 1);
        const xNext = Math.min(segs, ix + 1);
        const idx = iz * gridRes + ix;

        const hCenter = heights[idx];
        const dhdx = (heights[iz * gridRes + xNext] - heights[iz * gridRes + xPrev]) / (2.0 * cellStepM);
        const dhdz = (heights[zNext * gridRes + ix] - heights[zPrev * gridRes + ix]) / (2.0 * cellStepM);

        // Normalize height to [0..380m] and slope gradients to [-1.2..+1.2] -> [0..255]
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

    pos.needsUpdate = true;
    colorAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  // Bilinear CPU height & gradient query for 3D wind streamlines so air ribbons wrap around mountains
  function sampleHeightAndGradient(x, z) {
    const u = THREE.MathUtils.clamp((x + 600.0) / 1200.0, 0.0, 0.999);
    const v = THREE.MathUtils.clamp((z + 600.0) / 1200.0, 0.0, 0.999);
    const ix = Math.floor(u * segs);
    const iz = Math.floor(v * segs);
    const idx = iz * gridRes + ix;
    const h = heights[idx];
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

// 3. 3D Topographic Wind Streamlines (shows moving air splitting around mountain peaks, rising over ridges & funneling through gorges)
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

      // Deflect particle velocity around steep mountain slopes & accelerate in gorges
      let vx = baseWx * p.speedScale * (1.0 + info0.funnel * 0.45);
      let vz = baseWz * p.speedScale * (1.0 + info0.funnel * 0.45);

      if (info0.h > p.baseY - 45.0) {
        // Push air laterally around the mountain slope gradient instead of going through rock
        const block = THREE.MathUtils.clamp((info0.h - (p.baseY - 45.0)) / 75.0, 0.0, 1.8);
        vx -= info0.gx * 52.0 * block;
        vz -= info0.gz * 52.0 * block;
      }

      p.x += vx * dt;
      p.z += vz * dt;

      // Wrap within [-520, 520] domain
      if (p.x > 520) p.x -= 1040;
      if (p.x < -520) p.x += 1040;
      if (p.z > 520) p.z -= 1040;
      if (p.z < -520) p.z += 1040;

      // Trace streamline ribbon backward along local topographic flow field
      let curX = p.x;
      let curZ = p.z;
      const baseVertIdx = i * segsPerStream * 2;

      for (let s = 0; s < segsPerStream; s++) {
        const tA = terrain.sampleHeightAndGradient(curX, curZ);
        // Orographic lift: streamline rides smoothly over terrain cushion (+16m above rock)
        const yA = Math.max(p.baseY + tA.h * 0.35, tA.h + 16.0);

        let stepVx = baseWx * (1.0 + tA.funnel * 0.45);
        let stepVz = baseWz * (1.0 + tA.funnel * 0.45);
        if (tA.h > p.baseY - 45.0) {
          const blk = THREE.MathUtils.clamp((tA.h - (p.baseY - 45.0)) / 75.0, 0.0, 1.8);
          stepVx -= tA.gx * 52.0 * blk;
          stepVz -= tA.gz * 52.0 * blk;
        }

        const nextX = curX - stepVx * 0.085;
        const nextZ = curZ - stepVz * 0.085;
        const tB = terrain.sampleHeightAndGradient(nextX, nextZ);
        const yB = Math.max(p.baseY + tB.h * 0.35, tB.h + 16.0);

        const vIdx = (baseVertIdx + s * 2) * 3;
        posArr[vIdx] = curX;
        posArr[vIdx + 1] = yA;
        posArr[vIdx + 2] = curZ;

        posArr[vIdx + 3] = nextX;
        posArr[vIdx + 4] = yB;
        posArr[vIdx + 5] = nextZ;

        const fadeA = 1.0 - s / segsPerStream;
        const fadeB = 1.0 - (s + 1) / segsPerStream;
        alphaArr[baseVertIdx + s * 2] = fadeA;
        alphaArr[baseVertIdx + s * 2 + 1] = fadeB;

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

// 4. Saronic Autonomous Surface Vessels (ASVs: Corsair, Cutlass, Spyglass) with Saronic Logo & Stealth Faceted Hulls
function createSaronicLogoTexture(vesselClass, hullNumber, accentCss) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');

  // Matte stealth hull background plate
  ctx.fillStyle = '#111822';
  ctx.fillRect(0, 0, c.width, c.height);

  // Subtle top/bottom tactical trim line
  ctx.fillStyle = accentCss;
  ctx.fillRect(0, 0, c.width, 4);
  ctx.fillRect(0, c.height - 4, c.width, 4);

  // Saronic Geometric Stealth Emblem (angular chevron/trident shield mark)
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

  // Bold "SARONIC" wordmark
  ctx.fillStyle = '#f8fafc';
  ctx.font = '800 44px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.letterSpacing = '4px';
  ctx.fillText('SARONIC', 124, 64);

  // Vessel class & hull designation subtitle
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

  // 1. Custom Faceted Stealth Wave-Piercing ASV Hull (inspired by Saronic Corsair / Cutlass)
  const hullPositions = new Float32Array([
    0.0, 2.3, 14.5,    // 0: bow top tip
    0.0, 0.1, 13.2,    // 1: bow waterline forefoot

    -2.6, 2.2, 5.5,    // 2: port fwd deck edge
     2.6, 2.2, 5.5,    // 3: stbd fwd deck edge
    -3.1, 1.1, 5.2,    // 4: port fwd outer chine
     3.1, 1.1, 5.2,    // 5: stbd fwd outer chine
    -2.2, 0.0, 5.0,    // 6: port fwd waterline
     2.2, 0.0, 5.0,    // 7: stbd fwd waterline

    -2.8, 2.1, -6.5,   // 8: port aft deck edge
     2.8, 2.1, -6.5,   // 9: stbd aft deck edge
    -3.4, 1.1, -6.8,   // 10: port aft outer chine
     3.4, 1.1, -6.8,   // 11: stbd aft outer chine
    -2.5, 0.0, -6.8,   // 12: port aft waterline
     2.5, 0.0, -6.8,   // 13: stbd aft waterline

    -2.3, 1.9, -11.5,  // 14: port transom top
     2.3, 1.9, -11.5,  // 15: stbd transom top
    -2.7, 0.9, -12.0,  // 16: port transom chine
     2.7, 0.9, -12.0,  // 17: stbd transom chine
    -2.0, 0.0, -11.8,  // 18: port transom bottom
     2.0, 0.0, -11.8,  // 19: stbd transom bottom
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

  // 2. Angular Stealth Superstructure / Payload Module House
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

  // 3. Forward-Raked Integrated Stealth Sensor Mast + EO/IR Gimbal Turret
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

  // 4. SARONIC Logo & Hull Nameplates
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

  // 5. High-Speed Twin Foaming V-Wake + Transom Rooster-Tail Spray
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

// 5. GPU-Accelerated 3D Rain Streak System (wind-slanted falling rain streaks around camera)
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
  'Mode 1 (Final Composite): Full volumetric clouds with topographic airflow deflection, orographic lift over ridges, and rain.',
  'Mode 2 (Optical Transmittance T): Shows how much background light passes through the clouds (1.0 = clear sky, 0.0 = opaque cloud core in coral).',
  'Mode 3 (Radial Scene Depth tScene): Visualizes true 3D Euclidean distance to mountain ridges & canyons (50m contour rings) used for soft cloud-terrain occlusion.',
  'Mode 4 (3D Noise & Airflow Slice): Cross-section of 3D noise + solid mountain rock cores (amber rim) showing air streamlines splitting around peaks.',
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

  const dt = Math.min((now - lastFrameTime) * 0.001, 0.05);
  lastFrameTime = now;
  const elapsed = (now - startTime) * 0.001;

  controls.update();

  // Advance Saronic ASV fleet strictly along the flooded canyon & fjord waterways
  for (const v of fleet) {
    const t = elapsed * v.speed + v.phase;
    const pNow = sampleFleetWaterwayPath(v.routeType, t);
    const pNext = sampleFleetWaterwayPath(v.routeType, t + 0.015);

    v.group.position.set(pNow.x, 0.15, pNow.z);
    v.group.lookAt(pNext.x, 0.15, pNext.z);
  }

  // Advance 3D topographic airflow streamlines (deflecting around peaks & funneling through gorges)
  airflowStreams.update(dt, atmosphere.state.windSpeed);

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

  // Pass 1: Render opaque maritime scene + 3D airflow streamlines + rainfall into offscreen render target + DepthTexture
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
