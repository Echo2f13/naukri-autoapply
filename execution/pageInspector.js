'use strict';

const state = require('./sessionState');

/**
 * execution/pageInspector.js
 *
 * Extracts a structured, serialisable snapshot of whatever the browser is
 * currently showing.  Nothing here controls the browser — it only reads.
 *
 * Used by GET /execution/state and GET /execution/verify.
 */

// Maximum characters of visible body text returned in snapshots
const MAX_VISIBLE_TEXT = 2000;

/**
 * Detect which high-level UI type is currently visible.
 * Returns one of: 'chatbot_overlay' | 'classic_form' | 'job_listing' |
 *                 'job_list' | 'workday_form' | 'success' | 'error' | 'unknown'
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function detectUIType(page) {
  return page.evaluate(() => {
    // Naukri chatbot overlay
    if (document.querySelector('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]')) {
      return 'chatbot_overlay';
    }
    // Naukri classic recruiter questions form
    if (document.querySelector('.recruiter-questions-container, .bot-questions-container, .question-wrapper')) {
      return 'classic_form';
    }
    // Workday application form
    if (document.querySelector('[data-automation-id^="formField-"]') ||
        document.querySelector('[data-automation-id="pageHeader"]')) {
      return 'workday_form';
    }
    // Success indicators
    const body = document.body?.innerText?.toLowerCase() || '';
    if (
      document.querySelector('.apply-success-container') ||
      document.querySelector('.job-header .already-applied') ||
      body.includes('application sent') ||
      body.includes('successfully submitted') ||
      body.includes('congratulations')
    ) {
      return 'success';
    }
    // Error indicators
    if (
      document.querySelector('.error-banner, .error-msg, .err-msg') ||
      body.includes('something went wrong') ||
      body.includes('there was an error')
    ) {
      return 'error';
    }
    // Job detail page (apply button present)
    if (document.querySelector('#apply-button, button[id="apply-button"], .applyBtn')) {
      return 'job_listing';
    }
    // Job list / search results
    if (document.querySelector('.cust-job-tuple, article.jobTuple, .job-tuple')) {
      return 'job_list';
    }
    return 'unknown';
  });
}

/**
 * Extract the pending question from the active UI (chatbot or classic form).
 * Returns null if no question is currently visible.
 * @param {import('playwright').Page} page
 * @returns {Promise<{question: string, options: string[], uiType: string} | null>}
 */
async function extractPendingQuestion(page) {
  const uiType = await detectUIType(page);

  if (uiType === 'chatbot_overlay') {
    return page.evaluate(() => {
      const overlay = document.querySelector('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]');
      if (!overlay) return null;

      // Find last visible bot message
      const botMsgs = overlay.querySelectorAll('div.botMsg.msg span, .botMsg.msg, .botMsg span, .msg.bot-msg');
      let questionText = '';
      for (let i = botMsgs.length - 1; i >= 0; i--) {
        const text = (botMsgs[i].textContent || '').trim();
        if (text.length > 3 && !text.includes('Hi ') && !text.includes('thank you for showing interest')) {
          questionText = text;
          break;
        }
      }
      if (!questionText) return null;

      // Collect visible options
      const optEls = overlay.querySelectorAll(
        '.ssrc__radio-btn-container, label.ssrc__label, [class*="chip"][class*="clickable"], a[role="button"], .styles_chip__7YCfG'
      );
      const options = [];
      for (const el of optEls) {
        const text = (el.textContent || '').trim();
        if (text && !text.includes('\n') && !options.includes(text)) {
          options.push(text);
        }
      }

      return { question: questionText, options, uiType: 'chatbot_overlay' };
    });
  }

  if (uiType === 'classic_form') {
    return page.evaluate(() => {
      const form = document.querySelector(
        '.recruiter-questions-container, .bot-questions-container, .question-wrapper'
      );
      if (!form) return null;

      const labelEl = form.querySelector('.question-label, label, p, span');
      const questionText = (labelEl?.textContent || '').trim();
      if (!questionText || questionText.length < 3) return null;

      const optEls = form.querySelectorAll('label, [class*="radio"], [class*="option"]');
      const options = [];
      for (const el of optEls) {
        const text = (el.textContent || '').trim();
        if (text && !text.includes('\n') && !options.includes(text)) {
          options.push(text);
        }
      }

      return { question: questionText, options, uiType: 'classic_form' };
    });
  }

  if (uiType === 'workday_form') {
    // Return the first unfilled required field as the "pending question"
    return page.evaluate(() => {
      const containers = document.querySelectorAll('[data-automation-id^="formField-"]');
      for (const container of containers) {
        const label = container.querySelector('label, [data-automation-id="formField-label"], legend');
        const labelText = (label?.textContent || '').trim();
        if (!labelText) continue;

        // Only return fields with red * (required)
        const hasRequired =
          labelText.includes('*') ||
          !!container.querySelector('[class*="required" i], abbr[title="required" i]') ||
          !!container.querySelector('input[required], [aria-required="true"]');
        if (!hasRequired) continue;

        // Only return unfilled fields
        const input = container.querySelector('input, textarea, select');
        if (input && (input.value || '').trim()) continue;

        const optEls = container.querySelectorAll('[role="radio"], input[type="radio"]');
        const options = [];
        for (const el of optEls) {
          const t = (el.textContent || el.value || '').trim();
          if (t) options.push(t);
        }

        return {
          question: labelText.replace(/\*/g, '').trim(),
          options,
          uiType: 'workday_form',
        };
      }
      return null;
    });
  }

  return null;
}

