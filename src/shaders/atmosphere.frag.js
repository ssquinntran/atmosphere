/**
 * Single-pass GLSL3 volumetric raymarching fragment shader:
 * - Intersects camera rays with the cloud/storm bounding volume and clips against uSceneDepth
 * - Evaluates 10 WMO cloud genera, 6 cyclone/storm regimes, and topographic airflow deflection
 * - Computes Beer-Lambert optical transmittance, dual-lobe Henyey-Greenstein scattering, and sheet lightning
 */
export const atmosphereFragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;

in vec3 vWorldPos;
out vec4 fragColor;

uniform vec4 uBoundsMinAndFade;      // xyz: boxMin, w: terrainSoftFadeDistance
uniform vec4 uBoundsMaxAndCoverage;  // xyz: boxMax, w: coverage [0..1]
uniform vec4 uSunDirAndElevation;    // xyz: sunDir, w: lightningIntensity [0..1]
uniform vec4 uSunColorAndIntensity;  // xyz: sunRGB, w: intensity
uniform vec4 uSkyColorAndHaze;       // xyz: ambientSkyRGB, w: horizonHazeDensity
uniform vec4 uWindAndTime;           // xy: windXZ, z: elapsedSeconds, w: extinctionCoeff
uniform vec4 uCameraPosAndSteps;     // xyz: cameraWorldPos, w: maxPrimarySteps
uniform vec4 uCameraForwardAndNear;  // xyz: cameraForward, w: cameraNear
uniform vec4 uViewportAndFar;        // xy: viewportResolution, z: cameraFar, w: detailErosionStrength
uniform vec4 uDebugParams;           // x: debugMode (0..3), y: cloudGenusId (0..9), z: rainIntensity, w: densityMultiplier
uniform vec4 uWorldOriginOffset;     // xy: floating-origin RTC offset XZ, z: stormTypeId, w: hurricaneStrength
uniform vec4 uCloudShapeParams;      // x: horizScale, y: vertStretch, z: cellularity, w: wispsAndShear
uniform vec4 uVortexAndTide;         // xy: tornadoCenterXZ, z: tornadoStrength, w: tidalWaterLevel

uniform sampler3D uMacroNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeatherMap;
uniform sampler2D uBlueNoise;
uniform sampler2D uTerrainMap;       // R: height/380m, G: dH/dx [0..1], B: dH/dz [0..1], A: canyonFunnelMask
uniform sampler2D uSceneDepth;

const float PI = 3.14159265359;
const float TERRAIN_MAX_NORM_H = 380.0;

// Slab-method ray-box intersection returning [tNear, tFar] along rayDir.
vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir, vec3 boxMin, vec3 boxMax) {
  vec3 invDir = 1.0 / rayDir;
  vec3 t0 = (boxMin - rayOrigin) * invDir;
  vec3 t1 = (boxMax - rayOrigin) * invDir;
  vec3 tSmaller = min(t0, t1);
  vec3 tBigger  = max(t0, t1);
  float tNear = max(max(tSmaller.x, tSmaller.y), max(tSmaller.z, 0.0));
  float tFar  = min(min(tBigger.x, tBigger.y), tBigger.z);
  return vec2(tNear, tFar);
}

// Converts non-linear [0..1] depth buffer sample back into view-space meters.
float linearizeDepth(float depthSample, float nearPlane, float farPlane) {
  if (depthSample >= 0.99999) return farPlane;
  float zNdc = depthSample * 2.0 - 1.0;
  return (2.0 * nearPlane * farPlane) / (farPlane + nearPlane - zNdc * (farPlane - nearPlane));
}

// Dual-lobe Henyey-Greenstein phase function (sharp forward silver lining + soft back-scatter).
float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 0.001);
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

float dualLobePhase(float cosTheta) {
  return mix(henyeyGreenstein(cosTheta, 0.72), henyeyGreenstein(cosTheta, -0.30), 0.28);
}

