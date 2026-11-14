# Volumetric Atmosphere & Topographic Airflow Layer (WebGL2 / Three.js)

A real-time, composable volumetric atmosphere and precipitation simulation built with **WebGL2 (`#version 300 es` / GLSL3)** and **Three.js (r187)** using custom native vertex and fragment shaders (`RawShaderMaterial` & `ShaderMaterial`) with **zero build step or bundler required**.

---

## Quickstart (Zero Build Step)

Runs natively in any modern WebGL2 browser via ES Modules and an HTML `<script type="importmap">`:

```bash
git clone https://github.com/ssquinntran/atmosphere.git
cd atmosphere
python3 -m http.server 8080
# Or: npx serve .
```

Then open **`http://localhost:8080`** in Chrome, Edge, Firefox, or Safari.

---

## Assignment Requirements Checklist

| Requirement | Implementation in Repository |
| :--- | :--- |
| **Build an atmosphere layer such as clouds** | Composable `AtmosphereLayer` (`src/layers/AtmosphereLayer.js`) supporting **all 10 WMO cloud genera**, volumetric sub-cloud virga rain shafts, 3D falling rain streaks, and ocean raindrop splash ripples. |
| **Build it natively using your own fragment & vertex shaders** | 100% custom GLSL3 (`#version 300 es`) shaders in `src/shaders/atmosphere.vert.js`, `src/shaders/atmosphere.frag.js`, and `src/noise/CloudNoiseBaker.js` (`THREE.RawShaderMaterial`), plus custom `ShaderMaterial` vertex/fragment shaders for 3D rainfall, 3D topographic wind streamlines, and `onBeforeCompile` ground/ocean cloud-shadow projection. |
| **WebGL2 / WebGPU-ready architecture** | Strictly `vec4`-aligned uniform blocks (`std140` / WebGPU `GPUBuffer` parity), hardware `THREE.DepthTexture` radial depth compositing, Relative-To-Center (RTC) floating-origin world offsets, and `EXT_disjoint_timer_query_webgl2` GPU pass profiling. |
| **Rendered onto a simple HTML site & uploaded to GitHub** | Self-contained `index.html` with interactive HUD controls, live telemetry, and 4-mode shader inspection overlay. |

---

## Key Engineering Features

### 1. Custom Native Vertex & Fragment Shaders (`src/shaders/`)
- **`atmosphere.vert.js`**: Projects an analytical proxy bounding slab (`[uBoundsMin, uBoundsMax]`, dynamically expanded for orographic lift headroom and sub-cloud virga shafts) and passes world-space ray coordinates.
- **`atmosphere.frag.js`**:
  - **Analytical Ray–AABB Intersection** with blue-noise start jitter (`64×64` interleaved gradient sequence) and adaptive empty-space stride skipping (`1.65×` stride outside clouds, step-back refinement on cloud boundary entry).
  - **Dual-Lobe Henyey-Greenstein Phase Function** ($g_1 = 0.72$ forward peak, $g_2 = -0.30$ backscatter lobe) combined with **Multi-Octave Beer-Lambert Extinction** and a **Powder-Sugar Edge Term** for high-contrast silver linings and deep self-shadowed cloud cores.
  - **5-Step Volumetric Sun Self-Shadowing (`marchSunTransmittance`)** and vertical sky-ambient gradient.
  - **Off-Axis Radial Euclidean Scene Depth (`tScene`)**: Linearizes the hardware `DepthTexture` from the opaque pass and divides by $\cos\theta = \mathbf{d}_{\text{ray}} \cdot \mathbf{d}_{\text{camFwd}}$ to prevent peripheral frustum depth distortion and smoothly feather cloud intersections against mountain cliffs (`35 m` soft fade).

### 2. All 10 WMO Cloud Genera (`CLOUD_GENERA`)
Interactive selector in the HUD reconfigures vertical height envelopes (`computeGenusHeightProfile`), cellularity (stratiform Perlin sheets vs. cumuliform Worley puffs), anisotropic wind shear, altitude bands, and precipitation:
- **Low-Étage:** `Cumulus (Cu)`, `Stratus (St)`, `Stratocumulus (Sc)`
- **Middle-Étage:** `Altocumulus (Ac)`, `Altostratus (As)`, `Nimbostratus (Ns)`
- **High-Étage Ice Clouds:** `Cirrus (Ci)`, `Cirrocumulus (Cc)`, `Cirrostratus (Cs)`
- **Towering Convective:** `Cumulonimbus (Cb)` (with spreading upper anvil dome and heavy downpour)

