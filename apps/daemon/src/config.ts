import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import type { EngineKind, FallbackKind } from '@nova/core';

// .env lives at the repo root
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const list = (v: string | undefined, d: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  port: Number(process.env.NOVA_PORT ?? 7878),
  gatewayKey: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || '',
  engine: (process.env.NOVA_DECISION_ENGINE ?? 'auto') as EngineKind,
  fallback: (process.env.NOVA_DECISION_FALLBACK ?? 'heuristic') as FallbackKind,
  timeoutMs: Number(process.env.NOVA_DECISION_TIMEOUT_MS ?? 1500),
  jevModel: process.env.NOVA_JEV_MODEL || 'typesafe-ai/jev',
  brainModel: process.env.NOVA_BRAIN_MODEL ?? '',
  wakeWords: list(process.env.NOVA_WAKE_WORDS, ['hey nova', 'okay nova', 'nova']),
};
