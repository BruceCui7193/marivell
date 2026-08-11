import {
  runDomInjectionPocE2E,
  type DomInjectionE2EResult,
} from '../benchmark/dom-injection-poc.ts';

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
  failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function waitUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; label: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = waitUnref(timeoutMs).then(() => ({ ok: false as const, label }));
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function main(): Promise<void> {
  console.log('\n## D2 formula DOM injection PoC e2e');
  const run = await withTimeout(runDomInjectionPocE2E(), 300_000, 'dom-injection-poc');
  assert('D2 PoC completes on a real Electron renderer', run.ok, run.ok ? '' : run.label);
  if (!run.ok) {
    failed += 1;
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const result: DomInjectionE2EResult = run.value;
  const corpus = result.corpus;

  console.log(
    `  corpus=${corpus.selected} inline=${corpus.inline} block=${corpus.block} quartiles=${corpus.quartileCounts.join('/')}`,
  );
  console.log(
    `  one-shot innerHTML p50/p95=${result.page.methods.find((method) => method.method === 'innerHTML')?.oneShot.ms.p50.toFixed(3)}/${result.page.methods.find((method) => method.method === 'innerHTML')?.oneShot.ms.p95.toFixed(3)}ms`,
  );
  console.log(
    `  reactivation innerHTML p50/p95=${result.page.methods.find((method) => method.method === 'innerHTML')?.reactivation.ms.p50.toFixed(3)}/${result.page.methods.find((method) => method.method === 'innerHTML')?.reactivation.ms.p95.toFixed(3)}ms`,
  );

  assert('corpus has at least 200 layered real formulas', corpus.selected >= 200, JSON.stringify(corpus));
  assert('corpus balances inline and block formulas', corpus.inline >= 80 && corpus.block >= 80, JSON.stringify(corpus));
  assert('corpus covers every HTML-size quartile', corpus.quartileCounts.every((count) => count >= 20), JSON.stringify(corpus.quartileCounts));
  assert(
    'heap API records a session delta',
    result.page.environment.heapApi.available &&
      typeof result.page.environment.heapApi.delta === 'number',
    JSON.stringify(result.page.environment.heapApi),
  );

  const methods = result.page.methods;
  const requiredMethods = [
    'innerHTML',
    'insert-adjacent-html',
    'template-clone',
    'range-contextual-fragment',
    'json-create-element',
    'json-create-element-fragment',
  ];
  for (const methodName of requiredMethods) {
    const method = methods.find((candidate) => candidate.method === methodName);
    assert(`${methodName} ran with 20 measured one-shot samples`, method?.supported && method.oneShot.samples.length === 20, JSON.stringify(method));
    assert(`${methodName} ran with 20 measured reactivation samples`, method?.supported && method.reactivation.samples.length === 20, JSON.stringify(method));
  }

  const setHTMLUnsafe = methods.find((method) => method.method === 'set-html-unsafe');
  assert(
    'setHTMLUnsafe is either supported or explicitly skipped',
    Boolean(setHTMLUnsafe && (setHTMLUnsafe.supported || setHTMLUnsafe.skipReason)),
    JSON.stringify(setHTMLUnsafe),
  );

  for (const method of methods) {
    if (!method.supported) {
      continue;
    }
    assert(
      `${method.method} reactivation uses at least 10 rounds per sample`,
      method.reactivation.samples.every(
        (sample) => (sample.perRoundMs?.length ?? 0) >= 10,
      ),
      JSON.stringify(method.reactivation.samples[0]),
    );
    assert(
      `${method.method} one-shot inserts the full corpus`,
      method.oneShot.samples.every(
        (sample) => sample.insertedNodes >= corpus.selected,
      ),
      JSON.stringify(method.oneShot.samples[0]),
    );
    assert(
      `${method.method} reactivation inserts the corpus every round`,
      method.reactivation.samples.every(
        (sample) => sample.insertedNodes >= corpus.selected * 10,
      ),
      JSON.stringify(method.reactivation.samples[0]),
    );
    assert(
      `${method.method} produces DOM mutations`,
      method.oneShot.samples.every((sample) => sample.domMutations > 0) &&
        method.reactivation.samples.every((sample) => sample.domMutations > 0),
      'dom mutations missing',
    );
    assert(
      `${method.method} reactivation removes DOM nodes between reinserts`,
      method.reactivation.samples.every((sample) => sample.removedNodes > 0),
      'removal mutations missing',
    );
    assert(
      `${method.method} reports positive injection time`,
      method.oneShot.ms.count === 20 &&
        method.oneShot.ms.p50 > 0 &&
        method.reactivation.ms.p50 > 0,
      JSON.stringify(method.oneShot.ms),
    );
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
