import { existsSync } from 'node:fs';
import path from 'node:path';

function resolveOptionalBuildIcon(relativePath) {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return existsSync(absolutePath) ? absolutePath : undefined;
}

function createMarkdownFileAssociation(ext, iconRelativePath) {
  const icon = resolveOptionalBuildIcon(iconRelativePath);

  return {
    ext,
    name: 'Markdown Document',
    description: 'Open Markdown files with Markdown Editor Pro',
    role: 'Editor',
    ...(icon ? { icon } : {}),
  };
}

export default {
  appId: 'com.crh.markdowneditorpro',
  productName: 'Markdown Editor Pro',
  executableName: 'markdown-editor-pro',
  directories: {
    buildResources: 'build',
  },
  files: ['out/**', 'package.json'],
  asar: true,
  compression: 'maximum',
  npmRebuild: false,
  win: {
    target: ['nsis'],
    fileAssociations: [
      createMarkdownFileAssociation('md', 'build/file-associations/md.ico'),
      createMarkdownFileAssociation('markdown', 'build/file-associations/markdown.ico'),
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'Office',
    icon: 'build/icons',
    fileAssociations: [
      {
        ext: 'md',
        name: 'Markdown Document',
        description: 'Open Markdown files with Markdown Editor Pro',
        mimeType: 'text/markdown',
      },
      {
        ext: 'markdown',
        name: 'Markdown Document',
        description: 'Open Markdown files with Markdown Editor Pro',
        mimeType: 'text/markdown',
      },
    ],
    desktop: {
      entry: {
        Name: 'Markdown Editor Pro',
        Comment: 'A professional Markdown editor',
        Categories: 'Office;TextEditor;',
        StartupWMClass: 'markdown-editor-pro',
      },
    },
  },
};
