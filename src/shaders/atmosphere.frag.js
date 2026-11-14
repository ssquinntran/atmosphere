/**
 * Custom #version 300 es volumetric cloud, topographic airflow & precipitation fragment shader.
 * Features:
 * - Analytical Ray-AABB intersection
 * - 3D Topographic Air-Land Interaction (uTerrainMap):
 *   - Potential-flow streamline deflection around mountain flanks & into canyon gorges
 *   - Orographic updraft lift over windward slopes + leeward wake turbulence
 *   - 3D solid-landmass obstacle exclusion (clouds wrap around & over peaks, never through rock)
 * - All 10 WMO cloud genera profiles (Cumulus, Stratus, Stratocumulus, Altocumulus,
 *   Altostratus, Nimbostratus, Cirrus, Cirrocumulus, Cirrostratus, Cumulonimbus)
 * - Volumetric sub-cloud rain shafts (virga / precipitation columns)
 * - Off-axis radial ray distance (tScene) depth compositing + soft terrain feathering
 * - Relative-To-Center (RTC) floating-origin world offset (uWorldOriginOffset)
 * - Blue-noise start jitter + adaptive empty-space stride skipping
 * - Multi-octave Beer-Lambert extinction, 5-step sun self-shadowing + powder edge term
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
uniform vec4 uDebugParams;           // x: debugMode (0=Final, 1=Transmittance, 2=Depth, 3=NoiseSlice), y: cloudGenusId (0..9), z: rainIntensity (0..1), w: densityMultiplier
uniform vec4 uWorldOriginOffset;     // xy: floating-origin RTC offset XZ (meters), zw: reserved
uniform vec4 uCloudShapeParams;      // x: horizontalScale, y: verticalStretch, z: cellularity (0=stratiform, 1=cumuliform), w: wispsAndShear

uniform sampler3D uMacroNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeatherMap;
uniform sampler2D uBlueNoise;
uniform sampler2D uTerrainMap;       // R: height/380m, G: dH/dx [0..1], B: dH/dz [0..1], A: canyonFunnelMask
uniform sampler2D uSceneDepth;

const float PI = 3.14159265359;
const float TERRAIN_MAX_NORM_H = 380.0;

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
  float forwardLobe = henyeyGreenstein(cosTheta, 0.72);
  float backLobe    = henyeyGreenstein(cosTheta, -0.30);
  return mix(forwardLobe, backLobe, 0.28);
}

float remap(float val, float low1, float high1, float low2, float high2) {
  return low2 + (val - low1) * (high2 - low2) / max(high1 - low1, 0.0001);
}

/**
 * Evaluates 3D topographic air-land interaction at worldPos:
 * - Solid landmass exclusion (clouds cannot exist inside rock)
 * - Potential-flow horizontal deflection around mountain flanks & funneling into gorges
 * - Orographic vertical lift over windward ridges + windward condensation / leeward dissipation
 */
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

  outTerrainY = tSample.r * TERRAIN_MAX_NORM_H;
  vec2 gradXZ = (tSample.gb - 0.5) * 2.0; // Normalized terrain slope gradient (points uphill)
  float canyonMask = tSample.a;           // 1.0 in flooded gorges, 0.0 on ridges

  // 1. 3D Solid-landmass obstacle exclusion: zero density inside rock, smooth boundary cushion above slope
  outClearanceMask = smoothstep(outTerrainY + 1.0, outTerrainY + 20.0, worldPos.y);

  // Height of air parcel relative to local mountain terrain
  float altAboveTerrain = max(worldPos.y - outTerrainY, 0.0);
  float interactionZone = 1.0 - smoothstep(0.0, 135.0, altAboveTerrain);

  // Wind direction unit vector
  float windLen = length(uWindAndTime.xy);
  vec2 windDir = windLen > 0.01 ? (uWindAndTime.xy / windLen) : vec2(0.848, 0.530);

  // Uphill wind component: positive when air blows directly up a windward mountain slope
  float uphillAlignment = dot(windDir, gradXZ);

  // 2. Orographic vertical lift: air parcel is pushed upward over high terrain & windward slopes
  float baseRidgeLift = clamp(outTerrainY - boxMin.y * 0.45, 0.0, 95.0) * 0.48;
  float windwardUpdraft = max(uphillAlignment, 0.0) * 34.0;
  outOrographicLiftY = (baseRidgeLift + windwardUpdraft) * interactionZone;

  // 3. Horizontal potential-flow streamline deflection around mountain massifs & into gorges:
  //    - Air is pushed away from steep mountain slopes (-gradXZ)
  //    - Air swirls tangentially around peak flanks (perpGrad)
  //    - Air accelerates along low-resistance canyon gorge channels (canyonMask)
  vec2 perpGrad = vec2(-gradXZ.y, gradXZ.x);
  float tangentSign = sign(dot(windDir, perpGrad) + 0.001);
  float blockStrength = smoothstep(25.0, 180.0, outTerrainY) * interactionZone;

  vec2 slopeRepulsion = -gradXZ * (78.0 * blockStrength);
  vec2 flankStream = perpGrad * tangentSign * (56.0 * blockStrength);
  vec2 canyonJet = windDir * (canyonMask * 42.0 * (1.0 - smoothstep(40.0, 195.0, worldPos.y)));

  outFlowOffsetXZ = slopeRepulsion + flankStream + canyonJet;

  // 4. Orographic condensation on windward crests & slight Foehn dissipation in leeward shadow
  outOrographicMod = clamp(uphillAlignment * 0.32 * interactionZone, -0.18, 0.28);
}

