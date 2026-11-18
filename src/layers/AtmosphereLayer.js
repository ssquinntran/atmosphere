import * as THREE from 'three';
import { atmosphereVertexShader } from '../shaders/atmosphere.vert.js';
import { atmosphereFragmentShader } from '../shaders/atmosphere.frag.js';
import { CloudNoiseBaker } from '../noise/CloudNoiseBaker.js';

/** Debug visualization modes selectable via keys 1–4 or the HUD dropdown. */
export const DEBUG_MODES = { final: 0, transmittance: 1, depth: 2, noise: 3 };

const defGenus = (id, name, etage, description, coverage, baseAltitude, slabThickness, extinction, densityMultiplier, rainIntensity, shapeParams) => ({
  id, name, etage, description, coverage, baseAltitude, slabThickness, extinction, densityMultiplier, rainIntensity, shapeParams,
});

/** Physical & visual profiles for all 10 WMO cloud genera (low, middle, high, and towering convective). */
export const CLOUD_GENERA = {
  cumulus:       defGenus(0, 'Cumulus (Cu)',       'Low (90–260 m)',        'Detached cauliflower towers with crisp flat bases and sunlit domes.',   0.64,  92, 165, 0.088, 1.65, 0.0,  [1.05, 0.95, 0.92, 0.08]),
  stratus:       defGenus(1, 'Stratus (St)',       'Low (55–140 m)',        'Uniform featureless gray layer hugging the lower atmosphere.',          0.86,  58,  85, 0.072, 1.45, 0.18, [0.52, 1.85, 0.15, 0.02]),
  stratocumulus: defGenus(2, 'Stratocumulus (Sc)', 'Low (80–200 m)',        'Lumpy honeycomb cloud rolls and rounded patches with sky breaks.',      0.72,  82, 120, 0.082, 1.55, 0.0,  [0.92, 1.35, 0.78, 0.05]),
  altocumulus:   defGenus(3, 'Altocumulus (Ac)',   'Middle (155–265 m)',    'Mid-altitude mackerel-sky cellular puffs and wave bands.',              0.62, 155, 110, 0.078, 1.55, 0.0,  [1.65, 1.45, 0.95, 0.12]),
  altostratus:   defGenus(4, 'Altostratus (As)',   'Middle (145–270 m)',    'Fibrous blue-gray sheet covering the sky with diffused sunlight.',      0.84, 145, 125, 0.068, 1.42, 0.12, [0.58, 1.65, 0.25, 0.18]),
  nimbostratus:  defGenus(5, 'Nimbostratus (Ns)',  'Low–Middle (65–275 m)', 'Dark widespread storm deck producing continuous rain.',                 0.92,  65, 210, 0.105, 1.85, 0.85, [0.75, 0.85, 0.45, 0.22]),
  cirrus:        defGenus(6, 'Cirrus (Ci)',        'High (235–325 m)',      'Delicate high-altitude ice filaments and wind-sheared mares\' tails.',  0.56, 235,  90, 0.054, 1.55, 0.0,  [1.35, 2.20, 0.38, 1.45]),
  cirrocumulus:  defGenus(7, 'Cirrocumulus (Cc)',  'High (230–310 m)',      'Thin white ice-crystal ripples arranged in fine honeycomb rows.',       0.58, 230,  80, 0.064, 1.60, 0.0,  [2.35, 2.10, 0.98, 0.35]),
  cirrostratus:  defGenus(8, 'Cirrostratus (Cs)',  'High (220–315 m)',      'Translucent silky ice-crystal veil covering the upper sky dome.',       0.80, 220,  95, 0.048, 1.35, 0.0,  [0.65, 2.00, 0.20, 0.65]),
  cumulonimbus:  defGenus(9, 'Cumulonimbus (Cb)',  'Towering (68–368 m)',   'Massive vertical thunderhead tower with spreading anvil and downpour.', 0.78,  68, 300, 0.112, 1.95, 0.95, [0.95, 0.62, 0.94, 0.48]),
};

