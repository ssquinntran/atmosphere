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

export const WEATHER_PRESETS = {
  tradeWinds: {
    coverage: 0.56,
    baseAltitude: 95,
    slabThickness: 130,
    sunElevationDeg: 28,
    sunAzimuthDeg: 42,
    windSpeed: 14,
    extinction: 0.042,
    sunColor: 0xfff3dc,
    sunIntensity: 3.1,
    skyColor: 0x6ea4d8,
  },
  clearPatrol: {
    coverage: 0.34,
    baseAltitude: 115,
    slabThickness: 110,
    sunElevationDeg: 46,
    sunAzimuthDeg: 35,
    windSpeed: 8,
    extinction: 0.036,
    sunColor: 0xfff8eb,
    sunIntensity: 3.4,
    skyColor: 0x7cb5eb,
  },
  squall: {
    coverage: 0.84,
    baseAltitude: 75,
    slabThickness: 165,
    sunElevationDeg: 14,
    sunAzimuthDeg: 55,
    windSpeed: 28,
    extinction: 0.062,
    sunColor: 0xffc994,
    sunIntensity: 2.3,
    skyColor: 0x4b637d,
  },
};

export class AtmosphereLayer {
  constructor(options = {}) {
    this.mapExtent = options.mapExtent ?? 1200; // [-600, 600] in X and Z
    this.state = {
      ...WEATHER_PRESETS.tradeWinds,
      maxSteps: options.maxSteps ?? 36,
      debugMode: options.debugMode ?? DEBUG_MODES.final,
      originOffsetX: 0,
      originOffsetZ: 0,
    };

    this.macroNoise = null;
    this.detailNoise = null;
    this.weatherMap = null;
    this.blueNoise = null;
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
        uSkyColorAndHaze: { value: new THREE.Vector4(0.43, 0.64, 0.85, 0.00085) },
        uWindAndTime: { value: new THREE.Vector4(10.0, 6.0, 0.0, this.state.extinction) },
        uCameraPosAndSteps: { value: new THREE.Vector4(0, 180, 320, this.state.maxSteps) },
        uCameraForwardAndNear: { value: new THREE.Vector4(0, -0.4, -0.9, 1.0) },
        uViewportAndFar: { value: new THREE.Vector4(1280, 720, 4000.0, 0.24) },
        uDebugParams: { value: new THREE.Vector4(this.state.debugMode, 0.0, 0.0, 0.0) },
        uWorldOriginOffset: {
          value: new THREE.Vector4(this.state.originOffsetX, this.state.originOffsetZ, 0.0, 0.0),
        },
        uMacroNoise: { value: this.macroNoise },
        uDetailNoise: { value: this.detailNoise },
        uWeatherMap: { value: this.weatherMap },
        uBlueNoise: { value: this.blueNoise },
        uSceneDepth: { value: null },
      },
    });

    // Unit cube scaled and positioned dynamically to match [yMin, yMax]
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

    // Bake 64³ macro Perlin-Worley + 32³ Worley detail erosion textures on GPU
    this.macroNoise = CloudNoiseBaker.bakeVolumeTexture(renderer, 64, 8, 4.0);
    this.detailNoise = CloudNoiseBaker.bakeVolumeTexture(renderer, 32, 8, 6.0);
    this.weatherMap = CloudNoiseBaker.createWeatherMap(256);
    this.blueNoise = CloudNoiseBaker.createBlueNoiseJitter(64);
  }

  /**
   * Releases invalidated WebGL query and texture handles when the browser signals
   * a GPU context loss event (e.g., driver reset or background tab reclamation).
   */
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

  /**
   * Re-bakes GPU 3D noise volumes and flags the custom shader program for recompilation
   * once WebGL2 context restoration completes.
   */
  onContextRestored(renderer) {
    this._initGpuResources(renderer);

    if (this.material) {
      this.material.uniforms.uMacroNoise.value = this.macroNoise;
      this.material.uniforms.uDetailNoise.value = this.detailNoise;
      this.material.uniforms.uWeatherMap.value = this.weatherMap;
      this.material.uniforms.uBlueNoise.value = this.blueNoise;
      this.material.needsUpdate = true;
      this._syncBoundsAndLighting();
    }
  }

  /**
   * Shifts Relative-To-Center (RTC) world-space coordinates (in meters) so multi-kilometer
   * map pans stay centered near the local float32 origin without precision jitter.
   */
  setWorldOriginOffset(offsetX, offsetZ) {
    this.state.originOffsetX = offsetX;
    this.state.originOffsetZ = offsetZ;
    if (this.material) {
      this.material.uniforms.uWorldOriginOffset.value.set(offsetX, offsetZ, 0.0, 0.0);
    }
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

  applyPreset(presetName) {
    const preset = WEATHER_PRESETS[presetName];
    if (!preset) return;
    Object.assign(this.state, preset);
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

    this.proxyMesh.scale.set(this.mapExtent, this.state.slabThickness, this.mapExtent);
    this.proxyMesh.position.set(0, yMin + this.state.slabThickness * 0.5, 0);

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
      0.00085
    );

    const windAngle = THREE.MathUtils.degToRad(32);
    this.material.uniforms.uWindAndTime.value.x = Math.cos(windAngle) * this.state.windSpeed;
    this.material.uniforms.uWindAndTime.value.y = Math.sin(windAngle) * this.state.windSpeed;
    this.material.uniforms.uWindAndTime.value.w = this.state.extinction;

    this.material.uniforms.uCameraPosAndSteps.value.w = this.state.maxSteps;
    this.material.uniforms.uDebugParams.value.x = this.state.debugMode;
    this.material.uniforms.uWorldOriginOffset.value.set(
      this.state.originOffsetX,
      this.state.originOffsetZ,
      0.0,
      0.0
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
    this.proxyMesh?.geometry.dispose();
    this.material?.dispose();
  }
}
