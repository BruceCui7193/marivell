<div align="center">

[English](README.md) | **简体中文**

# Marivell

**一个安静、本地优先的 Markdown 工作区：实时数学公式、图表和玻璃拟态界面。**

[![Release](https://img.shields.io/github/v/release/BruceCui7193/marivell?style=for-the-badge)](https://github.com/BruceCui7193/marivell/releases)
[![License](https://img.shields.io/github/license/BruceCui7193/marivell?style=for-the-badge)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/BruceCui7193/marivell/release.yml?style=for-the-badge)](https://github.com/BruceCui7193/marivell/actions)

</div>

![Marivell 工作区](docs/screenshots/hero-light.png)

Marivell 是一个所见即所得的 Markdown 编辑器，同时保留 Markdown 的完整控制力。它基于 Electron、React、TypeScript、Tiptap、KaTeX 和 Mermaid 构建，默认以本地文件为主，不需要云端账号。

## 编辑器

![深色源代码模式](docs/screenshots/source-dark.png)

一张最大化的工作区截图同时展示了任务列表、KaTeX 公式、Mermaid 图表、代码块、表格、脚注、文件夹导航和完整工具栏。源代码模式可以一键切到原始 Markdown，带行号和语法高亮。

## 为什么选择 Marivell

- **所见即所得编辑。** 直接编辑渲染后的文档，不需要单独维护预览窗格。
- **像真正的数学一样显示公式。** 行内和块级 LaTeX 使用 KaTeX 实时渲染。
- **文档内嵌图表。** Mermaid 图表保留可编辑性，并在原地渲染。
- **需要时使用源代码模式。** 原始 Markdown、行号和语法高亮一键可达。
- **安静、可配置的界面。** 支持磨砂玻璃、液态玻璃或纯色界面，深浅色模式和多种配色。
- **本地优先工作流。** 打开文件夹、浏览文件、粘贴图片、检测外部修改、导出文档，不需要云端账号。

## 功能

| 类别 | 说明 |
| --- | --- |
| Markdown | 标题、列表、任务列表、引用、表格、代码块、链接、脚注、HTML 块 |
| 数学公式 | `$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\]`，KaTeX 渲染和 LaTeX 语法高亮 |
| 图表 | Mermaid 流程图、时序图、状态图、甘特图等 |
| 文件 | 文件夹侧栏、文件树、文档大纲、外部修改检测、多窗口 |
| 图片 | 拖放、粘贴、保存到文档目录、保存到默认图库、保留原路径 |
| 外观 | 浅色、深色、跟随系统；natural、forest、bay、warm paper、graphite、aurora、sakura、lavender、cyberpunk 配色；磨砂玻璃、液态玻璃或纯色界面 |
| 导出 | PDF、2x 长图，以及 Pandoc 格式：DOCX、HTML、EPUB、LaTeX、ODT、RTF、PPTX、纯文本、GFM |
| 源代码模式 | 带行号的原始 Markdown 编辑器、搜索、跳转到行、语法高亮 |

## 快速开始

### Linux

从源码构建并安装最新版本：

```bash
sudo npm run install:linux
```

也可以从 [Releases](https://github.com/BruceCui7193/marivell/releases) 安装 `.deb` 或 AppImage。

### Windows

从 [Releases](https://github.com/BruceCui7193/marivell/releases) 下载 Windows 安装程序。安装器默认勾选可选的 `.md` / `.markdown` 文件关联。

### 打开 Markdown 文件

安装后可以从终端打开文件：

```bash
marivell document.md
```

## 开发

要求：Node.js 20+、npm 10+。

```bash
npm install
npm run dev
```

## 测试

```bash
npm test
```

测试套件覆盖 Markdown 往返、源代码/可视化模式切换、历史记录、剪贴板、公式、代码块、图片、脚注、任务列表、工作流压力场景和打包资源。GitHub Actions 会在构建发布前运行相同的测试。

## 构建

```bash
# Linux 安装包
npm run build:linux

# Windows 安装程序
npm run build:win

# 本地 Linux 免安装构建
npm run build:linux:dir
```

## 文件关联

`.md` 和 `.markdown` 的文件关联配置位于 [electron-builder.config.mjs](electron-builder.config.mjs)。

- Windows：NSIS 安装器可以为 Marivell 注册 `.md` / `.markdown`，并使用自定义文档图标。
- Linux：安装器注册 MIME 类型并安装 Markdown 图标，文件管理器会用 Marivell 图标显示 `.md` / `.markdown` 文件，并在“打开方式”中列出 Marivell。

## 键盘快捷键

| 操作 | 快捷键 |
| --- | --- |
| 保存 | `Ctrl+S` |
| 搜索 / 替换 | `Ctrl+F` |
| 源代码模式 | `Ctrl+Shift+E` |
| 导出 PDF | `Ctrl+Shift+P` |
| 导出图片 | `Ctrl+Shift+I` |
| 切换主题 | `Ctrl+Shift+L` |
| 切换侧栏 | `Ctrl+\` |
| 新建窗口 | `Ctrl+N` |
| 打开文件 | `Ctrl+O` |
| 加粗 | `Ctrl+B` |
| 斜体 | `Ctrl+I` |

## 项目结构

```text
src/
  main/        Electron 主进程、桌面集成、导出流程
  preload/     IPC 桥接层
  renderer/    React UI、编辑器、主题、剪贴板、液态玻璃
  shared/      共享契约和类型
build/         图标、桌面文件、安装器资源
tests/         Markdown fixtures 和共享测试资源
scripts/       构建、安装和测试脚本
```

可直接打开的示例文档：[docs/demo/marivell.md](docs/demo/marivell.md)。

## 技术栈

Electron、electron-vite、React、TypeScript、Tiptap/ProseMirror、KaTeX、Mermaid、lowlight、remark、pngjs、electron-builder。

液态玻璃 UI 是基于开源项目 [archisvaze/liquid-glass](https://github.com/archisvaze/liquid-glass) 的 SVG displacement 思路自研适配的独立渲染器，并加入了 Marivell 自己的背景采样层、动画和性能优化。实现见 [liquid-glass.ts](src/renderer/effects/liquid-glass.ts)。

## 许可证

MIT
