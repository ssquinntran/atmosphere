/**
 * GLSL fragment shader chunks injected into OceanLayer's MeshStandardMaterial via onBeforeCompile.
 * Renders Gerstner crest whitecaps, cloud shadows, raindrop splash rings, and freezing sea-ice.
 */

export const oceanFragmentCommonGLSL = /* glsl */ `
  varying vec3 vOceanWorldPos;
  varying vec3 vOceanNormal;
  varying float vFoamIntensity;
  uniform sampler2D uWeatherMap;
  uniform vec4 uWindAndTime;
  uniform vec4 uBoundsMinAndFade;
  uniform vec4 uBoundsMaxAndCoverage;
  uniform vec4 uSunDirAndElevation;
  uniform vec4 uWorldOriginOffset;
  uniform float uRainIntensity;
  uniform float uTemperature;

  // Procedural expanding raindrop ring ripples across tiled ocean cells.
  float rainRingPattern(vec2 p, float t) {
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float h = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
    float phase = fract(t * 1.85 + h);
    float ring = 1.0 - smoothstep(0.0, 0.055, abs(length(f) - phase * 0.46));
    return ring * (1.0 - phase) * step(0.42, h);
  }
`;

export const oceanFragmentDitherGLSL = /* glsl */ `
  vec3 sunDir = normalize(uSunDirAndElevation.xyz);
  float tCloudPlane = max((uBoundsMinAndFade.y - vOceanWorldPos.y) / max(sunDir.y, 0.08), 0.0);
  vec2 shadowWorldXZ = vOceanWorldPos.xz + uWorldOriginOffset.xy + sunDir.xz * tCloudPlane;
  vec2 weatherUV = (shadowWorldXZ - uBoundsMinAndFade.xz) / (uBoundsMaxAndCoverage.xz - uBoundsMinAndFade.xz) + uWindAndTime.xy * uWindAndTime.z * 0.00085;
  float cloudDensityShadow = smoothstep(1.0 - uBoundsMaxAndCoverage.w * 1.35, 1.0, texture2D(uWeatherMap, weatherUV).r);

  vec2 globalWaveXZ = vOceanWorldPos.xz + uWorldOriginOffset.xy;
  float tRip = uWindAndTime.z;
  // Fast 3-wave capillary micro-ripple normal perturbation (zero texture lookups)
  vec2 ripGrad = vec2(
    cos(globalWaveXZ.x * 0.55 + globalWaveXZ.y * 0.25 + tRip * 2.6) * 0.14 +
    cos(globalWaveXZ.x * 1.15 - globalWaveXZ.y * 0.70 - tRip * 3.4) * 0.09 +
    cos(globalWaveXZ.x * 2.10 + globalWaveXZ.y * 1.65 + tRip * 4.5) * 0.05,
    sin(globalWaveXZ.y * 0.62 - globalWaveXZ.x * 0.30 + tRip * 2.3) * 0.14 +
    sin(globalWaveXZ.y * 1.25 + globalWaveXZ.x * 0.65 - tRip * 3.1) * 0.09 +
    sin(globalWaveXZ.y * 2.20 - globalWaveXZ.x * 1.50 + tRip * 4.2) * 0.05
  );
  vec3 N = normalize(vOceanNormal + vec3(ripGrad.x, 0.0, ripGrad.y));
  vec3 V = normalize(cameraPosition - vOceanWorldPos);
  vec3 H = normalize(sunDir + V);

  // Schlick Fresnel sky reflection + deep water trough absorption + subsurface crest scatter
  float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 4.2);
  vec3 deepWater = vec3(0.014, 0.095, 0.19);
  vec3 skyReflect = vec3(0.38, 0.64, 0.88);
  vec3 waterCol = mix(deepWater, skyReflect, fresnel * 0.78);
  waterCol += vec3(0.03, 0.26, 0.30) * (0.25 + 0.75 * vFoamIntensity) * max(0.0, dot(V, -sunDir) * 0.5 + 0.5);
  float sunGlint = pow(max(dot(N, H), 0.0), 140.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, waterCol, 0.68) + vec3(1.0, 0.96, 0.86) * (sunGlint * 1.15);

  if (vFoamIntensity > 0.01) {
    float foamTex = 0.65 + 0.35 * sin(globalWaveXZ.x * 0.45 + uWindAndTime.z * 3.0) * cos(globalWaveXZ.y * 0.45);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.88, 0.96, 1.0), clamp(vFoamIntensity * foamTex, 0.0, 0.92));
  }

  if (uRainIntensity > 0.01) {
    float splash = (rainRingPattern(globalWaveXZ * 0.38, uWindAndTime.z) + rainRingPattern(globalWaveXZ * 0.52 + vec2(17.3, 9.1), uWindAndTime.z * 1.15)) * uRainIntensity;
    gl_FragColor.rgb += vec3(0.18, 0.25, 0.32) * splash;
  }

  float frost = clamp((1.0 - uTemperature) / 18.0, 0.0, 1.0);
  if (frost > 0.01) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.76, 0.89, 0.96), frost * (0.28 + 0.55 * vFoamIntensity));
  }

  gl_FragColor.rgb *= mix(1.0, 0.42, cloudDensityShadow * 0.82);
`;
