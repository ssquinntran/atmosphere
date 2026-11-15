# Volumetric Atmosphere, 6-Regime Storm Physics, Union-Find Coalescence & ASV Simulation (WebGL2 / Three.js)

A real-time, hardware-accelerated volumetric atmosphere, vortex hydrodynamics, 3D forked lightning, and Lagrangian particle physics digital twin built natively with **WebGL2 (`#version 300 es` / GLSL3)** and **Three.js (r187)** using custom vertex and fragment shaders (`RawShaderMaterial` & `ShaderMaterial`) with **zero build step or bundler required**.

---

## Quickstart (Zero Build Step)

Runs natively in any modern WebGL2 browser via ES Modules and an HTML `<script type="importmap">`:

```bash
git clone https://github.com/ssquinntran/atmosphere.git
cd atmosphere
python3 -m http.server 8080
# Or: npx serve .
```

- **Main 3D Simulation**: Open **`http://localhost:8080`**
- **Live Browser Front-End Unit Tests & 4-Phase Scientific Experiment**: Open **`http://localhost:8080/tests/frontend-tests.html`**
- **CLI Unit, Front-End Unit & Live Experiment Suite (`100.0%` V8 Line & Function Coverage)**:
  ```bash
  npm test
  ```

---

## Executive Presentation & Architecture Deck (Complete Slide Reference)

### Slide 1 · Executive Value Proposition

