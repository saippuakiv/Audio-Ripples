// Fullscreen quad vertex shader (shared by both passes)
export const fullscreenVert = `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// PASS 1 — Wave simulation (pressure + velocity)
// Buffer layout: .x = pressure, .y = velocity, .zw = gradients
export const waveSimFrag = `
  uniform sampler2D heightMap;
  uniform vec2 resolution;
  uniform vec2 clickPos;    // normalized 0-1
  uniform vec2 prevPos;     // previous frame's mouse position (normalized 0-1)
  uniform float addDrop;

  float distToSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 px = 1.0 / resolution;

  vec4 c     = texture2D(heightMap, uv);
  vec4 right = texture2D(heightMap, uv + vec2(px.x, 0.0));
  vec4 left  = texture2D(heightMap, uv - vec2(px.x, 0.0));
  vec4 up    = texture2D(heightMap, uv + vec2(0.0, px.y));
  vec4 down  = texture2D(heightMap, uv - vec2(0.0, px.y));

  float pressure = c.x;
  float pVel     = c.y;

  float p_right = right.x;
  float p_left  = left.x;
  float p_up    = up.x;
  float p_down  = down.x;

  // Boundary reflection
  if (gl_FragCoord.x < 1.0)                p_left  = p_right;
  if (gl_FragCoord.x > resolution.x - 1.0) p_right = p_left;
  if (gl_FragCoord.y < 1.0)                p_down  = p_up;
  if (gl_FragCoord.y > resolution.y - 1.0) p_up    = p_down;

  // Click/drag disturbance — segment between prev and current mouse position
  if (addDrop > 0.5) {
    vec2 curPixel  = clickPos * resolution;
    vec2 prevPixel = prevPos  * resolution;
    float dist = distToSegment(gl_FragCoord.xy, prevPixel, curPixel);
    float influence = smoothstep(8.0, 0.0, dist) * 0.6;
    pVel     -= influence * 0.5;
    pressure += influence * 0.02;
  }

  // Wave equation
  pVel += (-2.0 * pressure + p_right + p_left) / 4.0;
  pVel += (-2.0 * pressure + p_up + p_down) / 4.0;

  // Viscosity
  float vel_smooth = (right.y + left.y + up.y + down.y) * 0.25;
  pVel = mix(pVel, vel_smooth, 0.05);

  pressure += pVel;

  // Damping
  pVel *= 0.995;
  pVel -= 0.005 * pressure;

  // Gradients
  float dx = (p_right - p_left) / 2.0;
  float dy = (p_up - p_down) / 2.0;

  gl_FragColor = vec4(pressure, pVel, dx, dy);
}
`;

// PASS 2 — Render: displace background UV + sunlight glint
export const renderFrag = `
  uniform sampler2D heightMap;
  uniform sampler2D backgroundImage;
  uniform vec2 resolution;
  uniform vec2 bgImageSize;

  // Cover-fit UV: center-crop to preserve aspect ratio
  vec2 coverUV(vec2 uv) {
    float screenAspect = resolution.x / resolution.y;
    float imageAspect = bgImageSize.x / bgImageSize.y;
    vec2 scale = vec2(1.0);
    if (screenAspect > imageAspect) {
      scale.y = imageAspect / screenAspect;
    } else {
      scale.x = screenAspect / imageAspect;
    }
    return (uv - 0.5) * scale + 0.5;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution;

    vec4 data = texture2D(heightMap, uv);

    // Displace background sampling using gradients
    vec4 bgColor = texture2D(backgroundImage, coverUV(uv + 0.2 * data.zw));

    // Sunlight glint (specular highlight)
    vec3 normal = normalize(vec3(-data.z, 0.2, -data.w));
    vec3 lightDir = normalize(vec3(-3.0, 10.0, 3.0));
    float glint = pow(max(0.0, dot(normal, lightDir)), 60.0);

    vec3 color = bgColor.rgb + vec3(glint);

    // White overlay
    gl_FragColor = vec4(color, 1.0);
  }
`;
