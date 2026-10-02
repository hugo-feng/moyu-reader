# 开发流程规范

适用于 `D:\work\android`（墨阅 Android 端）与 `D:\work\moyu-reader`（Web 验证器）两个仓库。
目标只有一个：**任何一行代码都能回答「谁、什么时候、为什么改的」**。

---

## 一、提交身份（最重要，先配这个）

仓库里的提交作者必须是真人。如果历史上出现过 `dev <dev@local>` 这类占位身份，
那份历史就无法追溯 —— 没人能认领，也不知道该找谁问。

首次使用先配置（**只需一次**）：

```powershell
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
```

邮箱建议用 GitHub 提供的隐私邮箱（`设置 → Emails → Keep my email private`），
形如 `12345678+用户名@users.noreply.github.com`。
这样提交能关联到你的 GitHub 账号，又不会把真实邮箱写进公开历史。

**禁止**再用 `git -c user.name=... commit` 临时指定身份 ——
那正是产生占位作者的原因。配好全局身份后直接 `git commit` 即可。

验证：

```powershell
git log -1 --format='%an <%ae>'
```

---

## 二、分支模型

采用简化的 GitHub Flow —— 单人项目够用，又保留了可回溯性。

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 随时可发布的稳定分支 | **只接受 PR 合并，不直接提交** |
| `feat/<简短描述>` | 新功能 | 从 `main` 切出，完成后开 PR |
| `fix/<简短描述>` | 修 bug | 同上 |
| `chore/<简短描述>` | 构建、依赖、文档 | 同上 |

### 为什么不在 main 上直接提交

单人项目直接提交确实更快，但会失去两样东西：

1. **回滚粒度**。出问题时只能按提交回退，而一个提交里混了功能与修复，
   就没法只回退其中一半。
2. **变更意图的记录**。PR 描述里能写清「为什么这么改、考虑过哪些别的做法」，
   提交信息塞不下这些。半年后回头看，这才是最有价值的部分。

### 一个分支只做一件事

分支名要能看出做什么。`fix/reader-bottom-occlusion` 比 `fix2` 有用得多。

---

## 三、提交信息

格式：

```
<类型>: <一句话说清改了什么>

<可选：为什么这么改。若修的是 bug，写清触发条件与影响面>
```

类型用这几个前缀：

| 前缀 | 用于 |
|---|---|
| `feat:` | 新增功能 |
| `fix:` | 修 bug |
| `refactor:` | 重构，行为不变 |
| `perf:` | 性能 |
| `test:` | 只改测试 |
| `docs:` | 只改文档 |
| `build:` | 构建脚本、依赖 |
| `chore:` | 杂项 |

### 写「为什么」，不要只写「做了什么」

`fix: 分页漏扣天头地脚` 只说了做了什么。
`git diff` 本身就能看出改了什么，提交信息重复它没有价值。

有价值的是 diff 里**看不到**的东西：

```
fix: 分页漏扣天头书眉与地脚页码，导致每页少排 2-3 行字

版心高度由「视口 - 页边距 - 系统栏」推算，但正文容器里还有
天头书眉与地脚页码，两者都没被扣掉。结果分页按 28 行排，
实际只装得下 26 行 —— 每页悄悄少 2~3 行字。

最危险的是用户不会察觉自己少读了，只会觉得「这书排版有点挤」。

改为由渲染侧上报实测容器高度：容器本身已被页边距、系统栏与
地脚约束住，报上来的数字天然与真实版心一致，
公式不可能再和布局脱节。
```

### 一次提交只做一件事

不要把「修 bug」和「重构」混在一起。混了就没法单独回退其中之一。

如果确实需要一起改（例如重构后才能修 bug），就拆成两个提交：
先重构（行为不变，测试全过），再修 bug。

---

## 四、每次提交前必须做的验证

提交前本地跑通，**不要指望 CI 兜底** —— 这两个仓库都还没配 CI。

### Android 端

