const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const chalk = require('chalk');
const { launchBrowser } = require('../../../automation/browser');
const { ensureLogin } = require('../../../automation/login');
const { checkOllama } = require('../../../ai/ollama');
const { setActiveLLM } = require('../../../ai/answerEngine');
const { applyToJob } = require('../../../automation/apply');
const prisma = require('../../../db/prisma');
const { saveApplication } = require('../../../db/queries');

const targetJob = {
    role: 'Management Trainee - Junior Developers',
    company: 'Newt Global',
    location: 'Chennai',
    experience: '0-1 Yrs',
    jobUrl: 'https://www.naukri.com/job-listings-management-trainee-junior-developers-newt-global-chennai-0-to-1-years-080926503253?src=drecomm_profile&sid=17889463928512747&xp=2&px=1'
};

async function main() {
    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║   Newt Global — Management Trainee Apply Bot (External)       ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.cyan(`Target Job: ${targetJob.role} @ ${targetJob.company}`));
    console.log(chalk.cyan(`Location: ${targetJob.location} | Exp: ${targetJob.experience}`));
    console.log(chalk.cyan(`URL: ${targetJob.jobUrl}\n`));

    // 1. Verify Ollama Connection
    console.log(chalk.blue('Checking Ollama connection...'));
    const online = await checkOllama();
    if (!online) {
        console.error(chalk.red.bold('❌ Ollama server is offline or unreachable.'));
        process.exit(1);
    }
    setActiveLLM('ollama');

    // Clean prior DB entry for this specific job if any
    try {
        await prisma.appliedJob.deleteMany({
            where: {
                OR: [
                    { jobUrl: targetJob.jobUrl },
                    { jobUrl: { contains: '080926503253' } }
                ]
            }
        });
        console.log(chalk.gray('Cleaned previous DB test records for this job if any.'));
    } catch (_) {}

    // 2. Launch Browser (headed mode)
    console.log(chalk.blue('\nLaunching browser in headed mode...'));
    const { context, page } = await launchBrowser();

    try {
        await ensureLogin(page);

        console.log(chalk.blue('\nExecuting application flow with supervisor monitoring...'));
        const result = await applyToJob(page, targetJob);

        console.log(chalk.bold.green(`\nApplication process finished with status: ${result.status}`));
        if (result.message) console.log(chalk.cyan(`Message: ${result.message}`));
        if (result.resumeUsed) console.log(chalk.cyan(`Resume Used: ${result.resumeUsed}`));
        if (result.externalUrl) console.log(chalk.cyan(`External Portal URL: ${result.externalUrl}`));

        // Save record to DB
        await saveApplication({
            ...targetJob,
            status: result.status,
            matchScore: 100
        });
        console.log(chalk.green('✔ Application recorded in database.'));

        console.log(chalk.gray('\nKeeping browser window open for 10 seconds for user inspection...'));
        await page.waitForTimeout(10000);

    } catch (err) {
        console.error(chalk.red('\n❌ Unexpected error during application:'), err);
    } finally {
        await context.close();
        console.log(chalk.green('Browser closed. Run complete!'));
    }
}

main().catch(err => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
});
