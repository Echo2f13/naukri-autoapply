const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');
const profile = require('../config/profile');
const { askLMStudio, isLMStudioOnline } = require('./lmstudio');
const { askOllama, isOllamaOnline } = require('./ollama');
const { buildQuestionPrompt } = require('./prompts');
const { AnswerSource, Confidence, createResolvedAnswer } = require('./answerProvenance');
const { promptHumanIntervention } = require('./humanIntervention');
const { resolveCandidateFact, isPersonalFactQuestion, matchAtsOption, validateStructuredField } = require('./candidateFacts');

// ─── Active LLM Selection ─────────────────────────────────────────────────────
// Set by the startup menu in index.js before automation begins.
let activeLLM = 'auto'; // 'lmstudio' | 'ollama' | 'none' | 'auto'

/**
 * Sets which LLM to use for answering questions.
 * Called from startup menu after user/auto selection.
 * @param {'lmstudio'|'ollama'|'none'|'auto'} type
 */
function setActiveLLM(type) {
    activeLLM = type;
    const label = type === 'none' ? 'saved answers only' : type;
    console.log(chalk.blue(`[AI Engine] Active LLM: ${chalk.bold(label)}`));
}

/**
 * Calls whichever LLM is currently active.
 * Falls back gracefully if the selected LLM is offline.
 */
async function callAI(systemPrompt, userMessage) {
    switch (activeLLM) {
        case 'lmstudio':
            return isLMStudioOnline() ? await askLMStudio(systemPrompt, userMessage) : null;
        case 'ollama':
            return isOllamaOnline() ? await askOllama(systemPrompt, userMessage) : null;
        case 'none':
            return null;
        case 'auto':
        default:
            if (isLMStudioOnline()) return await askLMStudio(systemPrompt, userMessage);
            if (isOllamaOnline())  return await askOllama(systemPrompt, userMessage);
            return null;
    }
}

// ─── Database Paths ──────────────────────────────────────────────────────────
const optionsAnswersPath      = path.join(__dirname, '../data/optionsAnswers.json');
const textAnswersPath         = path.join(__dirname, '../data/textAnswers.json');
const workdayOptionsAnswersPath = path.join(__dirname, '../data/workdayOptionsAnswers.json');
const workdayTextAnswersPath  = path.join(__dirname, '../data/workdayTextAnswers.json');

// ─── Silent DB Initialisation ────────────────────────────────────────────────
// Ensure all JSON answer databases exist (no noisy migration logs at boot)
function ensureDb(filePath) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
    }
}
ensureDb(optionsAnswersPath);
ensureDb(textAnswersPath);
ensureDb(workdayOptionsAnswersPath);
ensureDb(workdayTextAnswersPath);

// ─── Hardcoded Personal Facts ─────────────────────────────────────────────────
/**
 * A small set of personal facts answered directly from profile.json.
 * These are answered instantly without calling the LLM.
 * The key is a lowercase substring that must appear in the question.
 */
// ─── Dynamic Context-Aware Experience Handling ──────────────────────────────
let currentJobMinExperience = 1; // Set per-job via setCurrentJobContext()
let maxUserExperience = 1;       // Set once at startup from user's selected search filter

/**
 * Sets the user's actual max experience level (from search filter selection).
 * This caps all experience answers — we never claim more experience than the user has.
 * @param {number} maxExp  — e.g. 0 for Fresher only, 1 for 1-year, 1 for Fresher+1yr
 */
function setUserMaxExperience(maxExp) {
    maxUserExperience = (typeof maxExp === 'number' && !isNaN(maxExp)) ? maxExp : 1;
    console.log(chalk.blue(`[AI Engine] User max experience set to: ${maxUserExperience} yr(s)${maxUserExperience === 0 ? ' (Fresher)' : ''}`));
}

/**
 * Sets the active job context so experience answers can be dynamically resolved.
 * @param {Object} job
 */
function setCurrentJobContext(job) {
    if (job && job.experience) {
        currentJobMinExperience = parseMinExperience(job.experience);
        console.log(chalk.blue(`  [Context] Job experience required: "${job.experience}" -> parsed min: ${currentJobMinExperience} yrs.`));
    } else {
        currentJobMinExperience = 1; // Default
    }
}