const defStorm = (id, name, description, cloudGenus, coverage, windSpeed, rainIntensity, lightningIntensity, fogDensity, tornadoStrength, hurricaneStrength, sunElevationDeg, sunColor, sunIntensity, skyColor) => ({
  id, name, description, cloudGenus, coverage, windSpeed, rainIntensity, lightningIntensity, fogDensity, tornadoStrength, hurricaneStrength, sunElevationDeg, sunColor, sunIntensity, skyColor,
});

/** Parameter presets for the 6 cyclonic / convective storm regimes. */
export const STORM_TYPES = {
  none:             defStorm(0, 'Fair Weather (No Cyclone)',                    'Calm maritime trade winds with no active cyclonic vortex.',                     'cumulus',      0.65, 14, 0.00, 0.00, 0.22, 0.00, 0.00, 32, 0xfff5e0, 3.6, 0x4f86c6),
  waterspout:       defStorm(1, 'Maritime Waterspout (Rankine Tube)',           'Slender Rankine vortex tube connecting cumulus base to a sea-spray collar.',    'cumulonimbus', 0.76, 22, 0.48, 0.35, 0.38, 0.72, 0.00, 24, 0xffe2b8, 3.0, 0x43668a),
  supercellTornado: defStorm(2, 'EF5 Supercell Wedge Tornado',                  'Massive wedge mesocyclone vortex with rotating wall cloud and forked lightning.', 'cumulonimbus', 0.88, 30, 0.92, 0.95, 0.55, 0.95, 0.00, 15, 0xffc994, 2.5, 0x35485e),
  hurricane:        defStorm(3, 'Category 5 Hurricane (Eyewall + Spiral Bands)','Tropical cyclone with calm eye, stadium eyewall, 4 spiral bands & storm surge.', 'cumulonimbus', 0.94, 38, 0.96, 0.85, 0.65, 0.00, 0.95, 18, 0xffd7b0, 2.4, 0x2d4359),
  derecho:          defStorm(4, 'Derecho Squall Line (Arcus Shelf Cloud)',      'Bowed convective squall front with low arcus roll cloud and straight-line gale.','cumulonimbus', 0.86, 36, 0.88, 0.90, 0.50, 0.00, 0.82, 14, 0xffbe85, 2.4, 0x314559),
  norEaster:        defStorm(5, "Nor'easter Bomb Cyclone (Comma-Head)",         'Baroclinic comma-head cyclone with dense nimbostratus gale bands and sea fog.',  'nimbostratus', 0.92, 33, 0.86, 0.45, 0.72, 0.35, 0.88, 12, 0xdbeafe, 2.3, 0x2c4257),
};

const buildPreset = (stormType, overrides = {}) => {
  const s = STORM_TYPES[stormType];
  const g = CLOUD_GENERA[overrides.cloudGenus ?? s.cloudGenus];
  return {
    stormType,
    stormTypeId: s.id,
    cloudGenus: overrides.cloudGenus ?? s.cloudGenus,
    coverage: s.coverage,
    baseAltitude: g.baseAltitude,
    slabThickness: g.slabThickness,
    sunElevationDeg: s.sunElevationDeg,
    sunAzimuthDeg: 42,
    windSpeed: s.windSpeed,
    extinction: g.extinction,
    densityMultiplier: g.densityMultiplier,
    rainIntensity: s.rainIntensity,
    lightningIntensity: s.lightningIntensity,
    fogDensity: s.fogDensity,
    tornadoStrength: s.tornadoStrength,
    hurricaneStrength: s.hurricaneStrength,
    sunColor: s.sunColor,
    sunIntensity: s.sunIntensity,
    skyColor: s.skyColor,
    ...overrides,
  };
};

