import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLinuxFallbackDefault } from '../../src/main/linux-mime.ts';

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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`================================================\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
