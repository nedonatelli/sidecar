/**
 * Intelligent compression of tool execution results.
 *
 * Instead of naive truncation at N chars, extract actionable information:
 * - Error messages → keep full error + stack trace
 * - Test results → extract PASS/FAIL counts + failed test names
 * - File content → extract relevant methods/functions
 * - Grep output → extract filename:line:match format
 * - Command output → extract key status lines + errors
 *
 * Fallback to smart truncation if pattern matching doesn't apply.
 */

export interface CompressionResult {
  /** The compressed result text. */
  content: string;
  /** Original content length. */
  originalLength: number;
  /** Compression strategy applied. */
  strategy: CompressionStrategy;
  /** Estimated information density (0-1, higher = more useful). */
  density: number;
}

export type CompressionStrategy =
  | 'error_extraction'
  | 'test_extraction'
  | 'grep_extraction'
  | 'file_extraction'
  | 'command_extraction'
  | 'smart_truncation'
  | 'no_compression_needed';

export class ToolResultCompressor {
  /**
   * Compress a tool result intelligently.
   * Tries semantic extraction first, falls back to truncation.
   *
   * @param content The tool result content to compress
   * @param maxLength Maximum chars to return (soft limit for extraction, hard limit for truncation)
   * @param toolName Optional tool name for context (e.g., "run_command", "read_file")
   * @returns Compression result with strategy info
   */
  compress(content: string, maxLength: number = 500, toolName?: string): CompressionResult {
    // Too short to bother compressing
    if (content.length <= maxLength) {
      return {
        content,
        originalLength: content.length,
        strategy: 'no_compression_needed',
        density: 1.0,
      };
    }

    // Try semantic extraction based on content patterns
    const errorResult = this.tryExtractErrors(content, maxLength);
    if (errorResult) return errorResult;

    const testResult = this.tryExtractTestResults(content, maxLength);
    if (testResult) return testResult;

    const grepResult = this.tryExtractGrepResults(content, maxLength);
    if (grepResult) return grepResult;

    const commandResult = this.tryExtractCommandOutput(content, maxLength);
    if (commandResult) return commandResult;

    const fileResult = this.tryExtractFileContent(content, maxLength, toolName);
    if (fileResult) return fileResult;

    // Fall back to smart truncation
    return this.smartTruncate(content, maxLength);
  }

  /**
   * Extract key error information (Error: messages, stack traces, exception names).
   */
  private tryExtractErrors(content: string, maxLength: number): CompressionResult | null {
    // Look for error-like patterns
    const errorPatterns = [
      /^Error:/m,
      /^(ENOENT|EACCES|EISDIR|TypeError|ReferenceError|SyntaxError):/m,
      /^  at /m, // Stack trace lines
      /\[error\]/i,
      /failed|failure|fail:/i,
      /exception|throw/i,
    ];

    if (!errorPatterns.some((p) => p.test(content))) {
      return null;
    }

    const lines = content.split('\n');
    const extracted: string[] = [];
    let seenMainError = false;

    for (let i = 0; i < lines.length && extracted.length < 15; i++) {
      const line = lines[i];

      // Prioritize error messages
      if (/^Error:|^[A-Z]+Error:|^\[error\]/i.test(line)) {
        extracted.push(line);
        seenMainError = true;
      }
      // Include stack traces (up to 5 lines after main error)
      else if (seenMainError && /^\s+at /.test(line)) {
        extracted.push(line);
      }
      // Stop at blank line after stack trace
      else if (seenMainError && extracted.length > 3 && line.trim() === '') {
        break;
      }
      // Also capture "FAIL:" lines
      else if (/^FAIL:|^✗|^×/.test(line)) {
        extracted.push(line);
      }
    }

    if (extracted.length === 0) {
      return null;
    }

    const result = extracted.join('\n');
    if (result.length > maxLength) {
      return {
        content: result.slice(0, maxLength) + '...',
        originalLength: content.length,
        strategy: 'error_extraction',
        density: 0.95,
      };
    }

    return {
      content: result,
      originalLength: content.length,
      strategy: 'error_extraction',
      density: Math.min(1.0, result.length / content.length + 0.3), // Boost density for error extraction
    };
  }