// Compute genus-specific vertical profile for all 10 WMO cloud genera (0..9)
float computeGenusHeightProfile(int genusId, float h, vec3 weather) {
  if (genusId == 0) {
    // 0: Cumulus (Cu) — crisp flat condensation base, rounded cauliflower towers
    float maxTop = mix(0.55, 0.98, weather.g);
    return smoothstep(0.0, 0.09, h) * (1.0 - smoothstep(maxTop * 0.55, maxTop, h));
  } else if (genusId == 1) {
    // 1: Stratus (St) — uniform low horizontal sheet with soft upper/lower boundaries
    return smoothstep(0.0, 0.18, h) * (1.0 - smoothstep(0.42, 0.85, h));
  } else if (genusId == 2) {
    // 2: Stratocumulus (Sc) — lumpy honeycomb roll deck with distinct gaps
    float maxTop = mix(0.45, 0.78, weather.g);
    return smoothstep(0.0, 0.11, h) * (1.0 - smoothstep(maxTop * 0.65, maxTop, h));
  } else if (genusId == 3) {
    // 3: Altocumulus (Ac) — mid-altitude mackerel sky cellular puffs
    float maxTop = mix(0.50, 0.85, weather.g);
    return smoothstep(0.05, 0.22, h) * (1.0 - smoothstep(maxTop * 0.68, maxTop, h));
  } else if (genusId == 4) {
    // 4: Altostratus (As) — mid-altitude fibrous gray-blue sheet
    return smoothstep(0.0, 0.22, h) * (1.0 - smoothstep(0.58, 0.94, h));
  } else if (genusId == 5) {
    // 5: Nimbostratus (Ns) — thick, dark, ragged rain-bearing storm deck
    return smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.75, 0.99, h));
  } else if (genusId == 6) {
    // 6: Cirrus (Ci) — high-altitude delicate ice-crystal filaments & mares' tails
    float streakBand = exp(-pow((h - 0.52) * 3.1, 2.0));
    return streakBand;
  } else if (genusId == 7) {
    // 7: Cirrocumulus (Cc) — high-altitude fine rippled ice cloudlets
    return exp(-pow((h - 0.50) * 3.6, 2.0));
  } else if (genusId == 8) {
    // 8: Cirrostratus (Cs) — thin high-altitude translucent ice veil
    return smoothstep(0.08, 0.35, h) * (1.0 - smoothstep(0.65, 0.95, h));
  } else {
    // 9: Cumulonimbus (Cb) — towering convective thunderhead with spreading upper anvil
    float tower = smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.88, 1.0, h));
    float anvilSpread = smoothstep(0.66, 0.84, h) * (1.0 - smoothstep(0.92, 1.0, h));
    return max(tower, anvilSpread * 1.25);
  }
}

