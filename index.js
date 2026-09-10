require('dotenv').config();
const readline = require('readline');
const chalk = require('chalk');

const { launchBrowser } = require('./automation/browser');
const { ensureLogin } = require('./automation/login');
const { extractRecommendedJobs, searchNaukriJobs } = require('./automation/searchJobs');
const { applyToJob } = require('./automation/apply');
const { scoreJob } = require('./ai/jobScorer');
const { isAlreadyApplied, saveApplication, logEvent } = require('./db/queries');
const { checkLMStudio } = require('./ai/lmstudio');
const { checkOllama, getOllamaModel } = require('./ai/ollama');
const { loadResume } = require('./ai/prompts');
const { setActiveLLM, setUserMaxExperience } = require('./ai/answerEngine');
const settings = require('./config/settings');

// ─── Prompt Utilities ─────────────────────────────────────────────────────────

function ask(question, defaultVal = '') {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const suffix = defaultVal ? chalk.gray(` (default: ${defaultVal})`) : '';
        rl.question(`${question}${suffix}: `, answer => {
            rl.close();
            resolve(answer.trim() || defaultVal);
        });
    });
}

async function askChoice(question, choices, defaultIdx = 0) {
    console.log(chalk.cyan(`\n${question}`));
    choices.forEach((c, i) => {
        const bullet = i === defaultIdx ? chalk.green('●') : chalk.gray('○');
        console.log(`  ${bullet} [${i + 1}] ${c}`);
    });
    const ans = await ask('Choice', String(defaultIdx + 1));
    const idx = parseInt(ans) - 1;
    return (idx >= 0 && idx < choices.length) ? idx : defaultIdx;
}

// ─── Experience Filter (applies to ALL jobs — recommendations + search) ────────

/**
 * Filters jobs to only include ones within the user's experience bucket.
 * Uses maxExp + 1 as threshold because Naukri's experience search buckets
 * naturally include jobs whose minimum requirement is up to 1 year above the filter.
 * E.g. "1 year" search returns both "1-3 Yrs" and "2-5 Yrs" jobs —
 * we keep min ≤ 2 but reject min ≥ 3 (genuine over-experience).
 * @param {Array}  jobs
 * @param {number} maxExp  - user's max experience (0=Fresher, 1=1yr, etc.)
 */
function filterByExperience(jobs, maxExp = 1) {
    const threshold = maxExp + 1; // 1-year tolerance for Naukri's bucket ranges
    const before = jobs.length;
    const filtered = jobs.filter(job => {
        const expStr = (job.experience || '').toLowerCase().trim();
        if (!expStr || expStr === 'n/a') return true;                     // Unknown — include
        if (expStr.includes('fresher') || expStr.includes('entry')) return true;
        const nums = expStr.match(/\d+/g);
        if (!nums) return true;
        const minRequired = parseInt(nums[0], 10);
        return minRequired <= threshold;                                   // Keep if min ≤ maxExp+1
    });
    const removed = before - filtered.length;
    if (removed > 0) {
        console.log(chalk.gray(`  [Filter] Skipped ${removed} jobs requiring > ${threshold} year(s) experience.`));
    }
    return filtered;
}

// ─── Post Age Filter ──────────────────────────────────────────────────────────

function parsePostAgeToDays(ageText) {
    if (!ageText) return 999; // If no date text, default to 999 (treat as old unless filtered)
    const clean = ageText.toLowerCase().trim();
    if (clean.includes('today') || clean.includes('just now') || clean.includes('hour') || clean.includes('minute') || clean.includes('few seconds')) {
        return 0;
    }
    const match = clean.match(/\d+/);
    if (match) {
        return parseInt(match[0], 10);
    }
    if (clean.includes('day')) {
        return 1;
    }
    return 30; // default fallback for older listings
}

// ─── Startup Menu ─────────────────────────────────────────────────────────────

async function promptStartup() {
    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║       Naukri Auto Apply  —  v2.0             ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════════╝\n'));

    // ── 1. LLM Detection ──────────────────────────────────────────────────────
    console.log(chalk.cyan('Checking for local AI...\n'));
    const lmStudioOk = await checkLMStudio();
    const ollamaOk   = await checkOllama();
    console.log('');

    let selectedLLM = 'none';

    if (lmStudioOk && ollamaOk) {
        const llmChoice = await askChoice('Both AI engines detected. Which do you want to use?', [
            `LMStudio  —  ${settings.lmStudioModel}`,
            `Ollama  —  ${getOllamaModel()}`,
            'No AI  —  use saved answers only'
        ]);
        selectedLLM = ['lmstudio', 'ollama', 'none'][llmChoice];
    } else if (lmStudioOk) {
        selectedLLM = 'lmstudio';
        console.log(chalk.green(`  → Using LMStudio (${settings.lmStudioModel})`));
    } else if (ollamaOk) {
        selectedLLM = 'ollama';
        console.log(chalk.green(`  → Using Ollama (${getOllamaModel()})`));
    } else {
        selectedLLM = 'none';
        console.log(chalk.yellow('  ⚠️  No local AI found — using saved answer cache only.'));
    }

    setActiveLLM(selectedLLM);
    await loadResume();

    // ── 2. Job Mode ───────────────────────────────────────────────────────────
    const modeIdx = await askChoice('How do you want to find jobs?', [
        'Recommended Jobs  (Naukri picks for you)',
        'Search by Keyword + Filters'
    ]);

    // ── 3. Search Config (only if search mode) ────────────────────────────────
    let searchOptions = null;
    if (modeIdx === 1) {
        console.log('');
        const keyword  = await ask('Search keyword', 'python');
        const location = await ask('Location',       'india');

        const expIdx = await askChoice('Experience levels to include', [
            'Fresher only  (0 years)',
            '1 year only',
            'Both Fresher + 1 year  ← recommended'
        ], 2);

        const expMap    = [[0], [1], [0, 1]];
        const expLabels = ['Fresher', '1 year', 'Fresher + 1 year'];
        searchOptions = { keyword, location, experienceLevels: expMap[expIdx] };

        console.log(chalk.green(
            `\n  ✅  Search config locked in:\n` +
            `       Keyword    : ${keyword}\n` +
            `       Location   : ${location}\n` +
            `       Experience : ${expLabels[expIdx]}\n` +
            `       Sort by    : Date\n`
        ));
    }

    // ── 4. Job Posting Age Filter ─────────────────────────────────────────────
    const maxDaysStr = await ask('Max job age in days (e.g., 2 for last 2 days, Enter for no limit)', 'any');
    const maxDays = maxDaysStr === 'any' ? null : parseInt(maxDaysStr, 10);

    return {
        mode: modeIdx === 0 ? 'recommended' : 'search',
        searchOptions,
        maxDays
    };
}

