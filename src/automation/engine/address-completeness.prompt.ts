import type { ChoiceAnswer, QuestionMap } from "src/ai-decision/ai-decision.types";

const request = require("./address-completeness.request.json") as {
  model: string;
  questions: QuestionMap;
};

export const ADDRESS_COMPLETENESS_MODEL = request.model;
export const ADDRESS_COMPLETENESS_QUESTIONS = request.questions;

export const ADDRESS_COMPLETENESS_BRANCH = {
  VALID: "valid",
  NOT_VALID: "not_valid",
  NOT_SURE: "not_sure",
} as const;

export type AddressCompletenessBranch =
  (typeof ADDRESS_COMPLETENESS_BRANCH)[keyof typeof ADDRESS_COMPLETENESS_BRANCH];

/** Same cutoffs as the address-completeness benchmark: accept >= 0.85, reject < 0.5. */
export function chooseAddressCompletenessBranch(
  addressValid: number,
  mainProblem?: string | null,
): AddressCompletenessBranch {
  const problem = mainProblem && mainProblem !== "none" ? mainProblem : "none";
  if (addressValid >= 0.80 && problem === "none") {
    return ADDRESS_COMPLETENESS_BRANCH.VALID;
  }
  if (addressValid < 0.50) {
    return ADDRESS_COMPLETENESS_BRANCH.NOT_VALID;
  }
  return ADDRESS_COMPLETENESS_BRANCH.NOT_SURE;
}

/** Jev returns a single main_problem choice; expose it as a problems list. */
export function problemsFromMainProblem(
  mainProblem?: ChoiceAnswer | null,
  minProb = 0.25,
): string[] {
  if (!mainProblem) return [];
  const probabilities = mainProblem.probabilities ?? {};
  const values = Object.values(probabilities);
  const top = values.length ? Math.max(...values) : 0;
  const fromProbs = Object.entries(probabilities)
    .filter(([key, prob]) => key !== "none" && prob >= minProb && prob >= top * 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
  const choice = mainProblem.choice;
  if (choice && choice !== "none" && !fromProbs.includes(choice)) {
    return [choice, ...fromProbs];
  }
  return fromProbs;
}