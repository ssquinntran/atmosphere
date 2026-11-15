import * as THREE from 'three';

/**
 * Disjoint-Set Union-Find (DSU) with Path Compression and Union by Size.
 * Time Complexity: O(α(N)) amortized per find/union operation (inverse Ackermann, effectively O(1)).
 *
 * Used for:
 * 1. Dynamic coalescence of nearby Lagrangian sea-spray / vortex debris particles into
 *    coherent physical eddies & foam rafts (scaling mass, drag, and luminance by cluster size).
 * 2. Topological connectivity analysis of flooded tidal waterways and emerged island/mountain
 *    landmasses as the user changes Tidal Sea Level or Landform Morph sliders.
 */
export class DisjointSetUnion {
  constructor(capacity) {
    this.capacity = capacity;
    this.parent = new Int32Array(capacity);
    this.size = new Int32Array(capacity);
    this.numComponents = capacity;
    this.maxClusterSize = 1;
    this.reset(capacity);
  }

  reset(activeCount = this.capacity) {
    const n = Math.min(activeCount, this.capacity);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this.size[i] = 1;
    }
    this.numComponents = n;
    this.maxClusterSize = n > 0 ? 1 : 0;
  }

  find(i) {
    let root = i;
    while (root !== this.parent[root]) {
      root = this.parent[root];
    }
    // Path compression: point all visited nodes directly to root
    let curr = i;
    while (curr !== root) {
      const nxt = this.parent[curr];
      this.parent[curr] = root;
      curr = nxt;
    }
    return root;
  }

  union(a, b) {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return rootA;

    // Union by size: attach smaller tree under larger tree
    if (this.size[rootA] < this.size[rootB]) {
      const tmp = rootA;
      rootA = rootB;
      rootB = tmp;
    }
    this.parent[rootB] = rootA;
    this.size[rootA] += this.size[rootB];
    if (this.size[rootA] > this.maxClusterSize) {
      this.maxClusterSize = this.size[rootA];
    }
    this.numComponents--;
    return rootA;
  }

  getComponentSize(i) {
    return this.size[this.find(i)];
  }
}

/**
 * 3D Uniform Spatial Hash Grid using flat typed arrays (head/next linked-list chains)
 * for zero-allocation O(N) broad-phase neighbor queries per frame.
 */
export class SpatialHashGrid3D {
  constructor(particleCapacity, cellSize = 18.0, tableSize = 4096) {
    this.cellSize = cellSize;
    this.invCellSize = 1.0 / cellSize;
    this.tableSize = tableSize; // Power of 2 for fast bitwise modulo
    this.tableMask = tableSize - 1;
    this.head = new Int32Array(tableSize).fill(-1);
    this.next = new Int32Array(particleCapacity);
    // Cache integer cell coordinates per particle to avoid redundant Math.floor in neighbor pass
    this.cellX = new Int32Array(particleCapacity);
    this.cellY = new Int32Array(particleCapacity);
    this.cellZ = new Int32Array(particleCapacity);
    // Track only occupied buckets for O(K) sparse clear instead of O(tableSize) full fill
    this.dirtyBuckets = new Int32Array(particleCapacity);
    this.dirtyCount = 0;
  }

  clear() {
    for (let i = 0; i < this.dirtyCount; i++) {
      this.head[this.dirtyBuckets[i]] = -1;
    }
    this.dirtyCount = 0;
  }

  _hashCell(cx, cy, cz) {
    // Large primes for spatial hashing (Teschner et al.)
    const h = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
    return h & this.tableMask;
  }