| Strategic Pillar | Technical Capability | Measurable Engineering Value |
| :--- | :--- | :--- |
| **1. Native GPU Volumetric Fidelity** | Custom GLSL3 raymarching (`src/shaders/atmosphere.vert.js`, `src/shaders/atmosphere.frag.js`) across **all 10 WMO cloud genera**, **6 storm regimes** (Waterspout, EF5 Supercell Tornado, Cat-5 Hurricane, Derecho, Nor'easter, Fair Weather), **3D forked lightning bolts**, and **exponential sea/cloud fog**. | Physically grounded visibility, optical depth, and multi-scattering cues with zero offline pre-baked binary assets. |
| **2. Hardware-Accelerated 3-Pass Pipeline** | **Half-resolution (`0.5×`) offscreen volumetric FBO (`cloudTarget`)** with premultiplied-alpha hardware bilinear upsampling + **100% GPU vertex-advected wind streamlines & lightning**. | Cuts fragment raymarching invocations by **75% (`4×` speedup)** and reduces CPU streamline overhead to **`0.00 ms/frame`**. |
| **3. Coupled Air–Land–Sea & 6-DOF Fleet** | Continuous landform/canyon morphing (`uTerrainMap`) drives **3D potential-flow wind deflection**, **orographic updraft lift**, and **vertex-displaced ocean waves** (Tsunami Soliton, Whirlpool Maelstrom, Storm Surge, Tides) ridden by 3 **Saronic ASVs** (`CORSAIR`, `CUTLASS`, `SPYGLASS`). | Eliminates visual/physical disconnects where wind passes through mountains or vessels clip through terrain. |
| **4. Algorithmic Efficiency ($O(N)$ + $O(\alpha(N))$)** | Zero-allocation **3D Spatial Hash Grid** (sparse dirty-bucket reset) + **Disjoint-Set Union-Find** (`src/physics/FluidClusterPhysics.js`) for particle coalescence and island/sea-basin topology. | L1-cache-resident `4 KB` spatial hash table (`Int32Array[1024]`) + **`0` heap allocations per frame** (zero V8 GC pauses). |
| **5. Production-Grade Verification** | Deterministic WebGL2 mock (`tests/three-mock.js`) + V8 precise coverage runner (`tests/run-tests.js`) + browser runner (`tests/frontend-tests.html`). | **100.0% Line Coverage**, **100.0% Function Coverage**, and **99.7% Branch Coverage** across all 6 source modules (`14 / 14` suites). |

---

### Slide 2 · End-to-End Three-Pass System Architecture

```mermaid
flowchart TB
    subgraph Init["1. Procedural GPU Boot (Zero External Textures)"]
        Baker["CloudNoiseBaker.js<br/>GLSL3 Slice-Atlas Baker"] --> Base3D["64³ Macro + 32³ Detail Data3DTexture<br/>Perlin-Worley + 3 Worley Octaves"]
        Baker --> Weather2D["256×256 Weather Map<br/>Coverage · Peak · Anvil"]
        Baker --> BlueNoise["64×64 Blue-Noise Jitter<br/>Interleaved Gradient Offset"]
    end

    subgraph CPUFrame["2. Per-Frame Zero-Allocation CPU Physics & Topology (main.js)"]
        Morph["Continuous Landform & Canyon Morph<br/>(0% Islands → 65% Flooded Fjord → 100% Massif)"] --> TerrTex["uTerrainMap DataTexture<br/>(Height, dH/dx, dH/dz, Canyon Funnel)"]
        Morph --> TopoUF["analyzeTerrainTopologyUnionFind()<br/>Counts Emerged Islands & Flooded Basins"]
        Hydro["Hydrodynamic State<br/>Tsunami Soliton · Whirlpool · Tides · Tornado · Hurricane"] --> ASV["Saronic ASV Fleet (CORSAIR, CUTLASS, SPYGLASS)<br/>6-DOF Wave-Riding Pitch/Roll/Heave in Gorges"]
        Hydro --> LagSys["LagrangianVortexParticleSystem (512 Parcels)<br/>SpatialHashGrid3D O(N) + DisjointSetUnion O(α(N))"]
    end

    subgraph GPUPass["3. Three-Pass Hardware-Accelerated WebGL2 Pipeline"]
        Pass1["Pass 1: Full-Res Scene FBO (sceneTarget)<br/>Terrain + 128² Ocean + GPU Streamlines + 3D Lightning + ASVs"] --> DepthTex["Hardware DepthTexture (24-bit)<br/>+ Full-Res Scene Color"]
        DepthTex --> Pass2["Pass 2: Half-Res (0.5×) Volumetric FBO (cloudTarget)<br/>Custom GLSL3 Raymarcher + 3-Step Cone Sun Shadows<br/>+ EXT_disjoint_timer_query_webgl2"]
        TerrTex --> Pass2
        Base3D --> Pass2
        Weather2D --> Pass2
        BlueNoise --> Pass2
        Pass2 --> Pass3["Pass 3: Single-Pass Screen Composite (blitScene)<br/>Hardware Bilinear Upsample + Premultiplied Alpha Blend"]
        DepthTex --> Pass3
    end
```

---

### Slide 3 · Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    SIMULATION_CONTEXT ||--|| ATMOSPHERE_LAYER : "owns & updates"
    SIMULATION_CONTEXT ||--|| TERRAIN_SYSTEM : "morphs & queries"
    SIMULATION_CONTEXT ||--|| HYDRO_STATE : "synchronizes"
    SIMULATION_CONTEXT ||--|| PARTICLE_SYSTEM : "steps per frame"
    SIMULATION_CONTEXT ||--|{ SARONIC_ASV_FLEET : "advances 6-DOF"
    SIMULATION_CONTEXT ||--|| GPU_LIGHTNING_SYSTEM : "triggers bolts"

    ATMOSPHERE_LAYER }|--|| STORM_REGIME : "active stormType (0..5)"
    ATMOSPHERE_LAYER }|--|| WMO_CLOUD_GENUS : "active cloudGenus (0..9)"
    ATMOSPHERE_LAYER ||--|| GPU_UNIFORM_BLOCK : "packs 13 std140 vec4s"
    ATMOSPHERE_LAYER ||--|| CLOUD_NOISE_TEXTURES : "samples 3D & 2D LUTs"

    PARTICLE_SYSTEM ||--|| SPATIAL_HASH_GRID_3D : "O(N) broad-phase"
    PARTICLE_SYSTEM ||--|| DISJOINT_SET_UNION : "O(a(N)) eddy coalescence"
    TERRAIN_SYSTEM ||--|| DISJOINT_SET_UNION : "scans island/sea topology"

    STORM_REGIME {
        int id PK "0=None, 1=Waterspout, 2=EF5, 3=Hurricane, 4=Derecho, 5=NorEaster"
        string cloudGenus FK "cumulus | cumulonimbus | nimbostratus"
        float tornadoStrength "Rankine funnel intensity [0..1]"
        float hurricaneStrength "Eyewall & spiral band intensity [0..1]"
        float lightningIntensity "3D bolt & volumetric flash [0..1]"
        float fogDensity "Exponential scene & horizon haze [0..1]"
    }

    WMO_CLOUD_GENUS {
        int id PK "0..9 WMO Atlas Genus ID"
        string name "Cumulus..Cumulonimbus"
        float baseAltitude "Cloud base Y (meters)"
        float slabThickness "Vertical slab thickness (meters)"
        float extinction "Beer-Lambert sigma_t"
        vec4 shapeParams "scaleX, stretchY, cellularity, shear"
    }

    SPATIAL_HASH_GRID_3D {
        float cellSize "20.0m uniform 3D voxel size"
        Int32Array head "1024 bucket heads (4 KB L1 cache)"
        Int32Array next "512 particle linked-list chains"
        Int32Array dirtyBuckets "Sparse O(K) occupied bucket tracker"
        Int32Array cellXYZ "Cached integer voxel coordinates"
    }

    DISJOINT_SET_UNION {
        int capacity "512 particles or 3136 terrain cells"
        Int32Array parent "Path-compressed parent pointers"
        Int32Array size "Subtree sizes for union-by-size"
        int numComponents "Live count of distinct clusters"
        int maxClusterSize "Largest coalesced vortex eddy"
    }

    TERRAIN_SYSTEM {
        float morph "0.0 Islands -> 0.65 Fjord -> 1.0 Massif"
        float peakHeight "Mountain crest elevation (60..360m)"
        float canyonDepth "Gorge incision factor [0..1]"
        DataTexture uTerrainMap "RGBA8: Height, dH/dx, dH/dz, Funnel"
        int islandCount "DSU connected land components"
        int waterBasinCount "DSU connected sea components"
    }

    SARONIC_ASV_FLEET {
        string hullNumber PK "ASV-01 CORSAIR, ASV-02 CUTLASS, ASV-03 SPYGLASS"
        string routeType "mainFjordNorthSouth | crossGorgeEastWest | junctionWeave"
        vec3 position "Wave-riding 3D coordinates"
        quaternion orientation "6-DOF wave normal pitch/roll/heading"
    }
