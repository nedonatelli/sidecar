/**
 * Minimal HTML escaping for inline string interpolation into HTML templates.
 * Handles the four characters that must be escaped in attribute values and
 * element content: &, <, >, ".
 */
export function escHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Decode common HTML entities in text extracted from HTML documents.
 * Covers the standard named entities plus the two apostrophe numeric forms.
 */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
