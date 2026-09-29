/**
 * The README's pictures and animations, taken from the window's scripted session (#demo, src/lib/demo.ts) in
 * headless Chrome, into .github/readme/: `npm run readme:media`. Nothing of yours is in them - #demo never
 * connects to the daemon. Needs Google Chrome (or CHROME_PATH), and img2webp for the animations (brew install webp).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('../../../.github/readme/', import.meta.url));
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1440;
const HEIGHT = 900;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));

type Listener = (method: string, params: any, session?: string) => void;

/** Chrome's DevTools protocol: commands, and the events of every page. */
class DevTools {
  private next = 0;
  private calls = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data));
      const call = this.calls.get(msg.id);
      if (call) {
        this.calls.delete(msg.id);
        if (msg.error) call.fail(new Error(msg.error.message));
        else call.ok(msg.result);
      } else if (msg.method) for (const listen of this.listeners) listen(msg.method, msg.params, msg.sessionId);
    });
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => (ws.addEventListener('open', ok), ws.addEventListener('error', fail)));
    return new DevTools(ws);
  }
  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, fail) => this.calls.set(id, { ok, fail }));
  }
  on(listen: Listener) {
    this.listeners.add(listen);
    return () => void this.listeners.delete(listen);
  }
  close() {
    this.ws.close();
  }
}

/** A tab showing the window at a size, dark, with the demo's clock started when it loaded. */
async function open(devtools: DevTools, url: string, scale: number) {
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  const send = <T = any>(method: string, params: object = {}) => devtools.send<T>(method, params, sessionId);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const loaded = new Promise<void>((ok) => {
    const off = devtools.on((method, _, session) => session === sessionId && method === 'Page.loadEventFired' && (off(), ok()));
  });
  await send('Page.navigate', { url });
  await loaded;
  const start = Date.now();
  // The wallpaper drifts over half a minute: held still, an animation loops without a jump behind it.
  await send('Runtime.evaluate', { expression: `document.head.insertAdjacentHTML('beforeend', '<style>.blob { animation-play-state: paused !important; }</style>')` });
  const page = {
    session: sessionId,
    send,
    /** Waits until this long after the page loaded - the demo's own clock, give or take a frame. */
    at: (ms: number) => sleep(start + ms - Date.now()),
    run: async (js: string) => (await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })).result?.value,
    /** ⌘ and a key, as the window's shortcuts take them. */
    command: async (key: string, code: string, keyCode: number) => {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 });
    },
    /** Where an element is, with room around it. */
    box: async (selector: string, pad = 0) => {
      const r = await page.run(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect())`);
      if (!r) throw new Error(`Nothing on the page matches ${selector}`);
      const { x, y, width, height } = JSON.parse(String(r));
      return { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(WIDTH, width + 2 * pad), height: Math.min(HEIGHT, height + 2 * pad) };
    },
    close: () => devtools.send('Target.closeTarget', { targetId }),
  };
  return page;
}
type Page = Awaited<ReturnType<typeof open>>;
type Box = Awaited<ReturnType<Page['box']>>;

async function still(page: Page, file: string, clip?: Box) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'webp', quality: 90, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  await writeFile(join(OUT, file), Buffer.from(data, 'base64'));
  console.log(`  ${file}`);
}

/**
 * An animation: frames as fast as Chrome draws them (the whole page) or can capture them (a part of it),
 * at most `fps` a second, each shown for as long as it really was.
 */
async function animate(devtools: DevTools, page: Page, file: string, { from, to, fps, quality, clip, width }: { from: number; to: number; fps: number; quality: number; clip?: Box; width?: number }) {
  const frames: { at: number; data: string }[] = [];
  await page.at(from);
  if (clip) {
    const end = Date.now() + to - from;
    while (Date.now() < end) {
      const at = Date.now();
      const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, clip: { ...clip, scale: 1 } });
      frames.push({ at, data });
      await sleep(at + 1000 / fps - Date.now());
    }
  } else {
    const off = devtools.on((method, params, session) => {
      if (session !== page.session || method !== 'Page.screencastFrame') return;
      void page.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      if (!frames.length || params.metadata.timestamp * 1000 - frames.at(-1)!.at >= 1000 / fps - 4) frames.push({ at: params.metadata.timestamp * 1000, data: params.data });
    });
    await page.send('Page.startScreencast', { format: 'jpeg', quality: 95, ...(width ? { maxWidth: width, maxHeight: Math.round((width * HEIGHT) / WIDTH) } : {}) });
    await page.at(to);
    await page.send('Page.stopScreencast');
    off();
  }
  const dir = await mkdtemp(join(tmpdir(), 'nova-frames-'));
  const args = ['-loop', '0'];
  for (const [i, frame] of frames.entries()) {
    const name = join(dir, `${String(i).padStart(4, '0')}.jpg`);
    await writeFile(name, Buffer.from(frame.data, 'base64'));
    const next = frames[i + 1]?.at ?? frame.at + 1000 / fps;
    args.push('-lossy', '-q', String(quality), '-m', '4', '-d', String(Math.max(20, Math.round(next - frame.at))), name);
  }
  const encoded = spawnSync('img2webp', [...args, '-o', join(OUT, file)], { encoding: 'utf8' });
  await rm(dir, { recursive: true, force: true });
  if (encoded.error || encoded.status !== 0) throw new Error(`img2webp couldn't make ${file}: ${encoded.error?.message ?? encoded.stderr}`);
  console.log(`  ${file} (${frames.length} frames)`);
}

