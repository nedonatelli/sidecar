// ---------------------------------------------------------------------------
// BFCL case loading.
//
// Two sources:
//   1. Bundled fixtures (`bench/bfcl/fixtures/*.json`) — a small, hand-curated
//      set in BFCL's shape so the harness runs offline and in CI without the
//      multi-hundred-MB upstream download.
//   2. Upstream BFCL JSONL — the real dataset ships as a `question` file plus a
//      `possible_answer` file, aligned by `id`. `parseUpstream()` merges them
//      into our BfclCase[]. Point `loadFromDir()` at a checkout to run the full
//      set.
// ---------------------------------------------------------------------------

import type { BfclCase, BfclCategory, BfclFunctionSchema, GroundTruthEntry } from './types.js';

/** A row from a BFCL `question` JSONL file. */
interface UpstreamQuestion {
  id: string;
  // BFCL nests turns: question[turn][message]. AST categories are single-turn.
  question: Array<Array<{ role: string; content: string }>>;
  function: BfclFunctionSchema[];
}

/** A row from a BFCL `possible_answer` JSONL file. */
interface UpstreamAnswer {
  id: string;
  ground_truth: GroundTruthEntry[];
}

/** Derive the category from a BFCL id prefix (`simple_12` → `simple`). */
export function categoryFromId(id: string): BfclCategory | null {
  const known: BfclCategory[] = ['parallel_multiple', 'parallel', 'multiple', 'simple', 'irrelevance', 'relevance'];
  // Longest prefixes first so `parallel_multiple` wins over `parallel`.
  for (const cat of known) {
    if (id === cat || id.startsWith(`${cat}_`)) return cat;
  }
  return null;
}

/** Flatten BFCL's nested turn structure to a single user prompt string. */
function flattenQuestion(turns: UpstreamQuestion['question']): string {
  return turns
    .flat()
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n')
    .trim();
}

/**
 * Merge a BFCL `question` JSONL and `possible_answer` JSONL (raw file contents)
 * into BfclCase[]. Categories with no ground truth (`irrelevance`) need only the
 * question file. Unknown-category ids are skipped.
 */
export function parseUpstream(questionsJsonl: string, answersJsonl: string): BfclCase[] {
  const answers = new Map<string, GroundTruthEntry[]>();
  for (const line of answersJsonl.split('\n')) {
    if (!line.trim()) continue;
    const a = JSON.parse(line) as UpstreamAnswer;
    answers.set(a.id, a.ground_truth);
  }

  const cases: BfclCase[] = [];
  for (const line of questionsJsonl.split('\n')) {
    if (!line.trim()) continue;
    const q = JSON.parse(line) as UpstreamQuestion;
    const category = categoryFromId(q.id);
    if (!category) continue;
    const gt = answers.get(q.id);
    cases.push({
      id: q.id,
      category,
      question: flattenQuestion(q.question),
      functions: q.function,
      ...(gt ? { groundTruth: gt } : {}),
    });
  }
  return cases;
}

/** Validate + normalize a JSON array of BfclCase (the bundled-fixture shape). */
export function parseFixtures(raw: string): BfclCase[] {
  const data = JSON.parse(raw) as BfclCase[];
  if (!Array.isArray(data)) throw new Error('fixture file must be a JSON array of BfclCase');
  for (const c of data) {
    if (!c.id || !c.category || !Array.isArray(c.functions)) {
      throw new Error(`malformed fixture case: ${JSON.stringify(c).slice(0, 120)}`);
    }
  }
  return data;
}
