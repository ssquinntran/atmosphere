/**
 * Deterministic Three.js & WebGL2 Mock for Node.js Unit and Integration Testing.
 */

export const GLSL3 = '300 es';
export const BackSide = 1;
export const DoubleSide = 2;
export const NearestFilter = 1003;
export const LinearFilter = 1006;
export const RGBAFormat = 1023;
export const UnsignedByteType = 1009;
export const UnsignedIntType = 1014;
export const RepeatWrapping = 1000;
export const ClampToEdgeWrapping = 1001;
export const ACESFilmicToneMapping = 4;
export const AdditiveBlending = 2;

export const MathUtils = {
  degToRad: (deg) => (deg * Math.PI) / 180.0,
  clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
  lerp: (x, y, t) => (1 - t) * x + t * y,
  smoothstep(x, min, max) {
    if (x <= min) return 0;
    if (x >= max) return 1;
    const t = (x - min) / (max - min);
    return t * t * (3 - 2 * t);
  },
};

export class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }
}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  normalize() {
    const len = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= len; this.y /= len; this.z /= len;
    return this;
  }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  lerp(v, alpha) {
    this.x += (v.x - this.x) * alpha;
    this.y += (v.y - this.y) * alpha;
    this.z += (v.z - this.z) * alpha;
    return this;
  }
}

export class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
}

export class Color {
  constructor(hex = 0xffffff) {
    this.r = 1; this.g = 1; this.b = 1;
    if (typeof hex === 'number') this.setHex(hex);
  }
  setHex(hex) {
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  lerp(c, alpha) {
    this.r += (c.r - this.r) * alpha;
    this.g += (c.g - this.g) * alpha;
    this.b += (c.b - this.b) * alpha;
    return this;
  }
}

export class Matrix4 {
  constructor() { this.elements = new Float32Array(16); }
  makeBasis(xAxis, yAxis, zAxis) {
    const e = this.elements;
    e[0] = xAxis.x; e[1] = xAxis.y; e[2] = xAxis.z;
    e[4] = yAxis.x; e[5] = yAxis.y; e[6] = yAxis.z;
    e[8] = zAxis.x; e[9] = zAxis.y; e[10] = zAxis.z;
    return this;
  }
}

export class Quaternion {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
  setFromRotationMatrix(m) {
    this.x = m.elements[0];
    this.y = m.elements[5];
    this.z = m.elements[10];
    return this;
  }
}

export class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array ? array.length / itemSize : 0;
    this.needsUpdate = false;
  }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setY(i, val) { this.array[i * this.itemSize + 1] = val; }
}

export class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this.disposed = false; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  setIndex(indices) { this.index = indices; return this; }
  computeVertexNormals() {}
  rotateX() { return this; }
  rotateY() { return this; }
  scale() { return this; }
  dispose() { this.disposed = true; }
}

export class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, widthSegments = 1, heightSegments = 1) {
    super();
    const gridX = widthSegments + 1, gridZ = heightSegments + 1;
    const arr = new Float32Array(gridX * gridZ * 3);
    let idx = 0;
    for (let iz = 0; iz < gridZ; iz++) {
      const z = (iz / heightSegments - 0.5) * height;
      for (let ix = 0; ix < gridX; ix++) {
        arr[idx++] = (ix / widthSegments - 0.5) * width;
        arr[idx++] = 0;
        arr[idx++] = z;
      }
    }
    this.setAttribute('position', new BufferAttribute(arr, 3));
  }
}

export class BoxGeometry extends BufferGeometry {
  constructor(w = 1, h = 1, d = 1) { super(); this.w = w; this.h = h; this.d = d; }
}

export class ConeGeometry extends BufferGeometry {
  constructor(r = 1, h = 1, s = 4) { super(); this.r = r; this.h = h; this.s = s; }
}

export class CylinderGeometry extends BufferGeometry {
  constructor(rt = 1, rb = 1, h = 1, s = 8) { super(); this.rt = rt; this.rb = rb; this.h = h; this.s = s; }
}

export class SphereGeometry extends BufferGeometry {
  constructor(r = 1, ws = 8, hs = 8) { super(); this.r = r; this.ws = ws; this.hs = hs; }
}

export class DataTexture {
  constructor(data, width, height, format) {
    this.data = data; this.width = width; this.height = height; this.format = format;
    this.needsUpdate = false; this.disposed = false;
  }
  dispose() { this.disposed = true; }
}

export class Data3DTexture extends DataTexture {
  constructor(data, width, height, depth) { super(data, width, height, RGBAFormat); this.depth = depth; }
}

export class CanvasTexture extends DataTexture {
  constructor(canvas) { super(null, canvas?.width ?? 128, canvas?.height ?? 128, RGBAFormat); this.image = canvas; }
}

export class DepthTexture extends DataTexture {
  constructor(width, height) { super(null, width, height, RGBAFormat); }
}

