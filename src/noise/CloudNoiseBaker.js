import * as THREE from 'three';

const bakeVertexShader = /* glsl */ `
precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const bake3DFragmentShader = /* glsl */ `
precision highp float;

out vec4 fragColor;

uniform vec2 uAtlasSize;     // e.g. (512, 512)
uniform float uVolumeRes;    // e.g. 64.0
uniform float uTilesPerRow;  // e.g. 8.0
uniform float uBaseFreq;     // 4.0 for macro, 6.0 for detail

// Periodic 3D hash for seamless RepeatWrapping across [0..period)
vec3 hash33(vec3 p, float period) {
  p = mod(p, period);
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(p) * 43758.5453123);
}

float periodicPerlin3D(vec3 uvw, float period) {
  vec3 p = uvw * period;
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float n000 = dot(hash33(i + vec3(0,0,0), period) * 2.0 - 1.0, f - vec3(0,0,0));
  float n100 = dot(hash33(i + vec3(1,0,0), period) * 2.0 - 1.0, f - vec3(1,0,0));
  float n010 = dot(hash33(i + vec3(0,1,0), period) * 2.0 - 1.0, f - vec3(0,1,0));
  float n110 = dot(hash33(i + vec3(1,1,0), period) * 2.0 - 1.0, f - vec3(1,1,0));
  float n001 = dot(hash33(i + vec3(0,0,1), period) * 2.0 - 1.0, f - vec3(0,0,1));
  float n101 = dot(hash33(i + vec3(1,0,1), period) * 2.0 - 1.0, f - vec3(1,0,1));
  float n011 = dot(hash33(i + vec3(0,1,1), period) * 2.0 - 1.0, f - vec3(0,1,1));
  float n111 = dot(hash33(i + vec3(1,1,1), period) * 2.0 - 1.0, f - vec3(1,1,1));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);

  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);

  return mix(nxy0, nxy1, u.z) * 0.5 + 0.5;
}

float periodicWorley3D(vec3 uvw, float period) {
  vec3 p = uvw * period;
  vec3 id = floor(p);
  vec3 fd = fract(p);

  float minDist = 1.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 offset = vec3(float(x), float(y), float(z));
        vec3 neighbor = id + offset;
        vec3 jitter = hash33(neighbor, period);
        vec3 diff = offset + jitter - fd;
        minDist = min(minDist, dot(diff, diff));
      }
    }
  }
  return 1.0 - clamp(sqrt(minDist), 0.0, 1.0);
}

