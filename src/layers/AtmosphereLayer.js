import * as THREE from 'three';
import { atmosphereVertexShader } from '../shaders/atmosphere.vert.js';
import { atmosphereFragmentShader } from '../shaders/atmosphere.frag.js';
import { CloudNoiseBaker } from '../noise/CloudNoiseBaker.js';

export const DEBUG_MODES = {
  final: 0,
  transmittance: 1,
  depth: 2,
  noise: 3,
};

/**
 * All 10 WMO Cloud Genera (World Meteorological Organization International Cloud Atlas):
 * Low-étage:    0 Cumulus (Cu), 1 Stratus (St), 2 Stratocumulus (Sc)
 * Middle-étage: 3 Altocumulus (Ac), 4 Altostratus (As), 5 Nimbostratus (Ns)
 * High-étage:   6 Cirrus (Ci), 7 Cirrocumulus (Cc), 8 Cirrostratus (Cs)
 * Towering:     9 Cumulonimbus (Cb)
 */
export const CLOUD_GENERA = {
  cumulus: {
    id: 0,
    name: 'Cumulus (Cu)',
    etage: 'Low (90–260 m)',
    description: 'Detached, dense cauliflower towers with crisp flat bases and sunlit domes.',
    coverage: 0.64,
    baseAltitude: 92,
    slabThickness: 165,
    extinction: 0.088,
    densityMultiplier: 1.65,
    rainIntensity: 0.0,
    shapeParams: [1.05, 0.95, 0.92, 0.08],
  },
  stratus: {
    id: 1,
    name: 'Stratus (St)',
    etage: 'Low (55–140 m)',
    description: 'Uniform, featureless gray horizontal cloud layer hugging the lower atmosphere.',
    coverage: 0.86,
    baseAltitude: 58,
    slabThickness: 85,
    extinction: 0.072,
    densityMultiplier: 1.45,
    rainIntensity: 0.18,
    shapeParams: [0.52, 1.85, 0.15, 0.02],
  },
  stratocumulus: {
    id: 2,
    name: 'Stratocumulus (Sc)',
    etage: 'Low (80–200 m)',
    description: 'Low, lumpy honeycomb cloud rolls and rounded patches with bright sky breaks.',
    coverage: 0.72,
    baseAltitude: 82,
    slabThickness: 120,
    extinction: 0.082,
    densityMultiplier: 1.55,
    rainIntensity: 0.0,
    shapeParams: [0.92, 1.35, 0.78, 0.05],
  },
  altocumulus: {
    id: 3,
    name: 'Altocumulus (Ac)',
    etage: 'Middle (155–265 m)',
    description: 'Mid-altitude "mackerel sky" rippled cellular puffs and patchy wave bands.',
    coverage: 0.62,
    baseAltitude: 155,
    slabThickness: 110,
    extinction: 0.078,
    densityMultiplier: 1.55,
    rainIntensity: 0.0,
    shapeParams: [1.65, 1.45, 0.95, 0.12],
  },
  altostratus: {
    id: 4,
    name: 'Altostratus (As)',
    etage: 'Middle (145–270 m)',
    description: 'Mid-altitude fibrous blue-gray sheet covering the sky with diffused sunlight.',
    coverage: 0.84,
    baseAltitude: 145,
    slabThickness: 125,
    extinction: 0.068,
    densityMultiplier: 1.42,
    rainIntensity: 0.12,
    shapeParams: [0.58, 1.65, 0.25, 0.18],
  },
  nimbostratus: {
    id: 5,
    name: 'Nimbostratus (Ns)',
    etage: 'Low–Middle (65–275 m)',
    description: 'Dark, thick, widespread storm layer producing steady continuous rain.',
    coverage: 0.92,
    baseAltitude: 65,
    slabThickness: 210,
    extinction: 0.105,
    densityMultiplier: 1.85,
    rainIntensity: 0.85,
    shapeParams: [0.75, 0.85, 0.45, 0.22],
  },
  cirrus: {
    id: 6,
    name: 'Cirrus (Ci)',
    etage: 'High (235–325 m)',
    description: 'High-altitude delicate white ice-crystal filaments and wind-sheared mares\' tails.',
    coverage: 0.56,
    baseAltitude: 235,
    slabThickness: 90,
    extinction: 0.054,
    densityMultiplier: 1.55,
    rainIntensity: 0.0,
    shapeParams: [1.35, 2.2, 0.38, 1.45],
  },
  cirrocumulus: {
    id: 7,
    name: 'Cirrocumulus (Cc)',
    etage: 'High (230–310 m)',
    description: 'High-altitude thin white grain-like ice ripples arranged in fine honeycomb rows.',
    coverage: 0.58,
    baseAltitude: 230,
    slabThickness: 80,
    extinction: 0.064,
    densityMultiplier: 1.60,
    rainIntensity: 0.0,
    shapeParams: [2.35, 2.1, 0.98, 0.35],
  },
  cirrostratus: {
    id: 8,
    name: 'Cirrostratus (Cs)',
    etage: 'High (220–315 m)',
    description: 'High, translucent silky ice-crystal veil covering the upper sky dome.',
    coverage: 0.80,
    baseAltitude: 220,
    slabThickness: 95,
    extinction: 0.048,
    densityMultiplier: 1.35,
    rainIntensity: 0.0,
    shapeParams: [0.65, 2.0, 0.20, 0.65],
  },
  cumulonimbus: {
    id: 9,
    name: 'Cumulonimbus (Cb)',
    etage: 'Towering (68–368 m)',
    description: 'Massive vertical thunderhead tower with a spreading upper anvil and heavy rain.',
    coverage: 0.78,
    baseAltitude: 68,
    slabThickness: 300,
    extinction: 0.112,
    densityMultiplier: 1.95,
    rainIntensity: 0.95,
    shapeParams: [0.95, 0.62, 0.94, 0.48],
  },
};