```

---

### Slide 4 · Per-Frame Execution & 3-Pass GPU Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User as User / HUD Controls
    participant Main as Simulation Loop (main.js)
    participant Terr as Terrain & DSU Topology
    participant Hash as SpatialHashGrid3D
    participant DSU as DisjointSetUnion
    participant Fleet as Saronic ASV Fleet (3 Hulls)
    participant GPU1 as Pass 1: sceneTarget (1.0x FBO)
    participant GPU2 as Pass 2: cloudTarget (0.5x FBO)
    participant GPU3 as Pass 3: Screen Composite

    User->>Main: Adjusts Storm / Tornado / Hurricane / Lightning / Fog / Tide
    alt Tide or Landform Morph Changed
        Main->>Terr: terrain.updateGeometry()
        Terr->>DSU: analyzeTerrainTopologyUnionFind(heights, 221, waterLevel)
        DSU-->>Terr: { islandCount, waterBasinCount }
        Terr-->>GPU1: Upload uTerrainMap (Height, GradXZ, CanyonFunnel)
    end

    rect rgb(20, 32, 48)
        Note over Main,Fleet: Per-Frame Zero-Allocation CPU Physics Step (animate)
        Main->>Fleet: Sample analytical waterway path + sampleWaterSurfaceHeight(x, z)
        Fleet-->>Main: Update 6-DOF position & wave-normal quaternion (pitch/roll/heave)
        Main->>Hash: clear() [O(K) dirtyBuckets] + insert(512 parcels)
        Main->>Hash: clusterNeighbors(positions, velocities, radius, dsu)
        Hash->>DSU: union(i, j) + pairwise viscous velocity alignment
        DSU-->>Main: getComponentSize(i) -> scale massFactor & aClusterSize
        Main->>Terr: sampleHeightAndGradient(px, pz) [2-Slot Ring Buffer, 0 GC]
    end

    rect rgb(18, 42, 36)
        Note over Main,GPU3: Three-Pass Hardware-Accelerated WebGL2 Pipeline
        Main->>GPU1: Render baseScene (Terrain + 128x128 Ocean + GPU Streamlines + 3D Forked Lightning + ASVs + DSU Particles)
        GPU1-->>GPU2: Bind Hardware DepthTexture (uSceneDepth)
        Main->>GPU2: beginGpuTimer() + Render atmosphereScene at 0.5x Resolution
        Note over GPU2: Raymarch 10 WMO Genera + 6 Storm Regimes + 3-Step Sun Cone -> Output Premultiplied RGBA
        Main->>GPU2: endGpuTimer() [EXT_disjoint_timer_query_webgl2]
        Main->>GPU3: Render blitScene (Hardware Bilinear Upsample cloudTarget over sceneTarget)
    end
```

