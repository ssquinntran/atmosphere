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

uniform float uVolumeRes;
uniform float uTilesPerRow;
uniform float uBaseFreq;

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

  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z) * 0.5 + 0.5;
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
        vec3 diff = offset + hash33(id + offset, period) - fd;
        minDist = min(minDist, dot(diff, diff));
      }
    }
  }
  return 1.0 - clamp(sqrt(minDist), 0.0, 1.0);
}

float perlinFbm(vec3 uvw, float baseFreq) {
  float sum = 0.0, amp = 0.5, freq = baseFreq;
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
  vec3 uvw = (vec3(mod(px, uVolumeRes), zSlice) + 0.5) / uVolumeRes;

  float pFbm = perlinFbm(uvw, uBaseFreq);
  float w0 = periodicWorley3D(uvw, uBaseFreq);
  float w1 = periodicWorley3D(uvw, uBaseFreq * 2.0);
  float w2 = periodicWorley3D(uvw, uBaseFreq * 4.0);

  fragColor = vec4(mix(pFbm, w0, 0.55), w0, w1, w2);
}
`;

/**
 * Pre-bakes tileable 3D Perlin-Worley volume textures, 2D weather maps, and blue-noise jitter
 * once at boot on the GPU so the volumetric raymarcher only performs fast hardware texture lookups.
 */
export class CloudNoiseBaker {
  /** Render a tiled 2D atlas on the GPU and unpack Z-slices via TypedArray.set() into a Data3DTexture. */
  static bakeVolumeTexture(renderer, resolution, tilesPerRow, baseFreq) {
    const atlasW = resolution * tilesPerRow;
    const atlasH = resolution * (resolution / tilesPerRow);

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

    const volumeData = new Uint8Array(resolution * resolution * resolution * 4);
    const rowBytes = resolution * 4;
    for (let z = 0; z < resolution; z++) {
      const startX = (z % tilesPerRow) * resolution;
      const startY = Math.floor(z / tilesPerRow) * resolution;
      const zBase = z * resolution * resolution * 4;
      for (let y = 0; y < resolution; y++) {
        const srcStart = ((startY + y) * atlasW + startX) * 4;
        const dstStart = zBase + y * rowBytes;
        volumeData.set(atlasPixels.subarray(srcStart, srcStart + rowBytes), dstStart);
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

  /**
   * Generate a tileable 2D RGBA weather map:
   * R = cloud coverage, G = cloud vertical height scale, B = cumulonimbus anvil mask.
   */
  static createWeatherMap(size = 256) {
    const data = new Uint8Array(size * size * 4);
    const hash2 = (ix, iy, period) => {
      const x = ((ix % period) + period) % period;
      const y = ((iy % period) + period) % period;
      const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return h - Math.floor(h);
    };

    const valueNoise2D = (u, v, period) => {
      const x = u * period, y = v * period;
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3.0 - 2.0 * fx);
      const uy = fy * fy * (3.0 - 2.0 * fy);
      const a = hash2(ix, iy, period);
      const b = hash2(ix + 1, iy, period);
      const c = hash2(ix, iy + 1, period);
      const d = hash2(ix + 1, iy + 1, period);
      return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    };

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const cov = 0.50 * valueNoise2D(u, v, 3) + 0.32 * valueNoise2D(u, v, 7) + 0.18 * valueNoise2D(u, v, 14);
        const contrastedCov = Math.min(Math.max((cov - 0.12) * 1.32, 0.0), 1.0);
        const heightScale = 0.65 * valueNoise2D(u + 0.31, v + 0.17, 3) + 0.35 * valueNoise2D(u + 0.31, v + 0.17, 6);
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

  /** Generate a 64x64 Interleaved Gradient Noise texture used to dither raymarch start offsets. */
  static createBlueNoiseJitter(size = 64) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const ign = (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1.0)) % 1.0;
        const idx = (y * size + x) * 4;
        const val = Math.round(ign * 255);
        data[idx] = data[idx + 1] = data[idx + 2] = val;
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