export const STORM_TYPES = {
  none: {
    id: 0,
    name: 'Fair Weather (No Cyclone)',
    description: 'Calm maritime trade winds with no active cyclonic vortex or squall front.',
    cloudGenus: 'cumulus',
    coverage: 0.65,
    windSpeed: 14,
    rainIntensity: 0.0,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.0,
    sunElevationDeg: 32,
    sunColor: 0xfff5e0,
    sunIntensity: 3.6,
    skyColor: 0x4f86c6,
  },
  waterspout: {
    id: 1,
    name: 'Maritime Waterspout (Rankine Tube)',
    description: 'Slender translucent columnar Rankine vortex tube connecting cumulus base to a sea-spray ring.',
    cloudGenus: 'cumulonimbus',
    coverage: 0.76,
    windSpeed: 22,
    rainIntensity: 0.48,
    tornadoStrength: 0.72,
    hurricaneStrength: 0.0,
    sunElevationDeg: 24,
    sunColor: 0xffe2b8,
    sunIntensity: 3.0,
    skyColor: 0x43668a,
  },
  supercellTornado: {
    id: 2,
    name: 'EF5 Supercell Wedge Tornado',
    description: 'Massive wedge-shaped mesocyclone Rankine vortex with rotating wall cloud, internal lightning, and debris suction.',
    cloudGenus: 'cumulonimbus',
    coverage: 0.88,
    windSpeed: 30,
    rainIntensity: 0.92,
    tornadoStrength: 0.95,
    hurricaneStrength: 0.0,
    sunElevationDeg: 15,
    sunColor: 0xffc994,
    sunIntensity: 2.5,
    skyColor: 0x35485e,
  },
  hurricane: {
    id: 3,
    name: 'Category 5 Hurricane (Eyewall + Spiral Bands)',
    description: 'Synoptic tropical cyclone with a calm clear low-pressure eye, towering stadium eyewall, 4 spiral rainbands, and storm surge.',
    cloudGenus: 'cumulonimbus',
    coverage: 0.94,
    windSpeed: 38,
    rainIntensity: 0.96,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.95,
    sunElevationDeg: 18,
    sunColor: 0xffd7b0,
    sunIntensity: 2.4,
    skyColor: 0x2d4359,
  },
  derecho: {
    id: 4,
    name: 'Derecho Squall Line (Arcus Shelf Cloud)',
    description: 'Bowed linear convective squall front with a low turbulent arcus roll cloud, 36 m/s straight-line gale winds, and sheet lightning.',
    cloudGenus: 'cumulonimbus',
    coverage: 0.86,
    windSpeed: 36,
    rainIntensity: 0.88,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.82,
    sunElevationDeg: 14,
    sunColor: 0xffbe85,
    sunIntensity: 2.4,
    skyColor: 0x314559,
  },
  norEaster: {
    id: 5,
    name: "Nor'easter Bomb Cyclone (Comma-Head)",
    description: 'Deep baroclinic comma-head cyclone with dense nimbostratus gale bands, silver-slate polar lighting, and freezing sea spray.',
    cloudGenus: 'nimbostratus',
    coverage: 0.92,
    windSpeed: 33,
    rainIntensity: 0.86,
    tornadoStrength: 0.35,
    hurricaneStrength: 0.88,
    sunElevationDeg: 12,
    sunColor: 0xdbeafe,
    sunIntensity: 2.3,
    skyColor: 0x2c4257,
  },
};

