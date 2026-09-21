import type { QuestionMap } from "src/ai-decision/ai-decision.types";

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
  if (addressValid >= 0.85 && problem === "none") {
    return ADDRESS_COMPLETENESS_BRANCH.VALID;
  }
  if (addressValid < 0.5) {
    return ADDRESS_COMPLETENESS_BRANCH.NOT_VALID;
  }
  return ADDRESS_COMPLETENESS_BRANCH.NOT_SURE;
}

/** Jev returns a single main_problem choice; expose it as a problems list. */
export function problemsFromMainProblem(
  mainProblem?: string | null,
): string[] {
  if (!mainProblem || mainProblem === "none") return [];
  return [mainProblem];
}
