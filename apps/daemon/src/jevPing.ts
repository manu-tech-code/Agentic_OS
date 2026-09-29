/**
 * How fast - and how sure - is Jev from where you are? Real decisions, through Nova's own
 * DecisionEngine (no fallback, so a failure shows as one), timed end to end.
 *   npm run jev:ping            (10 calls)
 *   npm run jev:ping -- 25
 * Needs Jev's key: NOVA_JEV_API_KEY in .env. Each call is billed to it (a few thousand input tokens).
 */
import { buildQuestions, builtinSkills, createDecisionEngine, topProbability } from '@nova/core';
import { loadConfig, loadDotEnv, readSettings } from './config.ts';

loadDotEnv();
const config = loadConfig((await readSettings().catch(() => null)) ?? {}, process.env);

if (!config.jevKey) {
  console.error('Add Jev\'s key first: NOVA_JEV_API_KEY=... in .env.');
  process.exit(1);
}

const n = Number(process.argv[2] ?? 10);
// Longer than Nova waits in use: this measures Jev, not the time limit.
const engine = createDecisionEngine({ engine: 'jev', fallback: 'none', jevApiKey: config.jevKey, jevModel: config.jevModel, timeoutMs: 15_000 });
const utterances = ['open slack', 'what time is it', 'set a timer for five minutes', 'quit spotify', 'what is the jevons paradox'];
const apps = ['Safari', 'Slack', 'Spotify', 'Visual Studio Code', 'Terminal', 'Figma', 'Notes'];
const times: number[] = [];

console.log(`Jev (${config.jevModel}), ${n} decisions:\n`);
for (let i = 0; i < n; i++) {
  const utterance = utterances[i % utterances.length]!;
  try {
    const d = await engine.decide({ utterance, wakeWordUsed: true, recentTurns: [] }, buildQuestions(builtinSkills, apps, utterance));
    times.push(d.latencyMs);
    const a = d.answers as Record<string, any>;
    const sure = d.confidence?.intent !== undefined ? `confidence ${d.confidence.intent.toFixed(2)}` : `p ${topProbability(a.intent).toFixed(2)}`;
    console.log(`${String(d.latencyMs).padStart(5)} ms  "${utterance}" -> ${a.intent.choice}${a.app ? ` / ${a.app.choice}` : ''}  (${sure})`);
  } catch (e) {
    console.log(`  failed  "${utterance}": ${(e as Error).message}`);
  }
}

if (times.length) {
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
  console.log(`\np50 ${pct(50)} ms · p90 ${pct(90)} ms · min ${times[0]} ms · max ${times.at(-1)} ms (Nova waits ${config.timeoutMs} ms, then Reflex decides)`);
}
