import {readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';
import externalGlobals from 'rollup-plugin-external-globals';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'plugin.json'), 'utf8'));

// Match Decky's ESM/global contract without its unpatched glob/delete chain.
export const cleanOutput = relativeDirectory => ({
  name: 'clean-output',
  buildStart() {
    const output = resolve(root, relativeDirectory);
    if (![resolve(root, 'dist'), resolve(root, 'build/v2-probe')].includes(output)) {
      throw new Error('Unexpected build output directory');
    }
    let entries;
    try {entries = readdirSync(output);} catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (realpathSync(output) !== output) throw new Error('Build output must not resolve outside its directory');
    for (const entry of entries) rmSync(resolve(output, entry), {recursive: true, force: true});
  },
});

export default {
  input: './src/index.tsx',
  context: 'window',
  plugins: [
    cleanOutput('dist'), typescript(), json(), commonjs(), nodeResolve({browser: true}),
    externalGlobals({react: 'SP_REACT', 'react/jsx-runtime': 'SP_JSX',
      'react-dom': 'SP_REACTDOM', '@decky/ui': 'DFL', '@decky/manifest': JSON.stringify(manifest)}),
    replace({preventAssignment: false, 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')}),
  ],
  external: ['react', 'react-dom', '@decky/ui'],
  treeshake: {pureExternalImports: {pure: ['@decky/ui', '@decky/api']}, preset: 'smallest'},
  output: {dir: 'dist', format: 'esm', sourcemap: true, exports: 'default',
    sourcemapPathTransform: relativeSourcePath => relativeSourcePath.replace(/^\.\.\//, `decky://decky/plugin/${encodeURIComponent(manifest.name)}/`)},
};
