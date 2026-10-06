import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cosmosAtlasPlugin } from './cosmos-atlas-patch.mjs';
await mkdir('dist', { recursive: true });
await build({ entryPoints: { app: 'app.mjs', worker: 'worker.mjs' }, outdir: 'dist', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof',
  plugins: [cosmosAtlasPlugin] });
for (const name of ['index.html', 'style.css']) await copyFile(name, `dist/${name}`);
const licenses = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) { await collect(path); continue; }
    try {
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      for (const file of await readdir(path)) {
        if (/^(license|licence|copying|notice)(\.|$)/i.test(file)) {
          licenses.push(`${pkg.name} ${pkg.version}\n${await readFile(join(path, file), 'utf8')}`);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await collect('node_modules');
await writeFile('dist/THIRD_PARTY_LICENSES.txt', licenses.join('\n\n--------------------\n\n'));
