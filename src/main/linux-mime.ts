import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LINUX_DESKTOP_FILE = 'markdown-editor-pro.desktop';

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