float remap(float val, float low1, float high1, float low2, float high2) {
  return low2 + (val - low1) * (high2 - low2) / max(high1 - low1, 0.0001);
}

// Samples uTerrainMap to deflect clouds around peaks, lift orographic crests, and clear canyons.
void evaluateTopographicAirflow(
  vec3 worldPos,
  vec3 boxMin,
  vec3 boxSize,
  out float outTerrainY,
  out float outClearanceMask,
  out vec2 outFlowOffsetXZ,
  out float outOrographicLiftY,
  out float outOrographicMod
) {
  vec2 terrainUV = clamp((worldPos.xz - boxMin.xz) / boxSize.xz, 0.002, 0.998);
  vec4 tSample = texture(uTerrainMap, terrainUV);

  outTerrainY = max(tSample.r * TERRAIN_MAX_NORM_H, uVortexAndTide.w);
  vec2 gradXZ = (tSample.gb - 0.5) * 2.0;
  float canyonMask = tSample.a;

  outClearanceMask = smoothstep(outTerrainY + 0.5, outTerrainY + 18.0, worldPos.y);

  float altAboveTerrain = max(worldPos.y - outTerrainY, 0.0);
  if (altAboveTerrain >= 135.0) {
    outFlowOffsetXZ = vec2(0.0);
    outOrographicLiftY = 0.0;
    outOrographicMod = 0.0;
    return;
  }
  float interactionZone = 1.0 - smoothstep(0.0, 135.0, altAboveTerrain);

  float windLen = length(uWindAndTime.xy);
  vec2 windDir = windLen > 0.01 ? (uWindAndTime.xy / windLen) : vec2(0.848, 0.530);
  float uphillAlignment = dot(windDir, gradXZ);

  float baseRidgeLift = clamp(outTerrainY - boxMin.y * 0.45, 0.0, 95.0) * 0.48;
  float windwardUpdraft = max(uphillAlignment, 0.0) * 34.0;
  outOrographicLiftY = (baseRidgeLift + windwardUpdraft) * interactionZone;

  vec2 perpGrad = vec2(-gradXZ.y, gradXZ.x);
  float tangentSign = sign(dot(windDir, perpGrad) + 0.001);
  float blockStrength = smoothstep(25.0, 180.0, outTerrainY) * interactionZone;

  vec2 slopeRepulsion = -gradXZ * (78.0 * blockStrength);
  vec2 flankStream = perpGrad * tangentSign * (56.0 * blockStrength);
  vec2 canyonJet = windDir * (canyonMask * 42.0 * (1.0 - smoothstep(40.0, 195.0, worldPos.y)));

  outFlowOffsetXZ = slopeRepulsion + flankStream + canyonJet;
  outOrographicMod = clamp(uphillAlignment * 0.32 * interactionZone, -0.18, 0.28);
}

