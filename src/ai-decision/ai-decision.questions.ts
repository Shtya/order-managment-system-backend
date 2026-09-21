import type {
  ChoiceQuestion,
  JsonValue,
  NoulQuestion,
  ScoreQuestion,
} from './ai-decision.types';

/**
 * Small builders so callers don't hand-write the question objects, and so the
 * option keys of a choice are preserved as literal types:
 *
 *   const { answers } = await ai.decide({
 *     ...,
 *     questions: {
 *       missing: q.choice('What is missing?', { none: 'Nothing', district: 'No district' }),
 *     },
 *   });
 *   answers.missing.choice; // 'none' | 'district'
 */
export const q = {
  /** Yes/no question. Optionally describe what true and false mean. */
  noul(
    instructions: JsonValue,
    criteria?: { true?: JsonValue; false?: JsonValue },
  ): NoulQuestion {
    return criteria
      ? { type: 'noul', instructions, criteria }
      : { type: 'noul', instructions };
  },

  /** Pick exactly one option. Include a "none/other" option if none may apply. */
  choice<C extends Record<string, JsonValue>>(
    instructions: JsonValue,
    criteria: C,
  ): ChoiceQuestion<C> {
    return { type: 'choice', instructions, criteria };
  },

  /** Rate on an ordered scale, lowest level first (at least 2 levels). */
  score(instructions: JsonValue, levels: readonly JsonValue[]): ScoreQuestion {
    return { type: 'score', instructions, criteria: [...levels] };
  },
};
