/**
 * Build Nova.app on this Mac and put it in ~/Applications:   npm run app   (--no-open: don't open it)
 *
 * It's built from apps/desktop/macos and signed here, so macOS knows it by one name (dev.nova.app)
 * for the microphone and for opening at login. It runs Nova from this folder: the app gets a note
 * of where Nova is, which node to use and the PATH the daemon and its agents need.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatShortcut } from '@nova/core';
import { loadConfig, loadDotEnv, readSettings, settingsFile } from '../config.ts';
import { BUNDLED_MODELS, bundleModel, downloadModel, isInstalled, MODELS, modelsDir } from '../models/files.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGE = join(ROOT, 'apps', 'desktop', 'macos');
const ICON = join(ROOT, 'apps', 'desktop', 'src-tauri', 'icons', 'icon.icns');
export const APP = join(homedir(), 'Applications', 'Nova.app');
/** Where the new build goes while it's still being put together - see swapIn(). */
const STAGING = `${APP}.new`;
const execute = promisify(execFile);

function run(command: string, args: string[], cwd = ROOT) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed (${code})`))));
  });
}

/** Node on the PATH (a stable path like /opt/homebrew/bin/node, not one that moves when node updates). */
function findNode() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'node');
    if (dir && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

/** A running Nova.app is asked to quit (it stops its daemon first), and given a few seconds. */
async function quitRunning() {
  const { stdout } = await execute('pgrep', ['-f', `${APP}/Contents/MacOS/Nova`]).catch(() => ({ stdout: '' }));
  const pids = stdout.split('\n').map(Number).filter((pid) => pid > 0);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
  return pids.length > 0;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts a finished build at `target`, replacing whatever's there. `staging` is already complete, so
 * this is never more than two renames (near-instant, same volume) - unlike deleting `target` first
 * and building into it over however long that takes, a build that fails or is interrupted here
 * leaves at worst the previous build in place, never `target` missing or half-written.
 */
export async function swapIn(target: string, staging: string) {
  const previous = `${target}.old`;
  await rm(previous, { recursive: true, force: true }); // a leftover from a swap interrupted before
  if (existsSync(target)) await rename(target, previous);
  await rename(staging, target);
  await rm(previous, { recursive: true, force: true });
}

async function main() {
  if (platform() !== 'darwin') throw new Error('Nova.app is for macOS.');
  loadDotEnv();
  const settings = await readSettings().catch(() => null);
  const config = loadConfig(settings ?? {}, process.env);

  console.log('\n  Building the window (apps/desktop) …');
  await run('npm', ['run', 'build', '-w', '@nova/desktop']);
  console.log('\n  Building Nova.app (apps/desktop/macos) …');
  await run('swift', ['build', '-c', 'release', '--package-path', PACKAGE]);
  await run(join(PACKAGE, '.build', 'release', 'Nova'), ['--selftest']);

  // Only ever replace Nova's own app - never something else that happens to be called Nova.
  if (existsSync(APP)) {
    const { stdout } = await execute('defaults', ['read', join(APP, 'Contents', 'Info'), 'CFBundleIdentifier']).catch(() => ({ stdout: '' }));
    if (stdout.trim() !== 'dev.nova.app') throw new Error(`${APP} is another app (${stdout.trim() || 'unknown'}) - move it, then run this again.`);
  }

  // Built beside whatever's running, and only swapped in once it's complete and signed - so a build
  // that fails, or is interrupted, never leaves Nova.app missing or half-written.
  await rm(STAGING, { recursive: true, force: true }); // a leftover from a build that didn't finish
  const contents = join(STAGING, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'), { recursive: true });
  await copyFile(join(PACKAGE, 'Info.plist'), join(contents, 'Info.plist'));
  await copyFile(join(PACKAGE, '.build', 'release', 'Nova'), join(contents, 'MacOS', 'Nova'));
  if (existsSync(ICON)) await copyFile(ICON, join(contents, 'Resources', 'AppIcon.icns'));
  // Nova's voice comes inside the app: Kokoro, checked against its pinned checksums. It's taken from
  // ~/.nova/models (on APFS a clone, so it takes no extra space) - fetched there once if it isn't yet.
  for (const model of BUNDLED_MODELS) {
    if (!(await isInstalled(model, modelsDir()))) {
      console.log(`\n  Fetching ${MODELS[model]!.label} for the app (once, from huggingface.co) …`);
      await downloadModel(model);
    }
    await bundleModel(model, modelsDir(), join(contents, 'Resources', 'models'));
  }
  const shell = {
    repo: ROOT.replace(/\/$/, ''),
    node: findNode(),
    path: process.env.PATH ?? '/usr/bin:/bin',
    port: config.port,
    settings: settingsFile(),
    // Only for an explicit dev install: Nova.app then also trusts whatever answers on this port
    // enough to check it's Nova's own dev server - never worth the risk for the app most people run.
    devUi: process.argv.includes('--dev-ui') ? 'http://localhost:5173/' : undefined,
  };
  await writeFile(join(contents, 'Resources', 'shell.json'), `${JSON.stringify(shell, null, 2)}\n`);
  // Signed here: one identity for macOS to remember. NOVA_SIGN_IDENTITY (in .env) can name a
  // certificate of yours, so the microphone permission survives rebuilds; otherwise it's signed for
  // this Mac alone, and macOS asks again after each rebuild.
  const identity = process.env.NOVA_SIGN_IDENTITY || '-';
  await run('codesign', ['--force', '--sign', identity, '--identifier', 'dev.nova.app', STAGING]);

  const wasRunning = await quitRunning();
  await swapIn(APP, STAGING);

  console.log(`
  Nova.app is in ${APP}, with Kokoro - Nova's voice - inside.
  It opens at login, runs the daemon (unless one is already running, or Settings → Menu bar says
  you run it yourself), listens for its name and comes when you press ${formatShortcut(config.presence.shortcut)}.
  The first time, macOS asks to let Nova use the microphone.
`);
  if (!process.argv.includes('--no-open')) await run('open', [APP]);
  else if (wasRunning) console.log('  It was running and has been closed; open it again when you like.');
}

// Only when this file is run directly (npm run app) - never as a side effect of another module
// importing it (swapIn, for a test), which must never rebuild or replace the installed app.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`\n  ${(e as Error).message}`);
    process.exit(1);
  });
}
