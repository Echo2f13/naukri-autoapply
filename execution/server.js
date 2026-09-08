'use strict';

/**
 * execution/server.js
 *
 * Thin HTTP adapter that exposes the existing naukri-autoapply automation
 * services over a local REST API.  Parallax calls this; nothing here
 * duplicates Playwright, browser, question-handling, or AI logic.
 *
 * Endpoints:
 *   POST /execution/start
 *   GET  /execution/jobs
 *   POST /execution/apply
 *   GET  /execution/state
 *   POST /execution/answer
 *   POST /execution/advance
 *   GET  /execution/verify
 *   POST /execution/stop
 *   GET  /execution/health
 *
 * The browser runs in this process.  Parallax communicates over HTTP only.
 */

require('dotenv').config();

const express = require('express');
const chalk   = require('chalk');

// ── Existing services (never duplicated) ────────────────────────────────────
const { launchBrowser }              = require('../automation/browser');
const { ensureLogin }                = require('../automation/login');
const { extractRecommendedJobs, searchNaukriJobs } = require('../automation/searchJobs');
const { handleQuestions, resetQuestionHistory }    = require('../automation/questionHandlers');
const { setCurrentJobContext, setUserMaxExperience } = require('../ai/answerEngine');
const { isAlreadyApplied, saveApplication, logEvent } = require('../db/queries');

// ── Execution-layer modules ──────────────────────────────────────────────────
const state        = require('./sessionState');
const inspector    = require('./pageInspector');
const { fillAnswer, advanceForm } = require('./formInteractor');
const { resolveAnswer, resolveAnswerDeterministic } = require('./answerBridge');

const PORT = parseInt(process.env.EXECUTION_API_PORT || '4000', 10);

const app = express();
app.use(express.json());

// ── Logging middleware ────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(chalk.gray(`[ExecutionAPI] ${req.method} ${req.path}`));
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireSession(res) {
  if (state.getStatus() === 'IDLE') {
    res.status(400).json({ error: 'No active session. Call POST /execution/start first.', code: 'NO_SESSION' });
    return false;
  }
  return true;
}

function requirePage(res) {
  const page = state.getPage();
  if (!page) {
    res.status(400).json({ error: 'Browser page not available.', code: 'NO_PAGE' });
    return null;
  }
  return page;
}

function loopGuard(res, url, actionKey) {
  state.recordAction(url, actionKey);
  if (state.isLooping(url, actionKey)) {
    res.status(409).json({
      error: 'Loop detected: same action repeated on same URL.',
      code: 'LOOP_DETECTED',
      url,
      actionKey,
    });
    return false;
  }
  return true;
}

// ─── GET /execution/health ────────────────────────────────────────────────────
app.get('/execution/health', (_req, res) => {
  res.json({ ok: true, status: state.getStatus(), session: state.snapshot() });
});

// ─── POST /execution/start ────────────────────────────────────────────────────
app.post('/execution/start', async (_req, res) => {
  if (state.getStatus() !== 'IDLE') {
    return res.status(409).json({
      error: 'A session is already running. Call POST /execution/stop first.',
      code: 'SESSION_ACTIVE',
      session: state.snapshot(),
    });
  }

  try {
    state.startSession();
    state.setStatus('STARTED');

    console.log(chalk.blue('[ExecutionAPI] Launching browser...'));
    const { context, page } = await launchBrowser();
    state.setBrowserContext(context);
    state.setPage(page);

    console.log(chalk.blue('[ExecutionAPI] Ensuring Naukri login...'));
    await ensureLogin(page);

    state.setStatus('BROWSING');
    await logEvent('EXECUTION_API_START', {});

    res.json({
      ok: true,
      message: 'Browser started and logged in.',
      session: state.snapshot(),
    });
  } catch (error) {
    state.setStatus('FAILED');
    res.status(500).json({ error: error.message, code: 'START_FAILED' });
  }
});