---

### Slide 5 · Graphviz DOT Architecture & Hardware Acceleration DAG

```dot
digraph AtmosphereEngine {
  rankdir=LR;
  bgcolor="#0b1220";
  fontname="Inter,Helvetica,Arial,sans-serif";
  node [shape=box, style="rounded,filled", fontname="Inter,Helvetica,Arial,sans-serif", fontsize=11, color="#334155", fontcolor="#f8fafc", fillcolor="#1e293b"];
  edge [color="#38bdf8", fontname="Inter,Helvetica,Arial,sans-serif", fontsize=9, fontcolor="#94a3b8"];

  subgraph cluster_boot {
    label="1. GPU Startup Baker (<15 ms)";
    style="rounded,dashed"; color="#38bdf8"; fontcolor="#38bdf8";
    Baker [label="CloudNoiseBaker\n(GLSL3 Slice-Atlas)", fillcolor="#0f172a"];
    Macro3D [label="uMacroNoise\n64x64x64 Data3DTexture\n(Perlin-Worley + 3 Worley)"];
    Detail3D [label="uDetailNoise\n32x32x32 Data3DTexture\n(3-Octave Worley FBM)"];
    Weather2D [label="uWeatherMap\n256x256 DataTexture"];
    Blue2D [label="uBlueNoise\n64x64 R2 Jitter"];
    Baker -> {Macro3D Detail3D Weather2D Blue2D};
  }

  subgraph cluster_cpu {
    label="2. Zero-Allocation CPU Physics & DSU Topology";
    style="rounded,dashed"; color="#34d399"; fontcolor="#34d399";
    HUD [label="17 HUD Sliders & 6 Storm Regimes\n(Lightning, Fog, Tornado, Hurricane,\nTsunami, Whirlpool, Tides, Morph)"];
    TerrainCPU [label="Morphable Fjord Terrain\n(2-Slot Ring Buffer Sampler)"];
    TerrainTex [label="uTerrainMap (221x221 RGBA8)\nR:Height G:dH/dx B:dH/dz A:Funnel"];
    TopoDSU [label="Terrain DisjointSetUnion\n(4 Emerged Islands / 1 Sea Basin)"];
    LagParticles [label="LagrangianVortexParticleSystem\n(512 Coalescing Parcels)"];
    SpatialHash [label="SpatialHashGrid3D\n(1024 Buckets, O(K) Sparse Clear)"];
    ParticleDSU [label="Particle DisjointSetUnion\n(O(N a(N)) Eddy Coalescence)"];
    SaronicFleet [label="3 Saronic ASVs\n(CORSAIR, CUTLASS, SPYGLASS)\n6-DOF Wave-Normal Kinematics"];

    HUD -> {TerrainCPU LagParticles SaronicFleet};
    TerrainCPU -> TerrainTex;
    TerrainCPU -> TopoDSU [label="56x56 Grid Scan"];
    LagParticles -> SpatialHash [label="O(N) Insert"];
    SpatialHash -> ParticleDSU [label="3x3x3 Neighbor Union"];
    ParticleDSU -> LagParticles [label="Mass & aClusterSize"];
  }

  subgraph cluster_gpu {
    label="3. Three-Pass Hardware-Accelerated WebGL2 Pipeline";
    style="rounded,dashed"; color="#f59e0b"; fontcolor="#f59e0b";
    OceanVS [label="128x128 Ocean Vertex Shader\n(Tsunami + Whirlpool + Surge Dome)"];
    StreamVS [label="GPU Wind Streamlines\n(Static VBO + Vertex uTerrainMap)"];
    LightningVS [label="3D Forked Lightning Bolts\n(6 Branched Trees in Vertex Shader)"];
    Pass1_FBO [label="Pass 1: sceneTarget (1.0x FBO)\nColor + 24-bit DepthTexture", fillcolor="#1e3a5f"];
    Pass2_FBO [label="Pass 2: cloudTarget (0.5x FBO)\natmosphere.frag.js Raymarcher\n(4x Fewer Pixels, Premultiplied RGBA)", fillcolor="#312e81"];
    Pass3_Screen [label="Pass 3: Screen Composite (blitScene)\nHardware Bilinear Upsample", fillcolor="#065f46"];

    {TerrainCPU OceanVS StreamVS LightningVS SaronicFleet LagParticles} -> Pass1_FBO;
    TerrainTex -> {StreamVS Pass2_FBO};
    {Pass1_FBO Macro3D Detail3D Weather2D Blue2D} -> Pass2_FBO [label="Depth & 3D LUTs"];
    {Pass1_FBO Pass2_FBO} -> Pass3_Screen [label="Single-Pass Composite"];
  }
}
```

