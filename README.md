# Volumetric Atmosphere & Maritime Storm Engine (`AtmosphereLayer`)

A drop-in, zero-allocation **WebGL2 / Three.js Volumetric Cloud, Cyclone Vortex, 3D Lightning, Fog & Maritime Hydrodynamics Engine**. Pairs single-pass GPU raymarching ([src/layers/AtmosphereLayer.js](src/layers/AtmosphereLayer.js)) with $O(N)$ **3D Spatial Hash Grid (`SpatialHashGrid3D`)** + $O(N \cdot \alpha(N))$ **Disjoint-Set Union-Find (`DisjointSetUnion`)** fluid-cluster and coastal-topology physics ([src/physics/FluidClusterPhysics.js](src/physics/FluidClusterPhysics.js)).

![Live EF5 Supercell Tornado Waterspout & Autonomous USV](screenshot_tornado_squall.png)

---

## Included Artifacts, Slideshows & Video Showcases in This Repository

| Artifact / Deliverable | Format | Link in Repository |
| :--- | :--- | :--- |
| **10-Slide Executive Architecture Slideshow (Markdown)** | Markdown + Mermaid + Graphviz | [atmosphere_architecture_slideshow.md](atmosphere_architecture_slideshow.md) |
| **10-Slide Interactive Architecture Presentation Deck** | Interactive HTML Deck | [atmosphere_slideshow_deck.html](atmosphere_slideshow_deck.html) |
| **Engineering Walkthrough & Union-Find Appendix** | Markdown Documentation | [walkthrough.md](walkthrough.md) |
| **10 Extreme Weather & Capability Scenario Videos** | Markdown Video Catalog | [extreme_weather_10_videos.md](extreme_weather_10_videos.md) |
| **Interactive 10-Scenario Video Showcase Player** | Interactive HTML Video Player | [atmosphere_video_showcase.html](atmosphere_video_showcase.html) |
| **Automated 10-Scenario WebGL2 Video Studio** | ES Module Recorder | [scenarios-recorder.js](scenarios-recorder.js) |

---

## Key Capabilities & Performance Highlights

- **Single-Pass GPU Volumetric Raymarching ([src/layers/AtmosphereLayer.js](src/layers/AtmosphereLayer.js), [src/shaders/atmosphere.frag.js](src/shaders/atmosphere.frag.js)):**
  - Pre-baked $64 \times 64 \times 64$ macro and $32 \times 32 \times 32$ detail tileable 3D Perlin-Worley + Curl-Noise volume textures ([src/noise/CloudNoiseBaker.js](src/noise/CloudNoiseBaker.js)) unpacked via native `TypedArray.set(subarray)` row copies (**~8.5× faster** than analytic shader noise).
  - Half-resolution ($0.5\times$) FBO volumetric target with blue-noise temporal jitter and single-pass hardware bilinear upsampling (**4× fewer fragments**).
  - **10 WMO Cloud Genera** (`cumulus`, `stratus`, `stratocumulus`, `altocumulus`, `altostratus`, `nimbostratus`, `cirrus`, `cirrocumulus`, `cirrostratus`, `cumulonimbus`) & **6 Storm Regimes** (`none`, `waterspout`, `supercellTornado`, `hurricane`, `derecho`, `norEaster`).
  - **Interactive Lightning & Fog Controls:** Real-time sliders for 3D branched GPU cloud-to-sea lightning bolts + volumetric sheet flash (`lightningIntensity` in `[0.0, 1.0]`) and Beer-Lambert atmospheric fog (`fogDensity` in `[0.0, 1.0]`).
- **Zero-Allocation $O(N)$ 3D Spatial Hash + Union-Find Physics ([src/physics/FluidClusterPhysics.js](src/physics/FluidClusterPhysics.js)):**
  - **3D Spatial Hash Grid (`SpatialHashGrid3D`):** $O(N)$ broad-phase proximity detection in `20m` 3D grid cells using flat `Int32Array` buckets (`head`, `next`, `dirtyBuckets`).
  - **Disjoint-Set Union (`DisjointSetUnion`):** $O(N \cdot \alpha(N))$ path-compressed connected-component clustering for 512 3D sea-spray/vortex parcels and $56 \times 56$ (`3,136-cell`) coastal heightfield topology using reusable zero-allocation buffers.
- **100.0% V8 Code Coverage:** **14 / 14** unit, front-end DOM, and live 4-phase experiment suites passing (**100.0% Line, 100.0% Function, 99.7% Branch Coverage**) via [tests/run-tests.js](tests/run-tests.js) and [tests/frontend-tests.html](tests/frontend-tests.html).

---

## System Architecture

