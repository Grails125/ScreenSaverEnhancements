# ScreenSaver Enhancements

[中文说明](./README_ZH.md)

An advanced plugin for **Decky Loader** (Steam Deck's plugin loader) designed to prevent the Steam Deck from automatically dimming or suspending the screen during video playback, web browsing, or while running specific applications.

### 🌟 Key Features
- **Automatic Inhibition**: Fully supports standard D-Bus inhibit requests (used by VLC, Chrome, mpv, wiliwili, etc.).
- **Manual Enhancement Mode**: Real-time scanning of running processes, allowing you to add any application to the "Inhibit List" with one click.
- **Premium UI**: Deeply integrated with the Steam Deck native design language, featuring clear status cards and intuitive panels.
- **Process Intelligence**: Automatically maps process names to readable titles and distinguishes between system and user applications.
- **Background Service**: Supports running on login to silently manage your screen-on requirements.

### 🚀 How to Install
1. Ensure [Decky Loader](https://decky.xyz) is installed.
2. Download the latest `ScreenSaverEnhancements.zip` from [Releases](https://github.com/Grails125/ScreenSaverEnhancements/releases).
3. Extract and place the `ScreenSaverEnhancements` folder into `/home/deck/homebrew/plugins/`.
4. Restart Steam or reload the plugin via the Decky menu.

### 🛠️ How it Works
In SteamOS Game Mode, the system defaults to dimming or suspending after a few minutes of inactivity.
- **Auto Mode**: The plugin monitors D-Bus services and automatically adjusts system settings upon receiving an "Inhibit" request from an app.
- **Manual Mode**: The plugin periodically checks if your manually added processes are running. As long as a matched process is active, the screen remains on. Default settings (Dim: 5m, Suspend: 10m) are restored once the process exits.

### 📝 Compatibility
- **Browsers**: Chrome, Firefox, Edge, etc.
- **Media Players**: VLC, mpv, Kodi, Wiliwili, etc.
- **Any Process**: Any running software visible in the process list can be supported via manual mode.

---
*This project is a refactored and enhanced version of [xfangfang/DeckyInhibitScreenSaver](https://github.com/xfangfang/DeckyInhibitScreenSaver).*