  insert(particleIndex, x, y, z) {
    const cx = Math.floor(x * this.invCellSize);
    const cy = Math.floor(y * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    this.cellX[particleIndex] = cx;
    this.cellY[particleIndex] = cy;
    this.cellZ[particleIndex] = cz;
    const bucket = this._hashCell(cx, cy, cz);
    if (this.head[bucket] === -1) {
      this.dirtyBuckets[this.dirtyCount++] = bucket;
    }
    this.next[particleIndex] = this.head[bucket];
    this.head[bucket] = particleIndex;
  }

  /**
   * Connects all particles within `radius` using the supplied DisjointSetUnion instance
   * and applies pairwise cohesive velocity alignment (flocking/coalescence).
   */
  clusterNeighbors(positions, velocities, count, radius, dsu) {
    const r2 = radius * radius;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const px = positions[i3];
      const py = positions[i3 + 1];
      const pz = positions[i3 + 2];

      const cx = this.cellX[i];
      const cy = this.cellY[i];
      const cz = this.cellZ[i];

      // Search 3x3x3 neighborhood cells
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = this._hashCell(cx + dx, cy + dy, cz + dz);
            let j = this.head[bucket];
            while (j !== -1) {
              if (j > i) {
                const j3 = j * 3;
                const diffX = positions[j3] - px;
                const diffY = positions[j3 + 1] - py;
                const diffZ = positions[j3 + 2] - pz;
                const distSq = diffX * diffX + diffY * diffY + diffZ * diffZ;
                if (distSq < r2) {
                  dsu.union(i, j);
                  // Weak viscous momentum coupling between coalesced droplet/foam parcels
                  const vxAvg = 0.5 * (velocities[i3] + velocities[j3]);
                  const vzAvg = 0.5 * (velocities[i3 + 2] + velocities[j3 + 2]);
                  velocities[i3] += (vxAvg - velocities[i3]) * 0.08;
                  velocities[j3] += (vxAvg - velocities[j3]) * 0.08;
                  velocities[i3 + 2] += (vzAvg - velocities[i3 + 2]) * 0.08;
                  velocities[j3 + 2] += (vzAvg - velocities[j3 + 2]) * 0.08;
                }
              }
              j = this.next[j];
            }
          }
        }
      }
    }
  }
}

/**
 * Computes connected landmass islands and connected flooded waterway components
 * on a downsampled terrain grid using Disjoint-Set Union-Find.
 */
export function analyzeTerrainTopologyUnionFind(heights, gridRes, waterLevel) {
  const step = 4; // Downsample 221x221 -> 56x56 (3,136 cells) for fast topological scan
  const subRes = Math.floor((gridRes - 1) / step) + 1;
  const totalCells = subRes * subRes;
  const dsu = new DisjointSetUnion(totalCells);
  const isLand = new Uint8Array(totalCells);

  for (let sz = 0; sz < subRes; sz++) {
    const iz = Math.min(gridRes - 1, sz * step);
    for (let sx = 0; sx < subRes; sx++) {
      const ix = Math.min(gridRes - 1, sx * step);
      const h = heights[iz * gridRes + ix];
      const cellIdx = sz * subRes + sx;
      isLand[cellIdx] = h > waterLevel + 1.5 ? 1 : 0;
    }
  }

  // Union 4-connected neighbors that share the same phase (Land-Land or Water-Water)
  for (let sz = 0; sz < subRes; sz++) {
    for (let sx = 0; sx < subRes; sx++) {
      const idx = sz * subRes + sx;
      const phase = isLand[idx];
      if (sx + 1 < subRes && isLand[idx + 1] === phase) {
        dsu.union(idx, idx + 1);
      }
      if (sz + 1 < subRes && isLand[idx + subRes] === phase) {
        dsu.union(idx, idx + subRes);
      }
    }
  }

  // Count significant land islands (size >= 4 cells) and water basins (size >= 6 cells)
  const seenRoots = new Set();
  let islandCount = 0;
  let waterBasinCount = 0;
  for (let i = 0; i < totalCells; i++) {
    const r = dsu.find(i);
    if (!seenRoots.has(r)) {
      seenRoots.add(r);
      const sz = dsu.size[r];
      if (isLand[r] === 1 && sz >= 4) {
        islandCount++;
      } else if (isLand[r] === 0 && sz >= 6) {
        waterBasinCount++;
      }
    }
  }

  return { islandCount, waterBasinCount };
}

/**
 * Lagrangian Particle Physics + Spatial Hash + Union-Find Coalescence System.
 * Simulates sea-spray, foam rafts, and tornado/whirlpool vortex debris parcels under:
 * - Rankine Tornado Vortex 3D velocity field (tangential swirl, radial inflow, helical updraft)
 * - Maelstrom Whirlpool surface suction & angular spin
 * - Tsunami soliton orbital wave surge & tidal sea-level buoyancy
 * - Quadratic aerodynamic drag & topographic slope collision
 * - O(N) SpatialHashGrid3D + O(N α(N)) DisjointSetUnion cluster detection
 */
