import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const pluginJson = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);

test("pins the Decky 3.2.6 compatible modern frontend toolchain", () => {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.dependencies["@decky/api"], "1.1.3");
  assert.equal(packageJson.devDependencies["@decky/ui"], "4.11.6");
  assert.equal(packageJson.devDependencies["@decky/rollup"], "1.0.2");
  assert.match(packageJson.scripts["build:v2-probe"], /rollup\.v2-probe\.config\.js/);
  assert.equal(pluginJson.api_version, 1);
});

test("the V2 probe uses typed callable RPC and reversible modern APIs", () => {
  const source = readFileSync(
    new URL("../src/v2Probe.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /callable<\[\], Diagnostics>/);
  assert.match(source, /routerHook\.addGlobalComponent/);
  assert.match(source, /routerHook\.removeGlobalComponent/);
  assert.match(source, /toaster\.toast/);
  assert.doesNotMatch(source, /ServerAPI|callPluginMethod|decky-frontend-lib/);
});

test("the V2 probe build delegates to the official Decky Rollup preset", () => {
  const source = readFileSync(
    new URL("../rollup.v2-probe.config.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /from ["']@decky\/rollup["']/);
  assert.match(source, /format:\s*["']esm["']/);
  assert.match(source, /build\/v2-probe/);
  assert.match(source, /entryFileNames:\s*["']index\.js["']/);
});

test("shared TypeScript options do not pin Rollup to the legacy output directory", () => {
  const tsconfig = JSON.parse(
    readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"),
  );

  assert.equal(tsconfig.compilerOptions.outDir, undefined);
  assert.equal(tsconfig.compilerOptions.suppressImplicitAnyIndexErrors, undefined);
  assert.match(packageJson.scripts.build, /tsc --outDir dist/);
});

test("the V2 probe type-check is isolated from the legacy frontend", () => {
  const config = readFileSync(
    new URL("../rollup.v2-probe.config.js", import.meta.url),
    "utf8",
  );
  const probeTsconfig = JSON.parse(
    readFileSync(new URL("../tsconfig.v2-probe.json", import.meta.url), "utf8"),
  );

  assert.match(config, /tsconfig:\s*["']\.\/tsconfig\.v2-probe\.json["']/);
  assert.deepEqual(probeTsconfig.include, ["src/v2Probe.tsx"]);
  assert.equal(probeTsconfig.compilerOptions.jsx, "react-jsx");
});

test("the legacy Rollup config remains valid after switching the package to ESM", () => {
  const source = readFileSync(
    new URL("../rollup.config.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /readFileSync/);
  assert.doesNotMatch(source, /import\s+\{\s*name\s*\}\s+from\s+["']\.\/plugin\.json["']/);
});