/** Headless Chrome, and the address its DevTools listen on. */
async function chrome(profile: string) {
  const child = spawn(CHROME, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const url = await new Promise<string>((ok, fail) => {
    let said = '';
    child.stderr.on('data', (d) => {
      said += d;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (found) ok(found[1]!);
    });
    child.on('error', (e) => fail(new Error(`Chrome didn't start (${CHROME}): ${e.message}. Set CHROME_PATH to another Chrome.`)));
    child.on('exit', (code) => fail(new Error(`Chrome quit (${code}): ${said.trim()}`)));
  });
  return { child, url };
}

async function main() {
  if (spawnSync('img2webp', ['-version']).error) throw new Error('img2webp makes the animations: brew install webp');
  await mkdir(OUT, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'nova-readme-'));
  const dist = join(work, 'dist');
  // One React: a stray node_modules link (git worktrees) can otherwise bundle it twice.
  const config = { root: DESKTOP, configFile: join(DESKTOP, 'vite.config.ts'), logLevel: 'warn' as const, resolve: { dedupe: ['react', 'react-dom'] }, build: { outDir: dist, emptyOutDir: true } };
  console.log('Building the window…');
  await build(config);
  const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 4179 } });
  const base = server.resolvedUrls!.local[0]!;
  const { child, url } = await chrome(join(work, 'chrome'));
  const devtools = await DevTools.connect(url);
  try {
    console.log(`Taking pictures into ${OUT}`);
    // The session as it happens: what's heard, what Reflex decided, Claude's answer, the cards, and Claude
    // asking before it runs a command.
    let page = await open(devtools, `${base}#demo`, 1);
    await animate(devtools, page, 'nova-demo.webp', { from: 200, to: 14_300, fps: 15, quality: 65, width: 1200 });
    await page.close();

    // The Orb up close (without the words under it): listening to a voice, thinking while Claude answers, speaking.
    page = await open(devtools, `${base}#demo`, 1);
    await page.run(`document.head.insertAdjacentHTML('beforeend', '<style>.captions { visibility: hidden; }</style>')`);
    await animate(devtools, page, 'orb.webp', { from: 2850, to: 7250, fps: 12, quality: 60, clip: await page.box('.orb', 73) });
    await page.close();

    // The window with Activity (⌘J) and the task board (⌘U) open, once Claude has asked.
    page = await open(devtools, `${base}#demo`, 2);
    await page.at(12_200);
    await page.command('j', 'KeyJ', 74);
    await page.command('u', 'KeyU', 85);
    await sleep(900);
    await still(page, 'window.webp');
    await page.close();

    // Settings, a few of its pages - early on, with the Decision Inspector (⌘I) put away, so little is behind it.
    page = await open(devtools, `${base}#demo`, 2);
    await page.command('i', 'KeyI', 73);
    await page.command(',', 'Comma', 188);
    await sleep(700);
    for (const [section, file] of [
      ['Setup', 'settings-setup.webp'],
      ['Hearing', 'settings-hearing.webp'],
      ['Agents', 'settings-agents.webp'],
      ['Privacy & trust', 'settings-privacy.webp'],
    ] as const) {
      await page.run(`[...document.querySelectorAll('.settings__navitem')].find((b) => b.textContent.includes(${JSON.stringify(section)}))?.click()`);
      await sleep(400);
      await still(page, file, await page.box('.glass.settings'));
    }
    await page.close();
  } finally {
    devtools.close();
    const quit = new Promise((ok) => child.once('exit', ok));
    child.kill();
    await quit;
    await server.close();
    await rm(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