  /**
   * Extract test result summary (PASS/FAIL counts, failed test names).
   */
  private tryExtractTestResults(content: string, maxLength: number): CompressionResult | null {
    // Test output indicators
    if (!/tests|test(s)? passed|test(s)? failed|describe|it\(|✓|✗/i.test(content)) {
      return null;
    }

    const lines = content.split('\n');
    const extracted: string[] = [];
    let foundSummary = false;

    // First pass: look for summary line
    for (const line of lines) {
      // Vitest/Jest summary: "10 passed 2 failed"
      if (/\d+\s+(passed|failed|skipped)/i.test(line)) {
        extracted.push(line);
        foundSummary = true;
        break;
      }
    }

    // Second pass: extract failed test names
    for (let i = 0; i < lines.length && extracted.length < 10; i++) {
      const line = lines[i];
      // Vitest format: "✗ test name"
      if (/^[✓✗×]\s+/.test(line)) {
        extracted.push(line);
      }
      // Jest format: "● test name"
      else if (/^●\s+/.test(line)) {
        extracted.push(line);
      }
      // FAIL: block header
      else if (/^FAIL:/.test(line)) {
        extracted.push(line);
      }
    }

    if (extracted.length === 0) {
      return null;
    }

    const result = extracted.join('\n');
    return {
      content: result.length > maxLength ? result.slice(0, maxLength) + '...' : result,
      originalLength: content.length,
      strategy: 'test_extraction',
      density: foundSummary ? 0.9 : 0.7,
    };
  }

  /**
   * Extract grep/search results in filename:line:match format.
   */
  private tryExtractGrepResults(content: string, maxLength: number): CompressionResult | null {
    // Grep-like output: file:line:content or file:123:content
    if (!/^[^:]+:\d+:/m.test(content)) {
      // Also check for grep-style with optional line numbers
      if (!/^[^:]+:\s+.*matched/im.test(content)) {
        return null;
      }
    }

    const lines = content.split('\n');
    const extracted: string[] = [];

    for (let i = 0; i < lines.length && extracted.length < 20; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;

      // Keep grep-style matches
      if (/^[^:]+:\d+:/.test(line) || /^[^:]+:\s+/.test(line)) {
        // Limit line length to prevent one massive match from dominating
        if (line.length > 120) {
          extracted.push(line.slice(0, 120) + '...');
        } else {
          extracted.push(line);
        }
      }
    }

    if (extracted.length === 0) {
      return null;
    }

    const result = extracted.join('\n');
    return {
      content:
        result.length > maxLength
          ? result.slice(0, maxLength - 10) + `\n... (${extracted.length} total matches)`
          : result,
      originalLength: content.length,
      strategy: 'grep_extraction',
      density: 0.85,
    };
  }

  /**
   * Extract command output (status lines, key output, exit codes).
   */
  private tryExtractCommandOutput(content: string, maxLength: number): CompressionResult | null {
    // Command output indicators
    const isCommandOutput =
      /exit code:|return code:|status:|\$|\[exit|\(exit|exited with/.test(content) ||
      /^SUCCESS|^DONE|^BUILD|^RUN/.test(content);

    if (!isCommandOutput) {
      return null;
    }

    const lines = content.split('\n');
    const extracted: string[] = [];

    // Look for exit code / status line
    for (const line of lines) {
      if (/exit code|return code|status|exited|SUCCESS|DONE|FAILURE|ERROR/.test(line)) {
        extracted.push(line);
      }
    }

    // If we found status info, add first few lines of context
    if (extracted.length > 0 && extracted[0].length < maxLength) {
      for (let i = 0; i < Math.min(3, lines.length); i++) {
        if (!extracted.includes(lines[i]) && lines[i].trim().length > 0) {
          extracted.push(lines[i]);
        }
      }
    }

    if (extracted.length === 0) {
      return null;
    }

    const result = extracted.slice(0, 6).join('\n'); // Limit to 6 lines
    return {
      content: result.length > maxLength ? result.slice(0, maxLength) + '...' : result,
      originalLength: content.length,
      strategy: 'command_extraction',
      density: 0.75,
    };
  }

  /**
   * Extract relevant code from file content (function defs, class names, imports).
   */
  private tryExtractFileContent(content: string, maxLength: number, toolName?: string): CompressionResult | null {
    // Only apply to file reads
    if (toolName && toolName !== 'read_file') {
      return null;
    }

    // Look for code-like patterns
    if (!/^(export |import |class |function |const |interface |type |async )/m.test(content)) {
      return null;
    }

    const lines = content.split('\n');
    const extracted: string[] = [];

    // Extract imports at top
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (/^(import |export )/.test(lines[i])) {
        extracted.push(lines[i]);
      }
    }

    // Extract function/class definitions (first few only)
    let defCount = 0;
    for (const line of lines) {
      if (/^(export )?(async )?(function |class |interface |type )/.test(line)) {
        extracted.push(line);
        defCount++;
        if (defCount >= 3) break;
      }
    }

    if (extracted.length < 2) {
      return null;
    }

    const result = extracted.join('\n');
    if (result.length > maxLength) {
      return {
        content: this.smartTruncate(result, maxLength).content,
        originalLength: content.length,
        strategy: 'file_extraction',
        density: 0.7,
      };
    }

    return {
      content: result,
      originalLength: content.length,
      strategy: 'file_extraction',
      density: 0.8,
    };
  }

  /**
   * Smart truncation: preserve sentence/line boundaries, add contextual suffix.
   */
  private smartTruncate(content: string, maxLength: number): CompressionResult {
    if (content.length <= maxLength) {
      return {
        content,
        originalLength: content.length,
        strategy: 'smart_truncation',
        density: 1.0,
      };
    }

    // Try to break at a newline
    const keepLength = Math.floor(maxLength * 0.85); // Reserve 15% for suffix
    let breakPoint = keepLength;

    // Look backward for a newline
    for (let i = keepLength; i > Math.floor(maxLength * 0.5); i--) {
      if (content[i] === '\n') {
        breakPoint = i;
        break;
      }
    }

    // Look backward for a space if we didn't find newline
    if (breakPoint === keepLength) {
      for (let i = keepLength; i > Math.floor(maxLength * 0.5); i--) {
        if (content[i] === ' ') {
          breakPoint = i;
          break;
        }
      }
    }

    const truncated = content.slice(0, breakPoint).trimEnd();
    const linesOmitted = content.slice(breakPoint).split('\n').length - 1;
    const suffix = `\n... (${content.length - breakPoint} chars, ${linesOmitted} lines omitted)`;

    return {
      content: (truncated + suffix).slice(0, maxLength),
      originalLength: content.length,
      strategy: 'smart_truncation',
      density: truncated.length / content.length,
    };
  }
}
