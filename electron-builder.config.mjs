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
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    include: 'build/installer.nsh',
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
