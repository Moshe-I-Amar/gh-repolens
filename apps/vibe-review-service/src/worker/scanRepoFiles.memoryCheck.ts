import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanRepoFiles } from './reviewRunner';

const FILE_COUNT = 240;
const FILE_BYTES = 10_000;
const ITERATIONS = 6;

const makeContent = (size: number) => {
  const line = 'export const value = "abcdefghijklmnopqrstuvwxyz";\n';
  const repeats = Math.max(1, Math.floor(size / line.length));
  return line.repeat(repeats);
};

const run = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scan-memory-check-'));
  try {
    for (let index = 0; index < FILE_COUNT; index += 1) {
      const relative = `src/module-${String(index).padStart(3, '0')}.ts`;
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, makeContent(FILE_BYTES), 'utf8');
    }

    const runOptimized = async () => {
      const started = process.hrtime.bigint();
      const result = await scanRepoFiles(root, { maxFiles: FILE_COUNT, includeDeprioritized: true });
      const ended = process.hrtime.bigint();
      return {
        durationMs: Number(ended - started) / 1_000_000,
        files: result.files.length,
      };
    };

    const runLegacySimulated = async () => {
      const started = process.hrtime.bigint();
      const result = await scanRepoFiles(root, { maxFiles: FILE_COUNT, includeDeprioritized: true });
      const legacy = result.files.map((file) => ({
        path: file.path,
        content: file.content,
        lines: file.content.split(/\r?\n/),
      }));
      const ended = process.hrtime.bigint();
      return {
        durationMs: Number(ended - started) / 1_000_000,
        files: legacy.length,
      };
    };

    const median = (values: number[]) => {
      const sorted = values.slice().sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        const left = sorted[middle - 1] ?? sorted[middle] ?? 0;
        const right = sorted[middle] ?? left;
        return (left + right) / 2;
      }
      return sorted[middle] ?? 0;
    };

    const optimizedDurations: number[] = [];
    const legacyDurations: number[] = [];

    // Warm-up to reduce first-run noise.
    await runOptimized();
    await runLegacySimulated();

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      if (iteration % 2 === 0) {
        legacyDurations.push((await runLegacySimulated()).durationMs);
        optimizedDurations.push((await runOptimized()).durationMs);
      } else {
        optimizedDurations.push((await runOptimized()).durationMs);
        legacyDurations.push((await runLegacySimulated()).durationMs);
      }
    }

    global.gc?.();
    const beforeOptimizedHeap = process.memoryUsage().heapUsed;
    const optimizedSingle = await runOptimized();
    const afterOptimizedHeap = process.memoryUsage().heapUsed;

    global.gc?.();
    const beforeLegacyHeap = process.memoryUsage().heapUsed;
    const legacySingle = await runLegacySimulated();
    const afterLegacyHeap = process.memoryUsage().heapUsed;

    const optimizedMs = median(optimizedDurations);
    const legacyMs = median(legacyDurations);
    const optimizedHeapMb = (afterOptimizedHeap - beforeOptimizedHeap) / (1024 * 1024);
    const legacyHeapMb = (afterLegacyHeap - beforeLegacyHeap) / (1024 * 1024);
    const runtimeDeltaPct = legacyMs > 0 ? ((optimizedMs - legacyMs) / legacyMs) * 100 : 0;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          optimized: {
            files: optimizedSingle.files,
            durationMs: Number(optimizedMs.toFixed(2)),
            heapDeltaMb: Number(optimizedHeapMb.toFixed(2)),
          },
          legacySimulated: {
            files: legacySingle.files,
            durationMs: Number(legacyMs.toFixed(2)),
            heapDeltaMb: Number(legacyHeapMb.toFixed(2)),
          },
          runtimeDeltaPct: Number(runtimeDeltaPct.toFixed(2)),
          runtimeRegressionWithin5Pct: runtimeDeltaPct <= 5,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

void run();