/**
 * Build a full PageState snapshot.
 * @param {import('playwright').Page} page
 * @returns {Promise<PageState>}
 */
async function buildPageState(page) {
  const url   = page.url();
  const title = await page.title().catch(() => '');
  const uiType = await detectUIType(page);
  const pendingQuestion = await extractPendingQuestion(page);

  const visibleText = await page.evaluate((maxLen) => {
    return (document.body?.innerText || '').slice(0, maxLen).trim();
  }, MAX_VISIBLE_TEXT).catch(() => '');

  // Collect visible action buttons
  const actionButtons = await page.evaluate(() => {
    const btns = [];
    const candidates = document.querySelectorAll(
      'button:not([disabled]), a[role="button"]:not([disabled])'
    );
    for (const btn of candidates) {
      const text = (btn.textContent || '').trim();
      if (text && text.length < 60 && btns.length < 10) {
        btns.push(text);
      }
    }
    return btns;
  }).catch(() => []);

  return {
    url,
    title,
    uiType,
    visibleText,
    actionButtons,
    pendingQuestion,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check whether the current page shows a confirmed success state.
 * @param {import('playwright').Page} page
 * @returns {Promise<{success: boolean, indicator: string | null}>}
 */
async function checkSuccess(page) {
  const successSelectors = [
    { selector: '.job-header span:text-is("Applied")',     label: 'applied_header_tag' },
    { selector: '.job-header .already-applied',            label: 'already_applied_class' },
    { selector: '.job-header .applied-status',             label: 'applied_status_class' },
    { selector: '.apply-success-container',                label: 'apply_success_container' },
    { selector: 'p:has-text("successfully submitted")',    label: 'text_successfully_submitted' },
    { selector: 'div:has-text("Application sent")',        label: 'text_application_sent' },
    { selector: 'text=/congratulations/i',                 label: 'text_congratulations' },
  ];

  for (const { selector, label } of successSelectors) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout: 500 });
      if (visible) return { success: true, indicator: label };
    } catch {
      // continue
    }
  }

  // Inferred success: apply button gone + chatbot closed
  // BUT only infer if the session actually answered a question or the URL shows an apply-confirmation page.
  // This prevents false positives from simply navigating away from a job listing.
  const applyGone = !(await page.locator('button:has-text("Apply"), #apply-button')
    .first().isVisible().catch(() => false));
  const chatbotGone = !(await page.locator('.chatbot_Drawer, .chatbot_Overlay')
    .first().isVisible().catch(() => false));
  const currentUrl = page.url();
  const isConfirmationPage = currentUrl.includes('saveApply') || currentUrl.includes('showAcp') || currentUrl.includes('applyConfirm');
  const sessionAnsweredQuestions = state.getCurrentQA().length > 0;

  if (applyGone && chatbotGone && (isConfirmationPage || sessionAnsweredQuestions)) {
    return { success: true, indicator: 'inferred_apply_gone' };
  }

  return { success: false, indicator: null };
}

module.exports = {
  detectUIType,
  extractPendingQuestion,
  buildPageState,
  checkSuccess,
};