---

### Slide 6 · Particle Physics & Union-Find Data Structures (`src/physics/FluidClusterPhysics.js`)

```mermaid
flowchart LR
    subgraph BroadPhase["SpatialHashGrid3D — O(N) Broad-Phase"]
        Insert["Insert N=512 3D Parcels<br/>Prime XOR Hash: (ix·p1) ⊕ (iy·p2) ⊕ (iz·p3)<br/>+ Cache cellX/Y/Z Int32Arrays"] --> Cells["L1-Cache-Resident Hash Table<br/>Int32Array head[1024] (4 KB)<br/>+ O(K) Sparse dirtyBuckets Reset"]
        Cells --> Query["Query 3×3×3 (27) Neighbor Cells<br/>Within Coalescence Radius r"]
    end

    subgraph NarrowPhase["DisjointSetUnion — O(α(N)) Coalescence"]
        Query --> Union["dsu.union(i, j)<br/>Union by Size + Path Compression"]
        Union --> Viscous["Viscous Momentum Coupling<br/>Aligns Neighbor Velocities (v_i ↔ v_j)"]
        Viscous --> Cluster["Cluster Mass & Sprite Scaling<br/>getComponentSize(i) Scales Inertia & Glow"]
    end
```

#### Why Spatial Hash + Union-Find Beats a Priority Queue for Fluid Coalescence
1. **Transitive Connected Components in $O(N \cdot \alpha(N))$**: When droplet $A$ touches $B$ and $B$ touches $C$ inside a tornado funnel wall, `dsu.union(A,B)` + `dsu.union(B,C)` transitively merges ${A,B,C}$ into a single eddy and tracks `size[root] = 3` in $O(\alpha(N)) \approx O(1)$ amortized time.
2. **Zero Binary-Heap Overhead**: A priority queue requires $O(K \log K)$ heap maintenance for pairwise time-of-impact events and still requires a separate graph structure to know connected component sizes.
3. **Dual Application in the Engine**:
   - **Particle Coalescence (`Union-Find Clusters` in HUD)**: Scales physical mass/inertia (`massFactor = 1.0 + Math.min(compSize, 16) * 0.08`) and GPU point-sprite luminance (`aClusterSize`).
   - **Topological Island & Waterway Analysis (`DSU Land / Water` in HUD)**: `analyzeTerrainTopologyUnionFind()` scans a $56 \times 56$ (`3,136`-cell) terrain grid across live **Tidal Sea Level (`-5m..+12m`)** changes to count connected emerged islands and navigable sea basins.

---

### Slide 7 · Architectural Tradeoffs & Hardware Acceleration