### 1. Graphviz Pipeline Diagram (`digraph AtmosphereEngine`)

```dot
digraph AtmosphereEngine {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fillcolor="#131c2e", fontcolor="#f0f6fc", color="#38bdf8", fontname="Inter"];
  edge [color="#94a3b8", fontcolor="#cbd5e1", fontname="Inter", fontsize=10];

  subgraph cluster_boot {
    label="1. Boot & Pre-Bake"; style="rounded,dashed"; color="#38bdf8"; fontcolor="#38bdf8";
    Baker [label="CloudNoiseBaker\n64³ Macro + 32³ Detail\nTypedArray.set Row Copy"];
    TopoDSU [label="analyzeTerrainTopologyUnionFind\n56×56 Grid (3,136 cells)\nZero-Alloc _topoDsu Buffers"];
  }
  subgraph cluster_cpu {
    label="2. Per-Frame CPU Physics (Zero Heap Alloc)"; style="rounded,dashed"; color="#818cf8"; fontcolor="#818cf8";
    Grid [label="SpatialHashGrid3D\nO(N) 20m 3D Cells\n3×3×3 Neighbor Scan"];
    DSU [label="DisjointSetUnion (512 parcels)\nO(N α(N)) Coalescence +\n0.08 Viscous Velocity Blend"];
    ASV [label="6-DOF Saronic ASV Fleet\nBuoyancy + Roll/Pitch"];
    Grid -> DSU -> ASV;
  }
  subgraph cluster_gpu {
    label="3. Half-Res GPU Volumetric Pass"; style="rounded,dashed"; color="#34d399"; fontcolor="#34d399";
    Frag [label="atmosphere.frag.js (0.5x FBO)\nRankine Vortex + Hurricane\n+ Sheet Lightning + Fog"];
    Comp [label="Fullscreen Bilinear Composite\nbaseCol*(1-alpha) + cloudCol"];
    Frag -> Comp;
  }
  Baker -> Frag [label="uMacroNoise / uDetailNoise"];
  TopoDSU -> ASV [label="4 Isl / 1 Sea"];
  DSU -> Comp [label="aClusterSize Glow"];
}
```

