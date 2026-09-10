const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const chalk = require('chalk');
const { launchBrowser } = require('../../../automation/browser');
const { ensureLogin } = require('../../../automation/login');
const { applyToJob } = require('../../../automation/apply');
const { saveApplication } = require('../../../db/queries');
const { checkLMStudio } = require('../../../ai/lmstudio');
const { checkOllama, getOllamaModel } = require('../../../ai/ollama');
const { loadResume } = require('../../../ai/prompts');
const { setActiveLLM, setUserMaxExperience } = require('../../../ai/answerEngine');
const prisma = require('../../../db/prisma');

const targetJob = {
    role: 'Associate Software Engineer',
    company: 'Tredence',
    location: 'Bengaluru',
    experience: '0-2 Yrs',
    jobUrl: 'https://www.naukri.com/job-listings-associate-software-engineer-tredence-bengaluru-0-to-2-years-040926011650?src=drecomm_apply&sid=1788903337779641&xp=1&px=1'
};

async function main() {
    console.log(chalk.bold.cyan('\n=== Applying to Specific Target Job ==='));
    console.log(chalk.cyan(`Target: ${targetJob.role} @ ${targetJob.company}`));
    console.log(chalk.cyan(`URL: ${targetJob.jobUrl}\n`));

    // 1. AI Init
    const lmStudioOk = await checkLMStudio();
    const ollamaOk = await checkOllama();

    if (lmStudioOk) {
        setActiveLLM('lmstudio');
    } else if (ollamaOk) {
        setActiveLLM('ollama');
    } else {
        setActiveLLM('none');
    }

    await loadResume();
    setUserMaxExperience(2); // Set user max experience to 2 to accommodate 0-2 yrs

    // Remove any previous DB entry for this exact URL so it doesn't get blocked
    try {
        await prisma.appliedJob.deleteMany({
            where: {
                OR: [
                    { jobUrl: targetJob.jobUrl },
                    { jobUrl: { contains: '040926011650' } }
                ]
            }
        });
        console.log(chalk.gray('Cleaned previous DB test entries for this job if any.'));
    } catch (e) {
        // ignore
    }

    // 2. Launch Browser
    console.log(chalk.blue('Launching browser (headed mode)...'));
    const { context, page } = await launchBrowser();

    try {
        await ensureLogin(page);

        console.log(chalk.blue('\nProceeding to apply to target job...'));
        const result = await applyToJob(page, targetJob);

        console.log(chalk.bold.magenta('\nResult:'), result);

        await saveApplication({
            ...targetJob,
            status: result.status,
            questions: result.questions || [],
            answers: result.answers || [],
            errorMessage: result.message || null,
            externalUrl: result.externalUrl || null,
            matchScore: 100
        });

        if (result.status === 'SUCCESS') {
            console.log(chalk.green.bold('\n🎉 Successfully applied to Tredence!'));
        } else {
            console.log(chalk.yellow(`\nFinished with status: ${result.status} (${result.message || 'No message'})`));
        }

        // Keep browser open for a few seconds so user can see the final page
        await page.waitForTimeout(5000);

    } catch (err) {
        console.error(chalk.red('Error applying to job:'), err);
    } finally {
        await context.close();
        process.exit(0);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
