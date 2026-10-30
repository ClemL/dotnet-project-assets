// Changelog entries (public/updates.txt) and the footer's build-info line.

/**
 * Splits the changelog file into entries: one per non-blank line, trimmed, in file order (oldest
 * first). Accepts LF and CRLF line endings.
 */
export function parseChangelog(text: string): string[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** "<App> · v<version> · built <time>", without the "built" part when the build time is empty. */
export function buildInfoLine(appName: string, version: string, buildTime: string): string {
  return `${appName} · v${version}${buildTime ? ` · built ${buildTime}` : ''}`;
}
