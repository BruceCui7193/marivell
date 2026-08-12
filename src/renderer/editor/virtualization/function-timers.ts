// Benchmark-gated function-level timing instrumentation for D10 attribution.
// Only active when window.markdownEditor?.getBenchmarkEnabled?.() is true.

type TimerEntry = {
  name: string;
  total: number;
  max: number;
  count: number;
};

type ActiveTimer = {
  name: string;
  start: number;
};

const functionTimers = new Map<string, TimerEntry>();
const activeTimers = new Map<string, ActiveTimer>();

function isBenchmarkEnabled(): boolean {
  try {
    return (window as unknown as { markdownEditor?: { getBenchmarkEnabled?: () => boolean } })
      .markdownEditor?.getBenchmarkEnabled?.() === true;
  } catch {
    return false;
  }
}

export function startFunctionTimer(name: string): void {
  if (!isBenchmarkEnabled()) return;
  const entry = functionTimers.get(name) ?? { name, total: 0, max: 0, count: 0 };
  functionTimers.set(name, entry);
  activeTimers.set(name, { name, start: performance.now() });
}

export function endFunctionTimer(name: string): number {
  if (!isBenchmarkEnabled()) return 0;
  const active = activeTimers.get(name);
  if (!active) return 0;
  activeTimers.delete(name);
  const duration = performance.now() - active.start;
  const entry = functionTimers.get(name);
  if (entry) {
    entry.total += duration;
    entry.max = Math.max(entry.max, duration);
    entry.count += 1;
  }
  return duration;
}

export function functionTimerWrap<T>(name: string, fn: () => T): T {
  startFunctionTimer(name);
  try {
    return fn();
  } finally {
    endFunctionTimer(name);
  }
}

export function getAndResetFunctionTimings(): TimerEntry[] {
  const entries = Array.from(functionTimers.values()).map((e) => ({ ...e }));
  functionTimers.clear();
  return entries;
}

export function getFunctionTimingsForAttribution(): Record<string, { totalMs: number; maxMs: number; count: number }> {
  const result: Record<string, { totalMs: number; maxMs: number; count: number }> = {};
  for (const entry of functionTimers.values()) {
    result[entry.name] = {
      totalMs: Math.round(entry.total * 1000) / 1000,
      maxMs: Math.round(entry.max * 1000) / 1000,
      count: entry.count,
    };
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__marivellFunctionTimings = getFunctionTimingsForAttribution;
  (window as unknown as Record<string, unknown>).__marivellResetFunctionTimings = () => {
    functionTimers.clear();
    activeTimers.clear();
  };
}
