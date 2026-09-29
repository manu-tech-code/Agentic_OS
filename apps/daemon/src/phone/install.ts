/**
 * Nova on the iPhone, built on this Mac and put on the phone: `npm run phone` - the iPhone paired with this
 * Mac (by cable, or on the same Wi-Fi once Xcode has seen it), unlocked, with Developer Mode on. It's signed
 * for your Apple certificate's team, the one Nova.app is signed with; with a free Apple account that lasts
 * 7 days, so run it again after that. `npm run phone -- --simulator` puts it in the iOS Simulator instead.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentIdentity } from '../shell/signing.ts';

const IOS = fileURLToPath(new URL('../../../ios/', import.meta.url));
const BUILD = join(IOS, '.build');
const BUNDLE = 'dev.nova.phone';

/** Runs a program, its output shown as it goes (quiet: only kept, for when it fails). */
function run(command: string, args: string[], quiet = false): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (d: Buffer) => {
      out += d;
      if (!quiet) process.stdout.write(d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? ok(out) : fail(new Error(`${command} ${args[0]} failed (${code})${quiet ? `:\n${out.trim().split('\n').slice(-15).join('\n')}` : ''}`))));
  });
}

interface Device {
  identifier: string;
  deviceProperties?: { name?: string; developerModeStatus?: string; osVersionNumber?: string };
  hardwareProperties?: { udid?: string; platform?: string; reality?: string; marketingName?: string };
  connectionProperties?: { pairingState?: string };
}

/** The iPhone to put Nova on: the one named (NOVA_PHONE_DEVICE, its name or id), or the only paired one. */
async function iPhone(): Promise<Device> {
  const dir = await mkdtemp(join(tmpdir(), 'nova-phone-'));
  try {
    await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', join(dir, 'devices.json')], true);
    const all: Device[] = JSON.parse(await readFile(join(dir, 'devices.json'), 'utf8')).result?.devices ?? [];
    const phones = all.filter((d) => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties.platform === 'iOS');
    const wanted = process.env.NOVA_PHONE_DEVICE;
    const found = wanted ? phones.find((d) => [d.identifier, d.hardwareProperties?.udid, d.deviceProperties?.name].includes(wanted)) : phones.length === 1 ? phones[0] : phones.find((d) => d.connectionProperties?.pairingState === 'paired');
    if (!found) {
      throw new Error(
        phones.length
          ? `Which iPhone? Set NOVA_PHONE_DEVICE to one of: ${phones.map((d) => d.deviceProperties?.name).join(', ')}.`
          : "No iPhone is paired with this Mac: connect it by cable once, unlock it and tap Trust, then run this again.",
      );
    }
    if (found.deviceProperties?.developerModeStatus && found.deviceProperties.developerModeStatus !== 'enabled') {
      throw new Error(`Turn on Developer Mode on ${found.deviceProperties.name}: Settings → Privacy & Security → Developer Mode, then restart it.`);
    }
    return found;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function simulator() {
  console.log('Building Nova for the iOS Simulator…');
  await run('xcodebuild', ['-project', join(IOS, 'Nova.xcodeproj'), '-scheme', 'Nova', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', BUILD, 'CODE_SIGNING_ALLOWED=NO', 'build'], true);
  const app = join(BUILD, 'Build/Products/Debug-iphonesimulator/Nova.app');
  const booted = await run('xcrun', ['simctl', 'list', 'devices', 'booted'], true);
  if (!/\(Booted\)/.test(booted)) {
    const name = process.env.NOVA_SIMULATOR ?? 'iPhone 17';
    console.log(`Starting the ${name} simulator…`);
    await run('xcrun', ['simctl', 'boot', name], true);
  }
  await run('open', ['-a', 'Simulator'], true);
  await run('xcrun', ['simctl', 'install', 'booted', app], true);
  await run('xcrun', ['simctl', 'launch', 'booted', BUNDLE], true);
  console.log('Nova is open in the Simulator. To pair it, press Copy the link in Settings → iPhone, then:\n  xcrun simctl openurl booted "<the link>"');
}

async function device() {
  const identity = await currentIdentity();
  if (!identity.team) {
    throw new Error(
      "Nova on the iPhone is signed for your Apple team, and there's no Apple Development certificate on this Mac: sign in to Xcode with your Apple ID (Xcode → Settings → Accounts), then run this again.",
    );
  }
  const phone = await iPhone();
  const name = phone.deviceProperties?.name ?? 'the iPhone';
  console.log(`Building Nova for ${name} (${phone.hardwareProperties?.marketingName ?? 'iPhone'}, iOS ${phone.deviceProperties?.osVersionNumber ?? '?'}), signed for team ${identity.team}…`);
  await run(
    'xcodebuild',
    [
      '-project', join(IOS, 'Nova.xcodeproj'), '-scheme', 'Nova', '-configuration', 'Debug', '-destination', `id=${phone.hardwareProperties?.udid ?? phone.identifier}`,
      '-derivedDataPath', BUILD, '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${identity.team}`, 'build',
    ],
    true,
  );
  console.log(`Putting it on ${name}…`);
  await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', phone.identifier, join(BUILD, 'Build/Products/Debug-iphoneos/Nova.app')], true);
  await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', phone.identifier, BUNDLE], true).catch(() => {
    console.log(`It's installed; open it on ${name} (unlocked). The first time, iOS may ask you to trust the developer: Settings → General → VPN & Device Management.`);
  });
  console.log(`Nova is on ${name}. Pair it in Nova's Settings → iPhone on this Mac.`);
}

(process.argv.includes('--simulator') ? simulator() : device()).catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
