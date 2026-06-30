import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import type { CodeAnalyzer } from './types.js';
import { createTreeSitterAnalyzer } from './treeSitterAnalyzer.js';

// Real-grammar verification of AST edge extraction. Grammars live in the
// gitignored `grammars/` build artifact (created by `npm run copy-grammars`),
// so skip when absent rather than fail a grammar-less checkout.
const grammarsDir = path.join(process.cwd(), 'grammars');
const hasGrammars = fs.existsSync(path.join(grammarsDir, 'tree-sitter-typescript.wasm'));

describe.skipIf(!hasGrammars)('treeSitterAnalyzer — AST edge extraction', () => {
  let analyzer: CodeAnalyzer;
  beforeAll(async () => {
    analyzer = await createTreeSitterAnalyzer(grammarsDir);
  }, 30000);

  const TS = [
    'import { lookup } from "./db";',
    'export class Service extends Base implements Handler {',
    '  handle(cfg: AuthConfig): SessionToken {',
    '    const u: UserRecord = lookup(cfg);',
    '    return this.mint(u);',
    '  }',
    '}',
    'export const route = (r: ReqCtx): void => {',
    '  helper.process(r);',
    '  doThing();',
    '};',
    '// commentCall() must not be captured',
    'const s = "stringCall()";',
  ].join('\n');

  it('extracts calls attributed to the innermost enclosing symbol (AST scope)', () => {
    const parsed = analyzer.parseFileContent('svc.ts', TS);
    const calls = parsed.calls ?? [];
    const byCallee = (n: string) => calls.find((c) => c.calleeName === n);

    // Plain + member calls, resolved to the bare callee name.
    expect(byCallee('lookup')).toMatchObject({ callerName: 'handle' });
    expect(byCallee('mint')).toMatchObject({ callerName: 'handle' }); // this.mint → mint
    expect(byCallee('process')).toMatchObject({ callerName: 'route' }); // helper.process → process
    expect(byCallee('doThing')).toMatchObject({ callerName: 'route' });
  });

  it('does not capture calls inside comments or string literals', () => {
    const calls = analyzer.parseFileContent('svc.ts', TS).calls ?? [];
    const names = calls.map((c) => c.calleeName);
    expect(names).not.toContain('commentCall');
    expect(names).not.toContain('stringCall');
  });

  it('extracts type-use edges with roles', () => {
    const uses = analyzer.parseFileContent('svc.ts', TS).typeUses ?? [];
    const byType = (t: string) => uses.find((u) => u.typeName === t);
    expect(byType('AuthConfig')).toMatchObject({ userName: 'handle', role: 'param' });
    expect(byType('SessionToken')).toMatchObject({ userName: 'handle', role: 'return' });
    expect(byType('UserRecord')).toMatchObject({ userName: 'handle', role: 'variable' });
    expect(byType('ReqCtx')).toMatchObject({ userName: 'route', role: 'param' });
  });

  it('extracts extends/implements heritage as type relations', () => {
    const rels = analyzer.parseFileContent('svc.ts', TS).typeRelations ?? [];
    expect(rels).toContainEqual({ childName: 'Service', parentName: 'Base', kind: 'extends' });
    expect(rels).toContainEqual({ childName: 'Service', parentName: 'Handler', kind: 'implements' });
  });

  it('falls back to regex edge extraction for non-AST languages (Java)', () => {
    const java = ['class A {', '  void run() {', '    doThing();', '  }', '}'].join('\n');
    const calls = analyzer.parseFileContent('A.java', java).calls ?? [];
    // Java is parsed by tree-sitter for elements but delegates edges to the
    // regex analyzer (which supports JVM calls) — so no edge-coverage regression.
    expect(calls.find((c) => c.calleeName === 'doThing')).toBeTruthy();
  });

  // --- Python AST edges (Stage 4) ---
  const PY = [
    'class Service(Base, Mixin):',
    '    def handle(self, cfg: AuthConfig) -> SessionToken:',
    '        u: UserRecord = lookup(cfg)',
    '        return self.mint(u)',
    '',
    'def route(r: ReqCtx) -> None:',
    '    helper.process(r)',
    '    do_thing()',
    '    # commentCall() must not be captured',
  ].join('\n');

  it('extracts Python calls attributed to the enclosing def (incl. attribute calls)', () => {
    const calls = analyzer.parseFileContent('svc.py', PY).calls ?? [];
    const byCallee = (n: string) => calls.find((c) => c.calleeName === n);
    expect(byCallee('lookup')).toMatchObject({ callerName: 'handle' });
    expect(byCallee('mint')).toMatchObject({ callerName: 'handle' }); // self.mint → mint
    expect(byCallee('process')).toMatchObject({ callerName: 'route' }); // helper.process → process
    expect(byCallee('do_thing')).toMatchObject({ callerName: 'route' });
    expect(calls.map((c) => c.calleeName)).not.toContain('commentCall');
  });

  it('extracts Python type hints with roles', () => {
    const uses = analyzer.parseFileContent('svc.py', PY).typeUses ?? [];
    const byType = (t: string) => uses.find((u) => u.typeName === t);
    expect(byType('AuthConfig')).toMatchObject({ userName: 'handle', role: 'param' });
    expect(byType('SessionToken')).toMatchObject({ userName: 'handle', role: 'return' });
    expect(byType('UserRecord')).toMatchObject({ userName: 'handle', role: 'variable' });
    expect(byType('ReqCtx')).toMatchObject({ userName: 'route', role: 'param' });
  });

  it('extracts Python base classes as extends relations', () => {
    const rels = analyzer.parseFileContent('svc.py', PY).typeRelations ?? [];
    expect(rels).toContainEqual({ childName: 'Service', parentName: 'Base', kind: 'extends' });
    expect(rels).toContainEqual({ childName: 'Service', parentName: 'Mixin', kind: 'extends' });
  });
});
