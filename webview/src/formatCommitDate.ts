let commitDateFormatter: Intl.DateTimeFormat | undefined;

export function formatCommitDate(timestamp: number): string {
  if (!timestamp) return '';
  commitDateFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return commitDateFormatter.format(new Date(timestamp * 1000));
}
