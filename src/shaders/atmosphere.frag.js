/**
 * Custom #version 300 es volumetric cloud fragment shader.
 * Features:
 * - Analytical Ray-AABB intersection
 * - Off-axis radial ray distance (tScene) depth compositing + soft terrain feathering
 * - Relative-To-Center (RTC) floating-origin world offset (uWorldOriginOffset)
 * - Blue-noise start jitter + adaptive empty-space stride skipping
 * - Beer-Lambert extinction, 4-step sun self-shadowing + powder edge term
 * - Dual-lobe Henyey-Greenstein scattering + horizon aerial perspective
 * - 4-mode shader inspection overlay (Final, Transmittance, Radial Depth, 3D Noise Slice)
 */
export const atmosphereFragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;

in vec3 vWorldPos;
out vec4 fragColor;

// Strictly vec4-aligned uniform blocks for 1:1 std140 / WebGPU GPUBuffer parity
uniform vec4 uBoundsMinAndFade;      // xyz: boxMin, w: terrainSoftFadeDistance
uniform vec4 uBoundsMaxAndCoverage;  // xyz: boxMax, w: coverage [0..1]
uniform vec4 uSunDirAndElevation;    // xyz: normalized sunDir, w: sin(elevation)
uniform vec4 uSunColorAndIntensity;  // xyz: sunRGB, w: intensity
uniform vec4 uSkyColorAndHaze;       // xyz: ambientSkyRGB, w: horizonHazeDensity
uniform vec4 uWindAndTime;           // xy: windXZ, z: elapsedSeconds, w: extinctionCoeff
uniform vec4 uCameraPosAndSteps;     // xyz: cameraWorldPos, w: maxPrimarySteps
uniform vec4 uCameraForwardAndNear;  // xyz: normalized cameraForward, w: cameraNear
uniform vec4 uViewportAndFar;        // xy: viewportResolution, z: cameraFar, w: detailErosionStrength
uniform vec4 uDebugParams;           // x: debugMode (0=Final, 1=Transmittance, 2=Depth, 3=NoiseSlice), yzw: reserved
uniform vec4 uWorldOriginOffset;     // xy: floating-origin RTC offset XZ (meters), zw: reserved

uniform sampler3D uMacroNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeatherMap;
uniform sampler2D uBlueNoise;
uniform sampler2D uSceneDepth;

const float PI = 3.14159265359;

vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir, vec3 boxMin, vec3 boxMax) {
  vec3 invDir = 1.0 / rayDir;
  vec3 t0 = (boxMin - rayOrigin) * invDir;
  vec3 t1 = (boxMax - rayOrigin) * invDir;
  vec3 tSmaller = min(t0, t1);
  vec3 tBigger  = max(t0, t1);
  float tNear = max(max(tsmaller.x, tsmaller.y), max(tsmaller.z, 0.0));
  float tFar  = min(min(tbigger.x, tbigger.y), tbigger.z);
  return vec2(tNear, tFar);
}

float linearizeDepth(float depthSample, float nearPlane, float farPlane) {
  if (depthSample >= 0.99999) {
    return farPlane;
  }
  float zNdc = depthSample * 2.0 - 1.0;
  return (2.0 * nearPlane * farPlane) / (farPlane + nearPlane - zNdc * (farPlane - nearPlane));
}

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 0.001);
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

float dualLobePhase(float cosTheta) {
  float forwardLobe = henyeyGreenstein(cosTheta, 0.65);
  float backLobe    = henyeyGreenstein(cosTheta, -0.25);
  return mix(forwardLobe, backLobe, 0.30);
}

float remap(float val, float low1, float high1, float low2, float high2) {
  return low2 + (val - low1) * (high2 - low2) / max(high1 - low1, 0.0001);
}