export const WEATHER_PRESETS = {
  tradeWinds:  buildPreset('none', { densityMultiplier: 1.68 }),
  clearPatrol: buildPreset('none', { cloudGenus: 'cirrus', coverage: 0.54, baseAltitude: 230, slabThickness: 90, sunElevationDeg: 45, sunAzimuthDeg: 35, windSpeed: 18, extinction: 0.058, densityMultiplier: 1.55, fogDensity: 0.10, sunColor: 0xfff9ed, sunIntensity: 3.8, skyColor: 0x5692d6 }),
  squall:      buildPreset('supercellTornado', { coverage: 0.86, slabThickness: 290, sunElevationDeg: 16, sunAzimuthDeg: 55, windSpeed: 28, extinction: 0.110, densityMultiplier: 1.92, lightningIntensity: 0.90, fogDensity: 0.52, tornadoStrength: 0.85, sunIntensity: 2.6, skyColor: 0x3b5068 }),
  hurricane:   buildPreset('hurricane', { baseAltitude: 64, slabThickness: 305, sunAzimuthDeg: 48, extinction: 0.115, densityMultiplier: 1.98 }),
};

/**
 * Self-contained WebGL2 / Three.js volumetric cloud, cyclone, lightning, and fog layer.
 * Renders an inverted BackSide proxy box whose fragment shader raymarches 3D Perlin-Worley noise.
 */
export class AtmosphereLayer {
  constructor(options = {}) {
    this.mapExtent = options.mapExtent ?? 1200;
    const g = CLOUD_GENERA.cumulus;
    this.state = {
      ...WEATHER_PRESETS.tradeWinds,
      cloudGenusId: g.id,
      shapeParams: [...g.shapeParams],
      maxSteps: options.maxSteps ?? 36,
      debugMode: options.debugMode ?? DEBUG_MODES.final,
      originOffsetX: 0,
      originOffsetZ: 0,
      tornadoX: 0.0,
      tornadoZ: 45.0,
      waterLevel: 0.0,
      temperature: 18,
    };

    this.macroNoise = null;
    this.detailNoise = null;
    this.weatherMap = null;
    this.blueNoise = null;
    this.terrainMap = null;
    this.material = null;
    this.proxyMesh = null;

    this.gl = null;
    this.timerExt = null;
    this.pendingQueries = [];
    this.lastGpuPassMs = null;

    this._cameraForward = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._tmpColor = new THREE.Color();
  }