float sampleCloudDensity(vec3 worldPos, bool highDetail, out float outRainShaft) {
  outRainShaft = 0.0;
  vec3 boxMin = uBoundsMinAndFade.xyz;
  vec3 boxMax = uBoundsMaxAndCoverage.xyz;
  vec3 boxSize = boxMax - boxMin;

  // Smooth horizontal edge feathering in local camera-centered slab prevents AABB seams
  vec2 normXZ = abs((worldPos.xz - 0.5 * (boxMin.xz + boxMax.xz)) / (0.5 * boxSize.xz));
  float edgeMask = (1.0 - smoothstep(0.82, 1.0, normXZ.x)) *
                   (1.0 - smoothstep(0.82, 1.0, normXZ.y));
  if (edgeMask <= 0.001) return 0.0;

  // Evaluate 3D topographic air-land interaction (deflection around mountains, funneling into canyons, orographic lift)
  float terrainY = 0.0;
  float clearanceMask = 1.0;
  vec2 flowOffsetXZ = vec2(0.0);
  float orographicLiftY = 0.0;
  float orographicMod = 0.0;

  evaluateTopographicAirflow(
    worldPos,
    boxMin,
    boxSize,
    terrainY,
    clearanceMask,
    flowOffsetXZ,
    orographicLiftY,
    orographicMod
  );

  // Reject immediately if sample point is inside solid mountain rock
  if (clearanceMask <= 0.001) return 0.0;

  // Apply Relative-To-Center (RTC) floating-origin offset + topographic streamline deflection
  vec2 globalXZ = worldPos.xz + uWorldOriginOffset.xy + flowOffsetXZ;
  vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;

  int genusId = int(uDebugParams.y + 0.5);
  float rainIntensity = uDebugParams.z;
  float densityMult = uDebugParams.w;

  // Effective altitude after orographic lift over mountain ridges
  float liftedY = worldPos.y - orographicLiftY;

  // Weather map lookup along deflected air streamlines
  float weatherFreq = (genusId == 3 || genusId == 7) ? 1.45 : 1.0;
  vec2 weatherUV = ((globalXZ - boxMin.xz) / boxSize.xz) * weatherFreq + windOffset * 0.00085;
  vec3 weather = texture(uWeatherMap, weatherUV).rgb;

  // Sub-cloud volumetric rain shafts (virga / precipitation curtains below cloud base, blocked by terrain)
  if (liftedY < boxMin.y) {
    if (rainIntensity <= 0.01 || worldPos.y < terrainY) return 0.0;
    float subH = clamp((worldPos.y - terrainY) / max(boxMin.y - terrainY, 10.0), 0.0, 1.0);
    vec2 shearXZ = globalXZ + uWindAndTime.xy * (boxMin.y - liftedY) * 0.06;
    vec2 rainUV = (shearXZ - boxMin.xz) / boxSize.xz + windOffset * 0.00085;
    float coreCov = texture(uWeatherMap, rainUV).r;
    float shaftMask = smoothstep(0.45, 0.82, coreCov * uBoundsMaxAndCoverage.w * 1.5);
    if (shaftMask > 0.01) {
      vec3 streakUVW = vec3(shearXZ.x * 0.009, worldPos.y * 0.002 + uWindAndTime.z * 0.45, shearXZ.y * 0.009);
      float streakNoise = texture(uDetailNoise, streakUVW).r;
      outRainShaft = shaftMask * (0.45 + 0.55 * streakNoise) * rainIntensity * edgeMask * clearanceMask * smoothstep(0.0, 0.12, subH);
    }
    return 0.0;
  }

  // Normalized altitude [0..1] inside cloud slab (using liftedY so clouds arch over windward peaks)
  float h = clamp((liftedY - boxMin.y) / boxSize.y, 0.0, 1.0);
  if (liftedY > boxMax.y) return 0.0;

  // Modulate coverage by weather map, user coverage slider, and windward orographic condensation
  float coverageBoost = 1.62;
  if (genusId == 1 || genusId == 4 || genusId == 5 || genusId == 8) {
    weather.r = mix(weather.r, 0.78, 0.55);
  } else if (genusId == 9 && h > 0.68) {
    weather.r = max(weather.r, weather.b * 0.92);
    coverageBoost = 1.85;
  }

  float localCoverage = clamp(weather.r * (uBoundsMaxAndCoverage.w * coverageBoost) + orographicMod, 0.0, 1.0);
  if (localCoverage <= 0.03) return 0.0;

  float heightProfile = computeGenusHeightProfile(genusId, h, weather);
  if (heightProfile <= 0.001) return 0.0;

  // Apply wind shear for cirrus filaments and anvil tops
  float shearStrength = uCloudShapeParams.w;
  vec2 shearedXZ = globalXZ + windOffset + vec2(h * shearStrength * 85.0, h * shearStrength * 35.0);

  float horizScale = uCloudShapeParams.x;
  float vertStretch = uCloudShapeParams.y;
  float cellularity = uCloudShapeParams.z;

  // Macro 3D Perlin-Worley FBM lookup using deflected XZ and orographically lifted Y
  vec3 macroUVW = vec3(
    shearedXZ.x * horizScale,
    liftedY * vertStretch,
    shearedXZ.y * horizScale
  ) * 0.0024;

  if (genusId == 6) {
    macroUVW.x *= 0.42;
    macroUVW.z *= 1.85;
  }

  vec4 macro = texture(uMacroNoise, macroUVW);
  float worleyFbm = macro.g * 0.625 + macro.b * 0.25 + macro.a * 0.125;

  float RemapLow = mix(-0.35, -(1.0 - worleyFbm) * 0.75, cellularity);
  float baseShape = remap(mix(macro.r, worleyFbm, cellularity * 0.42), RemapLow, 1.0, 0.0, 1.0);

  if (genusId == 3 || genusId == 7) {
    float ripple = sin(shearedXZ.x * 0.045 + macro.g * 3.5) * 0.5 + 0.5;
    baseShape *= mix(0.68, 1.18, ripple * worleyFbm);
  }

  float baseDensity = remap(baseShape * heightProfile, 1.0 - localCoverage, 1.0, 0.0, 1.0);
  baseDensity = clamp(baseDensity, 0.0, 1.0) * edgeMask * clearanceMask;

  if (!highDetail || baseDensity <= 0.001) {
    return baseDensity * densityMult;
  }

  // High-frequency Worley detail erosion (with extra wake curl near mountain ridges)
  float detailFreq = (genusId == 6 || genusId == 7) ? 0.016 : 0.0115;
  vec3 detailUVW = vec3(
    shearedXZ.x * 1.35,
    liftedY + uWindAndTime.z * 1.5,
    shearedXZ.y * 1.35
  ) * detailFreq;

  vec3 detail = texture(uDetailNoise, detailUVW).rgb;
  float detailFbm = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
  float detailModifier = mix(detailFbm, 1.0 - detailFbm, clamp(h * 2.2, 0.0, 1.0));

  float erosionWeight = uViewportAndFar.w * mix(0.55, 1.15, cellularity);
  float finalDensity = remap(baseDensity, detailModifier * erosionWeight, 1.0, 0.0, 1.0);
  return max(finalDensity, 0.0) * densityMult;
}