export const WEATHER_PRESETS = {
  tradeWinds: {
    stormType: 'none',
    stormTypeId: 0,
    cloudGenus: 'cumulus',
    coverage: 0.65,
    baseAltitude: 92,
    slabThickness: 165,
    sunElevationDeg: 32,
    sunAzimuthDeg: 42,
    windSpeed: 14,
    extinction: 0.088,
    densityMultiplier: 1.68,
    rainIntensity: 0.0,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.0,
    sunColor: 0xfff5e0,
    sunIntensity: 3.6,
    skyColor: 0x4f86c6,
  },
  clearPatrol: {
    stormType: 'none',
    stormTypeId: 0,
    cloudGenus: 'cirrus',
    coverage: 0.54,
    baseAltitude: 230,
    slabThickness: 90,
    sunElevationDeg: 45,
    sunAzimuthDeg: 35,
    windSpeed: 18,
    extinction: 0.058,
    densityMultiplier: 1.55,
    rainIntensity: 0.0,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.0,
    sunColor: 0xfff9ed,
    sunIntensity: 3.8,
    skyColor: 0x5692d6,
  },
  squall: {
    stormType: 'supercellTornado',
    stormTypeId: 2,
    cloudGenus: 'cumulonimbus',
    coverage: 0.86,
    baseAltitude: 68,
    slabThickness: 290,
    sunElevationDeg: 16,
    sunAzimuthDeg: 55,
    windSpeed: 28,
    extinction: 0.110,
    densityMultiplier: 1.92,
    rainIntensity: 0.92,
    tornadoStrength: 0.85,
    hurricaneStrength: 0.0,
    sunColor: 0xffc994,
    sunIntensity: 2.6,
    skyColor: 0x3b5068,
  },
  hurricane: {
    stormType: 'hurricane',
    stormTypeId: 3,
    cloudGenus: 'cumulonimbus',
    coverage: 0.94,
    baseAltitude: 64,
    slabThickness: 305,
    sunElevationDeg: 18,
    sunAzimuthDeg: 48,
    windSpeed: 38,
    extinction: 0.115,
    densityMultiplier: 1.98,
    rainIntensity: 0.96,
    tornadoStrength: 0.0,
    hurricaneStrength: 0.95,
    sunColor: 0xffd7b0,
    sunIntensity: 2.4,
    skyColor: 0x2d4359,
  },
};

export class AtmosphereLayer {
  constructor(options = {}) {
    this.mapExtent = options.mapExtent ?? 1200; // [-600, 600] in X and Z
    const defaultGenus = CLOUD_GENERA.cumulus;
    this.state = {
      ...WEATHER_PRESETS.tradeWinds,
      cloudGenus: 'cumulus',
      cloudGenusId: defaultGenus.id,
      shapeParams: [...defaultGenus.shapeParams],
      maxSteps: options.maxSteps ?? 48,
      debugMode: options.debugMode ?? DEBUG_MODES.final,
      originOffsetX: 0,
      originOffsetZ: 0,
      tornadoX: 0.0,
      tornadoZ: 45.0,
      tornadoStrength: 0.0,
      hurricaneStrength: 0.0,
      stormType: 'none',
      stormTypeId: 0,
      waterLevel: 0.0,
    };

    this.macroNoise = null;
    this.detailNoise = null;
    this.weatherMap = null;
    this.blueNoise = null;
    this.terrainMap = null;
    this.material = null;
    this.proxyMesh = null;

    // Isolated GPU timer query state (EXT_disjoint_timer_query_webgl2)
    this.gl = null;
    this.timerExt = null;
    this.pendingQueries = [];
    this.lastGpuPassMs = null;

    this._cameraForward = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
  }

