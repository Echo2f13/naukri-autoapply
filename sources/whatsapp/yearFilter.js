'use strict';

/**
 * Evaluates graduation / batch / passout year eligibility for WhatsApp job messages.
 *
 * Rules:
 * 1. If NO graduation/passout/batch year is mentioned -> ELIGIBLE (No-year rule)
 * 2. If 2026 is explicitly mentioned in year context -> ELIGIBLE
 * 3. If contextual "26" represents the passout/batch year -> ELIGIBLE
 * 4. Any combination or range containing 2026/26 (e.g. "2025 & 26", "2025 / 2026", "2023–2026", "2025–2027", "2024, 2025, 2026, 2027") -> ELIGIBLE
 * 5. If years are explicitly mentioned but 2026/26 is NOT present/included -> REJECTED_YEAR
 *    Examples: "2025", "2027", "2024 & 2025" -> REJECTED_YEAR
 * 
 * Numbers such as "26 LPA" or "26 years exp" must NOT be interpreted as batch 2026.
 *
 * @param {string} text - Raw message or page text
 * @returns {{ eligible: boolean, hasYearEvidence: boolean, yearEvidence: string|null, reason?: string, detail?: string }}
 */
function evaluatePassoutYear(text = '') {
    if (!text || typeof text !== 'string') {
        return { eligible: true, hasYearEvidence: false, yearEvidence: null, reason: 'NO_YEAR_MENTIONED' };
    }

    const cleanText = text.replace(/[•*#_]/g, ' ');

    // 1. Explicitly labeled patterns:
    // "Batch : 2025 & 26", "Graduation: 2025 / 2026", "Passouts: 2023–2026", "YOP: 2026"
    // "anticipated graduation date in 2028", "graduating in 2027", "graduating class of 2028", "students graduating between 2025 and 2027"
    const labelMatch = cleanText.match(/\b(?:batch(?:es)?(?:\s*eligible)?|graduation(?:\s+date|\s+year)?(?:\s+in|\s+by|\s+of)?|graduating(?:\s+in|\s+by|\s+between)?|passouts?|pass\s*outs?|passed\s*out|yop|year\s*of\s*passing|class\s*of)[:\t ]+([^\n,;•|]+(?:\s*(?:&|and|\/|-|–|—|to|,)\s*[^\n,;•|]+)*)/i);

    // 2. Preceding year patterns: "2025 & 2026 Batch", "2026 passout", "2024, 2025, 2026 passouts"
    const prefixMatch = cleanText.match(/\b(202\d(?:\s*(?:&|and|\/|-|–|—|to|,)\s*(?:202\d|\d{2}))*)\s*(?:batch|passouts?|graduates?|pass-outs?)/i);

    let rawEvidence = null;
    if (labelMatch) {
        rawEvidence = labelMatch[1].trim();
    } else if (prefixMatch) {
        rawEvidence = prefixMatch[1].trim();
    }

    // 3. Fallback: Standalone batch year mentions e.g. "Batch 2026" or "Batch 26"
    if (!rawEvidence) {
        const standaloneMatch = cleanText.match(/\bbatch\s+((?:202\d|\d{2})(?:\s*(?:&|and|\/|-|–|—|to|,)\s*(?:202\d|\d{2}))*)/i);
        if (standaloneMatch) {
            rawEvidence = standaloneMatch[1].trim();
        }
    }

    // If no graduation/passout/batch year is detected, eligible under the No-Year Rule
    if (!rawEvidence) {
        return {
            eligible: true,
            hasYearEvidence: false,
            yearEvidence: null,
            reason: 'NO_YEAR_MENTIONED'
        };
    }

    // Clean evidence line to only year tokens, ranges, and delimiters
    const firstLine = rawEvidence.split('\n')[0].trim();
    // Stop if evidence runs into another labeled field or non-year text
    const cleanEvidence = firstLine.split(/(?:role|salary|package|package:|location|type|tech|apply|mode|skills|and full-time|and full time)/i)[0].trim();

    // Check if the evidence contains years at all
    const hasYearNumbers = /\b(201\d|202\d|203\d|\d{2})\b/.test(cleanEvidence);
    if (!hasYearNumbers) {
        return {
            eligible: true,
            hasYearEvidence: false,
            yearEvidence: null,
            reason: 'NO_YEAR_MENTIONED'
        };
    }

    // Check for explicit 2026
    const has2026 = /\b2026\b/.test(cleanEvidence);

    // Check for contextual 26 (must not be salary like 26 LPA, or experience like 26 yrs, or day 26)
    const has26 = /\b26\b/.test(cleanEvidence) &&
                  !/26\s*(?:lpa|k|lakhs?|lac|ctc)/i.test(cleanEvidence) &&
                  !/26\s*(?:yrs?|years?|months?)/i.test(cleanEvidence) &&
                  !/26\s*(?:am|pm)/i.test(cleanEvidence);

    if (has2026 || has26) {
        return {
            eligible: true,
            hasYearEvidence: true,
            yearEvidence: cleanEvidence,
            reason: 'YEAR_ELIGIBLE_2026'
        };
    }

    // Check for 4-digit year ranges (e.g. "2025–2027", "2025 - 2027", "2025 to 2027", "2023–2026")
    const rangeMatch4Digit = cleanEvidence.match(/\b(201\d|202\d|203\d)\s*(?:-|–|—|to|\/)\s*(201\d|202\d|203\d)\b/i);
    if (rangeMatch4Digit) {
        const start = parseInt(rangeMatch4Digit[1], 10);
        const end = parseInt(rangeMatch4Digit[2], 10);
        const minYear = Math.min(start, end);
        const maxYear = Math.max(start, end);
        if (minYear <= 2026 && 2026 <= maxYear) {
            return {
                eligible: true,
                hasYearEvidence: true,
                yearEvidence: cleanEvidence,
                reason: 'YEAR_ELIGIBLE_2026'
            };
        }
    }

    // Check for 2-digit year ranges (e.g. "25–27", "23–26")
    const rangeMatch2Digit = cleanEvidence.match(/\b([2-3]\d)\s*(?:-|–|—|to)\s*([2-3]\d)\b/i);
    if (rangeMatch2Digit) {
        const start = parseInt(rangeMatch2Digit[1], 10);
        const end = parseInt(rangeMatch2Digit[2], 10);
        const minYear = Math.min(start, end);
        const maxYear = Math.max(start, end);
        if (minYear <= 26 && 26 <= maxYear) {
            return {
                eligible: true,
                hasYearEvidence: true,
                yearEvidence: cleanEvidence,
                reason: 'YEAR_ELIGIBLE_2026'
            };
        }
    }

    // Check for "between Y1 and Y2"
    const betweenMatch = cleanText.match(/\bbetween\s+(201\d|202\d|203\d)\s+and\s+(201\d|202\d|203\d)\b/i) ||
                         cleanEvidence.match(/\bbetween\s+(201\d|202\d|203\d)\s+and\s+(201\d|202\d|203\d)\b/i);
    if (betweenMatch) {
        const start = parseInt(betweenMatch[1], 10);
        const end = parseInt(betweenMatch[2], 10);
        const minYear = Math.min(start, end);
        const maxYear = Math.max(start, end);
        if (minYear <= 2026 && 2026 <= maxYear) {
            return {
                eligible: true,
                hasYearEvidence: true,
                yearEvidence: cleanEvidence,
                reason: 'YEAR_ELIGIBLE_2026'
            };
        }
    }

    // If years are explicitly mentioned, but neither 2026 nor 26 is present or included in ranges -> REJECT
    return {
        eligible: false,
        hasYearEvidence: true,
        yearEvidence: cleanEvidence,
        reason: 'REJECTED_YEAR',
        detail: `Batch/passout year "${cleanEvidence}" does not include 2026 or 26`
    };
}

module.exports = {
    evaluatePassoutYear
};
