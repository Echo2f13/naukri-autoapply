const { getAnswer } = require('../ai/answerEngine');
const { randomDelay } = require('./utils');
const chalk = require('chalk');

let currentJobUrl = '';
let questionHistory = {};

/**
 * Handles recruiter questions in the Naukri chatbot overlay or standard form.
 */
async function handleQuestions(page) {
    const url = page.url();
    if (url !== currentJobUrl) {
        currentJobUrl = url;
        questionHistory = {};
    }

    await randomDelay(1500, 2000);
    const answered = [];

    const chatbotOverlay = page.locator('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]').first();
    const isChatbotVisible = await chatbotOverlay.isVisible();

    const questionForm = page.locator('.recruiter-questions-container, .bot-questions-container, .question-wrapper').first();
    const isFormVisible = await questionForm.isVisible();

    if (!isChatbotVisible && !isFormVisible) {
        console.log(chalk.gray('  No chatbot or question form detected.'));
        return answered;
    }

    if (isChatbotVisible) {
        console.log(chalk.blue('  Chatbot detected. Using chatbot handler.'));
        return handleChatbotOverlay(page, chatbotOverlay, answered);
    } else {
        console.log(chalk.blue('  Question form detected. Using form handler.'));
        return handleQuestionForm(page, questionForm, answered);
    }
}

/**
 * Tries to find and click a "Skip this question" button (or any skip variant).
 * Scoped to the overlay if provided, otherwise searches the whole page.
 * @param {Object} page     - Playwright page
 * @param {Object} overlay  - Optional scoped locator (e.g. chatbot overlay)
 * @returns {Promise<boolean>} true if skip was clicked
 */
async function trySkipQuestion(page, overlay = null) {
    const skipSelectors = [
        'button:has-text("Skip this question")',
        'a:has-text("Skip this question")',
        'span:has-text("Skip this question")',
        'button:has-text("Skip")',
        'a:has-text("Skip")',
        '[class*="skip"]',
    ];

    const root = overlay || page;

    for (const selector of skipSelectors) {
        try {
            const btn = root.locator(selector).first();
            if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
                await btn.click({ force: true });
                await randomDelay(500, 1000);
                return true;
            }
        } catch (_) { /* continue */ }
    }
    return false;
}

/**
 * Modern Chatbot Handler (Scoped to Overlay)
 */