float evaluateTornadoFunnel(vec3 worldPos, vec3 boxMin, vec3 boxMax, float terrainY) {
  float tornadoStrength = uVortexAndTide.z;
  if (tornadoStrength <= 0.01) return 0.0;

  vec2 roughRel = worldPos.xz - uVortexAndTide.xy;
  if (dot(roughRel, roughRel) > 42000.0) return 0.0;

  float waterLevel = uVortexAndTide.w;
  float minFunnelY = max(terrainY, waterLevel);
  float maxFunnelY = boxMin.y + (boxMax.y - boxMin.y) * 0.65;
  if (worldPos.y < minFunnelY || worldPos.y > maxFunnelY) return 0.0;

  float fh = clamp((worldPos.y - waterLevel) / max(maxFunnelY - waterLevel, 25.0), 0.0, 1.0);
  float t = uWindAndTime.z;
  vec2 sway = vec2(
    sin(fh * 4.2 - t * 2.4) * 11.0 * (1.0 - fh * 0.5),
    cos(fh * 3.6 - t * 2.1) * 9.0 * (1.0 - fh * 0.5)
  );
  vec2 relXZ = worldPos.xz - (uVortexAndTide.xy + sway);
  float r = length(relXZ);

  int stormTypeId = int(uWorldOriginOffset.z + 0.5);
  float baseR = (stormTypeId == 1) ? 11.0 : 22.0;
  float topR = (stormTypeId == 1) ? 42.0 : 78.0;
  float collarFlare = (stormTypeId == 1) ? 34.0 : 68.0;
  float funnelRadius = mix(baseR, topR, pow(fh, 1.45)) + pow(max(fh - 0.55, 0.0) / 0.45, 2.0) * collarFlare;
  if (r > funnelRadius * 2.2) return 0.0;

  float angle = atan(relXZ.y, relXZ.x) + t * 5.8 - fh * 9.5 + (25.0 / (r + 8.0));
  vec3 vortexUVW = vec3(cos(angle) * 0.28 + 0.5, fh * 1.6 - t * 0.55, sin(angle) * 0.28 + 0.5);
  vec4 vNoise = texture(uMacroNoise, vortexUVW);
  float helicalFbm = dot(vNoise.rgb, vec3(0.55, 0.30, 0.15));

  float funnelShell = smoothstep(funnelRadius * 0.14, funnelRadius * 0.42, r) *
                      (1.0 - smoothstep(funnelRadius * 0.52, funnelRadius * 1.35, r));
  float sprayRing = (1.0 - smoothstep(14.0, 52.0, abs(r - 26.0))) * (1.0 - smoothstep(0.0, 0.22, fh)) * 0.95;

  float rawVortex = (funnelShell * (0.55 + 0.65 * helicalFbm) + sprayRing * helicalFbm) * tornadoStrength;
  return clamp(rawVortex * 2.4, 0.0, 1.8);
}

float computeGenusHeightProfile(int genusId, float h, vec3 weather) {
  if (genusId == 0) {
    float maxTop = mix(0.55, 0.98, weather.g);
    return smoothstep(0.0, 0.09, h) * (1.0 - smoothstep(maxTop * 0.55, maxTop, h));
  } else if (genusId == 1) {
    return smoothstep(0.0, 0.18, h) * (1.0 - smoothstep(0.42, 0.85, h));
  } else if (genusId == 2) {
    float maxTop = mix(0.45, 0.78, weather.g);
    return smoothstep(0.0, 0.11, h) * (1.0 - smoothstep(maxTop * 0.65, maxTop, h));
  } else if (genusId == 3) {
    float maxTop = mix(0.50, 0.85, weather.g);
    return smoothstep(0.05, 0.22, h) * (1.0 - smoothstep(maxTop * 0.68, maxTop, h));
  } else if (genusId == 4) {
    return smoothstep(0.0, 0.22, h) * (1.0 - smoothstep(0.58, 0.94, h));
  } else if (genusId == 5) {
    return smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.75, 0.99, h));
  } else if (genusId == 6) {
    return exp(-pow((h - 0.52) * 3.1, 2.0));
  } else if (genusId == 7) {
    return exp(-pow((h - 0.50) * 3.6, 2.0));
  } else if (genusId == 8) {
    return smoothstep(0.08, 0.35, h) * (1.0 - smoothstep(0.65, 0.95, h));
  }
  float tower = smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.88, 1.0, h));
  float anvilSpread = smoothstep(0.66, 0.84, h) * (1.0 - smoothstep(0.92, 1.0, h));
  return max(tower, anvilSpread * 1.25);
}

