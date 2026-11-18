/**
 * GLSL vertex shader chunks injected into OceanLayer's MeshStandardMaterial via onBeforeCompile.
 * Combines 4-wave directional Gerstner trochoidal swells with tsunami soliton, whirlpool maelstrom,
 * tornado collar, and hurricane eyewall storm surge.
 */

export const oceanVertexCommonGLSL = /* glsl */ `
  varying vec3 vOceanWorldPos;
  varying float vFoamIntensity;
  uniform vec4 uWindAndTime;
  uniform vec4 uWorldOriginOffset;
  uniform vec4 uHydroA;
  uniform vec4 uHydroB;
  uniform float uTornadoStrength;

  // Adds one directional Gerstner trochoidal wave (horizontal pinch + vertical lift + crest foam).
  void addGerstnerWave(vec2 xz, float t, vec2 dir, float steepness, float wavelength, inout vec3 disp, inout float foam) {
    float k = 6.2831853 / wavelength;
    float c = sqrt(9.8 / k);
    float a = (steepness / k) * 0.25;
    float theta = k * (dot(dir, xz) - c * t);
    float s = sin(theta);
    float cs = cos(theta);
    disp.x += dir.x * (a * steepness * cs);
    disp.z += dir.y * (a * steepness * cs);
    disp.y += a * s;
    foam += max(0.0, s) * steepness * 0.28;
  }

  // Evaluates combined Gerstner swells + tidal level + tsunami, whirlpool, tornado & hurricane.
  vec3 evalOceanDisplacement(vec2 xz, float t, out float outFoam) {
    outFoam = 0.0;
    vec3 disp = vec3(0.0, uHydroA.w, 0.0);

    addGerstnerWave(xz, t, vec2(0.848, 0.530), 0.34, 62.0, disp, outFoam);
    addGerstnerWave(xz, t, vec2(0.574, -0.819), 0.26, 38.0, disp, outFoam);
    addGerstnerWave(xz, t, vec2(-0.423, 0.906), 0.20, 23.0, disp, outFoam);
    addGerstnerWave(xz, t, vec2(0.966, -0.259), 0.14, 14.0, disp, outFoam);
    outFoam = clamp(outFoam - 0.18, 0.0, 0.45);

    float tsunamiStr = uHydroA.x;
    if (tsunamiStr > 0.01) {
      float dz = xz.y - uHydroA.y;
      float waveH = 26.0 * tsunamiStr * exp(-(dz * dz) / 2312.0) * (1.0 + 0.35 * tanh(-dz * 0.08));
      disp.y += waveH;
      outFoam += smoothstep(8.0, 22.0, waveH) * 0.95;
    }

    float whirlStr = uHydroA.z;
    if (whirlStr > 0.01) {
      vec2 dW = xz - uHydroB.xy;
      float r2 = dot(dW, dW);
      float r = sqrt(r2);
      float spiralArm = sin((atan(dW.y, dW.x) + t * 4.8 - r * 0.14) * 3.0) * 0.5 + 0.5;
      disp.y -= 15.5 * whirlStr * exp(-r2 / 3872.0);
      disp.y += 1.8 * whirlStr * (spiralArm - 0.5) * exp(-r2 / 11250.0);
      outFoam += whirlStr * exp(-r2 / 8450.0) * (0.35 + 0.65 * spiralArm);
    }

    if (uTornadoStrength > 0.01) {
      float rT = length(xz - uHydroB.zw);
      float dr = (rT - 24.0) / 14.0;
      disp.y += 2.6 * uTornadoStrength * exp(-(dr * dr));
      outFoam += uTornadoStrength * exp(-rT / 48.0) * 0.9;
    }

    float hurricaneStr = uWorldOriginOffset.w;
    if (hurricaneStr > 0.01) {
      vec2 dH = xz - uHydroB.zw;
      float r2H = dot(dH, dH);
      float rH = sqrt(r2H);
      float drH = (rH - 88.0) / 38.0;
      float eyewallRing = exp(-(drH * drH));
      disp.y += (5.2 * exp(-r2H / 26450.0) + 3.4 * sin(rH * 0.11 - t * 5.2) * eyewallRing) * hurricaneStr;
      outFoam += hurricaneStr * eyewallRing * 0.85;
    }
    return disp;
  }
`;

export const oceanVertexNormalGLSL = /* glsl */ `
  float tWave = uWindAndTime.z;
  float foamCenter = 0.0, dummyF = 0.0;
  vec3 dispC = evalOceanDisplacement(position.xz, tWave, foamCenter);
  vec3 dispX = evalOceanDisplacement(position.xz + vec2(2.5, 0.0), tWave, dummyF) + vec3(2.5, 0.0, 0.0);
  vec3 dispZ = evalOceanDisplacement(position.xz + vec2(0.0, 2.5), tWave, dummyF) + vec3(0.0, 0.0, 2.5);
  objectNormal = normalize(cross(dispZ - dispC, dispX - dispC));
`;

export const oceanVertexPositionGLSL = /* glsl */ `
  transformed += dispC;
  vFoamIntensity = clamp(foamCenter, 0.0, 1.0);
  vOceanWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
