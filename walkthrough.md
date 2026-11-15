# Volumetric Atmosphere & Maritime Storm Engine — Walkthrough & Appendix

> [!IMPORTANT]
> **Deliverables Complete:**
> 1. **10 Recorded Extreme Weather & Capability Scenario Videos** captured at 30 FPS (`960×540` `.webm`) in [extreme_weather_10_videos.md](extreme_weather_10_videos.md) and [atmosphere_video_showcase.html](atmosphere_video_showcase.html).
> 2. **10-Slide Executive Architecture Deck + Appendix** in [atmosphere_slideshow_deck.html](atmosphere_slideshow_deck.html) and [atmosphere_architecture_slideshow.md](atmosphere_architecture_slideshow.md).
> 3. **14 / 14 Passing Test Suites** with **100.0% V8 Line Coverage, 100.0% Function Coverage, and 99.7% Branch Coverage** ([tests/run-tests.js](tests/run-tests.js)).

---

## 1. Appendix: What Union-Find Does & Why Spatial Hash + Union-Find Instead of a Priority Queue

We do **not** use a priority queue—instead, the simulation pairs a **3D Spatial Hash Grid (`SpatialHashGrid3D`)** for $O(N)$ broad-phase collision/proximity detection with **Disjoint-Set Union-Find (`DisjointSetUnion`)** for $O(N \cdot \alpha(N))$ connected-component clustering in [src/physics/FluidClusterPhysics.js](src/physics/FluidClusterPhysics.js).

### 1.1 What Union-Find Does in Your Simulation

Union-Find (`DisjointSetUnion`, implemented with Path Compression and Union by Size in flat `Int32Array` buffers) drives two real-time physical systems:

#### A. Particle Coalescence: Sea-Spray, Foam Rafts & Vortex Eddies
* **Broad-Phase Collision (`SpatialHashGrid3D`):** Every frame, `LagrangianVortexParticleSystem.update()` inserts all 512 3D sea-spray and vortex debris parcels into a 3D spatial hash grid (`20m` cells).
* **Narrow-Phase Collision & Union (`clusterNeighbors`):** In `SpatialHashGrid3D.clusterNeighbors()`, each particle checks its $3 \times 3 \times 3$ neighboring grid cells. Whenever two particles collide within the coalescence radius ($d < R_{\text{coalesce}}$):
  * **Topological Merge:** `dsu.union(i, j)` merges them into the same connected fluid eddy/foam cluster.
  * **Viscous Momentum Coupling:** Their horizontal velocities blend toward their pairwise mean (`0.08` viscous alignment) so connected droplets move coherently.
* **How Cluster Size Affects Physics & Shaders:**
  * **Physical Inertia:** Each particle queries its component size (`compSize`). Larger coalesced clusters receive a higher mass factor (`massFactor = 1.0 + Math.min(compSize, 16) * 0.08`), giving large foam rafts and tornado debris clusters higher momentum and lower aerodynamic drag (`dragRate = (2.4 / massFactor) * dt`).
  * **GPU Shader Sizing & Glow:** `this.clusterSizes[i] = compSize` is uploaded to the GPU as the `aClusterSize` vertex attribute. Isolated droplets (`size = 1`) render as small, translucent sea-spray points, while large Union-Find clusters bloom into bright cyan-white foam rafts and vortex filaments.
  * **Live Telemetry:** Displayed in the HUD under **Union-Find Clusters** (e.g., `69 (Max: 318)` — meaning 69 distinct eddies with the largest vortex funnel eddy containing 318 coalesced parcels).

#### B. Terrain Island & Flooded Waterway Topology
* Whenever you adjust the **Tidal Sea Level** (`-5m` to `+12m`) or **Landform & Canyon Morph** (`0% Islands → 100% Massif`) sliders, `analyzeTerrainTopologyUnionFind()` scans a $56 \times 56$ (`3,136-cell`) terrain grid.
* It classifies each cell as **Land** (`h > waterLevel + 1.5m`) or **Water**, and runs `dsu.union()` across 4-connected neighbors of the same phase:
  * **Connected Land components ($\ge 4$ cells):** Count the number of distinct emerged islands/peaks.
  * **Connected Water components ($\ge 6$ cells):** Verify whether the fjord gorges form a single navigable sea basin (`1 Sea`) or become isolated tidal pools.
* Displayed live in the HUD under **DSU Land / Water** (e.g., `4 Isl / 1 Sea`).

### 1.2 Why Spatial Hash + Union-Find Instead of a Priority Queue?

| Feature | 3D Spatial Hash Grid + Union-Find (Used Here) | Priority Queue (Min-Heap) Collision Clustering |
| :--- | :--- | :--- |
| **Time Complexity per Frame** | $O(N)$ spatial hash build + $O(N \cdot \alpha(N)) \approx O(N)$ union-find | $O(N \log N)$ or $O(K \log K)$ heap insertions & extract-min operations |
| **Memory Layout** | 100% flat `Int32Array`s (`parent`, `size`, `head`, `next`, `dirtyBuckets`), zero per-frame heap allocations | Requires maintaining a binary heap of collision pairs `(distSq, i, j)` or time-of-impact `(toi, i, j)` events |
| **Transitive Clustering ($A \leftrightarrow B, B \leftrightarrow C \implies \{A,B,C\}$)** | **Native $O(\alpha(N))$:** If droplet $A$ touches $B$ and $B$ touches $C$ inside a tornado funnel wall, `dsu.union(A,B)` + `dsu.union(B,C)` automatically merges all three into one cluster of size $3$. | Does not track connected components on its own—a priority queue only orders pairwise events by distance or time, requiring a separate graph/DSU structure anyway to know cluster sizes. |
| **Best Use Case** | Continuous fluid parcels, sea spray, foam rafts, vortex debris, and grid flood/island connectivity where hundreds of particles overlap simultaneously every frame. | Discrete Time-of-Impact (TOI) rigid-body collisions (e.g., billiard balls or resolving the exact millisecond two rigid Saronic ASV boat hulls collide). |

> [!TIP]
> **When a Min-Heap Priority Queue Would Be Used:** If you ever want to add **vessel-to-vessel rigid-body collision avoidance** (where the 3 Saronic ASVs predict their earliest Time-of-Closest-Approach in the canyon junction and steer around each other in priority order), a **Min-Heap Priority Queue on vessel pair Time-of-Impact (TOI)** would be the exact right data structure for the fleet layer, while keeping Spatial Hash + Union-Find for the fluid/vortex particles.

---

## 2. 10 Recorded Extreme Weather & Capability Scenario Videos

| # | Recorded Video File | Storm Regime | Cloud Genus / Mode | Highlights |
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
