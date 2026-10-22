/**
 * Prefix on a streamed tool-output chunk that carries a diff for the chat view
 * to render. It travels only on the `onOutput` side channel: the tool's own
 * result describes the change separately. A consumer that forwards streamed
 * output anywhere else (a calling model, a log) must drop or strip these
 * chunks — `sidecar_edit_file` over the LM tool API returned the raw marker to
 * the calling model (#165 ML-55).
 */
export const DIFF_STREAM_PREFIX = '\x00diff\x00';
