import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { LINUX_DESKTOP_FILE, removeLinuxMarkdownMimeDefaults } from './linux-mime';
import type { AppInfo, FileAssociationResult, FileAssociationStatus, UpdateCheckResult } from '@shared/contracts';

const execFileAsync = promisify(execFile);
const GITHUB_REPO = 'BruceCui7193/markdown-editor-pro';
const WINDOWS_PROG_ID = 'MarkdownEditorPro.md';

export function getAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  };
}

function compareVersions(left: string, right: string): number {
  const normalize = (value: string) =>
    value
      .replace(/^v/i, '')
      .split(/[-+.]/)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = normalize(left);
  const b = normalize(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export async function checkForUpdates(
  includePrerelease: boolean,
): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'markdown-editor-pro',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }

    const releases = (await response.json()) as Array<{
      draft?: boolean;
      prerelease?: boolean;
      tag_name?: string;
      html_url?: string;
    }>;
    const latest = releases.find(
      (release) => !release.draft && (includePrerelease || !release.prerelease),
    );
    const latestVersion = latest?.tag_name?.replace(/^v/i, '') ?? currentVersion;
    const hasUpdate = Boolean(latest && compareVersions(latestVersion, currentVersion) > 0);
    return {
      currentVersion,
      latestVersion,
      releaseUrl: latest?.html_url ?? null,
      hasUpdate,
    };
  } catch (error) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      releaseUrl: null,
      hasUpdate: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getLinuxMimeDefault(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xdg-mime', ['query', 'default', 'text/markdown']);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function writeLinuxMimeDefault(enabled: boolean, desktopFile = LINUX_DESKTOP_FILE): Promise<void> {
  const configPath = path.join(os.homedir(), '.config', 'mimeapps.list');
  let content = '';
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    // A missing file is fine; we create it below.
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sectionIndex = lines.findIndex((line) => line.trim() === '[Default Applications]');
  const nextSectionIndex = lines.findIndex(
    (line, index) => index > (sectionIndex >= 0 ? sectionIndex : -1) && /^\[/.test(line.trim()),
  );
  const bodyEnd = nextSectionIndex >= 0 ? nextSectionIndex : lines.length;
  const body = lines.slice(sectionIndex >= 0 ? sectionIndex + 1 : bodyEnd, bodyEnd);
  const withoutMarkdown = body.filter(
    (line) => !line.startsWith('text/markdown=') && !line.startsWith('application/x-markdown='),
  );
  const newBody = enabled
    ? [`text/markdown=${desktopFile}`, ...withoutMarkdown]
    : withoutMarkdown;
  const head = sectionIndex >= 0 ? lines.slice(0, sectionIndex) : lines.slice(0, bodyEnd);
  const tail = lines.slice(bodyEnd);
  const header = sectionIndex >= 0 ? [] : ['[Default Applications]'];
  const next = [head.filter((line) => line.trim() !== ''), header, newBody, tail]
    .flat()
    .filter((line, index, array) => !(index > 0 && line === '' && array[index - 1] === ''))
    .join('\n');

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}

async function getWindowsAssociationStatus(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      'HKCU\\Software\\Classes\\.md',
      '/ve',
    ]);
    return stdout.includes(WINDOWS_PROG_ID);
  } catch {
    return false;
  }
}

async function setWindowsAssociation(enabled: boolean): Promise<void> {
  const command = `"${process.execPath}" "%1"`;
  if (enabled) {
    for (const extension of ['.md', '.markdown']) {
      await execFileAsync('reg', [
        'add',
        `HKCU\\Software\\Classes\\${extension}`,
        '/ve',
        '/d',
        WINDOWS_PROG_ID,
        '/f',
      ]);
    }
    await execFileAsync('reg', [
      'add',
      `HKCU\\Software\\Classes\\${WINDOWS_PROG_ID}\\shell\\open\\command`,
      '/ve',
      '/d',
      command,
      '/f',
    ]);
    return;
  }

  for (const key of ['.md', '.markdown', WINDOWS_PROG_ID]) {
    await execFileAsync('reg', ['delete', `HKCU\\Software\\Classes\\${key}`, '/f']);
  }
}


export async function getFileAssociationStatus(): Promise<FileAssociationStatus> {
  const platform = process.platform;
  if (platform === 'linux') {
    const current = await getLinuxMimeDefault();
    return {
      platform,
      supported: true,
      associated: current === LINUX_DESKTOP_FILE,
    };
  }
  if (platform === 'win32') {
    return {
      platform,
      supported: true,
      associated: await getWindowsAssociationStatus(),
    };
  }
  return { platform, supported: false, associated: false };
}

export async function setFileAssociation(enabled: boolean): Promise<FileAssociationResult> {
  const platform = process.platform;
  try {
    if (platform === 'linux') {
      if (enabled) {
        await writeLinuxMimeDefault(true);
        try {
          await execFileAsync('xdg-mime', ['default', LINUX_DESKTOP_FILE, 'text/markdown']);
        } catch {
          // The direct mimeapps.list write is still valid on minimal systems.
        }
      } else {
        await removeLinuxMarkdownMimeDefaults();
      }
      return { ok: true, supported: true, platform, message: 'ok' };
    }
    if (platform === 'win32') {
      await setWindowsAssociation(enabled);
      return { ok: true, supported: true, platform, message: 'ok' };
    }
    return { ok: false, supported: false, platform, message: 'unsupported' };
  } catch (error) {
    return {
      ok: false,
      supported: true,
      platform,
      message: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
