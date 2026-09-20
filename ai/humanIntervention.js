'use strict';

const readline = require('readline');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const optionsAnswersPath = path.join(__dirname, '../data/optionsAnswers.json');
const textAnswersPath = path.join(__dirname, '../data/textAnswers.json');

/**
 * Saves human-verified answer to local answer store.
 */
function saveHumanVerifiedAnswer(question, answer, hasOptions = false) {
    try {
        // Section 3: Do NOT save if the answer is already in canonical profile facts!
        const { resolveCandidateFact, validateStructuredField } = require('./candidateFacts');
        const canonical = resolveCandidateFact(question);
        if (canonical && canonical.resolved) {
            return false;
        }

        // Section 7: Reject saving contradictory or bogus answers (e.g. State -> Amazon)
        const validation = validateStructuredField(question, String(answer));
        if (!validation.valid) {
            console.log(chalk.yellow(`  ⚠️ [Human Answer Store] Rejected invalid answer for "${question}": ${validation.message}`));
            return false;
        }

        const filePath = hasOptions ? optionsAnswersPath : textAnswersPath;
        let db = {};
        if (fs.existsSync(filePath)) {
            try {
                db = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (_) {
                db = {};
            }
        }
        db[question.toLowerCase().trim()] = answer;
        fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
        console.log(chalk.gray(`  [Human Answer Store] Verified answer saved for future applications: "${question}"`));
        return true;
    } catch (err) {
        console.warn(chalk.yellow(`  ⚠️ Could not persist verified answer: ${err.message}`));
        return false;
    }
}

/**
 * Reads a line of input from stdin using Node readline.
 * @param {string} promptText 
 * @returns {Promise<string>}
 */
function readLineFromTerminal(promptText = '> ') {
    return new Promise((resolve) => {
        if (!process.stdin || !process.stdout || process.stdin.destroyed) {
            return resolve('');
        }
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: Boolean(process.stdin.isTTY)
        });
        rl.question(promptText, (ans) => {
            rl.close();
            resolve((ans || '').trim());
        });
    });
}

/**
 * Centralized, reusable human intervention mechanism for all application handlers.
 * 
 * Pauses automation, displays structured question with options, validates input,
 * persists verified answers, and resumes application cleanly.
 *
 * @param {Object} params
 * @param {string} params.question - The question asked by recruiter or ATS form
 * @param {'text'|'dropdown'|'radio'|'checkbox'|'action'} [params.type='text'] - Question type
 * @param {string[]} [params.options=[]] - Available option labels (for dropdowns/radios/checkboxes)
 * @param {Object} [params.job={}] - Current job context { title, company, source }
 * @param {string} [params.reason] - Explanation of why intervention is needed
 * @param {Function} [params.promptFn] - Custom prompt callback (for tests or alternative UI)
 * @param {boolean} [params.isInteractive] - Override for interactive TTY check
 * @param {boolean} [params.allowEmpty=false] - Whether pressing Enter without text is accepted (e.g. for action steps)
 * @returns {Promise<{ answered: boolean, value: string|string[], selectedOptions?: string[], reason?: string }>}
 */
