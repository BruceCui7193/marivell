import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MARIVELL_BENCHMARK_LOCK_PATH =
  process.env.MARIVELL_BENCHMARK_LOCK_PATH ??
  path.join(os.tmpdir(), 'marivell-benchmark.lock');

const marivellTempMarkers = Array.from(
  new Set([
    path.join(os.tmpdir(), 'marivell-'),
    '/tmp/marivell-',
  ]),
);

export interface MarivellTemporaryProcess {
  pid: number;
  commandLine: string;
}

export interface ExclusiveRunHandle {
  lockPath: string;
  release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isMarivellTemporaryProcess(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase();
  if (!marivellTempMarkers.some((marker) => normalized.includes(marker.toLowerCase()))) {
    return false;
  }
  return normalized.includes('electron') || normalized.includes('node');
}

async function listMarivellTemporaryProcesses(): Promise<MarivellTemporaryProcess[]> {
  let output = '';
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    output = stdout;
  } else {
    const { stdout } = await execFileAsync(
      'ps',
      ['-axo', 'pid=,args='],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    output = stdout;
  }

  const processes: MarivellTemporaryProcess[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(\d+)\s+(.*)$/s);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const commandLine = match[2];
    if (isMarivellTemporaryProcess(commandLine)) {
      processes.push({ pid, commandLine });
    }
  }
  return processes;
}

async function assertNoMarivellTemporaryProcesses(): Promise<void> {
  const processes = await listMarivellTemporaryProcesses();
  if (processes.length === 0) {
    return;
  }
  const details = processes
    .map((process) => `  PID ${process.pid}: ${process.commandLine}`)
    .join('\n');
  throw new Error(
    `Refusing to start benchmark: found ${processes.length} marivell temporary Electron/POC process(es).\n` +
      'Wait for them to finish or clean them up before measuring performance.\n' +
      details,
  );
}

async function acquireLock(): Promise<ExclusiveRunHandle> {
  const lockPath = MARIVELL_BENCHMARK_LOCK_PATH;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return {
        lockPath,
        async release() {
          try {
            if (readLockPid(lockPath) === process.pid) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // The lock is already gone or was replaced by a newer run.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const holderPid = readLockPid(lockPath);
      if (holderPid !== null && isProcessAlive(holderPid)) {
        throw new Error(
          `Refusing to start benchmark: ${lockPath} is held by PID ${holderPid}.\n` +
            'Only one marivell Electron performance task may run at a time.\n' +
            'Wait for it to finish, or verify the PID is stale before removing the lock.',
        );
      }
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error(`Failed to acquire exclusive benchmark lock: ${lockPath}`);
}

export async function acquireExclusiveBenchmarkRun(): Promise<ExclusiveRunHandle> {
  await assertNoMarivellTemporaryProcesses();
  return acquireLock();
}
