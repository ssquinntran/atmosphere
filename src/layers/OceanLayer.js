import * as THREE from 'three';
import {
  oceanVertexCommonGLSL,
  oceanVertexNormalGLSL,
  oceanVertexPositionGLSL,
} from '../shaders/ocean.vert.js';
import {
  oceanFragmentCommonGLSL,
  oceanFragmentDitherGLSL,
} from '../shaders/ocean.frag.js';

/**
 * 4-wave directional Gerstner swell spectrum [dirX, dirZ, steepness, wavelength]
 * shared between the GPU vertex shader and CPU sampleWaterSurfaceHeight().
 */
const GERSTNER_WAVES = [
  [0.848, 0.530, 0.34, 62.0],
  [0.574, -0.819, 0.26, 38.0],
  [-0.423, 0.906, 0.20, 23.0],
  [0.966, -0.259, 0.14, 14.0],
];

/**
 * Self-contained WebGL2 / Three.js Gerstner Ocean & Hydrodynamics Layer.
 * Mirrors AtmosphereLayer's lifecycle (init / setHydroState / sampleWaterSurfaceHeight / dispose)
 * with zero per-frame heap allocations.
 */
export class OceanLayer {
  constructor({ sharedCloudUniforms, temperatureUniform, size = 1400, segments = 128 } = {}) {
    this.sharedCloudUniforms = sharedCloudUniforms;
    this.size = size;
    this.segments = segments;

    this.uRainIntensity = { value: 0.0 };
    this.uTemperature = temperatureUniform ?? { value: 18.0 };
    this.uHydroA = { value: new THREE.Vector4(0.0, 280.0, 0.0, 0.0) };
    this.uHydroB = { value: new THREE.Vector4(0.0, -10.0, 0.0, 65.0) };
    this.uTornadoStrength = { value: 0.0 };
    this.uWaveScale = { value: 1.6 };

    this.state = {
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
      waveScale: 1.6,
    };

    this.geometry = null;
    this.material = null;
    this.mesh = null;
  }

  /** Builds the subdivided ocean PlaneGeometry, injects Gerstner/hydro GLSL, and adds to scene. */
  init(scene) {
    this.geometry = new THREE.PlaneGeometry(this.size, this.size, this.segments, this.segments);
    this.geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.MeshStandardMaterial({
      color: 0x072b45,
      roughness: 0.14,
      metalness: 0.35,
    });

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        ...this.sharedCloudUniforms,
        uRainIntensity: this.uRainIntensity,
        uTemperature: this.uTemperature,
        uHydroA: this.uHydroA,
        uHydroB: this.uHydroB,
        uTornadoStrength: this.uTornadoStrength,
        uWaveScale: this.uWaveScale,
      });

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${oceanVertexCommonGLSL}`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${oceanVertexNormalGLSL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${oceanVertexPositionGLSL}`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${oceanFragmentCommonGLSL}`)
        .replace('#include <dithering_fragment>', `${oceanFragmentDitherGLSL}\n#include <dithering_fragment>`);
    };

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    scene.add(this.mesh);
  }

  /** Syncs tidal level, tsunami soliton, whirlpool maelstrom, tornado & hurricane uniforms. */
  setHydroState(hydro) {
    Object.assign(this.state, hydro);
    const s = this.state;
    this.uHydroA.value.set(s.tsunamiStrength, s.tsunamiZ, s.whirlpoolStrength, s.waterLevel);
    this.uHydroB.value.set(s.whirlpoolX, s.whirlpoolZ, s.tornadoX, s.tornadoZ);
    this.uTornadoStrength.value = s.tornadoStrength;
  }

  /** Updates raindrop surface splash ring intensity. */
  setRainIntensity(intensity) {
    this.uRainIntensity.value = intensity;
  }

  /** Scales the 4-wave Gerstner swell amplitude and crest foam (0.5x = calm, 3.2x+ = rough seas). */
  setWaveScale(scale) {
    this.state.waveScale = scale;
    this.uWaveScale.value = scale;
  }

  /**
   * CPU-side mirror of evalOceanDisplacement(): evaluates 4-wave Gerstner swells plus
   * tidal level, tsunami soliton, whirlpool depression, and tornado/hurricane surge at (x, z, elapsed).
   */
  sampleWaterSurfaceHeight(x, z, elapsed) {
    const s = this.state;
    let y = s.waterLevel;

    for (let i = 0; i < GERSTNER_WAVES.length; i++) {
      const [dx, dz, steepness, wavelength] = GERSTNER_WAVES[i];
      const k = 6.2831853 / wavelength;
      const c = Math.sqrt(9.8 / k);
      const a = (steepness / k) * 0.25 * s.waveScale;
      y += a * Math.sin(k * (dx * x + dz * z - c * elapsed));
    }

    if (s.tsunamiStrength > 0.01) {
      const dz = z - s.tsunamiZ;
      y += 26.0 * s.tsunamiStrength * Math.exp(-(dz * dz) / 2312.0) * (1.0 + 0.35 * Math.tanh(-dz * 0.08));
    }

    if (s.whirlpoolStrength > 0.01) {
      const dx = x - s.whirlpoolX;
      const dz = z - s.whirlpoolZ;
      const r2 = dx * dx + dz * dz;
      y -= 15.5 * s.whirlpoolStrength * Math.exp(-r2 / 3872.0);
      y += 1.8 * s.whirlpoolStrength * Math.sin(Math.sqrt(r2) * 0.16 - elapsed * 6.5) * Math.exp(-r2 / 11250.0);
    }

    if (s.tornadoStrength > 0.01) {
      const dx = x - s.tornadoX;
      const dz = z - s.tornadoZ;
      const dr = Math.sqrt(dx * dx + dz * dz) - 24.0;
      y += 2.6 * s.tornadoStrength * Math.exp(-(dr * dr) / 196.0);
    }

    if (s.hurricaneStrength > 0.01) {
      const dx = x - s.tornadoX;
      const dz = z - s.tornadoZ;
      const r2 = dx * dx + dz * dz;
      const r = Math.sqrt(r2);
      const dr = (r - 88.0) / 38.0;
      y += (5.2 * Math.exp(-r2 / 26450.0) + 3.4 * Math.sin(r * 0.11 - elapsed * 5.2) * Math.exp(-(dr * dr))) * s.hurricaneStrength;
    }

    return y;
  }

  /** Releases GPU geometry and material resources. */
  dispose() {
    if (this.geometry) { this.geometry.dispose(); this.geometry = null; }
    if (this.material) { this.material.dispose(); this.material = null; }
    this.mesh = null;
  }
}
