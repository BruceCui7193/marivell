import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function section(title: string): void {
  console.log(`\n## ${title}`);
}

section('file association icons');

{
  for (const file of ['md.ico', 'markdown.ico']) {
    const data = readFileSync(path.join(projectRoot, 'build/file-associations', file));
    assert(`${file} is an ICO resource`, data.subarray(0, 4).toString('latin1') === '\u0000\u0000\u0001\u0000');
  }

  const config = read('electron-builder.config.mjs');
  assert('windows association config uses md icon', config.includes("build/file-associations/md.ico"));
  assert('windows association config uses markdown icon', config.includes("build/file-associations/markdown.ico"));
  assert('windows build bundles md icon as resource', config.includes("from: 'build/file-associations/md.ico', to: 'md.ico'"));
  assert('windows build bundles markdown icon as resource', config.includes("from: 'build/file-associations/markdown.ico', to: 'markdown.ico'"));

  const installer = read('build/installer.nsh');
  assert('installer keeps optional association checkbox', installer.includes('Associate .md / .markdown files with Markdown Editor Pro'));
  assert('installer does not fall back to exe icon', !installer.includes('$appExe,0'));
  assert('installer registers md with custom icon', installer.includes('$INSTDIR\\resources\\md.ico'));
  assert('installer registers markdown with custom icon', installer.includes('$INSTDIR\\resources\\markdown.ico'));
  assert('installer can remove associations when unchecked', installer.includes('APP_UNASSOCIATE "md" "MarkdownEditorPro.md"'));
}

section('linux mime icons');

{
  const mime = read('build/file-associations/markdown-editor-pro.xml');
  assert('mime package covers .md', mime.includes('*.md'));
  assert('mime package covers .markdown', mime.includes('*.markdown'));
  assert('mime package declares markdown icon', mime.includes('<icon name="text-markdown"/>'));

  for (const size of ['64', '128', '256', '512']) {
    assert(`linux mime icon ${size}px exists`, readFileSync(path.join(projectRoot, `build/file-associations/text-markdown-${size}.png`)).length > 0);
  }

  const script = read('scripts/install-linux.sh');
  assert('linux installer installs mime package', script.includes('INSTALL_MIME_PACKAGE'));
  assert('linux installer installs mime icons', script.includes('install_mime_icon 256'));
  assert('linux installer refreshes mime database', script.includes('update-mime-database'));
  assert('linux installer registers both mime icon names', script.includes('text-x-markdown'));
}

console.log(`\n${'='.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log('All build-assets tests passed.');
