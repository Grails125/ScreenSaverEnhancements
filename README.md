# ScreenSaver Enhancements

[中文说明](./README_ZH.md)

ScreenSaver Enhancements is a Decky Loader plugin for Steam Deck. It keeps the screen awake while supported media apps request inhibition through D-Bus, or while user-selected processes are running.

This project is based on [xfangfang/DeckyInhibitScreenSaver](https://github.com/xfangfang/DeckyInhibitScreenSaver) and adds manual process monitoring plus a richer management panel.

## What's New in 1.3.0

- Added a management panel that shows the current inhibition state and its source.
- Improved manual process matching for executable names, command arguments, and Flatpak app IDs.
- Moved manual process monitoring to the backend so it remains active while the Decky panel is closed.
- Added DeckyMusic playback-aware inhibition and black-background controls.
- Improved compatibility with recent SteamOS and SteamClient API variants.

## Features

- **D-Bus inhibit support**: Compatible with apps that use standard inhibit APIs, such as VLC, Chrome, mpv, and wiliwili.
- **Manual process monitoring**: Add running processes to an inhibit list and keep the screen awake while they exist.
- **Robust process matching**: Matches short command names, full command arguments, long executable names, and Flatpak app IDs.
- **Backend watcher**: Manual process checks run in the plugin backend, so they do not depend on the Decky panel staying open.
- **DeckyMusic special handling**: DeckyMusic is not inhibited merely because its plugin process is running. If enabled in the inhibit list, it is handled by frontend audio playback detection.
- **Run on login**: Automatically starts the background monitor when Decky Loader starts.

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
