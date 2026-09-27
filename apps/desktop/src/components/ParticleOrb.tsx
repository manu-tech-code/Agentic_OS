import { useEffect, useRef, type RefObject } from 'react';
import type { OrbPrefs, Phase } from '@nova/core/protocol';
import { onSpeech } from '../voice/voice';

/**
 * Nova's face as a sphere of thousands of dots, drawn by the GPU. Every dot drifts on its
 * own; the surface flows like liquid; the whole sphere breathes when idle, ripples with your
 * voice when listening, swirls when thinking and pulses with each word when speaking.
 */

type RGB = [number, number, number];

/** Top, middle and bottom colours of each palette. */
export const ORB_PALETTES: Record<OrbPrefs['colors'], [string, string, string]> = {
  nova: ['#5cd6ff', '#6b63ff', '#c65cff'],
  aurora: ['#3dffc8', '#3d8bff', '#9b5cff'],
  ember: ['#4fa3ff', '#d04dff', '#ff7a45'],
  ice: ['#f3f8ff', '#9ec4ff', '#5b6cff'],
};
const THINKING_TINT: RGB = [1, 0.36, 0.84];

/** How each phase moves: surface flow, turbulence, spin (rad/s) and brightness. */
const LOOK: Record<Phase, { flow: number; turb: number; spin: number; bright: number; tint: number }> = {
  idle: { flow: 0.08, turb: 0.35, spin: 0.05, bright: 0.85, tint: 0 },
  listening: { flow: 0.14, turb: 0.55, spin: 0.09, bright: 1, tint: 0 },
  thinking: { flow: 0.4, turb: 0.95, spin: 0.55, bright: 1, tint: 1 },
  acting: { flow: 0.28, turb: 0.75, spin: 0.3, bright: 1.05, tint: 0 },
  speaking: { flow: 0.2, turb: 0.65, spin: 0.12, bright: 1.15, tint: 0 },
};
const MOTION: Record<OrbPrefs['motion'], number> = { lively: 1, calm: 0.45, still: 0.12 };

const VERTEX = `
precision highp float;
attribute vec3 a_dir;
attribute vec2 a_seed;
attribute float a_shell;
uniform float u_time, u_flow, u_energy, u_pulse, u_turb, u_spin, u_scale, u_point, u_bright;
uniform vec3 u_top, u_mid, u_low;
varying vec3 v_color;
varying float v_alpha;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// Smooth value noise in -1..1.
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z) * 2.0 - 1.0;
}

void main() {
  vec3 d = a_dir;
  // A flowing, liquid surface: noise, bent by more noise so it swirls rather than scrolls.
  vec3 q = d + 0.3 * vec3(noise(d * 1.1 + u_flow), noise(d * 1.1 - u_flow + 5.2), noise(d * 1.1 + vec3(9.1, u_flow, 0.0)));
  float n1 = noise(q * 1.4 + vec3(0.0, u_flow, u_flow * 0.7));
  float n2 = noise(q * 3.1 - vec3(u_flow * 1.3, u_flow * 0.4, 0.0));
  float disp = n1 * 0.7 + n2 * 0.3;
  float r = 1.0 + disp * (0.06 + u_turb * 0.08 + u_energy * 0.2 + u_pulse * 0.08);
  // Waves that travel over the sphere while it's active.
  r += sin(d.y * 8.0 + n1 * 3.0 - u_time * 6.0) * 0.02 * u_energy;
  // Loose dust around the edge, flung wider by sound.
  r += a_shell * (0.03 + a_seed.x * a_seed.x * 0.28) * (0.7 + u_energy * 1.6);
  vec3 p = d * r;
  // Every dot drifts on its own little orbit.
  float wobble = 0.008 + u_energy * 0.03 + a_shell * 0.018;
  p += wobble * vec3(
    sin(u_time * (0.8 + a_seed.x) + a_seed.y * 6.2832),
    cos(u_time * (1.1 + a_seed.y) + a_seed.x * 6.2832),
    sin(u_time * (0.6 + a_seed.x * 0.7) + a_seed.y * 12.566));
  // Spin, with a slight tilt toward the viewer.
  float c = cos(u_spin), s = sin(u_spin);
  p = vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
  p = vec3(p.x, 0.949 * p.y - 0.315 * p.z, 0.315 * p.y + 0.949 * p.z);
  float perspective = 6.0 / (6.0 - p.z);
  gl_Position = vec4(p.xy * perspective * u_scale, 0.0, 1.0);

  vec3 n = normalize(p);
  float front = n.z * 0.5 + 0.5;
  float rim = 1.0 - abs(n.z);
  gl_PointSize = u_point * (0.9 + a_seed.x * 1.4) * (0.6 + front * 0.6) * (1.0 + u_energy * 0.35);
  // Colour runs from top to bottom; crests brighten when it's active.
  float h = clamp(d.y * 0.5 + 0.5 + disp * 0.12, 0.0, 1.0);
  vec3 col = h > 0.5 ? mix(u_mid, u_top, (h - 0.5) * 2.0) : mix(u_low, u_mid, h * 2.0);
  col = mix(col, vec3(1.0), clamp(disp, 0.0, 1.0) * u_energy * 0.35 + a_seed.y * a_seed.y * 0.12);
  float twinkle = 0.7 + 0.3 * sin(u_time * (1.5 + a_seed.x * 3.0) + a_seed.y * 40.0);
  v_color = col;
  v_alpha = (0.35 + 0.65 * rim) * (0.45 + 0.55 * front) * twinkle * u_bright * (a_shell > 0.5 ? 0.6 : 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = v_alpha * smoothstep(0.5, 0.1, d);
  gl_FragColor = vec4(v_color * a, a);
}`;

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;

