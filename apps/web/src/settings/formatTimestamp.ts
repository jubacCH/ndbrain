/** Formats an ISO timestamp string for display in the keys/audit tables. Returns
 *  `fallback` for null/empty/unparsable input instead of rendering "Invalid Date". */
export function formatTimestamp(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}
