import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cosmosAtlasPlugin } from './cosmos-atlas-patch.mjs';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
await build({ entryPoints: { app: 'app.mjs', worker: 'worker.mjs' }, outdir: 'dist', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof',
  plugins: [cosmosAtlasPlugin] });
await copyFile('style.css', 'dist/style.css');
// Version all viewer assets together so a cached script cannot outlive its UI.
const assets = await Promise.all(['app.js', 'worker.js', 'style.css'].map(name => readFile(`dist/${name}`)));
const version = createHash('sha256');
for (const asset of assets) version.update(asset);
const suffix = `?v=${version.digest('hex').slice(0, 16)}`;
const html = (await readFile('index.html', 'utf8'))
  .replace('href="style.css"', `href="style.css${suffix}"`)
  .replace('src="app.js"', `src="app.js${suffix}"`);
await writeFile('dist/index.html', html);
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