float sampleCloudDensity(vec3 worldPos, bool highDetail, out float outRainShaft) {
  outRainShaft = 0.0;
  vec3 boxMin = uBoundsMinAndFade.xyz;
  vec3 boxMax = uBoundsMaxAndCoverage.xyz;
  vec3 boxSize = boxMax - boxMin;

  vec2 normXZ = abs((worldPos.xz - 0.5 * (boxMin.xz + boxMax.xz)) / (0.5 * boxSize.xz));
  float edgeMask = (1.0 - smoothstep(0.82, 1.0, normXZ.x)) * (1.0 - smoothstep(0.82, 1.0, normXZ.y));
  if (edgeMask <= 0.001) return 0.0;

  float terrainY = 0.0;
  float clearanceMask = 1.0;
  vec2 flowOffsetXZ = vec2(0.0);
  float orographicLiftY = 0.0;
  float orographicMod = 0.0;
  evaluateTopographicAirflow(worldPos, boxMin, boxSize, terrainY, clearanceMask, flowOffsetXZ, orographicLiftY, orographicMod);
  if (clearanceMask <= 0.001) return 0.0;

  float funnelDensity = evaluateTornadoFunnel(worldPos, boxMin, boxMax, terrainY) * edgeMask;
  vec2 globalXZ = worldPos.xz + uWorldOriginOffset.xy + flowOffsetXZ;

  int stormTypeId = int(uWorldOriginOffset.z + 0.5);
  float hurricaneStrength = uWorldOriginOffset.w;

  if (uVortexAndTide.z > 0.01 || hurricaneStrength > 0.01) {
    vec2 dVortex = worldPos.xz - uVortexAndTide.xy;
    float maxSwirlR = hurricaneStrength > 0.01 ? 560.0 : 260.0;
    float r2V = dot(dVortex, dVortex);
    if (r2V < maxSwirlR * maxSwirlR) {
      float rV = sqrt(r2V);
      float swirlAngle = (1.0 - rV / maxSwirlR) * max(uVortexAndTide.z * 2.2, hurricaneStrength * 2.8);
      float cs = cos(swirlAngle);
      float sn = sin(swirlAngle);
      globalXZ += vec2(dVortex.x * cs - dVortex.y * sn, dVortex.x * sn + dVortex.y * cs) - dVortex;
    }
  }

  vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
  int genusId = int(uDebugParams.y + 0.5);
  float rainIntensity = uDebugParams.z;
  float densityMult = uDebugParams.w;
  float liftedY = worldPos.y - orographicLiftY;

  float weatherFreq = (genusId == 3 || genusId == 7) ? 1.45 : 1.0;
  vec2 weatherUV = ((globalXZ - boxMin.xz) / boxSize.xz) * weatherFreq + windOffset * 0.00085;
  vec3 weather = texture(uWeatherMap, weatherUV).rgb;

  float eyeClearMask = 1.0;
  float stormBandBoost = 0.0;
  if (hurricaneStrength > 0.01) {
    vec2 dStorm = worldPos.xz - uVortexAndTide.xy;
    float rStorm = length(dStorm);
    float normAlt = clamp((liftedY - boxMin.y) / max(boxSize.y, 10.0), 0.0, 1.0);

    if (stormTypeId == 4) {
      float bowZ = mod(uWindAndTime.z * 38.0, 680.0) - 340.0 + (worldPos.x * worldPos.x) * 0.00065;
      stormBandBoost = exp(-pow((worldPos.z - bowZ) / 85.0, 2.0)) * 0.45 * hurricaneStrength;
    } else {
      float eyeRadius = mix(76.0, 138.0, normAlt);
      eyeClearMask = mix(1.0, smoothstep(eyeRadius * 0.48, eyeRadius * 0.88, rStorm), hurricaneStrength);
      float eyewallRing = exp(-pow((rStorm - eyeRadius) / 36.0, 2.0));
      float bandCount = (stormTypeId == 5) ? 2.0 : 4.0;
      float spiralWave = cos(bandCount * atan(dStorm.y, dStorm.x) - rStorm * 0.024 + uWindAndTime.z * 2.1) * 0.5 + 0.5;
      float outerBands = pow(spiralWave, 1.6) * smoothstep(eyeRadius * 0.8, eyeRadius * 1.5, rStorm);
      stormBandBoost = (eyewallRing * 0.58 + outerBands * 0.34) * hurricaneStrength;
    }
  }

  if (liftedY < boxMin.y) {
    if (highDetail && rainIntensity > 0.01 && worldPos.y >= terrainY) {
      float subH = clamp((worldPos.y - terrainY) / max(boxMin.y - terrainY, 10.0), 0.0, 1.0);
      vec2 shearXZ = globalXZ + uWindAndTime.xy * (boxMin.y - liftedY) * 0.06;
      vec2 rainUV = (shearXZ - boxMin.xz) / boxSize.xz + windOffset * 0.00085;
      float coreCov = clamp(texture(uWeatherMap, rainUV).r + stormBandBoost, 0.0, 1.0) * eyeClearMask;
      float shaftMask = smoothstep(0.45, 0.82, coreCov * uBoundsMaxAndCoverage.w * 1.5);
      if (shaftMask > 0.01) {
        vec3 streakUVW = vec3(shearXZ.x * 0.009, worldPos.y * 0.002 + uWindAndTime.z * 0.45, shearXZ.y * 0.009);
        float streakNoise = texture(uDetailNoise, streakUVW).r;
        outRainShaft = shaftMask * (0.45 + 0.55 * streakNoise) * rainIntensity * edgeMask * clearanceMask * smoothstep(0.0, 0.12, subH);
      }
    }
    return funnelDensity * densityMult;
  }

  if (liftedY > boxMax.y) return funnelDensity * densityMult;
  float h = clamp((liftedY - boxMin.y) / boxSize.y, 0.0, 1.0);

  float coverageBoost = 1.62;
  if (genusId == 1 || genusId == 4 || genusId == 5 || genusId == 8) {
    weather.r = mix(weather.r, 0.78, 0.55);
  } else if (genusId == 9 && h > 0.68) {
    weather.r = max(weather.r, weather.b * 0.92);
    coverageBoost = 1.85;
  }

  float localCoverage = clamp((weather.r * (uBoundsMaxAndCoverage.w * coverageBoost) + orographicMod + stormBandBoost) * eyeClearMask, 0.0, 1.0);
  if (localCoverage <= 0.03) return funnelDensity * densityMult;

  float heightProfile = computeGenusHeightProfile(genusId, h, weather);
  if (heightProfile <= 0.001) return funnelDensity * densityMult;

  vec2 shearedXZ = globalXZ + windOffset + vec2(h * uCloudShapeParams.w * 85.0, h * uCloudShapeParams.w * 35.0);
  float cellularity = uCloudShapeParams.z;

  vec3 macroUVW = vec3(shearedXZ.x * uCloudShapeParams.x, liftedY * uCloudShapeParams.y, shearedXZ.y * uCloudShapeParams.x) * 0.0024;
  if (genusId == 6) {
    macroUVW.x *= 0.42;
    macroUVW.z *= 1.85;
  }

  vec4 macro = texture(uMacroNoise, macroUVW);
  float worleyFbm = dot(macro.gba, vec3(0.625, 0.25, 0.125));
  float remapLow = mix(-0.35, -(1.0 - worleyFbm) * 0.75, cellularity);
  float baseShape = remap(mix(macro.r, worleyFbm, cellularity * 0.42), remapLow, 1.0, 0.0, 1.0);

  if (genusId == 3 || genusId == 7) {
    float ripple = sin(shearedXZ.x * 0.045 + macro.g * 3.5) * 0.5 + 0.5;
    baseShape *= mix(0.68, 1.18, ripple * worleyFbm);
  }

  float baseDensity = clamp(remap(baseShape * heightProfile, 1.0 - localCoverage, 1.0, 0.0, 1.0), 0.0, 1.0) * edgeMask * clearanceMask;
  if (!highDetail || baseDensity <= 0.001) {
    return max(baseDensity, funnelDensity) * densityMult;
  }

  float detailFreq = (genusId == 6 || genusId == 7) ? 0.016 : 0.0115;
  vec3 detailUVW = vec3(shearedXZ.x * 1.35, liftedY + uWindAndTime.z * 1.5, shearedXZ.y * 1.35) * detailFreq;
  float detailFbm = dot(texture(uDetailNoise, detailUVW).rgb, vec3(0.625, 0.25, 0.125));
  float detailModifier = mix(detailFbm, 1.0 - detailFbm, clamp(h * 2.2, 0.0, 1.0));

  float erosionWeight = uViewportAndFar.w * mix(0.55, 1.15, cellularity);
  float finalDensity = remap(baseDensity, detailModifier * erosionWeight, 1.0, 0.0, 1.0);
  return max(max(finalDensity, 0.0), funnelDensity) * densityMult;
}

