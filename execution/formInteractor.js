'use strict';

/**
 * execution/formInteractor.js
 *
 * Thin action layer that:
 *  - Fills a given answer into the currently visible form field.
 *  - Advances the form (clicks Next / Submit / Send).
 *
 * This does NOT duplicate questionHandlers.js logic.
 * It delegates to the existing handleQuestions() when Parallax sends an
 * external answer, and to the native getAnswer() flow when a local answer
 * is already known.
 *
 * API used by execution/server.js:
 *   fillAnswer(page, question, options, answer)  → { ok, detail }
 *   advanceForm(page)                             → { ok, buttonText, detail }
 */

const { randomDelay } = require('../automation/utils');
const chalk = require('chalk');

/**
 * Fill a known answer into the active form field.
 *
 * Supports:
 *   - Naukri chatbot overlay (radio chips + contenteditable)
 *   - Naukri classic form   (radio/checkbox + text input)
 *   - Workday form          (handled via existing workdayHandler — not this path)
 *
 * @param {import('playwright').Page} page
 * @param {string}   question   — question text (used for logging only)
 * @param {string[]} options    — visible option texts
 * @param {string}   answer     — the answer to fill
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function fillAnswer(page, question, options, answer) {
  if (!answer || !answer.trim()) {
    return { ok: false, detail: 'Empty answer provided' };
  }

  try {
    // ── Detect active UI ───────────────────────────────────────────────────
    const chatbotOverlay = page.locator(
      '.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]'
    ).first();
    const isChatbot = await chatbotOverlay.isVisible().catch(() => false);

    const classicForm = page.locator(
      '.recruiter-questions-container, .bot-questions-container, .question-wrapper'
    ).first();
    const isClassic = await classicForm.isVisible().catch(() => false);

    const root = isChatbot ? chatbotOverlay : (isClassic ? classicForm : page);

    const selectedAnswers = answer.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
    let interacted = false;

    // ── A. Option selectors (radio chips, labels) ──────────────────────────
    if (options && options.length > 0) {
      const optionSelectors = isChatbot
        ? '.ssrc__radio-btn-container, label.ssrc__label, input.ssrc__radio, [class*="chip"][class*="clickable"], a[role="button"], label, .styles_chip__7YCfG'
        : 'label, [class*="radio"], [class*="option"]';

      const optionLocators = await root.locator(optionSelectors).all();
      const clickedTexts = new Set();

      for (const opt of optionLocators) {
        if (!(await opt.isVisible().catch(() => false))) continue;
        const rawOptText = await opt.textContent().catch(() => '');
        if (rawOptText.includes('\n')) continue; // skip container elements
        const optText = rawOptText.toLowerCase().trim();
        if (clickedTexts.has(optText)) continue;

        let isMatch = false;
        for (const cleanAns of selectedAnswers) {
          const ansNum = parseInt(cleanAns, 10);
          // Exact match
          if (optText === cleanAns) { isMatch = true; break; }
          // Yes / No
          if ((cleanAns === 'yes' && (optText === 'yes' || optText.includes('yes'))) ||
              (cleanAns === 'no'  && (optText === 'no'  || optText.includes('no')))) {
            isMatch = true; break;
          }
          // Numeric range (e.g. answer "2" matching "1-3 years")
          const isPureNumber = /^\d+$/.test(cleanAns);
          if (isPureNumber && !isNaN(ansNum)) {
            const nums = optText.match(/\d+/g);
            if (nums) {
              const optNums = nums.map(Number);
              if (optNums.length === 2) {
                isMatch = ansNum >= optNums[0] && ansNum <= optNums[1];
              } else if (optNums.length === 1) {
                if (optText.includes('>') || optText.includes('more than')) {
                  isMatch = ansNum > optNums[0];
                } else if (optText.includes('<') || optText.includes('less than')) {
                  isMatch = ansNum < optNums[0];
                } else {
                  isMatch = ansNum === optNums[0];
                }
              }
              if (isMatch) break;
            }
          }
          // Substring fallback
          if (!isMatch && cleanAns.length > 1 && optText.includes(cleanAns)) {
            isMatch = true; break;
          }
        }

        if (isMatch) {
          console.log(chalk.green(`  [FormInteractor] → Selecting: "${rawOptText.trim()}"`));
          clickedTexts.add(optText);
          await opt.evaluate((el) => {
            const control = el.querySelector('input[type="checkbox"], input[type="radio"]') || el;
            control.scrollIntoView({ block: 'center' });
            control.click();
            control.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await randomDelay(500, 900);
          interacted = true;
        }
      }
    }

    // ── B. Text / contenteditable input ───────────────────────────────────
    if (!interacted) {
      // Chatbot contenteditable first
      let textInput = root.locator(
        'div.textArea[contenteditable="true"], [contenteditable="true"]'
      ).first();

      if (!(await textInput.isVisible().catch(() => false))) {
        textInput = root.locator(
          'input[type="text"], input[type="date"], input[type="number"], ' +
          'input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]), textarea'
        ).first();
      }

      if (await textInput.isVisible().catch(() => false)) {
        console.log(chalk.green(`  [FormInteractor] → Typing: "${answer}"`));
        await textInput.scrollIntoViewIfNeeded().catch(() => {});
        await textInput.click({ force: true });
        await textInput.evaluate((el) => {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = '';
          else el.innerText = '';
        });
        await page.keyboard.type(answer, { delay: 40 });
        await page.keyboard.press('Enter');
        interacted = true;
      }
    }

    if (!interacted) {
      return { ok: false, detail: 'No interactable field found for the given answer' };
    }

    await randomDelay(400, 700);
    return { ok: true, detail: `Filled answer: "${answer}"` };
  } catch (error) {
    return { ok: false, detail: `fillAnswer error: ${error.message}` };
  }
}

/**
 * Click the primary action button (Send / Next / Submit / Apply Now / Save).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ok: boolean, buttonText: string | null, detail: string}>}
 */
async function advanceForm(page) {
  try {
    const sendBtn = page.locator(
      '.chatbot_Drawer div.sendMsg, div.sendMsg, .send-msg-btn'
    ).first();
    const isSendVisible = await sendBtn.isVisible().catch(() => false);

    if (isSendVisible) {
      console.log(chalk.yellow('  [FormInteractor] → Clicking Chatbot Send'));
      await sendBtn.click({ force: true });
      await randomDelay(800, 1400);
      return { ok: true, buttonText: 'Send', detail: 'Clicked chatbot send button' };
    }

    const nextBtn = page.locator(
      'button:text-is("Save"), button:text-is("Submit"), button:text-is("Next"), ' +
      'button:text-is("Apply Now"), button:text-is("Save and Continue"), .save-button'
    ).first();
    const isNextVisible = await nextBtn.isVisible().catch(() => false);

    if (isNextVisible) {
      const btnText = (await nextBtn.innerText().catch(() => '')).trim();
      console.log(chalk.yellow(`  [FormInteractor] → Clicking "${btnText}"`));
      await nextBtn.click({ force: true });
      await randomDelay(800, 1400);
      return { ok: true, buttonText: btnText, detail: `Clicked: ${btnText}` };
    }

    return { ok: false, buttonText: null, detail: 'No advance button visible' };
  } catch (error) {
    return { ok: false, buttonText: null, detail: `advanceForm error: ${error.message}` };
  }
}

module.exports = { fillAnswer, advanceForm };
