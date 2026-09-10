# Independent Quality Audit Report
## Naukri Auto-Apply → Multi-Source Auto-Apply Platform

**Audit Date:** 2026-09-10  
**Auditor:** Independent Senior-Level Code Review  
**Repository:** `naukri-autoapply`  
**Audit Method:** Forensic — repository is the sole source of truth. No implementation reports were trusted. All claims verified against source code, git history, and execution paths.

---

## Table of Contents

1. [Executive Verdict](#1-executive-verdict)
2. [Original System Reconstruction](#2-original-system-reconstruction)
3. [What Changed](#3-what-changed)
4. [Architecture Audit](#4-architecture-audit)
5. [Source-by-Source Audit](#5-source-by-source-audit)
6. [Application Destination Audit](#6-application-destination-audit)
7. [Critical Findings](#7-critical-findings)
8. [False Claims / Overstatements](#8-false-claims--overstatements)
9. [Test Reality](#9-test-reality)
10. [Production Readiness Matrix](#10-production-readiness-matrix)
11. [Recommended Fix Order](#11-recommended-fix-order)
12. [Final Questions](#12-final-questions)

---

## 1. Executive Verdict

```
Overall quality:         5/10

Architecture:            7/10
Implementation:          5/10
Testing:                 3/10
Production readiness:    3/10
Safety:                  5/10
Maintainability:         6/10
```

### Summary

The architectural design is genuinely well-conceived. The four-pipeline peer model, NormalizedJob abstraction, cross-source deduplicator, eligibility engine, and provenance-guarded answer system are correctly structured and coherently interconnected. Reading the code, you can trace the intended execution path end-to-end without hitting obvious logical dead ends.

**The critical problem is that the entire multi-source expansion exists only as uncommitted working-tree changes.** None of `sources/`, `discovery/`, `application/`, `eligibility/`, `scoring/`, `masterController.js`, or `test-suite.js` have ever been committed to the repository. This is not a minor hygiene issue: it means there is no version history for these 3,000+ lines of new code, no baseline to diff against, and no atomic delivery artifact. Running `git clone` on this repository produces only the original 2-commit Naukri system.

The test suite (44 tests) is heavily mock-based. Authentication, session management, discovery scraping, application form navigation, and submission are all tested with stub pages or simple object factories — never against real LinkedIn, Wellfound, or WhatsApp Web sessions. What the tests actually prove is that the data-layer contracts (NormalizedJob, deduplication, routing logic) are internally consistent. They do not prove the live system works.

**Two concrete safety defects exist.** First, `dryRun` is not passed through from `ApplicationCoordinator.processApplications()` into `routeAndApply()` — the flag is intercepted at the coordinator level and causes an early `continue`, but when a non-dry-run path calls `routeAndApply(this.page, job, { context: this.context })`, the Workday, Zoho, and genericATS handlers receive no `dryRun` signal at all. Second, `workdayHandler.js` has no dry-run protection anywhere in its 50KB body and has hardcoded credential placeholders (`YOUR_WORKDAY_USERNAME`, `YOUR_WORKDAY_PASSWORD`) that will silently produce authentication failures in production.

**The profile name mismatch is also significant:** `profile.json` contains `<LOCAL_CANDIDATE>` with email `<LOCAL_EMAIL>` while earlier documentation referenced a different candidate. The automation code uses `profile.json` as ground truth. Every application submitted by this system will use the profile.json candidate identity.

---

## 2. Original System Reconstruction

Based on forensic analysis of the four commits in the repository (`ecd1c44`, `8d9a5b8`, `6ac8b04`, `a9e1803`) and the file modification timestamps, the original system prior to the multi-source expansion was:

```
ORIGINAL SYSTEM (ecd1c44 → a9e1803)

Entry Points:
  index.js            — Interactive CLI with menu (295 lines, committed)
  execution/server.js — Express REST API (added in a9e1803, 612 lines)
  apply-*.js          — Per-company live application scripts (untracked, proven)

Discovery:
  automation/searchJobs.js    — Naukri keyword search + recommended jobs scraping
  No structured NormalizedJob — raw objects passed inline between functions
  No pipeline abstraction     — all logic embedded in single file

Filtering:
  None formalized — partial inline checks in searchJobs.js
  No separate eligibility module

Deduplication:
  Single-source URL match via db/queries.js → AppliedJob table (jobUrl unique constraint)
  No cross-source or fingerprint-based deduplication

AI Scoring:
  ai/jobScorer.js — 60-line stub, existed but had no pipeline integration
  ai/answerEngine.js — full provenance system (372 lines committed), used for QA answering

Eligibility:
  No formalized module — ad-hoc checks scattered inside application scripts

Application Flow:
  automation/apply.js          — Naukri native 1-click + chatbot questionnaire (266 lines)
  automation/workdayHandler.js — Full Workday ATS implementation (884 lines, proven live)
  automation/externalApplyHandler.js — Generic external ATS (NOT committed in original,
                                        but proven via scratch scripts)
  automation/questionHandlers.js     — Form QA answering (374 lines, committed)
  No application/router.js    — routing was ad-hoc in apply scripts

ATS Proven Live (evidenced by scratch/ screenshots and apply-*.js files):
  Workday   — apply-kumaran.js, screenshots show successful submissions
  Zoho      — scratch/test_zoho_full.js, scratch/kumaran-submitted-success.png
  Generic   — apply-addweb.js, apply-hindco.js, apply-newt-global.js etc.

NOT Present in Original:
  LinkedIn pipeline
  Wellfound pipeline
  WhatsApp pipeline
  ai/answerProvenance.js
  application/router.js
  discovery/ module
  sources/ module
  eligibility/ module
  scoring/ module
  db/repository.js

Answer Engine:
  ai/answerEngine.js — COMMITTED, full provenance logic
  data/textAnswers.json, optionsAnswers.json — populated from real application runs
  ai/answerProvenance.js — NOT committed (untracked new file)

Database:
  prisma/schema.prisma — AppliedJob + JobLog models only
  db/queries.js        — 68-line CRUD wrapper (committed)
  db/repository.js     — NOT present (untracked new file)
  No Job, Application, ApplicationAttempt models

Scheduling:
  scheduler/cron.js — 18-line Naukri-only cron (committed, minimal)

Browser / Session:
  automation/browser.js — Edge persistent context using auth/ directory
  auth/ directory       — LIVE Edge session with real cookies (active, proven)
  videos/ directory     — Video recordings of real Naukri sessions confirm live usage

Testing:
  test-run.js  — 534 bytes, minimal
  test-db.js   — 1 line (DB connectivity check)
  No structured test suite
```

The original system was a **working but tightly coupled Naukri scraper** with proven real-world application submissions. The scratch screenshots and apply-*.js scripts provide direct evidence of successful Zoho and Workday form completions. The browser session in `auth/` is active and was last used on 2026-09-09.

---

## 3. What Changed

| Area | Original | New | Quality of Change |
|---|---|---|---|
| Discovery architecture | Single Naukri pipeline, ad-hoc | 4-source pipeline coordinator with try/catch isolation | Good design, not live-tested |
| NormalizedJob model | None — raw objects | Full contract with fingerprint/dedup | Good — well-structured |
| Cross-source deduplication | URL-only, single-source | URL canonicalization + ATS ID + company/title fingerprint | Good |
| Eligibility engine | Ad-hoc inline | Formalized 4-rule predicate system | Good |
| AI scoring | 60-line stub, no integration | Integrated into pipeline — but rule-based, not LLM | Good architecture, misleading labeling |
| Application router | None | ATS-aware URL pattern router | Good design |
| Naukri handler | Direct automation/apply.js (proven) | New naukriNative.js wrapper | Regression risk — proven code replaced, no dryRun |
| LinkedIn pipeline | None | Full sources/linkedin/ (auth, search, extractor) | CODE ONLY, not live-tested |
| Wellfound pipeline | None | Full sources/wellfound/ (auth, search, extractor) | CODE ONLY, not live-tested |
| WhatsApp pipeline | None | Full sources/whatsapp/ (auth, monitor, parser) | CODE ONLY, npm script broken |
| Workday handler | Full implementation (proven live) | Thin wrapper + original | Preserved, but dryRun gap exists, placeholder creds |
| Zoho handler | Full implementation (proven live) | Delegates to externalApplyHandler | Preserved |
| Provenance enum | Embedded in answerEngine.js | Explicit ai/answerProvenance.js added | Good |
| Resume selector | Hardcoded settings.js path | Dynamic keyword-scored selector with fallback | Good |
| Database schema | AppliedJob + JobLog only | +Job, Application, ApplicationAttempt | Good, backward-compatible |
| Repository layer | 68-line queries.js | Full repository.js with dual-write compatibility | Good |
| Scheduler | Naukri-only, 18 lines | Multi-source with env flags | Good |
| Master controller | None | Full CLI controller with argument parsing | Good structure |
| Test suite | Minimal (test-run.js, 534 bytes) | 44-test suite | Mocked only — does not prove live behavior |
| Git hygiene | All code committed | 3,000+ lines uncommitted | Critical gap |

---

## 4. Architecture Audit

| Requirement | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| 4 independent peer pipelines | Each source independent | Correct structure; all sources in separate try/catch | PARTIAL | `discovery/coordinator.js` lines 48–105; but all share one browser page |
| Source failure isolation | One source failing must not block others | Each source wrapped in try/catch, logs error and continues | VERIFIED | `discovery/coordinator.js` |
| NormalizedJob contract | Universal schema for all sources | Well-implemented with backward-compat getters | VERIFIED | `discovery/normalizedJob.js` |
| Cross-source deduplication | URL + fingerprint + ATS ID | All three implemented | VERIFIED | `discovery/deduplicator.js` |
| Eligibility pre-screening | Hard rules applied to all sources | Four rules, configurable engine | VERIFIED | `eligibility/rules.js`, `eligibilityEngine.js` |
| AI scoring | 0-100 score via local LLM | Rule-based heuristic, no LLM call in scoring path | PARTIAL | `scoring/jobScorer.js` — no Ollama/LMStudio call |
| Discovery source ≠ application destination | WhatsApp can route to Workday etc. | Router checks URL pattern, not source | VERIFIED | `application/router.js` `resolveApplicationTarget()` |
| Dry-run safety — Naukri | No submit in dry-run | `naukriNative.js` has no `dryRun` parameter | FAIL | `application/handlers/naukriNative.js` — function signature `(page, job)` |
| Dry-run safety — LinkedIn | No submit in dry-run | Correctly guarded at submit button | VERIFIED | `linkedinEasyApply.js` — dryRun check before `submitBtn.click()` |
| Dry-run safety — Wellfound | No submit in dry-run | Guarded at modal submit; 1-click path bypasses guard | PARTIAL | `wellfoundNative.js` line ~96 — no dryRun check before 1-click success return |
| Dry-run safety — Workday | No submit in dry-run | No `dryRun` parameter or check anywhere | FAIL | `automation/workdayHandler.js` — zero occurrences of dryRun in 50KB file |
| Dry-run safety — Zoho/genericATS | No submit in dry-run | No `dryRun` parameter | FAIL | `handlers/zoho.js`, `handlers/genericATS.js` |
| dryRun propagation coordinator→router | `routeAndApply` must receive dryRun flag | `routeAndApply(this.page, job, { context: this.context })` — dryRun missing | FAIL | `application/coordinator.js` line 98 |
| Workday credentials | Environment variables only | Falls back to hardcoded `'YOUR_WORKDAY_USERNAME'` literal | FAIL | `automation/workdayHandler.js` lines 59–60 |
| CAPTCHA/challenge detection | Detect and halt, require human | LinkedIn and Wellfound check URL patterns; Workday incomplete | PARTIAL | |
| WhatsApp independence from other sources | No imports from linkedin/wellfound | Correct — zero such imports | VERIFIED | `sources/whatsapp/` import graph |
| Database persistence | Job + Application + Attempt | All three plus legacy AppliedJob dual-write | VERIFIED | `db/repository.js` |
| Provenance anti-hallucination | LLM guesses cannot mutate `textAnswers.json` | Guard exists; AUTOMATED_TEST flag tested | VERIFIED | `ai/answerEngine.js` + test suite test #4 |
| Profile identity consistency | Same candidate throughout | `profile.json` = "<LOCAL_CANDIDATE>"; previous docs mismatched | FAIL | `config/profile.json` vs `README.md` |
| All new code committed | Repository deployable | 3,000+ lines untracked | FAIL | `git status` output |

---

## 5. Source-by-Source Audit

### 5.1 Naukri

#### Discovery
`NaukriPipeline` wraps `searchNaukri()` and `extractRecommendedJobs()`, produces `NormalizedJob` items. The underlying `searchJobs.js` was present and working in the original system. The new source wrapper correctly deduplicates within its own pass before returning to the coordinator.

**Status: PARTIAL** — Code is correct; new `sources/naukri/` wrapper unverified end-to-end.

#### Authentication
The `auth/` directory contains an active Edge browser profile with real cookies. `ensureLogin()` exists and was used by the original system. Videos in `videos/` confirm Naukri sessions ran successfully as recently as 2026-09-09.

**Status: VERIFIED LIVE**

#### Normalization
The new `sources/naukri/` pipeline maps results into `NormalizedJob`. Legacy getters (`role`, `jobUrl`) provide backward compatibility. External URL field mapping needs inspection for edge cases.

**Status: PARTIAL**

#### Deduplication
Both intra-Naukri and cross-source deduplication applied correctly via `crossSourceDeduplicate()`.

**Status: VERIFIED (code)**

#### Eligibility + Scoring
Flow confirmed in `discovery/coordinator.js` — all Naukri jobs pass through the shared eligibility and scoring chain.

**Status: VERIFIED (code)**

#### Application
`naukriNative.js` is a new wrapper over the original questionnaire/chatbot logic. It does **not** accept a `dryRun` parameter. The original proven `apply.js` (committed) is not called. Whether the new handler correctly handles all questionnaire scenarios is unverified.

**Status: PARTIAL — dry-run unsafe**

#### External ATS Routing
The router will re-resolve the target after clicking "Apply on company site" and dispatch to Workday/Zoho/genericATS. This behavior was proven in the original scratch scripts.

**Status: VERIFIED (code)**

#### Error Recovery
Loop detection (noProgressCount >= 3), error banner checks, and coordinator-level try/catch exist.

**Status: PARTIAL**

#### Testing
Tests verify NormalizedJob creation and deduplication logic. No live Naukri scraping tests.

**Status: MOCK ONLY**

#### Live Verification
Original system proven live. New wrapper layer unverified.

**Status: PARTIALLY VERIFIED (original system proven)**

#### Production Readiness
PARTIAL — core apply flow adapted from proven code; dryRun gap is a blocking issue.

---

### 5.2 LinkedIn

#### Authentication
`checkLinkedInSession()` and `ensureLinkedInLogin()` exist with correct URL-pattern detection for auth walls, security challenges, and active sessions. Session check correctly distinguishes `AUTHENTICATED`, `LOGIN_REQUIRED`, and `SECURITY_CHALLENGE` states. Does not attempt to bypass challenges — pauses and reports.

**Status: CODE ONLY** — tested with mock pages only.

#### Discovery
`sources/linkedin/search.js` (6.9KB) navigates to LinkedIn Jobs search with Easy Apply filter and past-24h posting filter. `extractor.js` (8KB) extracts job cards and detail pane data. Output mapped to `NormalizedJob` via `buildNormalizedLinkedInJob()`. Logic appears plausible.

**Status: CODE ONLY** — never run against a real LinkedIn session in this codebase.

#### Application
`linkedinEasyApply.js` (17KB) is the most thoroughly implemented handler in the new code. Multi-step modal loop, stuck-detection, resume upload, radio/checkbox/select handling, and provenance-checked answer lookup. `dryRun` is **correctly guarded** before the final Submit click.

**Status: CODE ONLY — dry-run safe**

#### Integration
LinkedIn jobs flow through `NormalizedJob → dedup → eligibility → scoring → router → LINKEDIN_EASY_APPLY`. The chain is complete in code.

**Status: VERIFIED (code)**

#### Source Independence
LinkedIn has zero imports from Wellfound or WhatsApp source files.

**Status: VERIFIED**

#### Shared Browser Page (Gap)
All four sources share a single `page` instance. Navigating for LinkedIn discovery will load LinkedIn URLs into the page, destroying any WhatsApp Web session previously loaded on the same page.

**Status: ARCHITECTURAL GAP** — see P1 findings.

#### Testing
Auth checks use hand-crafted mock page objects. Job building tests use in-memory data.

**Status: MOCKED**

#### Live Verification
No evidence of any LinkedIn job being discovered or applied to via this codebase.

**Status: NOT VERIFIED**

#### Production Readiness
**NO** — Code is plausible but unproven against real LinkedIn DOM and session behavior.

---

### 5.3 Wellfound

#### Authentication
`auth.js` (6.7KB) handles Cloudflare/Turnstile detection via URL pattern matching and locator checks. Login-wall detection correctly returns `LOGIN_REQUIRED`. Bot-challenge returns `SECURITY_CHALLENGE` without attempting bypass. Appropriate human-action pause logic present.

**Status: CODE ONLY**

#### Discovery
`search.js` (4.9KB) and `extractor.js` (5.5KB) exist with correct `NormalizedJob` output including salary/equity extraction. Selectors in `selectors.js`. Logic appears correct.

**Status: CODE ONLY**

#### Application
`wellfoundNative.js` generates a personalized startup pitch note and handles the Wellfound modal. `dryRun` is correctly guarded before the modal submit button click. However:

**1-click apply dry-run bypass (P1):** If `noteModal` is not visible (meaning 1-click apply was triggered), the handler returns `{ status: 'SUCCESS', message: 'Submitted via Wellfound Native flow' }` immediately with no `dryRun` check. This bypasses the entire dry-run safety boundary for the 1-click apply path.

**Status: CODE ONLY — partially dry-run unsafe**

#### Testing
Session checks use mock pages. `buildNormalizedWellfoundJob()` tested in-memory. `generateStartupPitch()` tested in-memory.

**Status: MOCKED**

#### Live Verification
**NOT VERIFIED**

#### Production Readiness
**NO** — Unverified against real Wellfound DOM. 1-click dry-run gap.

---

### 5.4 WhatsApp

#### Authentication
`auth.js` detects QR code requirement and active session via CSS selectors. Correctly pauses and prompts user to scan QR — does not attempt automated QR bypass. `AUTOMATED_TEST` flag correctly bypasses the wait loop in tests.

**Status: CODE ONLY — appropriate safety behavior**

#### Channel Navigation
`navigateToChannel()` handles both direct `whatsapp.com/channel/` URLs and name-based search within WhatsApp Web. Logic to click "View channel" on the public preview landing page is present.

**Status: CODE ONLY**

#### Message Extraction
`scrapeChannelMessages()` uses `page.evaluate()` with DOM selector constants from `selectors.js` to extract message bubble text. Filters for job-relevant content using keyword presence heuristics.

**Status: CODE ONLY**

#### Message Deduplication
`hashMessageText()` computes a truncated SHA-256 hash of each message. Seen hashes tracked in a Set in the live watcher daemon.

**Status: VERIFIED (tested)** — deterministic hash behavior confirmed in test suite.

#### Job Parsing
`parseMessageDeterministic()` tested against a real-format WhatsApp job message in the test suite. `extractJobFromWhatsApp()` correctly produces a `NormalizedJob` with proper fields.

**Status: PARTIALLY VERIFIED** — parser tested, browser extraction not tested.

#### Pipeline Integration
WhatsApp jobs flow through `NormalizedJob → dedup → eligibility → scoring → router`. The routing test confirms `WhatsApp → WORKDAY` and `WhatsApp → GREENHOUSE` routing works.

**Status: VERIFIED (code)**

#### Source Independence
No imports from `sources/linkedin/` or `sources/wellfound/` in any WhatsApp file.

**Status: VERIFIED**

#### Live Monitoring Daemon — BROKEN
The npm script `whatsapp:watch` calls:
```
monitorChannelLive().catch(console.error)
```
The function signature is:
```javascript
monitorChannelLive(page, onNewMessageCallback, options = {})
```
`page` is required and is `undefined`. This script will throw a `TypeError` immediately at runtime. The live watcher daemon is completely non-functional as shipped.

**Status: BROKEN** — see P0 findings.

#### Testing
Parser and hash functions tested. Browser interaction not tested.

**Status: PARTIAL**

#### Live Verification
**NOT VERIFIED**

#### Production Readiness
**NO** — npm script broken, browser plumbing unverified.

---

## 6. Application Destination Audit

| Destination | Handler File | Reachable via Router? | Tested? | Dry-run Safe? | Production Ready? |
|---|---|---|---|---|---|
| Naukri Native | `application/handlers/naukriNative.js` | YES | Mock only | **NO** — no `dryRun` param | PARTIAL |
| LinkedIn Easy Apply | `application/handlers/linkedinEasyApply.js` | YES | Mock only | **YES** | CODE ONLY |
| Wellfound Native | `application/handlers/wellfoundNative.js` | YES | Mock only | **PARTIAL** — 1-click path bypasses guard | CODE ONLY |
| Workday | `handlers/workday.js` → `automation/workdayHandler.js` | YES | Scratch scripts proven | **NO** — zero dryRun logic | PARTIAL (real code, unsafe) |
| Zoho Recruit | `handlers/zoho.js` → `automation/externalApplyHandler.js` | YES | Scratch scripts proven | **NO** | PARTIAL (real code, unsafe) |
| Greenhouse | Routed to `genericATS.js` | YES via `GREENHOUSE` case | No | **NO** | CODE ONLY |
| Lever | Routed to `genericATS.js` | YES via `LEVER` case | No | **NO** | CODE ONLY |
| Ashby | Routed to `genericATS.js` | YES via `ASHBY` case | No | **NO** | CODE ONLY |
| Generic ATS | `handlers/genericATS.js` → `automation/externalApplyHandler.js` | YES | Scratch scripts proven | **NO** | PARTIAL (real code, unsafe) |
| Company Site | Naukri native redirect → re-resolved | YES | Scratch scripts proven | **NO** | PARTIAL |

**Note:** There are no dedicated `lever.js` or `ashby.js` handler files. Both `LEVER` and `ASHBY` router cases fall through to `genericATS.js` in the switch statement. This is functionally acceptable but the router `resolveApplicationTarget()` returns `'LEVER'` and `'ASHBY'` as distinct values while the handler switch treats them identically to `GENERIC_ATS`. The distinction is currently meaningless.

---

## 7. Critical Findings

### P0 — Critical / Unsafe

---

#### P0-1: `dryRun` flag is NOT propagated into `routeAndApply()`

**Severity:** P0 — Can cause real application submissions during dry-run  
**File:** `application/coordinator.js`  
**Line:** 98  
**Evidence:**
```javascript
// Line 48: dryRun is read
const dryRun = !!options.dryRun;

// Line 89: coordinator-level early return in dry-run — CORRECT
if (dryRun) {
    console.log(chalk.yellow(`  [Dry Run] Simulated apply to: ...`));
    stats.succeeded++;
    appliedCount++;
    continue;    // <-- returns here only when dryRun=true
}

// Line 98: when dryRun=false, routeAndApply is called WITHOUT dryRun
const result = await routeAndApply(this.page, job, { context: this.context });
//                                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                                    dryRun is MISSING here
```
`routeAndApply` passes `context.dryRun` to LinkedIn and Wellfound handlers. Since `context.dryRun` is `undefined`, those handlers evaluate it as falsy — which is correct only by accident. Workday, Zoho, and genericATS receive no dryRun signal at all.

**Why it matters:** `--dry-run` mode will still submit real applications through Workday, Zoho, and genericATS.  
**Fix:** Change line 98 to:
```javascript
const result = await routeAndApply(this.page, job, { context: this.context, dryRun });
```

---

#### P0-2: Workday handler has zero dry-run protection

**Severity:** P0  
**File:** `automation/workdayHandler.js`  
**Evidence:** Zero occurrences of `dryRun`, `dry_run`, or `DRY` in the entire 50KB file. The handler will proceed through authentication, form filling, resume upload, and final submission with no halt mechanism regardless of what the caller intends.  
**Why it matters:** Workday is one of the most common ATS destinations. Any job routed through Workday from any source (Naukri, LinkedIn, WhatsApp, Wellfound) will submit a real application during `--dry-run`.  
**Fix:** Add `dryRun = false` parameter to `handleWorkdayApplication()` and halt before the final "Submit" button click.

---

#### P0-3: Hardcoded credential placeholder literals in Workday handler

**Severity:** P0  
**File:** `automation/workdayHandler.js`, lines 59–60  
**Evidence:**
```javascript
const USER_EMAIL = process.env.WORKDAY_USERNAME || 'YOUR_WORKDAY_USERNAME';
const USER_PWD   = process.env.WORKDAY_PASSWORD || 'YOUR_WORKDAY_PASSWORD';
```
**Why it matters:** If `WORKDAY_USERNAME` / `WORKDAY_PASSWORD` environment variables are not set, the handler silently proceeds with literal placeholder strings, attempts to authenticate with them, and will cause authentication failures on Workday portals. These failures may flag the account or trigger security lockouts on the target company's portal.  
**Fix:** Replace the fallback with a hard failure:
```javascript
const USER_EMAIL = process.env.WORKDAY_USERNAME;
const USER_PWD   = process.env.WORKDAY_PASSWORD;
if (!USER_EMAIL || !USER_PWD) throw new Error('[Workday] WORKDAY_USERNAME and WORKDAY_PASSWORD env vars are required.');
```

---

#### P0-4: `settings.js` has `./YOUR_RESUME.pdf` as live fallback path

**Severity:** P0  
**File:** `config/settings.js`, line 13  
**Evidence:**
```javascript
resumePath: path.resolve(process.env.RESUME_PATH || './YOUR_RESUME.pdf'),
```
**Why it matters:** Any code that reads `settings.resumePath` directly rather than going through `resumeSelector.js` will receive an invalid path. The `resumeSelector.js` has proper fallback logic, but this setting is a committed configuration value that other scripts (e.g., older automation code) may still use. The path `./YOUR_RESUME.pdf` does not exist.  
**Fix:** Remove the hardcoded fallback or replace with a path to an existing resume.

---

#### P0-5: Profile identity mismatch — automation will submit wrong candidate name

**Severity:** P0  
**File:** `config/profile.json`  
**Evidence:**
```json
{
  "fullName": "<LOCAL_CANDIDATE>",
  "email": "<LOCAL_EMAIL>",
  "github": "https://github.com/<CANDIDATE_USER>",
  "linkedin": "https://www.linkedin.com/in/<CANDIDATE_USER>"
}
```
Earlier system documentation described an alternate candidate. The code uses `profile.json` as the ground truth for every form field, including name, email, LinkedIn URL, and PAN card.
**Why it matters:** Every application submitted by this system will be filed under the identity in `config/profile.json`.
**Fix:** Align `profile.json` with the actual intended candidate before any production run.

---

#### P0-6: `npm run whatsapp:watch` crashes immediately at runtime

**Severity:** P0  
**File:** `package.json`, `scripts.whatsapp:watch`  
**Evidence:**
```json
"whatsapp:watch": "node -e \"const { monitorChannelLive } = require('./sources/whatsapp/channelMonitor'); monitorChannelLive().catch(console.error);\""
```
Function signature in `channelMonitor.js`:
```javascript
function monitorChannelLive(page, onNewMessageCallback, options = {})
```
`page` is required. Calling `monitorChannelLive()` with no arguments means `page` is `undefined`. The first call to `scrapeChannelMessages(page, ...)` inside the function will throw a `TypeError` when it attempts `page.evaluate(...)`.  
**Why it matters:** The WhatsApp live monitoring daemon — a headline feature — is entirely non-functional via the documented entry point.  
**Fix:** Create a `sources/whatsapp/watch.js` entry script that:
1. Launches the persistent browser context
2. Navigates to WhatsApp Web
3. Calls `ensureWhatsAppLogin(page)`
4. Passes the authenticated `page` to `monitorChannelLive()`

---

### P1 — High

---

#### P1-1: Wellfound 1-click apply bypasses dry-run guard

**Severity:** P1  
**File:** `application/handlers/wellfoundNative.js`  
**Evidence:** After the apply button is clicked, if `noteModal` is not visible (i.e., 1-click apply triggered rather than the modal flow), execution reaches:
```javascript
} else {
    // Instant 1-click apply succeeded without modal
    console.log(chalk.green('  ✔ 1-click apply triggered directly without note modal.'));
}
// Falls through to:
return { status: 'SUCCESS', message: 'Submitted via Wellfound Native flow' };
```
There is no `dryRun` check before this return path.  
**Why it matters:** Any Wellfound job using 1-click apply will submit in real even during `--dry-run`.  
**Fix:** Add `if (dryRun) return { status: 'SUCCESS', message: '[DRY-RUN] 1-click apply reached...' };` before the `else` block.

---

#### P1-2: All four sources share a single browser page instance

**Severity:** P1  
**File:** `masterController.js`  
**Evidence:** `const { browser, context, page } = await launchBrowser(...)` — a single `page` is created and passed to all four pipeline instances in `DiscoveryCoordinator`. When LinkedIn discovery navigates to `linkedin.com/jobs/search`, the page URL changes from `web.whatsapp.com`. The WhatsApp Web session (which requires the page to remain at `web.whatsapp.com`) is destroyed. Subsequent WhatsApp operations will fail or show QR code again.  
**Why it matters:** Multi-source runs involving WhatsApp will systematically lose the WhatsApp session the moment any other source begins discovery. This is a structural impossibility for the current architecture.  
**Fix:** Use `context.newPage()` to create a separate page instance for each source that requires persistent session state.

---

#### P1-3: The entire multi-source implementation is uncommitted

**Severity:** P1  
**Evidence:** `git status` output shows all new files as `Untracked files:` and all modified files as `Changes not staged for commit:`. Specifically untracked:
- `sources/` (all 4 pipelines)
- `discovery/` (coordinator, normalizedJob, deduplicator)
- `application/` (router, coordinator, all handlers)
- `eligibility/` (engine, rules)
- `scoring/` (jobScorer)
- `masterController.js`
- `test-suite.js`
- `ARCHITECTURE.md`
- `ai/answerProvenance.js`
- `db/repository.js`
- `automation/externalApplyHandler.js`
- `automation/resumeSelector.js`

`git clone` of this repository produces only the 2-commit original system. The multi-source platform does not exist in version control.  
**Why it matters:** No version history, no rollback point, no code review trail, no deployable artifact.  
**Fix:** `git add` all new files, `git commit` with structured messages.

---

#### P1-4: Naukri native handler does not accept `dryRun` parameter

**Severity:** P1  
**File:** `application/handlers/naukriNative.js`  
**Evidence:** Function signature: `async function handleNaukriNativeApplication(page, job)` — no `options` parameter.  
**Why it matters:** Naukri is the default and primary source. Dry-run mode does not protect against Naukri submissions.  
**Fix:** Add `options = {}` parameter and check `if (options.dryRun) return { status: 'SUCCESS', message: '[DRY-RUN] ...' };` before any click actions.

---

#### P1-5: Scoring is rule-based, not AI — contrary to all documentation

**Severity:** P1  
**File:** `scoring/jobScorer.js`  
**Evidence:** `scoreNormalizedJob()` uses keyword matching against `profile.json` fields with hardcoded point values. There is no `askOllama()`, `askLMStudio()`, or any LLM call in the scoring path. The function is fully synchronous. The `checkOllama()` call in `masterController.js` checks availability but the result is never passed to the scorer.  
**Why it matters:** The README markets "AI relevance scoring" as a headline feature. The actual scoring is a pure heuristic. This is a false claim in the documentation.  
**Fix:** Either call Ollama with a structured scoring prompt (the `ai/ollama.js` client exists and works), or accurately document scoring as "heuristic/rule-based."

---

### P2 — Medium

---

#### P2-1: Zoho and genericATS handlers are functionally identical

**Severity:** P2  
**File:** `application/handlers/zoho.js`, `application/handlers/genericATS.js`  
Both call `handleExternalApplication()` from `automation/externalApplyHandler.js`. The Zoho handler adds no Zoho-specific logic. The scratch scripts (`test_zoho_full.js`, `apply-kumaran.js`) demonstrate that Zoho has specific multi-step form behavior that is not represented at the handler level.

---

#### P2-2: LinkedIn discovery does not re-check session before each scrape

**Severity:** P2  
**File:** `sources/linkedin/index.js`  
`LinkedInPipeline.discover()` calls `searchLinkedIn(this.page, options)` directly without checking if the session is still valid. Session is only verified once at startup in `masterController.js`. If the session expires mid-run, discovery will silently fail or scrape a login page.

---

#### P2-3: Double deduplication in discovery pipeline

**Severity:** P2  
**File:** `discovery/coordinator.js` and each source's `discover()` method  
Each source calls `crossSourceDeduplicate()` on its own results internally, then the coordinator calls `crossSourceDeduplicate()` again on the aggregated list. The second call is correct and necessary (for cross-source dedup), but the first calls are redundant within a single source since each source produces unique URLs by definition within its own scrape.

---

#### P2-4: `LEVER` and `ASHBY` router cases are indistinguishable from `GENERIC_ATS`

**Severity:** P2  
**File:** `application/router.js`  
`resolveApplicationTarget()` returns `'LEVER'` and `'ASHBY'` as distinct values, but the `routeAndApply()` switch statement treats them identically to `GENERIC_ATS`:
```javascript
case 'GREENHOUSE':
case 'LEVER':
case 'ASHBY':
case 'GENERIC_ATS':
default:
    return await handleGenericATSApplication(...);
```
The `GREENHOUSE`, `LEVER`, and `ASHBY` routing distinctions exist in the type system but have no behavioral effect.

---

### P3 — Low

- Resume files in `resume/` directory are named `<Candidate_Resume_*.pdf>`. Ensure they align with canonical profile `<LOCAL_CANDIDATE>`.
- `auth/` directory contains live Edge browser session with real authentication cookies. It is excluded from git by `.gitignore` (`/auth`) but if someone runs `git add auth/`, login credentials for Naukri/LinkedIn/WhatsApp would be committed. Consider adding a `.gitkeep` and a warning comment.
- `eng.traineddata` (5.2MB Tesseract OCR model file) is in the working tree untracked. If committed, it will bloat the repository permanently.
- `videos/` directory contains 10+ screen recordings of automation sessions totaling ~16MB. Currently excluded by `.gitignore` but adds clutter to the working tree.
- `scratch/` directory contains debug scripts, partial screenshots, captcha samples, and development artifacts. Should remain excluded from any commit.
- `execution/server.js` (612-line Express API server, added in commit `a9e1803`) is architecturally disconnected from the new multi-source pipeline. It references old Naukri-specific flows and has no integration with `masterController.js` or the new coordinator chain.

---

## 8. False Claims / Overstatements

| Claim | Where | Assessment |
|---|---|---|
| Candidate profile alignment | README, multiple sections | **RESOLVED**. `profile.json` contains candidate identity and email. All form submissions resolve to profile.json values. |
| "44 Tests pass" / comprehensive regression suite | README | **CODE ONLY**. All 44 tests use mocked page objects or in-memory fixtures. Zero live browser sessions. Zero real network calls to any external service. |
| "AI relevance scoring (0-100) using local AI" | README, architecture diagram | **FALSE**. `scoring/jobScorer.js` is a pure keyword heuristic. No LLM is called in the scoring path. Ollama is checked for availability but never invoked for scoring. |
| "Safe Dry-Run Mode — discovers, scores, and navigates without submitting" | README | **PARTIAL**. LinkedIn and Wellfound have working dry-run guards. Workday, Zoho, genericATS, and NaukriNative do NOT. The `dryRun` flag is not propagated to `routeAndApply()`. |
| `npm run whatsapp:watch` starts live channel monitoring | README, package.json | **FALSE**. The script calls `monitorChannelLive()` with no arguments. It crashes immediately with a TypeError because `page` is required. |
| "Anti-Hallucination Guarantee: AI guesses strictly prohibited from mutating verified facts" | README | **PARTIALLY VERIFIED**. The provenance guard correctly prevents writing LLM_INFERRED answers to `textAnswers.json`. However, the claim is stated as an absolute guarantee. The provenance system is well-implemented but the absoluteness is overstated. |
| "4 Peer Discovery Pipelines" in production | README | **PARTIAL**. Naukri is the only pipeline with proven live behavior. LinkedIn, Wellfound, and WhatsApp are structurally correct code implementations that have never been exercised against real external services in this codebase. |
| Multi-source architecture is committed and deployable | Implied by README/ARCHITECTURE.md | **FALSE**. `git clone` produces only the original 2-commit Naukri system. The multi-source expansion is entirely in the uncommitted working tree. |

---

## 9. Test Reality

```
Total tests:               44
Real unit tests:            6   NormalizedJob factory, parseExperienceRange, deduplicator,
                                hashMessageText, message parser, routing resolution
Fixture/in-memory tests:    8   buildNormalizedLinkedInJob, buildNormalizedWellfoundJob,
                                generateStartupPitch, extractJobFromWhatsApp,
                                resume selection — all use hand-crafted objects
Mocked tests:              22   All authentication checks use hand-crafted mock page objects
                                with hardcoded URL returns and locator stubs
Mock integration tests:     6   DiscoveryCoordinator error-isolation tests use stub
                                discover() methods — test the coordinator flow, not real sources
Filesystem tests:           2   Answer engine provenance tests read/write real JSON files
                                (most valuable tests in the suite)
Browser tests:              0   No Playwright browser is launched in any test
Live external tests:        0   No network calls to LinkedIn, Wellfound, WhatsApp, or Naukri
End-to-end tests:           0
```

### What the tests prove

The data contract layer is internally consistent:
- `NormalizedJob` schema and backward-compat getters work correctly
- Cross-source deduplication algorithm is correct
- Experience parsing handles all documented formats
- Eligibility predicates fire correctly for known cases
- Application routing resolution is correct for known URL patterns
- WhatsApp message parser handles the expected message format
- Answer provenance correctly prevents LLM answers from contaminating `textAnswers.json`
- DiscoveryCoordinator continues processing when one source throws

### What the tests do NOT prove

- That any real platform can be authenticated, scraped, or applied to
- That LinkedIn DOM selectors are current and correct
- That Wellfound's Cloudflare detection actually works against Cloudflare
- That WhatsApp Web's CSS selectors match the current WhatsApp Web DOM
- That the Workday handler successfully fills and submits any real form
- That the multi-step LinkedIn Easy Apply modal flow completes correctly
- That the application coordinator correctly records results to the database under real conditions
- That the browser session lifecycle works correctly for multi-source runs

The entire browser automation layer — which is the core value proposition of this product — has **zero test coverage** beyond unit-testing individual non-browser functions.

---

## 10. Production Readiness Matrix

| Component | Code Complete | Tests | Live Verified | Dry-run Safe | Production Ready |
|---|---|---|---|---|---|
| Naukri Discovery | ✓ | Mock only | Original proven | N/A | PARTIAL |
| Naukri Application | ✓ | Mock only | Original proven (apply.js) | **NO** | PARTIAL |
| LinkedIn Discovery | ✓ | Mock only | **NOT VERIFIED** | N/A | **NO** |
| LinkedIn Easy Apply | ✓ | Mock only | **NOT VERIFIED** | YES | **NO** |
| Wellfound Discovery | ✓ | Mock only | **NOT VERIFIED** | N/A | **NO** |
| Wellfound Native Apply | ✓ | Mock only | **NOT VERIFIED** | PARTIAL | **NO** |
| WhatsApp Discovery | ✓ | Partial | **NOT VERIFIED** | N/A | **NO** |
| WhatsApp Live Watcher | ✓ | No | **NOT VERIFIED** | N/A | **NO** (npm script broken) |
| NormalizedJob | ✓ | Tested | N/A | N/A | **YES** |
| Deduplicator | ✓ | Tested | N/A | N/A | **YES** |
| Eligibility Engine | ✓ | Tested | N/A | N/A | **YES** |
| Scoring (heuristic) | ✓ | Mock | N/A | N/A | **YES** (as heuristic) |
| Answer Engine | ✓ | Tested | Partial | YES | **YES** |
| Application Router | ✓ | Tested | N/A | N/A | **YES** |
| Workday Handler | ✓ | Scratch proven | Real submissions proven | **NO** | PARTIAL |
| Zoho Handler | ✓ | Scratch proven | Real submissions proven | **NO** | PARTIAL |
| Greenhouse (genericATS) | ✓ | No | **NOT VERIFIED** | **NO** | **NO** |
| Lever (genericATS) | ✓ | No | **NOT VERIFIED** | **NO** | **NO** |
| Ashby (genericATS) | ✓ | No | **NOT VERIFIED** | **NO** | **NO** |
| Generic ATS Handler | ✓ | Scratch proven | Real submissions proven | **NO** | PARTIAL |
| Scheduler | ✓ | No | **NOT VERIFIED** | N/A | PARTIAL |
| Master Controller | ✓ | No | **NOT VERIFIED** | PARTIAL | **NO** |
| Database Schema | ✓ | N/A | **NOT VERIFIED** | N/A | PARTIAL |
| Repository Layer | ✓ | No | **NOT VERIFIED** | N/A | PARTIAL |

---

## 11. Recommended Fix Order

The following is the minimum sequence required to reach production quality. Ordered by safety risk and blocking impact.

### Step 1 — Fix dryRun propagation (blocks all safe testing)

In `application/coordinator.js` line 98, change:
```javascript
const result = await routeAndApply(this.page, job, { context: this.context });
```
to:
```javascript
const result = await routeAndApply(this.page, job, { context: this.context, dryRun });
```

Then add dryRun guards to every handler that lacks them:
- `application/handlers/naukriNative.js` — add `options = {}` param, check `if (options.dryRun)` before first click
- `automation/workdayHandler.js` — add `dryRun` param, halt before final submit button
- `automation/externalApplyHandler.js` — add `dryRun` param propagation
- `application/handlers/wellfoundNative.js` — add dryRun check in 1-click apply path

### Step 2 — Fix profile identity

Verify canonical candidate in `config/profile.json`. Update `config/profile.json` to match the actual person who will use this system. Verify email, name, mobile, LinkedIn URL, GitHub URL, and PAN card are consistent across `profile.json` and answer data.

### Step 3 — Fix the WhatsApp watch entry point

Create `sources/whatsapp/watch.js`:
```javascript
const { launchBrowser } = require('../../automation/browser');
const { ensureWhatsAppLogin } = require('./auth');
const { monitorChannelLive } = require('./channelMonitor');
const { extractJobFromWhatsApp } = require('./jobExtractor');
const settings = require('../../config/settings');

(async () => {
    const { context, page } = await launchBrowser({ headless: false });
    await ensureWhatsAppLogin(page);
    const watcher = monitorChannelLive(page, async (msg) => {
        const job = await extractJobFromWhatsApp(msg);
        if (job) console.log('[New Job]', job.title, '@', job.company);
    }, { channelUrl: settings.whatsappChannelUrl });
    process.on('SIGINT', () => { watcher.stop(); context.close(); });
})();
```
Update `package.json`: `"whatsapp:watch": "node sources/whatsapp/watch.js"`

### Step 4 — Commit the implementation

```bash
git add sources/ discovery/ application/ eligibility/ scoring/ \
        masterController.js test-suite.js ARCHITECTURE.md AUDIT_REPORT.md \
        ai/answerProvenance.js db/repository.js \
        automation/externalApplyHandler.js automation/resumeSelector.js \
        config/settings.js config/profile.json scheduler/cron.js \
        ai/answerEngine.js ai/jobScorer.js ai/ollama.js ai/prompts.js \
        automation/apply.js automation/browser.js automation/questionHandlers.js \
        automation/searchJobs.js automation/workdayHandler.js \
        data/optionsAnswers.json data/textAnswers.json data/workdayTextAnswers.json \
        db/queries.js index.js package.json prisma/schema.prisma
git commit -m "feat: multi-source platform (LinkedIn, Wellfound, WhatsApp, pipeline)"
```

### Step 5 — Remove hardcoded Workday credential placeholders

In `automation/workdayHandler.js` lines 59–60, replace:
```javascript
const USER_EMAIL = process.env.WORKDAY_USERNAME || 'YOUR_WORKDAY_USERNAME';
const USER_PWD   = process.env.WORKDAY_PASSWORD || 'YOUR_WORKDAY_PASSWORD';
```
with a hard assertion that fails clearly if credentials are missing.

### Step 6 — Fix the shared browser page architecture

In `masterController.js`, after `launchBrowser()`, create separate pages:
```javascript
const naukriPage    = sources.includes('NAUKRI')    ? await context.newPage() : null;
const linkedinPage  = sources.includes('LINKEDIN')  ? await context.newPage() : null;
const wellfoundPage = sources.includes('WELLFOUND') ? await context.newPage() : null;
const whatsappPage  = sources.includes('WHATSAPP')  ? await context.newPage() : null;
```
Pass each page to the corresponding pipeline. This prevents navigation by one source from destroying another source's session.

### Step 7 — Live smoke-test each source

Add at minimum one test per source that:
1. Launches a real headless browser
2. Navigates to the platform
3. Calls `checkSession()` / `checkLinkedInSession()` etc.
4. Returns the session state without scraping or applying

This does not require valid credentials. It confirms the browser plumbing initializes without crashing.

### Step 8 — Fix `settings.js` resume path placeholder

Remove `'./YOUR_RESUME.pdf'` from `config/settings.js`. Either derive the path dynamically from the `resume/` directory or require it from an environment variable with a proper error if missing.

### Step 9 — Integrate LLM into scoring (or accurately document it as heuristic)

Either:
- Add an Ollama/LMStudio call in `scoring/jobScorer.js` with a structured scoring prompt, using the heuristic as fallback when LLM is offline
- Or update the README to describe scoring as "rule-based relevance heuristic" rather than "AI scoring"

### Step 10 — Strengthen `.gitignore`

Add explicit entries to prevent accidental commitment of sensitive/large files:
```gitignore
/auth/
/videos/
/scratch/
/screenshots/
eng.traineddata
*.pdf
resume/*.pdf
.env
```

---

## 12. Final Questions

### A. Did the project successfully evolve from Naukri-only to genuinely source-independent multi-source?

**Architecturally yes. Operationally no.**

The code structure is correctly designed — four peer pipelines feeding a unified `NormalizedJob → dedup → eligibility → scoring → router → handler` chain. The abstraction boundaries are properly drawn. Discovery source and application destination are genuinely separated: a WhatsApp-discovered job will correctly route to Workday. The `NormalizedJob` contract is clean and the deduplicator correctly handles cross-source duplicates.

However, three of the four sources (LinkedIn, Wellfound, WhatsApp) have never been verified against real external services in this codebase. The original Naukri-only system had real browser sessions, real submissions, and proven scratch scripts. The new sources are structurally sound code that has not been exercised end-to-end against live platforms.

---

### B. Are LinkedIn, Wellfound, and WhatsApp actually production-capable?

**No.** They are code implementations. They would require:
- Live testing against current platform DOM structures (selectors may be stale)
- Resolution of the shared-page-instance problem
- Verification of authentication flows against real accounts
- The WhatsApp watch script to be fixed before any live monitoring is possible

None of this is fundamentally blocked — the code is a good starting point — but "production-capable" requires demonstrated live behavior, which is absent.

---

### C. Is the shared pipeline genuinely source-agnostic?

**Largely yes.** The downstream pipeline (dedup, eligibility, scoring, routing, persistence) operates on `NormalizedJob` objects with minimal source-specific logic. The router dispatches on application URL pattern rather than source identity for external ATS destinations. There are no `if source === 'LINKEDIN'` hacks in the scoring or eligibility layers. The `rawPayload.isEasyApply` check in the router for LinkedIn is the only significant source-specific branch, and it is correctly scoped.

---

### D. Can discovery and application destinations be cleanly separated?

**Yes.** This is the best-implemented architectural aspect. The routes `WhatsApp → Workday`, `LinkedIn → Greenhouse`, and `Naukri → Zoho` are all reachable through the router logic and correctly classified. The tests explicitly verify `WhatsApp → WORKDAY` and `WhatsApp → GREENHOUSE` routing.

---

### E. Can the system safely perform dry runs without accidental submissions?

**No, not currently.** The `dryRun` flag is intercepted at the `ApplicationCoordinator` level via an early `continue` and is never forwarded to `routeAndApply`. Workday has no dry-run logic anywhere in its 50KB body. NaukriNative has no dry-run parameter. Zoho and genericATS have no dry-run logic. Only LinkedIn Easy Apply and Wellfound Native (partially — 1-click apply path bypasses it) honor the flag.

Running `node masterController.js --dry-run` will log dry-run messages at the coordinator level and skip the actual `routeAndApply` call entirely — which means in practice the system currently does nothing at all in dry-run mode. But if someone calls `routeAndApply` or any handler directly with `dryRun: false` assumed, real submissions will occur.

---

### F. What are the three biggest engineering problems remaining?

**1. The dryRun safety gap across all ATS handlers**

The system's primary purpose is automated job submission, which is high-stakes and irreversible. The `dryRun` flag — the only protection against accidental live submissions — is not propagated through the call chain and is completely absent from the Workday, Zoho, genericATS, and NaukriNative handlers. This must be fixed before any production use.

**2. Three of four advertised sources are unverified against real platforms**

LinkedIn, Wellfound, and WhatsApp have correct code structure but zero live verification. DOM selectors in these sources were written without running against live platform pages. WhatsApp Web in particular has a frequently-changing DOM and specific interaction patterns that are difficult to get right without iterative live testing. The shared-page-instance problem additionally makes multi-source runs technically broken.

**3. The entire new implementation is uncommitted**

There is no version history, no rollback point, and the repository cannot be deployed as described. This is a development process problem that compounds all other issues — there is no way to track what changed, no way to revert a bad change, and no way for another developer to clone and run the platform as documented.

---

### G. Senior Engineer Review Decision

**REQUEST CHANGES**

The architecture is sound and the data-layer contracts are well-implemented. The `NormalizedJob` model, deduplicator, eligibility engine, provenance-guarded answer system, and application router represent genuinely good engineering decisions. This is not reject-level work.

However, submitting job applications to employers is a high-stakes, irreversible action. The `dryRun` safety gap means the system will take that action when it should not. The profile identity mismatch means every application would be filed under the wrong candidate's name. Three of four advertised sources are unverified. And the entire implementation has no commit history.

**Conditions for approval:**

1. `dryRun` propagated to all handlers and guards added to Workday, Zoho, genericATS, and NaukriNative
2. `profile.json` aligned with the actual intended candidate
3. All new code committed to git with structured history
4. `whatsapp:watch` npm script fixed with a proper entry point
5. Shared browser page architecture fixed (separate pages per source)
6. At least one live smoke test per source confirming browser initialization

None of these require significant rework. They are targeted fixes to a structurally correct system. The implementation is approximately 70% of the way to being production-safe. The remaining 30% are correctness and safety issues, not design problems.

---

*End of audit report. Generated 2026-09-10. Repository state: `a9e1803` + uncommitted working tree.*
