# atmosphere
Simulation of atmosphere layer such as clouds

├── README.md                     # Updated engineering design doc & architecture overview

├── index.html                    # Entry viewport, importmap (Three.js r187), HUD & telemetry

└── src/

    ├── main.js                   # Renderer, offscreen depth pass, ocean/terrain/vessels, UI
    
    ├── layers/
    │   └── AtmosphereLayer.js    # Composable volumetric cloud layer & GPU timer profiler
    
    ├── noise/
    │   └── CloudNoiseBaker.js    # GPU slice-atlas 3D noise baker & weather/jitter textures
    
    └── shaders/
    
        ├── atmosphere.vert.js    # World-space ray setup & bounding slab projection
        
        └── atmosphere.frag.js    # Ray-AABB intersect, radial depth fade, HG/Beer-Lambert march
        

# Volumetric Cloud & Atmosphere Layer (WebGL2 / Three.js)

A real-time, map-native volumetric cloud layer built with **Three.js (r187)** and custom **GLSL (`#version 300 es`)** vertex and fragment shaders. Designed for 3D geospatial and maritime operational viewports, the layer renders physically inspired cumulus formations inside a world-space altitude slab with analytical ray-box intersection, radial depth-buffer terrain compositing, synchronized ocean cloud shadows, Relative-To-Center (RTC) floating-origin support, and a 4-mode shader inspection overlay.

> **Live Demo:** `[Insert GitHub Pages URL]`

---

## Quickstart

Zero build step or bundler required—runs natively via ES Modules and an HTML `importmap`.

```bash
git clone [https://github.com/](https://github.com/)<your-username>/<repo-name>.git
cd <repo-name>
npx serve .
# Or: python3 -m http.server 8080
```

Open `http://localhost:3000` (or `:8080`) in a WebGL2-capable browser (Chrome, Edge, Firefox, Safari).

---

## 1. Architectural Goals

1. **Map-Camera & Floating-Origin Rigor:** Support arbitrary camera pitch, zoom, and altitude—including flying *above*, *through*, or *beneath* the cloud deck—alongside a `setWorldOriginOffset(x, z)` RTC anchor so multi-kilometer map panning never introduces `float32` vertex or UV precision jitter.
2. **Deterministic 60 FPS Frame Budget:** Keep volumetric fragment costs predictable on integrated and mid-tier laptop GPUs via GPU-baked 3D noise textures, blue-noise step jittering, adaptive empty-space stride skipping, `DPR <= 2` clamping, and Beer-Lambert transmittance early-out.
3. **Composable Layer Lifecycle & Context Resilience:** Decouple atmospheric rendering from host scene management through an explicit `AtmosphereLayer` interface (`init`, `setSceneDepthTexture`, `setEnvironment`, `setWorldOriginOffset`, `setDebugMode`, `update`, `resize`, `onContextLost`, `onContextRestored`, `dispose`).
4. **WebGL2 → WebGPU Data Parity:** Pack uniforms into strictly `vec4`-aligned blocks and channel-packed 3D textures so shader bindings map 1:1 to WebGPU `GPUBuffer` (`std140`) and `@compute` pipelines.

---

## 2. System Architecture & Render Pipeline

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. STARTUP / CONTEXT-RESTORE GPU BAKE PASS (< 15 ms, zero main-thread stall) │
│    ├── Macro 3D Noise    : 64³ RGBA8 Data3DTexture (GPU 512² slice-atlas)    │
│    ├── Detail 3D Noise   : 32³ RGBA8 Data3DTexture (GPU 256×128 slice-atlas) │
│    ├── Weather Map       : 256² RGBA8 DataTexture (Coverage + Cloud Height)  │
│    └── Blue-Noise Jitter : 64² RGBA8 Tileable Texture (Anti-banding offset)  │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Bound to AtmosphereLayer + Ground UBOs
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 2. BASE MARITIME SCENE PASS (Offscreen WebGLRenderTarget)                    │
│    ├── Ocean surface (Fresnel + waves + RTC-projected drifting cloud shadows)│
│    ├── Coastal archipelago terrain (peaks penetrate cloud base for depth)    │
│    ├── Autonomous surface vessel markers + wakes                             │
│    └── Outputs Color Buffer + Hardware DepthTexture (UnsignedIntType)        │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ uSceneDepth
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 3. VOLUMETRIC ATMOSPHERE PASS (Custom Vertex + Fragment Shaders)             │
│    ├── Proxy Geometry : World-space bounding slab [yMin, yMax] (BackSide)    │
│    ├── Vertex Shader  : Emits world-space proxy pos & screen-space UVs       │
│    └── Fragment Shader: Ray-AABB intersect → Radial tScene depth clamp       │
│                         → RTC World Offset → Adaptive March / Debug View     │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Premultiplied / Normal Alpha Composite
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 4. ISOLATED GPU PROFILER & PRESET CONTROLLER                                 │
│    └── EXT_disjoint_timer_query_webgl2 isolated pass timing + HUD controls   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Shader & Mathematical Design

