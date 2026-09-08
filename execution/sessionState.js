'use strict';

/**
 * execution/sessionState.js
 *
 * Singleton that tracks the lifecycle of a single browser session started
 * via the Execution API.  It is intentionally separate from the existing
 * index.js / cron.js entry-points so those are left completely unmodified.
 *
 * State machine:
 *   IDLE → STARTED → BROWSING → APPLYING → QUESTIONING → VERIFYING → DONE | FAILED
 *
 * Loop detection:
 *   Keeps a fixed-length ring-buffer of (url, actionKey) pairs.
 *   If the same (url, actionKey) pair appears ≥ LOOP_THRESHOLD times
 *   within the window, `checkLoop()` returns true.
 */

const LOOP_WINDOW   = 5;   // how many recent (url, action) entries to examine
const LOOP_THRESHOLD = 3;  // how many identical entries in that window = loop

/** @type {'IDLE'|'STARTED'|'BROWSING'|'APPLYING'|'QUESTIONING'|'VERIFYING'|'DONE'|'FAILED'} */
let _status = 'IDLE';

/** @type {import('playwright').BrowserContext | null} */
let _browserContext = null;

/** @type {import('playwright').Page | null} */
let _page = null;

/**
 * The job currently being applied to.
 * @type {{ jobUrl: string, role: string, company: string, location: string, experience: string } | null}
 */
let _currentJob = null;

/**
 * Ring-buffer for loop detection.
 * Each entry: { url: string, actionKey: string, ts: number }
 * @type {Array<{url: string, actionKey: string, ts: number}>}
 */
const _actionHistory = [];

/**
 * Accumulated Q&A for the current application.
 * @type {Array<{question: string, answer: string, source: string}>}
 */
let _currentQA = [];

/** ISO timestamp when the current session was started */
let _startedAt = null;

/** Running count of actions taken this session */
let _actionCount = 0;

// ─── Status ──────────────────────────────────────────────────────────────────

function getStatus() {
  return _status;
}

/**
 * Transition to a new status.
 * Illegal transitions throw rather than silently corrupt state.
 * @param {'IDLE'|'STARTED'|'BROWSING'|'APPLYING'|'QUESTIONING'|'VERIFYING'|'DONE'|'FAILED'} next
 */
function setStatus(next) {
  const allowed = {
    IDLE:        ['STARTED'],
    STARTED:     ['BROWSING', 'FAILED'],
    BROWSING:    ['APPLYING', 'BROWSING', 'DONE', 'FAILED'],
    APPLYING:    ['QUESTIONING', 'VERIFYING', 'APPLYING', 'DONE', 'FAILED'],
    QUESTIONING: ['QUESTIONING', 'VERIFYING', 'APPLYING', 'DONE', 'FAILED'],
    VERIFYING:   ['DONE', 'FAILED', 'APPLYING'],
    DONE:        ['IDLE'],
    FAILED:      ['IDLE'],
  };

  const transitions = allowed[_status] ?? [];
  if (!transitions.includes(next)) {
    throw new Error(
      `[SessionState] Illegal transition: ${_status} → ${next}`
    );
  }
  _status = next;
}

// ─── Browser / Page ──────────────────────────────────────────────────────────

function setBrowserContext(context) {
  _browserContext = context;
}

function getBrowserContext() {
  return _browserContext;
}

function setPage(page) {
  _page = page;
}

function getPage() {
  return _page;
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

function startSession() {
  _startedAt  = new Date().toISOString();
  _actionCount = 0;
  _actionHistory.length = 0;
  _currentQA  = [];
  _currentJob = null;
}

function getStartedAt() {
  return _startedAt;
}

/**
 * Full reset — called by POST /execution/stop or on unrecoverable error.
 */
function reset() {
  _status         = 'IDLE';
  _browserContext = null;
  _page           = null;
  _currentJob     = null;
  _startedAt      = null;
  _actionCount    = 0;
  _currentQA      = [];
  _actionHistory.length = 0;
}

// ─── Job context ─────────────────────────────────────────────────────────────

function setCurrentJob(job) {
  _currentJob = job;
  _currentQA  = [];
}

function getCurrentJob() {
  return _currentJob;
}

// ─── Q&A tracking ────────────────────────────────────────────────────────────

/**
 * Record an answered question.
 * @param {string} question
 * @param {string} answer
 * @param {'profile'|'cache'|'llm'|'chatgpt'|'manual'|'unknown'} source
 */
function recordAnswer(question, answer, source = 'unknown') {
  _currentQA.push({ question, answer, source, ts: new Date().toISOString() });
}

function getCurrentQA() {
  return [..._currentQA];
}

// ─── Loop detection ──────────────────────────────────────────────────────────

/**
 * Record an action so it can be checked for loops.
 * @param {string} url       — page URL when the action was taken
 * @param {string} actionKey — short identifier, e.g. "advance", "answer:xyz"
 */
function recordAction(url, actionKey) {
  _actionCount += 1;
  _actionHistory.push({ url, actionKey, ts: Date.now() });
  // keep only the last LOOP_WINDOW entries
  if (_actionHistory.length > LOOP_WINDOW) {
    _actionHistory.shift();
  }
}

/**
 * Returns true when the same (url, actionKey) pair has appeared at least
 * LOOP_THRESHOLD times inside the current window.
 * @param {string} url
 * @param {string} actionKey
 * @returns {boolean}
 */
function isLooping(url, actionKey) {
  const matches = _actionHistory.filter(
    e => e.url === url && e.actionKey === actionKey
  ).length;
  return matches >= LOOP_THRESHOLD;
}

function getActionCount() {
  return _actionCount;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Returns a plain-object summary of the current session state.
 * Safe to serialise as JSON and return in API responses.
 */
function snapshot() {
  return {
    status:      _status,
    startedAt:   _startedAt,
    actionCount: _actionCount,
    currentJob:  _currentJob,
    qaCount:     _currentQA.length,
    recentActions: _actionHistory.slice(-LOOP_WINDOW).map(e => ({
      url:       e.url,
      actionKey: e.actionKey,
    })),
  };
}

module.exports = {
  // status
  getStatus,
  setStatus,
  // browser
  setBrowserContext,
  getBrowserContext,
  setPage,
  getPage,
  // lifecycle
  startSession,
  getStartedAt,
  reset,
  // job
  setCurrentJob,
  getCurrentJob,
  // qa
  recordAnswer,
  getCurrentQA,
  // loop detection
  recordAction,
  isLooping,
  getActionCount,
  // snapshot
  snapshot,
};