async function handleChatbotOverlay(page, overlay, answered) {
    const botMsgSelectors = [
        'div.botMsg.msg span',
        '.botMsg.msg',
        '.botMsg span',
        '.msg.bot-msg'
    ];

    let questionText = '';
    for (const selector of botMsgSelectors) {
        const msgs = overlay.locator(selector);
        const count = await msgs.count();
        if (count > 0) {
            for (let i = count - 1; i >= 0; i--) {
                const msg = msgs.nth(i);
                if (await msg.isVisible()) {
                    const text = (await msg.innerText()).trim();
                    if (text.length > 3 && !text.includes('Hi ') && !text.includes('thank you for showing interest')) {
                        questionText = text;
                        break;
                    }
                }
            }
        }
        if (questionText) break;
    }

    if (!questionText || questionText.length < 3) {
        const salutationHeader = overlay.locator('.chatbot_MessageContainer span, .chatbot_MessageContainer div').filter({ hasText: /^Salutation$/ }).first();
        if (await salutationHeader.isVisible()) questionText = "Salutation";
    }

    if (!questionText) {
        console.log(chalk.yellow('  ⚠️ Could not identify question text.'));
    } else {
        console.log(chalk.gray(`  Q: "${questionText}"`));
    }

    // --- EXTRACT OPTIONS ---
    const optionSelectors = [
        '.ssrc__radio-btn-container', 
        'label.ssrc__label',          
        'input.ssrc__radio',          
        '[class*="chip"][class*="clickable"]',
        'a[role="button"]',
        'label',
        '.styles_chip__7YCfG'
    ];

    const optionLocators = await overlay.locator(optionSelectors.join(', ')).all();
    const options = [];
    for (const opt of optionLocators) {
        if (await opt.isVisible()) {
            const text = (await opt.innerText()).trim();
            if (text && !text.includes('\n') && !options.includes(text)) options.push(text);
        }
    }

    const cleanQ = (questionText || "Chatbot Question").toLowerCase().trim();
    if (!questionHistory[cleanQ]) {
        questionHistory[cleanQ] = { count: 0 };
    }
    questionHistory[cleanQ].count++;
    
    const forceManual = questionHistory[cleanQ].count > 3;
    if (forceManual) {
        console.log(chalk.yellow(`  ⚠️ Chatbot question "${questionText}" seen ${questionHistory[cleanQ].count} times. Forcing manual terminal prompt...`));
    }

    const answer = await getAnswer(questionText || "Chatbot Question", options, forceManual);

    // If no answer, try to skip the question before giving up
    if (!answer && questionText) {
        const skipped = await trySkipQuestion(page, overlay);
        if (skipped) {
            console.log(chalk.yellow(`    ⏭️  Skipped unanswerable question: "${questionText}"`));
            answered.push({ question: questionText, answer: '[SKIPPED]' });
        }
        return answered;
    }

    answered.push({ question: questionText || "Chatbot Question", answer });
    let interacted = false;

    if (options.length > 0) {
        const selectedAnswers = answer.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
        const clickedTexts = new Set();

        for (const opt of optionLocators) {
            if (!(await opt.isVisible())) continue;
            const rawOptText = await opt.innerText();
            if (rawOptText.includes('\n')) continue; // Skip container elements!
            const optText = rawOptText.toLowerCase().trim();
            if (clickedTexts.has(optText)) continue;
            
            let isMatch = false;
            for (const cleanAns of selectedAnswers) {
                const ansNum = parseInt(cleanAns);
                
                // 1. Exact or basic match
                if (optText === cleanAns || 
                    (cleanAns === 'yes' && (optText === 'yes' || optText.includes('yes'))) ||
                    (cleanAns === 'no' && (optText === 'no' || optText.includes('no')))) {
                    isMatch = true;
                }

                // 2. Numeric range match (e.g. Answer "2" matching "1-3 years")
                // Only run numeric match if the candidate's answer is a pure digits-only string
                const isPureNumber = /^\d+$/.test(cleanAns);
                if (!isMatch && isPureNumber && !isNaN(ansNum)) {
                    const nums = optText.match(/\d+/g);
                    if (nums) {
                        const optNums = nums.map(Number);
                        if (optNums.length === 2) {
                            // Range like "1-3"
                            isMatch = ansNum >= optNums[0] && ansNum <= optNums[1];
                        } else if (optNums.length === 1) {
                            // Single number like "2 years" or ">1 year"
                            if (optText.includes('>') || optText.includes('more than')) {
                                isMatch = ansNum > optNums[0];
                            } else if (optText.includes('<') || optText.includes('less than')) {
                                isMatch = ansNum < optNums[0];
                            } else {
                                isMatch = ansNum === optNums[0];
                            }
                        }
                    }
                }

                // 3. Substring match as fallback
                if (!isMatch && cleanAns.length > 1 && optText.includes(cleanAns)) {
                    isMatch = true;
                }

                if (isMatch) break;
            }

            if (isMatch) {
                console.log(chalk.green(`    -> Selecting option: "${rawOptText.trim()}"`));
                clickedTexts.add(optText);
                await opt.evaluate((el) => {
                    const control = el.querySelector('input[type="checkbox"], input[type="radio"]') || el;
                    control.scrollIntoView({ block: 'center', inline: 'center' });
                    control.click();
                    control.dispatchEvent(new Event('change', { bubbles: true }));
                });
                await randomDelay(500, 1000);
                interacted = true;
            }
        }
    }

    // --- B. Text Input ---
    if (!interacted && answer) {
        let textInput = overlay.locator('div.textArea[contenteditable="true"], [contenteditable="true"]').first();
        if (!(await textInput.isVisible().catch(() => false))) {
            textInput = overlay.locator('input[type="text"], input[type="date"], input[type="number"], input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]), textarea').first();
        }

        if (await textInput.isVisible().catch(() => false)) {
            console.log(chalk.green(`    -> Typing: "${answer}"`));
            await textInput.scrollIntoViewIfNeeded();
            await textInput.click({ force: true });
            
            await textInput.evaluate((el) => {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = '';
                else el.innerText = '';
            });
            
            await page.keyboard.type(answer, { delay: 50 });
            await page.keyboard.press('Enter');
            interacted = true;
        }
    }

    if (!interacted && questionText) {
        // Couldn't fill in any field — try skip button as last resort
        const skipped = await trySkipQuestion(page, overlay);
        if (skipped) {
            console.log(chalk.yellow(`    ⏭️  Skipped question (no matching field): "${questionText}"`));
        } else {
            console.log(chalk.red(`    ❌ FAILED to interact and no skip button found.`));
        }
    }

    return answered;
}

