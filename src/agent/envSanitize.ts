/**
 * Strip control characters from an environment variable value to prevent
 * injection via terminal escape sequences or null-byte attacks.
 *
 * Preserves \n and \r (legitimate in multi-line values like PEM certificates).
 * This is extracted from EventHookManager.sanitizeEnvValue() so both hook systems
 * (per-tool hooks + file-event hooks) use the same function.
 */
export function sanitizeEnvValue(value: string): string {
  // Remove null bytes (\x00) and most control characters (\x01–\x1f except \x09 tab, \x0a LF, \x0d CR), plus DEL (\x7f)
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
