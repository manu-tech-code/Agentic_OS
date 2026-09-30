/**
 * The README's iPhone pictures, taken from Nova's scripted session on the phone (`-demo <scene>`,
 * apps/ios/Nova/Model/Demo.swift) in the iOS Simulator, into .github/readme/: `npm run readme:phone`. Nothing of yours
 * is in them - the demo never connects to a Mac, and this Simulator's own pairing is left as it was. Needs Xcode with an
 * iPhone Simulator (NOVA_SIMULATOR, else iPhone 17), and cwebp and img2webp (brew install webp).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IOS = fileURLToPath(new URL('../../../ios/', import.meta.url));
const BUILD = join(IOS, '.build');
const OUT = fileURLToPath(new URL('../../../../.github/readme/', import.meta.url));
const BUNDLE = 'dev.nova.phone';
const DEVICE = process.env.NOVA_SIMULATOR ?? 'iPhone 17';

/** The phone's own screens: each scene, and how long it takes to settle. */
const STILLS = [
  { scene: 'talk', settle: 2.5 },
  { scene: 'answer', settle: 3 },
  { scene: 'faceid', settle: 3 },
  { scene: 'tasks', settle: 3 },
  { scene: 'pair', settle: 2 },
];

const sleep = (s: number) => new Promise((ok) => setTimeout(ok, s * 1000));

/** Runs a program; its output is kept, for when it fails. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? ok(out) : fail(new Error(`${command} ${args.slice(0, 2).join(' ')} failed (${code}):\n${out.trim().split('\n').slice(-12).join('\n')}`))));
  });
}
const simctl = (...args: string[]) => run('xcrun', ['simctl', ...args]);

/** Nova, shown as a scene: started afresh with it. */
async function launch(scene: string) {
  await simctl('terminate', 'booted', BUNDLE).catch(() => {});
  await simctl('launch', 'booted', BUNDLE, '-demo', scene);
}

async function main() {
  for (const tool of ['cwebp', 'img2webp']) if (spawnSync(tool, ['-version']).error) throw new Error(`${tool} makes the pictures: brew install webp`);
  console.log('Building Nova for the iOS Simulator…');
  await run('xcodebuild', [
    '-project', join(IOS, 'Nova.xcodeproj'), '-scheme', 'Nova', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', BUILD, 'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', 'DEVELOPMENT_TEAM=', 'build',
  ]);
  if (!/\(Booted\)/.test(await simctl('list', 'devices', 'booted'))) {
    console.log(`Starting the ${DEVICE} simulator…`);
    await simctl('boot', DEVICE);
  }
  await simctl('bootstatus', 'booted', '-b');
  await simctl('install', 'booted', join(BUILD, 'Build/Products/Debug-iphonesimulator/Nova.app'));
  await simctl('terminate', 'booted', 'com.apple.Preferences').catch(() => {}); // opened from another app, Nova shows a way back to it
  // The status bar as Apple shows it: 9:41, full, no carrier.
  await simctl('status_bar', 'booted', 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active',
    '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100');
  const dir = await mkdtemp(join(tmpdir(), 'nova-phone-media-'));
  try {
    for (const { scene, settle } of STILLS) {
      await launch(scene);
      await sleep(settle);
      const shot = join(dir, `${scene}.png`);
      await simctl('io', 'booted', 'screenshot', '--type=png', shot);
      await run('cwebp', ['-quiet', '-q', '82', '-resize', '540', '0', shot, '-o', join(OUT, `phone-${scene}.webp`)]);
      console.log(`  phone-${scene}.webp`);
    }
    // The Dynamic Island, while Nova speaks with Claude at work: Nova sent to the background (Settings in front), and
    // filmed - a screenshot doesn't catch the island while it moves.
    await launch('island');
    await sleep(2.5);
    await simctl('launch', 'booted', 'com.apple.Preferences');
    await sleep(1);
    const movie = join(dir, 'island.mov');
    const film = spawn('xcrun', ['simctl', 'io', 'booted', 'recordVideo', '--codec=h264', '--force', movie], { stdio: 'ignore' });
    await sleep(5);
    film.kill('SIGINT');
    await new Promise((ok) => film.on('exit', ok));
    const frames = join(dir, 'island');
    await mkdir(frames);
    await run('swift', [join(IOS, 'readme-frames.swift'), movie, frames, '1.2', '4.2', '10', '290', '12', '626', '150', '0.9']);
    const args = ['-loop', '0'];
    for (const frame of (await readdir(frames)).sort()) args.push('-lossy', '-q', '80', '-m', '4', '-d', '100', join(frames, frame));
    await run('img2webp', [...args, '-o', join(OUT, 'phone-island.webp')]);
    console.log('  phone-island.webp');
  } finally {
    await rm(dir, { recursive: true, force: true });
    // Nothing left behind: the demo's activities end as a scene starts, and the status bar is the Simulator's again.
    await launch('pair').catch(() => {});
    await sleep(1.5);
    await simctl('terminate', 'booted', BUNDLE).catch(() => {});
    await simctl('terminate', 'booted', 'com.apple.Preferences').catch(() => {});
    await simctl('status_bar', 'booted', 'clear').catch(() => {});
  }
}

main().catch((e) => {
  console.error(`  ${(e as Error).message}`);
  process.exit(1);
});
