// The status bar's wording (CO-6): how long ago, and the version and build.
// Kept apart from the screens, so it needs nothing but the build constants.

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago" (CO-6). */
export function formatAgo(value: string | Date, now: Date = new Date()): string {
  const then = typeof value === 'string' ? new Date(value) : value;
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/** "v0.1.0 · build 6035081, Oct 30", and the full build for the tooltip. */
export function versionText(version = __APP_VERSION__, build = __APP_BUILD__) {
  const [commit, day] = build.split(' ');
  const date = day
    ? new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  return {
    short: `v${version} · build ${commit}${date ? `, ${date}` : ''}`,
    title: `kmezBooks ${version}, built from commit ${commit}${day ? ` on ${day}` : ''}`,
  };
}

/**
 * The window title (CO-2). A browser tab gets "Acme LLC – kmezBooks", company
 * first so a narrow tab still shows it. The installed app gets just "Acme LLC":
 * Chrome puts "kmezBooks - " in front of any title that doesn't start with the
 * app's name, so its title bar reads "kmezBooks - Acme LLC".
 */
export function windowTitle(legalName: string | null | undefined, installed = false): string {
  const name = legalName?.trim();
  if (!name) return 'kmezBooks';
  return installed ? name : `${name} – kmezBooks`;
}