export class WebGLRenderTarget {
  constructor(width, height, options = {}) {
    this.width = width; this.height = height; this.options = options;
    this.texture = new DataTexture(null, width, height, RGBAFormat);
    this.depthTexture = options.depthTexture ?? null;
    this.disposed = false;
  }
  setSize(w, h) { this.width = w; this.height = h; }
  dispose() { this.disposed = true; }
}

export class Material {
  constructor(params = {}) { Object.assign(this, params); this.needsUpdate = false; this.disposed = false; }
  dispose() { this.disposed = true; }
}

export class RawShaderMaterial extends Material {}
export class ShaderMaterial extends Material {}
export class MeshStandardMaterial extends Material {}
export class MeshBasicMaterial extends Material {}

export class Object3D {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.quaternion = new Quaternion();
    this.children = [];
    this.visible = true;
    this.frustumCulled = true;
    this.renderOrder = 0;
  }
  add(child) { this.children.push(child); return this; }
  lookAt(x, y, z) { this.rotation.set(x, y, z); }
}

export class Group extends Object3D {}

export class Mesh extends Object3D {
  constructor(geometry = new BufferGeometry(), material = new Material()) {
    super(); this.geometry = geometry; this.material = material;
  }
}

export class LineSegments extends Mesh {}
export class Points extends Mesh {}

export class Scene extends Object3D {
  constructor() { super(); this.background = null; this.fog = null; }
}

export class FogExp2 {
  constructor(color, density) { this.color = new Color(color); this.density = density; }
}

export class PerspectiveCamera extends Object3D {
  constructor(fov = 50, aspect = 1.77, near = 1, far = 3500) {
    super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
  }
  updateProjectionMatrix() {}
  getWorldDirection(target) { return target.set(0, -0.35, -0.93).normalize(); }
}

export class OrthographicCamera extends Object3D {}

export class DirectionalLight extends Object3D {
  constructor(color, intensity) { super(); this.color = new Color(color); this.intensity = intensity; }
}

export class HemisphereLight extends Object3D {
  constructor(skyColor, groundColor, intensity) {
    super(); this.color = new Color(skyColor); this.groundColor = new Color(groundColor); this.intensity = intensity;
  }
}

export function createMockWebGL2Context() {
  const timerExt = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  let activeQuery = null, queryAvailable = true, disjointState = false, timerSupported = true;
  const gl = {
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    _setTimerSupported(flag) { timerSupported = flag; },
    _setQueryAvailable(flag) { queryAvailable = flag; },
    _setDisjoint(flag) { disjointState = flag; },
    getExtension(name) { return name === 'EXT_disjoint_timer_query_webgl2' && timerSupported ? timerExt : null; },
    createQuery() { return { id: Math.random() }; },
    beginQuery(_target, query) { activeQuery = query; },
    endQuery() { activeQuery = null; },
    getQuery() { return activeQuery; },
    getParameter(pname) { return pname === timerExt.GPU_DISJOINT_EXT ? disjointState : 0; },
    getQueryParameter(_q, pname) {
      if (pname === gl.QUERY_RESULT_AVAILABLE) return queryAvailable;
      if (pname === gl.QUERY_RESULT) return 2450000;
      return 0;
    },
    deleteQuery() {},
  };
  return gl;
}

export class WebGLRenderer {
  constructor(params = {}) {
    this.domElement = params.canvas ?? {};
    this.toneMapping = 0;
    this.toneMappingExposure = 1.0;
    this.autoClear = true;
    this.info = { render: { calls: 4 } };
    this._target = null;
    this._width = 1280;
    this._height = 720;
    this._gl = createMockWebGL2Context();
  }
  setPixelRatio() {}
  setSize(w, h) { this._width = w; this._height = h; }
  getDrawingBufferSize(targetVec2) { return targetVec2.set(this._width, this._height); }
  getContext() { return this._gl; }
  setRenderTarget(rt) { this._target = rt; }
  getRenderTarget() { return this._target; }
  setClearColor() {}
  clear() {}
  render(scene) {
    if (scene?.children) {
      for (const child of scene.children) {
        if (typeof child.material?.onBeforeCompile === 'function' && !child.material._compiled) {
          const mockShader = {
            uniforms: {},
            vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
            fragmentShader: '#include <common>\n#include <dithering_fragment>',
          };
          child.material.onBeforeCompile(mockShader);
          child.material._compiledShader = mockShader;
          child.material._compiled = true;
        }
      }
    }
  }
  readRenderTargetPixels(_rt, _x, _y, _w, _h, outBuffer) {
    for (let i = 0; i < outBuffer.length; i += 4) {
      outBuffer[i] = 160; outBuffer[i + 1] = 140; outBuffer[i + 2] = 110; outBuffer[i + 3] = 255;
    }
  }
}

export class OrbitControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.target = new Vector3();
    this.enableDamping = false;
    this.dampingFactor = 0.05;
    this.maxPolarAngle = Math.PI;
    this.minDistance = 1;
    this.maxDistance = 1000;
  }
  update() {}
}