```powershell
$env:JAVA_HOME='D:\AndroidToolchain\jdk\jdk-17.0.13+11'
$env:ANDROID_HOME='D:\AndroidToolchain\sdk'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
cd D:\work\android
.\gradlew.bat --no-daemon -g 'D:\work\.cache\gradle-home' :app:testDebugUnitTest
```

要求：**全部测试通过**，且**编译零警告**（有警告说明有未处理的隐患）。

### Web 端

```powershell
cd D:\work\moyu-reader
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # 类型检查
node node_modules/vitest/vitest.mjs run                          # 单元测试
node tests/e2e.mjs                                               # 端到端
node tests/layout-audit.mjs                                      # 多尺寸布局审计
```

要求：类型检查零错误、单测与 e2e 全过、布局审计 0 问题。

### 出安装包时

见 [`releases/VERSION.md`](../android/releases/VERSION.md)。
要点：**必须提升 `versionCode`，不得覆盖历史版本的 APK**。

---

## 五、推送流程

```powershell
# 1. 从最新的 main 切分支
git switch main
git pull
git switch -c fix/reader-bottom-occlusion

# 2. 改代码，跑验证

# 3. 提交（身份已全局配好，不要再加 -c 参数）
git add -A
git commit -m "fix: 分页漏扣天头书眉与地脚页码，导致每页少排 2-3 行字

..."

# 4. 推分支
git push -u origin fix/reader-bottom-occlusion

# 5. 在 GitHub 上开 PR → 自查 diff → 合并到 main
```

### 合并方式：用 squash

PR 合并选 **Squash and merge**。这样 `main` 上每个提交对应一个完整的功能或修复，
历史线性可读；分支内部那些「改错了再改回来」的中间提交不会污染主干。

squash 后的提交信息用 PR 标题 + 描述，所以**PR 描述要认真写** ——
它就是最终留在历史上的那条记录。

---

## 六、凭据管理

**不要把 token 贴在对话、聊天或任何会被记录的地方。**
GitHub token 等同于账号写权限，泄露后对方可以推任意代码、删仓库。

正确做法（本机已配好 `credential.helper=store`）：

首次推送时会提示输入用户名与密码，**密码处粘贴 token**。
Git 会保存到 `%USERPROFILE%\.git-credentials`，之后不再询问。

该文件是**明文**存储，但权限限定为当前用户可读。
这比把 token 写进脚本或对话安全，但不是加密存储。

更好的选择（若以后愿意折腾）：安装
[Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)，
它用 Windows 凭据管理器加密保存，且支持浏览器授权，无需手工创建 token。

### token 的最小权限

创建 token 时**只勾 `repo`**（或对单一仓库的 `Contents: Read and write`）。
不要勾 `delete_repo`、`admin:org` 这类用不到的权限 ——
万一泄露，损失范围小得多。

### 定期轮换

token 建议设有效期（90 天），到期重新生成。
旧 token 到 GitHub 设置里**主动吊销**，不要只是删掉本地文件。

---

## 七、绝对不要做的事

| 禁止 | 原因 |
|---|---|
| 提交密钥、token、密码 | 一旦推送，即使后续删除，**历史里仍然存在**，必须改写历史才能清除 |
| `git push --force` 到 `main` | 会覆盖别人的提交，且让所有已克隆的仓库产生分叉 |
| 把 `build/`、`node_modules/` 入库 | 历史会膨胀到无法克隆 |
| 覆盖 `releases/` 里的历史 APK | 无法再回答「用户装的是哪一版」 |
| 用 `dev <dev@local>` 之类的占位身份提交 | 历史无人认领，等于没有作者信息 |
| 用 `Set-Content` 批量改写源码 | 在 PowerShell 5.1 下是「按 ANSI 读、按 UTF-8 带 BOM 写」，会把中文变乱码、把文件写坏。**改用编辑器工具** |

最后一条不是理论风险 —— 这个项目里真实发生过两次，
导致 Kotlin 源码乱码、九处 import 丢失。
