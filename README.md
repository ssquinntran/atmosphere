# Volumetric Atmosphere, Vortex Hydrodynamics & Particle Physics Layer (WebGL2 / Three.js)

A real-time, composable volumetric atmosphere, vortex hydrodynamics, and Lagrangian particle physics simulation built with **WebGL2 (`#version 300 es` / GLSL3)** and **Three.js (r187)** using custom native vertex and fragment shaders (`RawShaderMaterial` & `ShaderMaterial`) with **zero build step or bundler required**.

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
| **Build an atmosphere layer such as clouds** | Composable `AtmosphereLayer` (`src/layers/AtmosphereLayer.js`) supporting **all 10 WMO cloud genera**, **volumetric Rankine Tornado / Waterspout funnel**, **volumetric internal storm lightning**, **3D topographic air–land interaction**, sub-cloud virga rain shafts, and 3D falling rain. |
| **Build it natively using your own fragment & vertex shaders** | 100% custom GLSL3 (`#version 300 es`) shaders in `src/shaders/atmosphere.vert.js`, `src/shaders/atmosphere.frag.js`, and `src/noise/CloudNoiseBaker.js` (`THREE.RawShaderMaterial`), plus custom vertex/fragment displacement shaders for **Tsunami Soliton Waves, Whirlpool Maelstrom Vortex, Tides**, 3D rainfall, 3D topographic wind streamlines, and Lagrangian particle clusters. |
| **Particle Physics & Data Structures (Spatial Hash + Union-Find)** | `src/physics/FluidClusterPhysics.js` implements a zero-allocation **3D Spatial Hash Grid (`SpatialHashGrid3D`)** for $O(N)$ neighbor lookup paired with **Disjoint-Set Union-Find (`DisjointSetUnion`)** (with path compression and union by size, $O(\alpha(N))$) for real-time droplet/foam coalescence and topological landmass/waterway connectivity analysis. |
| **Rendered onto a simple HTML site & uploaded to GitHub** | Self-contained `index.html` with interactive HUD controls, live GPU & Union-Find telemetry, and 4-mode shader inspection overlay. |

---

## Key Engineering Features

### 1. Custom Native Volumetric Shaders & Rankine Tornado Funnel (`src/shaders/`)
- **`atmosphere.vert.js`**: Projects an analytical proxy bounding slab (`[uBoundsMin, uBoundsMax]`, dynamically expanded for orographic lift headroom and sub-cloud tornado/virga shafts).
- **`atmosphere.frag.js`**:
  - **3D Rankine Tornado / Maritime Waterspout (`evaluateTornadoFunnel`)**: Raymarches a spinning helical condensation funnel from the mesocyclone cloud collar all the way to the sea surface (`uVortexAndTide`), complete with a hollow low-pressure eye wall, cyclonic cloud-deck swirl, sea-spray touchdown collar, and stochastic **volumetric internal storm lightning** flashes.
  - **Analytical Ray–AABB Intersection** with `64×64` blue-noise start jitter and adaptive empty-space stride skipping.
  - **Dual-Lobe Henyey-Greenstein Phase Function** ($g_1 = 0.72$, $g_2 = -0.30$) + **Multi-Octave Beer-Lambert Extinction** + **Powder-Sugar Edge Term**.
  - **Off-Axis Radial Euclidean Scene Depth (`tScene`)**: Linearizes the hardware `DepthTexture` and divides by $\cos\theta = \mathbf{d}_{\text{ray}} \cdot \mathbf{d}_{\text{camFwd}}$ for distortion-free 3D mountain/wave occlusion.

### 2. Particle Physics & Data Structures (`src/physics/FluidClusterPhysics.js`)
- **`SpatialHashGrid3D` ($O(N)$ Broad-Phase)**: Buckets 1,100+ 3D Lagrangian sea-spray, foam-raft, and vortex debris particles into uniform 3D spatial cells using flat typed-array linked lists (`head`/`next` arrays with prime XOR hashing) for zero garbage collection per frame.
- **`DisjointSetUnion` (Union-Find with Path Compression & Union by Size, $O(\alpha(N))$)**:
  1. **Dynamic Particle Coalescence**: Merges neighboring parcels within the coalescence radius into connected physical eddies/clusters, scaling particle inertia, viscous velocity alignment, and point-sprite luminance by `getComponentSize(i)`.
  2. **Topological Land/Water Connectivity (`analyzeTerrainTopologyUnionFind`)**: Scans the terrain heightfield against the live **Tidal Sea Level** to count connected emerged island/mountain masses and flooded waterway basins in real time.

### 3. Vertex-Shader Ocean Hydrodynamics: Tsunami, Whirlpool & Tides (`src/main.js`)
- **Subdivided Ocean Mesh (`180×180`) with Custom Vertex & Fragment Shaders**:
  - **Tsunami Soliton Wave**: Propagates a steep-fronted 26m soliton wave wall up the fjord channel with foaming crest spray.
  - **Whirlpool Maelstrom Vortex**: Pulls ocean vertices into a rotating logarithmic funnel pit at the central canyon junction with spiral whitewater foam bands.
  - **Tidal Sea Level (`-5.0 m` Low Tide to `+12.0 m` King Tide)**: Dynamically floods or exposes canyon beaches and shoals while updating Union-Find island/waterway topology.
- **Saronic ASV 6-DOF Wave-Riding Physics (`CORSAIR`, `CUTLASS`, `SPYGLASS`)**:
  - Custom faceted stealth hulls with **SARONIC** logo plates evaluate the live wave height and surface normal every frame to heave, pitch, and roll over tsunami swells, tides, and whirlpool rims while navigating the flooded gorges.

### 4. All 10 WMO Cloud Genera & 3D Topographic Air–Land Interaction
- **10 WMO Genera (`CLOUD_GENERA`)**: `Cumulus`, `Stratus`, `Stratocumulus`, `Altocumulus`, `Altostratus`, `Nimbostratus`, `Cirrus`, `Cirrocumulus`, `Cirrostratus`, and `Cumulonimbus`.
- **Topographic Airflow (`uTerrainMap`)**: Potential-flow streamline deflection around mountain flanks, canyon funneling, orographic updraft lift over windward ridges, and 3D solid-rock exclusion.

---

## Repository Structure

```text
├── README.md                        # Architecture overview, shader pipeline & data structures
├── index.html                       # Entry viewport, importmap (Three.js r187), HUD & telemetry
└── src/
    ├── main.js                      # Renderer, morphable canyon terrain, vertex-displaced ocean, Saronic ASVs
    ├── layers/
    │   └── AtmosphereLayer.js       # Composable volumetric cloud/tornado layer, 10 WMO genera & GPU timer
    ├── noise/
    │   └── CloudNoiseBaker.js       # GPU slice-atlas 3D Perlin-Worley baker, weather map & blue-noise jitter
    ├── physics/
    │   └── FluidClusterPhysics.js   # SpatialHashGrid3D + DisjointSetUnion (Union-Find) + Lagrangian physics
    └── shaders/
        ├── atmosphere.vert.js       # Custom GLSL3 world-space bounding slab vertex shader
        └── atmosphere.frag.js       # Custom GLSL3 volumetric clouds, Rankine tornado, lightning & airflow shader
```
