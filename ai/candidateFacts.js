'use strict';

const profile = require('../config/profile');

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * CENTRALIZED CANONICAL CANDIDATE FACT RESOLVER & QUESTION MAPPING
 * ══════════════════════════════════════════════════════════════════════════════
 * Strictly enforces:
 * 1. Canonical profile is ALWAYS the first and primary answer source.
 * 2. Deterministic derived facts from canonical profile.
 * 3. Exact & normalized ATS option matching (whitespace, punctuation, abbreviations).
 * 4. Zero LLM guessing for known personal facts.
 * 5. Rejection of contradictory or invalid structured inputs (e.g. State -> Amazon).
 */

/**
 * Normalizes question string by stripping leading asterisks, punctuation, and extra whitespace.
 */
function normalizeQuestionText(q) {
    if (!q || typeof q !== 'string') return '';
    return q
        .replace(/^[*•\-\s]+/, '')
        .replace(/[*:]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Strips whitespace, punctuation, and converts to lowercase for clean matching.
 */
function cleanString(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolves a candidate fact directly from the canonical profile.
 * Returns { resolved: true, answer: string, canonicalKey: string } or { resolved: false, answer: null }.
 */
function resolveCandidateFact(questionText, sectionContext = '', customProfile = null) {
    const p = customProfile || profile;
    const raw = normalizeQuestionText(questionText);
    const qLower = raw.toLowerCase();
    const sLower = (sectionContext || '').toLowerCase();

    const makeRes = (answer, canonicalKey, extra = {}) => ({
        resolved: true,
        answer,
        canonicalKey,
        path: canonicalKey,
        ...extra
    });

    // ── 1. Education: Degree / Highest Education ─────────────────────────────
    if (
        /^(highest education|highest degree|highest qualification|degree|qualification|course|education level)$/i.test(raw) ||
        /\b(highest education|highest degree|highest qualification|degree type|current degree)\b/i.test(qLower)
    ) {
        const degree = p.education?.degree || p.degree || 'Integrated M.Tech';
        const degreeType = p.education?.degreeType || p.degreeType || 'M.Tech';
        return makeRes(degree, 'education.degree', { degreeType });
    }

    // ── 2. Education: Institution / University / College ─────────────────────
    if (
        /\b(institute name|institution name|name of institute|name of institution|university|college|institution|institute|school|campus)\b/i.test(qLower) &&
        !/\b(city|state|location|address|pin|zip)\b/i.test(qLower)
    ) {
        const institution = p.education?.institution || p.education?.university || p.university || 'Vellore Institute of Technology';
        return makeRes(institution, 'education.institution');
    }

    // ── 3. Education: Field of Study / Major / Branch ────────────────────────
    if (
        /\b(field of study|major|branch|specialization|discipline|stream|course name)\b/i.test(qLower)
    ) {
        const field = p.education?.field || p.education?.major || p.major || 'Computer Science and Engineering';
        return makeRes(field, 'education.field');
    }

    // ── 4. Education: City & State ───────────────────────────────────────────
    if (
        /\b(education city|university city|college city|institute city|campus city)\b/i.test(qLower) ||
        (/\b(city)\b/i.test(qLower) && (/\b(education|university|college|institute|campus|academic)\b/i.test(qLower) || /\b(education|academic|qualification)\b/i.test(sLower)))
    ) {
        const city = p.education?.educationCity || p.education?.city || 'Vellore';
        return makeRes(city, 'education.city');
    }

    if (
        /\b(education state|university state|college state|institute state|campus state)\b/i.test(qLower) ||
        (/\b(state)\b/i.test(qLower) && (/\b(education|university|college|institute|campus|academic)\b/i.test(qLower) || /\b(education|academic|qualification)\b/i.test(sLower)))
    ) {
        const state = p.education?.educationState || p.education?.state || 'Tamil Nadu';
        return makeRes(state, 'education.state');
    }

    // ── 5. Education: Graduation / Passout Year ──────────────────────────────
    if (
        /\b(graduation year|year of graduation|passout year|pass out year|passing year|year of passing|batch)\b/i.test(qLower)
    ) {
        const year = String(p.education?.passoutYear || p.education?.endYear || p.passoutYear || '2026');
        return makeRes(year, 'education.passoutYear');
    }

    // ── 6. Nationality & Citizenship ─────────────────────────────────────────
    if (/\b(nationality)\b/i.test(qLower)) {
        const nat = p.nationality || 'Indian';
        return makeRes(nat, 'nationality');
    }

    if (/\b(citizenship|current citizenship)\b/i.test(qLower)) {
        const citizen = p.citizenship || p.nationality || 'Indian';
        return makeRes(citizen, 'citizenship');
    }

    // ── 7. Marital Status ───────────────────────────────────────────────────
    if (/\b(marital status|marital)\b/i.test(qLower)) {
        const status = p.maritalStatus || 'Single';
        return makeRes(status, 'maritalStatus');
    }

    // ── 8. Gender / Sex ─────────────────────────────────────────────────────
    if (/^(gender|sex)$/i.test(raw) || /\b(gender|sex)\b/i.test(qLower)) {
        const gender = p.gender || 'Male';
        return makeRes(gender, 'gender');
    }

    // ── 9. Relocation Preference ────────────────────────────────────
    if (/\b(relocat|willing to move|open to relocat|willingness to relocate)\b/i.test(qLower)) {
        const willRelocate = p.willingToRelocate !== undefined
            ? p.willingToRelocate
            : (p.relocate !== undefined ? p.relocate : true);
        return makeRes(willRelocate ? 'Yes' : 'No', 'willingToRelocate');
    }

    // ── 10. Travel Preference ───────────────────────────────────────────────
    if (/\b(willingness to travel|willing to travel|open to travel|travel required|travel)\b/i.test(qLower)) {
        const willTravel = p.willingToTravel || p.preferences?.willingToTravel || 'Yes';
        return makeRes(willTravel, 'willingToTravel');
    }

    // ── 11. Passport ────────────────────────────────────────────────────────
    if (/\b(passport|valid passport|hold a passport|have a passport)\b/i.test(qLower)) {
        const pass = p.hasPassport || 'Yes';
        return makeRes(pass, 'hasPassport');
    }

    // ── 12. Compensation Currencies ─────────────────────────────────────────
    // Current / Last compensation currency MUST be checked BEFORE expected / general currency
    if (
        /\b(current|last|previous)\b/i.test(qLower) &&
        /\b(currency)\b/i.test(qLower)
    ) {
        const curr = p.currentCurrency || 'INR';
        return makeRes(curr, 'profile.currentCurrency');
    }

    if (
        (/\b(expected|target|desired|preferred)\b/i.test(qLower) && /\b(currency)\b/i.test(qLower)) ||
        /\b(expected.*currency|currency.*expected)\b/i.test(qLower) ||
        /^(currency|select currency)$/i.test(raw) ||
        (/\b(currency)\b/i.test(qLower) && /\b(compensation|salary|ctc)\b/i.test(qLower))
    ) {
        const curr = p.expectedCurrency || 'INR';
        return makeRes(curr, 'profile.expectedCurrency');
    }

    // ── 13. Compensation Types (e.g. Annual, Monthly, Hourly) ───────────────
    // Strictly requires explicit canonical profile value; if absent, triggers HUMAN_INTERVENTION
    if (/\b(compensation.*type|type.*compensation|salary.*type|ctc.*type)\b/i.test(qLower)) {
        if (/\b(current|last|previous)\b/i.test(qLower)) {
            if (p.currentCompensationType) {
                return makeRes(p.currentCompensationType, 'profile.currentCompensationType');
            }
            return { resolved: false, answer: null };
        }
        if (/\b(expected|target|desired|preferred)\b/i.test(qLower) || !/\b(current|last)\b/i.test(qLower)) {
            if (p.expectedCompensationType) {
                return makeRes(p.expectedCompensationType, 'profile.expectedCompensationType');
            }
            return { resolved: false, answer: null };
        }
    }

    // ── 14. Compensation Values ─────────────────────────────────────────────
    if (/\b(expected ctc|expected salary|salary expectation|ctc expectation|what is your expected)\b/i.test(qLower)) {
        const rawCtc = p.expectedCTC || '800000';
        const num = parseFloat(String(rawCtc).replace(/[^0-9.]/g, ''));
        const inLakhs = !isNaN(num) && num >= 10000 ? String(Math.round(num / 100000)) : '8';
        if (/lakh|lacs|lac|lpa/i.test(qLower)) {
            return makeRes(inLakhs, 'expectedCTC');
        }
        return makeRes(String(rawCtc), 'expectedCTC');
    }

    if (/\b(current ctc|current salary|current package|last drawn salary)\b/i.test(qLower)) {
        const rawCtc = p.currentCTC || '0';
        const num = parseFloat(String(rawCtc).replace(/[^0-9.]/g, ''));
        const inLakhs = !isNaN(num) && num >= 10000 ? String(Math.round(num / 100000)) : '0';
        if (/lakh|lacs|lac|lpa/i.test(qLower)) {
            return makeRes(inLakhs, 'currentCTC');
        }
        return makeRes(String(rawCtc), 'currentCTC');
    }

    // ── 15. Permanent Address ───────────────────────────────────────────────
    if (
        /\b(permanent address.*state|permanent state)\b/i.test(qLower) ||
        (/\b(state)\b/i.test(qLower) && /\b(permanent)\b/i.test(sLower))
    ) {
        const state = p.permanentAddress?.state || p.address?.state || p.currentState || 'Telangana';
        return makeRes(state, 'permanentAddress.state');
    }

    if (
        /\b(permanent address.*city|permanent city)\b/i.test(qLower) ||
        (/\b(city)\b/i.test(qLower) && /\b(permanent)\b/i.test(sLower))
    ) {
        const city = p.permanentAddress?.city || p.address?.city || p.currentCity || 'Hyderabad';
        return makeRes(city, 'permanentAddress.city');
    }

    if (
        /\b(permanent address.*country|permanent country)\b/i.test(qLower) ||
        (/\b(country)\b/i.test(qLower) && /\b(permanent)\b/i.test(sLower))
    ) {
        const country = p.permanentAddress?.country || p.address?.country || 'India';
        return makeRes(country, 'permanentAddress.country');
    }

    if (/\b(permanent address.*pin|permanent address.*zip|permanent pin|permanent zip)\b/i.test(qLower)) {
        const zip = p.permanentAddress?.zipCode || p.address?.pinCode || p.address?.zipCode || '500001';
        return makeRes(zip, 'permanentAddress.zipCode');
    }

    if (/\b(permanent address)\b/i.test(qLower) && !/\b(city|state|country|zip|pin)\b/i.test(qLower)) {
        const street = p.permanentAddress?.street || p.address?.street || 'Hyderabad, Telangana';
        return makeRes(street, 'permanentAddress.street');
    }

    // ── 16. Current Address / Location ──────────────────────────────────────
    if (
        /\b(current address.*state|current state|present state)\b/i.test(qLower) ||
        raw === 'state' ||
        (/\b(state)\b/i.test(qLower) && (/\b(current|present|address|personal|contact)\b/i.test(sLower) || !sLower))
    ) {
        const state = p.currentState || p.address?.state || 'Telangana';
        return makeRes(state, 'currentAddress.state');
    }

    if (
        /\b(current address.*city|current city|present city|location city)\b/i.test(qLower) ||
        raw === 'city' ||
        (/\b(city)\b/i.test(qLower) && (/\b(current|present|address|personal|contact)\b/i.test(sLower) || !sLower))
    ) {
        const city = p.currentCity || p.address?.city || p.currentLocation || 'Hyderabad';
        return makeRes(city, 'currentAddress.city');
    }

    if (
        /\b(current address.*country|current country|present country)\b/i.test(qLower) ||
        raw === 'country' ||
        (/\b(country)\b/i.test(qLower) && (/\b(current|present|address|personal|contact)\b/i.test(sLower) || !sLower))
    ) {
        const country = p.address?.country || 'India';
        return makeRes(country, 'currentAddress.country');
    }

    if (/\b(current address.*pin|current address.*zip|current pin|current zip)\b/i.test(qLower) || /^(zip code|pin code|postal code)$/i.test(raw)) {
        const zip = p.address?.pinCode || p.address?.zipCode || '500001';
        return makeRes(zip, 'currentAddress.zipCode');
    }

    if (/\b(current address|present address|address)\b/i.test(qLower) && !/\b(city|state|country|zip|pin)\b/i.test(qLower)) {
        const street = p.address?.street || 'Hyderabad, Telangana';
        return makeRes(street, 'currentAddress.street');
    }

    // ── 17. Immigration Status (Strict Invariant) ───────────────────────────
    // STRICT RULE: Do NOT infer Immigration Status from workAuthorization.isAuthorized,
    // needsSponsorship, nationality, or citizenship. If absent from canonical profile,
    // it MUST return resolved: false to trigger HUMAN_INTERVENTION. Zero guessing allowed.
    if (/\b(immigration status|immigration|visa status)\b/i.test(qLower)) {
        if (p.immigrationStatus) {
            return makeRes(p.immigrationStatus, 'profile.immigrationStatus');
        }
        return { resolved: false, answer: null };
    }

    // ── 18. Work Authorization & Sponsorship ────────────────────────────────
    if (/\b(sponsorship|require sponsorship|need sponsorship|visa sponsorship)\b/i.test(qLower)) {
        return makeRes('No', 'workAuthorization.needsSponsorship');
    }

    if (
        (/\b(legally authorized|authorized to work|authorization to work|eligible to work)\b/i.test(qLower)) &&
        !/\b(immigration status|visa status)\b/i.test(qLower)
    ) {
        return makeRes('Yes', 'workAuthorization.isAuthorized');
    }

    // ── 19. Contact Info ────────────────────────────────────────────────────
    if (/\b(email|e-mail)\b/i.test(qLower)) {
        const email = p.email || '';
        return makeRes(email, 'email');
    }

    if (/\b(phone|mobile|cell|contact number)\b/i.test(qLower)) {
        const phone = p.mobile || p.phone || '';
        return makeRes(phone, 'mobile');
    }

    if (/\b(full name|your name|candidate name)\b/i.test(qLower)) {
        const name = p.fullName || p.name || 'Kota Manish Dev';
        return makeRes(name, 'fullName');
    }

    if (/\b(first name)\b/i.test(qLower)) {
        const fname = p.firstName || (p.fullName || '').split(' ')[0] || '';
        return makeRes(fname, 'firstName');
    }

    if (/\b(last name|surname)\b/i.test(qLower)) {
        const lname = p.lastName || (p.fullName || '').split(' ').slice(1).join(' ') || '';
        return makeRes(lname, 'lastName');
    }

    return { resolved: false, answer: null };
}

/**
 * Checks whether a question asks for sensitive or personal facts that MUST NEVER be guessed by an LLM.
 */
function isPersonalFactQuestion(questionText) {
    if (!questionText || typeof questionText !== 'string') return false;
    const qLower = questionText.toLowerCase();

    const personalPatterns = [
        /\b(nationality|citizenship)\b/,
        /\b(marital status|marital)\b/,
        /\b(passport|visa|immigration|immigration status|visa status)\b/,
        /\b(education|degree|qualification|institute|institution|university|college|school)\b/,
        /\b(compensation|salary|ctc|currency|compensation type)\b/,
        /\b(address|street|city|state|zip|postal|country)\b/,
        /\b(phone|mobile|email|name|dob|birth)\b/,
        /\b(graduation|passout|batch)\b/,
        /\b(work authorization|authorized to work|authorization to work|legally authorized|eligible to work|sponsorship|visa)\b/,
        /\b(notice period|relocat|travel)\b/,
        /\b(license|certificate|certification|clearance)\b/,
        /\b(experience|years of experience|yoe|employment|job title|company|employer)\b/
    ];

    return personalPatterns.some(pat => pat.test(qLower));
}

/**
 * Deterministically matches a canonical answer against ATS dropdown/combobox options.
 * Supports:
 * - Exact match
 * - Normalized whitespace & casing
 * - Punctuation & Unicode normalization
 * - Domain-specific equivalences (Degree, Currency, Institution, Nationality)
 * - Additional ATS description matching (e.g. "Master's Degree" vs "Master's Degree (±18 years)")
 * - Strictly prevents unsafe ambiguous matching!
 *
 * @param {string[]} options - Available options on page
 * @param {string} canonicalAnswer - Resolved canonical answer
 * @param {string} [questionText=''] - The question context
 * @returns {{ matched: boolean, selectedOption: string|null, ambiguous: boolean, matchingOptions: string[] }}
 */
function matchAtsOption(options, canonicalAnswer, questionText = '') {
    if (!canonicalAnswer || !Array.isArray(options) || options.length === 0) {
        return { matched: false, selectedOption: null, ambiguous: false, matchingOptions: [] };
    }

    const cleanTarget = cleanString(canonicalAnswer);
    const targetLower = canonicalAnswer.trim().toLowerCase();

    // 1. Exact match (case-insensitive & trimmed)
    const exact = options.find(o => o.trim().toLowerCase() === targetLower);
    if (exact) {
        return { matched: true, selectedOption: exact, ambiguous: false, matchingOptions: [exact] };
    }

    // 2. Normalized whitespace & punctuation match
    const normalizedMatches = options.filter(o => cleanString(o) === cleanTarget);
    if (normalizedMatches.length === 1) {
        return { matched: true, selectedOption: normalizedMatches[0], ambiguous: false, matchingOptions: normalizedMatches };
    }
    if (normalizedMatches.length > 1) {
        return { matched: false, selectedOption: null, ambiguous: true, matchingOptions: normalizedMatches };
    }

    // 3. Domain Equivalence Rules:
    // A. Degree Equivalence (e.g. "Integrated M.Tech" -> "Master's Degree (±18 years)")
    const isDegreeQuestion = /\b(degree|education|qualification)\b/i.test(questionText) ||
                             /\b(m\.tech|master|b\.tech|bachelor|phd|doctorate)\b/i.test(canonicalAnswer);
    if (isDegreeQuestion) {
        const isMaster = /\b(m\.tech|mtech|master|ms|m\.s|m\.e)\b/i.test(canonicalAnswer);
        const isBachelor = /\b(b\.tech|btech|bachelor|bs|b\.s|b\.e)\b/i.test(canonicalAnswer);

        let degreeCandidates = [];
        if (isMaster) {
            degreeCandidates = options.filter(o => {
                const oClean = cleanString(o);
                return (
                    oClean.includes('master') ||
                    oClean.includes('post graduate') ||
                    oClean.includes('postgraduate') ||
                    /\bm\s*tech\b/i.test(o)
                );
            });

            // If canonicalAnswer is "Integrated M.Tech", strictly verify trusted mapping
            if (/integrated/i.test(canonicalAnswer)) {
                // 1. If options explicitly contain "integrated", choose that
                const integratedOption = degreeCandidates.find(o => /integrated/i.test(o));
                if (integratedOption) {
                    return {
                        matched: true,
                        selectedOption: integratedOption,
                        ambiguous: false,
                        matchingOptions: [integratedOption],
                        trustReason: 'Option explicitly specifies Integrated degree'
                    };
                }
                // 2. Check if mapping to generic Master's is explicitly trusted in profile.education
                const trustedDegreeMap = profile.education?.trustedAtsDegreeMappings || {};
                const trustedOption = degreeCandidates.find(o => {
                    return Object.keys(trustedDegreeMap).some(k => cleanString(k) === cleanString(o) || cleanString(o).includes(cleanString(k)));
                });
                if (trustedOption) {
                    const matchedKey = Object.keys(trustedDegreeMap).find(k => cleanString(k) === cleanString(trustedOption) || cleanString(trustedOption).includes(cleanString(k)));
                    return {
                        matched: true,
                        selectedOption: trustedOption,
                        ambiguous: false,
                        matchingOptions: [trustedOption],
                        trustReason: trustedDegreeMap[matchedKey] || 'Explicitly configured in profile.education.trustedAtsDegreeMappings'
                    };
                }
                // 3. Not explicitly trusted -> do NOT blindly equate
                return {
                    matched: false,
                    selectedOption: null,
                    ambiguous: false,
                    matchingOptions: degreeCandidates,
                    trustReason: 'BLOCKED: Integrated M.Tech cannot be blindly equated with Master\'s Degree without explicit trusted mapping'
                };
            }
        } else if (isBachelor) {
            degreeCandidates = options.filter(o => {
                const oClean = cleanString(o);
                return (
                    oClean.includes('bachelor') ||
                    oClean.includes('undergraduate') ||
                    /\bb\s*tech\b/i.test(o)
                );
            });
        }

        if (degreeCandidates.length === 1) {
            return { matched: true, selectedOption: degreeCandidates[0], ambiguous: false, matchingOptions: degreeCandidates, trustReason: 'Unique matching degree level' };
        }
        if (degreeCandidates.length > 1) {
            // Check if one candidate is a closer match (e.g. contains exact words)
            const exactSub = degreeCandidates.filter(c => cleanString(c).includes(cleanTarget) || cleanTarget.includes(cleanString(c)));
            if (exactSub.length === 1) {
                return { matched: true, selectedOption: exactSub[0], ambiguous: false, matchingOptions: exactSub, trustReason: 'Exact substring degree match' };
            }
            return { matched: false, selectedOption: null, ambiguous: true, matchingOptions: degreeCandidates, trustReason: 'Ambiguous degree options' };
        }
    }

    // B. Currency Equivalence (e.g. "INR" -> "INR - Indian Rupee", "INR (₹)")
    const isCurrencyQuestion = /\b(currency)\b/i.test(questionText) || /^(inr|usd|eur|gbp|cad|aud)$/i.test(canonicalAnswer);
    if (isCurrencyQuestion) {
        const currCode = canonicalAnswer.trim().toUpperCase();
        const currMatches = options.filter(o => {
            const oUpper = o.toUpperCase();
            return (
                oUpper === currCode ||
                new RegExp(`\\b${currCode}\\b`).test(oUpper) ||
                (currCode === 'INR' && oUpper.includes('INDIAN RUPEE')) ||
                (currCode === 'USD' && oUpper.includes('US DOLLAR'))
            );
        });
        if (currMatches.length === 1) {
            return { matched: true, selectedOption: currMatches[0], ambiguous: false, matchingOptions: currMatches };
        }
        if (currMatches.length > 1) {
            // Prefer option that starts with currency code
            const startsWithCode = currMatches.filter(m => m.trim().toUpperCase().startsWith(currCode));
            if (startsWithCode.length === 1) {
                return { matched: true, selectedOption: startsWithCode[0], ambiguous: false, matchingOptions: startsWithCode };
            }
            return { matched: false, selectedOption: null, ambiguous: true, matchingOptions: currMatches };
        }
    }

    // C. Institution / University Equivalence (e.g. "Vellore Institute of Technology" -> "Vellore Institute of Technology, Vellore" or "VIT")
    const isInstitutionQuestion = /\b(institute|university|college|school)\b/i.test(questionText);
    const isVitTarget = cleanTarget.includes('vellore') || /\bvit\b/i.test(cleanTarget);
    if (isInstitutionQuestion || isVitTarget) {
        const instMatches = options.filter(o => {
            const oClean = cleanString(o);
            if (oClean === cleanTarget) return true;
            if (cleanTarget.length >= 4 && (oClean.startsWith(cleanTarget) || cleanTarget.startsWith(oClean))) return true;
            if (isVitTarget && (oClean.includes('vellore institute of technology') || /\bvit\s*(university|vellore)?\b/i.test(oClean))) {
                return true;
            }
            return false;
        });
        if (instMatches.length === 1) {
            return { matched: true, selectedOption: instMatches[0], ambiguous: false, matchingOptions: instMatches };
        }
        if (instMatches.length > 1) {
            // Check for exact main campus match
            const velloreCampus = instMatches.filter(m => /vellore/i.test(m));
            if (velloreCampus.length === 1) {
                return { matched: true, selectedOption: velloreCampus[0], ambiguous: false, matchingOptions: velloreCampus };
            }
            return { matched: false, selectedOption: null, ambiguous: true, matchingOptions: instMatches };
        }
    }

    // D. Nationality & Citizenship Equivalence (e.g. "Indian" <-> "India")
    const isNationalityQuestion = /\b(nationality|citizenship)\b/i.test(questionText);
    if (isNationalityQuestion || cleanTarget === 'indian' || cleanTarget === 'india') {
        const natMatches = options.filter(o => {
            const oClean = cleanString(o);
            return oClean === 'indian' || oClean === 'india' || oClean.includes('india');
        });
        if (natMatches.length === 1) {
            return { matched: true, selectedOption: natMatches[0], ambiguous: false, matchingOptions: natMatches };
        }
        if (natMatches.length > 1) {
            // Prefer "Indian" for nationality, "India" for citizenship/country
            const preferred = natMatches.find(m => cleanString(m) === cleanTarget);
            if (preferred) {
                return { matched: true, selectedOption: preferred, ambiguous: false, matchingOptions: [preferred] };
            }
            return { matched: false, selectedOption: null, ambiguous: true, matchingOptions: natMatches };
        }
    }

    // 4. Substring & Explanatory Metadata Matching (e.g. option has "(±18 years)")
    // Answer must be a substantial substring (at least 4 chars) and match uniquely!
    if (cleanTarget.length >= 4) {
        const subMatches = options.filter(o => {
            const oClean = cleanString(o);
            return oClean.includes(cleanTarget) || cleanTarget.includes(oClean);
        });
        if (subMatches.length === 1) {
            return { matched: true, selectedOption: subMatches[0], ambiguous: false, matchingOptions: subMatches };
        }
        if (subMatches.length > 1) {
            return { matched: false, selectedOption: null, ambiguous: true, matchingOptions: subMatches };
        }
    }

    return { matched: false, selectedOption: null, ambiguous: false, matchingOptions: [] };
}

/**
 * Validates whether an answer to a structured field is plausible and does not conflict with canonical profile.
 * Prevents obvious bad answers (e.g. Permanent Address-State -> Amazon).
 *
 * @param {string} fieldName - The question/field name
 * @param {string} value - The candidate answer value
 * @returns {{ valid: boolean, reason?: string, message?: string }}
 */
function validateStructuredField(fieldName, value) {
    if (!value || typeof value !== 'string') {
        return { valid: false, reason: 'EMPTY_VALUE', message: 'Value cannot be empty' };
    }

    const valClean = value.trim();
    const valLower = valClean.toLowerCase();
    const qLower = fieldName.toLowerCase();

    // 1. State / City validation: Must not be IT company, tech stack, or job title!
    const isLocationField = /\b(state|city|country|hometown|location)\b/i.test(qLower);
    if (isLocationField) {
        const suspiciousWords = [
            'amazon', 'google', 'microsoft', 'meta', 'apple', 'infosys', 'tcs', 'wipro', 'cognizant', 'accenture',
            'birlasoft', 'capgemini', 'oracle', 'cisco', 'ibm', 'intel', 'nvidia', 'uber', 'naukri', 'linkedin',
            'developer', 'engineer', 'architect', 'analyst', 'intern', 'manager', 'lead',
            'python', 'java', 'javascript', 'react', 'node', 'django', 'golang', 'docker', 'aws'
        ];
        if (suspiciousWords.includes(valLower)) {
            return {
                valid: false,
                reason: 'STATE_CONTAINS_EMPLOYER_OR_TECH',
                message: `"${valClean}" is an employer or technical keyword, not a valid geographical location for "${fieldName}".`
            };
        }
    }

    // 2. Currency validation: Must be a plausible currency code or name
    const isCurrencyField = /\b(currency)\b/i.test(qLower);
    if (isCurrencyField) {
        const validCurrencies = ['inr', 'usd', 'eur', 'gbp', 'cad', 'aud', 'sgd', 'jpy', 'cny', 'chf', 'rupee', 'dollar', 'euro', 'pound'];
        const hasValidCurrency = validCurrencies.some(c => valLower.includes(c));
        if (!hasValidCurrency) {
            return {
                valid: false,
                reason: 'INVALID_CURRENCY',
                message: `"${valClean}" is not a recognized currency for "${fieldName}".`
            };
        }
    }

    // 3. Nationality / Citizenship validation
    const isNationalityField = /\b(nationality|citizenship)\b/i.test(qLower);
    if (isNationalityField) {
        const suspiciousWords = [
            'amazon', 'google', 'microsoft', 'meta', 'apple', 'infosys', 'tcs', 'wipro', 'cognizant', 'accenture',
            'birlasoft', 'capgemini', 'oracle', 'cisco', 'ibm', 'intel', 'nvidia', 'uber', 'naukri', 'linkedin',
            'developer', 'engineer', 'architect', 'analyst', 'intern', 'manager', 'lead',
            'python', 'java', 'javascript', 'react', 'node', 'django', 'golang', 'docker', 'aws'
        ];
        if (suspiciousWords.includes(valLower)) {
            return {
                valid: false,
                reason: 'INVALID_NATIONALITY',
                message: `"${valClean}" is an employer or technical keyword, not a valid nationality.`
            };
        }

        const canonical = profile.nationality || 'Indian';
        if (canonical && valLower !== canonical.toLowerCase() && valLower !== 'india') {
            return {
                valid: false,
                reason: 'CONTRADICTORY_NATIONALITY',
                message: `Selected nationality "${valClean}" contradicts canonical candidate nationality "${canonical}".`
            };
        }
    }

    return { valid: true };
}

module.exports = {
    normalizeQuestionText,
    resolveCandidateFact,
    isPersonalFactQuestion,
    matchAtsOption,
    validateStructuredField
};
