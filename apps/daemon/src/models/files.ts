import { createHash, type Hash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface FileCheck {
  size: number;
  /** For large (LFS) files: their SHA-256. */
  sha256?: string;
  /** For small files: their git blob id, as Hugging Face lists it. */
  gitSha1?: string;
  /** Where the file is in its source, when that isn't its name here. */
  from?: string;
}

interface ModelSpec {
  label: string;
  repo: string;
  /** Pinned, so a changed upload can't slip in. */
  revision: string;
  license: string;
  /**
   * Where the files come from when it isn't Hugging Face: a GitHub release's downloads (`revision` is its tag, and
   * the checksums pin each file), or a GitHub repository at a commit (`revision`).
   */
  source?: 'github-release' | 'github';
  files: Record<string, FileCheck>;
}

/**
 * Models Nova downloads: Reflex's embedding model (a lookup table of word meanings, not a
 * language model), Kokoro (the voice), Parakeet (hearing, on the Neural Engine), Smart Turn
 * (hearing when you've finished), Silero VAD (hearing what's speech) and Voice ID's three. Each is
 * pinned to a revision and checked file by file.
 */
export const MODELS: Record<string, ModelSpec> = {
  'potion-base-8M': {
    label: 'potion-base-8M · English · 31 MB',
    repo: 'minishlab/potion-base-8M',
    revision: 'bf8b056651a2c21b8d2565580b8569da283cab23',
    license: 'MIT',
    files: {
      'model.safetensors': { size: 30_236_760, sha256: 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2' },
      'tokenizer.json': { size: 683_666, gitSha1: '3e511f68ccf95c33b9ffd214a94c6d25bdb3034f' },
      'config.json': { size: 202, gitSha1: '7df26884a1aaaefbd7a30b37c32a25477cfb4c0e' },
    },
  },
  // Reflex's sentence model: reads whole sentences (word order, "not") for its classifier, next to potion's word
  // meanings. Run by transformers.js in its own process (reflex/sentence-worker.ts).
  'all-MiniLM-L6-v2': {
    label: 'MiniLM L6 · sentences · 24 MB',
    repo: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    license: 'Apache-2.0',
    files: {
      'onnx/model_quantized.onnx': { size: 22_972_370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
      'tokenizer.json': { size: 711_661, gitSha1: 'c17ed520ed8438736732a54957a69306b8822215' },
      'config.json': { size: 650, gitSha1: '72147e4ff4426ebedbfa2146c4a0999def51a313' },
      'tokenizer_config.json': { size: 366, gitSha1: '37fca74771bc76a8e01178ce3a6055a0995f8093' },
    },
  },
  'kokoro-82M': {
    label: 'Kokoro 82M · natural voices · 326 MB',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    license: 'Apache-2.0',
    files: {
      'onnx/model.onnx': { size: 325_532_232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb' },
      'config.json': { size: 44, gitSha1: '790faf216e7e3f490e71e8bc80df79ed8941101c' },
      'tokenizer.json': { size: 3497, gitSha1: '4280f55fc1c32211bc9bb4d55545759a00054ecd' },
      'tokenizer_config.json': { size: 113, gitSha1: '5c81e9a3a06db9139900d6ee5b60e8bb701ccb0b' },
    },
  },
  // Compiled Core ML bundles, loaded by the hearing helper through FluidAudio (v2: English).
  'parakeet-tdt-0.6b-v2': {
    label: 'Parakeet TDT 0.6B v2 · English · 464 MB',
    repo: 'FluidInference/parakeet-tdt-0.6b-v2-coreml',
    revision: 'ee09c569f73759e6d44c9bd16766f477b2b36d39',
    license: 'CC-BY-4.0',
    files: {
      'Decoder.mlmodelc/analytics/coremldata.bin': { size: 243, sha256: '46de1a6fe2e49d19a2125bc91acf020df7f2aea84ba821532aade8427a440b05' },
      'Decoder.mlmodelc/coremldata.bin': { size: 554, sha256: 'd200ca07694a347f6d02a3886a062ae839831e094e443222f2e48a14945966a8' },
      'Decoder.mlmodelc/metadata.json': { size: 3_427, gitSha1: 'e3a08d21a5d1577db2bedd1749ea0ddae5d21b73' },
      'Decoder.mlmodelc/model.mil': { size: 13_106, gitSha1: '167cc9db34dd7828e0e61eab40d6a09f8a234d30' },
      'Decoder.mlmodelc/weights/weight.bin': { size: 14_429_952, sha256: '27d26890221d82322c1092fd99d7b40578e435d5cf4b83c887c42603caf97aba' },
      'Encoder.mlmodelc/analytics/coremldata.bin': { size: 243, sha256: '42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105' },
      'Encoder.mlmodelc/coremldata.bin': { size: 485, sha256: '4def7aa848599ad0e17a8b9a982edcdbf33cf92e1f4b798de32e2ca0bc74b030' },
      'Encoder.mlmodelc/metadata.json': { size: 2_926, gitSha1: 'c87f9eb24e76b8e518dc1fbead46c8c0029d3925' },
      'Encoder.mlmodelc/model.mil': { size: 959_769, gitSha1: '93d1301ccde7c2ca447af6c01ab05bfda5a5dd2c' },
      'Encoder.mlmodelc/weights/weight.bin': { size: 445_187_200, sha256: '4adc7ad44f9d05e1bffeb2b06d3bb02861a5c7602dff63a6b494aed3bf8a6c3e' },
      'JointDecision.mlmodelc/analytics/coremldata.bin': { size: 243, sha256: 'f1183ba213bb94a918c8d2cad19ab045320618f97f6ca662245b3936d7b090f7' },
      'JointDecision.mlmodelc/coremldata.bin': { size: 534, sha256: 'e2c6752f1c8cf2d3f6f26ec93195c9bfa759ad59edf9f806696a138154f96f11' },
      'JointDecision.mlmodelc/metadata.json': { size: 2_936, gitSha1: 'db3b2bc33cfda6f7cd1073d21182446180e53f94' },
      'JointDecision.mlmodelc/model.mil': { size: 9_722, gitSha1: '339c35b303b074de7fe047bb099311a4cc08cf53' },
      'JointDecision.mlmodelc/weights/weight.bin': { size: 3_453_388, sha256: 'ca22a65903a05e64137677da608077578a8606090a598abf4875fa6199aaa19d' },
      'Preprocessor.mlmodelc/analytics/coremldata.bin': { size: 243, sha256: '03ab3c1327a054c54c07a40325db967ec574f2c91dcc8192bfa44aa561bcf2d8' },
      'Preprocessor.mlmodelc/coremldata.bin': { size: 494, sha256: 'd88ea1fc349459c9e100d6a96688c5b29a1f0d865f544be103001724b986b6d6' },
      'Preprocessor.mlmodelc/metadata.json': { size: 2_974, gitSha1: '887f7d4adc6d7f933686f7b984e23a47b45f57e3' },
      'Preprocessor.mlmodelc/model.mil': { size: 27_166, gitSha1: 'e94cce4bc7fbf55e55788449bf067ffe09a5ca91' },
      'Preprocessor.mlmodelc/weights/weight.bin': { size: 298_880, sha256: 'a5f7df6c7f47147ae9486fe18cc7792f9a44d093ec3c6a11e91ef2dc363c48dc' },
      'parakeet_vocab.json': { size: 18_762, gitSha1: 'a111d3bd29d44781c4588447c3eac1ea549cb1f1' },
    },
  },
  'smart-turn-v3.2': {
    label: 'Smart Turn v3.2 · 9 MB',
    repo: 'pipecat-ai/smart-turn-v3',
    revision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93',
    license: 'BSD-2-Clause',
    files: {
      'smart-turn-v3.2-cpu.onnx': { size: 8_679_182, sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f' },
    },
  },
  // Silero VAD: whether each 32 ms is someone speaking, so typing, music or a fan don't start a turn. In ONNX Runtime
  // (speech-worker.ts). It's kept in its repository rather than a release: v6.2.3's commit.
  'silero-vad-v6.2': {
    label: 'Silero VAD v6.2 · 2 MB',
    repo: 'snakers4/silero-vad',
    revision: '5cd7945676eb32225748052e2e6a0580e4686a08',
    source: 'github',
    license: 'MIT',
    files: {
      'silero_vad.onnx': { size: 2_327_524, sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3', from: 'src/silero_vad/data/silero_vad.onnx' },
    },
  },
  // Voice ID: a voiceprint of who is speaking (WeSpeaker v2), on the Neural Engine. Its licence isn't confirmed:
  // the repository's NOTICE.md leaves this legacy export out of its CC-BY-4.0 scope. Before Nova goes to anyone
  // else, switch to that repository's Community-1 Embedding + FBank pair (CC-BY-4.0) behind the same voiceprint.
  'wespeaker-v2': {
    label: 'WeSpeaker v2 · 8 MB',
    repo: 'FluidInference/speaker-diarization-coreml',
    revision: 'df2625ac79a7ac6b65ad868fee6d80f320da4232',
    license: 'unconfirmed (legacy export; see the repository NOTICE.md)',
    files: {
      'wespeaker_v2.mlmodelc/analytics/coremldata.bin': { size: 243, sha256: 'd2b1fcde6121aea3ff0e14c1dc50d09dacb0314a2e89156353c31804230a422f' },
      'wespeaker_v2.mlmodelc/coremldata.bin': { size: 359, sha256: '6feb2472a71fa9d8a84020c85206138a4f6261c565c9884bf518d59dd5838da7' },
      'wespeaker_v2.mlmodelc/metadata.json': { size: 2_738, gitSha1: '5cda8cc14897fb37b01552a0fb9fefca31a6c00f' },
      'wespeaker_v2.mlmodelc/model.mil': { size: 706_900, gitSha1: '977dcf031d18b18fb5096d3e943ff8aa18754e21' },
      'wespeaker_v2.mlmodelc/weights/weight.bin': { size: 7_243_904, sha256: '34004f6798d35cad7071e2fdc67e63faaa782f53697e1cb49bcb452cf81ae151' },
    },
  },
  // Voice ID's two larger models, in ONNX Runtime (voice-worker.ts): WeSpeaker's ResNet293 (trained on VoxCeleb) and
  // NVIDIA's TitaNet-Large (VoxCeleb, phone calls, audiobooks), as sherpa-onnx exported them. The release tag is spelled so.
  'wespeaker-resnet293': {
    label: 'WeSpeaker ResNet293 · 114 MB',
    repo: 'k2-fsa/sherpa-onnx',
    revision: 'speaker-recongition-models',
    source: 'github-release',
    license: 'CC-BY-4.0',
    files: {
      'wespeaker_en_voxceleb_resnet293_LM.onnx': { size: 114_336_527, sha256: 'f65dbc820e534eef64ae12d1e289e20244d60e60f7f00d7b092092b1c458be2e' },
    },
  },
  'titanet-large': {
    label: 'NVIDIA TitaNet-Large · 101 MB',
    repo: 'k2-fsa/sherpa-onnx',
    revision: 'speaker-recongition-models',
    source: 'github-release',
    license: 'CC-BY-4.0',
    files: {
      'nemo_en_titanet_large.onnx': { size: 101_405_493, sha256: 'd51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77' },
    },
  },
};
/** Older name, from when only Reflex downloaded a model. */
export const REFLEX_MODELS = MODELS;

export const DEFAULT_REFLEX_MODEL = 'potion-base-8M';
/** Reflex's sentence model, for its classifier (optional: without it, Reflex reads word meanings alone). */
export const SENTENCE_MODEL = 'all-MiniLM-L6-v2';
export const KOKORO_MODEL = 'kokoro-82M';
export const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v2';
export const SMART_TURN_MODEL = 'smart-turn-v3.2';
export const SPEECH_MODEL = 'silero-vad-v6.2';
export const VOICE_ID_MODEL = 'wespeaker-v2';
/** Every model Voice ID hears with: the hearing helper's, then the two in ONNX Runtime. */
export const VOICE_ID_MODELS = [VOICE_ID_MODEL, 'wespeaker-resnet293', 'titanet-large'] as const;

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Where downloaded models live - a constant (NOVA_MODELS_DIR in .env), outside the repo. */
export const modelsDir = () => expand(process.env.NOVA_MODELS_DIR || '~/.nova/models');

/**
 * Models that come inside Nova.app (Kokoro, Nova's voice): its Resources/models. The app says where
 * when it runs the daemon; a daemon started in a terminal looks in the installed app.
 */
export const bundledModelsDir = () => process.env.NOVA_BUNDLED_MODELS || join(homedir(), 'Applications', 'Nova.app', 'Contents', 'Resources', 'models');

/** Models Nova.app is built with. */
export const BUNDLED_MODELS = ['kokoro-82M'];

/** A running checksum in the form each file is listed with. */
function hasher(check: FileCheck): Hash {
  return check.sha256 ? createHash('sha256') : createHash('sha1').update(`blob ${check.size}\0`);
}
const expected = (check: FileCheck) => check.sha256 ?? check.gitSha1;

/** Whether a file on disk is exactly the expected one (read in pieces, however big it is). */
async function fileMatches(path: string, check: FileCheck) {
  const size = await stat(path).then((s) => s.size, () => -1);
  if (size !== check.size) return false;
  const hash = hasher(check);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex') === expected(check);
}

/** Whether every file of a model is present at its expected size (a full checksum runs when it's downloaded or bundled). */
async function presentIn(name: string, dir: string) {
  const spec = MODELS[name];
  if (!spec) return false;
  for (const [file, check] of Object.entries(spec.files)) {
    const size = await stat(join(dir, name, file)).then((s) => s.size, () => -1);
    if (size !== check.size) return false;
  }
  return true;
}

/** Where a model is: downloaded to ~/.nova/models, or inside Nova.app - null when it's in neither. */
export async function whereInstalled(name: string): Promise<{ dir: string; bundled: boolean } | null> {
  if (await presentIn(name, modelsDir())) return { dir: modelsDir(), bundled: false };
  if (BUNDLED_MODELS.includes(name) && (await presentIn(name, bundledModelsDir()))) return { dir: bundledModelsDir(), bundled: true };
  return null;
}

/** Whether a model is there: in `dir`, or else downloaded or inside Nova.app. */
export async function isInstalled(name: string, dir?: string) {
  return dir ? presentIn(name, dir) : (await whereInstalled(name)) !== null;
}

/** Copy a model's checked files into `dir` (Nova.app's Resources, when it's built). On APFS it's a clone: no extra space. */
export async function bundleModel(name: string, from: string, dir: string) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Nova doesn't know a model called ${name}.`);
  for (const [file, check] of Object.entries(spec.files)) {
    const source = join(from, name, file);
    if (!(await fileMatches(source, check))) throw new Error(`${name}/${file} doesn't match its checksum.`);
    const target = join(dir, name, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_FICLONE);
  }
}

/** Where a model's file downloads from: its pinned revision on Hugging Face, or on GitHub. */
export function sourceUrl(spec: Pick<ModelSpec, 'repo' | 'revision' | 'source'>, path: string) {
  if (spec.source === 'github-release') return `https://github.com/${spec.repo}/releases/download/${spec.revision}/${path}`;
  if (spec.source === 'github') return `https://raw.githubusercontent.com/${spec.repo}/${spec.revision}/${path}`;
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${path}`;
}

/** No bytes at all for this long fails a download - not a cap on the whole transfer, which can take a while for a big model on a slow (but steady) connection. */
const IDLE_TIMEOUT_MS = 60_000;

/** Download a model from its pinned revision, checking every file before it's saved. */
export async function downloadModel(name: string, opts: { dir?: string; onProgress?: (file: string, received: number, total: number) => void } = {}) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Nova doesn't know a model called ${name}.`);
  const target = join(opts.dir ?? modelsDir(), name);
  await mkdir(target, { recursive: true });
  for (const [file, check] of Object.entries(spec.files)) {
    const path = join(target, file);
    await mkdir(dirname(path), { recursive: true });
    if (await fileMatches(path, check)) continue;

    const controller = new AbortController();
    const stalled = () => controller.abort(new Error(`${file} stalled: no data for ${IDLE_TIMEOUT_MS / 1000}s.`));
    let idleTimer = setTimeout(stalled, IDLE_TIMEOUT_MS);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stalled, IDLE_TIMEOUT_MS);
    };
    try {
      const url = sourceUrl(spec, check.from ?? file);
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`Couldn't download ${file} (HTTP ${res.status}).`);
      // Straight to disk, checking (and capping at the expected size) as it goes: big models never sit in memory.
      const part = `${path}.part`;
      const hash = hasher(check);
      let received = 0;
      const track = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          resetIdle();
          received += chunk.length;
          if (received > check.size) return callback(new Error(`${file} is bigger than expected (${check.size} bytes) - stopped downloading it.`));
          hash.update(chunk);
          opts.onProgress?.(file, received, check.size);
          callback(null, chunk);
        },
      });
      try {
        // `pipeline` turns every stream's 'error' event (a full disk, denied permissions, ...) into
        // a rejection here, instead of an unhandled event that would crash the whole daemon.
        await pipeline(res.body as unknown as AsyncIterable<Uint8Array>, track, createWriteStream(part), { signal: controller.signal });
      } catch (e) {
        await rm(part, { force: true });
        throw e;
      }
      if (received !== check.size || hash.digest('hex') !== expected(check)) {
        await rm(part, { force: true });
        throw new Error(`${file} didn't match its checksum, so it wasn't saved.`);
      }
      await rename(part, path);
    } finally {
      clearTimeout(idleTimer);
    }
  }
  return target;
}

/** Reflex's model files, for the embedder to parse. */
export async function readModelFiles(name: string, dir = modelsDir()) {
  const base = join(dir, name);
  const [weights, tokenizer, config] = await Promise.all([
    readFile(join(base, 'model.safetensors')),
    readFile(join(base, 'tokenizer.json'), 'utf8'),
    readFile(join(base, 'config.json'), 'utf8'),
  ]);
  return { weights, tokenizer: JSON.parse(tokenizer) as unknown, config: JSON.parse(config) as Record<string, unknown> };
}