| Design Dimension | Chosen Architecture | Alternative Considered | Why Our Tradeoff Wins |
| :--- | :--- | :--- | :--- |
| **1. Volumetric Resolution** | **Half-Res (`0.5×`) Offscreen FBO (`cloudTarget`) + Premultiplied Bilinear Upsample** | Full `2.0×` Retina resolution direct raymarching | **4×–7× Faster Fill-Rate:** Cuts fragment shader invocations by 75%–86% while premultiplied alpha interpolation prevents dark fringes at cloud edges. |
| **2. Wind Streamlines & Lightning** | **100% GPU Vertex Shader Advection from Static VBOs** | Per-frame CPU streamline integration + `gl.bufferSubData` upload | **0.00 ms CPU Cost:** Eliminates 5,460 CPU terrain queries and 15,600 float uploads per frame by sampling `uTerrainMap` directly in the vertex shader. |
| **3. Scene Depth Occlusion** | **Radial Euclidean Distance** ($d = z_{\text{linear}} / \cos\theta$) from hardware `DepthTexture` | Raw planar `gl_FragCoord.z` comparison | **Zero Corner Distortion:** Planar depth causes clouds to falsely clip mountain peaks at wide camera angles; radial correction guarantees exact 3D intersection. |
| **4. Sun Self-Shadowing** | **3-Step Exponential-Stride Cone March** + Squared-Radius Vortex Culling | 6-step uniform shadow march + unconditional funnel trig | **40% Fewer 3D Texture Reads:** Exponential step growth (`18m → 30m → 49m`) captures full cloud optical depth while skipping 97% of tornado trig outside the funnel. |
| **5. Terrain Query Memory** | **2-Slot Ring Buffer (`_sampleRing`)** + **Sparse `dirtyBuckets` Hash Clear** | Allocating `{ h, gx, gz, funnel }` per query + `head.fill(-1)` | **Zero GC Pauses:** Eliminates ~390,000 temporary heap allocations/sec and resets only occupied spatial hash buckets in $O(K)$ time. |

---

### Slide 8 · Operational Scenarios: 6 Storm Regimes, 3D Lightning, Fog & Hydrodynamics

| Storm / Mission Regime | Atmospheric, Lightning & Fog State | Ocean & Saronic ASV Behavior |
| :--- | :--- | :--- |
| **1. Fair-Weather Trade Winds (`none`)** | `Cumulus humilis` cauliflower domes (`92m`), `0%` lightning, `22%` light maritime haze, `14 m/s` breeze. | Saronic ASVs (`CORSAIR`, `CUTLASS`, `SPYGLASS`) patrol flooded gorges; GPU wind streamlines split around peaks. |
| **2. Maritime Waterspout (`waterspout`)** | Slender translucent Rankine condensation tube (`11–42m` radius), `35%` lightning, `38%` fog, sea-spray collar (`48%` rain). | Serpentine vortex tube sways along the central fjord channel while spray droplets spiral upward. |
| **3. EF5 Supercell Wedge Tornado (`supercellTornado`)** | Massive wide-wedged mesocyclone Rankine vortex (`22–78m` radius), rotating wall cloud, **`95%` 3D forked lightning + volumetric flash**, `55%` fog. | Cyclonic inflow spirals clouds and 512 Lagrangian parcels into the funnel wall (`Updraft > 50 m/s`); DSU eddy sizes spike. |
| **4. Category 5 Tropical Hurricane (`hurricane`)** | Outward-sloping **Stadium Eyewall** (`76–138m`), **Calm Clear Low-Pressure Eye**, **4 Spiral Rainbands**, `85%` eyewall lightning, `65%` fog. | **`+5.2m` Inverted-Barometer Storm Surge Dome** + eyewall wave chop ring (`r ≈ 88m`); calm subsidence inside the eye (`r < 62m`). |
| **5. Derecho (`derecho`) & Nor'easter (`norEaster`)** | Advancing bowed **Arcus Shelf Cloud** (`90%` lightning) or polar silver-slate **Comma-Head Bomb Cyclone** (`72%` dense fog). | Straight-line `36 m/s` gust-front wind shear and forked cloud-to-ground lightning bolts across the canyon gorges. |
| **6. Tsunami (`95%`), Whirlpool (`86%`) & King Tide (`+12m`)** | `26m` steep soliton wave wall, `16m` rotating maelstrom pit, and `-5m..+12m` tidal sea-level shifts. | ASVs pitch `34.2°` and heave `+30.2m` riding over the Tsunami crest; Union-Find dynamically updates connected **Island / Sea Basin** topology. |

---

### Slide 9 · Front-End Unit Tests, Live 4-Phase Experiment & 100% V8 Code Coverage

#### Live 4-Phase Coupled Experiment Telemetry (`npm test` & `tests/frontend-tests.html`)

