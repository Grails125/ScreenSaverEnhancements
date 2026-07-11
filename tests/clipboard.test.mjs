import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/clipboard.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { copyTextToClipboard } = module.exports;

const documentEnvironment = (copyResult) => {
  const input = { value: "", style: {}, setAttribute() {}, focus() {}, select() {} };
  return {
    createElement: () => input,
    execCommand: () => copyResult,
    body: { appendChild() {}, removeChild() {} },
  };
};

test("uses the Decky-compatible document copy path first", async () => {
  let navigatorCalled = false;
  const copied = await copyTextToClipboard("report", {
    windowValue: {},
    documentValue: documentEnvironment(true),
    navigatorValue: { clipboard: { writeText: async () => { navigatorCalled = true; } } },
  });
  assert.equal(copied, true);
  assert.equal(navigatorCalled, false);
});

test("falls back to a SteamClient clipboard method when document copy fails", async () => {
  let copiedText = null;
  const system = { SetClipboardText(text) { copiedText = text; } };
  const copied = await copyTextToClipboard("diagnostics", {
    windowValue: { SteamClient: { System: system } },
    documentValue: documentEnvironment(false),
    navigatorValue: {},
  });
  assert.equal(copied, true);
  assert.equal(copiedText, "diagnostics");
});

test("reports failure when every clipboard path is unavailable", async () => {
  const copied = await copyTextToClipboard("diagnostics", {
    windowValue: {},
    documentValue: documentEnvironment(false),
    navigatorValue: {},
  });
  assert.equal(copied, false);
});