// ─── GET /execution/jobs ──────────────────────────────────────────────────────
// Query params:
//   mode=recommended|search  (default: recommended)
//   keyword=<string>
//   location=<string>
//   exp=0|1|2               (comma-separated experience levels)
//   maxPages=<number>        (default: 2, search mode only)
app.get('/execution/jobs', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  try {
    state.setStatus('BROWSING');
    const mode     = req.query.mode || 'recommended';
    const keyword  = String(req.query.keyword  || 'python');
    const location = String(req.query.location || 'india');
    const expParam = String(req.query.exp      || '0,1');
    const maxPages = parseInt(req.query.maxPages || '2', 10);
    const maxAgeDays = req.query.maxAgeDays ? parseInt(req.query.maxAgeDays, 10) : null;

    const experienceLevels = expParam
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));

    const userMaxExp = experienceLevels.length > 0
      ? Math.max(...experienceLevels)
      : 1;

    setUserMaxExperience(userMaxExp);

    let jobs;
    if (mode === 'search') {
      jobs = await searchNaukriJobs(page, { keyword, location, experienceLevels, maxPages });
    } else {
      jobs = await extractRecommendedJobs(page);
    }

    // Age filter (optional)
    if (maxAgeDays !== null && !isNaN(maxAgeDays)) {
      const parsePostedAgeDays = (text) => {
        if (!text) return null;
        const lower = text.toLowerCase();
        if (/today|just now|hour|minute|second/i.test(lower)) return 0;
        const match = lower.match(/(\d+)\+?\s*(day|week|month)/);
        if (!match) return null;
        const n = parseInt(match[1], 10);
        const unit = match[2];
        if (unit === 'day') return n;
        if (unit === 'week') return n * 7;
        if (unit === 'month') return n * 30;
        return null;
      };

      jobs = jobs.filter(job => {
        const days = parsePostedAgeDays(job.postedAge);
        // If we can't parse it, default to keeping it (or default to 30, but keeping is safer)
        if (days === null) return true;
        return days <= maxAgeDays;
      });
    }

    // Deduplication filter
    const unappliedJobs = [];
    for (const job of jobs) {
      const url = job.jobUrl || job.job_url || '';
      if (!url) continue;
      const applied = await isAlreadyApplied(url).catch(() => false);
      if (!applied) unappliedJobs.push(job);
    }
    jobs = unappliedJobs;

    res.json({ ok: true, count: jobs.length, jobs });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'JOBS_FAILED' });
  }
});

// ─── POST /execution/apply ────────────────────────────────────────────────────
// Body: { jobUrl, role, company, location, experience }
// Navigates to the job URL and clicks Apply (does NOT run the full apply loop).
// Leaves the page in a state where Ollama can inspect questions one by one.
app.post('/execution/apply', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  const { jobUrl, role, company, location, experience } = req.body || {};
  const url = page.url();
  if (!loopGuard(res, url, 'apply')) return;
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobUrl is required', code: 'MISSING_FIELD' });
  }

  try {
    // Check if already applied
    const alreadyApplied = await isAlreadyApplied(jobUrl).catch(() => false);
    if (alreadyApplied) {
      return res.json({ ok: true, status: 'ALREADY_APPLIED', message: 'Job already applied in DB.' });
    }

    const job = { jobUrl, role: role || 'Unknown', company: company || 'Unknown', location: location || '', experience: experience || '' };
    state.setCurrentJob(job);
    setCurrentJobContext(job);
    resetQuestionHistory();

    state.setStatus('APPLYING');
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    // Click Apply button — covers all Naukri variants:
    //   "Apply", "Apply Now", "Easy Apply", "Apply Directly"
    // Uses :text() (substring, case-insensitive) not :text-is() (exact)
    const applyBtn = page.locator([
      'button:has-text("Apply")',
      '#apply-button',
      '.apply-button',
      '.applyBtn',
      'a:has-text("Apply")',
    ].join(', ')).first();

    const applyVisible = await applyBtn.isVisible().catch(() => false);

    if (applyVisible) {
      await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
      await applyBtn.click({ force: true });
      // Wait up to 5s for the chatbot overlay OR a form to appear
      try {
        await page.waitForSelector(
          '.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"], ' +
          '.recruiter-questions-container, .bot-questions-container, .question-wrapper, ' +
          'div[class*="applyForm"], .myapply-container',
          { timeout: 5000 }
        );
      } catch {
        // Chatbot didn't appear — may be a quick-apply or external redirect
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    const pageState = await inspector.buildPageState(page);

    await logEvent('EXECUTION_API_APPLY_START', { jobUrl });

    res.json({
      ok: true,
      status: 'APPLYING',
      applyClicked: applyVisible,
      pageState,
      session: state.snapshot(),
    });
  } catch (error) {
    state.setStatus('FAILED');
    res.status(500).json({ error: error.message, code: 'APPLY_FAILED' });
  }
});

