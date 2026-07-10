// Tool-NAME aliasing — the sibling of paramRemap's synonym keys. Local
// models are trained on Claude Code / OpenHands / Cursor transcripts and
// reproduce those catalogs' tool names from muscle memory (observed live:
// llama3.2 emitted `create_file` — not in SideCar's catalog — mid-run).
// Bouncing with "Unknown tool" wastes an iteration the model often can't
// recover; the intent is unambiguous, so resolve it deterministically and
// disclose the canonical name in the result.
//
// Safety: resolution happens BEFORE permission/approval checks, so an
// aliased call inherits the canonical tool's gates (create_file gets
// write_file's approval semantics). Only names with a single obvious
// SideCar equivalent belong here — anything ambiguous stays unknown.

const TOOL_NAME_ALIASES: Record<string, string> = {
  // write_file
  create_file: 'write_file',
  new_file: 'write_file',
  save_file: 'write_file',
  // edit_file
  str_replace: 'edit_file',
  str_replace_editor: 'edit_file',
  replace_in_file: 'edit_file',
  modify_file: 'edit_file',
  // read_file
  cat: 'read_file',
  open_file: 'read_file',
  view_file: 'read_file',
  // run_command
  bash: 'run_command',
  shell: 'run_command',
  execute_command: 'run_command',
  exec: 'run_command',
  terminal: 'run_command',
  // list_directory
  ls: 'list_directory',
  list_files: 'list_directory',
  list_dir: 'list_directory',
  // delete_file
  remove_file: 'delete_file',
  rm: 'delete_file',
};

/** Canonical SideCar tool name for a known foreign alias, or null. */
export function resolveToolNameAlias(name: string): string | null {
  return TOOL_NAME_ALIASES[name] ?? null;
}
