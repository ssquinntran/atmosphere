# atmosphere
Simulation of atmosphere layer such as clouds

# Volumetric Cloud & Atmosphere Layer (WebGL2 / Three.js)

A real-time, map-native volumetric cloud layer built with **Three.js** and custom **GLSL (`#version 300 es`)** vertex and fragment shaders. Designed for 3D geospatial and maritime operational viewports, the layer renders physically inspired cumulus formations inside a world-space altitude slab with analytical ray-box intersection, depth-buffer terrain compositing, and deterministic frame-budget controls.

> **Live Demo:** `[Insert GitHub Pages / Vercel URL]`

---

## Quickstart

Zero external build dependencies beyond Node.js (v18+).

```bash
git clone [https://github.com/](https://github.com/)<your-username>/<repo-name>.git
cd <repo-name>
npm install
npm run dev
```

To generate a static production bundle:

```bash
npm run build && npm run preview
```

---

## 1. Architectural Goals

1. **Map-Camera Rigor:** Support arbitrary camera pitch, zoom, and altitude—including flying *above*, *through*, or *beneath* the cloud deck—without near-plane polygon clipping or parallax drift.
2. **Deterministic 60 FPS Frame Budget:** Keep volumetric fragment costs predictable on integrated and mid-tier laptop GPUs via pre-baked 3D noise textures, blue-noise step jittering, and adaptive step strides.
3. **Composable Layer Lifecycle:** Decouple atmospheric rendering from host scene management through an explicit `AtmosphereLayer` interface (`init`, `update`, `setEnvironment`, `resize`, `dispose`).
4. **WebGL2 → WebGPU Data Parity:** Structure uniforms in `std140`-aligned Uniform Buffer Objects (UBOs) and channel-packed textures so shader bindings map cleanly to WebGPU `GPUBuffer` and `compute` pipelines.

---

## 2. System Architecture & Render Pipeline

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. STARTUP / ONE-TIME BAKE PASS (CPU / Offscreen FBO)                        │
│    ├── 3D Noise Volume   : 128³ RGBA8 Data3DTexture (Perlin-Worley + FBM)    │
│    ├── Weather Map       : 512² RG8 DataTexture (Coverage + Cloud Type)      │
│    └── Blue-Noise Jitter : 64² R8 Tileable Texture (Anti-banding offset)     │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Bound once to AtmosphereUBO / Samplers
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 2. BASE GEOSPATIAL SCENE PASS (Offscreen WebGLRenderTarget)                  │
│    ├── Renders 3D ocean/coastal terrain tile + surface vessel markers        │
│    └── Outputs Color Buffer + Hardware DepthTexture (DepthFormat / Uint32)   │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ uSceneDepth
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 3. VOLUMETRIC ATMOSPHERE PASS (Custom Vertex + Fragment Shaders)             │
│    ├── Proxy Geometry : World-space bounding slab [yMin, yMax] (BackSide)    │
│    ├── Vertex Shader  : Emits world-space ray origin & proxy surface pos     │
│    └── Fragment Shader: Ray-AABB intersect → Depth clamp → Adaptive March    │
│                         → Beer-Lambert + Henyey-Greenstein scattering        │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Premultiplied Alpha Composite
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 4. TELEMETRY & ADAPTIVE QUALITY CONTROLLER                                   │
│    └── Tracks rolling frame time (ms) & dynamically scales step budget       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Repository Structure

```text
├── index.html                    # Entry viewport + minimal HUD & telemetry overlay
├── src/
│   ├── main.js                   # Three.js renderer, OrbitControls, maritime tile scene
│   ├── layers/
│   │   └── AtmosphereLayer.js    # Self-contained volumetric cloud layer & UBO manager
│   ├── noise/
│   │   └── CloudNoiseBaker.js    # Tileable 3D Perlin-Worley FBM & blue-noise generator
│   └── shaders/
│       ├── atmosphere.vert.glsl  # World-space ray setup & bounding slab projection
│       └── atmosphere.frag.glsl  # Ray-AABB intersection, depth fade, lighting march
└── README.md
```

---

## 3. Shader & Mathematical Design

### 3.1 Vertex Shader (`atmosphere.vert.glsl`)
The proxy mesh is an axis-aligned bounding box spanning the map tile horizontally and `[uCloudMinY, uCloudMaxY]` vertically, rendered with `THREE.BackSide` and `depthTest: false`. Rendering back faces ensures the shader continues executing when the camera enters the cloud volume.

