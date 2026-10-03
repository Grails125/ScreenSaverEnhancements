import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { getEventListeners } from 'node:events';

const source = fs.readFileSync(new URL('../decky_music_cdp.py', import.meta.url), 'utf8');
const script = source.match(/DECKY_MUSIC_TRACKER_SCRIPT = r'''([\s\S]*?)'''/)[1];
const key = '__screenSaverEnhancementsDeckyMusicTrackerV1';
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

function fixture() {
  let tracked;
  class ObservableSet extends Set { constructor(...args) { super(...args); tracked = this; } }
  class Media extends EventTarget {
    paused = true;
    ended = false;
    readyState = 0;
    result = Promise.resolve();
    failure = null;
    play(...args) {
      this.args = args;
      if (this.failure) throw this.failure;
      return this.result;
    }
    pause() {
      this.paused = true;
      if (!this.silentPause) this.dispatchEvent(new Event('pause'));
      return this.pauseResult;
    }
  }
  const originalPlay = Media.prototype.play, originalPause = Media.prototype.pause;
  const context = vm.createContext({ Set: ObservableSet, WeakRef, HTMLMediaElement: Media });
  const install = () => vm.runInContext(script, context);
  install();
  return { Media, context, originalPlay, originalPause, install,
    tracker: () => context[key], retained: () => tracked.size };
}

test('rejected and synchronous failed play calls release their audio references', async () => {
  const f = fixture();
  for (let n = 0; n < 100; n++) {
    const audio = new f.Media(); audio.result = Promise.reject(Error('autoplay denied'));
    assert.equal(audio.play(), audio.result);
    await audio.result.catch(() => {});
  }
  const audio = new f.Media(); audio.failure = Error('invalid state');
  assert.throws(() => audio.play(), error => error === audio.failure);
  await flush(); assert.equal(f.retained(), 0);
});

test('initial query retains active detached audio and skips paused and ended objects', () => {
  const f = fixture(), active = new f.Media(), ended = new f.Media();
  active.paused = false; active.readyState = 4;
  ended.paused = false; ended.ended = true; ended.readyState = 4;
  assert.equal(f.tracker().trackAll([active, ended, ...Array.from({ length: 1000 }, () => new f.Media())]), true);
  assert.equal(f.retained(), 1);
  active.pause(); assert.equal(f.retained(), 0); assert.equal(f.tracker().isPlaying(), false);
});

test('play preserves its returned promise and arguments while tracking later playback', async () => {
  const f = fixture(), audio = new f.Media();
  assert.equal(audio.play('argument'), audio.result);
  assert.deepEqual(audio.args, ['argument']);
  audio.paused = false; audio.readyState = 4;
  audio.dispatchEvent(new Event('playing'));
  await flush(); assert.equal(f.tracker().isPlaying(), true); assert.equal(f.retained(), 1);
  audio.ended = true; audio.dispatchEvent(new Event('ended'));
  assert.equal(f.retained(), 0);
});

test('paused or failed elements are pruned when no terminal event is delivered', async () => {
  const f = fixture(), audio = new f.Media(); audio.paused = false; audio.readyState = 4;
  audio.play(); await flush(); assert.equal(f.retained(), 1);
  audio.paused = true;
  assert.equal(f.tracker().isPlaying(), false); assert.equal(f.retained(), 0);
});

test('an old rejected play cannot remove a newer successful playback', async () => {
  const f = fixture(), audio = new f.Media(); let reject;
  audio.result = new Promise((_, no) => { reject = no; });
  const old = audio.play(); const observed = old.catch(() => {});
  audio.result = Promise.resolve(); audio.paused = false; audio.readyState = 4;
  audio.play(); await flush(); reject(Error('old aborted')); await observed; await flush();
  assert.equal(f.tracker().isPlaying(), true); assert.equal(f.retained(), 1);
});