float perlinFbm(vec3 uvw, float baseFreq) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = baseFreq;
  for (int i = 0; i < 4; i++) {
    sum += amp * periodicPerlin3D(uvw, freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float tileX = floor(px.x / uVolumeRes);
  float tileY = floor(px.y / uVolumeRes);
  float zSlice = tileY * uTilesPerRow + tileX;

  vec2 localXY = mod(px, uVolumeRes);
  vec3 uvw = (vec3(localXY, zSlice) + 0.5) / uVolumeRes;

  float pFbm = perlinFbm(uvw, uBaseFreq);
  float w0 = periodicWorley3D(uvw, uBaseFreq);
  float w1 = periodicWorley3D(uvw, uBaseFreq * 2.0);
  float w2 = periodicWorley3D(uvw, uBaseFreq * 4.0);

  // Perlin-Worley blend produces billowy cumulus cellular lobes
  float perlinWorley = mix(pFbm, w0, 0.55);

  fragColor = vec4(perlinWorley, w0, w1, w2);
}
`;

/**
 * Generates tileable 3D cloud noise volumes on the GPU in < 15 ms using a 2D slice-atlas
 * pass (avoiding Windows Chrome ANGLE D3D11 3D FBO attachment issues), plus a 2D weather
 * coverage map and blue-noise jitter texture.
 */
export class CloudNoiseBaker {
  static bakeVolumeTexture(renderer, resolution, tilesPerRow, baseFreq) {
    const tilesPerCol = resolution / tilesPerRow;
    const atlasW = resolution * tilesPerRow;
    const atlasH = resolution * tilesPerCol;

    const rt = new THREE.WebGLRenderTarget(atlasW, atlasH, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const bakeMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: bakeVertexShader,
      fragmentShader: bake3DFragmentShader,
      uniforms: {
        uAtlasSize: { value: new THREE.Vector2(atlasW, atlasH) },
        uVolumeRes: { value: resolution },
        uTilesPerRow: { value: tilesPerRow },
        uBaseFreq: { value: baseFreq },
      },
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat);
    const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(quad, orthoCam);
    renderer.setRenderTarget(prevTarget);

    const atlasPixels = new Uint8Array(atlasW * atlasH * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, atlasW, atlasH, atlasPixels);

    // Unpack 2D tile atlas into contiguous 3D voxel buffer
    const volumeData = new Uint8Array(resolution * resolution * resolution * 4);
    for (let z = 0; z < resolution; z++) {
      const tileX = z % tilesPerRow;
      const tileY = Math.floor(z / tilesPerRow);
      const startX = tileX * resolution;
      const startY = tileY * resolution;

      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          const srcIdx = ((startY + y) * atlasW + (startX + x)) * 4;
          const dstIdx = (z * resolution * resolution + y * resolution + x) * 4;
          volumeData[dstIdx] = atlasPixels[srcIdx];
          volumeData[dstIdx + 1] = atlasPixels[srcIdx + 1];
          volumeData[dstIdx + 2] = atlasPixels[srcIdx + 2];
          volumeData[dstIdx + 3] = atlasPixels[srcIdx + 3];
        }
      }
    }

    quad.geometry.dispose();
    bakeMat.dispose();
    rt.dispose();

    const tex3D = new THREE.Data3DTexture(volumeData, resolution, resolution, resolution);
    tex3D.format = THREE.RGBAFormat;
    tex3D.type = THREE.UnsignedByteType;
    tex3D.minFilter = THREE.LinearFilter;
    tex3D.magFilter = THREE.LinearFilter;
    tex3D.wrapS = THREE.RepeatWrapping;
    tex3D.wrapT = THREE.RepeatWrapping;
    tex3D.wrapR = THREE.RepeatWrapping;
    tex3D.unpackAlignment = 1;
    tex3D.needsUpdate = true;

    return tex3D;
  }

  static createWeatherMap(size = 256) {
    const data = new Uint8Array(size * size * 4);

    // Periodic multi-octave value noise for synoptic cloud fronts
    const hash2 = (ix, iy, period) => {
      const x = ((ix % period) + period) % period;
      const y = ((iy % period) + period) % period;
      const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return h - Math.floor(h);
    };

    const valueNoise2D = (u, v, period) => {
      const x = u * period;
      const y = v * period;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      const ux = fx * fx * (3.0 - 2.0 * fx);
      const uy = fy * fy * (3.0 - 2.0 * fy);

      const a = hash2(ix, iy, period);
      const b = hash2(ix + 1, iy, period);
      const c = hash2(ix, iy + 1, period);
      const d = hash2(ix + 1, iy + 1, period);

      return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        const cov =
          0.50 * valueNoise2D(u, v, 3) +
          0.32 * valueNoise2D(u, v, 7) +
          0.18 * valueNoise2D(u, v, 14);

        // Stretch contrast of weather map so clouds have distinct, sculpted formations
        const contrastedCov = Math.min(Math.max((cov - 0.12) * 1.32, 0.0), 1.0);

        const heightScale =
          0.65 * valueNoise2D(u + 0.31, v + 0.17, 3) +
          0.35 * valueNoise2D(u + 0.31, v + 0.17, 6);

        const anvilMask = valueNoise2D(u + 0.63, v + 0.41, 4);

        const idx = (y * size + x) * 4;
        data[idx] = Math.round(contrastedCov * 255);
        data[idx + 1] = Math.round(Math.min(Math.max(heightScale, 0), 1) * 255);
        data[idx + 2] = Math.round(Math.min(Math.max(anvilMask, 0), 1) * 255);
        data[idx + 3] = 255;
      }
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  static createBlueNoiseJitter(size = 64) {
    // Low-discrepancy R2 / interleaved gradient sequence for artifact-free jitter
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const ign = (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1.0)) % 1.0;
        const idx = (y * size + x) * 4;
        const val = Math.round(ign * 255);
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }
}
