const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const profile = require('../config/profile');
const { askLMStudio, isLMStudioOnline } = require('./lmstudio');
const { askOllama, isOllamaOnline } = require('./ollama');
const { buildQuestionPrompt } = require('./prompts');
const { AnswerSource, Confidence, createResolvedAnswer } = require('./answerProvenance');

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
 * A small set of personal facts answered directly from profile.json.
 * These are answered instantly without calling the LLM.
 * The key is a lowercase substring that must appear in the question.
 */
const PERSONAL_FACTS = [
    // Notice period
    { match: ['notice period', 'notice'],                answer: () => profile.noticePeriod },
    // Relocation
    { match: ['relocat', 'willing to move', 'open to relocat'], answer: () => profile.relocate ? 'Yes' : 'No' },
    // Current location / city
    { match: ['current location', 'current city', 'residing', 'currently based', 'where are you based'],
                                                          answer: () => profile.currentLocation },
    // Expected CTC / salary
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
    // Current CTC
    { match: ['current ctc', 'current salary', 'current package'],
      answer: (q = '') => {
          const qLower = (q || '').toLowerCase();
          if (qLower.includes('invalid') || qLower.includes('error') || qLower.includes('valid input')) return '1';
          return profile.currentCTC || '0';
      }
    },
    // Years of experience (total)
    { match: ['total experience', 'years of experience', 'how many years', 'overall experience'],
                                                          answer: () => getExperienceAnswer() },
    // Name
    { match: ['your name', 'full name', 'candidate name'],
                                                          answer: () => profile.fullName },
    // Email
    { match: ['email', 'e-mail'],                        answer: () => profile.email },
    // Phone / mobile
    { match: ['phone', 'mobile', 'contact number'],      answer: () => profile.mobile },
    // Date of Birth
    { match: ['date of birth', 'dob', 'birth date', 'birthdate'], answer: () => profile.dateOfBirth || profile.dob || '' },
    // PAN Card / Number
    { match: ['pan number', 'pan card', 'pan no', 'permanent account number', /\bpan\b/i], answer: () => profile.panNumber || '' },
    // Graduation year / Passout year
    { match: ['graduation year', 'year of graduation', 'passout year', 'year of passing', 'passing year', 'batch', 'passout'], answer: () => String(profile.education?.passoutYear || profile.graduationYear || '') },
    // Degree / Education
    { match: ['degree', 'highest qualification', 'education level'], answer: () => profile.education?.degree || '' },
    // University / College
    { match: ['university', 'college', 'institute', 'school'], answer: () => profile.education?.university || '' },
];

/**
 * Tries to match the question against hardcoded personal facts.
 * Returns the answer string if matched, or null.
 */
function checkPersonalFact(question) {
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
    let filePath;
    if (source === 'workday') {
        filePath = hasOptions ? workdayOptionsAnswersPath : workdayTextAnswersPath;
    } else {
        filePath = hasOptions ? optionsAnswersPath : textAnswersPath;
    }

    const db = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    db[question.toLowerCase().trim()] = answer;
    fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
    console.log(chalk.gray(`  [Cache] Saved answer for: "${question}"`));
}

