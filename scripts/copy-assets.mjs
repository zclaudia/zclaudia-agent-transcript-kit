// tsc emits JS and .d.ts; the stylesheet has to be copied alongside it.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assets = [['src/react/transcript.css', 'dist/react/transcript.css']];

for (const [from, to] of assets) {
  const target = path.join(root, to);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, from), target);
}
console.log(`copied ${assets.length} asset(s) into dist/`);