float marchSunTransmittance(vec3 samplePos, vec3 sunDir) {
  float stepLen = 14.0;
  float opticalDepth = 0.0;
  vec3 pos = samplePos;
  float dummyRain = 0.0;
  float maxSlabTop = uBoundsMaxAndCoverage.y + 65.0;

  for (int i = 0; i < 5; i++) {
    pos += sunDir * stepLen;
    if (pos.y > maxSlabTop) break;
    float d = sampleCloudDensity(pos, false, dummyRain);
    opticalDepth += d * stepLen;
    stepLen *= 1.38;
  }

  float extinction = uWindAndTime.w;
  float beerPrimary = exp(-opticalDepth * extinction);
  float beerSecondary = exp(-opticalDepth * extinction * 0.28) * 0.72;
  float beer = max(beerPrimary, beerSecondary);

  float powder = 1.0 - exp(-opticalDepth * extinction * 2.4);
  return mix(beer, beer * (0.52 + 0.88 * powder), 0.68);
}

void main() {
  vec3 rayOrigin = uCameraPosAndSteps.xyz;
  vec3 rayDir = normalize(vWorldPos - rayOrigin);

  // Prevent division-by-zero on axis-aligned rays
  vec3 safeRayDir = mix(rayDir, vec3(1e-5), lessThan(abs(rayDir), vec3(1e-5)));

  // Expand raymarch box to include +65m orographic lift headroom above peaks and down to y=0 when raining
  vec3 marchBoxMin = uBoundsMinAndFade.xyz;
  if (uDebugParams.z > 0.01) {
    marchBoxMin.y = 0.0;
  }
  vec3 marchBoxMax = uBoundsMaxAndCoverage.xyz + vec3(0.0, 65.0, 0.0);

  vec2 hit = intersectAABB(
    rayOrigin,
    safeRayDir,
    marchBoxMin,
    marchBoxMax
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

  // Debug Mode 3: Horizontal 3D Noise & Topographic Airflow Slice at mid-cloud altitude
  if (debugMode == 3) {
    float sliceY = mix(uBoundsMinAndFade.y, uBoundsMaxAndCoverage.y, 0.35);
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

    float terrainY = 0.0;
    float clearanceMask = 1.0;
    vec2 flowOffsetXZ = vec2(0.0);
    float orographicLiftY = 0.0;
    float orographicMod = 0.0;
    evaluateTopographicAirflow(
      slicePos,
      uBoundsMinAndFade.xyz,
      uBoundsMaxAndCoverage.xyz - uBoundsMinAndFade.xyz,
      terrainY,
      clearanceMask,
      flowOffsetXZ,
      orographicLiftY,
      orographicMod
    );

    // Highlight solid mountain peaks intersecting the horizontal slice
    if (slicePos.y < terrainY + 2.0) {
      float rockRim = smoothstep(terrainY - 12.0, terrainY + 2.0, slicePos.y);
      vec3 rockCol = mix(vec3(0.14, 0.16, 0.20), vec3(1.0, 0.68, 0.20), rockRim);
      fragColor = vec4(rockCol, 0.94);
      return;
    }

    vec2 globalSliceXZ = slicePos.xz + uWorldOriginOffset.xy + flowOffsetXZ;
    vec2 windOffset = uWindAndTime.xy * uWindAndTime.z;
    vec3 macroUVW = vec3(globalSliceXZ.x + windOffset.x, slicePos.y - orographicLiftY, globalSliceXZ.y + windOffset.y) * 0.0024;
    vec3 detailUVW = vec3(
      globalSliceXZ.x + windOffset.x * 1.35,
      slicePos.y - orographicLiftY + uWindAndTime.z * 1.5,
      globalSliceXZ.y + windOffset.y * 1.35
    ) * 0.011;

    vec4 macro = texture(uMacroNoise, macroUVW);
    vec3 detail = texture(uDetailNoise, detailUVW).rgb;
    float dummyRain = 0.0;
    float sculptedDensity = sampleCloudDensity(slicePos, true, dummyRain);

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
  float baseStep = max(marchSpan / float(maxSteps), 2.2);

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
  int genusId = int(uDebugParams.y + 0.5);
  float rainIntensity = uDebugParams.z;

  bool inCloud = false;
  float weightedDist = 0.0;
  float totalWeight = 0.0;

  for (int i = 0; i < 80; i++) {
    if (i >= maxSteps || t >= tFar || transmittance < 0.008) {
      break;
    }

    vec3 pos = rayOrigin + rayDir * t;
    float stepSize = inCloud ? baseStep : baseStep * 1.65;
    float rainShaft = 0.0;
    float density = sampleCloudDensity(pos, inCloud, rainShaft);

    if (density > 0.001 || rainShaft > 0.001) {
      if (!inCloud && density > 0.001) {
        // Step back once upon entering cloud boundary for crisp silhouette integration
        t = max(tNear, t - baseStep);
        inCloud = true;
        continue;
      }

      // Soft terrain/vessel intersection fade prevents sharp polygon clipping
      float distToSurface = max(tScene - t, 0.0);
      float surfaceFade = smoothstep(0.0, terrainFadeDist, distToSurface);
      density *= surfaceFade;
      rainShaft *= surfaceFade;

      if (density > 0.001) {
        float heightFrac = clamp(
          (pos.y - uBoundsMinAndFade.y) / (uBoundsMaxAndCoverage.y - uBoundsMinAndFade.y),
          0.0,
          1.0
        );

        float lightTransmittance = marchSunTransmittance(pos, sunDir);
        vec3 directLight = sunRadiance * lightTransmittance * (0.28 + 1.35 * phase);

        // Rich vertical ambient gradient: dark storm bases, bright sky-lit tops
        float baseDarkening = (genusId == 5 || genusId == 9) ? 0.18 : 0.34;
        baseDarkening *= mix(1.0, 0.55, rainIntensity);
        vec3 bottomAmbient = ambientSky * baseDarkening;
        vec3 topAmbient = mix(ambientSky * 1.22, vec3(0.96, 0.98, 1.0), 0.35);
        vec3 indirectLight = mix(bottomAmbient, topAmbient, smoothstep(0.0, 0.85, heightFrac));

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

      // Integrate sub-cloud volumetric rain shafts (virga / rain curtains)
      if (rainShaft > 0.001) {
        float rainSigma = rainShaft * 0.011;
        float rainTrans = exp(-rainSigma * stepSize);
        vec3 rainCol = mix(ambientSky * 0.52, sunRadiance * 0.25 + ambientSky * 0.45, 0.35);
        scatteredLight += transmittance * rainCol * (1.0 - rainTrans);
        float rAlpha = transmittance * (1.0 - rainTrans);
        weightedDist += t * rAlpha;
        totalWeight += rAlpha;
        transmittance *= rainTrans;
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

  // Subtle contrast & silver-lining rim boost so clouds pop clearly against the sky
  float rimGlow = pow(max(cosTheta, 0.0), 6.0) * (1.0 - alpha * 0.65) * 0.45;
  cloudColor += sunRadiance * rimGlow;

  // Aerial perspective blend into maritime horizon haze (reduced so clouds stay crisp)
  float avgDist = totalWeight > 0.0 ? (weightedDist / totalWeight) : tNear;
  float hazeFactor = 1.0 - exp(-max(avgDist - 260.0, 0.0) * (uSkyColorAndHaze.w * 0.52));
  vec3 horizonColor = mix(
    ambientSky * 0.92,
    sunRadiance * 0.45 + ambientSky * 0.55,
    max(cosTheta, 0.0) * 0.40
  );
  cloudColor = mix(cloudColor, horizonColor, clamp(hazeFactor, 0.0, 0.62));

  fragColor = vec4(cloudColor, alpha);
}
`;
