/**
 * Terse-message intent classifiers: predicates that recognize short user
 * replies ("commit", "yes", "undo", "continue") whose meaning is the intent,
 * not the literal words. Each predicate trims, length-caps, and rejects slash
 * commands before matching its own pattern set.
 */

/**
 * Detect terse user messages like "continue", "go on", "keep going" that mean
 * "resume what you were just doing" rather than "answer this literal word".
 * Caller should also check that there's a prior assistant message — otherwise
 * there's nothing to continue.
 */
const CONTINUATION_PATTERNS: RegExp[] = [
  /^continue\.?$/i,
  /^continue please\.?$/i,
  /^please continue\.?$/i,
  /^continue working\.?$/i,
  /^keep (going|working)\.?$/i,
  /^go on\.?$/i,
  /^go ahead\.?$/i,
  /^carry on\.?$/i,
  /^proceed\.?$/i,
  /^resume\.?$/i,
  /^next\.?$/i,
  /^and\??$/i,
  /^more\.?$/i,
  /^finish (it|this|up)\.?$/i,
  /^keep at it\.?$/i,
];

const COMMIT_REQUEST_PATTERNS: RegExp[] = [
  /^commit\.?$/i,
  /^commit (it|this|that|the changes?|them)\.?$/i,
  /^commit (and push|it now)\.?$/i,
  /^make (a )?commit\.?$/i,
  /^create (a )?commit\.?$/i,
  /^save (the )?changes?\.?$/i,
  /^lgtm\.?$/i,
];

/** Returns true when the user wants to commit the current changes. */
export function isCommitRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return false;
  if (trimmed.startsWith('/')) return false;
  return COMMIT_REQUEST_PATTERNS.some((re) => re.test(trimmed));
}

const SHOW_DIFF_PATTERNS: RegExp[] = [
  /^(show|what|see) (me )?(the )?(diff|changes?|what (changed|you did|was changed))\.?$/i,
  /^(show|display) diff\.?$/i,
  /^what('?d| did) you (change|do|edit)\.?\??$/i,
  /^what changed\.?\??$/i,
  /^show changes?\.?$/i,
  /^diff\.?$/i,
];

/** Returns true when the user wants to see the current change summary. */
export function isShowDiffRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (trimmed.startsWith('/')) return false;
  return SHOW_DIFF_PATTERNS.some((re) => re.test(trimmed));
}

const DEFERRED_ANSWER_PATTERNS: RegExp[] = [
  /^i (don'?t|do not) know\.?$/i,
  /^(your|your own) (call|choice|pick|decision|judgment|judgement|preference)\.?$/i,
  /^up to you\.?$/i,
  /^whatever (you think|you prefer|works|is best|makes sense)\.?$/i,
  /^you (decide|choose|pick)\.?$/i,
  /^(use your )?(best )?judgment\.?$/i,
  /^any(thing| of them)\.?$/i,
  /^(it )?doesn'?t matter\.?$/i,
  /^(no|no strong) preference\.?$/i,
  /^(just )?(go with|pick) (whatever|what you think)\.?$/i,
  /^sure[,!]?\s+(your call|up to you|whatever)\.?$/i,
];

/** Returns true when the user is deferring a pending question back to the agent. */
export function isDeferredAnswer(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (trimmed.startsWith('/')) return false;
  return DEFERRED_ANSWER_PATTERNS.some((re) => re.test(trimmed));
}

const PLAN_REJECTION_PATTERNS: RegExp[] = [
  /^no\.?$/i,
  /^nope\.?$/i,
  /^nah\.?$/i,
  /^cancel\.?$/i,
  /^reject\.?$/i,
  /^rejected\.?$/i,
  /^stop\.?$/i,
  /^abort\.?$/i,
  /^start over\.?$/i,
  /^scratch that\.?$/i,
  /^never mind\.?$/i,
  /^nevermind\.?$/i,
  /^forget it\.?$/i,
  /^discard(ed)?\.?$/i,
  /^don'?t (do it|proceed|execute)\.?$/i,
  /^no[,!]?\s+(thanks?|thank you)\.?$/i,
];

/** Returns true when the user is rejecting a presented plan. */
export function isPlanRejection(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (trimmed.startsWith('/')) return false;
  return PLAN_REJECTION_PATTERNS.some((re) => re.test(trimmed));
}

const UNDO_REQUEST_PATTERNS: RegExp[] = [
  /^undo\.?$/i,
  /^undo (that|this|it|the changes?|all)\.?$/i,
  /^revert\.?$/i,
  /^revert (that|this|it|the changes?)\.?$/i,
  /^roll ?back\.?$/i,
  /^roll ?back (that|this|the changes?)\.?$/i,
  /^un-?do that\.?$/i,
  /^take that back\.?$/i,
  /^restore (original|previous)\.?$/i,
];

/** Returns true when the user wants to undo the agent's file changes. */
export function isUndoRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return false;
  if (trimmed.startsWith('/')) return false;
  return UNDO_REQUEST_PATTERNS.some((re) => re.test(trimmed));
}

