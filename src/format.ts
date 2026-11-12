/** Format an integer NOK amount as "kr 9 171" (space-grouped thousands). */
export function formatKr(n: number): string {
  const sign = n < 0 ? '-' : '';
  const grouped = Math.round(Math.abs(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `kr ${sign}${grouped}`;
}

function cell(v: string | number | null | undefined): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Build a markdown table from headers and rows. */
export function markdownTable(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Render a warnings block; empty string when there are no warnings. */
export function warningsBlock(warnings: string[] | undefined): string {
  if (!warnings?.length) return '';
  return ['**Warnings**', ...warnings.map((w) => `- ${w}`)].join('\n');
}

/** Truncate text to max characters, appending an ellipsis marker. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
