import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const diagnosticsHookSource = readFileSync(new URL("../src/useDiagnosticsData.ts", import.meta.url), "utf8");

test("uses consistent icon components for secondary page entry actions", () => {
  assert.match(indexSource, /RiMoonClearLine/);
  assert.match(indexSource, /RiInformationLine/);
  assert.doesNotMatch(indexSource, /<span style=\{PANEL_STYLES\.menuIcon\}>☾<\/span>/);
  assert.doesNotMatch(indexSource, /<span style=\{PANEL_STYLES\.menuIcon\}>i<\/span>/);
});

test("uses one accessible back button across secondary pages", () => {
  assert.match(indexSource, /const SecondaryPageBackButton: FC<\{ onBack: \(\) => void \}>/);
  assert.match(indexSource, /aria-label=\{t\('Back'\)\}/);
  assert.match(indexSource, /<SecondaryPageBackButton onBack=\{onBack\} \/>/);
  assert.equal((indexSource.match(/<SecondaryPageBackButton onBack=\{onBack\} \/>/g) || []).length, 2);
});

test("keeps recent event timestamps on one line when event names are long", () => {
  assert.match(indexSource, /diagnosticEventName/);
  assert.match(indexSource, /diagnosticEventTime/);
  assert.match(indexSource, /textOverflow: 'ellipsis'/);
  assert.match(indexSource, /whiteSpace: 'nowrap' as const/);
  assert.doesNotMatch(indexSource, /formatDiagnosticEventDetail\(event\.detail\) \|\| formatDiagnosticTime\(event\.timestamp\)/);
  assert.match(indexSource, /const eventDetail = formatDiagnosticEventDetail\(event\.detail\);/);
  assert.match(indexSource, /eventDetail && \([\s\S]*\{eventDetail\}/);
  assert.doesNotMatch(indexSource, /\{formatDiagnosticEventDetail\(event\.detail\)\}/);
});

test("removes the unused secondary page back icon style", () => {
  assert.doesNotMatch(indexSource, /backIcon:\s*\{/);
});

test("cleans up the diagnostics export status timer on dismount", () => {
  assert.match(diagnosticsHookSource, /const diagnosticsExportTimeoutRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\);/);
  assert.match(diagnosticsHookSource, /diagnosticsExportTimeoutRef\.current = setTimeout\(/);
  assert.match(diagnosticsHookSource, /clearTimeout\(diagnosticsExportTimeoutRef\.current\);/);
});

test("uses direct backend RPC calls instead of forwarding wrappers", () => {
  assert.doesNotMatch(indexSource, /const startBackend = async/);
  assert.doesNotMatch(indexSource, /const stopBackend = async/);
  assert.doesNotMatch(indexSource, /const isBackendRunning = async/);
});
