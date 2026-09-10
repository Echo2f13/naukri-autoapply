const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const chalk = require('chalk');
const { launchBrowser } = require('../../automation/browser');
const { ensureLogin } = require('../../automation/login');
const { searchNaukriJobs } = require('../../automation/searchJobs');
const { applyToJob } = require('../../automation/apply');
const { scoreJob } = require('../../ai/jobScorer');
const { isAlreadyApplied, saveApplication } = require('../../db/queries');
const { checkOllama, getOllamaModel } = require('../../ai/ollama');
const { loadResume } = require('../../ai/prompts');
const { setActiveLLM, setUserMaxExperience } = require('../../ai/answerEngine');
const { randomDelay } = require('../../automation/utils');

const TARGET_APPLICATIONS = 3;
const SEARCH_CONFIG = {
    keyword: 'AI Engineer',
    location: 'india',
    experienceLevels: [0, 1], // Fresher (0) and 1 year
    maxPages: 2
};

function filterByExperience(jobs, maxExp = 1) {
    const threshold = maxExp + 1; // max 2 years for 1 year profile
    const before = jobs.length;
    const filtered = jobs.filter(job => {
        const expStr = (job.experience || '').toLowerCase().trim();
        if (!expStr || expStr === 'n/a') return true;
        if (expStr.includes('fresher') || expStr.includes('entry')) return true;
        const nums = expStr.match(/\d+/g);
        if (!nums) return true;
        const minRequired = parseInt(nums[0], 10);
        return minRequired <= threshold;
    });
    const removed = before - filtered.length;
    if (removed > 0) {
        console.log(chalk.gray(`  [Filter] Skipped ${removed} jobs requiring > ${threshold} year(s) experience.`));
    }
    return filtered;
}

async function main() {
    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║      Search & Apply — AI Engineer (Fresher / 1 Yr)           ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.cyan(`Target Applications: ${TARGET_APPLICATIONS}`));
    console.log(chalk.cyan(`Keyword: ${SEARCH_CONFIG.keyword} | Location: ${SEARCH_CONFIG.location}`));
    console.log(chalk.cyan(`Experience Levels: Fresher (0) & 1 year\n`));

    // 1. Verify Ollama Connection
    console.log(chalk.blue('Checking Ollama connection...'));
    const online = await checkOllama();
    if (!online) {
        console.error(chalk.red.bold('❌ Ollama server is offline or unreachable.'));
        process.exit(1);
    }
    console.log(chalk.green(`✔ Ollama is online with model: ${getOllamaModel()}`));
    setActiveLLM('ollama');
    await loadResume();
    setUserMaxExperience(1);

    // 2. Launch Browser (Headed Mode)
    console.log(chalk.blue('\nLaunching browser in headed mode...'));
    const { context, page } = await launchBrowser();

    const summary = [];

    try {
        await ensureLogin(page);

        // 3. Search for jobs
        console.log(chalk.blue('\nSearching Naukri for matching jobs...'));
        let jobs = await searchNaukriJobs(page, SEARCH_CONFIG);
        console.log(chalk.green(`Total listings found from search: ${jobs.length}`));

        // 4. Filter by experience
        jobs = filterByExperience(jobs, 1);
        console.log(chalk.cyan(`Jobs eligible after experience filter: ${jobs.length}`));

        let appliedCount = 0;
        let processedCount = 0;

        for (const job of jobs) {
            if (appliedCount >= TARGET_APPLICATIONS) {
                console.log(chalk.bold.green(`\n🎯 Target of ${TARGET_APPLICATIONS} successful applications reached!`));
                break;
            }

            processedCount++;
            console.log(chalk.bold.magenta(`\n──────────────────────────────────────────────────────────────`));
            console.log(chalk.bold.magenta(`[Job #${processedCount}] ${job.role} @ ${job.company}`));
            console.log(chalk.gray(`Location: ${job.location} | Experience: ${job.experience}`));
            console.log(chalk.gray(`URL: ${job.jobUrl}`));

            // Check if already applied
            const alreadyInDb = await isAlreadyApplied(job.jobUrl);
            if (alreadyInDb || job.isAppliedOnPage) {
                console.log(chalk.gray(`  ↳ Skipped: Already applied previously.`));
                summary.push({
                    role: job.role,
                    company: job.company,
                    status: 'SKIPPED',
                    reason: 'Already applied'
                });
                continue;
            }

            // Score job
            const matchScore = scoreJob(job);
            if (matchScore < 50) {
                console.log(chalk.yellow(`  ↳ Skipped: Low match score (${matchScore}/100).`));
                await saveApplication({ ...job, status: 'SKIPPED', matchScore });
                summary.push({
                    role: job.role,
                    company: job.company,
                    status: 'SKIPPED',
                    reason: `Low match score (${matchScore})`
                });
                continue;
            }

            // Ensure active page is valid
            let activePage = page;
            try {
                const pages = context.pages().filter(p => !p.isClosed());
                if (pages.length > 0) activePage = pages[0];
            } catch (_) {}

            // Apply to job
            console.log(chalk.blue(`  ↳ Attempting application (Match Score: ${matchScore})...`));
            const result = await applyToJob(activePage, job);

            const finalStatus = result.status;
            await saveApplication({
                ...job,
                status: finalStatus,
                matchScore,
                recruiterQuestions: result.questions || [],
                aiAnswers: result.answers || [],
                errorMessage: result.message || null,
                externalUrl: result.externalUrl || null
            });

            summary.push({
                role: job.role,
                company: job.company,
                status: finalStatus,
                message: result.message || 'N/A',
                resumeUsed: result.resumeUsed || 'N/A'
            });

            if (finalStatus === 'SUCCESS') {
                appliedCount++;
                console.log(chalk.bold.green(`  ✔ Applied successfully! (${appliedCount}/${TARGET_APPLICATIONS})`));
            } else {
                console.log(chalk.yellow(`  ↳ Finished with status: ${finalStatus} (${result.message || 'No details'})`));
            }

            // Pause between applications to simulate natural browsing
            console.log(chalk.gray('  Waiting 4 seconds before next job...'));
            await randomDelay(3000, 5000);
        }

        console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
        console.log(chalk.bold.cyan('║                    BATCH RUN SUMMARY                         ║'));
        console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

        console.table(summary);
        console.log(chalk.bold.green(`\nTotal Applied: ${appliedCount} / ${TARGET_APPLICATIONS}`));

    } catch (err) {
        console.error(chalk.red('\n❌ Error during search & apply execution:'), err);
    } finally {
        await context.close().catch(() => {});
        console.log(chalk.green('Browser closed. Run finished.'));
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red('Fatal error:'), err);
        process.exit(1);
    });
}

module.exports = { main, filterByExperience };
