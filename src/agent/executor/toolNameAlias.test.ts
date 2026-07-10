import { describe, it, expect } from 'vitest';
import { resolveToolNameAlias } from './toolNameAlias.js';

describe('resolveToolNameAlias', () => {
  it('maps foreign catalog names onto SideCar equivalents', () => {
    expect(resolveToolNameAlias('create_file')).toBe('write_file');
    expect(resolveToolNameAlias('str_replace_editor')).toBe('edit_file');
    expect(resolveToolNameAlias('bash')).toBe('run_command');
    expect(resolveToolNameAlias('ls')).toBe('list_directory');
    expect(resolveToolNameAlias('cat')).toBe('read_file');
    expect(resolveToolNameAlias('rm')).toBe('delete_file');
  });

  it('returns null for canonical SideCar names (never remaps a real tool)', () => {
    expect(resolveToolNameAlias('write_file')).toBeNull();
    expect(resolveToolNameAlias('edit_file')).toBeNull();
    expect(resolveToolNameAlias('run_command')).toBeNull();
  });

  it('returns null for unknown names', () => {
    expect(resolveToolNameAlias('summon_daemon')).toBeNull();
    expect(resolveToolNameAlias('')).toBeNull();
  });

  it('maps the COMPLETE alias table exactly (mutation-tested — every entry pinned)', () => {
    // Exhaustive: a mutated or dropped table entry must fail here, not survive
    // because only a sample was checked (Stryker: 14/23 mutants survived the
    // spot-check version of this suite).
    const table: Record<string, string> = {
      create_file: 'write_file',
      new_file: 'write_file',
      save_file: 'write_file',
      str_replace: 'edit_file',
      str_replace_editor: 'edit_file',
      replace_in_file: 'edit_file',
      modify_file: 'edit_file',
      cat: 'read_file',
      open_file: 'read_file',
      view_file: 'read_file',
      bash: 'run_command',
      shell: 'run_command',
      execute_command: 'run_command',
      exec: 'run_command',
      terminal: 'run_command',
      ls: 'list_directory',
      list_files: 'list_directory',
      list_dir: 'list_directory',
      remove_file: 'delete_file',
      rm: 'delete_file',
    };
    for (const [alias, canonical] of Object.entries(table)) {
      expect(resolveToolNameAlias(alias), alias).toBe(canonical);
    }
  });

  it('every canonical target is a real SideCar tool (never alias→alias or alias→typo)', () => {
    const realTools = new Set(['write_file', 'edit_file', 'read_file', 'run_command', 'list_directory', 'delete_file']);
    for (const alias of ['create_file', 'str_replace', 'cat', 'bash', 'ls', 'rm']) {
      const target = resolveToolNameAlias(alias);
      expect(target && realTools.has(target), `${alias} → ${target}`).toBe(true);
    }
  });
});
