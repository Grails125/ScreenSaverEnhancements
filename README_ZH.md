# ScreenSaver Enhancements（屏幕保护增强）

[English](./README.md)

ScreenSaver Enhancements 是一个 Steam Deck 的 Decky Loader 插件，用于在视频播放、网页浏览、音乐播放或指定应用运行时阻止屏幕调暗和系统休眠。

本项目基于 [xfangfang/DeckyInhibitScreenSaver](https://github.com/xfangfang/DeckyInhibitScreenSaver) 扩展，保留原版 D-Bus 抑制休眠能力，并新增手动进程监听和更完整的管理界面。

## 功能

- **D-Bus 自动抑制**：兼容 VLC、Chrome、mpv、wiliwili 等会主动发送 inhibit 请求的应用。
- **手动进程监听**：可以把正在运行的进程加入阻止休眠列表，只要目标进程存在就保持屏幕常亮。
- **更稳的进程匹配**：支持短命令名、完整命令行、长可执行文件名和 Flatpak app id。
- **后端常驻监听**：手动进程扫描在插件后端运行，不依赖 Decky 面板一直打开。
- **DeckyMusic 特殊处理**：不会因为 DeckyMusic 插件进程常驻就一直阻止休眠；如果列表中启用了 DeckyMusic，则只在真实音频播放时阻止休眠。
- **开机自启**：Decky Loader 启动后可自动启动后台监听。

## 安装

1. 安装 [Decky Loader](https://decky.xyz)。
2. 构建或下载 `ScreenSaverEnhancements.zip`。
3. 解压后把 `ScreenSaverEnhancements` 文件夹放到：
   `/home/deck/homebrew/plugins/`
4. 重启 Steam，或在 Decky 菜单中重新加载插件。

## 工作方式

插件有两条触发路径：

- **自动模式**注册原版相同的 D-Bus 服务。应用调用 `Inhibit` 后，插件前端会通过 SteamClient 修改 SteamOS 的调暗和休眠设置。
- **手动模式**由后端定期扫描进程。发现配置列表中的进程后，后端通过与自动模式相同的事件路径发出 `Inhibit` 事件。

当所有自动和手动抑制都结束后，插件会恢复默认设置：

- 调暗：5 分钟
- 休眠：10 分钟

## DeckyMusic

DeckyMusic 是一个常驻插件进程，单纯按进程名监听会导致它即使暂停播放也一直阻止休眠。因此本插件会在后端进程匹配中跳过 DeckyMusic。

如果阻止列表中包含 `DeckyMusic`，前端会监听真实的 HTML 媒体播放状态，只在音频实际播放时阻止休眠。

## 开发

```powershell
npm.cmd install
python build.py
```

构建产物会输出到 `build/ScreenSaverEnhancements` 和 `build/ScreenSaverEnhancements.zip`。
