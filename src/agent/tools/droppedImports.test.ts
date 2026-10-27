import { describe, it, expect } from 'vitest';
import { droppedUsedImports, droppedImportError } from './droppedImports.js';

const names = (before: string, after: string, file = 'mod.py') =>
  droppedUsedImports(file, before, after).map((d) => d.name);

describe('droppedUsedImports (#334)', () => {
  // The three shapes from the recorded SWE canaries.
  it('scikit-learn-10949: `import numpy as np` replaced while np is still used', () => {
    const before =
      'import warnings\nimport numpy as np\nimport scipy.sparse as sp\n\ndef f(x):\n    return np.asarray(x)\n';
    const after = before.replace('import numpy as np', 'import pandas as pd');
    const d = droppedUsedImports('sklearn/utils/validation.py', before, after);
    expect(d).toEqual([{ name: 'np', importLine: 'import numpy as np', useLine: 6, useText: 'return np.asarray(x)' }]);
  });

  it('django-11583: `from pathlib import Path` dropped from a multi-name block', () => {
    const before =
      'import os\nfrom pathlib import Path\nfrom zipimport import zipimporter\n\ndef g(f):\n    return Path(f).resolve()\n';
    expect(names(before, before.replace('from pathlib import Path\n', ''))).toEqual(['Path']);
  });

  it('pytest-5692: a plain `import time` removed', () => {
    const before = 'import os\nimport time\n\nstamp = time.time()\n';
    expect(names(before, 'import os\n\nstamp = time.time()\n')).toEqual(['time']);
  });

  it('a renamed alias: `import x as y` -> `import x as z` with y still used', () => {
    const before = 'import numpy as np\nnp.zeros(1)\n';
    expect(names(before, 'import numpy as npy\nnp.zeros(1)\n')).toEqual(['np']);
  });

  it('one name dropped from a parenthesised import', () => {
    const before = 'from .models import (\n    Article,\n    Publication,\n)\n\nArticle.objects.all()\nPublication()\n';
    const after = 'from .models import (\n    Publication,\n)\n\nArticle.objects.all()\nPublication()\n';
    expect(names(before, after)).toEqual(['Article']);
  });

  describe('allowed', () => {
    it('removing an import nothing uses', () => {
      expect(names('import os\nimport sys\nprint(sys.argv)\n', 'import sys\nprint(sys.argv)\n')).toEqual([]);
    });

    it('moving or re-importing the name', () => {
      const before = 'import numpy as np\nnp.zeros(1)\n';
      expect(names(before, 'from numpy import zeros\nimport numpy as np\nnp.zeros(1)\n')).toEqual([]);
      expect(names('from a import Path\nPath()\n', 'from pathlib import Path\nPath()\n')).toEqual([]);
    });

    it('binding the name another way: def, class, assignment, for, with/except as, global', () => {
      const before = 'from x import thing\nthing()\n';
      for (const binder of [
        'def thing():\n    pass\n',
        'class thing:\n    pass\n',
        'thing = 1\n',
        'thing: int = 1\n',
        'for thing in []:\n    pass\n',
        'with open("f") as thing:\n    pass\n',
        'try:\n    pass\nexcept Exception as thing:\n    pass\n',
      ]) {
        expect(names(before, `${binder}thing()\n`), binder).toEqual([]);
      }
    });

    it('a star import that may supply the name', () => {
      expect(names('from sympy import Add\nAdd(1)\n', 'from sympy import *\nAdd(1)\n')).toEqual([]);
    });

    it('a mention only in a comment or a string', () => {
      expect(names('import time\nx = 1\n', 'x = 1  # time it\ny = "time"\n')).toEqual([]);
    });

    it('an attribute of the same name (obj.np) is not a use', () => {
      expect(names('import numpy as np\nobj.np = 1\n', 'obj.np = 1\n')).toEqual([]);
    });

    it('`from __future__` imports, and non-Python files', () => {
      expect(names('from __future__ import annotations\nannotations\n', 'annotations\n')).toEqual([]);
      expect(droppedUsedImports('a.ts', "import fs from 'fs';\nfs.x\n", 'fs.x\n')).toEqual([]);
    });

    it('`import a.b` removed while `import a.c` still binds a', () => {
      expect(names('import os.path\nimport os.sep\nos.getcwd()\n', 'import os.sep\nos.getcwd()\n')).toEqual([]);
    });
  });

  it('the refusal names the import, the use, and what to do; it lists any others', () => {
    const before = 'import numpy as np\nimport time\nnp.x\ntime.y\n';
    const msg = droppedImportError('m.py', droppedUsedImports('m.py', before, 'np.x\ntime.y\n'));
    expect(msg).toContain('edit_file refused this edit to m.py');
    expect(msg).toContain('removes `import numpy as np`, but `np` is still used (and 1 more: `time`)');
    expect(msg).toContain('line 1: `np.x`');
    expect(msg).toContain('The file was NOT modified');
  });
});