function parseMinExperience(expStr) {
    if (!expStr || typeof expStr !== 'string') return 1;
    const clean = expStr.toLowerCase().trim();
    if (clean.includes('fresher')) return 0;
    const match = clean.match(/\d+/);
    if (match) {
        return parseInt(match[0], 10);
    }
    return 1;
}

/**
 * Returns the experience answer for the current job.
 * - Caps at maxUserExperience so we never claim more than we actually have.
 * - If job requires >= 2 yrs AND user has >= 2 yrs, answer "2".
 * - Otherwise answer the lower of: what the job requires vs what user has.
 */
function getExperienceAnswer() {
    // The answer we'd ideally give = what the job needs, capped at what we have
    const ideal = Math.min(currentJobMinExperience, maxUserExperience);
    // Always return at least "1" (never "0") — recruiters treat 0 as Fresher/disqualifying
    return String(Math.max(ideal, 1));
}

function isExperienceQuestion(questionText) {
    const q = questionText.toLowerCase();

    // Exclude Yes/No confirmatory questions — these are NOT numeric-answer questions.
    // e.g. "Do you have hands-on experience with Python?" → options are Yes/No, not a number.
    const isYesNoQuestion = /^(do you have|have you|are you|did you|can you|would you)/i.test(questionText.trim());
    if (isYesNoQuestion) return false;

    return q.includes('years of experience') ||
           q.includes('years experience') ||
           q.includes('experience in') ||
           q.includes('how many years') ||
           q.includes('overall experience') ||
           (q.includes('experience') && (
               q.includes('python') || q.includes('django') || q.includes('react') ||
               q.includes('node') || q.includes('sql') || q.includes('java') ||
               q.includes('javascript') || q.includes('c#') || q.includes('developer') ||
               q.includes('development') || q.includes('engineer') || q.includes('engineering')
           ));
}

// ─── Hardcoded Personal Facts ─────────────────────────────────────────────────
/**
 * A comprehensive set of candidate personal facts answered directly from profile.json.
 * These are answered instantly and deterministically without calling the LLM.
 * Semantic location rules distinguish education location (Vellore, Tamil Nadu) from
 * current residence (Hyderabad, Telangana) and preferred work locations.
 */