float marchSunTransmittance(vec3 samplePos, vec3 sunDir) {
  float stepLen = 18.0;
  float opticalDepth = 0.0;
  vec3 pos = samplePos;
  float dummyRain = 0.0;
  float maxSlabTop = uBoundsMaxAndCoverage.y + 65.0;

  for (int i = 0; i < 3; i++) {
    pos += sunDir * stepLen;
    if (pos.y > maxSlabTop) break;
    opticalDepth += sampleCloudDensity(pos, false, dummyRain) * stepLen;
    stepLen *= 1.65;
  }

  float ext = uWindAndTime.w;
  float beer = max(exp(-opticalDepth * ext), exp(-opticalDepth * ext * 0.28) * 0.72);
  float powder = 1.0 - exp(-opticalDepth * ext * 2.4);
  return mix(beer, beer * (0.52 + 0.88 * powder), 0.68);
}

void main() {
  vec3 rayOrigin = uCameraPosAndSteps.xyz;
  vec3 rayDir = normalize(vWorldPos - rayOrigin);
  vec3 safeRayDir = mix(rayDir, vec3(1e-5), lessThan(abs(rayDir), vec3(1e-5)));

  vec3 marchBoxMin = uBoundsMinAndFade.xyz;
  if (uDebugParams.z > 0.01 || uVortexAndTide.z > 0.01) {
    marchBoxMin.y = min(uVortexAndTide.w, 0.0);
  }
  vec3 marchBoxMax = uBoundsMaxAndCoverage.xyz + vec3(0.0, 65.0, 0.0);

  vec2 hit = intersectAABB(rayOrigin, safeRayDir, marchBoxMin, marchBoxMax);
  float tNear = hit.x;
  float tFar = hit.y;

  vec2 screenUV = gl_FragCoord.xy / uViewportAndFar.xy;
  float depthSample = texture(uSceneDepth, screenUV).r;
  float zView = linearizeDepth(depthSample, uCameraForwardAndNear.w, uViewportAndFar.z);
  float tScene = zView / max(dot(rayDir, uCameraForwardAndNear.xyz), 0.001);

  int debugMode = int(uDebugParams.x + 0.5);

  if (debugMode == 2) {
    float normDepth = clamp(tScene / 950.0, 0.0, 1.0);
    float contour = 1.0 - smoothstep(0.0, 0.06, abs(fract(tScene / 50.0) - 0.5));
    vec3 depthCol = normDepth < 0.45
      ? mix(vec3(0.12, 0.85, 0.95), vec3(0.18, 0.42, 0.88), normDepth / 0.45)
      : mix(vec3(0.18, 0.42, 0.88), vec3(0.05, 0.09, 0.18), (normDepth - 0.45) / 0.55);
    depthCol = mix(depthCol, vec3(1.0, 0.95, 0.75), contour * 0.35);
    fragColor = vec4(depthCol * 0.92, 0.92);
    return;
  }

  if (debugMode == 3) {
    float sliceY = mix(uBoundsMinAndFade.y, uBoundsMaxAndCoverage.y, 0.35);
    float denomY = abs(rayDir.y) > 1e-4 ? rayDir.y : (rayDir.y >= 0.0 ? 1e-4 : -1e-4);
    float tSlice = (sliceY - rayOrigin.y) / denomY;
    vec3 slicePos = rayOrigin + rayDir * (tSlice > 0.0 ? min(tSlice, tScene) : max(tNear, 60.0));

    vec2 boxMinXZ = uBoundsMinAndFade.xz;
    vec2 boxMaxXZ = uBoundsMaxAndCoverage.xz;
    vec2 normXZ = abs((slicePos.xz - 0.5 * (boxMinXZ + boxMaxXZ)) / (0.5 * (boxMaxXZ - boxMinXZ)));
    if (max(normXZ.x, normXZ.y) > 1.0) discard;

    float terrainY = 0.0, clearanceMask = 1.0, orographicLiftY = 0.0, orographicMod = 0.0;
    vec2 flowOffsetXZ = vec2(0.0);
    evaluateTopographicAirflow(slicePos, uBoundsMinAndFade.xyz, uBoundsMaxAndCoverage.xyz - uBoundsMinAndFade.xyz, terrainY, clearanceMask, flowOffsetXZ, orographicLiftY, orographicMod);

    if (slicePos.y < terrainY + 2.0) {
      vec3 rockCol = mix(vec3(0.14, 0.16, 0.20), vec3(1.0, 0.68, 0.20), smoothstep(terrainY - 12.0, terrainY + 2.0, slicePos.y));
      fragColor = vec4(rockCol * 0.94, 0.94);
      return;
    }

    vec2 globalSliceXZ = slicePos.xz + uWorldOriginOffset.xy + flowOffsetXZ;
    vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
    vec4 macro = texture(uMacroNoise, vec3(globalSliceXZ.x + windOffset.x, slicePos.y - orographicLiftY, globalSliceXZ.y + windOffset.y) * 0.0024);
    vec3 detail = texture(uDetailNoise, vec3(globalSliceXZ.x + windOffset.x * 1.35, slicePos.y - orographicLiftY + uWindAndTime.z * 1.5, globalSliceXZ.y + windOffset.y * 1.35) * 0.011).rgb;
    float dummyRain = 0.0;
    float sculptedDensity = sampleCloudDensity(slicePos, true, dummyRain);

    float thresholdRing = 1.0 - smoothstep(0.0, 0.035, abs(sculptedDensity - 0.08));
    vec3 noiseVis = mix(vec3(macro.r, macro.g, detail.r), vec3(0.22, 0.95, 1.0), thresholdRing * (sculptedDensity > 0.001 ? 0.75 : 0.0));
    fragColor = vec4(noiseVis * 0.94, 0.94);
    return;
  }

  tFar = min(tFar, tScene);
  if (tNear >= tFar) discard;

  int maxSteps = int(uCameraPosAndSteps.w);
  float baseStep = max((tFar - tNear) / float(maxSteps), 2.2);
  float jitter = texelFetch(uBlueNoise, ivec2(mod(gl_FragCoord.xy, 64.0)), 0).r;

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
  int genusId = int(uDebugParams.y + 0.5);
  float rainIntensity = uDebugParams.z;
  float tornadoStrength = uVortexAndTide.z;
  float hurricaneStrength = uWorldOriginOffset.w;
  float lightningIntensity = uSunDirAndElevation.w;

  float stormActivity = max(lightningIntensity, max(tornadoStrength, hurricaneStrength) * 0.85);
  float flashWave = pow(max(sin(uWindAndTime.z * 7.3) * sin(uWindAndTime.z * 19.7), 0.0), 10.0);
  float lightningPulse = stormActivity > 0.02 ? flashWave * stormActivity * 7.5 : 0.0;
  float flashAngle = uWindAndTime.z * 3.7;
  float flashRadius = hurricaneStrength > 0.2 ? 95.0 : 0.0;
  vec3 lightningOrigin = vec3(uVortexAndTide.x + cos(flashAngle) * flashRadius, uBoundsMinAndFade.y + 45.0, uVortexAndTide.y + sin(flashAngle) * flashRadius);

  bool inCloud = false;
  float weightedDist = 0.0;
  float totalWeight = 0.0;

  for (int i = 0; i < 80; i++) {
    if (i >= maxSteps || t >= tFar || transmittance < 0.015) break;

    vec3 pos = rayOrigin + rayDir * t;
    float stepSize = inCloud ? baseStep : baseStep * 1.85;
    float rainShaft = 0.0;
    float density = sampleCloudDensity(pos, inCloud, rainShaft);

    if (density > 0.001 || rainShaft > 0.001) {
      if (!inCloud && density > 0.001) {
        t = max(tNear, t - baseStep);
        inCloud = true;
        continue;
      }

      float surfaceFade = smoothstep(0.0, terrainFadeDist, max(tScene - t, 0.0));
      density *= surfaceFade;
      rainShaft *= surfaceFade;

      if (density > 0.001) {
        float heightFrac = clamp((pos.y - uBoundsMinAndFade.y) / (uBoundsMaxAndCoverage.y - uBoundsMinAndFade.y), 0.0, 1.0);
        vec3 directLight = sunRadiance * marchSunTransmittance(pos, sunDir) * (0.28 + 1.35 * phase);

        float baseDarkening = ((genusId == 5 || genusId == 9) ? 0.18 : 0.34) * mix(1.0, 0.55, max(rainIntensity, tornadoStrength * 0.75));
        vec3 indirectLight = mix(ambientSky * baseDarkening, mix(ambientSky * 1.22, vec3(0.96, 0.98, 1.0), 0.35), smoothstep(0.0, 0.85, heightFrac));

        vec3 lightningLight = lightningPulse > 0.01
          ? vec3(0.65, 0.82, 1.0) * (lightningPulse * exp(-length(pos - lightningOrigin) / 145.0))
          : vec3(0.0);

        float stepTransmittance = exp(-density * extinctionCoeff * stepSize);
        float stepAlpha = transmittance * (1.0 - stepTransmittance);
        scatteredLight += stepAlpha * (directLight + indirectLight + lightningLight);
        weightedDist += t * stepAlpha;
        totalWeight += stepAlpha;
        transmittance *= stepTransmittance;
      }

      if (rainShaft > 0.001) {
        float rainTrans = exp(-rainShaft * 0.011 * stepSize);
        float rAlpha = transmittance * (1.0 - rainTrans);
        scatteredLight += rAlpha * mix(ambientSky * 0.52, sunRadiance * 0.25 + ambientSky * 0.45, 0.35);
        weightedDist += t * rAlpha;
        totalWeight += rAlpha;
        transmittance *= rainTrans;
      }
    } else {
      inCloud = false;
    }

    t += stepSize;
  }

  if (debugMode == 1) {
    vec3 transVis = transmittance <= 0.015 ? vec3(0.95, 0.35, 0.15) : vec3(transmittance);
    fragColor = vec4(transVis * 0.90, 0.90);
    return;
  }

  float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
  if (alpha <= 0.002) discard;

  vec3 cloudColor = scatteredLight / max(alpha, 0.0001);
  cloudColor += sunRadiance * (pow(max(cosTheta, 0.0), 6.0) * (1.0 - alpha * 0.65) * 0.45);

  float avgDist = totalWeight > 0.0 ? (weightedDist / totalWeight) : tNear;
  float hazeFactor = 1.0 - exp(-max(avgDist - 260.0, 0.0) * (uSkyColorAndHaze.w * 0.52));
  vec3 horizonColor = mix(ambientSky * 0.92, sunRadiance * 0.45 + ambientSky * 0.55, max(cosTheta, 0.0) * 0.40);
  cloudColor = mix(cloudColor, horizonColor, clamp(hazeFactor, 0.0, 0.62));

  fragColor = vec4(cloudColor * alpha, alpha);
}
`;
