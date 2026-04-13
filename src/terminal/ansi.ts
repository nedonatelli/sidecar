// ---------------------------------------------------------------------------
// ANSI escape-sequence stripping — shared between the terminal error
// watcher and the persistent shell session so both produce clean,
// plain-text output for the agent/log sinks.
//
// Covers:
//   - CSI sequences:   ESC [ ... <final>   (colors, cursor motion, SGR)
//   - OSC sequences:   ESC ] ... BEL/ST    (window title, hyperlinks)
//   - Two-byte Fp/Fs:  ESC <single byte>   (DECKPAM, DECKPNM, DECSC, DECRC)
//
// Cycle-2 audit: shell output previously reached the agent context and
// audit log with raw escape sequences. This bloats token counts, can
// corrupt downstream rendering, and leaks terminal-state instructions
// into the LLM's view of tool output.
// ---------------------------------------------------------------------------

const CSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const FP_FS_RE = /\x1B[0-?@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(CSI_RE, '').replace(OSC_RE, '').replace(FP_FS_RE, '');
}
