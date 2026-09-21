/**
 * Shared types for the AI decision layer.
 *
 * These types are provider-agnostic. Jev (TypeSafe "System One") is the first
 * implementation, but nothing here mentions it: a future provider only has to
 * accept a DecideRequest and return a DecideResult.
 */

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/** What is being judged: plain text, or structured data (record, chat log, address...). */
export type DecisionState = string | JsonValue[] | { [key: string]: JsonValue };

/** Yes/no. The answer is the probability of "yes" (0..1). */
export interface NoulQuestion {
  type: 'noul';
  instructions: JsonValue;
  criteria?: { true?: JsonValue; false?: JsonValue };
}

/** Pick exactly one option. `criteria` maps option key -> description (null = no extra detail). */
export interface ChoiceQuestion<
  C extends Record<string, JsonValue> = Record<string, JsonValue>,
> {
  type: 'choice';
  instructions: JsonValue;
  criteria: C;
}

/** Rate on an ordered scale. `criteria` lists the levels, lowest first (at least 2). */
export interface ScoreQuestion {
  type: 'score';
  instructions: JsonValue;
  criteria: JsonValue[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Question id (your key, only used by your code) -> question. */
export type QuestionMap = Record<string, DecisionQuestion>;

/** The whole request. Any state, any number and mix of questions. */
export interface DecideRequest<Q extends QuestionMap = QuestionMap> {
  state: DecisionState;
  questions: Q;
}

/** Per-call overrides. Everything is optional. */
export interface DecideOptions {
  /** Override the provider's default model (use a pinned version, e.g. "jev-1.13.0"). */
  model?: string;
  /** Override the provider's default timeout. */
  timeoutMs?: number;
  /** Cancel the call from the outside. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Answer shapes (typed from the question map)
// ---------------------------------------------------------------------------

export interface NoulAnswer {
  type: 'noul';
  /** Probability of "yes", 0..1. */
  noul: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: 'choice';
  choice: K;
  confidence: number;
  probabilities: Record<K, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level; can land between levels (e.g. 1.34). */
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type AnswerOf<Q extends DecisionQuestion> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<Extract<keyof C, string>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

/** One typed answer per question id, e.g. answers.missing.choice is 'none' | 'district' | ... */
export type DecisionAnswers<Q extends QuestionMap> = {
  [K in keyof Q]: AnswerOf<Q[K]>;
};

// ---------------------------------------------------------------------------
// Usage and result
// ---------------------------------------------------------------------------

/**
 * Usage in the shape the billing operation expects.
 * `modelId` is the model that was REQUESTED (used to look up the price),
 * not the version the provider reports back.
 */
export interface DecisionUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface DecideResult<Q extends QuestionMap = QuestionMap> {
  answers: DecisionAnswers<Q>;
  usage: DecisionUsage;
  /** Exact model version the provider says answered. Log it. */
  modelVersion: string;
}