### 3. 3D Topographic Air–Land Interaction (`uTerrainMap`)
Moving air physically interacts with the terrain topology instead of passing through solid land masses:
- **Live GPU Height & Slope-Gradient Map (`uTerrainMap`)**: Encodes normalized elevation $H(x,z)$ (`R`), central-difference slope gradients $\partial H/\partial x, \partial H/\partial z$ (`G`, `B`), and a canyon gorge funnel mask (`A`).
- **Potential-Flow Streamline Deflection & Canyon Funneling**: Air parcels approaching steep mountain flanks deflect laterally around peaks and accelerate through low-resistance canyon gorges.
- **Orographic Updraft Lift & Windward Condensation**: Wind blowing uphill ($\mathbf{v}_{\text{wind}} \cdot \nabla H > 0$) lifts the cloud column over mountain ridges (`orographicLiftY`), boosting condensation on windward crests and creating Foehn dissipation in the leeward rain shadow.
- **3D Solid-Landmass Obstacle Exclusion**: Clouds are strictly excluded from solid mountain rock interiors (`clearanceMask`), verified in **Shader Debug View Key `4`**.
- **3D Topographic Wind Streamline Ribbons**: 260 dynamic 3D wind-stream trails (`createAirflowStreamlines`) visualize air currents splitting around mountain flanks, climbing windward ridges, and funneling through the gorges.

### 4. Continuous Island-to-Canyon Landform Morphing & Saronic ASV Fleet
- **Real-Time Landform Sliders (60 FPS)**:
  - **`Islands → Canyon Mountains` (`0%`–`100%`)**: Smoothly morphs detached coastal islands into twin mountain cordilleras split by a flooded North–South fjord and East–West cross gorge.
  - **`Mountain Peak Height` (`60 m`–`360 m`)** & **`Canyon Gorge Carve` (`0%`–`100%`)**: Continuously reshapes peak elevation and canyon wall steepness while updating `uTerrainMap` in real time.
- **Saronic Autonomous Surface Vessel (ASV) Fleet (`CORSAIR`, `CUTLASS`, `SPYGLASS`)**:
  - Custom faceted wave-piercing stealth hulls, inward-sloping tumblehome sides, flat phased-array SATCOM deckhouse, forward-raked sensor mast, EO/IR gimbal turret, twin foaming V-wakes, and **SARONIC** logo plates.
  - Navigates strictly along the flooded gorge splines (`getMainFjordX`, `getCrossGorgeZ`) so vessels never clip into land masses.

### 5. Shader Debug Inspector (Keys `1`–`4`)
- **Key `1` (`0: Final Composite`)**: Full physically-based volumetric clouds, topographic airflow, and precipitation.
- **Key `2` (`1: Optical Transmittance T`)**: Displays pixel transmittance $T \in [0, 1]$ (`1.0` = clear sky, coral tint marks $T \le 0.012$ early-exit opaque cloud cores).
- **Key `3` (`2: Radial Scene Depth tScene`)**: Visualizes Euclidean distance to mountains, canyons, and vessels with `50 m` contour rings.
- **Key `4` (`3: 3D Noise & Airflow Slice`)**: Horizontal cross-section through the GPU-baked 3D noise textures (`R` = Perlin-Worley base, `G` = Worley lobes, `B` = high-freq detail, `Cyan` = active cloud boundary, `Amber/Dark Slate` = solid mountain rock core intersecting the slice).

---

## Repository Structure

```text
├── README.md                     # Architecture overview, shader pipeline & quickstart
├── index.html                    # Entry viewport, importmap (Three.js r187), HUD & telemetry
└── src/
    ├── main.js                   # Renderer, morphable canyon terrain, uTerrainMap, Saronic ASVs, 3D rain & airflow
    ├── layers/
    │   └── AtmosphereLayer.js    # Composable volumetric cloud layer, 10 WMO genera & GPU timer profiler
    ├── noise/
    │   └── CloudNoiseBaker.js    # GPU slice-atlas 3D Perlin-Worley baker, weather map & blue-noise jitter
    └── shaders/
        ├── atmosphere.vert.js    # Custom GLSL3 world-space bounding slab vertex shader
        └── atmosphere.frag.js    # Custom GLSL3 volumetric raymarching, topographic airflow & virga shader
```
