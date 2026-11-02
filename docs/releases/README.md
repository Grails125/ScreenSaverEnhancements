# 发布约定

发布说明沿用中英文格式：先写 `[ZH-CN] 屏幕保护增强 v<version>` 和“新增与改进”，再写 `[EN] ScreenSaver Enhancements v<version>` 和“Added and improved”。每次发布将说明保存为本目录的 `v<version>.md`；合入外部贡献时，注明作者、PR 链接及具体贡献。

GitHub 发行版标题与 Git 标签沿用 `v<version>` 格式，例如 `v2.0.6`。

后续新版本只生成并上传 `ScreenSaverEnhancements.zip`。版本由 Git 标签、发行版标题和包内 `package.json` 确定，ZIP 内部根目录保持 `ScreenSaverEnhancements/`，避免改变 Decky 安装目录。

旧版内置更新器需要固定文件名，较新内置更新器在没有版本化 ZIP 时也会回退到该文件名。只发布一个匹配的插件 ZIP，避免 Direct Updater 0.2.6 因匹配到两个候选包而报告“版本不明确”。不要删除或更改已发布版本的资产。

发布前完成以下步骤：

1. 核对 `package.json` 版本号、发布标签与本目录中的更新说明一致。
2. 运行 `npm test` 和 `python build.py`，确认仅生成固定名称的 ZIP，包内版本、插件名、必需文件及 SHA-256 正确。
3. 将版本标签指向已验证的提交，使用对应 `v<version>.md` 创建草稿发行版，只上传 `ScreenSaverEnhancements.zip`；下载并核验后再公开。
4. 核对发布后的资产名、GitHub 返回的 SHA-256 摘要与内置更新器和 Direct Updater 的检查结果，并验证实际升级流程。

## v2.0.6

更新说明使用 [v2.0.6.md](./v2.0.6.md)，主要安装包为 `ScreenSaverEnhancements-v2.0.6.zip`，同时上传字节完全相同的 `ScreenSaverEnhancements.zip`。本版仅修复 Steam UI 类名缺失时的加载和样式降级，不改变监控行为，不覆盖用户设置。

保留原 `staticClasses` 取值，缺失时跳过样式规则；不要将空选择器插入 `.sse-panel-root` 规则，也不要因为字段缺失就优先切换未经对应环境验证的类名集合。已有模拟测试及 Deck 同步验证不代表所有 Steam 测试通道版本均已实测。

当时按草稿上传两份资产、下载核验再公开；新标签指向合入 main 的已验证提交，不移动旧版本标签。此次发布没有自动更新此前已同步修复、仍标记为 2.0.5 的 Deck 安装。

## v2.0.5

更新说明使用 [v2.0.5.md](./v2.0.5.md)，主要安装包为 `ScreenSaverEnhancements-v2.0.5.zip`，同时上传字节完全相同的 `ScreenSaverEnhancements.zip`。本版沿用已在 Deck 验证的监控与诊断实现，版本更新不改写用户的应用规则或电源设置。

新版本标签应指向完成验证并合入 main 的提交。先以草稿上传资产，核对下载文件的版本、插件名、必需模块及 SHA-256，再公开为正式 Latest Release；不要覆盖已有标签或旧版资产。

依赖审计记录（2026-11-01，使用官方 npm registry）：没有高危或严重项；构建工具的 `deepmerge`、`glob`、`minimatch` 依赖链仍有 2 项低危、3 项中危告警。本次未进行会引入破坏性工具链变更的强制修复，后续依赖升级需单独验证，不能宣称已清零全部漏洞。

## v2.0.4 同版本更正历史

v2.0.4 使用 [v2.0.4.md](./v2.0.4.md)，主要安装包为 `ScreenSaverEnhancements-v2.0.4.zip`。以下为当时的同版本更正流程，不用于新版本发布。

原 v2.0.4 安装包因更新安装身份名称错误撤回，更正包仍以 v2.0.4 发布。已安装原包的用户需从 ZIP 重装，同版本更正不会触发新版本提示。

同版本重发前，由维护者核对本地及远端 `v2.0.4` 标签均指向包含修复、已通过验证的提交，再从该提交重新构建两份 ZIP。核验 ZIP 内的版本、插件名、必需模块及两份包的 SHA-256 一致；旧发行版转为草稿后替换资产，验证新资产后再重新公开。已有标签不可直接重复创建，应先确认标签对应的提交。

标签和更正包核验完成后，使用以下命令发布 v2.0.4：

```powershell
git rev-parse v2.0.4
git ls-remote --tags origin refs/tags/v2.0.4
gh release upload v2.0.4 build/ScreenSaverEnhancements-v2.0.4.zip build/ScreenSaverEnhancements.zip --clobber
gh release edit v2.0.4 --draft=false --prerelease=false --latest --title v2.0.4 --notes-file docs/releases/v2.0.4.md
```

发布后下载并核验两份资产的 SHA-256、ZIP 元数据与已验证构建一致，确认发行版标签指向正确提交，并通过手动 ZIP 安装验证插件重载与功能。保留 [PR #1](https://github.com/Grails125/ScreenSaverEnhancements/pull/1) 作者及贡献致谢。