* Transforms proxy vertices into clip space while forwarding world-space position (`vWorldPos`) and screen-space UVs (`vScreenUv`) to the fragment stage.
* Passes `uCameraPos` via UBO so view-ray directions (`normalize(vWorldPos - uCameraPos)`) require zero per-fragment matrix inversions.

### 3.2 Analytical Ray-Slab Intersection & Depth Compositing (`atmosphere.frag.glsl`)
For each fragment, the ray $\mathbf{r}(t) = \mathbf{o} + t\mathbf{d}$ is intersected against the cloud slab AABB $[\mathbf{b}_{\min}, \mathbf{b}_{\max}]$:

```glsl
vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir, vec3 boxMin, vec3 boxMax) {
    vec3 t0 = (boxMin - rayOrigin) / rayDir;
    vec3 t1 = (boxMax - rayOrigin) / rayDir;
    vec3 tsmaller = min(t0, t1);
    vec3 tbigger  = max(t0, t1);
    float tNear = max(max(tsmaller.x, tsmaller.y), max(tsmaller.z, 0.0));
    float tFar  = min(min(tbigger.x, tbigger.y), tbigger.z);
    return vec2(tNear, tFar);
}
```

* **Early Exit:** Rays with `tNear >= tFar` discard immediately without sampling 3D textures.
* **Terrain & Marker Occlusion:** The hardware depth buffer (`uSceneDepth`) is linearized to world-ray distance $t_{\text{scene}}$, clamping `tFar = min(tFar, tScene)`. A soft depth-feather factor smoothly attenuates cloud density within 40 meters of coastal terrain or surface markers, eliminating hard intersection seams.

### 3.3 Channel-Packed 3D Noise & Density Field
Evaluating multi-octave 3D procedural noise inside a raymarch loop is prohibitively expensive in WebGL2. Instead, a tileable $128^3$ `RGBA8` `Data3DTexture` is generated once at initialization:

| Channel | Signal | Role in Density Field |
| :--- | :--- | :--- |
| **R** | Low-frequency Perlin-Worley FBM | Defines macro cumulus silhouettes and puffiness |
| **G** | Medium-frequency Worley FBM | Erodes large cloud edges into billowing lobes |
| **B** | High-frequency Worley FBM | Carves fine turbulent wisps at cloud boundaries |
| **A** | Vertical anvil / height bias | Shapes flat condensation bases and rounded tops |

At sample position $\mathbf{p}$, base density is sculpted by a normalized altitude gradient $h \in [0, 1]$ (rounded bottom ramp + tapered top anvil), modulated by the 2D weather coverage map (`uCoverage`) and wind advection (`uWindDir * uTime`), then eroded using the `G` and `B` channels only near cloud perimeters (`density > 0.0`) to avoid wasted texture reads in empty air.

### 3.4 Adaptive Raymarching & Lighting Model
* **Blue-Noise Jitter:** The starting ray offset $t_{\text{start}} = t_{\text{near}} + \Delta s \cdot \text{texelFetch}(uBlueNoise, \text{fragCoord} \bmod 64, 0).r$ converts structured step-banding into imperceptible high-frequency grain at just **32–48 primary steps**.
* **Adaptive Stride:** Rays march with a `2.0x` coarse stride while `density == 0.0`; upon encountering non-zero density, the ray steps back one coarse increment and switches to fine `1.0x` integration.
* **Scattering & Extinction:**
  * **Primary Transmittance (Beer-Lambert Law):** $T_i = \exp(-\sigma_e \cdot \rho(\mathbf{p}_i) \cdot \Delta s)$
  * **Self-Shadowing Light March:** A 4-step secondary march toward `uSunDir` accumulates optical depth $\tau_{\text{sun}}$, modulated by an empirical powder-sugar edge term $(1 - \exp(-2\tau_{\text{sun}}))$ to preserve crisp dark creases inside dense cumulus cores.
  * **Phase Function (Dual-Lobe Henyey-Greenstein):** Blends strong forward scattering ($g_1 = 0.65$, silver-lining rim glow when looking toward the sun) with mild back-scattering ($g_2 = -0.25$, ambient fullness when looking down-sun).

---

## 4. Composable Layer API (`AtmosphereLayer`)

The layer encapsulates all GPU allocations, UBO updates, and shader lifecycles behind a minimal host contract:

```ts
export interface AtmosphereEnvironment {
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  skyAmbientColor: THREE.Color;
  windVelocity: THREE.Vector3;   // xz drift in m/s
  coverage: number;              // [0.0, 1.0] cloud cover fraction
  altitudeBounds: [number, number]; // [yMin, yMax] in world units
}

export class AtmosphereLayer {
  constructor(options?: { noiseResolution?: number; qualityTier?: 'low' | 'medium' | 'high' });

  init(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
  setSceneDepthTexture(depthTexture: THREE.DepthTexture): void;
  setEnvironment(env: Partial<AtmosphereEnvironment>): void;
  setQualityTier(tier: 'low' | 'medium' | 'high'): void;
  update(elapsedSeconds: number, camera: THREE.PerspectiveCamera): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
```

---

## 5. Frame-Budget Engineering & Interactive Telemetry

### Target Resource & Performance Budget
| Metric | Budget Target (1080p Integrated GPU) | Implementation Mechanism |
| :--- | :--- | :--- |
| **Atmosphere Pass GPU Time** | **< 4.5 ms** (High) / **< 2.2 ms** (Medium) | Adaptive step stride + half-res render target option |
| **Additional Draw Calls** | **1** (atmosphere proxy slab) | Single `BackSide` bounding volume pass |
| **Texture VRAM Footprint** | **~9.0 MB** total | `128³ RGBA8` (8 MB) + `512² RG8` (0.5 MB) + depth buffer |
| **Per-Frame CPU Overhead** | **< 0.15 ms** | Single `gl.bufferSubData` UBO upload per frame |

### Built-In Reviewer HUD
The top-right control panel exposes real-time uniform controls alongside live profiling metrics:
* **Weather & Lighting:** Cloud Coverage (`0–100%`), Cloud Base/Top Altitude, Wind Speed, Sun Elevation & Azimuth.
* **Quality & Resolution Scale:** Step Budget (`24` / `40` / `64` steps) and Volumetric Render Scale (`0.5x` bilateral upsample vs. `1.0x` native).
* **Live Telemetry:** Rolling FPS, frame time (`ms`), active draw calls, and raymarch step count.

---

## 6. WebGL2 → WebGPU Migration Path

To support next-generation WebGPU renderers without rewriting core shading math, all data structures in this implementation follow WebGPU alignment and binding conventions:

| WebGL2 Implementation (Current) | WebGPU Target Equivalent | Migration Benefit |
| :--- | :--- | :--- |
| `std140` Uniform Buffer Object (`AtmosphereUBO`) | `GPUBuffer` with `GPUBufferUsage.UNIFORM` | Zero-copy struct layout parity (`vec4`-padded blocks) |
| `THREE.Data3DTexture` (`RGBA8`) | `GPUTexture` (`dimension: '3d'`, `rgba8unorm`) | Direct 1:1 resource transfer & hardware trilinear filtering |
| Fragment-shader raymarch on `BackSide` mesh | `@compute @workgroup_size(8, 8, 1)` pass writing to a half-res `rgba16float` storage texture | Enables async compute overlap with opaque geometry & shared-memory subgroup reductions |
| `WebGLRenderTarget` + `DepthTexture` | `GPUTexture` (`depth32float`) sampled via `textureLoad` in WGSL | Eliminates full-screen depth blit overhead |

---

## 7. Trade-offs & Future Extensions

* **Why Analytical Raymarching over Billboarded Cloud Cards:** Tactical map cameras frequently pitch between top-down nadir views and oblique horizon views. Sprite-based billboards exhibit visible card-flipping and flat layering at steep pitch angles, whereas world-space volumetric raymarching preserves true 3D parallax from every camera orientation.
* **Why `RGBA8` Pre-Baked Noise over Runtime FBM:** Sampling a hardware-interpolated `Data3DTexture` reduces per-step ALU instructions by ~70% compared to evaluating 4 octaves of 3D gradient/cellular noise in GLSL, keeping the shader ALU-light on bandwidth-constrained mobile/laptop GPUs.
* **Next Production Steps:**
  1. **Temporal Reprojection (TAA):** Amortize raymarching across 4 frames using motion vectors and neighborhood color clamping to achieve 128-step visual fidelity at 32-step cost.
  2. **Dynamic Weather Ingestion:** Stream real-time meteorological radar or GRIB wind/cloud-cover tiles directly into the 2D `WeatherMap` texture.
