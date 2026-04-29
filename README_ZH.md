# ScreenSaver Enhancements (屏幕保护增强)

[English](./README.md)

这是一个适用于 **Decky Loader** (Steam Deck 插件加载器) 的高级插件，旨在通过监控系统请求或手动指定进程，防止 Steam Deck 在播放视频、网页浏览或运行特定应用时自动熄屏/休眠。

### 🌟 核心功能
- **全自动识别**：支持标准的 D-Bus 接口请求（如 VLC、Chrome、mpv、wiliwili 等）。
- **手动增强模式**：实时扫描当前运行中的进程，支持一键将任何应用添加到“禁止锁屏列表”。
- **高级 UI 界面**：深度集成 Steam Deck 原生设计风格，提供清晰的状态卡片和操作面板。
- **智能映射**：自动为运行中的进程匹配中文名称，并区分系统与应用进程。
- **后台守护**：支持开机自启，在后台静默守护您的屏幕常亮需求。

### 📸 界面预览
<img width="1080" height="1440" alt="d3e9c577940f25d1224b22c892608de3" src="https://github.com/user-attachments/assets/1817419f-787a-427d-80c7-829b9ced0e50" />
<img width="1080" height="1440" alt="7c443969fa712c3c4887efb099a8a6af" src="https://github.com/user-attachments/assets/822b6403-aabd-4b36-8a62-45b43aba3691" />



### 🚀 如何安装
1. 确保已安装 [Decky Loader](https://decky.xyz)。
2. 从 [Releases](https://github.com/Grails125/ScreenSaverEnhancements/releases) 下载最新的 `ScreenSaverEnhancements.zip`。
3. 将压缩包解压后的 `ScreenSaverEnhancements` 文件夹放入 Steam Deck 的 `/home/deck/homebrew/plugins` 目录。
4. 重启 Steam 或在 Decky 菜单中重新加载插件。

### 🛠️ 工作原理
在 Steam Deck 游戏模式下，系统通常在几分钟无操作后自动进入休眠或调暗屏幕。
- **自动模式**：插件会监控系统 D-Bus 服务，当收到应用的 Inhibit 请求时，自动修改系统设置。
- **手动模式**：插件会周期性检查您手动添加的进程是否正在运行。只要该进程存在，插件就会保持系统常亮，并在进程结束后恢复默认设置（调暗：5分钟，休眠：10分钟）。

### 📝 兼容性
- **浏览器**：Chrome, Firefox, Edge 等。
- **视频播放器**：VLC, mpv, Kodi, Wiliwili 等。
- **其他应用**：只要是能出现在进程列表中的应用，均可通过手动模式支持。

---
*本项目基于 [xfangfang/DeckyInhibitScreenSaver](https://github.com/xfangfang/DeckyInhibitScreenSaver) 进行重构与功能增强。*
