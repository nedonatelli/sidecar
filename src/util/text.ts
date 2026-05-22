/**
 * Strip a surrounding Markdown code fence from a string, if present.
 * Handles optional language tags (e.g. ```typescript) and optional
 * trailing whitespace after the closing fence.
 *
 * Returns the string unchanged when no fence is detected.
 */
export function stripCodeFences(text: string): string {
  return text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
}