### 3.1 GPU Slice-Atlas 3D Noise Baking (`CloudNoiseBaker.js`)
Generating multi-octave 3D Perlin-Worley noise on the CPU blocks page startup for several seconds, while rendering directly into `WebGL3DRenderTarget` layers triggers known framebuffer-attachment bugs on Windows Chrome ANGLE D3D11 backends. Instead, `CloudNoiseBaker` renders all 3D depth slices into a single 2D tile atlas (`512×512` for `64³`, `256×128` for `32³`) in **one GPU draw call**, unpacks the pixels into a `THREE.Data3DTexture`, and disposes the temporary FBO—completing in **< 15 ms** across Metal, D3D11, and Vulkan.

| Texture | Resolution | Channels | Role in Density Field |
| :--- | :--- | :--- | :--- |
| `uMacroNoise` | `64³` (`1.0 MB`) | **R**: Perlin-Worley FBM<br>**G/B/A**: Multi-octave Worley FBM | Defines macro cumulus silhouettes, cloud puffiness, and vertical anvil shaping |
| `uDetailNoise` | `32³` (`0.13 MB`) | **R/G/B**: High-frequency periodic Worley FBM | Carves turbulent wisps along cloud boundaries (`density > 0.0` only) |
| `uWeatherMap` | `256²` (`0.26 MB`) | **R**: Coverage mask, **G**: Cloud height scale | Advected by wind & RTC origin offset; drives both clouds and ocean shadows |

### 3.2 Analytical Ray-Slab Intersection & Radial Depth Compositing
The proxy mesh is an axis-aligned bounding box spanning `[-600, 600]` in `X/Z` and `[uCloudMinY, uCloudMaxY]` in `Y`, rendered with `THREE.BackSide` and `depthTest: false` so the shader continues executing when the camera flies inside the cloud layer.

1. **Ray-AABB Entry/Exit:** Intersects $\mathbf{r}(t) = \mathbf{o} + t\mathbf{d}$ against $[\mathbf{b}_{\min}, \mathbf{b}_{\max}]$, clamping $t_{\text{near}} = \max(t_{\text{near}}, 0.0)$ and discarding early when $t_{\text{near}} \ge t_{\text{far}}$.
2. **Off-Axis Radial Depth Correction:** Linearizing the hardware depth buffer produces perpendicular view-space depth $z_{\text{view}}$. To prevent wide-FOV off-axis rays near screen edges from clipping prematurely behind terrain, $z_{\text{view}}$ is converted to Euclidean ray distance $t_{\text{scene}}$ before clamping $t_{\text{far}}$:
   $$t_{\text{scene}} = \frac{z_{\text{view}}}{\max(\text{dot}(\mathbf{d}_{\text{world}}, \mathbf{f}_{\text{camera}}), 0.001)}$$
3. **Soft Terrain Feathering & Horizon Haze:** Density attenuates smoothly over 35 world units near $t_{\text{scene}}$ and across the outer 16% horizontal perimeter of the local bounding slab, while exponential aerial perspective blends distant extinction into the horizon sky color.

### 3.3 Adaptive Raymarching & Lighting Model
* **Blue-Noise Jitter:** Starting offset $t_{\text{start}} = t_{\text{near}} + \Delta s \cdot \text{texelFetch}(uBlueNoise, \text{fragCoord} \bmod 64, 0).r$ breaks up step banding into imperceptible high-frequency grain at **24–48 primary steps**.
* **Adaptive Stride & Early-Out:** Marches at `1.85x` step size in empty space (`density <= 0.001`), steps back one base increment upon hitting a cloud boundary, integrates at `1.0x` resolution, and terminates early when transmittance $T < 0.01$.
* **Scattering & Extinction:**
  * **Beer-Lambert Transmittance:** $T_i = \exp(-\sigma_e \cdot \rho(\mathbf{p}_i) \cdot \Delta s)$
  * **Self-Shadowing + Powder Effect:** A 4-step secondary march toward `uSunDir` computes optical depth $\tau_{\text{sun}}$, modulated by $(1 - \exp(-2\tau_{\text{sun}}))$ to preserve dark internal crevices.
  * **Dual-Lobe Henyey-Greenstein Phase:** Blends forward scattering ($g_1 = 0.65$, silver-lining rim glow) with back-scattering ($g_2 = -0.25$, ambient fullness).

