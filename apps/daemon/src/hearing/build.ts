/**
 * Builds the hearing helper (a small Swift program) the first time it's needed, and again after
 * its sources change. It uses FluidAudio for Parakeet: fetched from GitHub at a pinned release,
 * checked against its commit, and built without its optional prebuilt text-normalization binary
 * (87 MB that hearing doesn't use). The first build takes a few minutes.
 *   npm run hearing:build
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const helperPackage = fileURLToPath(new URL('../../native/hearing', import.meta.url));
export const helperBinary = join(helperPackage, '.build', 'release', 'nova-hearing');

const FLUIDAUDIO = { url: 'https://github.com/FluidInference/FluidAudio.git', tag: 'v0.17.4', commit: '21493f8dac5a97e65742e6ff26f42f164c2fda0f' };
const vendor = join(helperPackage, '.vendor', 'FluidAudio');
const lockFile = join(helperPackage, '.vendor', 'building.pid');

const mtime = (path: string) => stat(path).then((s) => s.mtimeMs, () => 0);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether the built helper is newer than every source file. */
export async function helperIsCurrent() {
  const built = await mtime(helperBinary);
  if (!built) return false;
  const sources = [join(helperPackage, 'Package.swift'), ...(await readdir(join(helperPackage, 'Sources'))).map((f) => join(helperPackage, 'Sources', f))];
  return (await Promise.all(sources.map(mtime))).every((m) => m <= built);
}

/** Without the prebuilt NeMo binary: its target, the trait that links it, and the dependency on it. */
export function withoutPrebuiltBinary(manifest: string) {
  const out = manifest
    .replace(/\n\s*\.binaryTarget\(\s*name:\s*"NemoTextProcessing"[\s\S]*?\n\s*\),?/, '')
    .replace(/\n\s*traits:\s*\[[\s\S]*?\.default\(enabledTraits:[^\]]*\]\),\s*\],/, '')
    .replace(/\n\s*\.target\(name:\s*"NemoTextProcessing"[^\n]*\n/, '\n')
    .replace(/\n\s*"NemoTextProcessing",\s*\n/, '\n');
  if (/NemoTextProcessing"/.test(out.replace(/\/\/.*$/gm, ''))) throw new Error("FluidAudio's manifest changed: the prebuilt binary couldn't be left out.");
  return out;
}

/** FluidAudio at its pinned commit, prepared for Nova. */
async function prepareFluidAudio(progress?: (line: string) => void) {
  const marker = join(vendor, '.nova-commit');
  if ((await readFile(marker, 'utf8').catch(() => '')).trim() === FLUIDAUDIO.commit) return;
  progress?.(`Fetching FluidAudio ${FLUIDAUDIO.tag} from GitHub…`);
  await rm(vendor, { recursive: true, force: true });
  await mkdir(join(helperPackage, '.vendor'), { recursive: true });
  await run('git', ['clone', '--quiet', '--depth', '1', '--branch', FLUIDAUDIO.tag, FLUIDAUDIO.url, vendor], { timeout: 600_000 });
  const { stdout } = await run('git', ['-C', vendor, 'rev-parse', 'HEAD']);
  if (stdout.trim() !== FLUIDAUDIO.commit) {
    await rm(vendor, { recursive: true, force: true });
    throw new Error(`FluidAudio ${FLUIDAUDIO.tag} isn't the expected commit, so it wasn't used.`);
  }
  for (const name of ['Package.swift', 'Package@swift-6.2.swift']) {
    const path = join(vendor, name);
    const manifest = await readFile(path, 'utf8').catch(() => null);
    if (manifest !== null) await writeFile(path, withoutPrebuiltBinary(manifest));
  }
  await writeFile(marker, `${FLUIDAUDIO.commit}\n`);
}

let building: Promise<string> | null = null;

/** The helper's path, building it first if needed (macOS only). */
export function ensureHelper(onProgress?: (line: string) => void): Promise<string> {
  building ??= (async () => {
    if (platform() !== 'darwin') throw new Error('On-device hearing needs macOS.');
    // Another Nova (a restart mid-build) may be building it: wait for that instead of starting over.
    const other = Number(await readFile(lockFile, 'utf8').catch(() => ''));
    while (other && other !== process.pid && alive(other)) await new Promise((r) => setTimeout(r, 2000));
    if (await helperIsCurrent()) return helperBinary;
    await mkdir(join(helperPackage, '.vendor'), { recursive: true });
    await writeFile(lockFile, String(process.pid));
    try {
      await prepareFluidAudio(onProgress);
      await new Promise<void>((resolve, reject) => {
        const child = spawn('swift', ['build', '-c', 'release', '--package-path', helperPackage], { stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        const take = (d: Buffer) => {
          log = (log + String(d)).slice(-4000);
          for (const line of String(d).split('\n')) if (line.trim()) onProgress?.(line.trim());
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.on('error', (e) => reject(new Error(`Couldn't run swift (install Xcode or its Command Line Tools): ${e.message}`)));
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Building the hearing helper failed:\n${log.split('\n').slice(-12).join('\n')}`))));
      });
    } finally {
      await rm(lockFile, { force: true });
    }
    return helperBinary;
  })().finally(() => (building = null));
  return building;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('Building the hearing helper (the first time fetches FluidAudio and takes a few minutes)…');
  const bin = await ensureHelper((line) => console.log(`  ${line}`));
  console.log(`Ready: ${bin}`);
}