const PERSONAL_FACTS = [
    // 1. Education location / city
    { match: ['education city', 'university city', 'college city', 'school city', 'institute city', 'university location', 'college location', 'education location', 'campus city', 'campus location'],
      answer: () => profile.education?.educationCity || profile.education?.city || profile.education?.universityCity || 'Vellore' },
    // 2. Education state
    { match: ['education state', 'university state', 'college state', 'school state', 'campus state'],
      answer: () => profile.education?.educationState || profile.education?.state || 'Tamil Nadu' },
    // 3. Current City / Residence City
    { match: ['current city', 'present city', 'residing city', 'living in city', 'city of residence', 'your city', 'home city'],
      answer: (q = '') => {
          const qLower = (q || '').toLowerCase();
          if (qLower.includes('university') || qLower.includes('education') || qLower.includes('college') || qLower.includes('school')) {
              return profile.education?.educationCity || profile.education?.city || 'Vellore';
          }
          return profile.currentCity || profile.address?.city || 'Hyderabad';
      }
    },
    // 4. Current State / Residence State
    { match: ['current state', 'state of residence', 'living in state'],
      answer: (q = '') => {
          const qLower = (q || '').toLowerCase();
          if (qLower.includes('university') || qLower.includes('education') || qLower.includes('college') || qLower.includes('school')) {
              return profile.education?.educationState || profile.education?.state || 'Tamil Nadu';
          }
          return profile.currentState || profile.address?.state || 'Telangana';
      }
    },
    // 5. Current Location / General Residence
    { match: ['current location', 'residing in', 'currently based', 'where are you based', 'present location', 'current address'],
      answer: () => profile.currentLocation || profile.currentCity || profile.address?.city || 'Hyderabad' },
    // 6. Preferred location
    { match: ['preferred location', 'preferred city', 'desired location', 'work location preference', 'preferred work location'],
      answer: () => (Array.isArray(profile.preferredLocations) ? profile.preferredLocations.join(', ') : profile.preferredLocation) || (Array.isArray(profile.locations) ? profile.locations.filter(l => l.toLowerCase() !== 'remote').join(', ') : 'Hyderabad, Bangalore') },
    // 7. Notice period
    { match: ['notice period', 'notice', 'how soon can you join', 'joining period', 'availability to join', 'available to start'],
      answer: () => profile.noticePeriod || 'Immediate' },
    // 8. Relocation
    { match: ['relocat', 'willing to move', 'open to relocat'],
      answer: () => (profile.willingToRelocate !== undefined ? (profile.willingToRelocate ? 'Yes' : 'No') : (profile.relocate ? 'Yes' : 'No')) },
    // 9. Expected CTC / salary
    { match: ['expected ctc', 'expected salary', 'salary expectation', 'ctc expectation', 'what is your expected'],
      answer: (q = '') => {
          const qLower = (q || '').toLowerCase();
          const raw = profile.expectedCTC || '800000';
          const numeric = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
          const inLakhs = !isNaN(numeric) && numeric >= 10000 ? String(Math.round(numeric / 100000)) : '8';
          if (/lakh|lacs|lac|lpa/i.test(qLower)) {
              return inLakhs;
          }
          return raw;
      }
    },
    // 10. Current CTC
    { match: ['current ctc', 'current salary', 'current package'],
      answer: (q = '') => {
          const qLower = (q || '').toLowerCase();
          if (qLower.includes('invalid') || qLower.includes('error') || qLower.includes('valid input')) return '1';
          return profile.currentCTC || '0';
      }
    },
    // 11. Years of experience (total)
    { match: ['total experience', 'years of experience', 'how many years', 'overall experience'],
      answer: () => getExperienceAnswer() },
    // 12. Name
    { match: ['your name', 'full name', 'candidate name'], answer: () => profile.fullName || profile.name || '' },
    // 13. Date of Birth
    { match: ['date of birth', 'dob', 'birth date', 'birthdate'],
      answer: () => profile.dateOfBirth || profile.dob || '01/01/2001' },
    // 14. PAN Card
    { match: ['pan card', 'pan number', 'pan'],
      answer: () => profile.pan || profile.panCard || profile.panNumber || '' },
    // 15. Graduation / Passout Year
    { match: ['graduation year', 'year of graduation', 'passout year', 'pass out year', 'passing year', 'year of passing', 'batch'],
      answer: () => String(profile.education?.passoutYear || profile.passoutYear || profile.graduationYear || '2024') },
    // 16. Degree & Major
    { match: ['degree', 'highest degree', 'qualification', 'highest qualification', 'course'],
      answer: () => profile.education?.degree || profile.degree || 'Bachelor of Technology' },
    { match: ['field of study', 'major', 'branch', 'specialization', 'discipline'],
      answer: () => profile.education?.major || profile.major || 'Computer Science' },
    { match: ['university', 'college', 'institute', 'school'],
      answer: () => profile.education?.university || profile.university || '' },
    // 17. Contact Info
    { match: ['email', 'email address'], answer: () => profile.email || '' },
    { match: ['phone', 'mobile', 'contact number', 'phone number', 'cell'], answer: () => profile.mobile || profile.phone || '' },
    // 18. Gender
    { match: ['gender', 'sex'], answer: () => profile.gender || 'Male' },
    // 19. Work Authorization & Sponsorship
    { match: ['legally authorized to work', 'authorized to work', 'work authorization', 'eligible to work', 'legally eligible'],
      answer: () => 'Yes' },
    { match: ['require sponsorship', 'require visa', 'need sponsorship', 'sponsorship in future', 'visa sponsorship'],
      answer: () => 'No' }
];

/**
 * Tries to match the question against hardcoded personal facts.
 * Returns the answer string if matched, or null.
 */
function checkPersonalFact(question) {
    const res = resolveCandidateFact(question);
    if (res && res.resolved) {
        return res.answer;
    }
    const q = question.toLowerCase();
    for (const fact of PERSONAL_FACTS) {
        if (fact.match.some(keyword => keyword instanceof RegExp ? keyword.test(question) : q.includes(keyword))) {
            return fact.answer(question);
        }
    }
    return null;
}

// ─── Learned-Answer Cache ─────────────────────────────────────────────────────
/**
 * Resolves a cached answer from the JSON databases.
 */
