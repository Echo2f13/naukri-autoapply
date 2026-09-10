'use strict';

/**
  * Provenance metadata for recruiter question answers.
  */
const AnswerSource = {
    VERIFIED_PROFILE: 'VERIFIED_PROFILE', // Sourced from immutable profile.json
    VERIFIED_CACHE:   'VERIFIED_CACHE',   // Sourced from approved cached answers
    LLM_INFERRED:     'LLM_INFERRED',     // Sourced from local LLM inference
    MANUAL_PROMPT:    'MANUAL_PROMPT'     // Sourced from manual user terminal input
};

const Confidence = {
    HIGH:   'HIGH',   // Guaranteed factual truth
    MEDIUM: 'MEDIUM', // High probability LLM inference
    LOW:    'LOW'     // Uncertain guess
};

/**
  * Creates a structured answer with provenance metadata.
  * @param {string} answer 
  * @param {keyof AnswerSource} source 
  * @param {keyof Confidence} confidence 
  * @param {string} question 
  * @returns {{ answer: string, source: string, confidence: string, question: string, timestamp: Date }}
  */
function createResolvedAnswer(answer, source, confidence, question = '') {
    return {
        answer: String(answer).trim(),
        source: AnswerSource[source] || AnswerSource.LLM_INFERRED,
        get provenance() { return this.source; },
        confidence: Confidence[confidence] || Confidence.LOW,
        question,
        timestamp: new Date()
    };
}

module.exports = {
    AnswerSource,
    Provenance: AnswerSource,
    Confidence,
    createResolvedAnswer
};
