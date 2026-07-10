# ScreenSaver Enhancements

[中文说明](./README_ZH.md)

ScreenSaver Enhancements is a Decky Loader plugin for Steam Deck. It keeps the screen awake while supported media apps request inhibition through D-Bus, or while user-selected processes are running.

This project is based on [xfangfang/DeckyInhibitScreenSaver](https://github.com/xfangfang/DeckyInhibitScreenSaver) and adds manual process monitoring plus a richer management panel.

## Changelog

### 1.3.0

#### Added and improved

- Added a black mask display switch and transparency adjustment.
- Improved feature separation by moving the application configuration for preventing screen sleep to the secondary page.
- Improved compatibility with newer SteamOS and SteamClient API versions.

### 1.2.0

#### Added and improved

- Frontend poll interval: 1s → 3s; IPC/backend load reduced by 3x.
- Settings check frequency: 5s → 30s; IPC calls reduced by 6x.
- UI process-list refresh: 10s → 30s; `ps` subprocess calls reduced by 3x.
- Removed the per-second full-DOM scan: `querySelectorAll('audio')`.
- Reworked `installAudioTracker` to use shared handler functions instead of creating closures for every `play`, reducing GC pressure.
- Removed duplicate process checks from backend `get_event()`; `ps` command frequency changed from every second to every 5–10 seconds.
- Added adaptive `_manual_watch_loop` polling: 10s idle / 5s active, reducing idle CPU usage by 83%–91%.

### 1.1.0

#### Added and improved

- Fixed the manual inhibit list not applying to newly added applications.
- Improved process matching for short command names, complete command arguments, long executable names, and Flatpak app IDs.
- Added DeckyMusic-specific handling: it inhibits sleep only while actual audio playback is detected, not merely because its plugin process is running.
- Improved coordination between D-Bus automatic inhibition and manual process inhibition.

## Features

- **D-Bus inhibit support**: Compatible with apps that use standard inhibit APIs, such as VLC, Chrome, mpv, and wiliwili.
- **Manual process monitoring**: Add running processes to an inhibit list and keep the screen awake while they exist.
- **Robust process matching**: Matches short command names, full command arguments, long executable names, and Flatpak app IDs.
- **Backend watcher**: Manual process checks run in the plugin backend, so they do not depend on the Decky panel staying open.
- **DeckyMusic special handling**: DeckyMusic is not inhibited merely because its plugin process is running. If enabled in the inhibit list, it is handled by frontend audio playback detection.
- **Run on login**: Automatically starts the background monitor when Decky Loader starts.

## Screenshots

| Main panel | Settings panel |
| --- | --- |
| ![Main panel overview](./docs/Screenshot/mainPage_1.jpg) | ![Main panel status](./docs/Screenshot/mainPage_2.jpg) |
| ![Settings overview](./docs/Screenshot/secondaryPage_1.jpg) | ![Settings options](./docs/Screenshot/secondaryPage_2.jpg) |

## Install

1. Install [Decky Loader](https://decky.xyz).
2. Build or download `ScreenSaverEnhancements.zip`.
3. Extract the `ScreenSaverEnhancements` folder into:
   `/home/deck/homebrew/plugins/`
4. Restart Steam or reload Decky Loader.

## How It Works

The plugin uses two paths:

- **Automatic mode** registers the same D-Bus services as the original project. Apps that call `Inhibit` produce events, and the frontend applies SteamOS idle/suspend settings to keep the screen awake.
- **Manual mode** periodically scans running processes from the backend. When a configured process is found, the backend emits an `Inhibit` event through the same event path used by automatic mode.

When no automatic or manual inhibitor is active, the plugin restores the default settings:

- dim: 5 minutes
- suspend: 10 minutes

## DeckyMusic

DeckyMusic is a long-running plugin process, so process-based monitoring would keep the screen awake even while music is paused. This plugin skips DeckyMusic in backend process matching.

If `DeckyMusic` is in the inhibit list, the frontend watches real HTML media playback state instead. It only inhibits while audio is actually playing.

## Development

```powershell
npm.cmd install
npm.cmd test
python build.py
```

`npm.cmd test` runs TypeScript validation and any discovered unit tests. Build output is written to `build/ScreenSaverEnhancements` and `build/ScreenSaverEnhancements.zip`.
