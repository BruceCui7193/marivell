import { app } from 'electron';
import type { AppInfo, UpdateCheckResult } from '@shared/contracts';

const GITHUB_REPO = 'BruceCui7193/markdown-editor-pro';

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
