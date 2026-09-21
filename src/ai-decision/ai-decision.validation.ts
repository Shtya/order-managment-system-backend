import { AiDecisionValidationError } from './ai-decision.errors';
import type { DecideRequest, QuestionMap } from './ai-decision.types';

/**
 * Limits taken from TypeSafe's docs and community guides. If the provider's
 * docs change, adjust here (or move them into provider options).
 */
export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2; // official docs: at least two levels
export const MAX_SCORE_LEVELS = 10; // community guides; verify against the docs

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates the request BEFORE anything is reserved or sent, so a bad request
 * never touches the wallet or the provider. Throws AiDecisionValidationError.
 */
export function assertValidRequest(request: DecideRequest): void {
  const issues: string[] = [];
  const state: unknown = request?.state;
  const questions: unknown = request?.questions;

  if (typeof state === 'string') {
    if (!state.trim()) issues.push('state must not be empty');
  } else if (state === null || typeof state !== 'object') {
    issues.push('state must be a string, an object or an array');
  }

  if (!isPlainObject(questions)) {
    issues.push('questions must be an object map of id -> question');
  } else {
    const entries = Object.entries(questions);
    if (entries.length === 0) issues.push('questions must contain at least one question');
    for (const [id, question] of entries) validateQuestion(id, question, issues);
  }

  if (issues.length) throw new AiDecisionValidationError(issues);
}

function validateQuestion(id: string, question: unknown, issues: string[]): void {
  if (!isPlainObject(question)) {
    issues.push(`questions.${id} must be an object`);
    return;
  }
  if (question.instructions === undefined) {
    issues.push(`questions.${id}.instructions is required`);
  }

  switch (question.type) {
    case 'noul': {
      const c = question.criteria;
      if (c !== undefined) {
        if (!isPlainObject(c)) {
          issues.push(`questions.${id}.criteria must be an object with true/false`);
        } else {
          for (const key of Object.keys(c)) {
            if (key !== 'true' && key !== 'false') {
              issues.push(`questions.${id}.criteria has unknown key "${key}"`);
            }
          }
        }
      }
      break;
    }
    case 'choice': {
      const c = question.criteria;
      if (!isPlainObject(c)) {
        issues.push(`questions.${id}.criteria must be an object of option -> description`);
      } else {
        const n = Object.keys(c).length;
        if (n < MIN_CHOICE_OPTIONS || n > MAX_CHOICE_OPTIONS) {
          issues.push(
            `questions.${id}.criteria must have ${MIN_CHOICE_OPTIONS}-${MAX_CHOICE_OPTIONS} options (got ${n})`,
          );
        }
      }
      break;
    }
    case 'score': {
      const c = question.criteria;
      if (!Array.isArray(c)) {
        issues.push(`questions.${id}.criteria must be an ordered array of levels`);
      } else if (c.length < MIN_SCORE_LEVELS || c.length > MAX_SCORE_LEVELS) {
        issues.push(
          `questions.${id}.criteria must have ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels (got ${c.length})`,
        );
      }
      break;
    }
    default:
      issues.push(`questions.${id}.type must be "noul", "choice" or "score"`);
  }
}

/**
 * Checks a provider response against the request: one answer per question,
 * matching type, sane values. Returns a list of problems (empty = OK).
 * The shape guarantee from the provider says nothing about correctness, this
 * only protects your code from a malformed payload.
 */
export function validateAnswers(questions: QuestionMap, answers: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(answers)) return ['answers is not an object'];

  for (const [id, question] of Object.entries(questions)) {
    const a = answers[id];
    if (!isPlainObject(a)) {
      issues.push(`missing answer for "${id}"`);
      continue;
    }
    if (a.type !== question.type) {
      issues.push(`answer "${id}" has type ${String(a.type)}, expected ${question.type}`);
      continue;
    }

    if (question.type === 'noul') {
      if (!isProbability(a.noul)) issues.push(`answer "${id}".noul must be a number in [0,1]`);
    } else if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      if (typeof a.choice !== 'string' || !options.includes(a.choice)) {
        issues.push(`answer "${id}".choice is not one of the declared options`);
      }
      if (!isProbability(a.confidence)) issues.push(`answer "${id}".confidence must be in [0,1]`);
      if (!isPlainObject(a.probabilities)) issues.push(`answer "${id}".probabilities missing`);
    } else if (question.type === 'score') {
      if (typeof a.score !== 'number' || !Number.isFinite(a.score)) {
        issues.push(`answer "${id}".score must be a finite number`);
      }
      if (!isProbability(a.confidence)) issues.push(`answer "${id}".confidence must be in [0,1]`);
      if (!isPlainObject(a.probabilities)) issues.push(`answer "${id}".probabilities missing`);
    }
  }
  return issues;
}

const isProbability = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