test('reinstalling the current tracker does not wrap media methods again', () => {
  const f = fixture(), tracker = f.tracker(), play = f.Media.prototype.play, pause = f.Media.prototype.pause;
  assert.equal(f.install(), true); assert.equal(f.tracker(), tracker);
  assert.equal(f.Media.prototype.play, play); assert.equal(f.Media.prototype.pause, pause);
  assert.equal(tracker.version, 2);
});

test('an injected version one tracker is preserved until the UI reloads', () => {
  const f = fixture(), play = f.Media.prototype.play, pause = f.Media.prototype.pause;
  // V1's originals and set are private; preserve its detection instead of wrapping it again.
  const old = { version: 1, isPlaying: () => true, trackAll: () => true };
  f.context[key] = old;
  assert.equal(f.install(), true); assert.equal(f.tracker(), old);
  assert.equal(f.Media.prototype.play, play); assert.equal(f.Media.prototype.pause, pause);
});

test('pause without a browser event clears tracking and preserves the native result', async () => {
  const f = fixture(), audio = new f.Media(); audio.paused = false; audio.readyState = 4;
  audio.play(); await flush(); audio.silentPause = true; audio.pauseResult = 'native result';
  assert.equal(audio.pause(), 'native result'); assert.equal(f.retained(), 0);
});

test('repeated playback and terminal events keep listener count bounded', async () => {
  const f = fixture(), audio = new f.Media();
  for (let n = 0; n < 100; n++) {
    audio.paused = false; audio.readyState = 4; audio.play(); await flush();
    for (const type of ['playing', 'pause', 'ended', 'error', 'emptied']) {
      assert.equal(getEventListeners(audio, type).length, 1);
    }
    audio.paused = true; audio.dispatchEvent(new Event(n % 2 ? 'error' : 'emptied'));
    for (const type of ['playing', 'pause', 'ended', 'error', 'emptied']) {
      assert.equal(getEventListeners(audio, type).length, type === 'playing' ? 1 : 0);
    }
    assert.equal(f.retained(), 0);
  }
});

test('an abandoned pending play has no strong tracker reference', () => {
  const f = fixture(), audio = new f.Media(); audio.result = new Promise(() => {});
  assert.equal(audio.play(), audio.result); assert.equal(f.retained(), 0);
  assert.equal(f.tracker().isPlaying(), false);
});

test('an initially paused queried audio can start native playback without a JS play call', () => {
  const f = fixture(), audio = new f.Media();
  assert.equal(f.tracker().trackAll([audio]), false); assert.equal(f.retained(), 0);
  audio.paused = false; audio.readyState = 4; audio.dispatchEvent(new Event('playing'));
  assert.equal(f.tracker().isPlaying(), true); assert.equal(f.retained(), 1);
  audio.pause(); assert.equal(f.retained(), 0);
});

test('a buffering active element is detected again when native playback resumes', () => {
  const f = fixture(), audio = new f.Media(); audio.paused = false; audio.readyState = 4;
  f.tracker().trackAll([audio]); audio.readyState = 0;
  assert.equal(f.tracker().isPlaying(), false); assert.equal(f.retained(), 0);
  audio.readyState = 4; audio.dispatchEvent(new Event('playing'));
  assert.equal(f.tracker().isPlaying(), true); assert.equal(f.retained(), 1);
});

test('source reset releases strong references while later native playback is tracked again', () => {
  const f = fixture(), audio = new f.Media(); audio.paused = false; audio.readyState = 4;
  assert.equal(f.tracker().trackAll([audio]), true);
  audio.paused = true; audio.readyState = 0; audio.dispatchEvent(new Event('emptied'));
  assert.equal(f.tracker().isPlaying(), false); assert.equal(f.retained(), 0);
  audio.paused = false; audio.readyState = 4; audio.dispatchEvent(new Event('playing'));
  assert.equal(f.tracker().isPlaying(), true); assert.equal(f.retained(), 1);
  audio.dispatchEvent(new Event('ended'));
  assert.equal(f.retained(), 0);
});
