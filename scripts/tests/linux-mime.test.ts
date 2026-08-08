import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getLinuxFallbackDefault,
  getLinuxMimeConfigPaths,
  removeLinuxMarkdownMimeDefaults,
  removeMarkdownMimeEntries,
} from '../../src/main/linux-mime.ts';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log('  ✓', name);
    return;
  }
  failed += 1;
  console.error('  ✗', name, detail);
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mep-linux-mime-'));
  try {
    await writeFile(path.join(dir, 'markdown-editor-pro.desktop'), 'MimeType=text/markdown;\n');
    await writeFile(path.join(dir, 'typora.desktop'), 'MimeType=text/markdown;\n');
    await writeFile(path.join(dir, 'other.desktop'), 'MimeType=text/x-markdown;\n');

    const fallback = await getLinuxFallbackDefault([dir]);
    assert('linux fallback excludes this app', fallback !== 'markdown-editor-pro.desktop', fallback);
    assert('linux fallback prefers typora', fallback === 'typora.desktop', fallback);

    const emptyDir = path.join(dir, 'empty');
    await mkdir(emptyDir);
    const empty = await getLinuxFallbackDefault([emptyDir]);
    assert('linux fallback handles no alternatives', empty === '', empty);

    const mime = [
      '[Default Applications]',
      'text/markdown=markdown-editor-pro.desktop',
      'text/plain=text-editor.desktop',
      '[Added Associations]',
      'text/markdown=typora.desktop;',
      'application/x-markdown=other.desktop;',
    ].join('\n');
    const removed = removeMarkdownMimeEntries(mime);
    assert(
      'removing linux mime defaults strips markdown associations',
      !removed.includes('text/markdown') && !removed.includes('application/x-markdown'),
      removed,
    );
    assert(
      'removing linux mime defaults keeps unrelated entries',
      removed.includes('text/plain=text-editor.desktop') && removed.includes('[Added Associations]'),
      removed,
    );

    const configDir = path.join(dir, 'config');
    const dataDir = path.join(dir, 'data');
    await mkdir(configDir);
    await mkdir(path.join(dataDir, 'applications'), { recursive: true });
    const oldConfigHome = process.env.XDG_CONFIG_HOME;
    const oldDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      const configPath = getLinuxMimeConfigPaths()[0];
      const dataPath = getLinuxMimeConfigPaths()[1];
      await writeFile(configPath, '[Default Applications]\ntext/markdown=markdown-editor-pro.desktop\n');
      await writeFile(dataPath, '[Default Applications]\ntext/markdown=typora.desktop\n');
      const touched = await removeLinuxMarkdownMimeDefaults();
      assert('removeLinuxMarkdownMimeDefaults touches both mime files', touched.length === 2, touched.join(','));
      assert(
        'removeLinuxMarkdownMimeDefaults clears config default',
        !(await readFile(configPath, 'utf8')).includes('markdown'),
      );
      assert(
        'removeLinuxMarkdownMimeDefaults clears data default',
        !(await readFile(dataPath, 'utf8')).includes('markdown'),
      );
    } finally {
      if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfigHome;
      if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldDataHome;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`================================================\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
