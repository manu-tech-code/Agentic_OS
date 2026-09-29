// Nova's face: a sphere of thousands of dots, as the window draws it (apps/desktop/src/components/ParticleOrb.tsx),
// ported from its WebGL shaders. Every dot drifts on its own; the surface flows like liquid.

#include <metal_stdlib>
using namespace metal;

struct Particle {
  packed_float3 dir;
  packed_float2 seed;
  float shell;
};

struct Uniforms {
  float time, flow, energy, pulse, turb, spin, scale, point, bright, unused;
  float3 top, mid, low;
};

struct Dot {
  float4 position [[position]];
  float size [[point_size]];
  float3 color;
  float alpha;
};

static float hash3(float3 p) {
  p = fract(p * 0.3183099 + float3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// Smooth value noise in -1..1.
static float noise3(float3 x) {
  float3 i = floor(x);
  float3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash3(i), hash3(i + float3(1, 0, 0)), f.x), mix(hash3(i + float3(0, 1, 0)), hash3(i + float3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(hash3(i + float3(0, 0, 1)), hash3(i + float3(1, 0, 1)), f.x), mix(hash3(i + float3(0, 1, 1)), hash3(i + float3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z) * 2.0 - 1.0;
}

vertex Dot orbVertex(uint id [[vertex_id]], const device Particle *dots [[buffer(0)]], constant Uniforms &u [[buffer(1)]]) {
  float3 d = float3(dots[id].dir);
  float2 seed = float2(dots[id].seed);
  float shell = dots[id].shell;
  // A flowing, liquid surface: noise, bent by more noise so it swirls rather than scrolls.
  float3 q = d + 0.3 * float3(noise3(d * 1.1 + u.flow), noise3(d * 1.1 - u.flow + 5.2), noise3(d * 1.1 + float3(9.1, u.flow, 0.0)));
  float n1 = noise3(q * 1.4 + float3(0.0, u.flow, u.flow * 0.7));
  float n2 = noise3(q * 3.1 - float3(u.flow * 1.3, u.flow * 0.4, 0.0));
  float disp = n1 * 0.7 + n2 * 0.3;
  float r = 1.0 + disp * (0.06 + u.turb * 0.08 + u.energy * 0.2 + u.pulse * 0.08);
  // Waves that travel over the sphere while it's active.
  r += sin(d.y * 8.0 + n1 * 3.0 - u.time * 6.0) * 0.02 * u.energy;
  // Loose dust around the edge, flung wider by sound.
  r += shell * (0.03 + seed.x * seed.x * 0.28) * (0.7 + u.energy * 1.6);
  float3 p = d * r;
  // Every dot drifts on its own little orbit.
  float wobble = 0.008 + u.energy * 0.03 + shell * 0.018;
  p += wobble * float3(sin(u.time * (0.8 + seed.x) + seed.y * 6.2832),
                       cos(u.time * (1.1 + seed.y) + seed.x * 6.2832),
                       sin(u.time * (0.6 + seed.x * 0.7) + seed.y * 12.566));
  // Spin, with a slight tilt toward the viewer.
  float c = cos(u.spin), s = sin(u.spin);
  p = float3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
  p = float3(p.x, 0.949 * p.y - 0.315 * p.z, 0.315 * p.y + 0.949 * p.z);
  float perspective = 6.0 / (6.0 - p.z);

  Dot out;
  out.position = float4(p.xy * perspective * u.scale, 0.0, 1.0);
  float3 n = normalize(p);
  float front = n.z * 0.5 + 0.5;
  float rim = 1.0 - abs(n.z);
  out.size = u.point * (0.9 + seed.x * 1.4) * (0.6 + front * 0.6) * (1.0 + u.energy * 0.35);
  // Colour runs from top to bottom; crests brighten when it's active.
  float h = clamp(d.y * 0.5 + 0.5 + disp * 0.12, 0.0, 1.0);
  float3 col = h > 0.5 ? mix(u.mid, u.top, (h - 0.5) * 2.0) : mix(u.low, u.mid, h * 2.0);
  col = mix(col, float3(1.0), clamp(disp, 0.0, 1.0) * u.energy * 0.35 + seed.y * seed.y * 0.12);
  float twinkle = 0.7 + 0.3 * sin(u.time * (1.5 + seed.x * 3.0) + seed.y * 40.0);
  out.color = col;
  out.alpha = (0.35 + 0.65 * rim) * (0.45 + 0.55 * front) * twinkle * u.bright * (shell > 0.5 ? 0.6 : 1.0);
  return out;
}

fragment float4 orbFragment(Dot in [[stage_in]], float2 at [[point_coord]]) {
  float d = length(at - 0.5);
  if (d > 0.5) discard_fragment();
  float a = in.alpha * (1.0 - smoothstep(0.1, 0.5, d));
  return float4(in.color * a, a); // premultiplied: overlapping dots add up to a glowing rim
}