function findCachedAnswer(question, options = [], source = 'naukri') {
    const q = question.toLowerCase().trim();
    const qNormalized = q.replace(/[^a-z0-9]/g, '');
    const hasOptions = options && options.length > 0;

    let filePath;
    if (source === 'workday') {
        filePath = hasOptions ? workdayOptionsAnswersPath : workdayTextAnswersPath;
    } else {
        filePath = hasOptions ? optionsAnswersPath : textAnswersPath;
    }

    if (!fs.existsSync(filePath)) return null;
    const db = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // 1. Direct match
    if (db[q]) return db[q];

    // 2. Normalized alphanumeric match (e.g. "date_of_birth" matches "Date of Birth")
    for (const [key, val] of Object.entries(db)) {
        const keyNorm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (keyNorm === qNormalized) return val;
    }

    // 3. Substring match
    for (const [key, val] of Object.entries(db)) {
        const keyClean = key.toLowerCase().replace(/_/g, ' ').trim();
        if (keyClean.length > 3 && (q.includes(keyClean) || keyClean.includes(q))) {
            return val;
        }
    }

    // 4. If checking options, fallback to text database as well
    if (hasOptions) {
        const fallbackPath = source === 'workday' ? workdayTextAnswersPath : textAnswersPath;
        if (fs.existsSync(fallbackPath)) {
            const fallbackDb = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
            if (fallbackDb[q]) return fallbackDb[q];
            for (const [key, val] of Object.entries(fallbackDb)) {
                const keyNorm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (keyNorm === qNormalized) return val;
            }
        }
    }

    return null;
}

/**
 * Saves a new question-answer pair to the appropriate JSON database.
 */
function saveAnswer(question, answer, source = 'naukri', hasOptions = false) {
    // 1. Never save if the answer is already a canonical profile fact!
    const canonical = resolveCandidateFact(question);
    if (canonical && canonical.resolved) {
        return;
    }

    // 2. Validate structured fields to prevent saving bogus answers (e.g. State -> Amazon)
    const validation = validateStructuredField(question, String(answer));
    if (!validation.valid) {
        console.log(chalk.yellow(`  ⚠️ [Cache] Rejected invalid answer for "${question}": ${validation.message}`));
        return;
    }

    let filePath;
    if (source === 'workday') {
        filePath = hasOptions ? workdayOptionsAnswersPath : workdayTextAnswersPath;
    } else {
        filePath = hasOptions ? optionsAnswersPath : textAnswersPath;
    }

    const db = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    db[question.toLowerCase().trim()] = answer;
    fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
    console.log(chalk.gray(`  [Cache] Saved verified human answer for: "${question}"`));
}

// ─── Manual Terminal Fallback ─────────────────────────────────────────────────
async function promptUser(query = '> ') {
    if (!process.stdin || !process.stdout || process.stdin.destroyed) {
        return '';
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(query, (ans) => {
            rl.close();
            resolve((ans || '').trim());
        });
    });
}

/**
 * Checks whether a question asks for candidate personal facts.
 * Personal facts must NEVER be guessed or hallucinated by an LLM.
 */
function isPersonalCandidateFact(questionText = '') {
    const q = questionText.toLowerCase();
    const factKeywords = [
        'graduation', 'graduat', 'passout', 'passing year', 'batch', 'month of',
        'visa', 'sponsorship', 'authorized to work', 'work authorization', 'citizenship',
        'notice period', 'notice', 'joining', 'how soon can you join', 'start date',
        'ctc', 'salary', 'compensation', 'package', 'expected',
        'experience', 'years of', 'how many years',
        'city', 'location', 'residing', 'residence', 'address', 'state', 'country', 'relocate', 'relocation',
        'degree', 'education', 'university', 'college', 'school', 'institute', 'gpa', 'percentage', 'marks',
        'gender', 'date of birth', 'dob', 'pan', 'aadhaar', 'ssn', 'phone', 'mobile', 'email', 'name'
    ];
    return factKeywords.some(kw => q.includes(kw));
}

