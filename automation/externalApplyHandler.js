const { getAnswer } = require('../ai/answerEngine');
const { loadResume } = require('../ai/prompts');
const { randomDelay } = require('./utils');
const profile = require('../config/profile');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const { confirmAndExecuteSubmission } = require('../application/safetyBoundary');

/**
 * Safely matches an answer string against an array of option strings.
 * Avoids short substring collisions (e.g. 'No' matching 'Technology').
 */
function matchOption(options, ans) {
    if (!ans || !options || options.length === 0) return null;
    const cleanAns = ans.trim().toLowerCase();

    // 1. Exact match
    const exact = options.find(o => o.trim().toLowerCase() === cleanAns);
    if (exact) return exact;

    // 2. Strict word-boundary match (e.g. "Yes" in "Yes, I am authorized")
    const wordBoundary = options.find(o => {
        const escaped = cleanAns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(o.trim());
    });
    if (wordBoundary) return wordBoundary;

    // 3. Substring match ONLY if answer is at least 4 characters long
    if (cleanAns.length >= 4) {
        const sub = options.find(o => o.toLowerCase().includes(cleanAns) || cleanAns.includes(o.toLowerCase()));
        if (sub) return sub;
    }

    return null;
}

/**
 * Helper to safely fill an input field if it exists, is visible, and is currently empty.
 * Supports both standard CSS selectors and label-based lookup for ATS platforms with dynamic IDs (e.g. Zoho Recruit, Workday).
 */
async function fillFieldIfEmpty(scope, selectors, value, fieldLabel = '', labelAliases = []) {
    if (!value) return false;

    // 1. Try standard CSS selectors
    for (const selector of selectors) {
        try {
            const loc = scope.locator(selector).first();
            if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
                const currentVal = await loc.inputValue().catch(() => '');
                if (!currentVal || currentVal.trim() === '') {
                    await loc.scrollIntoViewIfNeeded().catch(() => {});
                    await loc.fill(String(value));
                    await loc.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true }))).catch(() => {});
                    await loc.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});
                    console.log(chalk.green(`    -> Filled ${fieldLabel || 'field'}: "${value}"`));
                    return true;
                } else {
                    return true; // already filled
                }
            }
        } catch (_) {}
    }

    // 2. Try label-based lookup (e.g. Zoho Recruit, Workday, custom ATS with generated IDs)
    const labelsToCheck = [fieldLabel, ...labelAliases].filter(Boolean);
    for (const lbl of labelsToCheck) {
        try {
            const labelLoc = scope.locator(`label:has-text("${lbl}")`).first();
            if (await labelLoc.isVisible({ timeout: 800 }).catch(() => false)) {
                const forId = await labelLoc.getAttribute('for').catch(() => '');
                let inp = forId ? scope.locator(`#${forId}`).first() : null;
                if (!inp || !(await inp.isVisible().catch(() => false))) {
                    inp = labelLoc.locator('..').locator('input:not([type="hidden"]), textarea').first();
                }
                if (inp && (await inp.isVisible().catch(() => false))) {
                    const currentVal = await inp.inputValue().catch(() => '');
                    if (!currentVal || currentVal.trim() === '') {
                        await inp.scrollIntoViewIfNeeded().catch(() => {});
                        await inp.fill(String(value));
                        await inp.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true }))).catch(() => {});
                        await inp.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});
                        console.log(chalk.green(`    -> Filled ${fieldLabel || lbl} (by label): "${value}"`));
                        return true;
                    } else {
                        return true;
                    }
                }
            }
        } catch (_) {}
    }

    return false;
}

/**
 * Checks if the external site presents an authentication/login gate before allowing application.
 */
async function checkLoginWall(page) {
    if (!page) return false;
    try {
        return await page.evaluate(() => {
            const bodyText = document.body?.innerText?.toLowerCase() || '';
            const hasPasswordField = !!document.querySelector('input[type="password"]');
            
            const hasLoginRegistrationHeader = bodyText.includes('login / registration') ||
                                               bodyText.includes('login/registration') ||
                                               bodyText.includes('already registered?') ||
                                               bodyText.includes('create an account to apply') ||
                                               bodyText.includes('create an account using any of the following') ||
                                               bodyText.includes('sign in to your account') ||
                                               bodyText.includes('sign in to apply') ||
                                               bodyText.includes('log in to apply') ||
                                               bodyText.includes('login to apply');

            const hasSignIn = bodyText.includes('sign in') || bodyText.includes('log in') || bodyText.includes('login') || bodyText.includes('create an account to apply');
            const hasEmailField = !!document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]');

            const hasAuthButton = !!Array.from(document.querySelectorAll('button, a, input[type="submit"]')).some(el => {
                const txt = (el.innerText || el.value || '').trim().toLowerCase();
                return /^(log\s*in|sign\s*in|login|signin|create\s*an?\s*account|register)$/i.test(txt) && el.offsetParent !== null;
            });

            // 1. Definite match: Password field present + any sign in / login / register text or auth button
            if (hasPasswordField && (hasSignIn || hasAuthButton || hasLoginRegistrationHeader)) {
                return true;
            }

            // 2. Stepper / Header match: Explicit "Login / Registration" or "Already registered?"
            if (hasLoginRegistrationHeader && (hasPasswordField || hasAuthButton || hasEmailField)) {
                return true;
            }

            // 3. Fallback: classic check (hasSignIn && hasPasswordField && hasEmailField)
            if (hasSignIn && hasPasswordField && hasEmailField) {
                return true;
            }

            return false;
        }).catch(() => false);
    } catch (_) {
        return false;
    }
}

/**
 * Attempts to bypass a login/registration wall by clicking guest or self-complete buttons.
 * Many ATS portals (Phenom People / Siemens, Workday, etc.) offer a guest path alongside login.
 * Returns true if a bypass was found and clicked, false otherwise.
 */
async function tryLoginWallBypass(page) {
    if (!page) return false;
    try {
        console.log(chalk.cyan('  Scanning for guest/self-complete bypass options...'));

        // 1. Try specific known IDs first (e.g. Phenom People / Siemens)
        const knownBypassIds = [
            '#methodButton--later',      // Siemens / Phenom People "Self-complete"
            '#methodButton--file',       // Siemens / Phenom People "Upload file"
            '#guest-apply-button',       // Generic guest apply
            '#apply-as-guest',           // Generic guest apply
            '#continueWithoutAccount',   // Generic continue without account
        ];

        for (const sel of knownBypassIds) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
                const txt = await btn.innerText().catch(() => sel);
                console.log(chalk.green(`  ✔ Found login wall bypass button: "${txt.trim()}" (${sel}). Clicking to skip login...`));
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ force: true });
                await randomDelay(2000, 3500);
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                return true;
            }
        }

        // 2. Try text-based selectors for common guest/bypass patterns
        const bypassTextPatterns = [
            'button:has-text("Self-complete")',
            'a:has-text("Self-complete")',
            'button:has-text("self complete")',
            'button:has-text("Apply as guest")',
            'a:has-text("Apply as guest")',
            'button:has-text("Apply as Guest")',
            'a:has-text("Apply as Guest")',
            'button:has-text("Guest")',
            'button:has-text("Continue without account")',
            'a:has-text("Continue without account")',
            'button:has-text("Continue as guest")',
            'a:has-text("Continue as guest")',
            'button:has-text("Skip")',
            'button:has-text("Upload file")',
            'a:has-text("Upload file")',
            'button:has-text("Apply without login")',
            'a:has-text("Apply without login")',
            'button:has-text("Apply without signing in")',
            'a:has-text("Apply without signing in")',
            'button:has-text("Quick Apply")',
            'a:has-text("Quick Apply")',
        ];

        for (const sel of bypassTextPatterns) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                const txt = await btn.innerText().catch(() => sel);
                console.log(chalk.green(`  ✔ Found login wall bypass: "${txt.trim()}". Clicking to skip login...`));
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ force: true });
                await randomDelay(2000, 3500);
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                return true;
            }
        }

        // 3. Heuristic: scan all visible buttons/links for guest-like text
        const bypassed = await page.evaluate(() => {
            const guestRegex = /^(self[\s-]?complete|apply\s+as\s+guest|continue\s+without|continue\s+as\s+guest|skip\s+login|upload\s+file|quick\s+apply|apply\s+without)/i;
            const els = document.querySelectorAll('button, a, [role="button"]');
            for (const el of els) {
                if (el.offsetParent === null) continue; // skip hidden
                const txt = (el.innerText || el.textContent || '').trim();
                if (guestRegex.test(txt)) {
                    el.click();
                    return txt;
                }
            }
            return null;
        }).catch(() => null);

        if (bypassed) {
            console.log(chalk.green(`  ✔ Login wall bypassed via heuristic match: "${bypassed}"`));
            await randomDelay(2000, 3500);
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            return true;
        }

        console.log(chalk.gray('  No guest/bypass options detected on page.'));
        return false;
    } catch (_) {
        return false;
    }
}

/**
 * Waits for portal page to stabilize and render form or authentication elements after clicking Apply.
 */
async function waitForPortalState(page, timeoutMs = 6000) {
    if (!page) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const isReady = await page.evaluate(() => {
            const hasPassword = !!document.querySelector('input[type="password"]');
            const hasFile = !!document.querySelector('input[type="file"]');
            const hasNameOrEmail = !!document.querySelector('input[name*="name" i], input[type="email"]');
            const hasAuthBtn = Array.from(document.querySelectorAll('button, a')).some(b => /^(log\s*in|sign\s*in|apply\s*now|upload\s*file)/i.test((b.innerText || '').trim()));
            return hasPassword || hasFile || hasNameOrEmail || hasAuthBtn;
        }).catch(() => false);

        if (isReady) break;
        await page.waitForTimeout(500);
    }
}

/**
 * Handles Account Creation or Login Wall via human-in-the-loop intervention.
 */
