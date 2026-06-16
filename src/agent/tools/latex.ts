import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { getRootUri, validateFilePath, type ToolExecutorContext, type RegisteredTool } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import { getConfig } from '../../config/settings.js';

export interface LatexError {
  file: string;
  line: number | null;
  message: string;
  context?: string;
}

export interface LatexWarning {
  file?: string;
  line?: number | null;
  message: string;
}

export interface LatexCompileResult {
  success: boolean;
  errors: LatexError[];
  warnings: LatexWarning[];
  pdfPath?: string;
}

/**
 * Parse LaTeX compiler output into structured errors and warnings.
 *
 * LaTeX error format:
 *   ! Undefined control sequence.
 *   l.42 \badcmd
 *
 * latexmk wraps errors with file context:
 *   ./src/chapter.tex:42: Undefined control sequence.
 */
export function parseLatexOutput(output: string, mainFile: string): LatexCompileResult {
  const errors: LatexError[] = [];
  const warnings: LatexWarning[] = [];
  const lines = output.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // latexmk / pdflatex inline format: "filename:line: message"
    const inlineErr = line.match(/^([^:]+\.tex):(\d+):\s+(.+)$/);
    if (inlineErr) {
      errors.push({ file: inlineErr[1], line: parseInt(inlineErr[2], 10), message: inlineErr[3].trim() });
      i++;
      continue;
    }

    // Classic pdflatex: "! Error message"
    if (line.startsWith('!')) {
      const message = line.slice(1).trim();
      let lineNum: number | null = null;
      let context: string | undefined;
      // Look ahead for "l.NNN context" line
      if (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        const lMatch = next.match(/^l\.(\d+)\s*(.*)/);
        if (lMatch) {
          lineNum = parseInt(lMatch[1], 10);
          context = lMatch[2].trim() || undefined;
          i += 2;
        } else {
          i++;
        }
      } else {
        i++;
      }
      errors.push({ file: mainFile, line: lineNum, message, context });
      continue;
    }

    // Warnings: "LaTeX Warning:", "Package X Warning:", "Overfull \hbox"
    const warnMatch =
      line.match(/^(LaTeX|Package \S+) Warning:\s+(.+)$/) || line.match(/^(Overfull|Underfull) \\(hbox|vbox)\s+(.+)$/);
    if (warnMatch) {
      const warnMsg = line.trim();
      let warnLine: number | null = null;
      // Try to extract line number from warning text e.g. "...at lines 42--45"
      const lineRef = warnMsg.match(/at lines? (\d+)/);
      if (lineRef) warnLine = parseInt(lineRef[1], 10);
      warnings.push({ message: warnMsg, line: warnLine, file: mainFile });
      i++;
      continue;
    }

    i++;
  }

  // Determine success: pdflatex exits 1 on error; presence of "Output written on" signals success
  const success = errors.length === 0 && output.includes('Output written on');
  const pdfMatch = output.match(/Output written on ([^\s(]+)/);
  const pdfPath = pdfMatch ? pdfMatch[1] : undefined;

  return { success, errors, warnings, pdfPath };
}

/** Detect whether latexmk or pdflatex is the preferred compiler, respecting config. */
async function resolveCompilerCommand(
  file: string,
  compiler: string,
  session: { execute: (cmd: string, opts?: object) => Promise<{ stdout: string; exitCode: number }> },
): Promise<string> {
  if (compiler === 'pdflatex') {
    return `pdflatex -interaction=nonstopmode -halt-on-error "${file}"`;
  }
  // Default: latexmk, falling back to pdflatex if latexmk is unavailable
  try {
    const probe = await session.execute('latexmk --version 2>&1', { timeout: 5000 });
    if (probe.exitCode === 0) {
      return `latexmk -pdf -interaction=nonstopmode "${file}"`;
    }
  } catch {
    /* latexmk not found */
  }
  return `pdflatex -interaction=nonstopmode -halt-on-error "${file}"`;
}

