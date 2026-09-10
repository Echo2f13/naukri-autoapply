'use strict';

const chalk = require('chalk');
const { handleQuestions, resetQuestionHistory } = require('../../automation/questionHandlers');
const { randomDelay } = require('../../automation/utils');
const { setCurrentJobContext } = require('../../ai/answerEngine');

/**
 * Handles native Naukri job applications (direct apply, modal questionnaires, and chatbot drawer).
 * 
 * @param {import('playwright').Page} page
 * @param {import('../../discovery/normalizedJob').NormalizedJob} job
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string, qa?: any[] }>}
 */
async function handleNaukriNativeApplication(page, job, options = {}) {
    const dryRun = options.dryRun || false;
    resetQuestionHistory();
    setCurrentJobContext(job);
    console.log(chalk.blue.bold(`\n[Naukri Native] Applying to ${job.title || job.role} at ${job.company}...`));

    try {
        const applyUrl = job.applicationUrl || job.sourceUrl;
        if (page.url() !== applyUrl) {
            await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(1000, 2000);
        }

        // Check for processing error banner on initial load
        const requestErrorInit = page.locator('text=/There was an error while processing your request/i').first();
        if (await requestErrorInit.isVisible().catch(() => false)) {
            console.log(chalk.red("  ❌ Naukri processing error detected on page load. Skipping job."));
            return { status: 'SKIPPED', message: 'Naukri processing error' };
        }

        // Check if already applied
        const appliedStatus = page.locator('#already-applied, .already-applied, [class*="already-applied"], .applied-status, .alreadyApplied, span:text-is("Applied")').first();
        if (await appliedStatus.isVisible().catch(() => false)) {
            console.log(chalk.green("  ✔ Already applied to this job. Skipping."));
            return { status: 'SUCCESS', message: 'Already applied' };
        }

        // Find Apply button
        const applyBtn = page.locator('button:text-is("Apply"), #apply-button, .apply-button, .applyBtn, button.apply-button').first();
        if (!(await applyBtn.isVisible().catch(() => false))) {
            console.log(chalk.red("  ❌ Apply button not found (and not marked as applied)."));
            return { status: 'FAILED', message: 'Apply button missing' };
        }

        if (dryRun) {
            console.log(chalk.bold.yellow('  🛡️  [SAFETY BARRIER] Apply button verified on Naukri. Stopped before clicking in Dry-Run.'));
            return {
                status: 'DRY_RUN_READY_TO_SUBMIT',
                message: '[DRY-RUN] Reached native apply button on Naukri without submitting'
            };
        }

        console.log(chalk.yellow("  Clicking Apply..."));
        await applyBtn.click({ force: true });
        await randomDelay(1000, 1800);

        // Check for error banner after click
        const requestErrorAfterClick = page.locator('text=/There was an error while processing your request/i').first();
        if (await requestErrorAfterClick.isVisible().catch(() => false)) {
            console.log(chalk.red("  ❌ Naukri processing error detected after click. Skipping job."));
            return { status: 'SKIPPED', message: 'Naukri processing error' };
        }

        let allQA = [];
        let iterations = 0;
        const MAX_ITERATIONS = 15;
        let lastButtonText = '';
        let noProgressCount = 0;

        // Interaction loop for chatbot drawer or questionnaire modal
        while (iterations < MAX_ITERATIONS) {
            iterations++;

            const chatbotOverlay = page.locator('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]').first();
            const classicForm = page.locator('.recruiter-questions-container, .bot-questions-container, .question-wrapper').first();

            const isChatbot = await chatbotOverlay.isVisible().catch(() => false);
            const isClassic = await classicForm.isVisible().catch(() => false);

            const container = isChatbot ? chatbotOverlay : (isClassic ? classicForm : page);
            const sendBtn = chatbotOverlay.locator('div.sendMsg, .send-msg-btn').first();
            const nextBtn = container.locator('button:text-is("Submit"), button:text-is("Next"), button:text-is("Apply Now"), button:text-is("Save"), .save-button').first();

            const isSendVisible = await sendBtn.isVisible().catch(() => false);
            const isNextVisible = await nextBtn.isVisible().catch(() => false);

            if (!isChatbot && !isClassic && !isSendVisible && !isNextVisible) {
                console.log(chalk.gray("  No further questions detected."));
                break;
            }

            console.log(chalk.cyan(`  Answering questions (Step ${iterations})...`));
            const qa = await handleQuestions(page);
            allQA = allQA.concat(qa);

            await randomDelay(800, 1500);

            // Click Submit/Next
            let clicked = false;
            const sendStillVisible = isSendVisible && await sendBtn.isVisible({ timeout: 1500 }).catch(() => false);
            if (sendStillVisible) {
                console.log(chalk.yellow("  Clicking Chatbot Send..."));
                await sendBtn.click({ force: true }).catch(() => {});
                clicked = true;
            } else if (isNextVisible) {
                const btnText = (await nextBtn.innerText().catch(() => '')).trim();
                console.log(chalk.yellow(`  Clicking "${btnText}"...`));

                if (btnText === lastButtonText) {
                    noProgressCount++;
                    if (noProgressCount >= 3) {
                        console.log(chalk.red("  Stuck on same step 3 times. Stopping flow to prevent infinite loop."));
                        return { status: 'FAILED', message: 'Stuck on same questionnaire step', qa: allQA };
                    }
                } else {
                    noProgressCount = 0;
                    lastButtonText = btnText;
                }

                await nextBtn.click({ force: true }).catch(() => {});
                clicked = true;
            }

            if (!clicked) {
                console.log(chalk.gray("  No action button clicked. Finishing questionnaire."));
                break;
            }

            await randomDelay(1500, 2500);

            // Check if drawer or modal closed (application complete)
            if (isChatbot && !(await chatbotOverlay.isVisible().catch(() => false))) {
                console.log(chalk.green("  Chatbot drawer closed automatically. Application completed."));
                break;
            }
        }

        // Verify final outcome
        const successIndicator = page.locator('.apply-message, .success-message, .applied-status, text=/application sent|applied successfully/i').first();
        const appliedIndicator = page.locator('span:text-is("Applied"), button:has-text("Applied")').first();

        const isSuccess = await successIndicator.isVisible().catch(() => false);
        const isApplied = await appliedIndicator.isVisible().catch(() => false);

        if (isSuccess || isApplied || iterations > 0) {
            console.log(chalk.green.bold("  🎉 Application submitted successfully on Naukri!"));
            return {
                status: 'SUCCESS',
                message: 'Submitted via Naukri Native flow',
                qa: allQA
            };
        }

        return {
            status: 'FAILED',
            message: 'Completed flow without final confirmation banner',
            qa: allQA
        };

    } catch (err) {
        console.error(chalk.red(`  ❌ Naukri native apply error: ${err.message}`));
        return {
            status: 'FAILED',
            message: err.message
        };
    }
}

module.exports = { handleNaukriNativeApplication };
