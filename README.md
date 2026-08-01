# markdown-editor-pro

`markdown-editor-pro` 是一个面向桌面场景的所见即所得（WYSIWYG）Markdown 编辑器，使用 Electron、React、TypeScript、Vite 和 Tiptap 构建。

项目目标不是简单实现 Markdown 渲染，而是提供一套更接近成熟桌面编辑器的使用体验，包括实时编辑、数学公式、Mermaid、文件夹浏览、多窗口、主题切换、导出能力和跨平台桌面集成。

## 主要功能

- 所见即所得编辑，不使用传统分栏预览
- 支持常用 Markdown 语法：标题、列表、任务列表、引用、表格、代码块、图片、链接、脚注等
- 支持数学公式：`$...$`、`$$...$$`、`\(...\)`、`\[...\]`，编辑时含 LaTeX 语法高亮
- 支持 Mermaid 图表渲染与单击编辑
- 支持粘贴 Markdown 文本自动转换为富文本
- 支持 Ctrl+F 搜索，全部匹配高亮（装饰层）+ 当前匹配深色高亮，导航不抢占焦点
- 支持源码模式
- 支持图片拖拽、粘贴和本地资源落盘
- 支持打开文件夹，并在侧栏查看当前目录中的 Markdown 文件
- 支持文档大纲侧栏
- 支持外部文件变更检测（提示重新加载或另存）
- 支持浅色、深色、跟随系统以及 9 套配色方案（自然/森林/海湾/暖纸/石墨/北极光/春樱/薰衣草/赛博朋克）
- 支持多窗口
- 支持未保存修改保护
- 支持记住上次窗口大小、位置和最大化状态
- 支持高质量导出 PDF（独立 Markdown 渲染管线，KaTeX 公式 / Mermaid 图表 / 任务列表完整保留）
- 支持导出 2× 高清长图（Chrome DevTools 全页截图）
- 支持通过 Pandoc 导出 Word (DOCX)、HTML、EPUB、LaTeX、ODT、RTF、PPTX 等格式（需安装 [Pandoc](https://pandoc.org)）
- 支持 Pandoc 自定义模板：DOCX/ODT/PPTX 参考文档（`--reference-doc`）、HTML/LaTeX 模板（`--template`）、EPUB 样式表（`--css`）；可设置默认模板或在导出时临时选择
- 支持 Windows/Linux 文件关联，可将 `.md` / `.markdown` 文件默认关联到本应用

## 技术栈

- Electron
- electron-vite
- React
- TypeScript
- Tiptap / ProseMirror
- unified / remark-parse / remark-gfm / remark-math
- KaTeX
- Mermaid
- lowlight
- pngjs

## 目录结构

```text
src/
  main/        Electron 主进程与桌面集成逻辑
  preload/     IPC 桥接层
  renderer/    React 界面、编辑器逻辑与样式
  shared/      主进程与渲染进程共享类型
build/         图标等打包资源
```

## 环境要求

- Node.js 20 及以上
- npm 10 及以上
- Windows 10 / 11 或 Ubuntu 20.04+ (Linux)

## 安装依赖

```bash
npm install
```

如果你是从旧版本代码更新到最新版本，建议重新执行一次 `npm install`，确保新增依赖已经安装完成。

## 开发运行

```bash
npm run dev
```

## 构建应用

### Windows

```bash
npm run build:win
```

### Linux (Ubuntu/Debian)

```bash
npm run build:linux
```

如果只想生成目录版产物用于本地测试，可以执行：

```bash
npm run build:linux:dir
```

## 安装到系统 (Linux)

从源码构建并安装最新版，直接执行：

```bash
sudo npm run install:linux
```

它会先执行 `npm run build:linux:dir`，再执行 `scripts/install-linux.sh`，等价于：

```bash
sudo npm run build:linux:dir
sudo bash scripts/install-linux.sh
```

如果已经构建过 `dist/linux-unpacked`，只想重新安装当前产物，可以只执行：

```bash
sudo bash scripts/install-linux.sh
```

注意：安装脚本需要写入 `/opt` 和 `/usr/local`，所以要用 `sudo`。如果之前用 `sudo` 构建过，`out/` 和 `dist/` 可能是 root 权限，之后普通用户构建会报 `EACCES`；可以先清理再构建：

```bash
sudo rm -rf out dist
sudo npm run install:linux
```

安装后，可以在应用菜单中找到 Markdown Editor Pro，也可以直接在终端运行：

```bash
markdown-editor-pro
markdown-editor-pro document.md
```

**卸载：**

```bash
sudo rm -rf /opt/markdown-editor-pro \
  /usr/local/bin/markdown-editor-pro \
  /usr/local/share/icons/hicolor/512x512/apps/markdown-editor-pro.png \
  /usr/local/share/applications/markdown-editor-pro.desktop
```

## 构建产物

构建完成后，常见产物位于 `dist/` 目录：

- `dist/win-unpacked/`：Windows 目录版应用
- `dist/linux-unpacked/`：Linux 目录版应用
- `dist/*.exe`：Windows 安装包
- `dist/*.AppImage`：Linux AppImage 安装包
- `dist/*.deb`：Linux deb 安装包

## 文件关联

`.md` 和 `.markdown` 文件关联配置位于 \[electron-builder.config.mjs]。

Windows 下通过 NSIS 安装包注册，Linux 下通过 desktop entry + MIME 类型实现。安装后可直接双击 `.md` 文件打开。
