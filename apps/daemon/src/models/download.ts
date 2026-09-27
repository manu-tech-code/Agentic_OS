/**
 * Installs models Nova runs locally.
 *   npm run reflex:download      Reflex's decision model (potion-base-8M, 31 MB)
 *   npm run voice:download       Kokoro, the natural voice (326 MB)
 *   npm run hearing:download     Parakeet (464 MB) and Smart Turn (9 MB), for hearing
 */
import { loadDotEnv } from '../config.ts';
import { DEFAULT_REFLEX_MODEL, downloadModel, MODELS } from './files.ts';

loadDotEnv(); // NOVA_MODELS_DIR, if set
const names = process.argv.length > 2 ? process.argv.slice(2) : [DEFAULT_REFLEX_MODEL];
for (const name of names) {
  const spec = MODELS[name];
  if (!spec) {
    console.error(`Unknown model "${name}". Known: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }
  console.log(`Downloading ${spec.label} from huggingface.co/${spec.repo} (${spec.license} licence)...`);
  const shown = new Map<string, number>();
  const target = await downloadModel(name, {
    onProgress(file, received, total) {
      const pct = Math.floor((received / total) * 10) * 10; // every 10%
      if (total > 1_000_000 && shown.get(file) !== pct) console.log(`  ${file}: ${pct}%`), shown.set(file, pct);
    },
  });
  console.log(`Checked and saved in ${target}`);
}
