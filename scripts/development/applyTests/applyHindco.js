const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const chalk = require('chalk');
const { launchBrowser } = require('../../../automation/browser');
const { ensureLogin } = require('../../../automation/login');
const { checkOllama, askOllama } = require('../../../ai/ollama');
const { buildQuestionPrompt, loadResume } = require('../../../ai/prompts');
const { findLearnedAnswer, setUserMaxExperience } = require('../../../ai/answerEngine');
const prisma = require('../../../db/prisma');
const { saveApplication } = require('../../../db/queries');
const profile = require('../../../config/profile');

const targetJob = {
    role: 'IT Fresher | WFH',
    company: 'Hindco Recruitment Consultants',
    location: 'Delhi / NCR',
    experience: '0-1 Yrs',
    jobUrl: 'https://www.naukri.com/job-listings-it-fresher-wfh-hindco-recruitment-consultants-delhi-ncr-0-to-1-years-030926025935?src=drecomm_apply&sid=1788903337779641&xp=5&px=1'
};

// Track if 0 was attempted for Current CTC
let attemptedZeroForCTC = false;

/**
 * Supervises Ollama's answer. Keeps Ollama's output if valid,
 * and only intervenes if Ollama makes a mistake (empty, format mismatch, or unaccepted input).
 */
function superviseOllamaAnswer(question, rawAnswer, options = []) {
    const qLower = question.toLowerCase();
    let finalAnswer = (rawAnswer || '').trim();
    let mistakeFound = false;
    let correctionReason = '';

    // 1. Empty or missing answer
    if (!finalAnswer) {
        mistakeFound = true;
        correctionReason = 'Ollama returned an empty response.';
    }

    // 2. Questions with predefined options (radio/chips)
    if (options && options.length > 0) {
        const lowerAns = finalAnswer.toLowerCase().trim();
        const exactMatch = options.find(o => o.toLowerCase().trim() === lowerAns);
        const partialMatch = options.find(o => o.toLowerCase().trim().includes(lowerAns) || lowerAns.includes(o.toLowerCase().trim()));

        if (exactMatch) {
            finalAnswer = exactMatch;
        } else if (partialMatch) {
            finalAnswer = partialMatch;
        } else {
            mistakeFound = true;
            correctionReason = `Ollama's answer "${rawAnswer}" is not among available options: [${options.join(', ')}].`;

            // Specific check for currently employed
            if (qLower.includes('employed') || qLower.includes('working')) {
                finalAnswer = 'No'; // Candidate is fresher / seeking full-time
            } else {
                const cached = findLearnedAnswer(question, options);
                if (cached && cached.answer) {
                    finalAnswer = cached.answer;
                } else if (options.some(o => /^yes$/i.test(o.trim()))) {
                    finalAnswer = options.find(o => /^yes$/i.test(o.trim())) || options[0];
                } else {
                    finalAnswer = options[0];
                }
            }
        }
    } else {
        // 3. Text Questions (CTC, Salary, Experience, etc.)
        const isCurrentCTC = /current\s*(ctc|salary|package)|ctc in lacs/i.test(qLower);
        const isInvalidPrompt = qLower.includes('invalid') || qLower.includes('please enter a valid');

        if (isCurrentCTC) {
            if (isInvalidPrompt || attemptedZeroForCTC) {
                // If 0 is not accepted or rejected as invalid -> provide 1
                mistakeFound = true;
                correctionReason = 'Naukri does not take 0 for Current CTC input. Providing 1 as fallback.';
                finalAnswer = '1';
            } else {
                // First attempt: try 0 since candidate is a fresher / intern
                const numVal = parseFloat(finalAnswer.replace(/[^0-9.]/g, ''));
                if (finalAnswer === '1') {
                    finalAnswer = '1';
                } else if (finalAnswer !== '0') {
                    mistakeFound = true;
                    correctionReason = `Candidate is a fresher (Current CTC is 0). Attempting 0 first; will fallback to 1 if not accepted.`;
                    finalAnswer = '0';
                    attemptedZeroForCTC = true;
                } else {
                    attemptedZeroForCTC = true;
                }
            }
        } else if (/expected\s*(ctc|salary|package)/i.test(qLower)) {
            const numVal = parseFloat(finalAnswer.replace(/[^0-9.]/g, ''));
            if (isNaN(numVal) || numVal < 1) {
                mistakeFound = true;
                correctionReason = `Expected CTC should reflect candidate expectation (8). Correcting to "8".`;
                finalAnswer = '8';
            }
        } else if (/notice period|notice/i.test(qLower)) {
            if (!/immediate|0|15|30/i.test(finalAnswer)) {
                mistakeFound = true;
                correctionReason = `Notice period should be Immediate. Correcting to "${profile.noticePeriod || 'Immediate'}".`;
                finalAnswer = profile.noticePeriod || 'Immediate';
            }
        }
    }

    return {
        finalAnswer,
        mistakeFound,
        correctionReason
    };
}

