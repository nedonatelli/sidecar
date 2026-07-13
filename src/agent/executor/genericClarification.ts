// Normalize GENERIC ask_user questions into a canned, useful clarification
// card. When a weak model is lost (no-signal turn, ambiguous fragment), it
// emits "What do you want me to do?" with whatever options it invents in the
// moment — observed live: llama3.2 offered ["Help", "Edit a file", "Run
// test…"] on a bare "hi", and in the worst case replayed its description
// example verbatim ("Which auth flow should the callback use?"). The
// question card is the right MOVE (asking beats thrashing), but the model's
// improvised phrasing carries no product value, so a detected generic
// question is swapped for a canonical card with consistent, actionable
// options. Specific questions ("which of the two greet functions?") never
// match and pass through untouched — a false positive here would destroy a
// genuine clarification, so patterns are anchored and conservative.

const GENERIC_QUESTION_PATTERNS: RegExp[] = [
  /^what (do|would|did) you (want|like|need)( me)?( to do| to help( you)? with| from me)?\??$/i,
  /^what should i (do|help( you)? with|work on)( next| now| first)?\??$/i,
  /^what can i (do|help( you)? with)( for you)?( today)?\??$/i,
  /^how (can|may|should) i (help|assist)( you)?( today| with (that|this))?\??$/i,
  /^(is there )?anything (else )?(i can|you'?d like me to) (do|help( you)? with)\??$/i,
  /^what('?s| is) (your|the) (task|request|goal|question)\??$/i,
  /^(please )?(provide|specify|describe|clarify) (a |the |more |your )*(task|details?|instructions?|request|what you (want|need))\.?$/i,
  /^(i'?m )?not sure what you('?re| are)? (asking|looking) for\.?$/i,
  /^what would you like( me)? to (do|work on|help with)( next| today)?\??$/i,
  /^(can|could) you (please )?(clarify|elaborate|be more specific)\??$/i,
];

/** True when an ask_user question is a generic "what do you want?" with no task-specific content. */
export function isGenericClarification(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length === 0) return true; // empty question is the degenerate generic case
  if (trimmed.length > 80) return false; // long questions carry specifics
  return GENERIC_QUESTION_PATTERNS.some((re) => re.test(trimmed));
}

/** The canonical clarification card shown in place of a generic model question. */
export const CANNED_CLARIFICATION = {
  question: "I'm not sure what you'd like me to do. Pick a direction or describe the task:",
  options: ['Explain this codebase', 'Fix a bug or error', 'Edit or refactor code', 'Run the tests'],
  allowCustom: true,
} as const;