  init(renderer, scene) {
    this._initGpuResources(renderer);

    if (!this.terrainMap) {
      const emptyData = new Uint8Array(64);
      for (let i = 0; i < 16; i++) {
        emptyData[i * 4 + 1] = 128;
        emptyData[i * 4 + 2] = 128;
      }
      this.terrainMap = new THREE.DataTexture(emptyData, 4, 4, THREE.RGBAFormat);
      this.terrainMap.needsUpdate = true;
    }

    const half = this.mapExtent * 0.5;
    const s = this.state;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      side: THREE.BackSide,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBoundsMinAndFade:     { value: new THREE.Vector4(-half, s.baseAltitude, -half, 35.0) },
        uBoundsMaxAndCoverage: { value: new THREE.Vector4(half, s.baseAltitude + s.slabThickness, half, s.coverage) },
        uSunDirAndElevation:   { value: new THREE.Vector4(0.6, 0.5, 0.6, 0.0) },
        uSunColorAndIntensity: { value: new THREE.Vector4(1.0, 0.95, 0.86, s.sunIntensity) },
        uSkyColorAndHaze:      { value: new THREE.Vector4(0.31, 0.53, 0.78, 0.00055) },
        uWindAndTime:          { value: new THREE.Vector4(10.0, 6.0, 0.0, s.extinction) },
        uCameraPosAndSteps:    { value: new THREE.Vector4(0, 180, 320, s.maxSteps) },
        uCameraForwardAndNear: { value: new THREE.Vector4(0, -0.4, -0.9, 1.0) },
        uViewportAndFar:       { value: new THREE.Vector4(1280, 720, 4000.0, 0.28) },
        uDebugParams:          { value: new THREE.Vector4(s.debugMode, s.cloudGenusId, s.rainIntensity, s.densityMultiplier) },
        uWorldOriginOffset:    { value: new THREE.Vector4(s.originOffsetX, s.originOffsetZ, s.stormTypeId, s.hurricaneStrength) },
        uCloudShapeParams:     { value: new THREE.Vector4(...s.shapeParams) },
        uVortexAndTide:         { value: new THREE.Vector4(s.tornadoX, s.tornadoZ, s.tornadoStrength, s.waterLevel) },
        uMacroNoise:           { value: this.macroNoise },
        uDetailNoise:          { value: this.detailNoise },
        uWeatherMap:           { value: this.weatherMap },
        uBlueNoise:            { value: this.blueNoise },
        uTerrainMap:           { value: this.terrainMap },
        uSceneDepth:           { value: null },
      },
    });

    this.proxyMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.proxyMesh.frustumCulled = false;
    this.proxyMesh.renderOrder = 100;

    this._syncBoundsAndLighting();
    scene.add(this.proxyMesh);
  }

  _initGpuResources(renderer) {
    this.gl = renderer.getContext();
    this.timerExt = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.macroNoise = CloudNoiseBaker.bakeVolumeTexture(renderer, 64, 8, 4.0);
    this.detailNoise = CloudNoiseBaker.bakeVolumeTexture(renderer, 32, 8, 6.0);
    this.weatherMap = CloudNoiseBaker.createWeatherMap(256);
    this.blueNoise = CloudNoiseBaker.createBlueNoiseJitter(64);
  }

  onContextLost() {
    this.gl = null;
    this.timerExt = null;
    this.pendingQueries.length = 0;
    this.lastGpuPassMs = null;
    this.macroNoise?.dispose();
    this.detailNoise?.dispose();
    this.weatherMap?.dispose();
    this.blueNoise?.dispose();
    this.macroNoise = this.detailNoise = this.weatherMap = this.blueNoise = null;
  }

  onContextRestored(renderer) {
    this._initGpuResources(renderer);
    if (this.material) {
      const u = this.material.uniforms;
      u.uMacroNoise.value = this.macroNoise;
      u.uDetailNoise.value = this.detailNoise;
      u.uWeatherMap.value = this.weatherMap;
      u.uBlueNoise.value = this.blueNoise;
      u.uTerrainMap.value = this.terrainMap;
      this.material.needsUpdate = true;
      this._syncBoundsAndLighting();
    }
  }

  setTerrainMap(terrainTexture) {
    this.terrainMap = terrainTexture;
    if (this.material) this.material.uniforms.uTerrainMap.value = terrainTexture;
  }

  _updateProxyTransform() {
    const s = this.state;
    const yMin = s.baseAltitude;
    const yMax = yMin + s.slabThickness;
    const hasSubCloud = s.rainIntensity > 0.01 || s.tornadoStrength > 0.01;
    const proxyMinY = hasSubCloud ? Math.min(s.waterLevel, 0.0) : yMin;
    const proxyHeight = yMax + 65.0 - proxyMinY;
    this.proxyMesh.scale.set(this.mapExtent, proxyHeight, this.mapExtent);
    this.proxyMesh.position.set(0, proxyMinY + proxyHeight * 0.5, 0);
  }

  setVortexAndTide(tornadoX, tornadoZ, tornadoStrength, waterLevel) {
    const s = this.state;
    s.tornadoX = tornadoX;
    s.tornadoZ = tornadoZ;
    s.tornadoStrength = tornadoStrength;
    s.waterLevel = waterLevel;
    if (this.material) {
      this.material.uniforms.uVortexAndTide.value.set(tornadoX, tornadoZ, tornadoStrength, waterLevel);
      this._updateProxyTransform();
    }
  }

  setWorldOriginOffset(offsetX, offsetZ) {
    this.state.originOffsetX = offsetX;
    this.state.originOffsetZ = offsetZ;
    if (this.material) {
      this.material.uniforms.uWorldOriginOffset.value.set(offsetX, offsetZ, this.state.stormTypeId, this.state.hurricaneStrength);
    }
  }

  setStormType(stormKey) {
    const storm = STORM_TYPES[stormKey];
    if (!storm) return;
    const genus = CLOUD_GENERA[storm.cloudGenus];
    Object.assign(this.state, storm, {
      stormType: stormKey,
      stormTypeId: storm.id,
      cloudGenusId: genus.id,
      baseAltitude: genus.baseAltitude,
      slabThickness: genus.slabThickness,
      extinction: genus.extinction,
      densityMultiplier: genus.densityMultiplier,
      shapeParams: [...genus.shapeParams],
    });
    this._syncBoundsAndLighting();
  }

  setSceneDepthTexture(depthTexture) {
    if (this.material) this.material.uniforms.uSceneDepth.value = depthTexture;
  }

  setDebugMode(mode) {
    const modeId = typeof mode === 'string' ? (DEBUG_MODES[mode] ?? 0) : Number(mode) || 0;
    this.state.debugMode = Math.min(Math.max(Math.round(modeId), 0), 3);
    if (this.material) this.material.uniforms.uDebugParams.value.x = this.state.debugMode;
  }

  setCloudGenus(genusKey) {
    const genus = CLOUD_GENERA[genusKey];
    if (!genus) return;
    const isDark = genusKey === 'nimbostratus' || genusKey === 'cumulonimbus';
    const isMid = genusKey === 'stratus' || genusKey === 'altostratus';
    Object.assign(this.state, {
      cloudGenus: genusKey,
      cloudGenusId: genus.id,
      coverage: genus.coverage,
      baseAltitude: genus.baseAltitude,
      slabThickness: genus.slabThickness,
      extinction: genus.extinction,
      densityMultiplier: genus.densityMultiplier,
      rainIntensity: genus.rainIntensity,
      shapeParams: [...genus.shapeParams],
      skyColor: isDark ? 0x3b5068 : isMid ? 0x516e8c : 0x4f86c6,
      sunIntensity: isDark ? 2.6 : isMid ? 3.0 : 3.6,
    });
    this._syncBoundsAndLighting();
  }

  applyPreset(presetName) {
    const preset = WEATHER_PRESETS[presetName];
    if (!preset) return;
    const genus = CLOUD_GENERA[preset.cloudGenus];
    Object.assign(this.state, preset, {
      cloudGenusId: genus.id,
      shapeParams: [...genus.shapeParams],
    });
    this._syncBoundsAndLighting();
  }

  setEnvironment(partial) {
    Object.assign(this.state, partial);
    this._syncBoundsAndLighting();
  }

  _syncBoundsAndLighting() {
    if (!this.material) return;
    const s = this.state;
    const u = this.material.uniforms;
    const half = this.mapExtent * 0.5;
    const yMin = s.baseAltitude;
    const yMax = yMin + s.slabThickness;

    const temp = s.temperature;
    const heat = Math.max(0, Math.min(1, (temp - 24) / 21));
    const frost = Math.max(0, Math.min(1, (2 - temp) / 22));
    const thermalScale = 1.0 + heat * 0.42 - frost * 0.18;

    this._updateProxyTransform();
    u.uBoundsMinAndFade.value.set(-half, yMin, -half, 35.0);
    u.uBoundsMaxAndCoverage.value.set(half, yMax, half, Math.min(1.0, s.coverage + heat * 0.08));

    const elevRad = THREE.MathUtils.degToRad(s.sunElevationDeg);
    const azimRad = THREE.MathUtils.degToRad(s.sunAzimuthDeg);
    this._sunDir.set(Math.cos(elevRad) * Math.cos(azimRad), Math.sin(elevRad), Math.cos(elevRad) * Math.sin(azimRad)).normalize();
    u.uSunDirAndElevation.value.set(this._sunDir.x, this._sunDir.y, this._sunDir.z, s.lightningIntensity);

    const c = this._tmpColor.setHex(s.sunColor);
    u.uSunColorAndIntensity.value.set(c.r, c.g, c.b, s.sunIntensity);

    c.setHex(s.skyColor);
    u.uSkyColorAndHaze.value.set(
      Math.min(1, c.r + heat * 0.08 + frost * 0.10),
      Math.min(1, c.g + heat * 0.02 + frost * 0.14),
      Math.min(1, c.b - heat * 0.08 + frost * 0.16),
      0.0001 + s.fogDensity * 0.0022 + heat * 0.00035
    );

    const windAngle = THREE.MathUtils.degToRad(32);
    u.uWindAndTime.value.x = Math.cos(windAngle) * s.windSpeed * thermalScale;
    u.uWindAndTime.value.y = Math.sin(windAngle) * s.windSpeed * thermalScale;
    u.uWindAndTime.value.w = s.extinction;

    u.uCameraPosAndSteps.value.w = s.maxSteps;
    u.uDebugParams.value.set(s.debugMode, s.cloudGenusId, s.rainIntensity, s.densityMultiplier);
    u.uCloudShapeParams.value.set(...s.shapeParams);
    u.uVortexAndTide.value.set(s.tornadoX, s.tornadoZ, Math.min(1.35, s.tornadoStrength * thermalScale), s.waterLevel);
    u.uWorldOriginOffset.value.set(s.originOffsetX, s.originOffsetZ, s.stormTypeId, Math.min(1.35, s.hurricaneStrength * thermalScale));
  }

  getSunDirection() { return this._sunDir; }
  getWeatherMap() { return this.weatherMap; }

  getSharedGroundUniforms() {
    const u = this.material.uniforms;
    return {
      uWeatherMap: u.uWeatherMap,
      uWindAndTime: u.uWindAndTime,
      uBoundsMinAndFade: u.uBoundsMinAndFade,
      uBoundsMaxAndCoverage: u.uBoundsMaxAndCoverage,
      uSunDirAndElevation: u.uSunDirAndElevation,
      uWorldOriginOffset: u.uWorldOriginOffset,
      uTerrainMap: u.uTerrainMap,
      uVortexAndTide: u.uVortexAndTide,
    };
  }

  update(elapsedSeconds, camera) {
    if (!this.material) return;
    const u = this.material.uniforms;
    camera.getWorldDirection(this._cameraForward);
    u.uWindAndTime.value.z = elapsedSeconds;
    u.uCameraPosAndSteps.value.set(camera.position.x, camera.position.y, camera.position.z, this.state.maxSteps);
    u.uCameraForwardAndNear.value.set(this._cameraForward.x, this._cameraForward.y, this._cameraForward.z, camera.near);
    u.uViewportAndFar.value.z = camera.far;
  }

  resize(w, h) {
    if (!this.material) return;
    this.material.uniforms.uViewportAndFar.value.x = w;
    this.material.uniforms.uViewportAndFar.value.y = h;
  }

  beginGpuTimer() {
    if (!this.timerExt || !this.gl) return;
    this._pollGpuQueries();
    if (this.pendingQueries.length < 4) {
      const query = this.gl.createQuery();
      this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query);
      this.pendingQueries.push(query);
    }
  }

  endGpuTimer() {
    if (!this.timerExt || !this.gl || this.pendingQueries.length === 0) return;
    if (this.gl.getQuery(this.timerExt.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) {
      this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    }
  }

  _pollGpuQueries() {
    const disjoint = this.gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
    while (this.pendingQueries.length > 0) {
      const q = this.pendingQueries[0];
      const available = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available && !disjoint) break;
      if (available && !disjoint) {
        this.lastGpuPassMs = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6;
      }
      this.gl.deleteQuery(q);
      this.pendingQueries.shift();
    }
  }

  dispose() {
    this.pendingQueries.length = 0;
    this.macroNoise?.dispose();
    this.detailNoise?.dispose();
    this.weatherMap?.dispose();
    this.blueNoise?.dispose();
    this.terrainMap?.dispose();
    this.material?.dispose();
    this.proxyMesh?.geometry?.dispose();
  }
}