### 2. Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    ATMOSPHERE_LAYER ||--|| CLOUD_NOISE_BAKER : "bakes 64x64x64 & 32x32x32 3D atlases"
    ATMOSPHERE_LAYER ||--o{ CLOUD_GENUS : "configures (10 WMO genera)"
    ATMOSPHERE_LAYER ||--o{ STORM_TYPE : "activates (6 cyclone regimes)"
    LAGRANGIAN_VORTEX_SYSTEM ||--|| SPATIAL_HASH_GRID_3D : "hashes 512 parcels in 20m 3D cells O(N)"
    LAGRANGIAN_VORTEX_SYSTEM ||--|| DISJOINT_SET_UNION : "coalesces connected vortex eddies O(N a(N))"
    TERRAIN_TOPOLOGY ||--|| DISJOINT_SET_UNION : "segments 56x56 (3,136) coastal cells"

    ATMOSPHERE_LAYER {
        THREE_Mesh proxyMesh "Inverted volumetric proxy box"
        THREE_Color _tmpColor "Reusable zero-alloc scratch"
        float lightningIntensity "uSunDirAndElevation.w [0..1]"
        float fogDensity "uSkyColorAndHaze.w [0..1]"
    }
    LAGRANGIAN_VORTEX_SYSTEM {
        int count "512 parcels (Float32Array SoA)"
        int activeClusters "Connected fluid eddies"
        int largestCluster "Peak vortex funnel eddy size"
        Float32Array clusterSizes "Uploaded as GPU attribute aClusterSize"
    }
```

### 3. Per-Frame Execution Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant RAF as requestAnimationFrame
    participant Main as src/main.js
    participant Phys as LagrangianVortexParticleSystem
    participant Grid as SpatialHashGrid3D + DSU
    participant GPU as WebGL2 (atmosphere.frag.js)

    RAF->>Main: animate() (pre-allocated scratch vectors)
    Main->>Phys: update(dt, _particleParams)
    Phys->>Grid: clear() + insert(512) + clusterNeighbors(dsu, R_coalesce)
    Grid-->>Phys: dsu.union(i, j) + 0.08 viscous momentum blend
    Phys->>Phys: compSize = dsu.size[dsu.parent[i]] -> massFactor & aClusterSize
    Main->>GPU: Pass 1: Render Terrain, Ocean, 3D Lightning, ASVs & DSU Points -> sceneTarget
    Main->>GPU: Pass 2: Render AtmosphereLayer -> cloudTarget (0.5x Half-Res Raymarch)
    Main->>GPU: Pass 3: Fullscreen Bilinear Upsample & Premultiplied-Alpha Composite
```

---

## Appendix: What Union-Find Does & Why Spatial Hash + Union-Find Instead of a Priority Queue

We are **not** using a priority queue—instead, the simulation pairs a **3D Spatial Hash Grid (`SpatialHashGrid3D`)** for $O(N)$ broad-phase collision/proximity detection with **Disjoint-Set Union-Find (`DisjointSetUnion`)** for $O(N \cdot \alpha(N))$ connected-component clustering in [src/physics/FluidClusterPhysics.js](src/physics/FluidClusterPhysics.js).

### 1. What Union-Find Does in Your Simulation

Union-Find (`DisjointSetUnion`, implemented with Path Compression and Union by Size in flat `Int32Array` buffers) drives two real-time physical systems:

#### A. Particle Coalescence: Sea-Spray, Foam Rafts & Vortex Eddies
- **Broad-Phase Collision (`SpatialHashGrid3D`):** Every frame, `LagrangianVortexParticleSystem.update()` inserts all 512 3D sea-spray and vortex debris parcels into a 3D spatial hash grid (`20m` cells).
- **Narrow-Phase Collision & Union (`clusterNeighbors`):** In `SpatialHashGrid3D.clusterNeighbors()`, each particle checks its $3 \times 3 \times 3$ neighboring grid cells. Whenever two particles collide within the coalescence radius ($d < R_{\text{coalesce}}$):
  - **Topological Merge:** `dsu.union(i, j)` merges them into the same connected fluid eddy/foam cluster.
  - **Viscous Momentum Coupling:** Their horizontal velocities blend toward their pairwise mean (`0.08` viscous alignment) so connected droplets move coherently.
- **How Cluster Size Affects Physics & Shaders:**
  - **Physical Inertia:** Each particle queries its component size (`compSize`). Larger coalesced clusters receive a higher mass factor (`massFactor = 1.0 + Math.min(compSize, 16) * 0.08`), giving large foam rafts and tornado debris clusters higher momentum and lower aerodynamic drag (`dragRate = (2.4 / massFactor) * dt`).
  - **GPU Shader Sizing & Glow:** `this.clusterSizes[i] = compSize` is uploaded to the GPU as the `aClusterSize` vertex attribute. Isolated droplets (`size = 1`) render as small, translucent sea-spray points, while large Union-Find clusters bloom into bright cyan-white foam rafts and vortex filaments.
  - **Live Telemetry:** Displayed in the HUD under **Union-Find Clusters** (e.g., `69 (Max: 318)` — meaning 69 distinct eddies with the largest vortex funnel eddy containing 318 coalesced parcels).

#### B. Terrain Island & Flooded Waterway Topology
- Whenever you adjust the **Tidal Sea Level** (`-5m` to `+12m`) or **Landform & Canyon Morph** (`0% Islands → 100% Massif`) sliders, `analyzeTerrainTopologyUnionFind()` scans a $56 \times 56$ (`3,136-cell`) terrain grid.
- It classifies each cell as **Land** (`h > waterLevel + 1.5m`) or **Water**, and runs `dsu.union()` across 4-connected neighbors of the same phase:
  - **Connected Land components ($\ge 4$ cells):** Count the number of distinct emerged islands/peaks.
  - **Connected Water components ($\ge 6$ cells):** Verify whether the fjord gorges form a single navigable sea basin (`1 Sea`) or become isolated tidal pools.
- Displayed live in the HUD under **DSU Land / Water** (e.g., `4 Isl / 1 Sea`).

### 2. Why Spatial Hash + Union-Find Instead of a Priority Queue?

| Feature | 3D Spatial Hash Grid + Union-Find (Used Here) | Priority Queue (Min-Heap) Collision Clustering |
| :--- | :--- | :--- |
| **Time Complexity per Frame** | $O(N)$ spatial hash build + $O(N \cdot \alpha(N)) \approx O(N)$ union-find | $O(N \log N)$ or $O(K \log K)$ heap insertions & extract-min operations |
| **Memory Layout** | 100% flat `Int32Array`s (`parent`, `size`, `head`, `next`, `dirtyBuckets`), zero per-frame heap allocations | Requires maintaining a binary heap of collision pairs `(distSq, i, j)` or time-of-impact `(toi, i, j)` events |
| **Transitive Clustering ($A \leftrightarrow B, B \leftrightarrow C \implies \{A,B,C\}$)** | **Native $O(\alpha(N))$:** If droplet $A$ touches $B$ and $B$ touches $C$ inside a tornado funnel wall, `dsu.union(A,B)` + `dsu.union(B,C)` automatically merges all three into one cluster of size $3$. | Does not track connected components on its own—a priority queue only orders pairwise events by distance or time, requiring a separate graph/DSU structure anyway to know cluster sizes. |
| **Best Use Case** | Continuous fluid parcels, sea spray, foam rafts, vortex debris, and grid flood/island connectivity where hundreds of particles overlap simultaneously every frame. | Discrete Time-of-Impact (TOI) rigid-body collisions (e.g., billiard balls or resolving the exact millisecond two rigid Saronic ASV boat hulls collide). |

If you ever want to add **vessel-to-vessel rigid-body collision avoidance** (where the 3 Saronic ASVs predict their earliest Time-of-Closest-Approach in the canyon junction and steer around each other in priority order), a **Min-Heap Priority Queue on vessel pair Time-of-Impact (TOI)** would be the exact right data structure for the fleet layer, while keeping Spatial Hash + Union-Find for the fluid/vortex particles.

---

## 10 Recorded Extreme Weather & Capability Scenario Videos

| # | Recorded Video File | Storm Regime | Cloud Genus / Pass | Highlighted Capability |
| :-: | :--- | :--- | :--- | :--- |
| **01** | [scenario_01_ef5_supercell_tornado.webm](scenario_01_ef5_supercell_tornado.webm) | `supercellTornado` | `cumulonimbus` | EF5 Rankine Wedge Tornado (`95%`) + 3D Branched Lightning (`95%`) |
| **02** | [scenario_02_cat5_hurricane_eyewall.webm](scenario_02_cat5_hurricane_eyewall.webm) | `hurricane` | `cumulonimbus` | Category-5 Eyewall (`100%`) + 4 Spiral Rainbands + `40 m/s` Wind |
| **03** | [scenario_03_waterspout_whirlpool_dsu.webm](scenario_03_waterspout_whirlpool_dsu.webm) | `waterspout` | `cumulonimbus` | Waterspout (`92%`) + Whirlpool (`100%`) + 512 DSU Vortex Parcels |
| **04** | [scenario_04_derecho_arcus_tsunami.webm](scenario_04_derecho_arcus_tsunami.webm) | `derecho` | `cumulonimbus` | Bow-Echo Arcus Shelf Cloud + `100%` Tsunami Soliton Wave |
| **05** | [scenario_05_noreaster_bomb_cyclone.webm](scenario_05_noreaster_bomb_cyclone.webm) | `norEaster` | `nimbostratus` | Baroclinic Comma-Head Cyclone + `+11.5m` King-Tide Canyon Surge |
| **06** | [scenario_06_dusk_lightning_barrage.webm](scenario_06_dusk_lightning_barrage.webm) | `supercellTornado` | `cumulonimbus` | Sunset Supercell + `100%` Branched Lightning & Sheet Flash |
| **07** | [scenario_07_dense_advection_sea_fog.webm](scenario_07_dense_advection_sea_fog.webm) | `none` | `stratus` | `100%` Beer-Lambert Advection Sea Fog + Low `55m` Stratus Deck |
| **08** | [scenario_08_golden_hour_archipelago.webm](scenario_08_golden_hour_archipelago.webm) | `none` | `cumulus` | 5-Island Archipelago DSU (`5I/1S`) + HG Silver-Lining Cumulus |
| **09** | [scenario_09_beer_lambert_transmittance.webm](scenario_09_beer_lambert_transmittance.webm) | `supercellTornado` | `debugMode: 1` | Beer-Lambert Optical Transmittance $T = \exp(-\sigma_t s)$ Heatmap |
| **10** | [scenario_10_3d_noise_topographic_airflow.webm](scenario_10_3d_noise_topographic_airflow.webm) | `hurricane` | `debugMode: 3` | $64^3$ 3D Perlin-Worley Noise Slice & Mountain Potential Flow |

---

## Visual Showcase

| Trade Winds & DSU Telemetry | GLSL Volumetric Raymarching |
| :---: | :---: |
| ![Trade Winds DSU Telemetry](screenshot_trade_winds_dsu.png) | ![GLSL Volumetric Shader](screenshot_glsl_shader.png) |
| **Beer-Lambert Transmittance Debug** | **Live 4-Phase Experiment & Browser Unit Tests** |
| ![Transmittance Debug](screenshot_transmittance_debug.png) | ![Live Experiment](screenshot_live_experiment.png) |

---

## Quick Start & Testing

```bash
# Start local HTTP server (http://localhost:8080)
npm run dev

# Run all 14 Unit, Front-End & Live 4-Phase Experiment Suites with V8 Coverage
npm test
```
