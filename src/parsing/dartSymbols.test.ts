import { describe, it, expect } from 'vitest';
import { grammarsDir, hasGrammars } from './grammarsTestSupport.js';
import { createTreeSitterAnalyzer } from './treeSitterAnalyzer.js';
import { DISABLED_GRAMMARS } from './treeSitterLoader.js';

// #400: the shipped Dart grammar is language ABI 15. web-tree-sitter 0.24 could
// not load it, so its element mappings had never run against a real tree;
// mixins and typedefs carry their names as children, not a `name` field.

const DART = `import 'package:http/http.dart' as http;

mixin Logging { void log(String m) => print(m); }

abstract class Shape { double area(); }

class Circle extends Shape with Logging {
  final double r;
  Circle(this.r);
  @override
  double area() => 3.14 * r * r;
}

enum Color { red, green }

typedef Json = Map<String, Object?>;

Future<String> fetch(Uri url) async => (await http.get(url)).body;

String describe(Object o) => switch (o) {
  int n when n > 0 => 'positive',
  _ => 'other',
};
`;

describe.skipIf(!hasGrammars)('Dart symbols (tree-sitter)', () => {
  it('loads the grammar', () => {
    expect(DISABLED_GRAMMARS.has('dart')).toBe(false);
  });

  it('names mixins, enums and typedefs, alongside classes and functions', async () => {
    const analyzer = await createTreeSitterAnalyzer(grammarsDir);
    const els = analyzer.parseFileContent('lib/shapes.dart', DART).elements.map((e) => `${e.type}:${e.name}`);
    expect(els).toEqual(
      expect.arrayContaining([
        'interface:Logging',
        'class:Shape',
        'class:Circle',
        'function:area',
        'enum:Color',
        'type:Json',
        'function:fetch',
        'function:describe',
      ]),
    );
    expect(els).not.toContain('interface:mixin_declaration');
  });
});