float sampleCloudDensity(vec3 worldPos, bool highDetail) {
  vec3 boxMin = uBoundsMinAndFade.xyz;
  vec3 boxMax = uBoundsMaxAndCoverage.xyz;
  vec3 boxSize = boxMax - boxMin;

  // Normalized altitude [0..1] inside local cloud slab
  float h = clamp((worldPos.y - boxMin.y) / boxSize.y, 0.0, 1.0);

  // Smooth horizontal edge feathering in local camera-centered slab prevents AABB seams
  vec2 normXZ = abs((worldPos.xz - 0.5 * (boxMin.xz + boxMax.xz)) / (0.5 * boxSize.xz));
  float edgeMask = (1.0 - smoothstep(0.84, 1.0, normXZ.x)) *
                   (1.0 - smoothstep(0.84, 1.0, normXZ.y));
  if (edgeMask <= 0.001) return 0.0;

  // Apply Relative-To-Center (RTC) floating-origin offset for jitter-free regional coordinates
  vec2 globalXZ = worldPos.xz + uWorldOriginOffset.xy;

  // 2D Weather map lookup with wind advection
  vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
  vec2 weatherUV = (globalXZ - boxMin.xz) / boxSize.xz + windOffset * 0.00085;
  vec2 weather = texture(uWeatherMap, weatherUV).rg;

  // Modulate coverage by weather map and user coverage control
  float localCoverage = clamp(weather.r * (uBoundsMaxAndCoverage.w * 1.45), 0.0, 1.0);
  if (localCoverage <= 0.05) return 0.0;

  // Cumulus vertical height envelope: flat condensation base, rounded billowing top
  float maxTop = mix(0.45, 0.96, weather.g);
  float bottomRamp = smoothstep(0.0, 0.14, h);
  float topRamp = 1.0 - smoothstep(maxTop * 0.58, maxTop, h);
  float heightProfile = bottomRamp * topRamp;
  if (heightProfile <= 0.001) return 0.0;

  // Macro 3D Perlin-Worley FBM lookup
  vec3 macroUVW = vec3(globalXZ.x + windOffset.x, worldPos.y, globalXZ.y + windOffset.y) * 0.0024;
  vec4 macro = texture(uMacroNoise, macroUVW);
  float worleyFbm = macro.g * 0.625 + macro.b * 0.25 + macro.a * 0.125;
  float baseShape = remap(macro.r, -(1.0 - worleyFbm) * 0.65, 1.0, 0.0, 1.0);

  float baseDensity = remap(baseShape * heightProfile, 1.0 - localCoverage, 1.0, 0.0, 1.0);
  baseDensity = clamp(baseDensity, 0.0, 1.0) * edgeMask;

  if (!highDetail || baseDensity <= 0.002) {
    return baseDensity;
  }

  // High-frequency Worley detail erosion at cloud boundaries
  vec3 detailUVW = vec3(
    globalXZ.x + windOffset.x * 1.35,
    worldPos.y + uWindAndTime.z * 1.5,
    globalXZ.y + windOffset.y * 1.35
  ) * 0.011;
  vec3 detail = texture(uDetailNoise, detailUVW).rgb;
  float detailFbm = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
  float detailModifier = mix(detailFbm, 1.0 - detailFbm, clamp(h * 2.5, 0.0, 1.0));

  float finalDensity = remap(baseDensity, detailModifier * uViewportAndFar.w, 1.0, 0.0, 1.0);
  return max(finalDensity, 0.0);
}

float marchSunTransmittance(vec3 samplePos, vec3 sunDir) {
  float stepLen = 14.0;
  float opticalDepth = 0.0;
  vec3 pos = samplePos;

  for (int i = 0; i < 4; i++) {
    pos += sunDir * stepLen;
    if (pos.y > uBoundsMaxAndCoverage.y) break;
    float d = sampleCloudDensity(pos, false);
    opticalDepth += d * stepLen;
    stepLen *= 1.35;
  }

  float extinction = uWindAndTime.w;
  float beer = exp(-opticalDepth * extinction * 1.15);
  // Powder-sugar edge term keeps dark creases inside dense cumulus cores
  float powder = 1.0 - exp(-opticalDepth * extinction * 2.2);
  return mix(beer, beer * (0.45 + 0.85 * powder), 0.65);
}

