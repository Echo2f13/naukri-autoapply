const { handleQuestions, resetQuestionHistory } = require('./questionHandlers');
const { handleWorkdayApplication } = require('./workdayHandler');
const { randomDelay } = require('./utils');
const { setCurrentJobContext } = require('../ai/answerEngine');
const settings = require('../config/settings');
const path = require('path');
const chalk = require('chalk');

/**
 * Applies to a job given its URL.
 */
async function applyToJob(page, job) {
    resetQuestionHistory();
    setCurrentJobContext(job);
    console.log(chalk.blue.bold(`\n[Processing] ${job.role} at ${job.company}`));
    
    let attempts = 0;
    const MAX_ATTEMPTS = 2;

    while (attempts < MAX_ATTEMPTS) {
        try {
            if (attempts > 0) {
                console.log(chalk.yellow(`  Retrying application (Attempt ${attempts + 1})...`));
                await page.reload({ waitUntil: 'domcontentloaded' });
                await randomDelay(800, 1500);
            } else {
                await page.goto(job.jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            }
            await randomDelay(800, 1500);

            // Check for processing error banner on initial load
            const requestErrorInit = page.locator('text=/There was an error while processing your request/i').first();
            if (await requestErrorInit.isVisible().catch(() => false)) {
                console.log(chalk.red("  ❌ Naukri processing error detected on page load. Skipping job."));
                return { status: 'SKIPPED', message: 'Naukri processing error' };
            }

            // 1. Initial State Checks
            const applyBtn = page.locator('button:text-is("Apply"), #apply-button, .apply-button, .applyBtn, button.apply-button').first();
            const isApplyVisible = await applyBtn.isVisible();

            if (!isApplyVisible) {
                const appliedStatus = page.locator('.job-header .applied-status, .job-header .already-applied, .job-header .alreadyApplied, .already-applied-container').first();
                const isApplied = await appliedStatus.isVisible();
                const appliedText = page.locator('.job-header-container span:text-is("Applied"), .top-header-section span:text-is("Applied")').first();
                const isAppliedTextVisible = await appliedText.isVisible();

                if (isApplied || isAppliedTextVisible) {
                    console.log(chalk.gray("  Already applied. skipping."));
                    return { status: 'SUCCESS', message: 'Already applied' };
                }
            }

            // External application check
            const externalBtn = page.locator('button:text-is("Apply on company site"), button:text-is("Apply on External Website"), a:text-is("Apply on company site"), a:text-is("Apply on External Website")').first();
            if (await externalBtn.isVisible()) {
                console.log(chalk.yellow("  External application button found. Clicking to reveal target URL..."));
                
                let externalPage = page;
                const popupPromise = page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null);
                
                await externalBtn.scrollIntoViewIfNeeded().catch(() => {});
                await externalBtn.click({ force: true });
                
                // Wait for potential new tab
                const newPage = await popupPromise;
                if (newPage) {
                    console.log(chalk.green("  New tab opened for external application."));
                    externalPage = newPage;
                } else {
                    console.log(chalk.gray("  No new tab. Current tab might navigate. Waiting for navigation..."));
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
                }
                
                await randomDelay(1500, 2500);
                const targetUrl = externalPage.url();
                console.log(chalk.blue(`  External Target URL: ${targetUrl}`));

                // ── Detect login / sign-in wall ──────────────────────────────
                // If the external page is asking for credentials (email + password
                // form with a Sign In button), we cannot proceed — skip the job.
                const isLoginWall = await externalPage.evaluate(() => {
                    const bodyText = document.body?.innerText?.toLowerCase() || '';
                    const hasSignIn = bodyText.includes('sign in') || bodyText.includes('log in') || bodyText.includes('login');
                    const hasPasswordField = !!document.querySelector('input[type="password"]');
                    const hasEmailField = !!document.querySelector('input[type="email"], input[name*="email"], input[id*="email"], input[placeholder*="email" i]');
                    return hasSignIn && hasPasswordField && hasEmailField;
                }).catch(() => false);

                if (isLoginWall) {
                    console.log(chalk.yellow('  ⚠️  External site requires login — skipping this job.'));
                    if (newPage) await newPage.close().catch(() => {});
                    return { status: 'SKIPPED', message: 'External site requires login' };
                }
                // ─────────────────────────────────────────────────────────────

                const isWorkday = targetUrl.includes('workdayjobs.com') || 
                                  targetUrl.includes('myworkdayjobs.com') || 
                                  /\.wd\d+\.myworkdayjobs\.com/.test(targetUrl) || 
                                  targetUrl.includes('/en-US/') && targetUrl.includes('/job/');
                                  
                if (isWorkday) {
                    console.log(chalk.magenta("  Workday detected! Starting external automation..."));
                    const res = await handleWorkdayApplication(externalPage, targetUrl);
                    if (newPage) await newPage.close().catch(() => {});
                    return res;
                }
                
                console.log(chalk.yellow("  External application (Non-Workday) detected. skipping."));
                if (newPage) await newPage.close().catch(() => {});
                return { status: 'EXTERNAL', message: 'External link', externalUrl: targetUrl };
            }

            if (!isApplyVisible) {
                console.log(chalk.red("  ❌ Apply button not found (and not marked as applied)."));
                return { status: 'FAILED', message: 'Apply button missing' };
            }

            console.log(chalk.yellow("  Clicking Apply..."));
            await applyBtn.click({ force: true });
            await randomDelay(1000, 1800);

            // Check for processing error banner after clicking apply
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

            // 3. Multi-Step Interaction Loop
            while (iterations < MAX_ITERATIONS) {
                iterations++;

                // Detect UI elements
                const chatbotOverlay = page.locator('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]').first();
                const classicForm = page.locator('.recruiter-questions-container, .bot-questions-container, .question-wrapper').first();
                
                const isChatbot = await chatbotOverlay.isVisible();
                const isClassic = await classicForm.isVisible();

                // Save Buttons
                const sendBtn = page.locator('.chatbot_Drawer div.sendMsg, div.sendMsg, .send-msg-btn').first(); 
                const nextBtn = page.locator('button:text-is("Save"), button:text-is("Submit"), button:text-is("Next"), button:text-is("Apply Now"), .save-button').first();

                const isSendVisible = await sendBtn.isVisible();
                const isNextVisible = await nextBtn.isVisible();

                if (!isChatbot && !isClassic && !isSendVisible && !isNextVisible) {
                    console.log(chalk.gray("  No further questions detected."));
                    break;
                }

                console.log(chalk.cyan(`  Answering questions (Step ${iterations})...`));
                const qa = await handleQuestions(page);
                allQA = allQA.concat(qa);

                await randomDelay(400, 800);

                // Click Submit/Next
                let clicked = false;
                if (isSendVisible) {
                    console.log(chalk.yellow("  Clicking Chatbot Send/Save..."));
                    await sendBtn.click({ force: true });
                    clicked = true;
                } else if (isNextVisible) {
                    const btnText = (await nextBtn.innerText()).trim();
                    console.log(chalk.yellow(`  Clicking "${btnText}"...`));
                    
                    if (btnText === lastButtonText) {
                        noProgressCount++;
                        if (noProgressCount >= 3) {
                            console.log(chalk.red("  Stuck on same button. breaking."));
                            break;
                        }
                    } else {
                        noProgressCount = 0;
                    }
                    
                    if (btnText.toLowerCase().includes('saved')) {
                        console.log(chalk.green("  Application button shows 'Saved'."));
                        break;
                    }

                    await nextBtn.click({ force: true });
                    lastButtonText = btnText;
                    clicked = true;
                }

                if (!clicked) break;
                await randomDelay(800, 1500);
            }

            // 4. Final Verification
            console.log(chalk.gray("  Verifying application success..."));
            await page.waitForTimeout(1500);

            // Check for explicit error messages
            const errorSelectors = [
                '.error-banner', '.error-msg', '.err-msg',
                'div:has-text("mandatory questions")', 
                'div:has-text("not accepted")',
                'div:has-text("something went wrong")',
                'div:has-text("Oops!")'
            ];
            
            for (const sel of errorSelectors) {
                const err = page.locator(sel).first();
                if (await err.isVisible()) {
                    const txt = await err.innerText();
                    console.log(chalk.red(`  ❌ Application Error Detected: ${txt}`));
                    attempts++;
                    await page.screenshot({ path: path.join('screenshots', `error-${Date.now()}.png`) }).catch(()=>{});
                    continue; 
                }
            }

            const successSelectors = [
                '.job-header span:text-is("Applied")',
                '.job-header .already-applied',
                '.job-header .applied-status',
                '.apply-success-container',
                'p:has-text("successfully submitted")',
                'div:has-text("Application sent")'
            ];

            let successFound = false;
            for (const sel of successSelectors) {
                if (await page.locator(sel).first().isVisible()) {
                    successFound = true;
                    break;
                }
            }

            if (successFound) {
                console.log(chalk.green.bold("  ✔ SUCCESS: Application submitted successfully!"));
                return { status: 'SUCCESS', questions: allQA.map(q => q.question), answers: allQA.map(q => q.answer) };
            }

            const stillHasApply = await page.locator('button:text-is("Apply"), #apply-button').first().isVisible();
            const chatbotStillOpen = await page.locator('.chatbot_Drawer, .chatbot_Overlay').first().isVisible();
            
            if (!stillHasApply && !chatbotStillOpen && (iterations > 0 || successFound)) {
                console.log(chalk.green("  ✔ SUCCESS (Inferred): Form closed and Apply button gone."));
                return { status: 'SUCCESS', questions: allQA.map(q => q.question), answers: allQA.map(q => q.answer) };
            }

            console.log(chalk.red("  ❌ Could not verify success. Marking as failed."));
            attempts++;

        } catch (err) {
            console.error(chalk.red(`  ❌ Error: ${err.message}`));
            attempts++;
            await randomDelay(800, 1200);
        }
    }

    return { status: 'FAILED', message: 'Max attempts reached' };
}

module.exports = { applyToJob };