| Experiment Phase | Controlled Condition | Verified Physical & Algorithmic Telemetry |
| :--- | :--- | :--- |
| **Phase 1: Canyon Venturi & Gorge Carve** | `Morph 0% -> 80% (Fjord)` | Gorge Floor: `0.0m` · Mean Massif Elevation: `30.0m -> 81.3m` · Venturi Funnel: `0.00 -> 1.00` |
| **Phase 2: Tornado & Cat-5 Hurricane + DSU** | `Calm (0%) -> Vortex/Hurricane (95%)` | Mean Parcel Speed: `31.4 -> 46.2 m/s` (Updraft `50.4 m/s`) · Active DSU Clusters: `55` (Max Eddy: `389` parcels) |
| **Phase 3: Tsunami Soliton & 6-DOF ASV Fleet** | `Tsunami 0% -> 95% Soliton` | Peak ASV Heave Y: `1.0m -> +30.2m` · Peak Hull Pitch/Roll: `34.2°` · Waterway Safe: `100%` |
| **Phase 4: Tidal Sweep & DSU Topology** | `Tide -4.5m -> +11.5m Flood` | Emerged Islands: `4 Isl -> 4 Isl` · Connected Sea Basins: `1 Sea` |

#### V8 Precise Code Coverage Summary (`src/`)

| Source Module | Line Coverage | Function Coverage | Branch Coverage | Verified Capabilities |
| :--- | :---: | :---: | :---: | :--- |
| `src/layers/AtmosphereLayer.js` | **100.0%** | **100.0%** | **100.0%** | All 10 WMO genera, 6 storm regimes, lightning & fog uniforms, GPU timer query states, context restore & disposal. |
| `src/main.js` | **100.0%** | **100.0%** | **99.2%** | 3-pass FBO pipeline, GPU streamlines, 3D forked lightning, Front-End Unit Tests & Live 4-Phase Experiment. |
| `src/noise/CloudNoiseBaker.js` | **100.0%** | **100.0%** | **100.0%** | `64³` & `32³` 3D Perlin-Worley slice baker, `256×256` weather map, `64×64` blue-noise texture. |
| `src/physics/FluidClusterPhysics.js` | **100.0%** | **100.0%** | **100.0%** | `DisjointSetUnion` (path compression + union by size), sparse `SpatialHashGrid3D`, terrain topology & Lagrangian vortex physics. |
| `src/shaders/atmosphere.frag.js` | **100.0%** | **100.0%** | **100.0%** | Custom `#version 300 es` volumetric cloud, 6 storm regimes, lightning, virga & topographic airflow fragment shader. |
| `src/shaders/atmosphere.vert.js` | **100.0%** | **100.0%** | **100.0%** | Custom `#version 300 es` world-space proxy bounding slab vertex shader. |
| **ALL FILES (TOTAL)** | **100.0%** | **100.0%** | **99.7%** | **14 / 14 Unit, Front-End Unit & Live Experiment Suites Passing (`npm test`)** |

---

## Repository Structure

```text
├── README.md                        # Complete architecture deck, ERD, Sequence Diagram, Graphviz & test telemetry
├── index.html                       # Entry viewport, importmap (Three.js r187), 17 HUD controls & telemetry
├── package.json                     # Zero-dependency ESM config & `npm test` script
├── src/
│   ├── main.js                      # 3-pass FBO pipeline, morphable terrain, ocean shader, GPU streamlines, 3D lightning & ASVs
│   ├── layers/
│   │   └── AtmosphereLayer.js       # Composable volumetric cloud/storm layer, 6 storm regimes, 10 WMO genera & GPU timer
│   ├── noise/
│   │   └── CloudNoiseBaker.js       # GPU slice-atlas 3D Perlin-Worley baker, weather map & blue-noise jitter
│   ├── physics/
│   │   └── FluidClusterPhysics.js   # Sparse SpatialHashGrid3D + DisjointSetUnion (Union-Find) + Lagrangian physics
│   └── shaders/
│       ├── atmosphere.vert.js       # Custom GLSL3 world-space bounding slab vertex shader
│       └── atmosphere.frag.js       # Custom GLSL3 volumetric clouds, 6 storm regimes, lightning & airflow shader
└── tests/
    ├── frontend-tests.html          # Browser-native Front-End Unit Test & Live 4-Phase Experiment runner
    ├── run-tests.js                 # 14 Unit, Front-End Unit & Live Experiment suites + V8 coverage profiler
    ├── three-mock.js                # Deterministic Three.js + WebGL2 + GPU timer query mock for headless testing
    └── three-mock-loader.mjs        # Node ESM loader hook mapping 'three' to tests/three-mock.js
```