// ─── GET /execution/state ─────────────────────────────────────────────────────
// Returns full page state snapshot + pending question if any.
app.get('/execution/state', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  const url = page.url();
  if (!loopGuard(res, url, 'state')) return;

  try {
    const pageState = await inspector.buildPageState(page);

    // If there's a pending question, also try deterministic resolution
    // so Ollama knows whether it can answer locally or needs ChatGPT.
    let resolution = null;
    if (pageState.pendingQuestion) {
      const { question, options } = pageState.pendingQuestion;
      resolution = resolveAnswerDeterministic(question, options || []);
    }

    res.json({
      ok: true,
      session: state.snapshot(),
      pageState,
      resolution,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'STATE_FAILED' });
  }
});

// ─── POST /execution/answer ───────────────────────────────────────────────────
// Body: { question, options, answer, source }
// Fills the provided answer into the current form field.
// The caller (Parallax/Ollama) is responsible for deciding the answer.
app.post('/execution/answer', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  const { question, options, answer, source } = req.body || {};
  if (!answer) {
    return res.status(400).json({ error: 'answer is required', code: 'MISSING_FIELD' });
  }

  const url = page.url();
  const actionKey = `answer:${(question || '').slice(0, 40).toLowerCase().replace(/\s+/g, '_')}`;

  if (!loopGuard(res, url, actionKey)) return;

  try {
    state.setStatus('QUESTIONING');
    const result = await fillAnswer(page, question || '', options || [], answer);
    state.recordAnswer(question || '', answer, source || 'external');

    if (!result.ok) {
      return res.status(422).json({ error: result.detail, code: 'FILL_FAILED' });
    }

    const pageState = await inspector.buildPageState(page);
    res.json({ ok: true, detail: result.detail, pageState, session: state.snapshot() });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'ANSWER_FAILED' });
  }
});

// ─── POST /execution/advance ──────────────────────────────────────────────────
// Clicks Next / Submit / Send — advances the form.
app.post('/execution/advance', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  const url = page.url();
  if (!loopGuard(res, url, 'advance')) return;

  try {
    const result = await advanceForm(page);
    if (!result.ok) {
      return res.status(422).json({ error: result.detail, code: 'ADVANCE_FAILED' });
    }

    // After clicking Send/Next, the chatbot takes 1-3s to render the next bot message.
    // Poll for a new bot message appearing (up to 4s) before reading pageState so
    // pendingQuestion is populated when Parallax reads it.
    try {
      await page.waitForFunction(() => {
        // A new bot message appearing means the chatbot is ready for the next answer
        const msgs = document.querySelectorAll(
          '.chatbot_Drawer .botMsg, .chatbot_Overlay .botMsg, [class*="chatbot"] .botMsg, .botMsg.msg'
        );
        return msgs.length > 0 && msgs[msgs.length - 1].textContent?.trim().length > 3;
      }, { timeout: 4000 });
    } catch {
      // Chatbot may have closed (form submitted) — that's fine, continue
      await new Promise(r => setTimeout(r, 800));
    }

    const pageState = await inspector.buildPageState(page);

    res.json({
      ok: true,
      buttonText: result.buttonText,
      detail: result.detail,
      pageState,
      session: state.snapshot(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'ADVANCE_FAILED' });
  }
});