/** Evenly spread dots on a sphere, plus loose dust around it. Seeded, so the sphere always looks the same. */
function makeParticles(surface: number, dust: number) {
  let s = 0x9e3779b9;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = surface + dust;
  const dir = new Float32Array(n * 3);
  const seed = new Float32Array(n * 2);
  const shell = new Float32Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    let x: number, y: number, z: number;
    if (i < surface) {
      y = 1 - (2 * (i + 0.5)) / surface;
      const r = Math.sqrt(1 - y * y);
      x = Math.cos(i * golden) * r;
      z = Math.sin(i * golden) * r;
    } else {
      y = rand() * 2 - 1;
      const r = Math.sqrt(1 - y * y);
      const a = rand() * Math.PI * 2;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      shell[i] = 1;
    }
    dir.set([x, y, z], i * 3);
    seed.set([rand(), rand()], i * 2);
  }
  return { dir, seed, shell, n };
}

type Uniforms = {
  time: number;
  flow: number;
  energy: number;
  pulse: number;
  turb: number;
  spin: number;
  bright: number;
  colors: [RGB, RGB, RGB];
};

/** The WebGL side: compiled once per canvas. Null when the browser can't do WebGL. */
function createRenderer(canvas: HTMLCanvasElement, count: { surface: number; dust: number }) {
  const opts: WebGLContextAttributes = { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' };
  const gl = (canvas.getContext('webgl2', opts) ?? canvas.getContext('webgl', opts)) as WebGLRenderingContext | null;
  if (!gl || gl.isContextLost()) return null;
  const shader = (type: number, source: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader failed');
    return sh;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
  gl.useProgram(program);

  const { dir, seed, shell, n } = makeParticles(count.surface, count.dust);
  const buffers: WebGLBuffer[] = [];
  const attribute = (name: string, data: Float32Array, size: number) => {
    const buffer = gl.createBuffer()!;
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  attribute('a_dir', dir, 3);
  attribute('a_seed', seed, 2);
  attribute('a_shell', shell, 1);
  const u = (name: string) => gl.getUniformLocation(program, name);
  const loc = {
    time: u('u_time'), flow: u('u_flow'), energy: u('u_energy'), pulse: u('u_pulse'), turb: u('u_turb'), spin: u('u_spin'),
    scale: u('u_scale'), point: u('u_point'), bright: u('u_bright'), top: u('u_top'), mid: u('u_mid'), low: u('u_low'),
  };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE); // colours arrive premultiplied: overlapping dots add up to a glowing rim

  return {
    draw(v: Uniforms) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(loc.time, v.time);
      gl.uniform1f(loc.flow, v.flow);
      gl.uniform1f(loc.energy, v.energy);
      gl.uniform1f(loc.pulse, v.pulse);
      gl.uniform1f(loc.turb, v.turb);
      gl.uniform1f(loc.spin, v.spin);
      gl.uniform1f(loc.scale, 0.57);
      gl.uniform1f(loc.point, Math.max(1.4, (w / 420) * 1.9));
      gl.uniform1f(loc.bright, v.bright);
      gl.uniform3fv(loc.top, v.colors[0]);
      gl.uniform3fv(loc.mid, v.colors[1]);
      gl.uniform3fv(loc.low, v.colors[2]);
      gl.drawArrays(gl.POINTS, 0, n);
    },
    /** Frees the GPU memory but keeps the context, which the same canvas may use again. */
    dispose() {
      buffers.forEach((b) => gl.deleteBuffer(b));
      gl.deleteProgram(program);
    },
  };
}

export interface ParticleOrbProps {
  phase: Phase;
  /** Microphone level, 0..1, while listening. */
  levelRef: RefObject<number>;
  prefs: OrbPrefs;
  /** Fewer dots for small previews. */
  small?: boolean;
  /** Called when this browser can't draw it, so the caller can fall back. */
  onUnsupported?: () => void;
  className?: string;
}

/** The dot sphere itself: a canvas that fills its container. */
export function ParticleOrb({ phase, levelRef, prefs, small, onUnsupported, className }: ParticleOrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const glow = useRef<HTMLSpanElement>(null);
  const live = useRef({ phase, prefs });
  live.current = { phase, prefs };

  useEffect(() => {
    const el = canvas.current!;
    const count = small ? { surface: 3600, dust: 900 } : { surface: 11000, dust: 3000 };
    const create = () => {
      try {
        return createRenderer(el, count);
      } catch (e) {
        console.warn('Particle orb unavailable:', e);
        return null;
      }
    };
    let renderer = create();
    if (!renderer) {
      onUnsupported?.();
      return;
    }
    // The GPU can drop the context (a driver reset, too many tabs); draw again once it's back.
    const lost = (e: Event) => {
      e.preventDefault();
      renderer = null;
    };
    const restored = () => (renderer = create());
    el.addEventListener('webglcontextlost', lost);
    el.addEventListener('webglcontextrestored', restored);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let pulse = 0;
    // With the natural voice, the Orb follows how loud Nova actually is.
    let voiceLevel = 0;
    let voiceAt = 0;
    const stopListening = onSpeech((e) => {
      if (e.type === 'level') {
        if (e.value - voiceLevel > 0.1) pulse = Math.min(1, pulse + 0.5); // a syllable starting
        voiceLevel = e.value;
        voiceAt = performance.now();
      }
    });

    const look = { ...LOOK[live.current.phase] };
    const colors = ORB_PALETTES[live.current.prefs.colors].map(hex) as [RGB, RGB, RGB];
    let energy = 0;
    let spin = 0;
    let flow = 0;
    let time = 0;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { phase: ph, prefs: p } = live.current;
      const motion = Math.min(MOTION[p.motion] ?? 1, reduceMotion?.matches ? MOTION.calm : 1);
      const t = now / 1000;

      // How active the sphere should be right now.
      let target: number;
      if (ph === 'listening') target = 0.08 + Math.min(1, (levelRef.current ?? 0) * 1.8);
      else if (ph === 'speaking') {
        if (now - voiceAt < 300) target = 0.18 + Math.min(1, voiceLevel * 1.4) * 0.75 + 0.4 * pulse;
        else {
          const syllables = Math.max(0, Math.sin(t * 27 + 1.7 * Math.sin(t * 2.1)));
          target = 0.3 + 0.4 * syllables * (0.65 + 0.35 * Math.sin(t * 2.2)) + 0.55 * pulse;
        }
      } else if (ph === 'thinking') target = 0.28 + 0.08 * Math.sin(t * 3.1);
      else if (ph === 'acting') target = 0.4;
      else target = 0.05 + 0.03 * Math.sin(t * 0.8);
      pulse *= Math.exp(-dt * 7);
      energy += (target - energy) * (1 - Math.exp(-dt * (target > energy ? 14 : 4)));

      // Ease the look and colours toward the phase, so changes melt rather than jump.
      const ease = 1 - Math.exp(-dt * 3);
      const want = LOOK[ph];
      for (const k of ['flow', 'turb', 'spin', 'bright', 'tint'] as const) look[k] += (want[k] - look[k]) * ease;
      const palette = ORB_PALETTES[p.colors] ?? ORB_PALETTES.nova;
      palette.forEach((h, i) => {
        const target = hex(h).map((v, j) => v + (THINKING_TINT[j]! - v) * look.tint * 0.35);
        colors[i] = colors[i]!.map((v, j) => v + (target[j]! - v) * ease) as RGB;
      });

      time += dt * motion;
      flow += dt * look.flow * motion;
      spin += dt * look.spin * (0.3 + 0.7 * motion) * (1 + energy * 0.5);
      const shown = energy * (0.35 + 0.65 * motion);
      renderer?.draw({ time, flow, energy: shown, pulse: pulse * motion, turb: look.turb * motion, spin, bright: look.bright, colors });
      glow.current?.style.setProperty('--level', shown.toFixed(3));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      stopListening();
      el.removeEventListener('webglcontextlost', lost);
      el.removeEventListener('webglcontextrestored', restored);
      renderer?.dispose();
    };
    // The canvas is set up once; phase and preferences are read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [small]);

  const [, mid] = ORB_PALETTES[prefs.colors] ?? ORB_PALETTES.nova;
  return (
    <span className={`particle-orb ${className ?? ''}`} aria-hidden>
      <span ref={glow} className="particle-orb__glow" style={{ ['--glow' as string]: mid }} />
      <canvas ref={canvas} className="particle-orb__canvas" />
    </span>
  );
}