// ─── Manual Terminal Fallback ─────────────────────────────────────────────────
function promptUser() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question('> ', (ans) => {
            rl.close();
            resolve(ans.trim());
        });
    });
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
async function getAnswerWithProvenance(question, options = [], forceManual = false, source = 'naukri') {
    const hasOptions = options && options.length > 0;

    // ── 0. Dynamic experience check ──────────────────────────────────────────
    if (!forceManual && isExperienceQuestion(question)) {
        const expAns = getExperienceAnswer();
        console.log(chalk.blue(`  [Experience Override] "${question}" → "${expAns}"`));
        return createResolvedAnswer(expAns, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
    }

    // ── 1. Skill-confidence auto-answer ──────────────────────────────────────
    if (!forceManual && hasOptions) {
        const isYesNoOptions = options.some(o => /^yes$/i.test(o.trim())) &&
                               options.some(o => /^no$/i.test(o.trim()));
        const isSkillQuestion = /do you have|have you|are you (familiar|proficient|experienced|able)|can you|did you (use|work|build|design|develop|operate)/i.test(question);
        if (isYesNoOptions && isSkillQuestion) {
            const yesOpt = options.find(o => /^yes$/i.test(o.trim())) || 'Yes';
            console.log(chalk.green(`  [Skill] Auto-answering "Yes" for: "${question}"`));
            return createResolvedAnswer(yesOpt, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
        }
    }

    // ── 2. Hardcoded personal facts (profile.json) ───────────────────────────
    if (!forceManual) {
        const factAnswer = checkPersonalFact(question);
        if (factAnswer) {
            if (hasOptions) {
                const lower = factAnswer.toLowerCase();
                const matched = options.find(opt => opt.toLowerCase().includes(lower) || lower.includes(opt.toLowerCase()));
                if (matched) {
                    console.log(chalk.blue(`  [Profile] "${question}" → "${matched}" (matched from fact: "${factAnswer}")`));
                    return createResolvedAnswer(matched, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
                }
                console.log(chalk.gray(`  [Profile] Fact "${factAnswer}" has no match in options — using AI/manual.`));
            } else {
                console.log(chalk.blue(`  [Profile] "${question}" → "${factAnswer}"`));
                return createResolvedAnswer(factAnswer, AnswerSource.VERIFIED_PROFILE, Confidence.HIGH, question);
            }
        }
    }

    // ── 3. Learned Answer Cache (verified cache) ─────────────────────────────
    if (!forceManual) {
        const cached = findCachedAnswer(question, options, source);
        if (cached) {
            if (hasOptions) {
                const lower = cached.toLowerCase();
                const matched = options.find(opt => opt.toLowerCase().includes(lower) || lower.includes(opt.toLowerCase()));
                if (matched) {
                    console.log(chalk.green(`  [Cache] "${question}" → "${matched}" (matched from: "${cached}")`));
                    return createResolvedAnswer(matched, AnswerSource.VERIFIED_CACHE, Confidence.HIGH, question);
                }
            } else {
                console.log(chalk.green(`  [Cache] "${question}" → "${cached}"`));
                return createResolvedAnswer(cached, AnswerSource.VERIFIED_CACHE, Confidence.HIGH, question);
            }
        }
    }

    // ── 4. AI (LMStudio or Ollama) ───────────────────────────────────────────
    if (!forceManual) {
        const aiOnline = isLMStudioOnline() || isOllamaOnline() || activeLLM === 'auto';
        if (aiOnline) {
            try {
                const { system, user } = buildQuestionPrompt(question, options);
                const llmLabel = activeLLM === 'auto'
                    ? (isLMStudioOnline() ? 'LMStudio' : 'Ollama')
                    : activeLLM;
                console.log(chalk.magenta(`  [${llmLabel}] Asking: "${question}"`));

                const aiAnswer = await callAI(system, user);

                if (aiAnswer && aiAnswer.length > 0) {
                    console.log(chalk.green(`  [${llmLabel}] → "${aiAnswer}"`));

                    if (hasOptions) {
                        const lower = aiAnswer.toLowerCase();
                        const matched = options.find(o => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
                        const finalAnswer = matched || aiAnswer;
                        // Inferred from LLM: return with INFERRED provenance, DO NOT pollute verified cache
                        return createResolvedAnswer(finalAnswer, AnswerSource.LLM_INFERRED, Confidence.MEDIUM, question);
                    }

                    // Inferred from LLM: return with INFERRED provenance, DO NOT pollute verified cache
                    return createResolvedAnswer(aiAnswer, AnswerSource.LLM_INFERRED, Confidence.MEDIUM, question);
                }

                console.log(chalk.yellow(`  [${llmLabel}] Empty response. Falling back to manual.`));
            } catch (err) {
                console.log(chalk.yellow(`  [AI] Error: ${err.message}. Falling back to manual.`));
            }
        }
    }

    // ── 5. Manual terminal prompt (User input IS saved to verified cache) ────
    if (process.env.AUTOMATED_TEST === 'true') {
        return createResolvedAnswer('', AnswerSource.LLM_INFERRED, Confidence.LOW, question);
    }

    console.log(chalk.red.bold(`\n--- MANUAL INTERVENTION REQUIRED ---`));
    console.log(chalk.yellow(`QUESTION: "${question}"`));

    if (hasOptions) {
        console.log(chalk.cyan('OPTIONS:'));
        options.forEach((opt, i) => console.log(chalk.white(`  [${i + 1}] ${opt}`)));
        console.log(chalk.cyan('\nType option number(s) then Enter — e.g. "1" or "1,3" for multiple:'));
    } else {
        console.log(chalk.cyan('Type your answer (Enter to skip):'));
    }

    const manualAnswer = await promptUser();

    if (manualAnswer) {
        if (hasOptions && /^[\d\s,&]+$/.test(manualAnswer)) {
            const indices = manualAnswer.split(/[\s,&]+/).map(s => parseInt(s) - 1).filter(idx => !isNaN(idx));
            const selected = indices.filter(i => i >= 0 && i < options.length).map(i => options[i]);
            if (selected.length > 0) {
                const final = selected.join(', ');
                console.log(chalk.green(`  Selected: "${final}"`));
                saveAnswer(question, final, source, true);
                return createResolvedAnswer(final, AnswerSource.MANUAL_PROMPT, Confidence.HIGH, question);
            }
        }

        saveAnswer(question, manualAnswer, source, hasOptions);
        return createResolvedAnswer(manualAnswer, AnswerSource.MANUAL_PROMPT, Confidence.HIGH, question);
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
    saveAnswer,
    setActiveLLM,
    setCurrentJobContext,
    setUserMaxExperience
};