export async function latexCompile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const cfg = context?.config ?? getConfig();
  if (!cfg.latexEnabled) {
    return 'LaTeX compilation is disabled. Enable it with `sidecar.latex.enabled = true`.';
  }

  let file = input.file as string | undefined;

  if (!file) {
    // Auto-detect: find the first .tex file in the workspace root
    try {
      const root = getRootUri();
      const found = await workspace.findFiles('*.tex', '{**/node_modules/**,**/.git/**}', 1);
      if (found.length === 0) {
        return 'No .tex file found. Specify `file="path/to/main.tex"`.';
      }
      const workspacePath = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const texPath = found[0].fsPath;
      file = workspacePath ? texPath.replace(workspacePath + '/', '') : texPath;
      // Verify the detected file exists under the root
      await workspace.fs.stat(Uri.joinPath(root, file));
    } catch {
      return 'Could not auto-detect a .tex file. Specify `file="path/to/main.tex"`.';
    }
  }

  const pathError = validateFilePath(file);
  if (pathError) return `Invalid file path: ${pathError}`;

  const compiler = cfg.latexCompiler;
  const runtime = context?.toolRuntime ?? getDefaultToolRuntime();
  const session = runtime.getShellSession(context?.config);

  const command = await resolveCompilerCommand(file, compiler, session);

  let rawOutput: string;
  try {
    const result = await session.execute(command, {
      timeout: 120_000,
      onOutput: context?.onOutput,
      signal: context?.signal,
    });
    rawOutput = result.stdout.trim();
  } catch (err) {
    return `LaTeX compilation failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const parsed = parseLatexOutput(rawOutput, file);

  if (parsed.success && parsed.errors.length === 0 && parsed.warnings.length === 0) {
    const pdfNote = parsed.pdfPath ? ` PDF written to \`${parsed.pdfPath}\`.` : '';
    return `Compilation successful.${pdfNote}`;
  }

  const lines: string[] = [];

  if (parsed.errors.length > 0) {
    lines.push(`**${parsed.errors.length} error${parsed.errors.length > 1 ? 's' : ''}**\n`);
    for (const e of parsed.errors) {
      const loc = e.line !== null && e.line !== undefined ? `${e.file}:${e.line}` : e.file;
      let entry = `- **${loc}** — ${e.message}`;
      if (e.context) entry += `\n  \`${e.context}\``;
      lines.push(entry);
    }
  }

  if (parsed.warnings.length > 0) {
    lines.push(`\n**${parsed.warnings.length} warning${parsed.warnings.length > 1 ? 's' : ''}**\n`);
    for (const w of parsed.warnings.slice(0, 10)) {
      const loc = w.line !== null && w.line !== undefined ? ` (line ${w.line})` : '';
      lines.push(`- ${w.message.slice(0, 120)}${loc}`);
    }
    if (parsed.warnings.length > 10) lines.push(`- … and ${parsed.warnings.length - 10} more warnings`);
  }

  if (parsed.pdfPath) lines.push(`\nPDF written to \`${parsed.pdfPath}\`.`);

  lines.push(
    `\n<details><summary>Full compiler output</summary>\n\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\`\n</details>`,
  );

  return lines.join('\n');
}

export const latexCompileDef: ToolDefinition = {
  name: 'latex_compile',
  nondeterministicOutput: true,
  description:
    'Compile a LaTeX document and return structured errors and warnings. ' +
    'Auto-detects the main .tex file in the workspace; use `file` to target a specific file. ' +
    'Prefers `latexmk` if available, falls back to `pdflatex`. ' +
    'Use this after editing .tex files to verify compilation, or to identify errors for an auto-fix loop. ' +
    'Example: `latex_compile(file="thesis/main.tex")`.',
  input_schema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Path to the main .tex file (relative to workspace root). Auto-detected if omitted.',
      },
    },
    required: [],
  },
};

export const latexTools: RegisteredTool[] = [
  { definition: latexCompileDef, executor: latexCompile, requiresApproval: true },
];