export class LagrangianVortexParticleSystem {
  constructor(count = 512) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.clusterSizes = new Float32Array(count);
    this.phases = new Float32Array(count); // 0 = surface foam/spray, 1 = airborne vortex parcel

    this.dsu = new DisjointSetUnion(count);
    this.spatialGrid = new SpatialHashGrid3D(count, 20.0, 1024);

    this.activeClusters = count;
    this.largestCluster = 1;

    for (let i = 0; i < count; i++) {
      this._respawnParticle(i, true);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aClusterSize', new THREE.BufferAttribute(this.clusterSizes, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(this.phases, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aClusterSize;
        attribute float aPhase;
        varying float vClusterFactor;
        varying float vPhase;
        varying float vDistFade;

        void main() {
          vClusterFactor = clamp((aClusterSize - 1.0) / 14.0, 0.0, 1.0);
          vPhase = aPhase;

          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mvPosition.z, 10.0);
          vDistFade = 1.0 - smoothstep(280.0, 680.0, dist);

          // Coalesced Union-Find clusters render larger and brighter
          float basePointSize = mix(4.2, 10.5, vClusterFactor) * mix(1.0, 1.35, aPhase);
          gl_PointSize = clamp(basePointSize * (240.0 / dist), 1.5, 16.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vClusterFactor;
        varying float vPhase;
        varying float vDistFade;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float r2 = dot(uv, uv);
          if (r2 > 0.25) discard;

          float radialAlpha = smoothstep(0.25, 0.02, r2);
          // Single droplets are pale sea-spray blue; large Union-Find coalesced clusters glow cyan-white
          vec3 sprayCol = mix(vec3(0.58, 0.85, 0.98), vec3(0.95, 0.99, 1.0), vClusterFactor);
          vec3 vortexCol = mix(vec3(0.75, 0.88, 1.0), vec3(0.35, 0.92, 1.0), vClusterFactor);
          vec3 col = mix(sprayCol, vortexCol, vPhase);

          float alpha = radialAlpha * vDistFade * mix(0.38, 0.85, vClusterFactor);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  _respawnParticle(i, initial = false) {
    const i3 = i * 3;
    // Spawn near the central fjord & gorge waterways
    const angle = Math.random() * Math.PI * 2.0;
    const radius = initial ? Math.random() * 280.0 : 25.0 + Math.random() * 210.0;
    this.positions[i3] = Math.cos(angle) * radius;
    this.positions[i3 + 1] = Math.random() * 25.0 + 1.0;
    this.positions[i3 + 2] = Math.sin(angle) * radius;

    this.velocities[i3] = (Math.random() - 0.5) * 8.0;
    this.velocities[i3 + 1] = Math.random() * 3.0;
    this.velocities[i3 + 2] = (Math.random() - 0.5) * 8.0;

    this.clusterSizes[i] = 1.0;
    this.phases[i] = 0.0;
  }

  update(dt, params) {
    const {
      windVecXZ,
      tornadoStrength,
      tornadoCenterXZ,
      hurricaneStrength = 0.0,
      whirlpoolStrength,
      whirlpoolCenterXZ,
      tsunamiStrength,
      tsunamiZ,
      waterLevel,
      cloudBaseY,
      sampleTerrain,
      sampleWaterHeight,
    } = params;

    const n = this.count;
    const pos = this.positions;
    const vel = this.velocities;

    // 1. Rebuild 3D Spatial Hash Grid in O(N)
    this.spatialGrid.clear();
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this.spatialGrid.insert(i, pos[i3], pos[i3 + 1], pos[i3 + 2]);
    }

    // 2. Run Disjoint-Set Union-Find clustering across neighboring cells in O(N α(N))
    this.dsu.reset(n);
    const coalesceRadius = 15.0 + tornadoStrength * 8.0 + hurricaneStrength * 7.0 + whirlpoolStrength * 6.0;
    this.spatialGrid.clusterNeighbors(pos, vel, n, coalesceRadius, this.dsu);

    this.activeClusters = this.dsu.numComponents;
    this.largestCluster = this.dsu.maxClusterSize;

    // 3. Integrate 3D Lagrangian forces (Gravity, Buoyancy, Drag, Rankine Tornado, Whirlpool, Tsunami, Terrain)
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let px = pos[i3];
      let py = pos[i3 + 1];
      let pz = pos[i3 + 2];

      let vx = vel[i3];
      let vy = vel[i3 + 1];
      let vz = vel[i3 + 2];

      const compSize = this.dsu.getComponentSize(i);
      this.clusterSizes[i] = compSize;
      // Larger coalesced Union-Find clusters have higher inertia
      const massFactor = 1.0 + Math.min(compSize, 16) * 0.08;

      // Ambient wind + topographic deflection
      const terr = sampleTerrain(px, pz);
      let airVx = windVecXZ.x * (1.0 + terr.funnel * 0.4);
      let airVy = 0.0;
      let airVz = windVecXZ.y * (1.0 + terr.funnel * 0.4);

      if (terr.h > py - 35.0) {
        const blk = Math.min(1.6, Math.max(0.0, (terr.h - (py - 35.0)) / 65.0));
        airVx -= terr.gx * 45.0 * blk;
        airVz -= terr.gz * 45.0 * blk;
        airVy += Math.max(0.0, (windVecXZ.x * terr.gx + windVecXZ.y * terr.gz) * 0.85);
      }

      // A) Rankine Tornado / Waterspout 3D Vortex Field
      let inTornado = 0.0;
      if (tornadoStrength > 0.01) {
        const dxT = px - tornadoCenterXZ.x;
        const dzT = pz - tornadoCenterXZ.y;
        const r2T = dxT * dxT + dzT * dzT;

        if (r2T < 44100.0) {
          const rT = Math.sqrt(r2T) + 0.1;
          const coreRadius = 26.0 + (Math.max(0.0, py - waterLevel) / Math.max(cloudBaseY, 80.0)) * 32.0;
          // Rankine tangential velocity: linear inside core (r < R), 1/r decay outside core
          const rankineSwirl =
            rT < coreRadius
              ? (rT / coreRadius)
              : (coreRadius / rT);
          const swirlSpeed = 115.0 * tornadoStrength * rankineSwirl;
          const invRT = 1.0 / rT;
          const tangX = -dzT * invRT;
          const tangZ = dxT * invRT;

          // Strong inward radial suction near sea surface; slight outward flare near cloud top
          const heightFrac = Math.min(1.0, Math.max(0.0, (py - waterLevel) / Math.max(cloudBaseY, 80.0)));
          const suctionSpeed = (1.0 - heightFrac * 1.15) * 58.0 * tornadoStrength * Math.exp(-rT / 95.0);
          const radX = -dxT * invRT;
          const radZ = -dzT * invRT;

          // Intense helical updraft inside the funnel wall
          const wallDelta = (rT - coreRadius * 0.75) / (coreRadius * 0.85);
          const wallProximity = Math.exp(-(wallDelta * wallDelta));
          const updraft = 82.0 * tornadoStrength * wallProximity;

          airVx += tangX * swirlSpeed + radX * suctionSpeed;
          airVz += tangZ * swirlSpeed + radZ * suctionSpeed;
          airVy += updraft;
          inTornado = wallProximity * tornadoStrength;
        }
      }

      // A2) Category 5 Hurricane Eyewall & Spiral Band Vortex Field
      if (hurricaneStrength > 0.01) {
        const dxH = px - tornadoCenterXZ.x;
        const dzH = pz - tornadoCenterXZ.y;
        const r2H = dxH * dxH + dzH * dzH;
        const eyeWallR = 88.0;
        if (r2H < 3844.0) {
          // Calm low-pressure Hurricane Eye (r < 62m) with gentle downward subsidence
          airVx *= 0.25;
          airVz *= 0.25;
          airVy -= 6.5 * hurricaneStrength;
        } else if (r2H < 176400.0) {
          // Intense cyclonic eyewall tangential wind + inward convergence toward eyewall ring
          const rH = Math.sqrt(r2H) + 0.1;
          const invRH = 1.0 / rH;
          const tangSpeed = 88.0 * hurricaneStrength * (eyeWallR * invRH);
          const ewDelta = (rH - eyeWallR) / 36.0;
          const eyeWallProximity = Math.exp(-(ewDelta * ewDelta));
          const inflowSpeed = ((rH - eyeWallR) * invRH) * 28.0 * hurricaneStrength;
          airVx += (-dzH * invRH) * tangSpeed - (dxH * invRH) * inflowSpeed;
          airVz += (dxH * invRH) * tangSpeed - (dzH * invRH) * inflowSpeed;
          airVy += 54.0 * hurricaneStrength * eyeWallProximity;
          inTornado = Math.max(inTornado, eyeWallProximity * hurricaneStrength);
        }
      }

      // B) Whirlpool Maelstrom Vortex Field (near water surface)
      if (whirlpoolStrength > 0.01 && py < waterLevel + 28.0) {
        const dxW = px - whirlpoolCenterXZ.x;
        const dzW = pz - whirlpoolCenterXZ.y;
        const r2W = dxW * dxW + dzW * dzW;
        if (r2W < 24025.0) {
          const rW = Math.sqrt(r2W) + 0.1;
          const invRW = 1.0 / rW;
          const coreW = 28.0;
          const swirlW = (rW < coreW ? rW / coreW : coreW * invRW) * 68.0 * whirlpoolStrength;
          const inwardW = 34.0 * whirlpoolStrength * Math.exp(-rW / 75.0);
          airVx += (-dzW * invRW) * swirlW - (dxW * invRW) * inwardW;
          airVz += (dxW * invRW) * swirlW - (dzW * invRW) * inwardW;
          airVy -= 18.0 * whirlpoolStrength * Math.exp(-rW / 35.0);
        }
      }

      // C) Tsunami Soliton Wave Surge Kick
      if (tsunamiStrength > 0.01) {
        const distWave = Math.abs(pz - tsunamiZ);
        if (distWave < 55.0 && py < waterLevel + 42.0) {
          const wavePulse = Math.exp(-Math.pow(distWave / 28.0, 2.0)) * tsunamiStrength;
          vy += 38.0 * wavePulse * dt;
          vz -= 52.0 * wavePulse * dt; // Surge propelling up-canyon
        }
      }

      // Aerodynamic drag relaxing particle velocity toward local 3D fluid velocity + gravity
      const dragRate = (2.4 / massFactor) * dt;
      vx += (airVx - vx) * dragRate;
      vz += (airVz - vz) * dragRate;

      const gravity = inTornado > 0.15 ? -3.5 : -14.5;
      vy += ((airVy - vy) * dragRate) + gravity * dt;

      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;

      // D) Ocean Surface Buoyancy & Wave Riding
      const localWaterY = sampleWaterHeight(px, pz);
      if (py < localWaterY + 0.8) {
        py = localWaterY + 0.8;
        // Foam rafts float on the waves unless lifted by tornado updraft or tsunami crest spray
        if (vy < 0.0) {
          vy = -vy * 0.25 + (tornadoStrength > 0.2 ? 6.0 * inTornado : 0.0);
        }
      }

      // E) Solid Terrain Slope Collision & Repulsion
      if (terr.h > localWaterY && py < terr.h + 2.5) {
        py = terr.h + 2.5;
        vx -= terr.gx * 18.0;
        vz -= terr.gz * 18.0;
        vy = Math.max(vy, 2.0);
      }

      // Respawn if lofted above cloud deck or drifted out of bounds
      if (
        py > cloudBaseY + 90.0 ||
        Math.abs(px) > 480.0 ||
        Math.abs(pz) > 480.0 ||
        (whirlpoolStrength > 0.3 && Math.hypot(px - whirlpoolCenterXZ.x, pz - whirlpoolCenterXZ.y) < 4.5)
      ) {
        this._respawnParticle(i, false);
        // Bias respawn near active tornado or tsunami crest when active
        if (tornadoStrength > 0.15 && Math.random() < 0.55) {
          const a = Math.random() * Math.PI * 2.0;
          const r = 12.0 + Math.random() * 65.0;
          this.positions[i3] = tornadoCenterXZ.x + Math.cos(a) * r;
          this.positions[i3 + 1] = localWaterY + 1.5 + Math.random() * 18.0;
          this.positions[i3 + 2] = tornadoCenterXZ.y + Math.sin(a) * r;
        }
        continue;
      }

      pos[i3] = px;
      pos[i3 + 1] = py;
      pos[i3 + 2] = pz;

      vel[i3] = vx;
      vel[i3 + 1] = vy;
      vel[i3 + 2] = vz;

      this.phases[i] = Math.min(1.0, Math.max(0.0, (py - localWaterY - 2.0) / 35.0));
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aClusterSize.needsUpdate = true;
    this.geo.attributes.aPhase.needsUpdate = true;
  }
}