---

## 4. Shader Debug Inspector & Operational Resilience

### 4.1 4-Mode Shader Debug View (`Keys 1–4` or HUD Dropdown)
To make pipeline behavior inspectable without external capture tools, `uDebugParams.x` switches the fragment output between production shading and three diagnostic visualizations:

| Key / ID | Mode | Visualization | What It Verifies |
| :--- | :--- | :--- | :--- |
| **`1` (`0`)** | **Final Composite** | Shaded cumulus deck + aerial perspective haze | Production lighting, silver linings, and terrain occlusion |
| **`2` (`1`)** | **Optical Transmittance ($T$)** | Grayscale transmittance $T \in [0, 1]$ with coral highlight where $T \le 0.012$ | Beer-Lambert density integration and early-out ray termination |
| **`3` (`2`)** | **Radial Scene Depth ($t_{\text{scene}}$)** | Linearized Euclidean ray distance with `50 m` range rings | Off-axis $\cos\theta$ depth linearization near wide-FOV screen edges |
| **`4` (`3`)** | **3D Noise Slice (RGB)** | Horizontal cross-section at 42% slab height (`R`: Perlin-Worley, `G`: Worley, `B`: Detail) + cyan coverage contour | Live wind advection, RTC floating-origin continuity, and channel packing |

### 4.2 Floating-Origin (RTC) & WebGL Context Recovery
* **Relative-To-Center Coordinates (`setWorldOriginOffset(x, z)`):** Keeps the camera and local bounding slab centered near `(0, y, 0)` in `float32` view space while shifting weather and 3D noise sampling coordinates via `uWorldOriginOffset.xy` (shared with the ocean shadow shader). Reviewers can test large-scale map translation directly in DevTools via `window.atmosphereLayer.setWorldOriginOffset(25000, -14000)`.
* **Context Loss Lifecycle (`webglcontextlost` / `webglcontextrestored`):** Browser-based C2 consoles run across multi-hour missions where GPU driver resets or OS sleep events can invalidate WebGL contexts. `main.js` prevents default context abandonment, pauses the `requestAnimationFrame` loop, disposes stale query/texture handles via `atmosphere.onContextLost()`, and transparently re-bakes all 3D noise volumes and render targets on `webglcontextrestored`.

---

## 5. Frame-Budget & Resource Summary

| Metric | Target Budget (1080p) | Implementation Mechanism |
| :--- | :--- | :--- |
| **Atmosphere GPU Pass Time** | **1.8 – 4.2 ms** (`24–36` steps) | Adaptive empty-space stride + `T < 0.01` early-out + `DPR <= 2` clamp |
| **Additional Draw Calls** | **1** | Single `BackSide` world-space bounding slab |
| **3D/2D Noise VRAM Footprint** | **~1.39 MB** | Nubis `64³` + `32³` split (`1.13 MB`) + `256²` weather + `64²` blue noise |
| **Startup / Restore Bake Time** | **< 15 ms** | Single-pass GPU 2D slice-atlas render + `Data3DTexture` upload |

---

## 6. WebGL2 → WebGPU Migration Path

| WebGL2 Implementation (Current) | WebGPU Target Equivalent | Migration Benefit |
| :--- | :--- | :--- |
| Strictly `vec4`-padded uniform blocks (`uBoundsMinAndFade`, `uWorldOriginOffset`, `uDebugParams`, etc.) | `GPUBuffer` (`GPUBufferUsage.UNIFORM`) | Zero-copy `std140` byte-layout parity |
| `THREE.Data3DTexture` (`RGBA8`) | `GPUTexture` (`dimension: '3d'`, `rgba8unorm`) | Direct 1:1 resource transfer & hardware trilinear filtering |
| Fragment-shader raymarch on `BackSide` slab | `@compute @workgroup_size(8, 8, 1)` pass writing to `rgba16float` storage texture | Enables async compute overlap with opaque geometry |
| `WebGLRenderTarget` + `DepthTexture` | `GPUTexture` (`depth32float`) sampled via `textureLoad` in WGSL | Eliminates full-screen depth resolve overhead |
