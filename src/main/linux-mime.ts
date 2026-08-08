import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LINUX_DESKTOP_FILE = 'markdown-editor-pro.desktop';

export function getLinuxMimeConfigPaths(): string[] {
  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return [
    path.join(configHome, 'mimeapps.list'),
    path.join(dataHome, 'applications', 'mimeapps.list'),
    path.join(dataHome, 'applications', 'defaults.list'),
  ];
}

export function removeMarkdownMimeEntries(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const filtered = lines.filter(
    (line) => !/^(?:text\/markdown|application\/x-markdown)=/.test(line.trim()),
  );
  const next = `${filtered.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
  return next === content ? content : next;
}

export async function removeLinuxMarkdownMimeDefaults(): Promise<string[]> {
  const touched: string[] = [];
  for (const configPath of getLinuxMimeConfigPaths()) {
    let content = '';
    try {
      content = await fs.readFile(configPath, 'utf8');
    } catch {
      continue;
    }
    const next = removeMarkdownMimeEntries(content);
    if (next === content) {
      continue;
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, next, 'utf8');
    touched.push(configPath);
  }
  return touched;
}

export async function getLinuxFallbackDefault(
  desktopDirs: string[] = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
  ],
): Promise<string> {
  const candidates: string[] = [];
  for (const dir of desktopDirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.desktop') || entry === LINUX_DESKTOP_FILE) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(dir, entry), 'utf8');
        if (/MimeType\s*=.*text\/markdown/i.test(content)) {
          candidates.push(entry);
        }
      } catch {
        // Ignore unreadable or stale desktop entries.
      }
    }
  }
  return (
    candidates.find((name) => name.startsWith('org.gnome.TextEditor')) ||
    candidates.find((name) => name.includes('typora')) ||
    candidates[0] ||
    ''
  );
}
