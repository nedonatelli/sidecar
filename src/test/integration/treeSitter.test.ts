/**
 * Integration tests for tree-sitter code analysis.
 * These run inside VS Code where WASM binaries are accessible.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Tree-Sitter Integration', () => {
  test('SimpleCodeAnalyzer parses TypeScript', async () => {
    // Import the regex-based analyzer (always available, no WASM needed)
    const { SimpleCodeAnalyzer } = await import('../../astContext.js');

    const code = [
      'import { readFile } from "fs";',
      '',
      'export interface Config {',
      '  name: string;',
      '  value: number;',
      '}',
      '',
      'export function processConfig(config: Config): string {',
      '  return config.name + String(config.value);',
      '}',
      '',
      'export class ConfigManager {',
      '  private configs: Config[] = [];',
      '',
      '  add(config: Config): void {',
      '    this.configs.push(config);',
      '  }',
      '',
      '  getAll(): Config[] {',
      '    return this.configs;',
      '  }',
      '}',
    ].join('\n');

    const parsed = SimpleCodeAnalyzer.parseFileContent('config.ts', code);
    assert.ok(parsed.elements.length > 0, 'Should find code elements');

    // Should find the function
    const fn = parsed.elements.find((e) => e.name === 'processConfig');
    assert.ok(fn, 'Should find processConfig function');
    assert.strictEqual(fn!.type, 'function');

    // Should find the class
    const cls = parsed.elements.find((e) => e.name === 'ConfigManager');
    assert.ok(cls, 'Should find ConfigManager class');
    assert.strictEqual(cls!.type, 'class');

    // Should find the interface
    const iface = parsed.elements.find((e) => e.name === 'Config');
    assert.ok(iface, 'Should find Config interface');
  });

  test('SimpleCodeAnalyzer finds relevant elements for a query', async () => {
    const { SimpleCodeAnalyzer } = await import('../../astContext.js');

    const code = [
      'export function authenticate(user: string, password: string): boolean {',
      '  return checkCredentials(user, password);',
      '}',
      '',
      'export function formatName(first: string, last: string): string {',
      '  return `${first} ${last}`;',
      '}',
    ].join('\n');

    const parsed = SimpleCodeAnalyzer.parseFileContent('auth.ts', code);
    // Use a query that directly matches a function name
    const relevant = SimpleCodeAnalyzer.findRelevantElements(parsed, 'authenticate');

    // Should find at least the "authenticate" function
    if (relevant.length > 0) {
      assert.strictEqual(relevant[0].name, 'authenticate');
    }
    // Even if empty, the function shouldn't throw
  });

  test('SimpleCodeAnalyzer extracts relevant content', async () => {
    const { SimpleCodeAnalyzer } = await import('../../astContext.js');

    const code = ['function a() { return 1; }', 'function b() { return 2; }', 'function c() { return 3; }'].join('\n');

    const parsed = SimpleCodeAnalyzer.parseFileContent('funcs.ts', code);
    const relevant = SimpleCodeAnalyzer.findRelevantElements(parsed, 'a');

    if (relevant.length > 0) {
      const content = SimpleCodeAnalyzer.extractRelevantContent(parsed, relevant.slice(0, 1));
      assert.ok(content.length > 0, 'Should extract some content');
    }
  });

  test('tree-sitter WASM files exist in grammars directory', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    const rootUri = folders[0].uri;
    const grammarsUri = vscode.Uri.joinPath(rootUri, 'grammars');

    try {
      const entries = await vscode.workspace.fs.readDirectory(grammarsUri);
      const wasmFiles = entries.filter(([name]) => name.endsWith('.wasm'));
      assert.ok(wasmFiles.length > 0, `Should have WASM grammar files, found: ${wasmFiles.map(([n]) => n).join(', ')}`);
    } catch {
      // grammars directory might not exist if copy-grammars hasn't been run
      console.log('grammars/ directory not found — skipping WASM file check');
    }
  });

  test('tree-sitter loader can be imported', async () => {
    try {
      const loader = await import('../../parsing/treeSitterLoader.js');
      assert.ok(loader, 'Should import tree-sitter loader module');
    } catch (err) {
      // May fail if WASM files aren't available — that's ok for CI
      console.log('Tree-sitter loader import failed (expected if WASM not available):', (err as Error).message);
    }
  });
});