/**
 * Classic Form Handler
 */
async function handleQuestionForm(page, form, answered) {
    const wrappers = await form.locator('.question-wrapper, .field').all();
    
    for (const wrapper of wrappers) {
        if (!(await wrapper.isVisible())) continue;

        let qText = '';
        const labels = await wrapper.locator('.question-label, label, p, span').all();
        for (const l of labels) {
            const txt = (await l.innerText()).trim();
            if (txt.length > 3) { qText = txt; break; }
        }
        if (!qText) continue;

        const optionEls = await wrapper.locator('label, [class*="radio"], [class*="option"]').all();
        const options = [];
        for (const opt of optionEls) {
            if (await opt.isVisible()) {
                const text = (await opt.innerText()).trim();
                if (text && !text.includes('\n') && !options.includes(text)) options.push(text);
            }
        }

        const cleanFormQ = qText.toLowerCase().trim();
        if (!questionHistory[cleanFormQ]) {
            questionHistory[cleanFormQ] = { count: 0 };
        }
        questionHistory[cleanFormQ].count++;
        
        const forceManual = questionHistory[cleanFormQ].count > 3;
        if (forceManual) {
            console.log(chalk.yellow(`  ⚠️ Form question "${qText}" seen ${questionHistory[cleanFormQ].count} times. Forcing manual terminal prompt...`));
        }

        const ans = await getAnswer(qText, options, forceManual);
        if (!ans) continue;

        answered.push({ question: qText, answer: ans });
        const selectedAnswers = ans.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
        
        const clickedTexts = new Set();
        let interacted = false;  // FIX: was never declared, caused ReferenceError
        
        for (const opt of optionEls) {
            if (!(await opt.isVisible())) continue;
            const rawOptText = await opt.innerText();
            if (rawOptText.includes('\n')) continue; // Skip container elements!
            const optText = rawOptText.toLowerCase().trim();
            if (clickedTexts.has(optText)) continue;

            let isMatch = false;
            for (const cleanAns of selectedAnswers) {
                const ansNum = parseInt(cleanAns);
                
                if (optText === cleanAns) {
                    isMatch = true;
                }

                // Only run numeric match if the candidate's answer is a pure digits-only string
                const isPureNumber = /^\d+$/.test(cleanAns);
                if (!isMatch && isPureNumber && !isNaN(ansNum)) {
                    const nums = optText.match(/\d+/g);
                    if (nums) {
                        const optNums = nums.map(Number);
                        if (optNums.length === 2) isMatch = ansNum >= optNums[0] && ansNum <= optNums[1];
                        else if (optNums.length === 1) isMatch = ansNum === optNums[0];
                    }
                }

                if (!isMatch && cleanAns.length > 1 && optText.includes(cleanAns)) {
                    isMatch = true;
                }

                if (isMatch) break;
            }

            if (isMatch) {
                console.log(chalk.green(`    -> Selecting option: "${rawOptText.trim()}"`));
                clickedTexts.add(optText);
                await opt.evaluate((el) => {
                    const control = el.querySelector('input[type="checkbox"], input[type="radio"], label, button') || el;
                    control.click();
                    control.dispatchEvent(new Event('change', { bubbles: true }));
                });
                interacted = true;
            }
        }

        if (!interacted) {
            const input = wrapper.locator('input[type="text"], input[type="number"], textarea').first();
            if (await input.isVisible()) {
                await input.scrollIntoViewIfNeeded();
                await input.click({ force: true });
                await input.fill(ans);
                interacted = true;
            }
        }
    }
    
    return answered;
}

function resetQuestionHistory() {
    questionHistory = {};
    currentJobUrl = '';
}

module.exports = { handleQuestions, resetQuestionHistory };
