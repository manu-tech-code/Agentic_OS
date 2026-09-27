/**
 * How well does Reflex decide? Compares it with the keyword matcher on phrasings it wasn't built from.
 *   npm run reflex:eval
 */
import {
  agentSkills,
  buildQuestions,
  builtinSkills,
  HeuristicEvaluationModel,
  initiativeSkills,
  memorySkills,
  trustSkills,
  REFLEX_PHRASES,
  ReflexEvaluationModel,
  StaticEmbedder,
  topProbability,
  type EvaluationModelV4,
} from '@nova/core';
import { loadDotEnv } from '../config.ts';
import { EVAL_AGENTS, EVAL_APPS, EVAL_PROJECTS, REPLIES, SET_A, SET_B, SET_C, SET_D, SET_E } from './evalSet.ts';
import { DEFAULT_REFLEX_MODEL, readModelFiles } from '../models/files.ts';

loadDotEnv();
const started = performance.now();
const embedder = StaticEmbedder.fromFiles(DEFAULT_REFLEX_MODEL, await readModelFiles(DEFAULT_REFLEX_MODEL));
console.log(`Loaded ${DEFAULT_REFLEX_MODEL} in ${Math.round(performance.now() - started)} ms`);

const tuning = process.env.REFLEX_TUNING ? JSON.parse(process.env.REFLEX_TUNING) : undefined;
// Every test phrasing is held out of what these copies of Reflex learn from (bar one- and two-word replies like
// "yes" or "stop", which any system knows): Nova itself learns from all of it, but a test only counts what's new.
const allCases = [...SET_A, ...SET_B, ...SET_C, ...SET_D, ...SET_E];
const holdOut = {
  texts: [...allCases.map((c) => c.u), ...REPLIES.map((r) => r.u)].filter((u) => u.split(/\s+/).length > 2),
  names: [...EVAL_APPS, ...EVAL_AGENTS.map((a) => a.name), ...EVAL_PROJECTS],
};
// Examples only: the closest-example search on its own, as Reflex was before its classifier.
const examplesOnly = new ReflexEvaluationModel({ embedder, learn: false, tuning, holdOut });
const reflex = new ReflexEvaluationModel({ embedder, learn: false, tuning, holdOut });
const training = reflex.trainingExamples();
const trainStarted = performance.now();
// REFLEX_TRAIN='{"epochs":20}' tries other training settings.
await reflex.train(process.env.REFLEX_TRAIN ? JSON.parse(process.env.REFLEX_TRAIN) : {});
console.log(`Trained the classifier on ${training.length} phrasings in ${Math.round(performance.now() - trainStarted)} ms`);
const keywords = new HeuristicEvaluationModel();
// Every intent Nova has, memory's included (the tool-only skills never reach System 1).
const skills = [...builtinSkills, ...agentSkills, ...memorySkills, ...initiativeSkills, ...trustSkills];
const host = { agents: EVAL_AGENTS, projects: EVAL_PROJECTS } as unknown as Parameters<typeof buildQuestions>[3];

// How many test phrasings the phrase bank and grammar already contain (these are held out above).
const plain = (t: string) => t.toLowerCase().replace(/\W+/g, ' ').trim();
const bank = new Set([...Object.values(REFLEX_PHRASES).flat().map((p) => p.replace(/\{(\w+)\}/g, '$1')), ...new ReflexEvaluationModel({ embedder, learn: false }).trainingExamples().map((e) => e.text)].map(plain));
const overlap = allCases.filter((c) => plain(c.u).split(' ').length > 2 && bank.has(plain(c.u))).length;
console.log(`Held out of training: ${holdOut.texts.length} test phrasings (${overlap} of them were in it word for word)`);

const picked = (a: any) => (a && a.choice !== 'none' && topProbability(a) >= 0.5 ? a.choice : undefined);
// REFLEX_CANTHINK=1: Nova has a brain, so doubtful matches go to it (and a wrong skill is the worst outcome).
const canThink = process.env.REFLEX_CANTHINK === '1';
async function decide(model: EvaluationModelV4, u: string, state: Record<string, unknown> = {}) {
  const t0 = performance.now();
  const { answers } = await model.doEvaluate({ state: { utterance: u, wakeWordUsed: true, canThink, ...state }, questions: buildQuestions(skills, EVAL_APPS, u, host) } as any);
  return { answers: answers as Record<string, any>, ms: performance.now() - t0 };
}

