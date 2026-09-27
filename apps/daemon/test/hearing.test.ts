import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechActivity } from '@nova/core';
import { helperBinary, helperIsCurrent, withoutPrebuiltBinary } from '../src/hearing/build.ts';
import { frame, HearingHelper, type HelperEvent } from '../src/hearing/helper.ts';
import { Hearing } from '../src/hearing/service.ts';
import { SmartTurn } from '../src/hearing/smart-turn.ts';
import { isInstalled, modelsDir, PARAKEET_MODEL, SMART_TURN_MODEL } from '../src/models/files.ts';

describe('the hearing helper, in pieces', () => {
  it('frames audio and commands for its stdin', () => {
    const f = frame(2, Buffer.from('{"type":"cancel"}'));
    expect(f[0]).toBe(2);
    expect(f.readUInt32LE(1)).toBe(17);
    expect(String(f.subarray(5))).toBe('{"type":"cancel"}');
    expect(frame(1, Buffer.alloc(640)).length).toBe(645);
  });

  it("builds FluidAudio without its optional prebuilt binary", () => {
    const manifest = `let package = Package(
    traits: [
        .trait(name: "NemoTextProcessing", description: "Link it."),
        .default(enabledTraits: ["NemoTextProcessing"]),
    ],
    targets: [
        .target(
            name: "FluidAudio",
            dependencies: [
                "FastClusterWrapper",
                .target(name: "NemoTextProcessing", condition: .when(traits: ["NemoTextProcessing"])),
            ]
        ),
        .binaryTarget(
            name: "NemoTextProcessing",
            url: "https://example.com/NemoTextProcessing.xcframework.zip",
            checksum: "abc"
        ),
        .target(name: "FastClusterWrapper"),
    ]
)`;
    const out = withoutPrebuiltBinary(manifest);
    expect(out).not.toMatch(/binaryTarget|\.trait\(|NemoTextProcessing/);
    expect(out).toMatch(/"FastClusterWrapper"/);
    expect(() => withoutPrebuiltBinary(manifest.replace('.binaryTarget(', '.binaryTarget2('))).toThrow(/manifest changed/);
  });

  it("reports a helper that can't start as stopped - it never takes Nova down", async () => {
    const [code, why] = await new Promise<[number | null, string]>((resolve) => {
      const helper = new HearingHelper(join(tmpdir(), 'no-such-dir', 'nova-hearing'), () => {}, (c, w) => resolve([c, w]));
      helper.command({ type: 'cancel' }); // nothing to write to: dropped
    });
    expect(code).toBeNull();
    expect(why).toMatch(/ENOENT/);
  });

  it('never sends to a Smart Turn process that stopped', async () => {
    const script = join(mkdtempSync(join(tmpdir(), 'nova-worker-')), 'dies.mjs');
    writeFileSync(script, 'process.exit(0);\n');
    const gone = new Promise<unknown>((resolve) => new (SmartTurn as any)(fork(script, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), resolve));
    const turn = (await gone) as SmartTurn;
    expect(turn.alive).toBe(false);
    expect(await turn.judge(new Int16Array(16_000))).toBeNull();
  });
});

describe('the hearing service, with a stand-in helper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const utterances: [string, boolean][] = [];
    const hearing = new Hearing({ status: () => {}, transcript: () => {}, utterance: (text, explicit) => utterances.push([text, explicit]), bargeIn: () => {} });
    (hearing as any).config = { engine: 'parakeet', language: 'en-US', patience: 'normal', smartTurn: false, bargeIn: true };
    /** A helper starts - or starts again - and says it's ready: the service's own code takes it on. */
    const start = () => {
      const commands: Record<string, any>[] = [];
      (hearing as any).use('parakeet', { command: (c: Record<string, any>) => commands.push(c), audio: () => {}, close: () => {} });
      (hearing as any).onHelper('parakeet', { type: 'ready', engine: 'parakeet', ms: 1 });
      return commands;
    };
    const feed = (samples: Int16Array) => {
      for (let i = 0; i < samples.length; i += 320) {
        const chunk = samples.subarray(i, i + 320);
        hearing.audio(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    };
    const quiet = (ms: number) => feed(new Int16Array(ms * 16));
    const talk = (ms: number) => feed(Int16Array.from({ length: ms * 16 }, (_, i) => Math.round(8000 * Math.sin(i / 5))));
    /** The helper's text for the turn it was last asked to finish. */
    const answer = (commands: Record<string, any>[], text: string) => {
      const turn = commands.filter((c) => c.type === 'finalize').at(-1)!.turn;
      (hearing as any).onHelper('parakeet', { type: 'final', turn, text, ms: 1 });
    };
    return { hearing, utterances, start, quiet, talk, answer };
  }

  it("tells a restarted helper where speech is in its own audio, not the daemon's", () => {
    const { hearing, start, quiet, talk } = setup();
    const first = start();
    quiet(10_000);
    talk(600);
    quiet(1000);
    vi.advanceTimersByTime(3000); // the turn ends
    expect(first.find((c) => c.type === 'speech' && c.active)!.at).toBe(10_000);
    const second = start(); // it stopped and started again: its audio counts from zero
    quiet(2000);
    talk(600);
    expect(second.find((c) => c.type === 'speech' && c.active)!.at).toBe(2000);
    expect(second.find((c) => c.type === 'cancel')!.at).toBe(1760);
    hearing.close();
  });

  it('makes a turn Nova’s after the shortcut only while it follows closely', () => {
    const { hearing, utterances, start, quiet, talk, answer } = setup();
    const helper = start();
    hearing.hold();
    hearing.release(false); // tapped
    quiet(500);
    talk(800);
    quiet(600);
    vi.advanceTimersByTime(3000);
    answer(helper, 'open slack');
    expect(utterances).toEqual([['open slack', true]]);

    hearing.hold();
    hearing.release(false); // tapped - and then nothing said for a while
    vi.advanceTimersByTime(10_000);
    talk(800);
    quiet(600);
    vi.advanceTimersByTime(3000);
    answer(helper, 'turn it down');
    expect(utterances.at(-1)).toEqual(['turn it down', false]); // not taken as said to Nova

    hearing.hold();
    hearing.release(true); // held without a word
    vi.advanceTimersByTime(2000);
    talk(800);
    quiet(600);
    vi.advanceTimersByTime(3000);
    answer(helper, 'the tv in the background');
    expect(utterances.at(-1)).toEqual(['the tv in the background', false]);
    hearing.close();
  });
});

// With the real helper, models and macOS voices: speech made with `say`, heard as a window would stream it.
const onMac = platform() === 'darwin';
const built = onMac && (await helperIsCurrent());
const parakeet = await isInstalled(PARAKEET_MODEL);
const smartTurn = await isInstalled(SMART_TURN_MODEL);
const dir = mkdtempSync(join(tmpdir(), 'nova-hearing-'));

/** 16 kHz 16-bit speech from the Mac's own voice. */
function speech(text: string): Int16Array {
  const file = join(dir, `${text.length}-${Math.random().toString(36).slice(2)}.wav`);
  execFileSync('say', ['-v', 'Samantha', '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  const wav = readFileSync(file);
  const at = wav.indexOf('data');
  const data = wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
  return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
}

/** Streams speech through the helper in real time, with the daemon's speech detector, and returns the turn's text. */
async function hear(engine: 'apple' | 'parakeet', samples: Int16Array) {
  const helper = await new Promise<HearingHelper>((resolve, reject) => {
    const h: HearingHelper = new HearingHelper(
      helperBinary,
      (e: HelperEvent) => (e.type === 'ready' ? resolve(h) : e.type === 'error' && e.fatal ? reject(new Error(e.message)) : undefined),
      () => reject(new Error('the helper exited')),
    );
    h.command({ type: 'start', engine, locale: 'en_US', vocabulary: ['Nova', 'Figma'], wakeWords: ['nova'], modelDir: join(modelsDir(), PARAKEET_MODEL) });
  });
  const final = new Promise<string>((resolve) => {
    (helper as any).child.stdout.on('data', (d: Buffer) => {
      for (const line of String(d).split('\n')) if (line.includes('"final"')) resolve(JSON.parse(line).text);
    });
  });
  const vad = new SpeechActivity();
  const audio = new Int16Array(16_000 * 0.5 + samples.length + 16_000 * 1.5);
  audio.set(samples, 8000);
  let sent = 0;
  for (let i = 0; i < audio.length; i += 320) {
    const chunk = audio.subarray(i, i + 320);
    helper.audio(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    sent += chunk.length;
    const change = vad.push(chunk);
    if (change) helper.command({ type: 'speech', active: change === 'start', at: Math.round(sent / 16) });
    await new Promise((r) => setTimeout(r, 5)); // 4x real time
  }
  helper.command({ type: 'finalize', turn: 1 });
  const text = await final;
  helper.close();
  return text;
}

describe.skipIf(!built)('hearing with the helper', () => {
  it("hears a command with Apple's on-device recognizer", async () => {
    const text = await hear('apple', speech('Nova, open Figma please.'));
    expect(text.toLowerCase()).toMatch(/nova.*open figma/);
  }, 60_000);

  it.skipIf(!parakeet)('hears a command with Parakeet', async () => {
    const text = await hear('parakeet', speech('Nova, set a timer for ten minutes.'));
    expect(text.toLowerCase()).toMatch(/nova.*set a timer for (10|ten) minutes/);
  }, 120_000);

  it('turns streamed speech into finished turns, waiting through a mid-sentence pause', async () => {
    const utterances: string[] = [];
    const hearing = new Hearing({ status: () => {}, transcript: () => {}, utterance: (t) => utterances.push(t), bargeIn: () => {} });
    hearing.configure({ engine: 'apple', language: 'en-US', patience: 'normal', smartTurn, bargeIn: true }, ['Nova'], ['nova']);
    for (let i = 0; i < 200 && !hearing.listening; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hearing.listening).toBe(true);
    const first = speech('Nova, in my current project I want to');
    const rest = speech('set a timer for five minutes.');
    const gap = new Int16Array(16_000 * 1.2); // thinking...
    const audio = new Int16Array([...new Int16Array(8000), ...first, ...gap, ...rest, ...new Int16Array(16_000 * 3)]);
    for (let i = 0; i < audio.length; i += 320) {
      const chunk = audio.subarray(i, i + 320);
      hearing.audio(Buffer.from(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)));
      await new Promise((r) => setTimeout(r, 20)); // real time: the turn-taking runs on the clock
    }
    for (let i = 0; i < 40 && !utterances.length; i++) await new Promise((r) => setTimeout(r, 50));
    hearing.close();
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.toLowerCase()).toMatch(/nova.*i want to.*set a timer for (5|five) minutes/);
  }, 60_000);
});

describe.skipIf(!smartTurn || !onMac)('Smart Turn', () => {
  it("hears whether a sentence is finished from how it's said", async () => {
    const turn = await SmartTurn.start();
    expect(turn).not.toBeNull();
    const done = await turn!.judge(speech('Open Figma please.'));
    const trailing = await turn!.judge(speech('In my current project, I want to'));
    turn!.close();
    expect(done).toBeGreaterThan(0.5);
    expect(trailing).toBeLessThan(0.5);
  }, 30_000);
});