// ─── GET /execution/verify ────────────────────────────────────────────────────
// Checks whether the current application was successful.
app.get('/execution/verify', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  try {
    state.setStatus('VERIFYING');
    const { success, indicator } = await inspector.checkSuccess(page);
    const pageState = await inspector.buildPageState(page);

    if (success) {
      // Persist to DB
      const job = state.getCurrentJob();
      if (job) {
        const qa = state.getCurrentQA();
        await saveApplication({
          ...job,
          status: 'SUCCESS',
          questions: qa.map(q => q.question),
          answers:   qa.map(q => q.answer),
        }).catch(() => {});
      }
      state.setStatus('DONE');
    }

    res.json({
      ok: true,
      success,
      indicator,
      pageState,
      session: state.snapshot(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'VERIFY_FAILED' });
  }
});

// ─── POST /execution/resolve ──────────────────────────────────────────────────
// Body: { question, options, source? }
// Asks the local answer engine for a deterministic answer without touching the browser.
// Returns { answer, source } — answer is null when ChatGPT is needed.
app.post('/execution/resolve', async (req, res) => {
  const { question, options, source } = req.body || {};
  if (!question) {
    return res.status(400).json({ error: 'question is required', code: 'MISSING_FIELD' });
  }

  try {
    const result = await resolveAnswer(question, options || [], source || 'naukri');
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'RESOLVE_FAILED' });
  }
});

