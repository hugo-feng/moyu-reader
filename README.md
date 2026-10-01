# 墨阅 · 浏览器验证器

这是 Android 应用「墨阅」的**功能验证器**，不是最终交付物。

存在的理由：本机没有可用的模拟器（`HypervisorPresent: False`，Windows 虚拟化功能未启用），
装不了 APK，也就没法用眼睛确认界面和交互是否正常。所以把**同一套引擎逻辑**用
TypeScript 重写一遍、跑在浏览器里，用它来回答「这个功能到底能不能用」。

两端刻意共享同一套规则（编码探测、分章、分页、统计口径），
因此这里跑通的行为对 Android 端有参考价值。但要注意：**验证器通过 ≠ 真机通过**，
像素级排版与系统能力（SAF、TTS）只能在真机上确认。

## 跑起来

```bash
pnpm install
pnpm dev            # 开发服务器
pnpm build          # 类型检查 + 生产构建 → dist/
pnpm preview        # 预览 dist（端口 4173）
```

## 验证命令

```bash
# 单元测试：引擎层（编码 / 分章 / 分页 / EPUB）
node node_modules/vitest/vitest.mjs run

# 端到端实测：真实 Edge + 手机尺寸视口（390×844），44 项断言
node tests/e2e.mjs

# 界面截图：11 张关键界面，供人眼复核排版
node tests/shots.mjs

# 排版探针：验证标题不重复显示、段落首无残留空白
node tests/probe-render.mjs
```

端到端测试**用真实 Chromium 而不是 jsdom**：本项目依赖 IndexedDB（书库）、
Canvas 度量（分页）、Selection/Range API（选词）、ResizeObserver（视口监听），
jsdom 对这些要么不实现要么不完整，用它测出来的「通过」没有意义。

## 当前状态

| | |
|---|---|
| 单元测试 | **144 个全部通过** |
| 端到端 | **44/44 通过**（真实 Edge，零控制台错误、零 404） |
| 生产构建 | 主包 302 KB（gzip 99 KB）+ 按需加载的 epubjs 分块 342 KB + 样式 26 KB |

## 目录

```
src/
├── engine/          引擎层，与界面无关（也是 Android 端要逐条对齐的部分）
│   ├── encoding.ts         编码探测：字节级严格 UTF-8 校验，失败回退 GB18030
│   ├── chapters.ts         TXT 分章：高/低置信两级判定，偏移无损
│   ├── pagination.ts       分页：按字符宽度测量 + 二分查找切页
│   ├── search.ts           全文检索
│   ├── progress.ts         阅读进度换算
│   ├── stats.ts            统计口径（本地时区归日、连续天数、热力等级）
│   ├── epub.ts             EPUB 解析与正文提取
│   └── dictionary.ts       词典
├── storage/         IndexedDB 持久化
├── ui/              React 界面
└── demo.ts          示例书内容（原创，刻意做成能压测分章与分页的形态）
```

## 关于示例书

`src/demo.ts` 里的《剑影长歌》是刻意构造的测试文本，不是随便写的占位符：

- 章节标题混用 8 种格式（`第一章` / `第1章` / `第 九 章` / `第4章` / `【第3章】` / `楔子` / `番外` …），
  用来压测分章算法的兼容性；
- **第十二章刻意写到 1481 字**（其余章节最多 348 字），是全书唯一能跨页的一章。
  在此之前每一章都恰好一页，导致「分页是否正确」「翻到次页会不会丢字」
  「次页起该不该印书眉」这些真正要命的路径在验证器里根本走不到；
- 结尾留空段、段首带全角空格，用来验证「首行缩进不被重复施加」。

## 与 Android 端的关系

| 能力 | 验证器 | Android |
|---|---|---|
| 分页 | Canvas 字符宽度测量 + 二分查找 | 真实 `StaticLayout` |
| 编码探测 | `TextDecoder` + 字节级校验 | 同样的字节级校验 |
| 分章 | `chapters.ts` | `ChapterSplitter.kt`（规则逐条对齐） |
| 存储 | IndexedDB | Room |
| 朗读 / 词典 / SAF | 浏览器能力或降级 | 系统 TTS / 内置词典 / SAF |

**修改分章或统计规则时，必须同时改两端**，否则验证器就不再能代表 Android 端的行为。
