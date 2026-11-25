import { APP_LABEL, belongsTo, mergeByName } from './everestoK8s';

describe('everestoK8s app lookup', () => {
  it('finds single-container apps by app=<repo> and multi-service apps by everesto.live/app=<repo>', () => {
    expect(belongsTo({ app: 'python-backend' }, 'python-backend')).toBe(true);
    expect(belongsTo({ app: 'edge-gateway', [APP_LABEL]: 'agency-backend' }, 'agency-backend')).toBe(true);
    expect(belongsTo({ app: 'edge-gateway' }, 'agency-backend')).toBe(false);
    expect(belongsTo({ [APP_LABEL]: 'other' }, 'agency-backend')).toBe(false);
    expect(belongsTo(undefined, 'agency-backend')).toBe(false);
  });

  it('merges the two label queries by name', () => {
    const a = { items: [{ metadata: { name: 'x' } }, { metadata: { name: 'y' } }] };
    const b = { items: [{ metadata: { name: 'y' } }, { metadata: { name: 'z' } }] };
    expect(mergeByName(a, b)!.items.map(o => o.metadata.name)).toEqual(['x', 'y', 'z']);
    expect(mergeByName(undefined, b)!.items).toHaveLength(2);
    expect(mergeByName(undefined, undefined)).toBeUndefined(); // not readable at all
  });
});

import { describeCron, nextCronRun, scheduledJobs } from './everestoK8s';

describe('scheduled jobs', () => {
  const at = new Date('2026-11-25T10:07:30Z'); // a Wednesday

  it('computes the next run of standard cron schedules (UTC)', () => {
    expect(nextCronRun('*/2 * * * *', at)!.toISOString()).toBe('2026-11-25T10:08:00.000Z');
    expect(nextCronRun('5 * * * *', at)!.toISOString()).toBe('2026-11-25T11:05:00.000Z');
    expect(nextCronRun('30 3 * * *', at)!.toISOString()).toBe('2026-11-26T03:30:00.000Z');
    expect(nextCronRun('15 4 * * 1', at)!.toISOString()).toBe('2026-11-30T04:15:00.000Z'); // next Monday
    expect(nextCronRun('@weekly', at)).toBeUndefined();
  });

  it('describes schedules in plain words', () => {
    expect(describeCron('*/2 * * * *')).toBe('every 2 min');
    expect(describeCron('20 * * * *')).toBe('hourly at :20');
    expect(describeCron('30 3 * * *')).toBe('daily 03:30 UTC');
    expect(describeCron('15 4 * * 1')).toBe('Mondays 04:15 UTC');
    expect(describeCron('0 0 1 * *')).toBe('0 0 1 * *');
  });

  it('groups jobs under their CronJob with status, duration and the pod for logs', () => {
    const cron = [{ metadata: { name: 'agency-experiments' }, spec: { schedule: '*/2 * * * *' },
      status: { lastScheduleTime: '2026-11-25T10:06:00Z', lastSuccessfulTime: '2026-11-25T10:06:20Z', active: [] } }];
    const owned = (name: string, status: any) => ({ metadata: { name, ownerReferences: [{ kind: 'CronJob', name: 'agency-experiments' }] }, status });
    const jobs = [
      owned('agency-experiments-1', { startTime: '2026-11-25T10:04:00Z', completionTime: '2026-11-25T10:04:12Z', succeeded: 1 }),
      owned('agency-experiments-2', { startTime: '2026-11-25T10:06:00Z', conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-25T10:06:30Z' }] }),
      { metadata: { name: 'agency-migrate' }, status: { startTime: '2026-11-25T09:00:00Z', completionTime: '2026-11-25T09:00:09Z', succeeded: 1 } },
    ];
    const pods = [{ metadata: { name: 'agency-experiments-2-abc', creationTimestamp: '2026-11-25T10:06:00Z', labels: { 'job-name': 'agency-experiments-2' } } }];
    const out = scheduledJobs(cron, jobs, pods, at);
    const c = out.cronJobs[0];
    expect(c.scheduleText).toBe('every 2 min');
    expect(c.nextRunInSec).toBe(30);
    expect(c.runs.map(r => [r.name, r.status, r.durationSec, r.pod])).toEqual([
      ['agency-experiments-2', 'failed', 30, 'agency-experiments-2-abc'],
      ['agency-experiments-1', 'succeeded', 12, undefined],
    ]);
    expect(out.oneOffJobs.map(j => j.name)).toEqual(['agency-migrate']);
  });
});
