import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  ARGON2_POLICY,
  PASSWORD_CONCURRENCY_LIMITS,
  PasswordCapacityError,
  createPasswordService,
} from '../src/modules/auth/password/index.js';

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function main(): Promise<void> {
  const cpus = os.cpus();
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;

  const sampleRss = () => {
    const current = process.memoryUsage().rss;
    if (current > peakRss) {
      peakRss = current;
    }
  };

  console.log('=== P2-AUTH-03a Argon2id Bounded Benchmark ===');
  console.log(
    `Machine: ${os.platform()} ${os.arch()}, CPU: ${cpus[0]?.model ?? 'unknown'} (${cpus.length} cores), Total RAM: ${(os.totalmem() / 1024 ** 3).toFixed(2)} GiB, Node: ${process.version}`
  );
  console.log(
    `Policy: Argon2id m=${ARGON2_POLICY.memoryCostKiB} KiB, t=${ARGON2_POLICY.timeCost}, p=${ARGON2_POLICY.parallelism}, maxConcurrent=${PASSWORD_CONCURRENCY_LIMITS.maxConcurrent}, maxQueue=${PASSWORD_CONCURRENCY_LIMITS.maxQueueSize}, queueTimeoutMs=${PASSWORD_CONCURRENCY_LIMITS.queueTimeoutMs}`
  );
  console.log(`Baseline RSS: ${mb(baselineRss)}`);

  const service = createPasswordService();
  const testPassword = 'Benchmark-Password-2026-Roundset!';

  // 1. Sequential hash latency (5 runs)
  const hashTimes: number[] = [];
  let sampleHash = '';
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    sampleHash = await service.hashPassword(testPassword);
    hashTimes.push(performance.now() - t0);
    sampleRss();
  }

  // 2. Sequential verify latency (5 runs)
  const verifyTimes: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    await service.verifyPassword(testPassword, sampleHash);
    verifyTimes.push(performance.now() - t0);
    sampleRss();
  }

  // 3. Concurrent workload: 10 admitted (2 active + 8 queued) + 11th overflow
  const rssTicker = setInterval(sampleRss, 10);
  const tConcStart = performance.now();
  const concurrentTasks = Array.from({ length: 11 }, (_, idx) =>
    service
      .verifyPassword(testPassword, sampleHash)
      .then((ok) => ({ idx, status: 'ok' as const, ok }))
      .catch((err: unknown) => ({
        idx,
        status: 'rejected' as const,
        reason: err instanceof PasswordCapacityError ? err.reason : 'OTHER',
      }))
  );
  const results = await Promise.all(concurrentTasks);
  const concurrentDurationMs = performance.now() - tConcStart;
  clearInterval(rssTicker);
  sampleRss();

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const succeeded = results.filter((r) => r.status === 'ok').length;
  const rejectedQueueFull = results.filter(
    (r) => r.status === 'rejected' && r.reason === 'QUEUE_FULL'
  ).length;

  console.log(
    `Hash latency (5 sequential): avg=${avg(hashTimes).toFixed(1)} ms, min=${Math.min(...hashTimes).toFixed(1)} ms, max=${Math.max(...hashTimes).toFixed(1)} ms`
  );
  console.log(
    `Verify latency (5 sequential): avg=${avg(verifyTimes).toFixed(1)} ms, min=${Math.min(...verifyTimes).toFixed(1)} ms, max=${Math.max(...verifyTimes).toFixed(1)} ms`
  );
  console.log(
    `Concurrent burst (11 requests): succeeded=${succeeded}/11, rejected_QUEUE_FULL=${rejectedQueueFull}/11, totalWallMs=${concurrentDurationMs.toFixed(1)} ms`
  );
  console.log(`Peak RSS observed: ${mb(peakRss)} (delta +${mb(peakRss - baselineRss)})`);
  console.log(
    'Note: Local MacBook measurements do NOT prove Render Free (512 MiB) deployment feasibility.'
  );
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