async function handleLoginWallIntervention(page, job = {}, options = {}, stepDescription = '') {
    console.log(chalk.yellow.bold(`\n============================================================`));
    console.log(chalk.yellow.bold(`🔐 ACCOUNT CREATION / SIGN-IN REQUIRED`));
    console.log(chalk.yellow(`  Portal: ${job.company || 'Employer'} (${job.title || 'Job'})`));
    if (stepDescription) {
        console.log(chalk.gray(`  Current Stage: ${stepDescription}`));
    }
    console.log(chalk.yellow(`  Action: Please log in or create an account in the visible browser window.`));
    console.log(chalk.yellow.bold(`============================================================\n`));

    const { promptHumanIntervention } = require('../ai/humanIntervention');
    const interventionRes = await promptHumanIntervention({
        question: `The career portal for ${job.company || 'the employer'} requires account creation or login${stepDescription ? ` (${stepDescription})` : ''}. Please log in or create an account in the open browser window, then press Enter (or type "done") to resume.`,
        type: 'action',
        options: [],
        job,
        reason: 'Candidate authentication or registration required on destination portal.',
        promptFn: options.promptFn,
        isInteractive: options.isInteractive
    });

    if (!interventionRes.answered) {
        console.log(chalk.yellow('  ⚠️ Human intervention for account creation / login was not completed.'));
        return {
            cleared: false,
            result: {
                status: 'SKIPPED',
                reason: 'NEEDS_HUMAN_INTERVENTION',
                message: 'External site requires account creation / login and human intervention was not completed',
                externalUrl: page.url()
            }
        };
    }

    // After user completes login, wait for browser navigation/redirection
    console.log(chalk.green('  Waiting for post-login page load & navigation...'));
    await randomDelay(3000, 5000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // Inspect all open tabs in case login opened or redirected to a new tab
    let activePage = page;
    if (page.context && typeof page.context().pages === 'function') {
        const pages = page.context().pages();
        for (const p of pages) {
            const u = p.url().toLowerCase();
            if (p !== page && !u.includes('about:blank') && !u.includes('whatsapp.com')) {
                activePage = p;
                await activePage.waitForLoadState('domcontentloaded').catch(() => {});
                console.log(chalk.cyan(`  Switched active application context to tab: ${activePage.url()}`));
                break;
            }
        }
    }

    // Re-check if login wall is cleared
    const stillBlocked = await checkLoginWall(activePage);
    if (stillBlocked) {
        console.log(chalk.yellow('  ⚠️ Login/Registration wall still detected in browser. Waiting 3s for redirect...'));
        await randomDelay(2500, 3500);
        if (await checkLoginWall(activePage)) {
            console.log(chalk.red('  ❌ Login wall still active after human intervention.'));
            return {
                cleared: false,
                page: activePage,
                result: {
                    status: 'SKIPPED',
                    reason: 'NEEDS_HUMAN_INTERVENTION',
                    message: 'External site still requires login after human intervention',
                    externalUrl: activePage.url()
                }
            };
        }
    }

    console.log(chalk.green.bold('  ✔ Account creation / login verified! Resuming application flow...'));
    return {
        cleared: true,
        page: activePage
    };
}

/**
 * Checks if application page currently exhibits concrete post-submission confirmation evidence.
 */
async function checkSubmissionConfirmation(page) {
    if (!page) return { isVerified: false };
    try {
        const finalUrl = page.url();
        const pageContent = await page.content().catch(() => '');
        let urlPath = '';
        try {
            urlPath = new URL(finalUrl).pathname.toLowerCase();
        } catch {
            urlPath = finalUrl.toLowerCase();
        }
        const isSuccessUrl = /\/(thank[-_]?you|application[-_]complete|submitted|confirmation)(\/|$)/i.test(urlPath);
        const isSuccessText = /(your application has been (submitted|received)|application successfully submitted|thank you for (applying|your application)|we have received your application)/i.test(pageContent);
        const hasConfirmationId = await page.evaluate(() => {
            const text = document.body ? document.body.innerText : '';
            return /(application|reference|candidate)\s*(id|number|#)\s*[:#-]?\s*[a-z0-9-]+/i.test(text);
        }).catch(() => false);

        return {
            isVerified: isSuccessUrl || isSuccessText || hasConfirmationId,
            isSuccessUrl,
            isSuccessText,
            hasConfirmationId,
            finalUrl
        };
    } catch (_) {
        return { isVerified: false };
    }
}

/**
 * Checks if the external site presents a CAPTCHA or security challenge.
 */
async function checkCaptcha(page) {
    return await page.evaluate(() => {
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const hasCaptchaText = bodyText.includes('recaptcha') || bodyText.includes('hcaptcha') || bodyText.includes('cf-turnstile') || bodyText.includes('verify you are human') || bodyText.includes('security check');
        const hasCaptchaIframe = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
        const hasCaptchaElement = !!document.querySelector('.g-recaptcha, .h-captcha, #cf-turnstile, [class*="captcha"]');
        return hasCaptchaIframe || hasCaptchaElement || (hasCaptchaText && (bodyText.includes('unusual traffic') || bodyText.includes('robot')));
    }).catch(() => false);
}

/**
 * Expands collapsible/accordion sections commonly found on modern ATS platforms
 * (e.g. SAP SuccessFactors Career Site Builder, Workday, custom portals)
 */
/**
 * Automatically detects and expands all accordion sections on the page.
 * Supports:
 * - Global expand buttons (e.g. "Expand all sections", "Expand all")
 * - Bootstrap, CSB, and custom collapsed elements ([aria-expanded="false"], .collapsed)
 * - Section headers (My Documents, Profile, Experience, Education)
 */
async function expandAllSections(page) {
    let expandedCount = 0;
    try {
        // 1. Click global expand buttons if present
        const expandButtons = [
            'a:has-text("Expand all sections")',
            'button:has-text("Expand all sections")',
            'a:has-text("Expand all")',
            'button:has-text("Expand all")',
            '[id*="expandAll" i]',
            '[class*="expandAll" i]'
        ];
        for (const sel of expandButtons) {
            const loc = page.locator(sel);
            const btn = loc && typeof loc.first === 'function' ? loc.first() : null;
            if (btn && await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                console.log(chalk.cyan(`  Expanding all accordion sections via "${sel}"...`));
                await btn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(1000);
                return { expanded: true, count: 1, type: 'global' };
            }
        }

        // 2. Expand individual collapsed sections and section headers
        const collapsedSections = await page.locator(
            '[aria-expanded="false"], .collapsed, .accordion-toggle.collapsed, .panel-heading.collapsed, button.accordion-button.collapsed, summary, button:has-text("My Documents"), button:has-text("Profile"), button:has-text("Experience"), button:has-text("Education")'
        ).all();

        if (collapsedSections.length > 0) {
            console.log(chalk.cyan(`  Expanding ${collapsedSections.length} collapsed section(s)...`));
            for (const section of collapsedSections) {
                if (await section.isVisible().catch(() => false)) {
                    await section.click({ force: true }).catch(() => {});
                    expandedCount++;
                    await page.waitForTimeout(300);
                }
            }
            return { expanded: expandedCount > 0, count: expandedCount, type: 'individual' };
        }
    } catch (_) {}
    return { expanded: false, count: 0, type: 'none' };
}

/**
 * Robust, generic FileUpload capability.
 * Supports:
 * - Direct input[type="file"] (including hidden inputs)
 * - Custom upload buttons / cards (e.g. SuccessFactors CSB "Upload a Resume", Workday, custom ATS)
 * - Playwright filechooser events
 * - Verification that the resume was actually attached in the DOM
 */
async function attachResumeSafely(targetScope, page, selectedResume, options = {}, job = {}) {
    console.log(chalk.blue('  Attaching resume file...'));
    let resumeAttached = false;

    if (!selectedResume || !selectedResume.path || !fs.existsSync(selectedResume.path)) {
        console.log(chalk.red('  ❌ Selected resume file does not exist on disk.'));
        return { success: false, verified: false, reason: 'RESUME_FILE_MISSING' };
    }

    const resumePath = selectedResume.path;
    const resumeFileName = selectedResume.fileName || path.basename(resumePath);
    const resumeBaseName = path.basename(resumePath, path.extname(resumePath));

    // 1. Try standard / hidden file inputs
    const fileInputs = await targetScope.locator('input[type="file"]').all();
    if (fileInputs.length > 0) {
        let targetFileInput = fileInputs[0];
        for (const fi of fileInputs) {
            const html = await fi.evaluate(e => `${e.name} ${e.id} ${e.getAttribute('aria-label') || ''} ${e.className}`).catch(() => '');
            if (/resume|cv|document|attachment/i.test(html)) {
                targetFileInput = fi;
                break;
            }
        }
        try {
            await targetFileInput.setInputFiles(resumePath);
            console.log(chalk.cyan(`    -> Set input files on file input element.`));
            await randomDelay(1500, 2500);
            resumeAttached = true;
        } catch (err) {
            console.log(chalk.yellow(`    ⚠️ direct setInputFiles failed: ${err.message}`));
        }
    }

    // 2. If no file input or setInputFiles didn't succeed, try custom upload triggers (cards, buttons, icons)
    if (!resumeAttached) {
        const customUploadSelectors = [
            'button:has-text("Upload Resume")',
            'button:has-text("Upload a Resume")',
            'button:has-text("Upload CV")',
            'button:has-text("Attach Resume")',
            'button:has-text("Choose File")',
            'button:has-text("Browse")',
            'a:has-text("Upload a Resume")',
            'a:has-text("Upload Resume")',
            'div:has-text("Upload a Resume")',
            'label:has-text("Upload a Resume")',
            'label:has-text("Upload Resume")',
            'label:has-text("Attach Resume")',
            '[data-qa="upload-resume"]',
            '[class*="uploadCard" i]',
            '[class*="upload-card" i]',
            '[class*="resume-upload" i]'
        ];

        for (const sel of customUploadSelectors) {
            const trigger = targetScope.locator(sel).first();
            if (await trigger.isVisible({ timeout: 800 }).catch(() => false)) {
                // Ignore navbar / header / search elements that are not part of an upload form
                const inNavOrHeader = (typeof trigger.evaluate === 'function')
                    ? await trigger.evaluate(el => Boolean(el.closest('header, nav, [role="navigation"]'))).catch(() => false)
                    : false;
                if (inNavOrHeader) {
                    continue;
                }
                if (sel.includes('Browse') && typeof trigger.innerText === 'function') {
                    const txt = await trigger.innerText().catch(() => '');
                    if (/jobs?|categories|locations?|search|all/i.test(txt)) {
                        continue;
                    }
                }

                console.log(chalk.cyan(`    -> Detected custom upload trigger: "${sel}". Waiting for filechooser...`));
                try {
                    const [fileChooser] = await Promise.all([
                        page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null),
                        trigger.click({ force: true }).catch(() => {})
                    ]);

                    if (fileChooser) {
                        await fileChooser.setFiles(resumePath);
                        console.log(chalk.cyan('    -> Handled filechooser event for custom upload button.'));
                        await randomDelay(1500, 2500);
                        resumeAttached = true;
                        break;
                    }
                } catch (err) {
                    console.log(chalk.yellow(`    ⚠️ custom upload trigger failed: ${err.message}`));
                }
            }
        }
    }

    // 3. Post-upload verification in DOM
    const verifyAttachment = async () => {
        return await targetScope.evaluate(({ fileName, baseName }) => {
            const bodyText = document.body ? document.body.innerText : '';
            if (bodyText.includes(fileName) || bodyText.includes(baseName)) return true;

            const inputs = document.querySelectorAll('input[type="file"]');
            for (const inp of inputs) {
                if (inp.files && inp.files.length > 0) return true;
            }

            const deleteBtns = document.querySelectorAll('button, a, span, div');
            for (const el of deleteBtns) {
                const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
                const cls = (el.className || '').toLowerCase();
                if ((txt.includes('delete') || txt.includes('remove') || cls.includes('uploaded-file') || cls.includes('file-chip')) && el.offsetParent !== null) {
                    return true;
                }
            }
            return false;
        }, { fileName: resumeFileName, baseName: resumeBaseName }).catch(() => false);
    };

    let verified = await verifyAttachment();

    // 4. If not verified, invoke Human Intervention
    if (!verified) {
        console.log(chalk.yellow('  ⚠️ Resume attachment could not be verified automatically. Prompting human intervention...'));
        const { promptHumanIntervention } = require('../ai/humanIntervention');
        const interventionRes = await promptHumanIntervention({
            question: `Please attach the candidate resume ("${resumeFileName}") in the browser window, then press Enter to resume.`,
            type: 'action',
            job,
            reason: 'Resume upload could not be verified automatically.',
            promptFn: options.promptFn,
            isInteractive: options.isInteractive
        });

        if (interventionRes.answered) {
            await randomDelay(1500, 2500);
            verified = await verifyAttachment();
            if (!verified) {
                verified = true; // User confirmed action completed
            }
        }
    }

    if (verified) {
        console.log(chalk.green.bold(`  ✔ Verified attached resume: "${resumeFileName}"`));
        return { success: true, verified: true, fileName: resumeFileName };
    } else {
        console.log(chalk.red(`  ❌ Could not verify resume attachment on application page.`));
        return { success: false, verified: false, fileName: resumeFileName, reason: 'RESUME_NOT_VERIFIED' };
    }
}

/**
 * Resolves only verified profile facts or cached human answers for dropdowns.
 * Strictly guarantees that Ollama or LLMs are NEVER invoked to guess dropdown options.
 */
function getTrustedDropdownAnswer(labelText, optionTexts = [], sectionContext = '', customProfile = null) {
    try {
        const { resolveCandidateFact, matchAtsOption } = require('../ai/candidateFacts');
        const { findCachedAnswer } = require('../ai/answerEngine');

        // 1. Primary: Canonical Candidate Profile Fact
        const canonical = resolveCandidateFact(labelText, sectionContext, customProfile);
        if (canonical && canonical.resolved && canonical.answer) {
            if (optionTexts && optionTexts.length > 0) {
                const matchRes = matchAtsOption(optionTexts, canonical.answer, labelText);
                if (matchRes.matched && matchRes.selectedOption) {
                    return matchRes.selectedOption;
                }
                return null;
            }
            return canonical.answer;
        }

        // Strict Invariant: If Immigration Status or Compensation Type is absent from canonical profile,
        // it MUST remain HUMAN_INTERVENTION and NEVER fall back to old cached text answers.
        const labelLower = (labelText || '').toLowerCase();
        if (
            /\b(immigration|visa status|immigration status)\b/i.test(labelLower) ||
            /\b(compensation.*type|type.*compensation|salary.*type|ctc.*type)\b/i.test(labelLower)
        ) {
            return null;
        }

        // 2. Secondary: Previously verified human answer store (cache)
        const cached = findCachedAnswer ? findCachedAnswer(labelText, optionTexts) : null;
        if (cached) {
            if (optionTexts && optionTexts.length > 0) {
                const matchRes = matchAtsOption(optionTexts, cached, labelText);
                if (matchRes.matched && matchRes.selectedOption) {
                    return matchRes.selectedOption;
                }
                return null;
            }
            return cached;
        }
    } catch (_) {}
    return null;
}

/**
 * Universal dropdown handler supporting:
 * - Native <select>
 * - [role="combobox"]
 * - [role="listbox"]
 * - button[aria-haspopup="listbox"]
 * - custom styled dropdowns
 * Strict zero-guessing invariant: If no trusted answer exists, prompts human intervention.
 */
async function handleDropdowns(targetScope, page, options = {}, job = {}) {
    const { promptHumanIntervention, saveHumanVerifiedAnswer } = require('../ai/humanIntervention');
    const { resolveCandidateFact, matchAtsOption } = require('../ai/candidateFacts');
    const { findCachedAnswer } = require('../ai/answerEngine');

    // 1. Handle Native <select>
    const selects = await targetScope.locator('select').all();
    for (const sel of selects) {
        try {
            if (!(await sel.isVisible().catch(() => false))) continue;
            const currentVal = await sel.inputValue().catch(() => '');
            if (currentVal && currentVal !== '0' && currentVal !== '') continue;

            const evalResult = await sel.evaluate(el => {
                const id = el.id;
                const label = id ? document.querySelector(`label[for="${id}"]`) : null;
                const lText = (label?.innerText || el.closest('label, .form-group, .field')?.querySelector('label, span, p')?.innerText || el.name || '').trim();

                let sText = '';
                const fieldset = el.closest('fieldset');
                if (fieldset?.querySelector('legend')?.innerText?.trim()) {
                    sText = fieldset.querySelector('legend').innerText.trim();
                } else {
                    const accordion = el.closest('.accordion-item, .panel, .section, [class*="section"], [class*="accordion"], [class*="card"]');
                    if (accordion) {
                        const hdr = accordion.querySelector('.accordion-header, .panel-heading, [class*="header"], [class*="title"], h2, h3, h4');
                        if (hdr?.innerText?.trim()) sText = hdr.innerText.trim();
                    }
                }
                return { labelText: lText, sectionText: sText };
            }).catch(() => ({ labelText: '', sectionText: '' }));

            const labelText = (typeof evalResult === 'object' && evalResult !== null ? evalResult.labelText : String(evalResult || '')).trim();
            const sectionText = (typeof evalResult === 'object' && evalResult !== null ? evalResult.sectionText : '').trim();

            const optionElements = await sel.locator('option').all();
            const optionTexts = [];
            for (const opt of optionElements) {
                const t = (await opt.innerText().catch(() => '')).trim();
                if (t && !t.toLowerCase().includes('select') && !t.toLowerCase().includes('choose')) {
                    optionTexts.push(t);
                }
            }

            if (optionTexts.length > 0 && labelText) {
                console.log(chalk.cyan(`  Answering dropdown: "${labelText}" ${sectionText ? `(Section: "${sectionText}")` : ''} (Options: ${optionTexts.slice(0, 4).join(', ')}...)`));
                // Zero-guessing rule: only check trusted facts and cache, never invoke Ollama
                const ans = getTrustedDropdownAnswer(labelText, optionTexts, sectionText);
                let selectedOption = null;

                if (ans) {
                    const matchRes = matchAtsOption(optionTexts, ans, labelText);
                    selectedOption = matchRes.selectedOption || ans;
                }

                // If system does NOT know the answer: PROMPT HUMAN INTERVENTION (No guessing)
                if (!selectedOption) {
                    console.log(chalk.yellow(`  ⚠️ No trusted answer for dropdown "${labelText}". Prompting human intervention...`));
                    const interventionRes = await promptHumanIntervention({
                        question: `Please select an answer for "${labelText}":`,
                        type: 'dropdown',
                        options: optionTexts,
                        job,
                        reason: 'Unknown dropdown answer. Zero guessing rule active.',
                        promptFn: options.promptFn,
                        isInteractive: options.isInteractive
                    });
                    if (interventionRes.answered && interventionRes.value) {
                        const humanMatch = matchAtsOption(optionTexts, interventionRes.value, labelText);
                        selectedOption = humanMatch.selectedOption || interventionRes.value;
                        const canonicalFact = resolveCandidateFact(labelText, sectionText);
                        if (!canonicalFact.resolved) {
                            saveHumanVerifiedAnswer(labelText, selectedOption, true);
                        }
                    }
                }

                if (selectedOption) {
                    console.log(chalk.green(`    -> Selected dropdown option: "${selectedOption}"`));
                    await sel.selectOption({ label: selectedOption }).catch(async () => {
                        await sel.selectOption(selectedOption).catch(() => {});
                    });
                    await sel.dispatchEvent('change').catch(() => {});
                    await page.waitForTimeout(300).catch(() => {});
                }
            }
        } catch (_) {}
    }

    // 2. Handle Custom Comboboxes & Accessible Dropdowns
    const comboboxSelectors = [
        '[role="combobox"]',
        'button[aria-haspopup="listbox"]',
        'button[aria-haspopup="true"]',
        '.select2-selection',
        '.dropdown-toggle',
        '.custom-select',
        'div[aria-expanded]'
    ];

    const comboboxes = await targetScope.locator(comboboxSelectors.join(', ')).all();
    for (const combo of comboboxes) {
        try {
            if (!(await combo.isVisible().catch(() => false))) continue;
            const currentText = (await combo.innerText().catch(() => '')) || (await combo.getAttribute('value').catch(() => '')) || '';
            if (currentText && !/select|choose|--/i.test(currentText)) continue; // already chosen

            const comboEval = await combo.evaluate(el => {
                const id = el.id;
                const label = id ? document.querySelector(`label[for="${id}"]`) : null;
                const ariaLabel = el.getAttribute('aria-label') || '';
                const lText = (label?.innerText || ariaLabel || el.closest('label, .form-group, .field')?.querySelector('label, span, p')?.innerText || '').trim();

                let sText = '';
                const fieldset = el.closest('fieldset');
                if (fieldset?.querySelector('legend')?.innerText?.trim()) {
                    sText = fieldset.querySelector('legend').innerText.trim();
                } else {
                    const accordion = el.closest('.accordion-item, .panel, .section, [class*="section"], [class*="accordion"], [class*="card"]');
                    if (accordion) {
                        const hdr = accordion.querySelector('.accordion-header, .panel-heading, [class*="header"], [class*="title"], h2, h3, h4');
                        if (hdr?.innerText?.trim()) sText = hdr.innerText.trim();
                    }
                }
                return { labelText: lText, sectionText: sText };
            }).catch(() => ({ labelText: '', sectionText: '' }));

            const labelText = (typeof comboEval === 'object' && comboEval !== null ? comboEval.labelText : String(comboEval || '')).trim();
            const sectionText = (typeof comboEval === 'object' && comboEval !== null ? comboEval.sectionText : '').trim();

            if (!labelText || labelText.length < 2) continue;

            // 1. Resolve canonical fact first (using sectionContext)
            const canonicalFact = resolveCandidateFact(labelText, sectionText);
            const knownTarget = canonicalFact.resolved ? canonicalFact.answer : (findCachedAnswer ? findCachedAnswer(labelText) : null);

            // Open the dropdown
            await combo.scrollIntoViewIfNeeded().catch(() => {});
            await combo.click().catch(() => {});
            await page.waitForTimeout(600);

            // Check if there is an active search input (SuccessFactors CSB, Select2, Workday, etc.)
            let searchInput = null;
            const isComboInput = (await combo.evaluate(el => el.tagName).catch(() => '')) === 'INPUT';
            if (isComboInput) {
                searchInput = combo;
            } else {
                const potentialSearch = page.locator('input[role="searchbox"], input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i], input.select2-search__field, input.dropdown-search, .dropdown-menu input, [role="combobox"] input').first();
                if (await potentialSearch.isVisible({ timeout: 500 }).catch(() => false)) {
                    searchInput = potentialSearch;
                }
            }

            // If combobox is searchable and canonical answer is known, type canonical answer to filter options!
            if (searchInput && knownTarget) {
                console.log(chalk.cyan(`    -> Combobox "${labelText}" is searchable. Filtering with canonical answer: "${knownTarget}"...`));
                await searchInput.focus().catch(() => {});
                await searchInput.fill(knownTarget).catch(() => {});
                await searchInput.dispatchEvent('input').catch(() => {});
                await searchInput.dispatchEvent('keyup').catch(() => {});
                await page.waitForTimeout(600);
            }

            // Collect options (either filtered or all available)
            const optionLocators = await page.locator('[role="option"], ul.dropdown-menu li, .select-options div, .dropdown-item, .select2-results__option').all();
            const optionTexts = [];
            const optionMap = [];

            for (const opt of optionLocators) {
                if (await opt.isVisible().catch(() => false)) {
                    const t = (await opt.innerText().catch(() => '')).trim();
                    if (t && !/select|choose/i.test(t)) {
                        optionTexts.push(t);
                        optionMap.push({ text: t, locator: opt });
                    }
                }
            }

            if (optionTexts.length > 0) {
                console.log(chalk.cyan(`  Answering custom combobox: "${labelText}" (Options: ${optionTexts.slice(0, 4).join(', ')}...)`));
                
                let selectedOption = null;

                // A. Deterministic profile / cache resolution
                if (knownTarget) {
                    const matchRes = matchAtsOption(optionTexts, knownTarget, labelText);
                    if (matchRes.matched && matchRes.selectedOption) {
                        selectedOption = matchRes.selectedOption;
                        console.log(chalk.green(`  ✔ Automatically matched canonical answer "${knownTarget}" -> "${selectedOption}"`));
                    }
                }

                // B. If deterministic matching fails: prompt human intervention (accepts both number and text)
                if (!selectedOption) {
                    console.log(chalk.yellow(`  ⚠️ No trusted answer for combobox "${labelText}". Prompting human intervention...`));
                    const interventionRes = await promptHumanIntervention({
                        question: `Please select an answer for "${labelText}":`,
                        type: 'dropdown',
                        options: optionTexts,
                        job,
                        reason: 'Unknown combobox answer. Zero guessing rule active.',
                        promptFn: options.promptFn,
                        isInteractive: options.isInteractive
                    });
                    if (interventionRes.answered && interventionRes.value) {
                        const humanMatch = matchAtsOption(optionTexts, interventionRes.value, labelText);
                        selectedOption = humanMatch.selectedOption || interventionRes.value;
                        if (!canonicalFact.resolved) {
                            saveHumanVerifiedAnswer(labelText, selectedOption, true);
                        }
                    }
                }

                if (selectedOption) {
                    const targetOpt = optionMap.find(o => o.text === selectedOption);
                    if (targetOpt) {
                        console.log(chalk.green(`    -> Selected combobox option: "${selectedOption}"`));
                        await targetOpt.locator.click().catch(() => {});
                        await page.waitForTimeout(400);
                    }
                }
            }
        } catch (_) {}
    }
}

/**
 * Dedicated handler for Zoho Recruit ATS forms (e.g. Kumaran Systems, Zoho Recruit hosted portals)
 */
async function handleZohoRecruitApplication(page, job, selectedResume, options = {}) {
    const dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    console.log(chalk.magenta.bold('  🎯 Detected Zoho Recruit ATS! Running specialized Zoho Recruit automation flow...'));

    // 1. Accept cookies banner if present
    const cookieBtn = page.locator('career-cookie-consent button.cookie-accept-btn, career-cookie-consent button:has-text("Accept all"), button.cookie-accept-btn, button:has-text("Accept all"), button:has-text("Accept All"), button:has-text("Accept cookies")').first();
    if (await cookieBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        console.log(chalk.blue('  Accepting cookies banner...'));
        await cookieBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
    }

    // 2. Click "I'm interested" / Apply trigger if on landing view
    const interestedBtn = page.locator('button:has-text("I\'m interested"), a:has-text("I\'m interested"), text=/I.m interested/i').first();
    if (await interestedBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
        console.log(chalk.blue('  Clicking "I\'m interested" button...'));
        await interestedBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(3000);
    }

    // Wait for the form container or inputs to mount
    await page.waitForSelector('rec-form-component, portal-manual-apply, input[name*="rec-form_"], [data-zcqa*="First_Name" i], .crc-form-row', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Helper to find and set input by visible label
    const fillByLabel = async (labelText, value) => {
        return await page.evaluate(({ labelText, value }) => {
            const labels = Array.from(document.querySelectorAll('label, .crm-from-label, span.crc-label-text, .cw-section-title'));
            const match = labels.find(l => l.innerText?.toLowerCase().includes(labelText.toLowerCase()));
            if (!match) return false;
            let container = match.closest('.crc-form-row, .rec-form-row') || match.parentElement;
            const input = container?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="file"]), textarea');
            if (input) {
                input.focus();
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        }, { labelText, value }).catch(() => false);
    };

    // 3. Attach Resume to the designated file input (Zoho typically has easy-resume at index 0 and standard application attachment at index 1)
    await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
    const fileInputs = await page.locator('input[type="file"]').all();
    console.log(chalk.blue(`  Found ${fileInputs.length} file upload inputs...`));
    if (fileInputs.length > 1) {
        await fileInputs[1].setInputFiles(selectedResume.path);
        console.log(chalk.green(`  ✔ Attached resume to application attachment input: "${selectedResume.fileName}"`));
    } else if (fileInputs.length > 0) {
        await fileInputs[0].setInputFiles(selectedResume.path);
        console.log(chalk.green(`  ✔ Attached resume: "${selectedResume.fileName}"`));
    }
    await page.waitForTimeout(1000);

    // 4. Fill standard Crux / Lyte form fields
    const textFields = [
        { key: 'First_Name', nameKey: '3149', val: profile.firstName || profile.fullName.split(' ')[0] },
        { key: 'Last_Name', nameKey: '3151', val: profile.lastName || (profile.fullName || '').split(' ').slice(1).join(' ') },
        { key: 'Email', nameKey: '3155', val: profile.email || '' },
        { key: 'Total_Years_Of_Experience', nameKey: '3179', val: String(profile.experience || '1') },
        { key: 'Experience_in_Years', nameKey: '3179', val: String(profile.experience || '1') },
        { key: 'Relevant_Years_Of_Experience', nameKey: '3179', val: String(profile.experience || '1') },
        { key: 'Current_Employer', nameKey: 'employer', val: profile.currentCompany || '' },
        { key: 'Current_Salary', nameKey: '3199', val: profile.currentCTC || '0' },
        { key: 'Expected_Salary', nameKey: '3197', val: profile.expectedCTC || '800000' }
    ];

    for (const tf of textFields) {
        let filled = false;
        // Direct name match e.g. input[name*="3149"] or zcqa
        const comp = page.locator(`input[name*="${tf.nameKey}"], [data-zcqa*="${tf.key}" i], [cx-prop-label*="${tf.key}" i]`).first();
        if (await comp.isVisible({ timeout: 600 }).catch(() => false)) {
            const inp = (await comp.evaluate(el => el.tagName).catch(() => '')) === 'INPUT' ? comp : comp.locator('input:not([type="hidden"])').first();
            if (await inp.isVisible({ timeout: 600 }).catch(() => false)) {
                await inp.fill(String(tf.val));
                await inp.evaluate(e => {
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
                console.log(chalk.green(`    -> Filled ${tf.key}: "${tf.val}"`));
                filled = true;
            }
        }
        if (!filled) {
            const labelKey = tf.key.replace(/_/g, ' ');
            const ok = await fillByLabel(labelKey, String(tf.val));
            if (ok) {
                console.log(chalk.green(`    -> Filled by label [${labelKey}]: "${tf.val}"`));
            }
        }
    }

    // Mobile Number (unique to Zoho schema 3161)
    const phoneInp = page.locator('input[name*="3161"], .crc-rec-form_23850000000003161 input.cxBorderBottom, [class*="3161"] input.cxBorderBottom, [data-zcqa*="Mobile" i] input.cxBorderBottom').first();
    if (await phoneInp.isVisible({ timeout: 1000 }).catch(() => false)) {
        const phoneVal = (profile.mobile || '').replace(/^\+91\s*/, '');
        await phoneInp.fill(phoneVal);
        await phoneInp.evaluate(e => {
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch(() => {});
        console.log(chalk.green(`    -> Filled Mobile: ${phoneVal}`));
    }

    // Address fields (sequential typing for Zoho combobox inputs)
    const streetVal = profile.address?.street || '';
    const cityVal = profile.address?.city || profile.currentLocation || '';
    const stateVal = profile.address?.state || '';
    const zipVal = profile.address?.zipCode || profile.postalCode || '';
    const countryVal = profile.address?.country || 'India';

    const addrSpecs = [
        { key: 'Street', val: streetVal },
        { key: 'City', val: cityVal },
        { key: 'State', val: stateVal },
        { key: 'Zip_Code', val: zipVal },
        { key: 'Country', val: countryVal }
    ];

    for (const a of addrSpecs) {
        const comp = page.locator(`[data-zcqa*="${a.key}" i]`).first();
        if (await comp.isVisible({ timeout: 600 }).catch(() => false)) {
            const inp = comp.locator('input').first();
            if (await inp.isVisible({ timeout: 600 }).catch(() => false)) {
                await inp.click();
                await inp.fill('');
                await inp.pressSequentially(a.val, { delay: 20 });
                await inp.evaluate(e => {
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
                console.log(chalk.green(`    -> Typed ${a.key}: "${a.val}"`));
            }
        }
    }

    // 5. Highest Qualification Held Dropdown
    const qualBtn = page.locator('[data-zcqa="manual_Highest_Qualification_Held"], lyte-dropdown[id*="3195"], lyte-dropdown:has-text("Highest Qualification")').first();
    if (await qualBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
        await qualBtn.scrollIntoViewIfNeeded().catch(() => {});
        await qualBtn.click();
        await page.waitForTimeout(500);

        const qualItem = page.locator('lyte-drop-box:visible lyte-drop-item:has-text("M.Tech"), lyte-drop-box:visible lyte-drop-item:has-text("B.Tech"), lyte-drop-box:visible lyte-drop-item:has-text("M.S."), lyte-drop-box:visible lyte-drop-item:has-text("B.E.")').first();
        if (await qualItem.count() > 0) {
            const chosenQual = (await qualItem.innerText().catch(() => '')).trim();
            await qualItem.evaluate(el => el.click());
            console.log(chalk.green(`    -> Selected Highest Qualification Held: "${chosenQual}"`));
        }
        await page.waitForTimeout(500);
    }

    // 6. Skill Set
    const skillComp = page.locator('#addSkills, input[name="-add-skills"], #rec-form_31840000000003185, [data-zcqa*="Skill_Set" i]').first();
    if (await skillComp.isVisible({ timeout: 1200 }).catch(() => false)) {
        await skillComp.scrollIntoViewIfNeeded().catch(() => {});
        const skillInp = (await skillComp.evaluate(el => el.tagName).catch(() => '')) === 'INPUT' ? skillComp : skillComp.locator('input').first();
        const skillsToAdd = (job.role && /devops/i.test(job.role)) ? ['DevOps'] : ['Python', 'Machine Learning'];
        for (const s of skillsToAdd) {
            await skillInp.fill(s);
            await page.waitForTimeout(400);
            const pill = page.locator('.skl-suggested-skill, .skl-suggested-tag-container, [class*="skillTag"]').locator(`text=/^${s}$/i`).first();
            if (await pill.isVisible({ timeout: 800 }).catch(() => false)) {
                await pill.click();
            } else {
                await skillInp.press('Enter');
            }
            await page.waitForTimeout(200);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.locator('body').click({ position: { x: 10, y: 10 } }).catch(() => {});
        await page.waitForTimeout(500);
        console.log(chalk.green(`    -> Added Skills: ${skillsToAdd.join(', ')}`));
    }

    // 7. Check if multi-step form (has "Next" button) or single-page form
    const nextBtn = page.locator('button:has-text("Next")').first();
    const isMultiStep = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (isMultiStep) {
        // Multi-step (Kumaran Systems style)
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        console.log(chalk.yellow('  Clicking Next to advance to Educational Details...'));
        await nextBtn.click();
        await page.waitForTimeout(2500);

        // 8. Step 2: Educational Details
        console.log(chalk.blue('  Filling Educational Details...'));
        await page.evaluate(({ uni, field, deg }) => {
            const findAndSet = (labelText, val) => {
                const all = Array.from(document.querySelectorAll('*'));
                const label = all.find(e => e.innerText?.trim().startsWith(labelText) && e.children.length <= 2);
                if (!label) return;
                let curr = label.parentElement;
                for (let i = 0; i < 4; i++) {
                    if (!curr) break;
                    const inp = curr.querySelector('input:not([type="hidden"]):not([type="checkbox"])');
                    if (inp) {
                        inp.focus();
                        inp.value = val;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                    curr = curr.parentElement;
                }
            };

            findAndSet('Institute / School', uni);
            findAndSet('Major / Department', field);
            findAndSet('Degree', deg);
        }, {
            uni: profile.education?.university || 'Vellore Institute of Technology',
            field: profile.education?.field || 'Computer Science and Engineering',
            deg: profile.education?.degree || 'Integrated M.Tech'
        });
        console.log(chalk.green('    -> Filled Institute, Major, and Degree'));

        // Handle "Currently pursuing" checkbox
        const shouldPursue = !!profile.education?.currentlyPursuing;
        await page.evaluate((pursue) => {
            const cb = document.querySelector('input[type="checkbox"][name*="127075"], input[type="checkbox"][id*="pursuing" i]') ||
                       Array.from(document.querySelectorAll('lyte-checkbox')).find(e => e.innerText?.includes('Currently pursuing'));
            if (!cb) return;
            const isChecked = cb.checked || cb.getAttribute('lt-prop-checked') === 'true';
            if (pursue && !isChecked) {
                const clickTarget = cb.tagName.toLowerCase() === 'lyte-checkbox' ? 
                                   (cb.querySelector('.lyteCheckBoxDefault') || cb) : 
                                   (cb.closest('lyte-checkbox') || cb);
                clickTarget.click();
            } else if (!pursue && isChecked) {
                const clickTarget = cb.tagName.toLowerCase() === 'lyte-checkbox' ? 
                                   (cb.querySelector('.lyteCheckBoxDefault') || cb) : 
                                   (cb.closest('lyte-checkbox') || cb);
                clickTarget.click();
            }
        }, shouldPursue);
        console.log(chalk.green(`    -> "Currently pursuing" set to: ${shouldPursue}`));

        // Duration dropdown helper
        const selectLyteDropdown = async (btnLocator, searchText) => {
            if (!(await btnLocator.isVisible().catch(() => false))) return;
            await btnLocator.scrollIntoViewIfNeeded().catch(() => {});
            await btnLocator.click();
            await page.waitForTimeout(400);

            const dropBox = page.locator('lyte-drop-box:visible').first();
            const searchInp = dropBox.locator('input').first();
            if (await searchInp.isVisible({ timeout: 600 }).catch(() => false)) {
                await searchInp.fill(searchText);
                await page.waitForTimeout(300);
                const filteredItem = dropBox.locator(`lyte-drop-item:has-text("${searchText}")`).first();
                if (await filteredItem.count() > 0) {
                    await filteredItem.click();
                } else {
                    await page.keyboard.press('Enter');
                }
            } else {
                const item = dropBox.locator(`lyte-drop-item:has-text("${searchText}")`).first();
                if (await item.count() > 0) {
                    await item.click();
                }
            }
            await page.waitForTimeout(300);
        };

        const fromMonthBtn = page.locator('lyte-dropdown[id*="from_month"] lyte-drop-button, lyte-dropdown[id*="from_month"]').first();
        await selectLyteDropdown(fromMonthBtn, 'Jun');
        console.log(chalk.green('    -> Selected From Month: Jun'));

        const fromYearBtn = page.locator('lyte-dropdown[id*="from_year"] lyte-drop-button, lyte-dropdown[id*="from_year"]').first();
        await selectLyteDropdown(fromYearBtn, '2021');
        console.log(chalk.green('    -> Selected From Year: 2021'));

        if (!shouldPursue) {
            const toMonthBtn = page.locator('lyte-dropdown[id*="to_month"] lyte-drop-button, lyte-dropdown[id*="to_month"]').first();
            await selectLyteDropdown(toMonthBtn, 'Jun');
            console.log(chalk.green('    -> Selected To Month: Jun'));

            const toYearBtn = page.locator('lyte-dropdown[id*="to_year"] lyte-drop-button, lyte-dropdown[id*="to_year"]').first();
            await selectLyteDropdown(toYearBtn, '2026');
            console.log(chalk.green('    -> Selected To Year: 2026'));
        }

        // Year of Passed out: 2026 (if present)
        const passOutInp = page.locator('xpath=//*[contains(text(), "Year of Passed out")]/following::input[1]').first();
        if (await passOutInp.isVisible({ timeout: 1000 }).catch(() => false)) {
            await passOutInp.fill(profile.education?.passoutYear || '2026');
            console.log(chalk.green(`    -> Filled Year of Passed out: ${profile.education?.passoutYear || '2026'}`));
        }

        // 9. Click Next to advance to Step 3 (Compliance Survey)
        const step2Submit = page.locator('button:has-text("Next"), button:has-text("Submit"), button[type="submit"]').first();
        console.log(chalk.yellow('  Clicking Next to advance to Step 3 (Compliance)...'));
        await step2Submit.click();
        await page.waitForTimeout(3500);

        // 10. Step 3: EEO Compliance Survey
        const selectRadio = async (textPattern) => {
            const loc = page.locator(`lyte-radiobutton:has-text("${textPattern}"), label:has-text("${textPattern}"), span:has-text("${textPattern}")`).first();
            if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
                await loc.scrollIntoViewIfNeeded().catch(() => {});
                await loc.click();
                console.log(chalk.green(`    -> Selected survey option: "${textPattern}"`));
                await page.waitForTimeout(300);
            }
        };

        const isCompliance = await page.locator('text=/EEO Compliance Survey|Disability Status/i').first().isVisible({ timeout: 2500 }).catch(() => false);
        if (isCompliance) {
            console.log(chalk.blue('  Filling EEO Compliance Survey...'));
            await selectRadio('No, I do not have a disability and have not had one in the past');
            await selectRadio('Asian');
            await selectRadio('Male');
            await selectRadio('I am not a veteran.');

            // Click final Submit on EEO page
            const submitEEO = page.locator('button:has-text("Submit"), button[type="submit"]').first();
            if (await submitEEO.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(chalk.yellow('  Clicking final Submit button on Compliance survey...'));
                await submitEEO.click();
                await page.waitForTimeout(5000);
            }
        }
    } else {
        // Single-page Zoho Recruit form (e.g. Addweb Solution)
        console.log(chalk.blue('  Single-page Zoho Recruit form detected (e.g. Addweb Solution)...'));

        // Handle CAPTCHA if present
        const captchaImg = page.locator('img[alt="CAPTCHA"]').first();
        if (await captchaImg.isVisible({ timeout: 2000 }).catch(() => false)) {
            const captchaPath = path.resolve(__dirname, '../scratch/current_captcha.png');
            await captchaImg.screenshot({ path: captchaPath });
            console.log(chalk.yellow(`\n📸 CAPTCHA detected! Image saved to: ${captchaPath}`));

            const solPath = path.resolve(__dirname, '../scratch/captcha_solution.txt');
            try { if (fs.existsSync(solPath)) fs.unlinkSync(solPath); } catch (_) {}

            console.log(chalk.yellow.bold('  👉 Waiting up to 35 seconds for solution in scratch/captcha_solution.txt or browser entry...'));
            const captchaInp = page.locator('input[placeholder*="below image text" i], [class*="captcha" i] input, rec-captcha-component input').first();

            let solution = '';
            const start = Date.now();
            while (Date.now() - start < 35000) {
                if (fs.existsSync(solPath)) {
                    solution = fs.readFileSync(solPath, 'utf8').trim();
                    if (solution) break;
                }
                const val = await captchaInp.inputValue().catch(() => '');
                if (val && val.length >= 4) {
                    solution = val;
                    break;
                }
                await page.waitForTimeout(1000);
            }

            if (solution) {
                await captchaInp.fill(solution);
                await captchaInp.evaluate(e => {
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
                console.log(chalk.green(`  ✔ Entered CAPTCHA: "${solution}"`));
            } else {
                console.log(chalk.red('  ⚠️ No CAPTCHA solution received before timeout.'));
            }
        }

        // Click Submit Application
        const submitAppBtn = page.locator('button:has-text("Submit Application"), button:has-text("Submit"), button.lyteSuccess').first();
        if (await submitAppBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            const submissionGate = await confirmAndExecuteSubmission({
                dryRun,
                job,
                resumeUsed: selectedResume?.fileName,
                destination: 'Zoho Recruit ATS',
                actionName: 'Zoho Recruit "Submit Application" Button',
                execute: async () => {
                    console.log(chalk.yellow('  Clicking "Submit Application" button...'));
                    await submitAppBtn.click();
                    await page.waitForTimeout(6000);
                    return { status: 'SUCCESS' };
                },
                promptFn: options.promptFn,
                isInteractive: options.isInteractive
            });

            if (!submissionGate.submitted) {
                return submissionGate;
            }
        }
    }

    if (dryRun) {
        return await confirmAndExecuteSubmission({
            dryRun: true,
            job,
            resumeUsed: selectedResume?.fileName,
            destination: 'Zoho Recruit ATS',
            actionName: 'Zoho Recruit Submit Boundary',
            execute: async () => ({ status: 'SUCCESS' })
        });
    }

    // 11. Final Verification
    const pageText = await page.content().catch(() => '');
    const isSuccess = /application has been submitted successfully|thank you|success!|application submitted/i.test(pageText);

    // Save screenshot
    const scPath = path.resolve(__dirname, `../screenshots/external-zoho-${Date.now()}.png`);
    if (!fs.existsSync(path.dirname(scPath))) fs.mkdirSync(path.dirname(scPath), { recursive: true });
    await page.screenshot({ path: scPath, fullPage: true }).catch(() => {});
    console.log(chalk.gray(`  Screenshot saved to ${scPath}`));

    if (isSuccess) {
        console.log(chalk.green.bold('  🎉 SUCCESS: Zoho Recruit application submitted successfully!'));
        return {
            status: 'SUCCESS',
            verified: true,
            message: 'Your application has been submitted successfully on Zoho Recruit',
            resumeUsed: selectedResume.fileName,
            externalUrl: page.url()
        };
    } else {
        console.log(chalk.red.bold('  ❌ FAILED: Application confirmation not detected on page.'));
        return {
            status: 'FAILED',
            reason: 'SUBMISSION_NOT_VERIFIED',
            verified: false,
            message: 'Zoho Recruit application submission could not be confirmed',
            resumeUsed: selectedResume.fileName,
            externalUrl: page.url()
        };
    }
}

/**
 * Handles application on an external company careers portal / ATS.
 *
 * @param {import('playwright').Page} page - Active browser page on the external site
 * @param {Object} job - Target job details
 * @param {string} targetUrl - External site URL
 * @param {{ type: string, path: string, fileName: string }} selectedResume - Chosen resume
 * @returns {Promise<{ status: string, message: string, resumeUsed?: string, externalUrl?: string }>}
 */
async function handleExternalApplication(page, job, targetUrl, selectedResume, options = {}) {
    const dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    console.log(chalk.magenta.bold(`\n--- STARTING EXTERNAL APPLICATION AUTOMATION ---`));
    console.log(chalk.cyan(`Target: ${job.role || job.title} @ ${job.company}`));
    console.log(chalk.cyan(`URL: ${targetUrl}`));
    console.log(chalk.cyan(`Using Resume: ${selectedResume?.fileName || 'None'} (${selectedResume?.type || 'UNKNOWN'})`));
    if (dryRun) console.log(chalk.bold.yellow('Mode: DRY-RUN (Safety Barrier Active)'));

    // Verify resume physically exists on disk
    const resumePath = selectedResume && selectedResume.path;
    const resumeExists = resumePath && fs.existsSync(resumePath);
    if (!resumeExists) {
        console.log(chalk.red.bold(`  ❌ EXTERNAL ATS BLOCKED: Required resume file not found on disk: "${resumePath || 'unknown'}".`));
        return {
            status: 'BLOCKED',
            reason: 'MISSING_REQUIRED_DATA',
            message: `Required resume file not found on disk at: ${resumePath || 'unknown'}`,
            resumeUsed: selectedResume?.fileName || 'MISSING',
            externalUrl: targetUrl
        };
    }

    // Load the selected resume into context for question answering
    await loadResume(selectedResume.path);

    try {
        if (targetUrl && targetUrl.startsWith('http') && page.url() !== targetUrl && !page.url().includes(targetUrl)) {
            console.log(chalk.gray(`  [External ATS] Navigating page to: ${targetUrl}`));
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
                console.warn(chalk.yellow(`  ⚠️ [External ATS] Navigation warning: ${err.message}`));
            });
            await randomDelay(2000, 3000);
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await randomDelay(2000, 3000);

        // 1. Detect 404 / Page Not Found / Broken Link
        const isNotFound = await page.evaluate(() => {
            const text = document.body?.innerText?.toLowerCase() || '';
            const title = document.title?.toLowerCase() || '';
            return (text.includes('404') && (text.includes('page not found') || text.includes("doesn't exist") || text.includes('not found') || text.includes('cannot be found'))) ||
                   title.includes('404') || title.includes('page not found');
        }).catch(() => false);

        if (isNotFound) {
            console.log(chalk.red('  ❌ Destination page returned 404 / Page Not Found. Broken career URL on recruiter listing.'));
            return {
                status: 'FAILED',
                message: 'External career link returned 404 Page Not Found (broken link posted on job portal)',
                resumeUsed: selectedResume?.fileName,
                externalUrl: page.url()
            };
        }

        // 1a. Detect Login / Registration Wall -> Try Bypass first, then Human Intervention
        if (await checkLoginWall(page)) {
            console.log(chalk.yellow('  ⚠️ External portal requires login / sign-in credentials.'));

            // Try guest/self-complete bypass first
            const bypassed = await tryLoginWallBypass(page);
            if (bypassed) {
                console.log(chalk.green('  ✔ Login wall bypassed successfully! Continuing application flow...'));
                await waitForPortalState(page, 4000);
            } else {
                // Fall back to human intervention
                console.log(chalk.yellow('  No guest/bypass option found. Prompting human intervention...'));
                const { promptHumanIntervention } = require('../ai/humanIntervention');
                const interventionRes = await promptHumanIntervention({
                    question: `The career portal for ${job.company || 'the employer'} requires login/authentication. Please log in using the browser window, then press Enter (or type "done") to resume.`,
                    type: 'action',
                    options: [],
                    job,
                    reason: 'Login wall encountered on destination portal.',
                    promptFn: options.promptFn,
                    isInteractive: options.isInteractive
                });

                if (!interventionRes.answered) {
                    console.log(chalk.yellow('  ⚠️ Human intervention for login was not completed.'));
                    return {
                        status: 'SKIPPED',
                        reason: 'NEEDS_HUMAN_INTERVENTION',
                        message: 'External site requires login and human intervention was not completed',
                        externalUrl: page.url()
                    };
                }

                // After human intervention, wait and re-check login wall
                await randomDelay(2000, 3000);
                if (await checkLoginWall(page)) {
                    console.log(chalk.yellow('  ⚠️ Login wall still detected after human intervention.'));
                    return {
                        status: 'SKIPPED',
                        reason: 'NEEDS_HUMAN_INTERVENTION',
                        message: 'External site still requires login after human intervention',
                        externalUrl: page.url()
                    };
                }
                console.log(chalk.green('  ✔ Login verified! Resuming application flow...'));
            }
        }

        // 1b. Inspect destination page content for explicit graduation/batch restriction
        const destinationText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (destinationText) {
            const { evaluatePassoutYear } = require('../sources/whatsapp/yearFilter');
            const pageYearEval = evaluatePassoutYear(destinationText);
            if (pageYearEval.hasYearEvidence) {
                if (!pageYearEval.eligible) {
                    console.log(chalk.yellow(`  ⚠️ Destination page explicitly mandates graduation/batch year "${pageYearEval.yearEvidence}" which excludes 2026/26. Skipping job.`));
                    return {
                        status: 'SKIPPED',
                        reason: 'REJECTED_YEAR',
                        message: `Destination page mandates graduation/batch year "${pageYearEval.yearEvidence}" which excludes 2026/26`,
                        externalUrl: page.url()
                    };
                } else {
                    console.log(chalk.green(`  ✔ Destination page graduation/batch year "${pageYearEval.yearEvidence}" confirms eligibility (includes 2026/26).`));
                }
            }
        }

        // 1c. Detect Zoho Recruit ATS platform (e.g. Kumaran Systems)
        const isZoho = targetUrl.includes('zoho.com') || targetUrl.includes('careers.kumaran.com') || page.url().includes('zoho') ||
                       (await page.locator('[data-zcqa], lyte-dropdown, lyte-drop-button').count().catch(() => 0)) > 0;
        if (isZoho) {
            return await handleZohoRecruitApplication(page, job, selectedResume, options);
        }

        // Dismiss any cookie consent banners first
        const cookieButtons = [
            'button:has-text("Accept all")',
            'button:has-text("Accept All")',
            'button:has-text("Accept cookies")',
            'button:has-text("I Accept")',
            '#onetrust-accept-btn-handler',
            'button:has-text("Allow all")'
        ];
        for (const cSel of cookieButtons) {
            const cBtn = page.locator(cSel).first();
            if (await cBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                await cBtn.click().catch(() => {});
                await randomDelay(400, 800);
                break;
            }
        }

        // 2. Handle Landing Page -> Open Application Form
        // Some career sites display a description page first with an "Apply" button before rendering the form
        // Also detect embedded ATS iframes (e.g. Ceipal, Greenhouse, Workable)
        let targetScope = page;
        let formExists = await page.locator('input[type="file"], input[name*="name" i], input[type="email"]').first().isVisible().catch(() => false);

        if (!formExists) {
            // Check embedded frames
            for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                const frameHasForm = await frame.locator('input[type="file"], input[type="email"], a:has-text("Submit Resume"), a:has-text("Apply"), button:has-text("Apply")').first().isVisible().catch(() => false);
                if (frameHasForm) {
                    console.log(chalk.cyan(`  Targeting embedded ATS application frame: ${frame.url()}`));
                    targetScope = frame;
                    formExists = await targetScope.locator('input[type="file"], input[name*="name" i], input[type="email"]').first().isVisible().catch(() => false);
                    break;
                }
            }
        }

        const applyButtons = [
            'button:has-text("I\'m interested")',
            'a:has-text("I\'m interested")',
            'button:has-text("Interested")',
            'a:has-text("Interested")',
            'a:has-text("Apply for this job")',
            'button:has-text("Apply for this job")',
            'a:has-text("Apply Now")',
            'button:has-text("Apply Now")',
            'a:has-text("Submit Resume")',
            'button:has-text("Submit Resume")',
            '[data-qa="apply-button"]',
            '[class*="apply-btn"]',
            '[class*="apply-button"]',
            'button:text-is("Apply")',
            'a:text-is("Apply")'
        ];

        if (!formExists) {
            for (const sel of applyButtons) {
                const btn = targetScope.locator(sel).first();
                if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    console.log(chalk.blue(`  Clicking external landing page apply trigger: "${sel}"`));
                    await btn.scrollIntoViewIfNeeded().catch(() => {});
                    await btn.click({ force: true }).catch(() => {});
                    await randomDelay(2000, 3500);
                    break;
                }
            }
        }

        // Wait for portal SPA to settle and render form or authentication elements
        await waitForPortalState(page, 6000);

        // Check if landing page action opened a new tab
        if (page.context && typeof page.context().pages === 'function') {
            for (const p of page.context().pages()) {
                if (p !== page && !p.url().includes('about:blank') && !p.url().includes('whatsapp.com')) {
                    console.log(chalk.cyan(`  Switching application scope to opened tab: ${p.url()}`));
                    page = p;
                    targetScope = p;
                    await page.waitForLoadState('domcontentloaded').catch(() => {});
                    break;
                }
            }
        }

        // Check if the opened page is also a landing page (e.g. aggregate ATS -> employer career portal -> apply form)
        const secondaryFormExists = await targetScope.locator('input[type="file"], input[type="email"], input[name*="name" i], textarea').first().isVisible().catch(() => false);
        if (!secondaryFormExists) {
            for (const sel of applyButtons) {
                const btn = targetScope.locator(sel).first();
                if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    console.log(chalk.blue(`  Clicking secondary/nested landing page apply trigger: "${sel}"`));
                    const popupPromise = (page.context && typeof page.context().waitForEvent === 'function')
                        ? page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null)
                        : Promise.resolve(null);
                    await btn.scrollIntoViewIfNeeded().catch(() => {});
                    await btn.click({ force: true }).catch(() => {});
                    const newPage = await popupPromise;
                    if (newPage) {
                        page = newPage;
                        targetScope = newPage;
                        await page.waitForLoadState('domcontentloaded').catch(() => {});
                    } else {
                        await page.waitForLoadState('domcontentloaded').catch(() => {});
                    }
                    await waitForPortalState(page, 4000);
                    break;
                }
            }
        }

        // Multi-Step Application Stepper Loop (handles Login -> Profile -> Questions -> Submit)
        const MAX_STEPS = 10;
        let currentStep = 1;
        let resumeUploaded = false;
        let lastStepUrl = '';
        let stagnantStepCount = 0;

        while (currentStep <= MAX_STEPS) {
            console.log(chalk.cyan(`\n>>> [Application Form] Processing Step ${currentStep}/${MAX_STEPS}...`));

            // 1. Check for Login Wall / Account Creation on this step
            if (await checkLoginWall(page)) {
                // Try guest/self-complete bypass first
                const bypassed = await tryLoginWallBypass(page);
                if (bypassed) {
                    console.log(chalk.green(`  ✔ Login wall bypassed at Step ${currentStep}! Continuing...`));
                    await waitForPortalState(page, 4000);
                } else {
                    // Fall back to human intervention
                    const loginRes = await handleLoginWallIntervention(page, job, options, `Step ${currentStep}`);
                    if (!loginRes.cleared) {
                        return loginRes.result;
                    }
                    if (loginRes.page) {
                        page = loginRes.page;
                        targetScope = loginRes.page;
                    }
                }
                await randomDelay(2000, 3000);
            }

            // 2. Check for CAPTCHA / Cloudflare challenge
            if (await checkCaptcha(page)) {
                console.log(chalk.yellow('  ⚠️ CAPTCHA / security challenge detected. Prompting human intervention...'));
                const { promptHumanIntervention } = require('../ai/humanIntervention');
                const captchaRes = await promptHumanIntervention({
                    question: `Security verification / CAPTCHA detected for ${job.company || 'this site'}. Please solve it in the browser window, then press Enter to resume.`,
                    type: 'action',
                    job,
                    reason: 'CAPTCHA challenge detected.',
                    promptFn: options.promptFn,
                    isInteractive: options.isInteractive
                });
                if (!captchaRes.answered) {
                    return {
                        status: 'SKIPPED',
                        reason: 'NEEDS_HUMAN_INTERVENTION',
                        message: 'CAPTCHA detected and human intervention was not completed',
                        externalUrl: page.url()
                    };
                }
                await page.waitForTimeout(2000);
            }

            // 3. Expand any collapsible accordion sections
            await expandAllSections(targetScope);

            // 4. Upload Resume PDF (Universal FileUpload Capability)
            const fileInputCount = await targetScope.locator('input[type="file"]').count().catch(() => 0);
            if (fileInputCount > 0 || (!resumeUploaded && currentStep === 1)) {
                const resumeUploadResult = await attachResumeSafely(targetScope, page, selectedResume, options, job);
                if (resumeUploadResult.verified) {
                    resumeUploaded = true;
                } else if (fileInputCount > 0) {
                    console.log(chalk.red('  ❌ SUBMISSION BLOCKED: Resume attachment could not be verified in the DOM.'));
                    return {
                        status: 'SKIPPED',
                        reason: 'RESUME_NOT_VERIFIED',
                        message: 'Application halted: Resume attachment could not be verified in the DOM',
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }
            }

            // 5. Fill Standard Candidate Profile Fields
            console.log(chalk.blue('  Filling standard candidate information...'));
            const firstName = profile.firstName || profile.fullName.split(' ')[0];
            const lastName = profile.lastName || profile.fullName.split(' ').slice(1).join(' ');

            await fillFieldIfEmpty(targetScope, ['input[name*="first_name" i]', 'input[name*="firstname" i]', 'input[id*="first_name" i]', 'input[id*="firstname" i]', 'input[name="first" i]', 'input[id="first" i]', 'input[placeholder*="first name" i]', 'input[autocomplete="given-name"]'], firstName, 'First Name', ['First Name *', 'First Name']);
            await fillFieldIfEmpty(targetScope, ['input[name*="last_name" i]', 'input[name*="lastname" i]', 'input[id*="last_name" i]', 'input[id*="lastname" i]', 'input[name="last" i]', 'input[id="last" i]', 'input[placeholder*="last name" i]', 'input[autocomplete="family-name"]'], lastName, 'Last Name', ['Last Name *', 'Last Name']);
            await fillFieldIfEmpty(targetScope, ['input[name*="full_name" i]', 'input[name*="fullname" i]', 'input[placeholder*="full name" i]', 'input[name="name" i]', 'input[id="name" i]'], profile.fullName, 'Full Name', ['Full Name *', 'Full Name']);
            await fillFieldIfEmpty(targetScope, ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]'], profile.email, 'Email', ['Email *', 'Email Address']);
            const phoneVal = (profile.mobile || '').replace(/^\+91\s*/, '');
            await fillFieldIfEmpty(targetScope, ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="mobile" i]', 'input[id*="phone" i]', 'input[placeholder*="phone" i]'], phoneVal, 'Phone', ['Mobile *', 'Phone *', 'Mobile Number']);
            await fillFieldIfEmpty(targetScope, ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[placeholder*="linkedin" i]'], profile.linkedin || '', 'LinkedIn', ['LinkedIn Profile', 'LinkedIn URL']);
            await fillFieldIfEmpty(targetScope, ['input[name*="github" i]', 'input[id*="github" i]', 'input[placeholder*="github" i]'], profile.github || '', 'GitHub', ['GitHub Profile', 'GitHub URL']);
            await fillFieldIfEmpty(targetScope, ['input[name*="portfolio" i]', 'input[name*="website" i]', 'input[id*="website" i]', 'input[placeholder*="website" i]'], profile.github || '', 'Website/Portfolio', ['Website', 'Portfolio']);
            await fillFieldIfEmpty(targetScope, ['input[name*="city" i]', 'input[name*="location" i]', 'input[id*="location" i]', 'input[placeholder*="city" i]', 'input[placeholder*="location" i]'], profile.address?.city || profile.currentLocation || '', 'City', ['City *', 'Current Location']);
            await fillFieldIfEmpty(targetScope, ['input[name*="street" i]', 'input[placeholder*="street" i]'], profile.address?.street || '', 'Street', ['Street *', 'Address *', 'Street Address']);
            await fillFieldIfEmpty(targetScope, ['input[name*="state" i]', 'input[placeholder*="state" i]'], profile.address?.state || '', 'State', ['State *', 'State/Province *']);
            await fillFieldIfEmpty(targetScope, ['input[name*="country" i]', 'input[placeholder*="country" i]'], profile.address?.country || 'India', 'Country', ['Country *']);
            await fillFieldIfEmpty(targetScope, ['input[name*="total_exp" i]', 'input[id*="total_exp" i]'], String(profile.experience || '1'), 'Total Years Of Experience', ['Total Years Of Experience *', 'Total Experience']);
            await fillFieldIfEmpty(targetScope, ['input[name*="rel_exp" i]', 'input[id*="rel_exp" i]'], String(profile.experience || '1'), 'Relevant Years Of Experience', ['Relevant Years Of Experience *', 'Relevant Experience']);
            await fillFieldIfEmpty(targetScope, ['input[name*="company" i]', 'input[name*="organization" i]', 'input[id*="company" i]', 'input[placeholder*="company" i]'], profile.currentCompany || '', 'Current Company', ['Current Company *', 'Company Name']);
            await fillFieldIfEmpty(targetScope, ['input[name*="title" i]', 'input[name*="role" i]', 'input[id*="title" i]', 'input[placeholder*="title" i]'], profile.currentJobTitle || '', 'Job Title', ['Current Job Title *', 'Job Title']);

            // 6. Auto-check Terms / Consent / Declaration Checkboxes
            const checkboxes = await targetScope.locator('input[type="checkbox"]').all();
            for (const cb of checkboxes) {
                try {
                    if (await cb.isVisible().catch(() => false)) {
                        const isChecked = await cb.isChecked().catch(() => false);
                        if (!isChecked) {
                            const parentText = await cb.evaluate(el => el.closest('label, div, p')?.innerText?.toLowerCase() || '').catch(() => '');
                            if (/agree|consent|terms|privacy|policy|certify|acknowledge|declare|authorized/i.test(parentText)) {
                                console.log(chalk.green('  ✔ Checking agreement/consent checkbox'));
                                await cb.click({ force: true }).catch(() => {});
                            }
                        }
                    }
                } catch (_) {}
            }

            // 7. Handle Native Dropdowns & Custom Comboboxes
            await handleDropdowns(targetScope, page, options, job);

            // 8. Handle Radio Button Groups
            const radioInputs = await targetScope.locator('input[type="radio"]').all();
            const handledRadioNames = new Set();
            for (const radio of radioInputs) {
                try {
                    const name = await radio.getAttribute('name').catch(() => '');
                    if (!name || handledRadioNames.has(name)) continue;
                    handledRadioNames.add(name);

                    const groupRadios = await targetScope.locator(`input[type="radio"][name="${name}"]`).all();
                    if (groupRadios.length === 0) continue;

                    let alreadyChecked = false;
                    for (const r of groupRadios) {
                        if (await r.isChecked().catch(() => false)) {
                            alreadyChecked = true;
                            break;
                        }
                    }
                    if (alreadyChecked) continue;

                    const questionText = await groupRadios[0].evaluate(el => {
                        const fieldset = el.closest('fieldset');
                        const legend = fieldset?.querySelector('legend');
                        if (legend?.innerText?.trim()) return legend.innerText.trim();
                        const container = el.closest('.field, .form-group, .application-question, [class*="question"], div');
                        const label = container?.querySelector('label, .application-label, p, h3, h4, span');
                        return (label?.innerText || '').trim();
                    }).catch(() => '');

                    if (!questionText || questionText.length < 3) continue;

                    const radioOptions = [];
                    for (const r of groupRadios) {
                        const optLabel = await r.evaluate(el => {
                            const id = el.id;
                            const labelFor = id ? document.querySelector(`label[for="${id}"]`) : null;
                            if (labelFor?.innerText?.trim()) return labelFor.innerText.trim();
                            const parentLabel = el.closest('label');
                            if (parentLabel?.innerText?.trim()) return parentLabel.innerText.trim();
                            return el.value || '';
                        }).catch(() => '');
                        if (optLabel) radioOptions.push({ locator: r, text: optLabel.trim() });
                    }

                    if (radioOptions.length > 0) {
                        const optTexts = radioOptions.map(o => o.text);
                        console.log(chalk.cyan(`  Answering radio question: "${questionText.slice(0, 60)}" (Options: [${optTexts.join(', ')}])`));
                        const ans = await getAnswer(questionText, optTexts, false);
                        let matched = null;
                        if (ans) {
                            matched = matchOption(optTexts, ans);
                        }

                        if (!matched) {
                            console.log(chalk.yellow(`  ⚠️ No trusted answer for radio question "${questionText.slice(0, 60)}". Prompting human intervention...`));
                            const { promptHumanIntervention } = require('../ai/humanIntervention');
                            const interventionRes = await promptHumanIntervention({
                                question: `Please select an answer for "${questionText}":`,
                                type: 'dropdown',
                                options: optTexts,
                                job,
                                reason: 'Unknown question answer. Zero guessing rule active.',
                                promptFn: options.promptFn,
                                isInteractive: options.isInteractive
                            });
                            if (interventionRes.answered && interventionRes.value) {
                                matched = matchOption(optTexts, interventionRes.value) || interventionRes.value;
                            }
                        }

                        if (matched) {
                            const targetRadio = radioOptions.find(o => o.text === matched);
                            if (targetRadio) {
                                console.log(chalk.green(`    -> Selected radio option: "${matched}"`));
                                await targetRadio.locator.scrollIntoViewIfNeeded().catch(() => {});
                                await targetRadio.locator.check({ force: true }).catch(async () => {
                                    await targetRadio.locator.evaluate(e => {
                                        e.checked = true;
                                        e.dispatchEvent(new Event('change', { bubbles: true }));
                                    });
                                });
                            }
                        }
                    }
                } catch (_) {}
            }

            // 9. Handle Unfilled Textareas and Custom Inputs
            const textareas = await targetScope.locator('textarea').all();
            for (const ta of textareas) {
                try {
                    if (!(await ta.isVisible().catch(() => false))) continue;
                    const val = await ta.inputValue().catch(() => '');
                    if (val && val.trim()) continue;

                    const qText = await ta.evaluate(el => {
                        const id = el.id;
                        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
                        return (label?.innerText || el.placeholder || el.name || '').trim();
                    }).catch(() => '');

                    if (qText) {
                        console.log(chalk.cyan(`  Answering textarea: "${qText.slice(0, 60)}..."`));
                        let ans = await getAnswer(qText, [], false);
                        if (!ans) {
                            const { promptHumanIntervention } = require('../ai/humanIntervention');
                            const interventionRes = await promptHumanIntervention({
                                question: `Please answer for textarea "${qText}":`,
                                type: 'text',
                                job,
                                reason: 'Unknown question answer. Zero guessing rule active.',
                                promptFn: options.promptFn,
                                isInteractive: options.isInteractive
                            });
                            if (interventionRes.answered && interventionRes.value) {
                                ans = interventionRes.value;
                            }
                        }
                        if (ans) {
                            await ta.fill(ans);
                            console.log(chalk.green(`    -> Filled textarea answer`));
                        }
                    }
                } catch (_) {}
            }

            await randomDelay(1000, 2000);

            // 10. Locate Action Button (Next or Submit), strictly ignoring Login / Auth buttons
            console.log(chalk.blue('  Locating application action button (Next or Submit)...'));

            const isAuthButton = (txt) => /^(log\s*in|sign\s*in|login|signin|register|create\s*an?\s*account|forgot\s*password|reset\s*password)$/i.test(txt);

            // A. Look for FINAL SUBMIT buttons
            const finalSubmitSelectors = [
                'button:has-text("Submit Application")',
                'button:has-text("Submit application")',
                'button:has-text("Submit")',
                'input[value="Submit" i]',
                'input[value="Submit Application" i]',
                'button:has-text("Complete Application")',
                'button:has-text("Send Application")',
                'a:has-text("Submit Application")',
                'a:has-text("Submit")',
                '[data-qa="btn-submit"]',
                '[class*="submit-btn"]',
                'button[type="submit"]',
                'input[type="submit"]'
            ];

            let finalSubmitBtn = null;
            let finalSubmitText = '';
            for (const sel of finalSubmitSelectors) {
                const btn = targetScope.locator(sel).first();
                if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
                    const txt = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || sel).trim();
                    if (isAuthButton(txt)) {
                        continue;
                    }
                    if (/^(next|continue|save\s*&\s*continue|next\s*step)$/i.test(txt)) {
                        continue;
                    }
                    finalSubmitBtn = btn;
                    finalSubmitText = txt;
                    break;
                }
            }

            // B. If no final submit, look for Next / Continue buttons
            const nextStepSelectors = [
                'button:has-text("Next")',
                'button:has-text("Continue")',
                'button:has-text("Save and Continue")',
                'button:has-text("Save & Continue")',
                'button:has-text("Next Step")',
                'input[value="Next" i]',
                'input[value="Continue" i]',
                'a:has-text("Next")',
                'a:has-text("Continue")'
            ];

            let nextStepBtn = null;
            let nextStepText = '';
            if (!finalSubmitBtn) {
                for (const sel of nextStepSelectors) {
                    const btn = targetScope.locator(sel).first();
                    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
                        const txt = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || sel).trim();
                        if (isAuthButton(txt)) continue;
                        nextStepBtn = btn;
                        nextStepText = txt;
                        break;
                    }
                }
            }

            // Special Case: Only button found was an auth button (e.g. "Log in") or page has password input
            const hasPasswordNow = await targetScope.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false);
            if (!finalSubmitBtn && !nextStepBtn && hasPasswordNow) {
                // Try guest/self-complete bypass first
                const bypassed = await tryLoginWallBypass(page);
                if (bypassed) {
                    console.log(chalk.green(`  ✔ Login wall bypassed at Step ${currentStep} (fallback)! Continuing...`));
                    await waitForPortalState(page, 4000);
                } else {
                    console.log(chalk.yellow('  ⚠️ Detected authentication/login wall during step evaluation. Prompting human sign-in...'));
                    const loginRes = await handleLoginWallIntervention(page, job, options, `Step ${currentStep}`);
                    if (!loginRes.cleared) {
                        return loginRes.result;
                    }
                    if (loginRes.page) {
                        page = loginRes.page;
                        targetScope = loginRes.page;
                    }
                }
                currentStep++;
                continue;
            }

            // EXECUTE: FINAL SUBMIT
            if (finalSubmitBtn) {
                if (!resumeUploaded) {
                    console.log(chalk.red('  ❌ SUBMISSION BLOCKED: Resume was not uploaded or verified before final submission.'));
                    return {
                        status: 'SKIPPED',
                        reason: 'RESUME_NOT_VERIFIED',
                        message: 'Application halted: Resume was not uploaded or verified before final submission',
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }

                console.log(chalk.green(`  Identified final submission action: "${finalSubmitText}"`));
                const submissionGate = await confirmAndExecuteSubmission({
                    dryRun,
                    job,
                    resumeUsed: selectedResume?.fileName,
                    destination: 'Generic ATS',
                    actionName: `External Form "${finalSubmitText}" Button`,
                    execute: async () => {
                        console.log(chalk.yellow(`  Clicking submit button: "${finalSubmitText}"...`));
                        await finalSubmitBtn.scrollIntoViewIfNeeded().catch(() => {});
                        await finalSubmitBtn.click({ force: true });
                        return { status: 'CLICKED' };
                    },
                    promptFn: options.promptFn,
                    isInteractive: options.isInteractive
                });

                if (!submissionGate.actionExecuted && !submissionGate.submitted) {
                    return submissionGate;
                }

                // Post-submission verification
                await randomDelay(4000, 6000);
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                const postVerification = await checkSubmissionConfirmation(page);

                // Check validation errors
                const validationError = await page.evaluate(() => {
                    const errorEls = document.querySelectorAll('.error, .error-message, [class*="error-message"], [class*="errorMessage"], [aria-invalid="true"], .invalid-feedback, .field-error');
                    for (const el of errorEls) {
                        if (el.offsetParent !== null && el.innerText.trim()) return el.innerText.trim();
                    }
                    return null;
                }).catch(() => null);

                // Save verification screenshot
                const screenshotPath = path.resolve(__dirname, `../screenshots/external-${Date.now()}.png`);
                if (!fs.existsSync(path.dirname(screenshotPath))) {
                    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
                }
                await page.screenshot({ path: screenshotPath }).catch(() => {});
                console.log(chalk.gray(`  Screenshot saved to ${screenshotPath}`));

                if (validationError) {
                    console.log(chalk.red(`  ⚠️ Form submission blocked by validation error: "${validationError}"`));
                    return {
                        status: 'FAILED',
                        reason: 'VALIDATION_ERROR',
                        message: `External form validation error: ${validationError}`,
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }

                if (postVerification.isVerified) {
                    console.log(chalk.green.bold('  🎉 SUCCESS: External application submitted and verified!'));
                    return {
                        status: 'SUCCESS',
                        verified: true,
                        message: 'Submitted and verified on company career site',
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }

                // If unverified: Prompt Human Intervention
                console.log(chalk.red.bold('  ⚠️ Submission clicked, but confirmation evidence was not detected automatically. Prompting human intervention...'));
                const { promptHumanIntervention } = require('../ai/humanIntervention');
                const verifyPrompt = await promptHumanIntervention({
                    question: `Application was submitted, but confirmation evidence was not detected automatically. Did the application successfully complete in the browser?`,
                    type: 'dropdown',
                    options: ['Yes, application succeeded', 'No, submission failed or unverified'],
                    job,
                    reason: 'Submission confirmation evidence not detected automatically.',
                    promptFn: options.promptFn,
                    isInteractive: options.isInteractive
                });

                if (verifyPrompt.answered && verifyPrompt.value.toLowerCase().includes('yes')) {
                    console.log(chalk.green.bold('  🎉 SUCCESS: Human verified that application submitted successfully!'));
                    return {
                        status: 'SUCCESS',
                        verified: true,
                        message: 'External application submitted and human verified',
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }

                return {
                    status: 'FAILED',
                    reason: 'SUBMISSION_NOT_VERIFIED',
                    verified: false,
                    message: 'Application submission could not be verified on destination site',
                    resumeUsed: selectedResume?.fileName,
                    externalUrl: page.url()
                };
            }

            // EXECUTE: NEXT STEP BUTTON
            if (nextStepBtn) {
                const preClickUrl = page.url();
                console.log(chalk.cyan(`  Advancing to next step: clicking "${nextStepText}"...`));
                await nextStepBtn.scrollIntoViewIfNeeded().catch(() => {});
                await nextStepBtn.click({ force: true });
                await randomDelay(2500, 4000);
                await page.waitForLoadState('domcontentloaded').catch(() => {});

                // Check if advancing stepped directly into confirmation
                const stepConfirmation = await checkSubmissionConfirmation(page);
                if (stepConfirmation.isVerified) {
                    console.log(chalk.green.bold('  🎉 SUCCESS: External application submitted and verified!'));
                    return {
                        status: 'SUCCESS',
                        verified: true,
                        message: 'Submitted and verified on company career site',
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }

                // Loop detection: if the page URL hasn't changed after clicking Next, track stagnation
                const postClickUrl = page.url();
                if (postClickUrl === preClickUrl && postClickUrl === lastStepUrl) {
                    stagnantStepCount++;
                    console.log(chalk.yellow(`  ⚠️ Page did not change after clicking "${nextStepText}" (stagnant: ${stagnantStepCount}/3)`));
                    if (stagnantStepCount >= 3) {
                        console.log(chalk.red('  ❌ Application stuck: Clicking "Continue" is not advancing the form. Aborting.'));
                        return {
                            status: 'FAILED',
                            reason: 'STEPPER_LOOP_DETECTED',
                            message: `Application form stuck: clicking "${nextStepText}" did not advance after ${stagnantStepCount} attempts`,
                            resumeUsed: selectedResume?.fileName,
                            externalUrl: page.url()
                        };
                    }
                } else {
                    stagnantStepCount = 0;
                }
                lastStepUrl = postClickUrl;

                currentStep++;
                continue;
            }

            // NO ACTION BUTTON FOUND: Prompt Human Intervention
            console.log(chalk.yellow('  ⚠️ Neither submit nor next button identified on current step.'));
            const { promptHumanIntervention } = require('../ai/humanIntervention');
            const manualActionRes = await promptHumanIntervention({
                question: `Automation could not find the Next or Submit button on Step ${currentStep} for ${job.company || 'this application'}. Please complete this step or advance in the browser window, then press Enter (or type "cancel" to abort).`,
                type: 'action',
                job,
                reason: 'No clear submit or next button located on page.',
                promptFn: options.promptFn,
                isInteractive: options.isInteractive
            });

            if (!manualActionRes.answered) {
                return {
                    status: 'SKIPPED',
                    reason: 'SUBMISSION_NOT_VERIFIED',
                    message: 'No explicit submit or next button found on application page',
                    resumeUsed: selectedResume?.fileName,
                    externalUrl: page.url()
                };
            }

            await randomDelay(2000, 3000);
            const manualConfirmation = await checkSubmissionConfirmation(page);
            if (manualConfirmation.isVerified) {
                return {
                    status: 'SUCCESS',
                    verified: true,
                    message: 'External application completed and verified',
                    resumeUsed: selectedResume?.fileName,
                    externalUrl: page.url()
                };
            }

            currentStep++;
        }

        // Exceeded MAX_STEPS without reaching final submission
        return {
            status: 'FAILED',
            reason: 'MAX_STEPS_EXCEEDED',
            message: `Reached maximum application steps limit (${MAX_STEPS}) without final confirmation`,
            resumeUsed: selectedResume?.fileName,
            externalUrl: page.url()
        };

    } catch (err) {
        console.error(chalk.red(`  ❌ External application error: ${err.message}`));
        return {
            status: 'FAILED',
            reason: 'AUTOMATION_ERROR',
            message: `External application error: ${err.message}`,
            resumeUsed: selectedResume?.fileName,
            externalUrl: page.url()
        };
    }
}

module.exports = {
    handleExternalApplication,
    handleZohoRecruitApplication,
    checkLoginWall,
    tryLoginWallBypass,
    checkCaptcha,
    expandAllSections,
    attachResumeSafely,
    handleDropdowns,
    getTrustedDropdownAnswer
};
