import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('statistics local calendar boundaries', () => {
  it.each([
    ['UTC', '2026-03-10T16:00:00Z', ['2026-03-10T00:00:00Z', '2026-03-04T00:00:00Z', '2026-02-09T00:00:00Z']],
    ['America/New_York', '2026-03-10T16:00:00Z', ['2026-03-10T04:00:00Z', '2026-03-04T05:00:00Z', '2026-02-09T05:00:00Z']],
    ['America/Sao_Paulo', '2018-11-04T15:00:00Z', ['2018-11-04T03:00:00Z', '2018-10-29T03:00:00Z', '2018-10-06T03:00:00Z']],
  ] as const)('uses %s local midnight and accounts for daylight saving changes', async (zone, timestamp, starts) => {
    const source = await readFile('src/shared/statisticsPeriod.ts', 'utf8');
    const compiled = await transform(source, { loader: 'ts', format: 'esm' });
    const now = Date.parse(timestamp);
    const script = `${compiled.code}\nprocess.stdout.write(JSON.stringify(['today','7d','30d','all'].map(period => statisticsPeriodBounds(period, ${now}))));`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: zone },
    });
    expect(JSON.parse(result.stdout)).toEqual([
      ...starts.map((start) => ({ dateFrom: Date.parse(start) / 1000, dateTo: now / 1000 })), {},
    ]);
  });
});
