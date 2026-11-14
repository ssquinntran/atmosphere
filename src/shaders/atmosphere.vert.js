/**
 * Custom #version 300 es vertex shader for the world-space cloud bounding slab.
 * Rendered with THREE.BackSide so raymarching remains active even when the camera
 * enters the cloud altitude band [yMin, yMax].
 */
export const atmosphereVertexShader = /* glsl */ `
precision highp float;

in vec3 position;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

out vec3 vWorldPos;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;