// ─── Core Automation ──────────────────────────────────────────────────────────

async function runAutomation(config = {}) {
    const { mode = 'recommended', searchOptions = null, maxDays = 1 } = config || {};

    console.log(chalk.blue.bold('\n--- Starting Naukri Auto Apply ---'));
    await logEvent('START_AUTOMATION', { mode, ...(searchOptions || {}), maxDays });

    const { context, page } = await launchBrowser();

    try {
        await ensureLogin(page);

        // Fetch jobs based on chosen mode
        let jobs = mode === 'search' && searchOptions
            ? await searchNaukriJobs(page, searchOptions)
            : await extractRecommendedJobs(page);

        // Re-acquire the active page after search (Naukri may have navigated or
        // opened/closed tabs, which can invalidate the original page reference)
        let activePage = page;
        try {
            const pages = context.pages();
            if (pages.length > 0 && pages[0].isClosed && !pages[0].isClosed()) {
                activePage = pages[0];
            }
        } catch (_) {}

        // Determine user's max experience level for filtering & answering
        const userMaxExp = searchOptions
            ? Math.max(...searchOptions.experienceLevels)  // e.g. max([0,1])=1
            : 1;                                           // Recommended mode: assume 1 yr

        // Calibrate the answer engine to never exceed the user's experience
        setUserMaxExperience(userMaxExp);

        // Global experience filter: skip jobs that need more experience than the user has
        jobs = filterByExperience(jobs, userMaxExp);

        // Global posting date/age filter
        if (maxDays !== null && !isNaN(maxDays)) {
            const beforeAge = jobs.length;
            jobs = jobs.filter(job => {
                const days = parsePostAgeToDays(job.postedAge);
                return days <= maxDays;
            });
            const filteredOut = beforeAge - jobs.length;
            if (filteredOut > 0) {
                console.log(chalk.gray(`  [Filter] Skipped ${filteredOut} jobs posted > ${maxDays} days ago.`));
            }
        }

        console.log(chalk.cyan(`\n  Jobs to process after filters: ${jobs.length}\n`));

        let appliedCount = 0;

        for (const job of jobs) {
            if (settings.maxDailyApplications && appliedCount >= settings.maxDailyApplications) {
                console.log(chalk.yellow(`Daily limit of ${settings.maxDailyApplications} reached.`));
                break;
            }

            // Skip if already applied
            const alreadyInDb = await isAlreadyApplied(job.jobUrl);
            if (alreadyInDb || job.isAppliedOnPage) {
                console.log(chalk.gray(`  Skip (already applied): ${job.role} @ ${job.company}`));
                if (!alreadyInDb && job.isAppliedOnPage) {
                    await saveApplication({ ...job, status: 'SKIPPED' });
                }
                continue;
            }

            // Score job
            const matchScore = scoreJob(job);
            if (matchScore < 50) {
                console.log(chalk.yellow(`  Skip (low match ${matchScore}): ${job.role}`));
                await saveApplication({ ...job, status: 'SKIPPED', matchScore });
                continue;
            }

            // Apply
            const result = await applyToJob(activePage, job);
            await saveApplication({
                ...job,
                status:       result.status,
                questions:    result.questions,
                answers:      result.answers,
                errorMessage: result.message,
                externalUrl:  result.externalUrl,
                matchScore
            });

            if (result.status === 'SUCCESS') {
                appliedCount++;
                console.log(chalk.green.bold(`  ✅ Applied! (${appliedCount} today)`));
            }

            // Human-like pause between applications
            await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
        }

        console.log(chalk.blue.bold(`\n--- Finished — Applied to ${appliedCount} job(s) today ---`));
        await logEvent('FINISH_AUTOMATION', { appliedCount, mode });

    } catch (error) {
        console.error(chalk.red(`Critical Error: ${error.message}`));
        console.error(error.stack);
        await logEvent('CRITICAL_ERROR', { error: error.message });
    } finally {
        await context.close();
    }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function startup() {
    const { validateProfileSetup } = require('./config/profileLoader');
    if (!validateProfileSetup()) {
        process.exit(1);
    }
    const config = await promptStartup();
    await runAutomation(config);
}

if (require.main === module) {
    startup().catch(err => {
        console.error(chalk.red(`Fatal: ${err.message}`));
        process.exit(1);
    });
}

module.exports = { runAutomation, startup };
