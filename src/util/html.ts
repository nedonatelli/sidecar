/**
 * Minimal HTML escaping for inline string interpolation into HTML templates.
 * Handles the four characters that must be escaped in attribute values and
 * element content: &, <, >, ".
 */
export function escHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