// ─── GET /execution/job-detail ────────────────────────────────────────────────
// Query params: url=<jobUrl>
// Navigates to a job listing page (using a side-tab so the main page stays on
// the search results / homepage) and extracts a rich description for Ollama ranking.
// Does NOT change session state or click Apply.
// Returns: { ok, title, company, location, experience, skills, description, applyType, jobUrl }
//   applyType: 'naukri' (chatbot/quick-apply) | 'external' (redirects to another site) | 'unknown'
app.get('/execution/job-detail', async (req, res) => {
  if (!requireSession(res)) return;
  const page = requirePage(res);
  if (!page) return;

  const { url: jobUrl } = req.query;
  if (!jobUrl) {
    return res.status(400).json({ error: 'url query param is required', code: 'MISSING_FIELD' });
  }

  // Open a side tab so the main page (used for applying) is never navigated away
  const context = state.getBrowserContext();
  if (!context) {
    return res.status(400).json({ error: 'No browser context', code: 'NO_CONTEXT' });
  }

  const tab = await context.newPage();
  try {
    await tab.goto(String(jobUrl), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tab.waitForTimeout(1500);

    const detail = await tab.evaluate(() => {
      // Title
      const titleEl = document.querySelector('h1.jd-header-title, .jd-header-title, h1');
      const title = titleEl?.innerText?.trim() || document.title;

      // Full body text for fallback parsing
      const bodyText = document.body?.innerText || '';
      const bodyLines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

      // ── Company / Experience / Location ──
      // Naukri uses CSS modules (hashed class names) so traditional selectors
      // break frequently. Primary strategy: parse the structured header text
      // that always follows the pattern:
      //   [title] → [company] → [rating Reviews] → [X - Y years] → [salary] → [location]
      let company = '', experience = '', location = '';

      // Try CSS selectors first (may work if Naukri reverts)
      const compEl = document.querySelector('.jd-header-comp-name a, .jd-header-comp-name, .comp-name');
      company = compEl?.innerText?.trim() || '';
      const expEl = document.querySelector('.experience, [class*="experience"]');
      experience = expEl?.innerText?.trim() || '';
      const locEl = document.querySelector('.location, [class*="location"]');
      location = locEl?.innerText?.trim() || '';

      // Fallback: parse from body text header structure
      if (!company || !experience || !location) {
        const titleIdx = bodyLines.findIndex(l => l === title);
        if (titleIdx >= 0) {
          // Line after title is always company name
          const rawCompany = bodyLines[titleIdx + 1] || '';
          // Line after company is rating (e.g. "3.62.2K Reviews") — skip it
          const ratingLine = bodyLines[titleIdx + 2] || '';
          const hasRating = /reviews/i.test(ratingLine) || /^\d+\.\d/.test(ratingLine);

          // If company has a rating, header is 6 lines; otherwise 5
          const offset = hasRating ? 0 : -1;
          const rawExp  = bodyLines[titleIdx + 3 + offset] || '';
          const rawLoc  = bodyLines[titleIdx + 5 + offset] || '';

          if (!company && rawCompany && rawCompany.length < 80) {
            company = rawCompany;
          }
          if (!experience && /\d+\s*[-\u2013to]+\s*\d+\s*year/i.test(rawExp)) {
            experience = rawExp;
          }
          if (!location && rawLoc && rawLoc !== 'Send me jobs like this' && rawLoc.length < 80) {
            location = rawLoc;
          }
        }
      }

      // Full job description text
      const jdEl = document.querySelector('.job-description, .jd-desc, #job-description, [class*="jobDescription"]');
      const description = (jdEl?.innerText || bodyText).slice(0, 3000).trim();

      // Key skills listed on the page
      const skillEls = document.querySelectorAll('.key-skill, .skills-tags a, .tag-li, [class*="skill"] a, [class*="chip"]');
      const skills = Array.from(skillEls)
        .map(el => el.innerText?.trim())
        .filter(t => t && t.length < 40 && !t.includes('\n'))
        .slice(0, 20);

      // ── Detect apply type ──
      // Check for Naukri's native apply button (id="apply-button" or similar)
      // Be specific: match buttons whose text is exactly "Apply" or "Apply Now",
      // NOT "Applied", "Apply Filters", "Apply For Job" (which is body text, not a button)
      const hasNaukriApply = !!document.querySelector('#apply-button, .applyBtn, button.apply-button')
        || Array.from(document.querySelectorAll('button, a[role="button"]')).some(b => {
          const t = (b.textContent || '').trim();
          return t.length < 20 && /^apply(\s+now)?$/i.test(t);
        });
      const hasExternalApply = !!document.querySelector(
        'a[href*="greenhouse"], a[href*="workday"], a[href*="lever"], a[href*="taleo"], a[href*="smartrecruiters"]'
      );
      const applyType = hasExternalApply ? 'external' : (hasNaukriApply ? 'naukri' : 'unknown');

      return { title, company, location, experience, skills, description, applyType };
    });

    res.json({
      ok: true,
      jobUrl: String(jobUrl),
      ...detail,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'JOB_DETAIL_FAILED' });
  } finally {
    await tab.close().catch(() => {});
  }
});

// ─── POST /execution/stop ─────────────────────────────────────────────────────
app.post('/execution/stop', async (_req, res) => {
  const context = state.getBrowserContext();
  try {
    if (context) {
      await context.close().catch(() => {});
    }
    await logEvent('EXECUTION_API_STOP', { actionCount: state.getActionCount() }).catch(() => {});
  } finally {
    state.reset();
  }
  res.json({ ok: true, message: 'Session stopped.' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(chalk.red(`[ExecutionAPI] Unhandled error: ${err.message}`));
  res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(chalk.bold.green(`\n[ExecutionAPI] ✅ Listening on http://localhost:${PORT}`));
  console.log(chalk.gray(`[ExecutionAPI] Endpoints:`));
  console.log(chalk.gray(`  GET  /execution/health`));
  console.log(chalk.gray(`  POST /execution/start`));
  console.log(chalk.gray(`  GET  /execution/jobs`));
  console.log(chalk.gray(`  POST /execution/apply`));
  console.log(chalk.gray(`  GET  /execution/state`));
  console.log(chalk.gray(`  POST /execution/answer`));
  console.log(chalk.gray(`  POST /execution/advance`));
  console.log(chalk.gray(`  GET  /execution/verify`));
  console.log(chalk.gray(`  POST /execution/resolve`));
  console.log(chalk.gray(`  POST /execution/stop`));
});

module.exports = app; // exported for integration tests