const warm = await decide(reflex, 'hello there');
console.log(`First decision (indexes the phrase bank): ${warm.ms.toFixed(1)} ms\n`);

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%`.padStart(4) : '   -');
// REFLEX_SETS=A,B,D leaves the held-out sets C and E alone while tuning.
const chosen = (process.env.REFLEX_SETS ?? 'A,B,C,D,E').split(',');
const sets = ([['A', SET_A], ['B', SET_B], ['C', SET_C], ['D', SET_D], ['E', SET_E]] as const).filter(([name]) => chosen.includes(name));
const HELD_OUT = new Set(['C', 'E']);
const models = [['keywords', keywords], ['examples', examplesOnly], ['reflex  ', reflex]] as const;
for (const [name, set] of sets) {
  for (const [label, model] of models) {
    let intent = 0;
    let wrongSkill = 0;
    let toBrain = 0;
    const brainy = (i: string) => i === 'chat' || i === 'other';
    const slots = { app: [0, 0], agent: [0, 0], project: [0, 0] };
    const misses: string[] = [];
    const times: number[] = [];
    const buckets = [0.9, 0.75, 0.5, 0].map((floor) => ({ floor, n: 0, ok: 0 }));
    for (const c of set) {
      const { answers, ms } = await decide(model, c.u);
      times.push(ms);
      const got = answers.intent.choice;
      const ok = got === c.intent || (canThink && brainy(got) && brainy(c.intent));
      if (ok) intent++;
      else misses.push(`"${c.u}" → ${got}`);
      if (!ok && !brainy(got)) wrongSkill++;
      if (!ok && brainy(got) && !brainy(c.intent)) toBrain++;
      const b = buckets.find((x) => topProbability(answers.intent) >= x.floor)!;
      b.n++;
      if (ok) b.ok++;
      for (const slot of ['app', 'agent', 'project'] as const) {
        if (!c[slot]) continue;
        slots[slot][1]!++;
        if (picked(answers[slot]) === c[slot]) slots[slot][0]!++;
      }
    }
    times.sort((a, b) => a - b);
    const t = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(2);
    console.log(
      `Set ${name} ${label} intent ${pct(intent, set.length)} (${intent}/${set.length}) · app ${pct(...(slots.app as [number, number]))} · agent ${pct(...(slots.agent as [number, number]))} · project ${pct(...(slots.project as [number, number]))} · ${t(0.5)} ms p50, ${t(0.9)} ms p90`,
    );
    if (model !== keywords) {
      console.log(`  wrong action ${pct(wrongSkill, set.length)} (${wrongSkill}) · handed to the brain ${pct(toBrain, set.length)} (${toBrain})`);
      console.log(`  confidence → accuracy: ${buckets.map((b) => `≥${b.floor}: ${b.ok}/${b.n}`).join(' · ')}`);
      // Held-out misses stay hidden unless asked for, so nobody tunes to them by accident.
      if (model === reflex && (!HELD_OUT.has(name) || process.env.REFLEX_SHOW_HELDOUT === '1')) console.log(`  misses: ${misses.join(' | ') || 'none'}`);
    }
  }
  console.log('');
}

// Follow-ups without the wake word: commands and questions are for Nova, background talk isn't.
for (const [label, model] of models) {
  let ok = 0;
  const wrong: string[] = [];
  const all = sets.flatMap(([, set]) => set);
  for (const c of all) {
    const { answers } = await decide(model, c.u, { wakeWordUsed: false });
    const forNova = answers.addressed.probability >= 0.5;
    if (forNova === (c.intent !== 'other')) ok++;
    else wrong.push(`"${c.u}" (${answers.addressed.probability.toFixed(2)})`);
  }
  const showWrong = model === reflex && (sets.every(([name]) => !HELD_OUT.has(name)) || process.env.REFLEX_SHOW_HELDOUT === '1');
  console.log(`Addressee ${label} ${pct(ok, all.length)} (${ok}/${all.length})${showWrong ? ` · wrong: ${wrong.join(' | ')}` : ''}`);
}

// Replies while a confirmation is pending.
for (const [label, model] of models) {
  let ok = 0;
  const wrong: string[] = [];
  for (const r of REPLIES) {
    const { answers } = await decide(model, r.u, { wakeWordUsed: false, awaitingConfirmationFor: 'quit_app' });
    const choice = answers.intent.choice;
    const right = r.yes ? choice === 'confirm_yes' : choice === 'confirm_no' || choice === 'stop';
    if (right) ok++;
    else wrong.push(`"${r.u}" → ${choice}`);
  }
  console.log(`Replies   ${label} ${pct(ok, REPLIES.length)} (${ok}/${REPLIES.length})${model === reflex ? ` · wrong: ${wrong.join(' | ') || 'none'}` : ''}`);
}
