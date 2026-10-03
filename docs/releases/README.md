# 发布约定

发布说明沿用中英文格式：先写 `[ZH-CN] 屏幕保护增强 v<version>` 和“新增与改进”，再写 `[EN] ScreenSaver Enhancements v<version>` 和“Added and improved”。每次发布将说明保存为本目录的 `v<version>.md`；合入外部贡献时，注明作者、PR 链接及具体贡献。

GitHub 发行版标题与 Git 标签沿用 `v<version>` 格式，例如 `v2.0.4`。

安装包由 `package.json` 中的版本号命名：`ScreenSaverEnhancements-v<version>.zip`。ZIP 内部根目录保持 `ScreenSaverEnhancements/`，避免改变 Decky 安装目录。

构建同时生成 `ScreenSaverEnhancements.zip` 兼容包，与版本化安装包字节完全相同。发布时上传两份：用户手动安装优先选择带版本号的文件；旧版插件的自动更新仍通过固定文件名查找安装包。

发布前完成以下步骤：

1. 核对 `package.json` 版本号、发布标签与本目录中的更新说明一致。
2. 运行 `npm test` 和 `python build.py`，检查两份安装包的 SHA-256 一致。
3. 将版本标签指向已验证的提交，使用对应 `v<version>.md` 作为 GitHub Release 说明，并上传两份 ZIP。
4. 核对发布后的资产名、GitHub 返回的 SHA-256 摘要与更新检查结果。

v2.0.4 使用 [v2.0.4.md](./v2.0.4.md)，主要安装包为 `ScreenSaverEnhancements-v2.0.4.zip`。

代码提交并推送后，切换到已验证的提交并重新构建，再使用以下命令发布 v2.0.4：

```powershell
git tag v2.0.4
git push origin v2.0.4
gh release create v2.0.4 --verify-tag --title v2.0.4 --notes-file docs/releases/v2.0.4.md build/ScreenSaverEnhancements-v2.0.4.zip build/ScreenSaverEnhancements.zip
```
