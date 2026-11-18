import * as THREE from 'three';

/**
 * Disjoint-Set Union-Find (DSU) with Path Compression and Union by Size — O(α(N)) amortized.
 * Stored in flat pre-allocated Int32Array buffers so per-frame clustering produces zero GC pressure.
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

  /** Reset all elements [0..activeCount) to singleton sets in O(N). */
  reset(activeCount = this.capacity) {
    const n = Math.min(activeCount, this.capacity);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this.size[i] = 1;
    }
    this.numComponents = n;
    this.maxClusterSize = n > 0 ? 1 : 0;
  }

  /** Iterative two-pass find with full path compression to flatten tree depth. */
  find(i) {
    let root = i;
    while (root !== this.parent[root]) root = this.parent[root];
    let curr = i;
    while (curr !== root) {
      const nxt = this.parent[curr];
      this.parent[curr] = root;
      curr = nxt;
    }
    return root;
  }

  /** Merge sets containing a and b by attaching the smaller tree under the larger root. */
  union(a, b) {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return rootA;
    if (this.size[rootA] < this.size[rootB]) {
      const tmp = rootA;
      rootA = rootB;
      rootB = tmp;
    }
    this.parent[rootB] = rootA;
    const newSize = (this.size[rootA] += this.size[rootB]);
    if (newSize > this.maxClusterSize) this.maxClusterSize = newSize;
    this.numComponents--;
    return rootA;
  }

  getComponentSize(i) {
    return this.size[this.find(i)];
  }
}

/**
 * Zero-allocation 3D Spatial Hash Grid with O(K) sparse dirty-bucket clearing.
 * Uses intrusive linked lists (head[] + next[]) inside flat Int32Arrays instead of JS arrays/Maps.
 */
export class SpatialHashGrid3D {
  constructor(particleCapacity, cellSize = 18.0, tableSize = 4096) {
    this.cellSize = cellSize;
    this.invCellSize = 1.0 / cellSize;
    this.tableSize = tableSize;
    this.tableMask = tableSize - 1;
    this.head = new Int32Array(tableSize).fill(-1);
    this.next = new Int32Array(particleCapacity);
    this.cellX = new Int32Array(particleCapacity);
    this.cellY = new Int32Array(particleCapacity);
    this.cellZ = new Int32Array(particleCapacity);
    this.dirtyBuckets = new Int32Array(particleCapacity);
    this.dirtyCount = 0;
  }

  /** Reset only the hash buckets touched in the previous frame in O(K) time. */
  clear() {
    for (let i = 0; i < this.dirtyCount; i++) {
      this.head[this.dirtyBuckets[i]] = -1;
    }
    this.dirtyCount = 0;
  }