void main() {
  vec3 rayOrigin = uCameraPosAndSteps.xyz;
  vec3 rayDir = normalize(vWorldPos - rayOrigin);

  // Prevent division-by-zero on axis-aligned rays
  vec3 safeRayDir = mix(rayDir, vec3(1e-5), lessThan(abs(rayDir), vec3(1e-5)));

  vec2 hit = intersectAABB(
    rayOrigin,
    safeRayDir,
    uBoundsMinAndFade.xyz,
    uBoundsMaxAndCoverage.xyz
  );

  float tNear = hit.x;
  float tFar = hit.y;

  // Reconstruct radial Euclidean distance to opaque scene geometry (terrain / vessels / ocean)
  vec2 screenUV = gl_FragCoord.xy / uViewportAndFar.xy;
  float depthSample = texture(uSceneDepth, screenUV).r;
  float zView = linearizeDepth(depthSample, uCameraForwardAndNear.w, uViewportAndFar.z);
  float cosViewAngle = max(dot(rayDir, uCameraForwardAndNear.xyz), 0.001);
  float tScene = zView / cosViewAngle;

  int debugMode = int(uDebugParams.x + 0.5);

  // Debug Mode 2: Radial Scene Depth (tScene) with 50m Euclidean distance contour rings
  if (debugMode == 2) {
    float normDepth = clamp(tScene / 950.0, 0.0, 1.0);
    float contour = 1.0 - smoothstep(0.0, 0.06, abs(fract(tScene / 50.0) - 0.5));
    vec3 nearCol = vec3(0.12, 0.85, 0.95);
    vec3 midCol  = vec3(0.18, 0.42, 0.88);
    vec3 farCol  = vec3(0.05, 0.09, 0.18);
    vec3 depthCol = normDepth < 0.45
      ? mix(nearCol, midCol, normDepth / 0.45)
      : mix(midCol, farCol, (normDepth - 0.45) / 0.55);
    depthCol = mix(depthCol, vec3(1.0, 0.95, 0.75), contour * 0.35);
    fragColor = vec4(depthCol, 0.92);
    return;
  }

  // Debug Mode 3: Horizontal 3D Noise Volume Slice at mid-cloud altitude
  if (debugMode == 3) {
    float sliceY = mix(uBoundsMinAndFade.y, uBoundsMaxAndCoverage.y, 0.42);
    float denomY = abs(rayDir.y) > 1e-4 ? rayDir.y : (rayDir.y >= 0.0 ? 1e-4 : -1e-4);
    float tSlice = (sliceY - rayOrigin.y) / denomY;
    float tSample = tSlice > 0.0 ? min(tSlice, tScene) : max(tNear, 60.0);
    vec3 slicePos = rayOrigin + rayDir * tSample;

    vec2 boxMinXZ = uBoundsMinAndFade.xz;
    vec2 boxMaxXZ = uBoundsMaxAndCoverage.xz;
    vec2 boxSizeXZ = boxMaxXZ - boxMinXZ;
    vec2 normXZ = abs((slicePos.xz - 0.5 * (boxMinXZ + boxMaxXZ)) / (0.5 * boxSizeXZ));

    if (max(normXZ.x, normXZ.y) > 1.0) {
      discard;
    }

    vec2 globalSliceXZ = slicePos.xz + uWorldOriginOffset.xy;
    vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
    vec3 macroUVW = vec3(globalSliceXZ.x + windOffset.x, slicePos.y, globalSliceXZ.y + windOffset.y) * 0.0024;
    vec3 detailUVW = vec3(
      globalSliceXZ.x + windOffset.x * 1.35,
      slicePos.y + uWindAndTime.z * 1.5,
      globalSliceXZ.y + windOffset.y * 1.35
    ) * 0.011;

    vec4 macro = texture(uMacroNoise, macroUVW);
    vec3 detail = texture(uDetailNoise, detailUVW).rgb;
    float sculptedDensity = sampleCloudDensity(slicePos, true);

    // R: Perlin-Worley macro base, G: medium Worley lobes, B: high-freq Worley erosion
    vec3 noiseVis = vec3(macro.r, macro.g, detail.r);
    float thresholdRing = 1.0 - smoothstep(0.0, 0.035, abs(sculptedDensity - 0.08));
    noiseVis = mix(
      noiseVis,
      vec3(0.22, 0.95, 1.0),
      thresholdRing * (sculptedDensity > 0.001 ? 0.75 : 0.0)
    );
    fragColor = vec4(noiseVis, 0.94);
    return;
  }

  tFar = min(tFar, tScene);

  if (tNear >= tFar) {
    discard;
  }

  int maxSteps = int(uCameraPosAndSteps.w);
  float marchSpan = tFar - tNear;
  float baseStep = max(marchSpan / float(maxSteps), 2.5);

  // Screen-space 64x64 blue-noise jitter converts banding into fine grain
  ivec2 noiseCoord = ivec2(mod(gl_FragCoord.xy, 64.0));
  float jitter = texelFetch(uBlueNoise, noiseCoord, 0).r;

  float t = tNear + jitter * baseStep;
  float transmittance = 1.0;
  vec3 scatteredLight = vec3(0.0);

  vec3 sunDir = normalize(uSunDirAndElevation.xyz);
  float cosTheta = dot(rayDir, sunDir);
  float phase = dualLobePhase(cosTheta);

  vec3 sunRadiance = uSunColorAndIntensity.rgb * uSunColorAndIntensity.w;
  vec3 ambientSky = uSkyColorAndHaze.rgb;
  float extinctionCoeff = uWindAndTime.w;
  float terrainFadeDist = uBoundsMinAndFade.w;

  bool inCloud = false;
  float weightedDist = 0.0;
  float totalWeight = 0.0;

  for (int i = 0; i < 64; i++) {
    if (i >= maxSteps || t >= tFar || transmittance < 0.01) {
      break;
    }

    vec3 pos = rayOrigin + rayDir * t;
    float stepSize = inCloud ? baseStep : baseStep * 1.85;
    float density = sampleCloudDensity(pos, inCloud);

    if (density > 0.001) {
      if (!inCloud) {
        // Step back once upon entering cloud boundary for crisp silhouette integration
        t = max(tNear, t - baseStep);
        inCloud = true;
        continue;
      }

      // Soft terrain/vessel intersection fade prevents sharp polygon clipping
      float distToSurface = max(tScene - t, 0.0);
      float surfaceFade = smoothstep(0.0, terrainFadeDist, distToSurface);
      density *= surfaceFade;

      if (density > 0.001) {
        float heightFrac = clamp(
          (pos.y - uBoundsMinAndFade.y) / (uBoundsMaxAndCoverage.y - uBoundsMinAndFade.y),
          0.0,
          1.0
        );

        float lightTransmittance = marchSunTransmittance(pos, sunDir);
        vec3 directLight = sunRadiance * lightTransmittance * phase;
        vec3 indirectLight = ambientSky * mix(0.42, 1.08, heightFrac);
        vec3 luminance = directLight + indirectLight;

        float sigmaE = density * extinctionCoeff;
        float stepTransmittance = exp(-sigmaE * stepSize);

        // Energy-conserving analytical step integration
        vec3 stepScatter = luminance * (1.0 - stepTransmittance);
        scatteredLight += transmittance * stepScatter;

        float stepAlpha = transmittance * (1.0 - stepTransmittance);
        weightedDist += t * stepAlpha;
        totalWeight += stepAlpha;

        transmittance *= stepTransmittance;
      }
    } else {
      inCloud = false;
    }

    t += stepSize;
  }

  // Debug Mode 1: Optical Transmittance T in [0..1] (coral tint marks T <= 0.012 early-out cores)
  if (debugMode == 1) {
    vec3 transVis = vec3(transmittance);
    if (transmittance <= 0.012) {
      transVis = vec3(0.95, 0.35, 0.15);
    }
    fragColor = vec4(transVis, 0.90);
    return;
  }

  float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
  if (alpha <= 0.002) {
    discard;
  }

  vec3 cloudColor = scatteredLight / max(alpha, 0.0001);

  // Aerial perspective blend into maritime horizon haze
  float avgDist = totalWeight > 0.0 ? (weightedDist / totalWeight) : tNear;
  float hazeFactor = 1.0 - exp(-max(avgDist - 120.0, 0.0) * uSkyColorAndHaze.w);
  vec3 horizonColor = mix(
    ambientSky * 0.95,
    sunRadiance * 0.55 + ambientSky * 0.55,
    max(cosTheta, 0.0) * 0.45
  );
  cloudColor = mix(cloudColor, horizonColor, clamp(hazeFactor, 0.0, 0.85));

  fragColor = vec4(cloudColor, alpha);
}
`;
