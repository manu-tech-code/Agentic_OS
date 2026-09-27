import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
