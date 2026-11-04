import type { StatisticsPeriod } from './models';

/** Local calendar days, including today; All has no date bounds. */
export function statisticsPeriodBounds(
  period: StatisticsPeriod,
  now = Date.now(),
): {
  dateFrom?: number;
  dateTo?: number;
} {
  if (period === 'all') return {};
  const dateTo = Math.floor(now / 1000);
  const start = new Date(now);
  const days = period === 'today' ? 1 : period === '7d' ? 7 : 30;
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  return { dateFrom: Math.floor(start.getTime() / 1000), dateTo };
}