async function promptHumanIntervention({
    question,
    type = 'text',
    options = [],
    job = {},
    reason = 'Verified candidate data does not contain this information.',
    promptFn = null,
    isInteractive = undefined,
    allowEmpty = false
}) {
    if (!question) {
        return { answered: false, value: '' };
    }

    const interactive = isInteractive !== undefined
        ? isInteractive
        : (process.env.FORCE_INTERACTIVE === 'true' || Boolean(process.stdin && process.stdin.isTTY && !process.stdin.destroyed));

    const askPrompt = async (msg) => {
        if (typeof promptFn === 'function') {
            return await promptFn(msg);
        }
        return await readLineFromTerminal(msg);
    };

    const isAction = type === 'action';
    const canBeEmpty = allowEmpty || isAction;
    const hasOptions = Array.isArray(options) && options.length > 0;
    const isDropdownOrRadio = !isAction && (type === 'dropdown' || type === 'radio' || (hasOptions && type !== 'checkbox'));
    const isCheckbox = !isAction && type === 'checkbox';

    // In non-interactive environment (CI, background without mock prompt):
    if (!interactive && typeof promptFn !== 'function') {
        console.log(chalk.red(`\n[Human Intervention] Non-interactive environment: Cannot prompt for "${question}".`));
        return { answered: false, value: '', reason: 'NON_INTERACTIVE' };
    }

    console.log(chalk.bold.yellow(`\n------------------------------------------------------------`));
    console.log(chalk.bold.yellow(`HUMAN INPUT REQUIRED`));
    console.log(chalk.bold.yellow(`------------------------------------------------------------`));

    if (job && (job.title || job.company || job.source)) {
        if (job.title) console.log(chalk.white(`Application: ${chalk.bold.cyan(job.title)}`));
        if (job.company) console.log(chalk.white(`Company:     ${chalk.bold.white(job.company)}`));
        if (job.source) console.log(chalk.white(`Source:      ${chalk.bold.magenta(job.source)}`));
        console.log('');
    }

    console.log(chalk.bold.white(`Question / Action Required:`));
    console.log(chalk.cyan(`"${question}"\n`));
    console.log(chalk.yellow(`${reason}\n`));

    // ── 0. Action-Oriented Intervention (e.g. Login, Resume Attachment, CAPTCHA) ───────────
    if (isAction) {
        const promptMsg = chalk.bold.green('Press Enter when completed in browser (or type "done" to resume, or "cancel" to abort):\n> ');
        const answer = (await askPrompt(promptMsg)).trim();
        if (/^(cancel|abort|no|n|stop)$/i.test(answer)) {
            console.log(chalk.yellow('  🛑 Human intervention aborted by user.'));
            console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
            return { answered: false, value: '', reason: 'USER_ABORTED' };
        }

        // Strict completion validation:
        // Only empty string (user pressed Enter) or documented completion keywords ('done', 'completed', 'finish', 'ok', 'proceed') are accepted.
        // Arbitrary inputs like "yes", "y", "submit" are strictly NOT accepted as action completion!
        const isDocumentedCompletion = answer === '' || /^(done|completed|finish|finished|ok|proceed)$/i.test(answer);
        if (!isDocumentedCompletion) {
            console.log(chalk.yellow(`  ⚠️ Input "${answer}" is not a valid action completion. Only Enter or "done" confirms completion.`));
            console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
            return { answered: false, value: '', reason: 'INVALID_COMPLETION_ACTION' };
        }

        console.log(chalk.green('  ✔ Human action confirmed. Resuming automation...'));
        console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
        return { answered: true, value: answer || 'done' };
    }

    // ── 1. Dropdown / Radio Selection (Supports both option Number and Text) ───
    if (isDropdownOrRadio && hasOptions) {
        console.log(chalk.bold.white('Options:'));
        options.forEach((opt, idx) => {
            console.log(chalk.white(`[${idx + 1}] ${opt}`));
        });
        console.log('');

        let attempts = 0;
        while (attempts < 5) {
            attempts++;
            const input = (await askPrompt(chalk.bold.green('Selection:\n> '))).trim();

            if (!input) {
                console.log(chalk.yellow('  ⚠️ Input cannot be empty. Please enter an option number or exact option text.'));
                continue;
            }

            // A. Number selection (e.g. "3")
            const num = parseInt(input, 10);
            if (!isNaN(num) && String(num) === input && num >= 1 && num <= options.length) {
                const selected = options[num - 1];
                console.log(chalk.green(`  ✔ Selected: "${selected}"`));
                saveHumanVerifiedAnswer(question, selected, true);
                console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
                return {
                    answered: true,
                    value: selected,
                    selectedOptions: [selected],
                    selectedIndex: num - 1
                };
            }

            // B. Text selection (e.g. "Vellore Institute of Technology" or "Master's Degree")
            const { matchAtsOption } = require('./candidateFacts');
            const matchRes = matchAtsOption(options, input, question);

            if (matchRes.matched && matchRes.selectedOption) {
                const selected = matchRes.selectedOption;
                console.log(chalk.green(`  ✔ Selected: "${selected}"`));
                saveHumanVerifiedAnswer(question, selected, true);
                console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
                return {
                    answered: true,
                    value: selected,
                    selectedOptions: [selected],
                    selectedIndex: options.indexOf(selected)
                };
            }

            if (matchRes.ambiguous) {
                console.log(chalk.yellow(`  ⚠️ Ambiguous input: "${input}" matches multiple options: [${matchRes.matchingOptions.slice(0, 5).join(', ')}...]. Please enter the exact option number.`));
                continue;
            }

            console.log(chalk.red(`  ❌ No option matches "${input}". Please choose a number between 1 and ${options.length} or enter exact option text.`));
        }

        console.log(chalk.red('  ❌ Maximum attempts exceeded without valid selection.'));
        console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
        return { answered: false, value: '', reason: 'MAX_ATTEMPTS_EXCEEDED' };
    }

    // ── 2. Checkbox / Multi-Select ────────────────────────────────────────────
    if (isCheckbox && hasOptions) {
        console.log(chalk.bold.white('Options:'));
        options.forEach((opt, idx) => {
            console.log(chalk.white(`[${idx + 1}] ${opt}`));
        });
        console.log(chalk.gray('(Enter comma-separated numbers, e.g. "1,3,5" or "1")\n'));

        let attempts = 0;
        while (attempts < 5) {
            attempts++;
            const input = (await askPrompt(chalk.bold.green('Selection:\n> '))).trim();

            if (!input) {
                console.log(chalk.yellow('  ⚠️ Input cannot be empty. Please enter option numbers.'));
                continue;
            }

            const parts = input.split(/[,;\s]+/).map(p => p.trim()).filter(Boolean);
            const indices = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n));

            const allValid = indices.length > 0 && indices.every(n => n >= 1 && n <= options.length);
            if (allValid) {
                // Deduplicate indices while preserving order
                const uniqueIndices = Array.from(new Set(indices));
                const selected = uniqueIndices.map(n => options[n - 1]);
                const joined = selected.join(', ');
                console.log(chalk.green(`  ✔ Selected: "${joined}"`));
                saveHumanVerifiedAnswer(question, joined, true);
                console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
                return {
                    answered: true,
                    value: joined,
                    selectedOptions: selected,
                    selectedIndices: uniqueIndices.map(i => i - 1)
                };
            }

            console.log(chalk.red(`  ❌ Invalid choice(s) in "${input}". All numbers must be between 1 and ${options.length}.`));
        }

        console.log(chalk.red('  ❌ Maximum attempts exceeded without valid selection.'));
        console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
        return { answered: false, value: '', reason: 'MAX_ATTEMPTS_EXCEEDED' };
    }

    // ── 3. Freeform Text Question ─────────────────────────────────────────────
    let attempts = 0;
    while (attempts < 5) {
        attempts++;
        const answer = (await askPrompt(chalk.bold.green('Enter answer:\n> '))).trim();
        if (answer.length > 0) {
            console.log(chalk.green(`  ✔ Entered: "${answer}"`));
            saveHumanVerifiedAnswer(question, answer, false);
            console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
            return { answered: true, value: answer };
        }
        if (canBeEmpty) {
            console.log(chalk.green('  ✔ Acknowledged.'));
            console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
            return { answered: true, value: '' };
        }
        console.log(chalk.yellow('  ⚠️ Answer cannot be blank.'));
    }

    console.log(chalk.red('  ❌ No answer provided.'));
    console.log(chalk.bold.yellow(`------------------------------------------------------------\n`));
    return { answered: false, value: '', reason: 'NO_INPUT' };
}

/**
 * Parses multi-select user input (e.g. "1,3,5" or "1 3") into 0-based indices.
 * @param {string} input 
 * @param {number} totalOptions 
 * @returns {number[]|null} Array of 0-based indices or null if invalid
 */
function parseMultiSelectInput(input = '', totalOptions = 0) {
    if (!input || totalOptions <= 0) return null;
    const parts = String(input).split(/[,;\s]+/).map(p => p.trim()).filter(Boolean);
    const indices = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
    if (indices.length === 0 || !indices.every(n => n >= 1 && n <= totalOptions)) {
        return null;
    }
    return Array.from(new Set(indices)).map(n => n - 1);
}

/**
 * Parses single dropdown user input into a 0-based index.
 * @param {string} input 
 * @param {number} totalOptions 
 * @returns {number|null} 0-based index or null if invalid
 */
function parseSingleSelectInput(input = '', totalOptions = 0) {
    if (!input || totalOptions <= 0) return null;
    const num = parseInt(String(input).trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= totalOptions) {
        return num - 1;
    }
    return null;
}

module.exports = {
    promptHumanIntervention,
    saveHumanVerifiedAnswer,
    parseMultiSelectInput,
    parseSingleSelectInput
};