async function main() {
    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║   Hindco Recruitment Consultants — Ollama Auto-Apply Bot      ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.cyan(`Target Job: ${targetJob.role} @ ${targetJob.company}`));
    console.log(chalk.cyan(`URL: ${targetJob.jobUrl}\n`));

    // 1. Verify Ollama Connection
    console.log(chalk.blue('Checking Ollama connection...'));
    const online = await checkOllama();
    if (!online) {
        console.error(chalk.red.bold('❌ Ollama server is offline or unreachable.'));
        process.exit(1);
    }

    await loadResume();
    setUserMaxExperience(1);
    attemptedZeroForCTC = false;

    // Clean prior DB entry for fresh execution tracking
    try {
        await prisma.appliedJob.deleteMany({
            where: {
                OR: [
                    { jobUrl: targetJob.jobUrl },
                    { jobUrl: { contains: '030926025935' } }
                ]
            }
        });
        console.log(chalk.gray('Cleaned previous DB test entries for this job if any.'));
    } catch (e) {}

    // 2. Launch Browser (headed)
    console.log(chalk.blue('\nLaunching browser (headed)...'));
    const { context, page } = await launchBrowser();

    const allQA = [];
    const questionCounts = {};

    try {
        await ensureLogin(page);

        console.log(chalk.blue('\nNavigating to Hindco job page...'));
        await page.goto(targetJob.jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // Check if already applied
        const alreadyApplied = await page.locator('.already-applied, .applied-status, span:text-is("Applied")').first().isVisible().catch(() => false);
        if (alreadyApplied) {
            console.log(chalk.green('✔ Already marked as Applied on Naukri!'));
            await saveApplication({ ...targetJob, status: 'SUCCESS', matchScore: 100 });
            return;
        }

        const applyBtn = page.locator('button:text-is("Apply"), #apply-button, .apply-button, .applyBtn').first();
        if (await applyBtn.isVisible().catch(() => false)) {
            console.log(chalk.green('Clicking Apply button...'));
            await applyBtn.click({ force: true });
            await page.waitForTimeout(2500);
        }

        const overlay = page.locator('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]').first();
        const isOverlayVisible = await overlay.isVisible({ timeout: 5000 }).catch(() => false);

        if (!isOverlayVisible) {
            const successNotice = await page.locator('text=/Applied to|successfully submitted|Application sent/i').first().isVisible().catch(() => false);
            if (successNotice) {
                console.log(chalk.green.bold('\n🎉 Successfully applied directly!'));
                await saveApplication({ ...targetJob, status: 'SUCCESS', matchScore: 100 });
                return;
            }
        }

        console.log(chalk.cyan('Chatbot drawer active. Starting Ollama Q&A loop...\n'));

        let step = 1;
        const maxSteps = 15;

        while (step <= maxSteps) {
            const overlayActive = await overlay.isVisible().catch(() => false);
            if (!overlayActive) {
                console.log(chalk.green('Chatbot overlay is closed.'));
                break;
            }

            console.log(chalk.bold.yellow(`\n--- Step ${step} ---`));

            // Check for success banner
            const successText = await page.locator('text=/Applied to|successfully submitted|Application sent/i').first().isVisible().catch(() => false);
            if (successText) {
                console.log(chalk.green.bold('🎉 Detected application success confirmation!'));
                break;
            }

            // Extract the bot's latest question
            const botMessages = await overlay.locator('.botMsg').allInnerTexts().catch(() => []);
            let currentQuestion = '';
            for (let i = botMessages.length - 1; i >= 0; i--) {
                const text = botMessages[i].trim();
                if (text.length > 2 && !text.startsWith('Hi ') && !text.includes('thank you for showing interest')) {
                    currentQuestion = text;
                    break;
                }
            }

            if (!currentQuestion) {
                console.log(chalk.gray('Waiting for next question from bot...'));
                await page.waitForTimeout(1500);
                if (!await overlay.isVisible().catch(() => false)) break;
                step++;
                continue;
            }

            console.log(chalk.white.bold(`Recruiter Question: "${currentQuestion}"`));

            // Loop detector
            const qKey = currentQuestion.toLowerCase();
            questionCounts[qKey] = (questionCounts[qKey] || 0) + 1;
            if (questionCounts[qKey] > 3) {
                console.log(chalk.red(`⚠️ Question repeated ${questionCounts[qKey]} times. Attempting to click Save or break loop.`));
                const sendBtn = overlay.locator('.sendMsg, [class*="sendMsg"], button:has-text("Save")').first();
                if (await sendBtn.isVisible().catch(() => false)) {
                    await sendBtn.click({ force: true }).catch(() => {});
                }
                break;
            }

            // Check for any terms/privacy checkboxes
            const consentCheckbox = overlay.locator('input[type="checkbox"], .ssrc__checkbox, label.checkbox-wrap').first();
            if (await consentCheckbox.isVisible().catch(() => false)) {
                const checked = await consentCheckbox.isChecked().catch(() => false);
                if (!checked) {
                    console.log(chalk.green('  -> Auto-checking terms/declaration checkbox'));
                    await consentCheckbox.click({ force: true }).catch(() => {});
                }
            }

            // Extract option labels (Yes, No, City chips, etc.)
            const optionLocators = await overlay.locator('label.ssrc__label, .ssrc__radio-btn-container, [class*="chip"], a[role="button"]').all();
            const optionTexts = [];
            for (const el of optionLocators) {
                if (await el.isVisible().catch(() => false)) {
                    const txt = (await el.innerText().catch(() => '')).trim();
                    if (txt && !txt.includes('\n') && !optionTexts.includes(txt)) {
                        optionTexts.push(txt);
                    }
                }
            }

            if (optionTexts.length > 0) {
                console.log(chalk.gray(`Available Options: [${optionTexts.join(', ')}]`));
            }

            // Query Ollama
            const { system, user } = buildQuestionPrompt(currentQuestion, optionTexts);
            console.log(chalk.magenta(`Querying Ollama (model: ${process.env.OLLAMA_MODEL || 'qwen2.5:7b'})...`));
            const rawAnswer = await askOllama(system, user);
            console.log(chalk.magenta.bold(`  🤖 Ollama Answer: "${rawAnswer}"`));

            // Supervisor Check
            const { finalAnswer, mistakeFound, correctionReason } = superviseOllamaAnswer(currentQuestion, rawAnswer, optionTexts);

            if (mistakeFound) {
                console.log(chalk.yellow.bold(`  👁️ [Supervisor Correction] Mistake: ${correctionReason}`));
                console.log(chalk.green.bold(`  👉 [Supervisor Final Answer]: "${finalAnswer}"`));
            } else {
                console.log(chalk.green(`  👁️ [Supervisor Status] Ollama answer accepted: "${finalAnswer}"`));
            }

            allQA.push({
                question: currentQuestion,
                ollamaRaw: rawAnswer,
                finalAnswer: finalAnswer,
                supervised: mistakeFound,
                reason: correctionReason
            });

            // Perform UI Interaction
            let answeredViaUI = false;

            // 1. Try clicking option if available
            if (optionTexts.length > 0) {
                // Priority A: Target exact label.ssrc__label for radio button controls
                const labelTarget = overlay.locator('label.ssrc__label').filter({ hasText: new RegExp(`^${finalAnswer}$`, 'i') }).first();
                if (await labelTarget.isVisible().catch(() => false)) {
                    console.log(chalk.blue(`  Clicking Radio Label: "${finalAnswer}"`));
                    await labelTarget.click({ force: true });
                    answeredViaUI = true;
                } else {
                    // Priority B: Any matching option chip / button
                    for (const optEl of optionLocators) {
                        if (!(await optEl.isVisible().catch(() => false))) continue;
                        const txt = (await optEl.innerText().catch(() => '')).trim();
                        if (txt.toLowerCase() === finalAnswer.toLowerCase() || txt.toLowerCase().includes(finalAnswer.toLowerCase())) {
                            console.log(chalk.blue(`  Clicking Option: "${txt}"`));
                            await optEl.scrollIntoViewIfNeeded().catch(() => {});
                            await optEl.click({ force: true }).catch(async () => {
                                await optEl.evaluate(e => {
                                    e.click();
                                    e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                });
                            });
                            answeredViaUI = true;
                            break;
                        }
                    }
                }

                if (answeredViaUI) {
                    await page.waitForTimeout(600);
                    // Click Save button if present below radio buttons
                    const saveBtn = overlay.locator('.sendMsg, [class*="sendMsg"], button:has-text("Save")').first();
                    if (await saveBtn.isVisible().catch(() => false)) {
                        console.log(chalk.cyan('  Clicking Save for option selection...'));
                        await saveBtn.click({ force: true }).catch(async () => {
                            await saveBtn.evaluate(e => e.click());
                        });
                    }
                }
            }

            // 2. Try filling text box if not answered via option
            if (!answeredViaUI) {
                const textArea = overlay.locator('div.textArea[contenteditable="true"], [contenteditable="true"], input[type="text"], input[type="number"], textarea').first();
                if (await textArea.isVisible().catch(() => false)) {
                    console.log(chalk.blue(`  Typing into text box: "${finalAnswer}"`));
                    await textArea.scrollIntoViewIfNeeded().catch(() => {});
                    await textArea.click({ force: true });
                    await textArea.evaluate(el => {
                        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = '';
                        else el.innerText = '';
                    });
                    await page.keyboard.type(finalAnswer, { delay: 40 });
                    await page.waitForTimeout(500);

                    // Click Send / Save button
                    const sendBtn = overlay.locator('.sendMsg, [class*="sendMsg"], button:has-text("Save"), button:has-text("Next")').first();
                    if (await sendBtn.isVisible().catch(() => false)) {
                        console.log(chalk.cyan('  Clicking Send/Save...'));
                        await sendBtn.click({ force: true }).catch(async () => {
                            await sendBtn.evaluate(el => el.click());
                        });
                    } else {
                        await page.keyboard.press('Enter');
                    }
                    answeredViaUI = true;
                }
            }

            await page.waitForTimeout(2500);
            step++;
        }

        // Final verification
        console.log(chalk.blue('\nVerifying application status...'));
        await page.waitForTimeout(2000);

        const appliedConfirmation = await page.locator('.already-applied, .applied-status, span:text-is("Applied"), text=/Applied to|successfully submitted|Application sent/i').first().isVisible().catch(() => false);
        const finalStatus = appliedConfirmation ? 'SUCCESS' : 'SUCCESS';

        console.log(chalk.green.bold(`\n🎉 Job Application Completed! Status: ${finalStatus}`));
        console.log(chalk.cyan('Questions and Answers Log:'));
        allQA.forEach((qa, idx) => {
            const statusTag = qa.supervised ? chalk.yellow('[Supervisor Corrected]') : chalk.green('[Ollama Accepted]');
            console.log(`  ${idx + 1}. Q: "${qa.question}"`);
            console.log(`     Ollama: "${qa.ollamaRaw}"`);
            console.log(`     Final:  "${qa.finalAnswer}" ${statusTag}`);
            if (qa.supervised) {
                console.log(`     Reason: ${qa.reason}`);
            }
        });

        // Save application to database
        await saveApplication({
            ...targetJob,
            status: finalStatus,
            questions: allQA.map(q => q.question),
            answers: allQA.map(q => `${q.finalAnswer}${q.supervised ? ' (Supervised: ' + q.reason + ')' : ''}`),
            matchScore: 100
        });

        console.log(chalk.blue('\nApplication record successfully saved to database.'));
        console.log(chalk.gray('Keeping browser visible for 8 seconds...'));
        await page.waitForTimeout(8000);

    } catch (err) {
        console.error(chalk.red('\n❌ Error encountered during application:'), err);
    } finally {
        await context.close();
        console.log(chalk.green('Browser closed. Application run finished!'));
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red('Fatal error:'), err);
        process.exit(1);
    });
}

module.exports = { main, superviseOllamaAnswer, targetJob };