  init(renderer, scene) {
    this._initGpuResources(renderer);

    const halfExtent = this.mapExtent * 0.5;
    const yMin = this.state.baseAltitude;
    const yMax = yMin + this.state.slabThickness;

    if (!this.terrainMap) {
      const emptyData = new Uint8Array(4 * 4 * 4);
      for (let i = 0; i < 16; i++) {
        emptyData[i * 4] = 0;
        emptyData[i * 4 + 1] = 128;
        emptyData[i * 4 + 2] = 128;
        emptyData[i * 4 + 3] = 0;
      }
      this.terrainMap = new THREE.DataTexture(emptyData, 4, 4, THREE.RGBAFormat);
      this.terrainMap.needsUpdate = true;
    }

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBoundsMinAndFade: { value: new THREE.Vector4(-halfExtent, yMin, -halfExtent, 35.0) },
        uBoundsMaxAndCoverage: { value: new THREE.Vector4(halfExtent, yMax, halfExtent, this.state.coverage) },
        uSunDirAndElevation: { value: new THREE.Vector4(0.6, 0.5, 0.6, 0.5) },
        uSunColorAndIntensity: { value: new THREE.Vector4(1.0, 0.95, 0.86, this.state.sunIntensity) },
        uSkyColorAndHaze: { value: new THREE.Vector4(0.31, 0.53, 0.78, 0.00055) },
        uWindAndTime: { value: new THREE.Vector4(10.0, 6.0, 0.0, this.state.extinction) },
        uCameraPosAndSteps: { value: new THREE.Vector4(0, 180, 320, this.state.maxSteps) },
        uCameraForwardAndNear: { value: new THREE.Vector4(0, -0.4, -0.9, 1.0) },
        uViewportAndFar: { value: new THREE.Vector4(1280, 720, 4000.0, 0.28) },
        uDebugParams: {
          value: new THREE.Vector4(
            this.state.debugMode,
            this.state.cloudGenusId,
            this.state.rainIntensity,
            this.state.densityMultiplier
          ),
        },
        uWorldOriginOffset: {
          value: new THREE.Vector4(this.state.originOffsetX, this.state.originOffsetZ, 0.0, 0.0),
        },
        uCloudShapeParams: {
          value: new THREE.Vector4(...this.state.shapeParams),
        },
        uVortexAndTide: {
          value: new THREE.Vector4(
            this.state.tornadoX,
            this.state.tornadoZ,
            this.state.tornadoStrength,
            this.state.waterLevel
          ),
        },
        uMacroNoise: { value: this.macroNoise },
        uDetailNoise: { value: this.detailNoise },
        uWeatherMap: { value: this.weatherMap },
        uBlueNoise: { value: this.blueNoise },
        uTerrainMap: { value: this.terrainMap },
        uSceneDepth: { value: null },
      },
    });

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.proxyMesh = new THREE.Mesh(boxGeo, this.material);
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

    this.macroNoise = null;
    this.detailNoise = null;
    this.weatherMap = null;
    this.blueNoise = null;
  }

  onContextRestored(renderer) {
    this._initGpuResources(renderer);

    if (this.material) {
      this.material.uniforms.uMacroNoise.value = this.macroNoise;
      this.material.uniforms.uDetailNoise.value = this.detailNoise;
      this.material.uniforms.uWeatherMap.value = this.weatherMap;
      this.material.uniforms.uBlueNoise.value = this.blueNoise;
      this.material.uniforms.uTerrainMap.value = this.terrainMap;
      this.material.needsUpdate = true;
      this._syncBoundsAndLighting();
    }
  }

  setTerrainMap(terrainTexture) {
    this.terrainMap = terrainTexture;
    if (this.material) {
      this.material.uniforms.uTerrainMap.value = terrainTexture;
    }
  }

  setVortexAndTide(tornadoX, tornadoZ, tornadoStrength, waterLevel) {
    this.state.tornadoX = tornadoX;
    this.state.tornadoZ = tornadoZ;
    this.state.tornadoStrength = tornadoStrength;
    this.state.waterLevel = waterLevel;
    if (this.material) {
      this.material.uniforms.uVortexAndTide.value.set(
        tornadoX,
        tornadoZ,
        tornadoStrength,
        waterLevel
      );
      const halfExtent = this.mapExtent * 0.5;
      const yMin = this.state.baseAltitude;
      const yMax = yMin + this.state.slabThickness;
      const hasSubCloud = this.state.rainIntensity > 0.01 || tornadoStrength > 0.01;
      const proxyMinY = hasSubCloud ? Math.min(waterLevel, 0.0) : yMin;
      const proxyMaxY = yMax + 65.0;
      const proxyHeight = proxyMaxY - proxyMinY;
      this.proxyMesh.scale.set(this.mapExtent, proxyHeight, this.mapExtent);
      this.proxyMesh.position.set(0, proxyMinY + proxyHeight * 0.5, 0);
    }
  }

  setWorldOriginOffset(offsetX, offsetZ) {
    this.state.originOffsetX = offsetX;
    this.state.originOffsetZ = offsetZ;
    if (this.material) {
      this.material.uniforms.uWorldOriginOffset.value.set(
        offsetX,
        offsetZ,
        this.state.stormTypeId,
        this.state.hurricaneStrength
      );
    }
  }

  setStormType(stormKey) {
    const storm = STORM_TYPES[stormKey];
    if (!storm) return;
    const genus = CLOUD_GENERA[storm.cloudGenus];
    this.state.stormType = stormKey;
    this.state.stormTypeId = storm.id;
    this.state.cloudGenus = storm.cloudGenus;
    this.state.cloudGenusId = genus.id;
    this.state.coverage = storm.coverage;
    this.state.baseAltitude = genus.baseAltitude;
    this.state.slabThickness = genus.slabThickness;
    this.state.extinction = genus.extinction;
    this.state.densityMultiplier = genus.densityMultiplier;
    this.state.rainIntensity = storm.rainIntensity;
    this.state.tornadoStrength = storm.tornadoStrength;
    this.state.hurricaneStrength = storm.hurricaneStrength;
    this.state.windSpeed = storm.windSpeed;
    this.state.sunElevationDeg = storm.sunElevationDeg;
    this.state.sunColor = storm.sunColor;
    this.state.sunIntensity = storm.sunIntensity;
    this.state.skyColor = storm.skyColor;
    this.state.shapeParams = [...genus.shapeParams];
    this._syncBoundsAndLighting();
  }
  setSceneDepthTexture(depthTexture) {
    if (this.material) {
      this.material.uniforms.uSceneDepth.value = depthTexture;
    }
  }

  setDebugMode(mode) {
    const modeId = typeof mode === 'string' ? (DEBUG_MODES[mode] ?? 0) : Number(mode) || 0;
    this.state.debugMode = Math.min(Math.max(Math.round(modeId), 0), 3);
    if (this.material) {
      this.material.uniforms.uDebugParams.value.x = this.state.debugMode;
    }
  }

  setCloudGenus(genusKey) {
    const genus = CLOUD_GENERA[genusKey];
    if (!genus) return;
    this.state.cloudGenus = genusKey;
    this.state.cloudGenusId = genus.id;
    this.state.coverage = genus.coverage;
    this.state.baseAltitude = genus.baseAltitude;
    this.state.slabThickness = genus.slabThickness;
    this.state.extinction = genus.extinction;
    this.state.densityMultiplier = genus.densityMultiplier;
    this.state.rainIntensity = genus.rainIntensity;
    this.state.shapeParams = [...genus.shapeParams];

    if (genusKey === 'nimbostratus' || genusKey === 'cumulonimbus') {
      this.state.skyColor = 0x3b5068;
      this.state.sunIntensity = 2.6;
    } else if (genusKey === 'stratus' || genusKey === 'altostratus') {
      this.state.skyColor = 0x516e8c;
      this.state.sunIntensity = 3.0;
    } else {
      this.state.skyColor = 0x4f86c6;
      this.state.sunIntensity = 3.6;
    }

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

    const halfExtent = this.mapExtent * 0.5;
    const yMin = this.state.baseAltitude;
    const yMax = yMin + this.state.slabThickness;

    const hasSubCloud = this.state.rainIntensity > 0.01 || this.state.tornadoStrength > 0.01;
    const proxyMinY = hasSubCloud ? Math.min(this.state.waterLevel, 0.0) : yMin;
    const proxyMaxY = yMax + 65.0;
    const proxyHeight = proxyMaxY - proxyMinY;
    this.proxyMesh.scale.set(this.mapExtent, proxyHeight, this.mapExtent);
    this.proxyMesh.position.set(0, proxyMinY + proxyHeight * 0.5, 0);

    this.material.uniforms.uBoundsMinAndFade.value.set(-halfExtent, yMin, -halfExtent, 35.0);
    this.material.uniforms.uBoundsMaxAndCoverage.value.set(
      halfExtent,
      yMax,
      halfExtent,
      this.state.coverage
    );

    const elevRad = THREE.MathUtils.degToRad(this.state.sunElevationDeg);
    const azimRad = THREE.MathUtils.degToRad(this.state.sunAzimuthDeg);
    this._sunDir
      .set(
        Math.cos(elevRad) * Math.cos(azimRad),
        Math.sin(elevRad),
        Math.cos(elevRad) * Math.sin(azimRad)
      )
      .normalize();

    this.material.uniforms.uSunDirAndElevation.value.set(
      this._sunDir.x,
      this._sunDir.y,
      this._sunDir.z,
      Math.sin(elevRad)
    );

    const sunCol = new THREE.Color(this.state.sunColor);
    this.material.uniforms.uSunColorAndIntensity.value.set(
      sunCol.r,
      sunCol.g,
      sunCol.b,
      this.state.sunIntensity
    );

    const skyCol = new THREE.Color(this.state.skyColor);
    this.material.uniforms.uSkyColorAndHaze.value.set(
      skyCol.r,
      skyCol.g,
      skyCol.b,
      0.00055
    );

    const windAngle = THREE.MathUtils.degToRad(32);
    this.material.uniforms.uWindAndTime.value.x = Math.cos(windAngle) * this.state.windSpeed;
    this.material.uniforms.uWindAndTime.value.y = Math.sin(windAngle) * this.state.windSpeed;
    this.material.uniforms.uWindAndTime.value.w = this.state.extinction;

    this.material.uniforms.uCameraPosAndSteps.value.w = this.state.maxSteps;
    this.material.uniforms.uDebugParams.value.set(
      this.state.debugMode,
      this.state.cloudGenusId,
      this.state.rainIntensity,
      this.state.densityMultiplier
    );
    this.material.uniforms.uCloudShapeParams.value.set(...this.state.shapeParams);
    this.material.uniforms.uVortexAndTide.value.set(
      this.state.tornadoX,
      this.state.tornadoZ,
      this.state.tornadoStrength,
      this.state.waterLevel
    );
    this.material.uniforms.uWorldOriginOffset.value.set(
      this.state.originOffsetX,
      this.state.originOffsetZ,
      this.state.stormTypeId,
      this.state.hurricaneStrength
    );
  }

  getSunDirection() {
    return this._sunDir;
  }

  getWeatherMap() {
    return this.weatherMap;
  }

  getSharedGroundUniforms() {
    return {
      uWeatherMap: this.material.uniforms.uWeatherMap,
      uWindAndTime: this.material.uniforms.uWindAndTime,
      uBoundsMinAndFade: this.material.uniforms.uBoundsMinAndFade,
      uBoundsMaxAndCoverage: this.material.uniforms.uBoundsMaxAndCoverage,
      uSunDirAndElevation: this.material.uniforms.uSunDirAndElevation,
      uWorldOriginOffset: this.material.uniforms.uWorldOriginOffset,
      uTerrainMap: this.material.uniforms.uTerrainMap,
      uVortexAndTide: this.material.uniforms.uVortexAndTide,
    };
  }

  update(elapsedSeconds, camera) {
    if (!this.material) return;

    camera.getWorldDirection(this._cameraForward);

    this.material.uniforms.uWindAndTime.value.z = elapsedSeconds;
    this.material.uniforms.uCameraPosAndSteps.value.set(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      this.state.maxSteps
    );
    this.material.uniforms.uCameraForwardAndNear.value.set(
      this._cameraForward.x,
      this._cameraForward.y,
      this._cameraForward.z,
      camera.near
    );
    this.material.uniforms.uViewportAndFar.value.z = camera.far;
  }

  resize(drawingBufferWidth, drawingBufferHeight) {
    if (!this.material) return;
    this.material.uniforms.uViewportAndFar.value.x = drawingBufferWidth;
    this.material.uniforms.uViewportAndFar.value.y = drawingBufferHeight;
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
        const ns = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT);
        this.lastGpuPassMs = ns / 1e6;
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
    this.proxyMesh?.geometry.dispose();
    this.material?.dispose();
  }
}
