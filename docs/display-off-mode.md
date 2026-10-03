# Display-off mode

## Scope

Add an explicit, one-shot action that turns off the Steam Deck's internal display while background applications continue running. Keep the existing black overlay and its settings. Do not add download completion detection or automatic suspend after downloading.

## Behavior

- Use a display power API, rather than reducing brightness or rendering black pixels.
- Install a reliable wake path before turning off the display. Reuse `black_background_close_on_any_key`: when enabled, a controller button or touch restores the screen; when disabled, ordinary input leaves the display off and Quick Access restores it and opens the panel. Normal suspend/resume and plugin unload release this session too.
- Keep the system awake for this session without changing the user's saved power settings or application rules. Release only the session's own sleep inhibition when the screen wakes.
- The action is transient: no saved "screen off" flag and no automatic activation on startup.
- Do not stop audio, downloads, or other applications, or change power/performance profiles.
- If the display API or wake support is unavailable, keep the screen on and report the failure. Do not silently substitute a black overlay.
- Concurrent activation/exit, failed activation, and unload during activation must leave no orphaned screen-off session.

## Validation

1. Test session activation, wake, failure cleanup, repeated activation, and unload races.
2. Run TypeScript checks, repository tests, and the production build.
3. On the OLED Deck, use a short, automatically restored trial to verify the display output switches off while a background process continues advancing.
4. Verify input wake and cleanup using the actual Steam UI integration.

## Interface selection

Use Steam's native `Gamescope.SetDisplayPowerState` service for activation and normal wake. Detect capability and the internal-display flag at runtime. A separate backend process holds a 30-second renewable recovery lease; EOF, timeout, signal, and backend unload restore the internal display through Wayland. The parent also restores it if the guard exits unexpectedly. Display state is transient, while the existing persisted power-override snapshot protects temporary idle timeout changes across reloads.

Guard and power-recovery RPCs have a five-second response deadline. Every metadata commit uses a fresh ownership revision; clearing an override retains an inactive revision so delayed requests cannot recreate or remove newer recovery state. Each native power-setting stage also has a five-second deadline. An expired transaction cannot send its next stage; a late response triggers a bounded repair to the latest shared intent. Repairs do not regenerate themselves indefinitely. A replacement frontend waits for its predecessor's bounded cleanup. Partial idle-setting failures roll back the saved profile, keeping the recovery snapshot if rollback fails. Profile edits also update any pending recovery snapshot.

Source: [Valve gamescope display control protocol](https://github.com/ValveSoftware/gamescope/blob/3.16.23/protocol/gamescope-control.xml).

## Verified on the OLED Deck

- SteamOS 3.8.28, gamescope 3.16.23.6: native Off disabled the eDP connector/CRTC; On restored it.
- The production plugin's independent recovery guard started, renewed, and stopped successfully.
- With the shared any-key option disabled, A left the display off and Quick Access woke it and opened the panel. With it enabled, A woke it.
- A background JavaScript counter continued advancing. After waking, the power configuration matched the pre-test values and the recovery snapshot was cleared.
- Release 2.0.4 checks: 293 JavaScript tests passed; 171 Python tests completed with six platform-specific skips on Windows. Earlier device validation passed all 165 Python tests available at that time. The installable package passed verification.


## Reload and profile recovery

A shared content registry replaces the inner React component even when Decky 3.2.9 retains the previous active plugin object. Ownership protects replacement content from an older instance's disposal. The power editor serializes edits and passive synchronization, rebases pending edits after initialization, and persists profiles with ownership revisions. A shared record of completed native writes prevents Steam's delayed disk flush from replacing the recovered profile with temporary disabled timeouts during reload.

Backend shutdown has a total deadline and does not send frontend events while unloading. The Decky 3.2.9 socket listener is stopped only after its module and current plugin ownership are verified; its final EOF is handled without spinning or canceling unrelated tasks. Compatibility follows the [Loader socket implementation](https://github.com/SteamDeckHomebrew/decky-loader/blob/v3.2.9/backend/decky_loader/localplatform/localsocket.py).

## Wake latency

Owned guard recovery and native On run concurrently. Either successful path releases wake input, while both bounded requests finish before another Off is allowed. Gamescope service lookup caches only a valid module export; each action still reads current capability and checks that the active display is internal. Errors invalidate the cached export.

A native On that exceeds the response deadline remains tracked until the underlying request actually settles. While it is pending, a new Off is refused, including across plugin reloads and for On requests used to recover a delayed Off. This prevents an older wake from undoing a newer off session. Capability replies superseded by a newer intent cannot submit a display mutation.

On the OLED Deck, three trials before optimization sent the native On request 16.7–18.3 ms after the UI input callback and completed session cleanup in 90.6–92.4 ms. After optimization, three trials sent On in 2.8–12.7 ms and completed cleanup in 77.1–89.1 ms. KMS activation was observed about 11–17 ms after the callback in these latter trials. These are software and driver measurements, not the time from a physical button press until visible OLED pixels.

A passive 90-second observation kept the internal display off with 45 successful guard heartbeats and no spontaneous wake. With any-key wake enabled, Steam's joystick and touchpad touch buttons also count as input; controlled tests that send Quick Access intentionally wake the screen.

## Settings and monitor concurrency

Application-rule edits, notification and any-key wake preferences, black-overlay settings, opacity saves, and complete background-monitor transactions are serialized. Pending edits are projected over the last confirmed value, so an earlier failure cannot roll back a later choice. Initialization reads cannot override newer edits or external closes. An external overlay close supersedes a pending enable and repairs its late persistence. State revisions also protect factory initialization and the overlay's own opacity read. Failed preference reads retain the last confirmed baseline.

Setting editors and their runtime-state publishers survive panel unmounts and are reused when the panel reopens. Plugin disposal releases their external listeners and fences old queued writes and callbacks.

A passive power-profile read remains the editor's native baseline if saving its local copy fails; the next edit first retries saving that baseline. This avoids changing unrelated Steam settings back to stale values. Diagnostic refresh revisions prevent old replies from restoring cleared events.

Backend start and stop share one lifecycle lock. Unload cancels an in-progress lifecycle operation while retaining its total shutdown deadline. Optional MPRIS discovery has a two-second budget and cannot indefinitely delay ordinary application monitoring. A failed or timed-out D-Bus connection query is unknown rather than disconnected; only a confirmed vanished sender releases its inhibit cookie.

Backend health checks the actual D-Bus connection. The existing 25-second watcher clears stale requests and MPRIS state after disconnection and retries connecting under the lifecycle lock. Service names are requested without queueing or replacing another owner, and a conflict releases any names already acquired during that attempt. Timed-out D-Bus calls release their own reply handlers.

App-rule process and inhibit queries have separate request revisions, so older replies cannot replace newer data or clear its loading state. Cancelling a restore notification invalidates in-flight queries and queued toasts; notification execution also checks plugin lifetime and the current preference.