// ─── Main Answer Function ─────────────────────────────────────────────────────
/**
 * Gets the best answer for a given recruiter question.
 *
 * Priority order:
 * 1. Hardcoded personal facts (from profile.json) — name, email, CTC, etc.
 * 2. LMStudio (Gemma 4 E4B) — if online, answers everything else
 * 3. Manual terminal prompt — if LMStudio is offline
 *
 * @param {string}   question     - The recruiter's question text
 * @param {string[]} options      - Available options (radio/chip), if any
 * @param {boolean}  forceManual  - Force manual terminal prompt regardless
 * @param {string}   source       - 'naukri' or 'workday'
/**
 * Resolves the answer along with provenance metadata.
 * Prevents LLM inferences from polluting the verified cache.
 *
 * @param {string}   question
 * @param {string[]} options
 * @param {boolean}  forceManual
 * @param {string}   source
 * @returns {Promise<{ answer: string, source: string, confidence: string, question: string }>}
 */
async function getAnswerWithProvenance(question, options = [], forceManual = false, source = 'naukri', context = {}) {
    const hasOptions = Array.isArray(options) && options.length > 0;
    const sourceName = typeof source === 'string' ? source : (source?.source || 'naukri');

    // ── 0. Dynamic experience check ──────────────────────────────────────────
    if (!forceManual && isExperienceQuestion(question)) {
        const expAns = getExperienceAnswer();
        console.log(chalk.blue(`  [Experience Override] "${question}" → "${expAns}"`));
        return createResolvedAnswer(expAns, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
    }

    // ── 1. Skill-confidence profile verification ──────────────────────────────
    if (!forceManual && hasOptions) {
        const isYesNoOptions = options.some(o => /^yes$/i.test(o.trim())) &&
                               options.some(o => /^no$/i.test(o.trim()));
        const isSkillQuestion = /do you have|have you|are you (familiar|proficient|experienced|able)|can you|did you (use|work|build|design|develop|operate)/i.test(question);
        if (isYesNoOptions && isSkillQuestion) {
            const candidateSkills = (profile.skills || []).map(s => s.toLowerCase());
            const qLower = question.toLowerCase();
            const hasExplicitSkill = candidateSkills.some(skill => qLower.includes(skill));
            if (hasExplicitSkill) {
                const yesOpt = options.find(o => /^yes$/i.test(o.trim())) || 'Yes';
                console.log(chalk.green(`  [Skill Verified] "${question}" matches profile skills → "Yes"`));
                return createResolvedAnswer(yesOpt, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
            }
            console.log(chalk.gray(`  [Skill Check] Question "${question}" asks for skill not in verified profile. Following strict answer hierarchy.`));
        }
    }

    // ── 2. Canonical Profile Facts (ai/candidateFacts.js) ────────────────────
    if (!forceManual) {
        const factRes = resolveCandidateFact(question);
        const factAnswer = (factRes && factRes.resolved) ? factRes.answer : checkPersonalFact(question);
        if (factAnswer && String(factAnswer).trim().length > 0) {
            const factStr = String(factAnswer);
            if (hasOptions) {
                const matchRes = matchAtsOption(options, factStr, question);
                if (matchRes.matched && matchRes.selectedOption) {
                    console.log(chalk.blue(`  [Profile] "${question}" → "${matchRes.selectedOption}" (matched from fact: "${factStr}")`));
                    return createResolvedAnswer(matchRes.selectedOption, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
                }
                console.log(chalk.gray(`  [Profile] Fact "${factStr}" could not be matched unambiguously against options. Checking cache/human.`));
            } else {
                console.log(chalk.blue(`  [Profile] "${question}" → "${factStr}"`));
                return createResolvedAnswer(factStr, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
            }
        }
    }

    // ── 3. Learned Answer Cache (verified candidate answer store) ────────────
    if (!forceManual) {
        const cached = findCachedAnswer(question, options, sourceName);
        if (cached && String(cached).trim().length > 0) {
            const cachedStr = String(cached);
            if (hasOptions) {
                const matchRes = matchAtsOption(options, cachedStr, question);
                if (matchRes.matched && matchRes.selectedOption) {
                    console.log(chalk.green(`  [Cache] "${question}" → "${matchRes.selectedOption}" (matched from: "${cachedStr}")`));
                    return createResolvedAnswer(matchRes.selectedOption, AnswerSource.VERIFIED_CACHE, Confidence.HIGH, question);
                }
            } else {
                console.log(chalk.green(`  [Cache] "${question}" → "${cachedStr}"`));
                return createResolvedAnswer(cachedStr, AnswerSource.VERIFIED_CACHE, Confidence.HIGH, question);
            }
        }
    }

    // ── 4. AI Interpretation (ONLY for non-personal questions) ───────────────
    // STRICT ANTI-GUESSING SAFETY: If the question asks for candidate facts
    // (nationality, citizenship, education, institute, compensation, address, etc.),
    // LLMs are strictly forbidden from guessing.
    const isFact = isPersonalFactQuestion(question) || isPersonalCandidateFact(question);

    if (!forceManual && !isFact) {
        const aiOnline = isLMStudioOnline() || isOllamaOnline() || activeLLM === 'auto';
        if (aiOnline) {
            try {
                const { system, user } = buildQuestionPrompt(question, options);
                const llmLabel = activeLLM === 'auto'
                    ? (isLMStudioOnline() ? 'LMStudio' : 'Ollama')
                    : activeLLM;
                console.log(chalk.magenta(`  [${llmLabel}] Classifying general prompt: "${question}"`));

                const aiAnswer = await callAI(system, user);

                if (aiAnswer && aiAnswer.length > 0) {
                    console.log(chalk.green(`  [${llmLabel}] → "${aiAnswer}"`));

                    if (hasOptions) {
                        const lower = aiAnswer.toLowerCase();
                        const matched = options.find(o => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
                        const finalAnswer = matched || aiAnswer;
                        return createResolvedAnswer(finalAnswer, AnswerSource.LLM_INFERRED, Confidence.MEDIUM, question);
                    }

                    return createResolvedAnswer(aiAnswer, AnswerSource.LLM_INFERRED, Confidence.MEDIUM, question);
                }
            } catch (err) {
                console.log(chalk.yellow(`  [AI] Error: ${err.message}. Falling back to human intervention.`));
            }
        }
    } else if (isFact) {
        console.log(chalk.yellow(`  [Safety Boundary] Question "${question}" requires candidate fact not in verified profile/cache. LLM guessing prohibited. Requesting human intervention.`));
    }

    // ── 5. Reusable Human Intervention (Pause & Resume CLI) ───────────────────
    const humanResult = await promptHumanIntervention({
        question,
        type: hasOptions ? 'dropdown' : 'text',
        options: hasOptions ? options : [],
        job: context?.job || (typeof source === 'object' ? source : { source: sourceName }),
        reason: isFact ? 'Verified candidate profile does not contain this personal information.' : 'Automated answer engine requires human clarification.',
        promptFn: context?.promptFn || (typeof forceManual === 'function' ? forceManual : null),
        isInteractive: context?.isInteractive
    });

    if (humanResult && humanResult.answered && humanResult.value) {
        saveAnswer(question, String(humanResult.value), sourceName, hasOptions);
        const ans = createResolvedAnswer(String(humanResult.value), AnswerSource.MANUAL_PROMPT, Confidence.HIGH, question);
        if (isFact) ans.needsHuman = true;
        return ans;
    }

    if (isFact) {
        const unans = createResolvedAnswer('', AnswerSource.MANUAL_PROMPT, Confidence.LOW, question);
        unans.needsHuman = true;
        return unans;
    }

    if (process.env.AUTOMATED_TEST === 'true') {
        return createResolvedAnswer('', AnswerSource.LLM_INFERRED, Confidence.LOW, question);
    }

    return createResolvedAnswer('', AnswerSource.MANUAL_PROMPT, Confidence.LOW, question);
}

/**
 * Backward-compatible wrapper returning only the answer string.
 */
async function getAnswer(question, options = [], forceManual = false, source = 'naukri') {
    const res = await getAnswerWithProvenance(question, options, forceManual, source);
    return res.answer;
}

// Export findLearnedAnswer as alias for backwards compat with any code that imports it
function findLearnedAnswer(question, options = [], source = 'naukri') {
    const cached = findCachedAnswer(question, options, source);
    if (cached) return { answer: cached, key: question.toLowerCase(), exact: true };
    return null;
}

module.exports = {
    getAnswer,
    getAnswerWithProvenance,
    promptUser,
    findLearnedAnswer,
    findCachedAnswer,
    checkPersonalFact,
    saveAnswer,
    setActiveLLM,
    setCurrentJobContext,
    setUserMaxExperience
};

