import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const VERSION = '3.4.2';
const SHA256 = '4ad56e0d6ddb6ad483baee7464b6ab0dd88b31c6af7f049408ad50574b8f1ff2';

export function patchCosmosAtlas(source, version, atlasPath) {
  if (version !== VERSION || createHash('sha256').update(source).digest('hex') !== SHA256) {
    throw new Error('Cosmos atlas patch requires the exact pinned @cosmos.gl/graph 3.4.2 bundle; review the adapter before upgrading');
  }
  const start = source.indexOf('function Ai(a, e = 16384) {');
  const end = source.indexOf('\nfunction Bi(', start);
  if (start < 0 || end < 0 || source.indexOf('function Ai(a, e = 16384) {', start + 1) >= 0) {
    throw new Error('Expected exactly one Cosmos 3.4.2 atlas helper');
  }
  return `import { createAtlasDataFromImageData as albumAtlas } from ${JSON.stringify(atlasPath)};\n` +
    source.slice(0, start) + 'function Ai(a, e = 16384) { return albumAtlas(a, e); }\n' + source.slice(end);
}

export const cosmosAtlasPlugin = {
  name: 'bounded-cosmos-3.4.2-atlas',
  setup(build) {
    build.onLoad({ filter: /@cosmos\.gl[\\/]graph[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      const pkg = JSON.parse(await readFile(resolve(dirname(path), '../package.json'), 'utf8'));
      return { contents: patchCosmosAtlas(await readFile(path, 'utf8'), pkg.version,
        resolve('atlas.mjs')), loader: 'js', resolveDir: dirname(path) };
    });
  },
};
