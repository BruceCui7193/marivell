export default {
  appId: 'com.crh.marivell',
  productName: 'Marivell',
  executableName: 'marivell',
  directories: {
    buildResources: 'build',
  },
  files: ['out/**', 'package.json'],
  asar: true,
  compression: 'maximum',
  npmRebuild: false,
  win: {
    target: ['nsis'],
    extraResources: [
      { from: 'build/file-associations/md.ico', to: 'md.ico' },
      { from: 'build/file-associations/markdown.ico', to: 'markdown.ico' },
    ],
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
        name: 'Marivell Markdown Document',
        description: 'Open Markdown files with Marivell',
        mimeType: 'text/markdown',
      },
      {
        ext: 'markdown',
        name: 'Marivell Markdown Document',
        description: 'Open Markdown files with Marivell',
        mimeType: 'text/markdown',
      },
    ],
    desktop: {
      entry: {
        Name: 'Marivell',
        Comment: 'A professional Markdown editor',
        Categories: 'Office;TextEditor;',
        StartupWMClass: 'marivell',
      },
    },
  },
};
