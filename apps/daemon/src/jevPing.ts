/**
 * Phase 0 spike: how fast is Jev from where you are?
 *   npm run jev:ping            (10 calls)
 *   npm run jev:ping -- 25
 * Needs AI_GATEWAY_API_KEY in .env.
 */
import { experimental_evaluate as evaluate } from 'ai';
import { buildQuestions, builtinSkills } from '@nova/core';
import { config } from './config.ts';

if (!config.gatewayKey) {
  console.error('Set AI_GATEWAY_API_KEY in .env first.');
  process.exit(1);
}

const n = Number(process.argv[2] ?? 10);
const utterances = ['open slack', 'what time is it', 'set a timer for five minutes', 'quit spotify', 'what is the jevons paradox'];
const apps = ['Safari', 'Slack', 'Spotify', 'Visual Studio Code', 'Terminal', 'Figma', 'Notes'];
const times: number[] = [];

for (let i = 0; i < n; i++) {
  const utterance = utterances[i % utterances.length]!;
  const t0 = performance.now();
  const r = await evaluate({
    model: config.jevModel,
    state: { utterance, wakeWordUsed: true, recentTurns: [] },
    questions: buildQuestions(builtinSkills, apps, utterance),
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
  const ms = Math.round(performance.now() - t0);
  times.push(ms);
  const a = r.answers as Record<string, any>;
  console.log(`${String(ms).padStart(5)} ms  "${utterance}" -> ${a.intent.choice}${a.app ? ` / ${a.app.choice}` : ''}  (model ${r.response.modelId})`);
}

times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
console.log(`\np50 ${pct(50)} ms · p90 ${pct(90)} ms · min ${times[0]} ms · max ${times.at(-1)} ms`);