const PLAN_APPROVAL_PATTERNS: RegExp[] = [
  /^yes\.?$/i,
  /^yeah\.?$/i,
  /^yep\.?$/i,
  /^yup\.?$/i,
  /^sure\.?$/i,
  /^ok\.?$/i,
  /^okay\.?$/i,
  /^sounds good\.?$/i,
  /^looks good\.?$/i,
  /^go ahead\.?$/i,
  /^go for it\.?$/i,
  /^do it\.?$/i,
  /^let'?s? (go|do it)\.?$/i,
  /^proceed\.?$/i,
  /^approved?\.?$/i,
  /^execute\.?$/i,
  /^execute (the )?plan\.?$/i,
  /^run (it|the plan)\.?$/i,
  /^(that'?s? )?good\.?$/i,
  /^(that'?s? )?perfect\.?$/i,
  /^i approve\.?$/i,
  /^yes[,!]? (please|go ahead|do it|proceed)\.?$/i,
];

/** Returns true when the user's message is a plain approval of a presented plan. */
export function isPlanApproval(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (trimmed.startsWith('/')) return false;
  return PLAN_APPROVAL_PATTERNS.some((re) => re.test(trimmed));
}

export function isContinuationRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  if (trimmed.startsWith('/')) return false;
  return CONTINUATION_PATTERNS.some((re) => re.test(trimmed));
}

// --- Small talk (greeting / gratitude) ---------------------------------------
// A pure greeting or thanks carries no task, but weak local models treat ANY
// turn as a work order: a bare "hi" produced a 10-iteration exploration run
// and "thanks, great work!" made llama3.2 redo the previous edit (latch eval:
// 0/3). Intercepting small talk with a canned reply BEFORE the agent loop is
// the deterministic fix — zero tokens, zero variance, and nothing for the
// model to latch onto. Patterns are strict full-string matches so any message
// carrying an actual task ("hi, rename greet to welcome") falls through to
// the model.

const GREETING_PATTERNS: RegExp[] = [
  /^(hi|hii+|hello|hey|heya|yo|sup|howdy|hiya)( there)?( sidecar)?[!.\s]*$/i,
  /^good (morning|afternoon|evening)[!.\s]*$/i,
  /^(hi|hello|hey),? (sidecar|there)[!.\s]*$/i,
];

const GRATITUDE_PATTERNS: RegExp[] = [
  /^(thanks|thank you|thankyou|thx|ty|cheers)[!.\s]*$/i,
  /^(thanks|thank you),? (a lot|so much|again|man)[!.\s]*$/i,
  /^(great|nice|good|awesome|excellent|amazing) (work|job)[!.\s]*$/i,
  /^(thanks|thank you|thx),? (great|nice|good|awesome) (work|job)[!.\s]*$/i,
  /^(perfect|awesome|great|nice|excellent)(,? thanks( a lot)?| thank you)?[!.\s]*$/i,
  /^(that('s| is|s) )?(perfect|great|awesome|exactly what i (wanted|needed))[!.\s]*$/i,
  /^you('re| are) (the best|awesome|great)[!.\s]*$/i,
];

export type SmallTalkKind = 'greeting' | 'gratitude';

/**
 * Classify a message as pure small talk, or null when it (possibly also)
 * carries a task. Strict by design: full-string anchored patterns with a
 * short length cap — a false positive here swallows real work, while a false
 * negative merely costs one model round-trip.
 */
export function classifySmallTalk(text: string): SmallTalkKind | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('@')) return null;
  if (GREETING_PATTERNS.some((re) => re.test(trimmed))) return 'greeting';
  if (GRATITUDE_PATTERNS.some((re) => re.test(trimmed))) return 'gratitude';
  return null;
}
