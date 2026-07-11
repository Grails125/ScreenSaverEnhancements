import { readFileSync } from 'node:fs';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import { defineConfig } from 'rollup';
import importAssets from 'rollup-plugin-import-assets';

const { name } = JSON.parse(
  readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  input: './dist/index.js',
  plugins: [
    commonjs(),
    nodeResolve(),
    json(),
    replace({
      preventAssignment: false,
      'process.env.NODE_ENV': JSON.stringify('production'),
    }),
    importAssets({
      publicPath: `http://127.0.0.1:1337/plugins/${name}/`
    })
  ],
  context: 'window',
  external: ["react", "react/jsx-runtime", "react-dom", "decky-frontend-lib"],
  output: {
    file: "dist/index.js",
    globals: {
      react: "SP_REACT",
      "react/jsx-runtime": "SP_JSX",
      "react-dom": "SP_REACTDOM",
      "decky-frontend-lib": "DFL"
    },
    format: 'iife',
    exports: 'default',
  },
});
