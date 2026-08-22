import {
  acquireExclusiveBenchmarkRun,
  type ExclusiveRunHandle,
} from '../../benchmark/exclusive-run';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForExclusiveBenchmarkLock(
  timeoutMs = 180_000,
): Promise<ExclusiveRunHandle> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await acquireExclusiveBenchmarkRun();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes('marivell-benchmark.lock') &&
        !message.includes('held by PID') &&
        !message.includes('Only one marivell Electron performance task')
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for exclusive benchmark lock: ${message}`);
      }
      await wait(2_000);
    }
  }
}
