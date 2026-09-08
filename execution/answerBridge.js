'use strict';

/**
 * execution/answerBridge.js
 *
 * Wraps the existing answerEngine.js with a deterministic-first resolver that
 * returns both the answer AND the source (profile | cache | llm | null).
 *
 * Contract:
 *   resolveAnswer(question, options, source?)
 *     → { answer: string | null, source: 'profile' | 'cache' | 'llm' | null }
 *
 * This is NOT a replacement for answerEngine — it is a thin inspection layer.
 * The existing getAnswer() is still fully functional and is NOT modified.
 *
 * When Parallax supplies an answer through POST /execution/answer, it bypasses
 * this bridge entirely and directly calls the page interaction layer.
 *
 * Priority (mirrors answerEngine.js logic, without mutation):
 *   1. Experience override (deterministic from profile)
 *   2. Skill yes/no auto-answer (deterministic)
 *   3. Hardcoded personal facts from profile.json
 *   4. Learned answer cache (JSON files)
 *   5. Local LLM (Ollama / LMStudio) — returns source: 'llm'
 *   6. null — caller (Parallax) must ask ChatGPT
 */

const path = require('path');
const fs   = require('fs');

// Import the existing engine components — do not re-implement them.
const {
  findLearnedAnswer,
  setActiveLLM,
  setCurrentJobContext,
  setUserMaxExperience,
} = require('../ai/answerEngine');

// We need direct access to some internals to detect the source without
// actually calling the full getAnswer() (which has side-effects like saving).
// We re-expose isExperienceQuestion and checkPersonalFact by importing the
// module then monkey-patching is not needed — we read profile ourselves.
const profile = require('../config/profile.json');

const PERSONAL_FACT_MATCHERS = [
  { match: ['notice period', 'notice'],            answer: () => profile.noticePeriod },
  { match: ['relocat', 'willing to move'],          answer: () => (profile.relocate ? 'Yes' : 'No') },
  { match: ['current location', 'current city', 'residing', 'currently based', 'where are you based'],
                                                    answer: () => profile.currentLocation },
  { match: ['expected ctc', 'expected salary', 'salary expectation', 'ctc expectation', 'what is your expected'],
                                                    answer: () => profile.expectedCTC },
  { match: ['current ctc', 'current salary', 'current package'],
                                                    answer: () => profile.currentCTC || '0 LPA' },
  { match: ['total experience', 'years of experience', 'how many years', 'overall experience'],
                                                    answer: () => String(Math.max(profile.experience || 1, 1)) },
  { match: ['your name', 'full name', 'candidate name'],
                                                    answer: () => profile.fullName },
  { match: ['email', 'e-mail'],                    answer: () => profile.email },
  { match: ['phone', 'mobile', 'contact number'],  answer: () => profile.mobile },
];

function checkPersonalFact(question) {
  const q = question.toLowerCase();
  for (const fact of PERSONAL_FACT_MATCHERS) {
    if (fact.match.some(kw => q.includes(kw))) {
      return fact.answer();
    }
  }
  return null;
}

function isSkillYesNoQuestion(question, options) {
  if (!options || options.length === 0) return false;
  const hasYes = options.some(o => /^yes$/i.test(o.trim()));
  const hasNo  = options.some(o => /^no$/i.test(o.trim()));
  if (!hasYes || !hasNo) return false;
  return /do you have|have you|are you (familiar|proficient|experienced|able)|can you|did you (use|work|build|design|develop|operate)/i.test(question);
}

/**
 * Attempt to resolve an answer deterministically (no LLM call).
 * Returns { answer, source } or { answer: null, source: null } if LLM is needed.
 *
 * @param {string}   question
 * @param {string[]} options   — available radio/chip options, if any
 * @param {string}   [source='naukri']  — 'naukri' | 'workday'
 * @returns {{ answer: string | null, source: 'profile' | 'cache' | null }}
 */
function resolveAnswerDeterministic(question, options = [], source = 'naukri') {
  // 1. Skill yes/no auto-answer
  if (isSkillYesNoQuestion(question, options)) {
    const yesOpt = options.find(o => /^yes$/i.test(o.trim())) || 'Yes';
    return { answer: yesOpt, source: 'profile' };
  }

  // 2. Personal facts
  const fact = checkPersonalFact(question);
  if (fact !== null) {
    if (options && options.length > 0) {
      // Verify the fact maps to one of the options
      const lower = fact.toLowerCase();
      const matched = options.find(
        opt => opt.toLowerCase().includes(lower) || lower.includes(opt.toLowerCase())
      );
      if (matched) return { answer: matched, source: 'profile' };
      // fact doesn't match any option — fall through
    } else {
      return { answer: fact, source: 'profile' };
    }
  }

  // 3. Learned answer cache
  const cached = findLearnedAnswer(question, options, source);
  if (cached && cached.answer) {
    return { answer: cached.answer, source: 'cache' };
  }

  return { answer: null, source: null };
}

/**
 * Full resolution attempt including LLM (Ollama/LMStudio).
 * Used when Parallax decides the local LLM should try before escalating.
 *
 * @param {string}   question
 * @param {string[]} options
 * @param {string}   [formSource='naukri']
 * @returns {Promise<{ answer: string | null, source: 'profile'|'cache'|'llm'|null }>}
 */
async function resolveAnswer(question, options = [], formSource = 'naukri') {
  // Try deterministic first
  const det = resolveAnswerDeterministic(question, options, formSource);
  if (det.answer !== null) return det;

  // Try local LLM — call existing answerEngine but intercept the source
  // We import getAnswer lazily to avoid startup side-effects
  const { getAnswer } = require('../ai/answerEngine');
  try {
    const llmAnswer = await getAnswer(question, options, false, formSource);
    if (llmAnswer && llmAnswer.length > 0) {
      return { answer: llmAnswer, source: 'llm' };
    }
  } catch {
    // LLM unavailable — fall through to null
  }

  return { answer: null, source: null };
}

module.exports = {
  resolveAnswer,
  resolveAnswerDeterministic,
};