  /** Large-prime XOR spatial hash masked to power-of-two tableSize. */
  _hashCell(cx, cy, cz) {
    return ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) & this.tableMask;
  }

  /** Hash particleIndex into its 3D grid cell and prepend it to the bucket's intrusive list. */
  insert(particleIndex, x, y, z) {
    const cx = Math.floor(x * this.invCellSize);
    const cy = Math.floor(y * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    this.cellX[particleIndex] = cx;
    this.cellY[particleIndex] = cy;
    this.cellZ[particleIndex] = cz;
    const bucket = this._hashCell(cx, cy, cz);
    if (this.head[bucket] === -1) this.dirtyBuckets[this.dirtyCount++] = bucket;
    this.next[particleIndex] = this.head[bucket];
    this.head[bucket] = particleIndex;
  }

  /**
   * Narrow-phase 3x3x3 cell scan: merges nearby fluid parcels (d < radius) via DSU
   * and applies 0.08 pairwise viscous momentum coupling so eddies move coherently.
   */
  clusterNeighbors(positions, velocities, count, radius, dsu) {
    const r2 = radius * radius;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const px = positions[i3], py = positions[i3 + 1], pz = positions[i3 + 2];
      const cx = this.cellX[i], cy = this.cellY[i], cz = this.cellZ[i];

      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            let j = this.head[this._hashCell(cx + dx, cy + dy, cz + dz)];
            while (j !== -1) {
              if (j > i) {
                const j3 = j * 3;
                const dxP = positions[j3] - px;
                const dyP = positions[j3 + 1] - py;
                const dzP = positions[j3 + 2] - pz;
                if (dxP * dxP + dyP * dyP + dzP * dzP < r2) {
                  dsu.union(i, j);
                  const dvx = (velocities[j3] - velocities[i3]) * 0.04;
                  const dvz = (velocities[j3 + 2] - velocities[i3 + 2]) * 0.04;
                  velocities[i3] += dvx;
                  velocities[j3] -= dvx;
                  velocities[i3 + 2] += dvz;
                  velocities[j3 + 2] -= dvz;
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

// Reusable module-level buffers for zero-allocation terrain topology DSU scans
const TOPO_MAX_CELLS = 4096;
const _topoDsu = new DisjointSetUnion(TOPO_MAX_CELLS);
const _topoIsLand = new Uint8Array(TOPO_MAX_CELLS);

/**
 * Segments a downsampled coastal heightfield into 4-connected Land islands and Water basins
 * using Disjoint-Set Union-Find whenever sea level or landform morph changes.
 */
export function analyzeTerrainTopologyUnionFind(heights, gridRes, waterLevel) {
  const step = 4;
  const subRes = Math.floor((gridRes - 1) / step) + 1;
  const totalCells = subRes * subRes;
  _topoDsu.reset(totalCells);

  for (let sz = 0; sz < subRes; sz++) {
    const iz = Math.min(gridRes - 1, sz * step);
    for (let sx = 0; sx < subRes; sx++) {
      const ix = Math.min(gridRes - 1, sx * step);
      _topoIsLand[sz * subRes + sx] = heights[iz * gridRes + ix] > waterLevel + 1.5 ? 1 : 0;
    }
  }

  for (let sz = 0; sz < subRes; sz++) {
    for (let sx = 0; sx < subRes; sx++) {
      const idx = sz * subRes + sx;
      const phase = _topoIsLand[idx];
      if (sx + 1 < subRes && _topoIsLand[idx + 1] === phase) _topoDsu.union(idx, idx + 1);
      if (sz + 1 < subRes && _topoIsLand[idx + subRes] === phase) _topoDsu.union(idx, idx + subRes);
    }
  }

  let islandCount = 0;
  let waterBasinCount = 0;
  for (let i = 0; i < totalCells; i++) {
    if (_topoDsu.parent[i] === i) {
      const sz = _topoDsu.size[i];
      if (_topoIsLand[i] === 1 && sz >= 4) islandCount++;
      else if (_topoIsLand[i] === 0 && sz >= 6) waterBasinCount++;
    }
  }
  return { islandCount, waterBasinCount };
}

/**
 * Simulates 512 3D sea-spray, foam-raft, and vortex-debris parcels using Structure-of-Arrays
 * Float32Arrays, SpatialHashGrid3D broad-phase, and DisjointSetUnion coalescence.
 * Cluster sizes upload to the GPU as `aClusterSize` to scale inertia and foam bloom.
 */
export class LagrangianVortexParticleSystem {
  constructor(count = 512) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.clusterSizes = new Float32Array(count);
    this.phases = new Float32Array(count);

    this.dsu = new DisjointSetUnion(count);
    this.spatialGrid = new SpatialHashGrid3D(count, 20.0, 1024);
    this.activeClusters = count;
    this.largestCluster = 1;

    for (let i = 0; i < count; i++) this._respawnParticle(i, true);

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
          vec3 sprayCol = mix(vec3(0.58, 0.85, 0.98), vec3(0.95, 0.99, 1.0), vClusterFactor);
          vec3 vortexCol = mix(vec3(0.75, 0.88, 1.0), vec3(0.35, 0.92, 1.0), vClusterFactor);
          gl_FragColor = vec4(mix(sprayCol, vortexCol, vPhase), radialAlpha * vDistFade * mix(0.38, 0.85, vClusterFactor));
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  _respawnParticle(i, initial = false) {
    const i3 = i * 3;
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

    this.spatialGrid.clear();
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this.spatialGrid.insert(i, pos[i3], pos[i3 + 1], pos[i3 + 2]);
    }

    this.dsu.reset(n);
    const coalesceRadius = 15.0 + tornadoStrength * 8.0 + hurricaneStrength * 7.0 + whirlpoolStrength * 6.0;
    this.spatialGrid.clusterNeighbors(pos, vel, n, coalesceRadius, this.dsu);
    this.activeClusters = this.dsu.numComponents;
    this.largestCluster = this.dsu.maxClusterSize;

    const invCloudSpan = 1.0 / Math.max(cloudBaseY, 80.0);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      let vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];

      const compSize = this.dsu.size[this.dsu.parent[i]];
      this.clusterSizes[i] = compSize;
      const massFactor = 1.0 + Math.min(compSize, 16) * 0.08;

      const terr = sampleTerrain(px, pz);
      const funnelBoost = 1.0 + terr.funnel * 0.4;
      let airVx = windVecXZ.x * funnelBoost;
      let airVy = 0.0;
      let airVz = windVecXZ.y * funnelBoost;

      if (terr.h > py - 35.0) {
        const blk = Math.min(1.6, Math.max(0.0, (terr.h - (py - 35.0)) / 65.0));
        airVx -= terr.gx * 45.0 * blk;
        airVz -= terr.gz * 45.0 * blk;
        airVy += Math.max(0.0, (windVecXZ.x * terr.gx + windVecXZ.y * terr.gz) * 0.85);
      }

      let inTornado = 0.0;
      if (tornadoStrength > 0.01) {
        const dxT = px - tornadoCenterXZ.x;
        const dzT = pz - tornadoCenterXZ.y;
        const r2T = dxT * dxT + dzT * dzT;
        if (r2T < 44100.0) {
          const rT = Math.sqrt(r2T) + 0.1;
          const invRT = 1.0 / rT;
          const heightFrac = Math.min(1.0, Math.max(0.0, (py - waterLevel) * invCloudSpan));
          const coreRadius = 26.0 + heightFrac * 32.0;
          const rankineSwirl = rT < coreRadius ? rT / coreRadius : coreRadius * invRT;
          const swirlSpeed = 115.0 * tornadoStrength * rankineSwirl;
          const suctionSpeed = (1.0 - heightFrac * 1.15) * 58.0 * tornadoStrength * Math.exp(-rT / 95.0);
          const wallDelta = (rT - coreRadius * 0.75) / (coreRadius * 0.85);
          const wallProximity = Math.exp(-(wallDelta * wallDelta));

          airVx += (-dzT * swirlSpeed - dxT * suctionSpeed) * invRT;
          airVz += (dxT * swirlSpeed - dzT * suctionSpeed) * invRT;
          airVy += 82.0 * tornadoStrength * wallProximity;
          inTornado = wallProximity * tornadoStrength;
        }
      }

      if (hurricaneStrength > 0.01) {
        const dxH = px - tornadoCenterXZ.x;
        const dzH = pz - tornadoCenterXZ.y;
        const r2H = dxH * dxH + dzH * dzH;
        if (r2H < 3844.0) {
          airVx *= 0.25;
          airVz *= 0.25;
          airVy -= 6.5 * hurricaneStrength;
        } else if (r2H < 176400.0) {
          const rH = Math.sqrt(r2H) + 0.1;
          const invRH = 1.0 / rH;
          const eyeWallR = 88.0;
          const tangSpeed = 88.0 * hurricaneStrength * (eyeWallR * invRH);
          const ewDelta = (rH - eyeWallR) / 36.0;
          const eyeWallProximity = Math.exp(-(ewDelta * ewDelta));
          const inflowSpeed = (rH - eyeWallR) * invRH * 28.0 * hurricaneStrength;
          airVx += (-dzH * tangSpeed - dxH * inflowSpeed) * invRH;
          airVz += (dxH * tangSpeed - dzH * inflowSpeed) * invRH;
          airVy += 54.0 * hurricaneStrength * eyeWallProximity;
          inTornado = Math.max(inTornado, eyeWallProximity * hurricaneStrength);
        }
      }

      if (whirlpoolStrength > 0.01 && py < waterLevel + 28.0) {
        const dxW = px - whirlpoolCenterXZ.x;
        const dzW = pz - whirlpoolCenterXZ.y;
        const r2W = dxW * dxW + dzW * dzW;
        if (r2W < 24025.0) {
          const rW = Math.sqrt(r2W) + 0.1;
          const invRW = 1.0 / rW;
          const swirlW = (rW < 28.0 ? rW / 28.0 : 28.0 * invRW) * 68.0 * whirlpoolStrength;
          const inwardW = 34.0 * whirlpoolStrength * Math.exp(-rW / 75.0);
          airVx += (-dzW * swirlW - dxW * inwardW) * invRW;
          airVz += (dxW * swirlW - dzW * inwardW) * invRW;
          airVy -= 18.0 * whirlpoolStrength * Math.exp(-rW / 35.0);
        }
      }

      if (tsunamiStrength > 0.01) {
        const distWave = Math.abs(pz - tsunamiZ);
        if (distWave < 55.0 && py < waterLevel + 42.0) {
          const wavePulse = Math.exp(-((distWave * distWave) / 784.0)) * tsunamiStrength;
          vy += 38.0 * wavePulse * dt;
          vz -= 52.0 * wavePulse * dt;
        }
      }

      const dragRate = (2.4 / massFactor) * dt;
      vx += (airVx - vx) * dragRate;
      vz += (airVz - vz) * dragRate;
      vy += (airVy - vy) * dragRate + (inTornado > 0.15 ? -3.5 : -14.5) * dt;

      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;

      const localWaterY = sampleWaterHeight(px, pz);
      if (py < localWaterY + 0.8) {
        py = localWaterY + 0.8;
        if (vy < 0.0) vy = -vy * 0.25 + (tornadoStrength > 0.2 ? 6.0 * inTornado : 0.0);
      }

      if (terr.h > localWaterY && py < terr.h + 2.5) {
        py = terr.h + 2.5;
        vx -= terr.gx * 18.0;
        vz -= terr.gz * 18.0;
        vy = Math.max(vy, 2.0);
      }

      const dxWp = px - whirlpoolCenterXZ.x;
      const dzWp = pz - whirlpoolCenterXZ.y;
      if (
        py > cloudBaseY + 90.0 ||
        Math.abs(px) > 480.0 ||
        Math.abs(pz) > 480.0 ||
        (whirlpoolStrength > 0.3 && dxWp * dxWp + dzWp * dzWp < 20.25)
      ) {
        this._respawnParticle(i, false);
        if (tornadoStrength > 0.15 && Math.random() < 0.55) {
          const a = Math.random() * Math.PI * 2.0;
          const r = 12.0 + Math.random() * 65.0;
          this.positions[i3] = tornadoCenterXZ.x + Math.cos(a) * r;
          this.positions[i3 + 1] = localWaterY + 1.5 + Math.random() * 18.0;
          this.positions[i3 + 2] = tornadoCenterXZ.y + Math.sin(a) * r;
        }
        continue;
      }

      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      this.phases[i] = Math.min(1.0, Math.max(0.0, (py - localWaterY - 2.0) / 35.0));
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aClusterSize.needsUpdate = true;
    this.geo.attributes.aPhase.needsUpdate = true;
  }
}
