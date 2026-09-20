const { getAnswer, promptUser, findLearnedAnswer } = require('../ai/answerEngine');
const { randomDelay } = require('./utils');
const { selectResumeForJob } = require('./resumeSelector');
const profile = require('../config/profile');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { confirmAndExecuteSubmission } = require('../application/safetyBoundary');

/**
 * Helper to find authentication input fields in Workday.
 * Resilient to dynamic IDs, custom containers, and missing/incorrect labels.
 */
async function findAuthInput(page, labelRegex, typeSelector, automationId) {
    // Strategy 1: Standard data-automation-id (Highly robust for Workday!)
    if (automationId) {
        const byAutoId = page.locator(`[data-automation-id="${automationId}"], [data-automation-id="${automationId}Input"]`).first();
        try {
            await byAutoId.waitFor({ state: 'visible', timeout: 3000 });
            const tag = await byAutoId.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
                return byAutoId;
            }
            const inner = byAutoId.locator('input, textarea, [role="textbox"]').first();
            if (await inner.isVisible().catch(() => false)) {
                return inner;
            }
        } catch (e) {}
    }

    // Strategy 2: Standard getByLabel
    try {
        let byLabel = page.getByLabel(labelRegex).first();
        await byLabel.waitFor({ state: 'visible', timeout: 2000 });
        const tag = await byLabel.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
            return byLabel;
        }
        const inner = byLabel.locator('input, textarea, [role="textbox"]').first();
        if (await inner.isVisible().catch(() => false)) {
            return inner;
        }
    } catch (e) {}

    // Strategy 3: Type selector fallback
    const fallback = page.locator(typeSelector).first();
    try {
        await fallback.waitFor({ state: 'visible', timeout: 2000 });
        return fallback;
    } catch (e) {}

    return null;
}

/**
 * Specialized handler for Workday (external) applications.
 */
async function handleWorkdayApplication(page, jobUrl, jobOrResume = null, options = {}) {
    const dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    console.log(chalk.magenta.bold(`\n--- ENTERING WORKDAY AUTOMATION ---`));

    const USER_EMAIL = process.env.WORKDAY_USERNAME || 'YOUR_WORKDAY_USERNAME'; // Replace with your actual Workday username or use environment variables for security
    const USER_PWD = process.env.WORKDAY_PASSWORD || 'YOUR_WORKDAY_PASSWORD'; // Replace with your actual password or use environment variables for security

    // Resolve resume using project's real resume-selection system
    let selectedResume = null;
    if (jobOrResume && typeof jobOrResume === 'object' && jobOrResume.path && fs.existsSync(jobOrResume.path)) {
        selectedResume = jobOrResume;
    } else if (jobOrResume && typeof jobOrResume === 'object') {
        selectedResume = selectResumeForJob(jobOrResume);
    } else {
        selectedResume = selectResumeForJob({});
    }

    const RESUME_PATH = selectedResume && selectedResume.path && fs.existsSync(selectedResume.path)
        ? selectedResume.path
        : null;

    if (!RESUME_PATH) {
        console.log(chalk.red.bold(`  ❌ WORKDAY BLOCKED: Required resume file not found on disk: "${selectedResume?.path || 'unknown'}".`));
        return {
            status: 'BLOCKED',
            reason: 'MISSING_REQUIRED_DATA',
            message: `Required resume file not found on disk at: ${selectedResume?.path || 'unknown'}`,
            resumeUsed: selectedResume?.fileName || 'MISSING'
        };
    } else {
        console.log(chalk.gray(`  [Workday] Using verified resume: "${path.basename(RESUME_PATH)}"`));
    }

    const jobContext = (jobOrResume && (jobOrResume.title || jobOrResume.company)) ? jobOrResume : { title: 'Workday Role', company: 'Workday Employer', applicationUrl: jobUrl };

    try {
        // Check if the page is missing or job doesn't exist
        const pageNotExistText = page.locator('text=/page you are looking for doesn\'t exist|doesn\'t exist|no longer available|no longer active|page not found/i').first();
        if (await pageNotExistText.isVisible().catch(() => false)) {
            console.log(chalk.red.bold('  ❌ WORKDAY ERROR: Job page does not exist or is no longer available. Skipping!'));
            return { status: 'FAILED', message: 'Job page does not exist' };
        }

        // 1. Navigation Flow
        const applyBtn = page.getByRole('button', { name: /apply/i }).first();
        try {
            await applyBtn.waitFor({ state: 'visible', timeout: 15000 });
            console.log(chalk.cyan('  Clicking initial "Apply" button...'));
            await applyBtn.click();
            await randomDelay(2000, 3000);
        } catch (e) {
            console.log(chalk.yellow('  Initial "Apply" button not found or already bypassed.'));
        }

        const manualApply = page.getByRole('button', { name: /apply manually/i }).first();
        try {
            await manualApply.waitFor({ state: 'visible', timeout: 8000 });
            console.log(chalk.cyan('  Selecting "Apply Manually"...'));
            await manualApply.click();
            await randomDelay(5000, 8000);
        } catch (e) {
            // Might already be on form/login or another state
        }

        // Handle "Sign in with email" gateway if present
        const emailSignInBtn = page.locator('button:has-text("Sign in with email"), a:has-text("Sign in with email"), [aria-label*="Sign in with email"], [class*="email" i][role="button"]').first();
        if (await emailSignInBtn.isVisible().catch(() => false)) {
            console.log(chalk.cyan('  "Sign in with email" screen detected. Clicking button...'));
            await emailSignInBtn.click({ force: true }).catch(async () => {
                await emailSignInBtn.evaluate(el => el.click()).catch(() => {});
            });
            await randomDelay(5000, 7000);
        }

        // 2. Authentication Loop
        let authAttempts = 0;
        while (authAttempts < 5) {
            if (await isFormPage(page).catch(() => false)) {
                console.log(chalk.green('  Direct Form Page detected (No sign-in required or already signed in). Proceeding directly to fill fields!'));
                break;
            }

            authAttempts++;
            await randomDelay(4000, 6000);

            // Use the ultra-robust helper to find input fields
            const emailInput = await findAuthInput(page, /email address|user name/i, 'input[type="email"], input[type="text"]', 'email');
            const pwdInput = await findAuthInput(page, /^password/i, 'input[type="password"]', 'password');
            
            // Strictly look for verifyPasswordInput to distinguish Create Account from Sign In
            const verifyPwdInput = page.locator('[data-automation-id="verifyPasswordInput"], [data-automation-id="verifyPassword"]').first();

            if (emailInput && await emailInput.isVisible().catch(() => false)) {
                console.log(chalk.cyan(`  Auth Screen Detected (Attempt ${authAttempts}).`));
                
                console.log(chalk.green(`    -> Typing Email: ${USER_EMAIL}`));
                await emailInput.focus().catch(() => {});
                await emailInput.fill(USER_EMAIL);
                await emailInput.dispatchEvent('change').catch(() => {});
                await emailInput.dispatchEvent('blur').catch(() => {});
                await emailInput.blur().catch(() => {});
                
                if (pwdInput && await pwdInput.isVisible()) {
                    console.log(chalk.green('    -> Typing Password...'));
                    await pwdInput.focus().catch(() => {});
                    await pwdInput.fill(USER_PWD);
                    await pwdInput.dispatchEvent('change').catch(() => {});
                    await pwdInput.dispatchEvent('blur').catch(() => {});
                    await pwdInput.blur().catch(() => {});
                }
                
                // Uniquely detect Create Account by checking if the verify password field is visible
                const isCreateAccount = await verifyPwdInput.isVisible().catch(() => false);
                if (isCreateAccount) {
                    console.log(chalk.green('    -> Mode: Create Account'));
                    await verifyPwdInput.focus().catch(() => {});
                    await verifyPwdInput.fill(USER_PWD);
                    await verifyPwdInput.dispatchEvent('change').catch(() => {});
                    await verifyPwdInput.dispatchEvent('blur').catch(() => {});
                    await verifyPwdInput.blur().catch(() => {});
                    
                    const agreeCheck = page.locator('input[type="checkbox"], [data-automation-id="agreementCheckbox"]').first();
                    const agreeLabel = page.locator('label:has-text("agree"), label:has-text("I agree"), [data-automation-id="agreementCheckbox"] label').first();
                    
                    if (await agreeCheck.isVisible()) {
                        await agreeCheck.check({ force: true }).catch(async () => {
                            await agreeCheck.click({ force: true }).catch(() => {});
                        });
                    } else if (await agreeLabel.isVisible()) {
                        await agreeLabel.click({ force: true }).catch(() => {});
                    }
                } else {
                    console.log(chalk.green('    -> Mode: Sign In'));
                }

                // SUBMIT BUTTON LOCATOR (Primary is the native submit button to trigger HTML form action)
                const submitBtn = isCreateAccount ? 
                    page.locator('[data-automation-id="createAccountSubmitButton"], [data-automation-id="createAccountButton"], button:has-text("Create Account")').first() :
                    page.locator('[data-automation-id="signInSubmitButton"], [data-automation-id="signInButton"], button:has-text("Sign In")').first();

                if (await submitBtn.count() > 0) {
                    const btnText = isCreateAccount ? 'Create Account' : 'Sign In';
                    console.log(chalk.yellow(`    -> Clicking "${btnText}"...`));
                    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
                    
                    // 1. Click native button (trigger HTML submit)
                    await submitBtn.click({ force: true }).catch(async () => {
                        await submitBtn.evaluate(el => el.click()).catch(() => {});
                    });

                    // 2. Click transparent overlay div (trigger React event handlers)
                    const overlayBtn = page.locator(`[data-automation-id="click_filter"][aria-label="${btnText}"]`).first();
                    if (await overlayBtn.count() > 0) {
                        await overlayBtn.click({ force: true }).catch(() => {});
                    }
                    
                    await randomDelay(8000, 12000);
                }

                // Save a screenshot for visual diagnostics
                const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
                if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
                const screenshotPath = path.resolve(screenshotsDir, `auth_attempt_${authAttempts}.png`);
                await page.screenshot({ path: screenshotPath }).catch(() => {});
                console.log(chalk.gray(`    [Diagnostic] Screenshot saved to: ${screenshotPath}`));

                // Check for errors (e.g., account already exists or invalid credentials)
                if (await errorAlert(page)) {
                    const errText = await getErrorText(page);
                    console.log(chalk.red(`    ❌ Auth Error: ${errText}`));
                    if (errText.toLowerCase().includes('already exists') || errText.toLowerCase().includes('sign in')) {
                         const signInLink = page.locator('button:has-text("Sign In"), a:has-text("Sign In"), [role="button"]:has-text("Sign In")').first();
                         if (await signInLink.isVisible().catch(() => false)) {
                             console.log(chalk.yellow('    -> Switching to Sign In...'));
                             await signInLink.click({ force: true }).catch(() => {});
                             await randomDelay(3000, 5000);
                             continue;
                         }
                    } else if (errText.toLowerCase().includes('incorrect') || errText.toLowerCase().includes('invalid') || errText.toLowerCase().includes('not found') || errText.toLowerCase().includes('cannot find')) {
                         const createAccountLink = page.locator('button:has-text("Create Account"), a:has-text("Create Account"), [role="button"]:has-text("Create Account"), button:has-text("Register"), a:has-text("Register")').first();
                         if (await createAccountLink.isVisible().catch(() => false)) {
                             console.log(chalk.yellow('    -> Sign In failed. Switching to Create Account...'));
                             await createAccountLink.click({ force: true }).catch(() => {});
                             await randomDelay(3000, 5000);
                             continue;
                         }
                    }
                }

                // Check for OTP / Security Verification Code
                const otpInput = page.locator('input[aria-label*="Verification Code" i], input[aria-label*="One-Time" i], input[placeholder*="code" i], input[placeholder*="OTP" i], input[data-automation-id="verificationCodeInput"], [data-automation-id="verificationCode"] input, input[id*="otp" i]').first();
                if (await otpInput.isVisible().catch(() => false)) {
                    console.log(chalk.red.bold('\n--- SECURITY VERIFICATION (OTP) REQUIRED ---'));
                    console.log(chalk.yellow('Workday has requested a verification code / one-time passcode.'));
                    console.log(chalk.cyan('Please check your email and type the OTP code here:'));
                    
                    const code = await promptUser();
                    if (code) {
                        console.log(chalk.green(`    -> Typing Verification Code: "${code}"`));
                        await otpInput.focus();
                        await otpInput.fill(code);
                        await otpInput.dispatchEvent('change');
                        
                        const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), [data-automation-id="verifyButton"]').first();
                        if (await verifyBtn.isVisible().catch(() => false)) {
                            console.log(chalk.yellow('    -> Clicking Verify/Submit button...'));
                            await verifyBtn.click();
                        } else {
                            await page.keyboard.press('Enter');
                        }
                        await randomDelay(8000, 12000);
                    }
                }

                if (await isFormPage(page)) break;
            } else {
                if (await isFormPage(page)) break;
                console.log(chalk.gray('  Waiting for page content...'));
            }
        }

        // 2.5 Candidate Home & Modal Redirection Check (Self-Healing Resumption)
        const modalContinue = page.locator('button:has-text("Continue Application"), button:has-text("Go to Candidate Home")').first();
        if (await modalContinue.isVisible().catch(() => false)) {
            console.log(chalk.cyan('  Modal overlay detected. Clicking to continue draft...'));
            await modalContinue.click();
            await randomDelay(4000, 6000);
        }

        if (page.url().includes('/userHome')) {
            console.log(chalk.cyan('  Detected Candidate Home page. Finding active draft applications...'));
            const continueBtn = page.getByRole('button', { name: /continue application/i }).first();
            const actionBtn = page.getByRole('button', { name: /actions/i }).first();
            
            if (await continueBtn.isVisible().catch(() => false)) {
                console.log(chalk.green('    -> Clicking "Continue Application"'));
                await continueBtn.click();
            } else if (await actionBtn.isVisible().catch(() => false)) {
                console.log(chalk.green('    -> Clicking "Actions" button'));
                await actionBtn.click();
                await randomDelay(1500, 2500);
                const continueOption = page.getByRole('menuitem', { name: /continue/i }).first();
                if (await continueOption.isVisible().catch(() => false)) {
                    console.log(chalk.green('    -> Clicking "Continue" from actions menu'));
                    await continueOption.click();
                }
            }
            await randomDelay(5000, 8000);
        }

        // 3. Main Multi-Page Form Loop
        console.log(chalk.yellow('\n  Starting form automation...'));
        let sectionsCompleted = 0;
        let lastHeader = '';
        let lastUrl = '';
        let samePageCount = 0;

        while (sectionsCompleted < 15) {
            sectionsCompleted++;
            await randomDelay(3000, 5000);

            // Check if the page is missing or job doesn't exist during loop transition
            const pageNotExistText = page.locator('text=/page you are looking for doesn\'t exist|doesn\'t exist|no longer available|no longer active|page not found/i').first();
            if (await pageNotExistText.isVisible().catch(() => false)) {
                console.log(chalk.red.bold('  ❌ WORKDAY ERROR: Job page does not exist or is no longer available. Skipping!'));
                return { status: 'FAILED', message: 'Job page does not exist' };
            }

            try {
                // Wait resiliently for ANY visible form container or header using Promise.any
                await Promise.any([
                    page.locator('[data-automation-id="formField"]').first().waitFor({ state: 'visible', timeout: 20000 }),
                    page.locator('[data-automation-id="file-upload-drop-zone"]').first().waitFor({ state: 'visible', timeout: 20000 }),
                    page.locator('[data-automation-id="pageHeader"]').first().waitFor({ state: 'visible', timeout: 20000 }),
                    page.locator('h2').first().waitFor({ state: 'visible', timeout: 20000 })
                ]);
            } catch (e) {
                console.log(chalk.red(`    [Debug] Form loop wait failed: ${e.message}`));

                // Capture high-fidelity diagnostic screenshot on timeout/exit
                const timeoutDir = path.resolve(process.cwd(), 'screenshots');
                if (!fs.existsSync(timeoutDir)) fs.mkdirSync(timeoutDir, { recursive: true });
                const timeoutPath = path.resolve(timeoutDir, `form_timeout_${sectionsCompleted}.png`);
                await page.screenshot({ path: timeoutPath }).catch(() => {});
                console.log(chalk.red(`    [Timeout] Saved diagnostic screenshot to: ${timeoutPath}`));

                if (await isSuccessPage(page)) {
                    console.log(chalk.green.bold('  ✔ WORKDAY APPLICATION SUCCESS!'));
                    return { status: 'SUCCESS', message: 'Workday submitted' };
                }
                break;
            }

            const sectionHeaderRaw = await page.locator('h2, h1, [data-automation-id="pageHeader"]').first().innerText().catch(() => `Section ${sectionsCompleted}`);
            const sectionHeader = sectionHeaderRaw.trim();
            const currentUrl = page.url();

            if (sectionHeader === lastHeader && currentUrl === lastUrl) {
                samePageCount++;
                if (samePageCount > 3) {
                    console.log(chalk.red.bold(`\n  ⚠️ Stuck on the same section "${sectionHeader}" for more than 3 attempts.`));
                    console.log(chalk.yellow('  There is likely an unfilled required field or a validation error blocking submission.'));
                    console.log(chalk.cyan('  Halting automated clicking for manual intervention. Please check the browser, fix the issue, and press Enter here to resume...'));
                    await promptUser();
                    samePageCount = 0;
                }
            } else {
                samePageCount = 0;
                lastHeader = sectionHeader;
                lastUrl = currentUrl;
            }

            console.log(chalk.blue(`\n  [Section ${sectionsCompleted}] - ${sectionHeader}`));

            // Resume Upload - Bulletproof matching of files
            const fileInputs = await page.locator('input[type="file"]').all();
            for (const fileInput of fileInputs) {
                const parentText = await fileInput.locator('xpath=./ancestor::*[contains(@data-automation-id, "file-upload") or contains(@class, "upload")]').first().innerText().catch(() => '');
                const isResume = parentText.toLowerCase().includes('resume') || parentText.toLowerCase().includes('cv') || parentText === '' || fileInputs.length === 1;
                
                if (isResume) {
                    const alreadyUploaded = await page.locator('[data-automation-id="file-upload-item-name"], [data-automation-id="file-upload-item"]').first().isVisible().catch(() => false);
                    if (!alreadyUploaded && RESUME_PATH) {
                        console.log(chalk.green(`    -> Uploading Resume: ${path.basename(RESUME_PATH)}`));
                        await fileInput.setInputFiles(RESUME_PATH);
                        await randomDelay(6000, 10000);
                    }
                    break;
                }
            }

            // Fill page fields
            await fillWorkdayForm(page);

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await randomDelay(2000, 3000);

            const nextBtn = page.locator('button:has-text("Save and Continue"), button:has-text("Next"), button:has-text("Submit"), [data-automation-id="bottom-navigation-next-button"]').first();
            try {
                await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
            } catch (e) {}

            if (await nextBtn.isVisible()) {
                const btnText = (await nextBtn.innerText()).trim();
                const isFinalSubmit = /submit/i.test(btnText) || sectionHeader.toLowerCase().includes('review');

                if (isFinalSubmit) {
                    const submissionGate = await confirmAndExecuteSubmission({
                        dryRun,
                        job: jobContext,
                        resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined,
                        destination: 'Workday ATS',
                        actionName: `Workday Final "${btnText}" Button`,
                        execute: async () => {
                            console.log(chalk.yellow(`  Clicking "${btnText}"...`));
                            await nextBtn.click();
                            await randomDelay(6000, 10000);
                            const verified = await isSuccessPage(page);
                            if (verified) {
                                return {
                                    status: 'SUCCESS',
                                    verified: true,
                                    message: 'Workday submitted',
                                    resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined
                                };
                            }
                            return {
                                status: 'FAILED',
                                reason: 'SUBMISSION_NOT_VERIFIED',
                                verified: false,
                                message: 'Workday submission could not be verified on confirmation page',
                                resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined
                            };
                        },
                        promptFn: options.promptFn,
                        isInteractive: options.isInteractive
                    });
                    return submissionGate;
                }

                console.log(chalk.yellow(`  Clicking "${btnText}"...`));
                await nextBtn.click();
                await randomDelay(6000, 10000);
            } else {
                if (await isSuccessPage(page)) {
                    console.log(chalk.green.bold('  ✔ WORKDAY APPLICATION SUCCESS!'));
                    return { status: 'SUCCESS', verified: true, message: 'Workday submitted' };
                }
                
                // Retry check in case of slow page renders
                await randomDelay(3000, 5000);
                if (await nextBtn.isVisible()) {
                    const btnText = (await nextBtn.innerText()).trim();
                    const isFinalSubmit = /submit/i.test(btnText) || sectionHeader.toLowerCase().includes('review');

                    if (isFinalSubmit) {
                        const submissionGate = await confirmAndExecuteSubmission({
                            dryRun,
                            job: jobContext,
                            resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined,
                            destination: 'Workday ATS',
                            actionName: `Workday Final "${btnText}" Button`,
                            execute: async () => {
                                console.log(chalk.yellow(`  Clicking "${btnText}"...`));
                                await nextBtn.click();
                                await randomDelay(6000, 10000);
                                const verified = await isSuccessPage(page);
                                if (verified) {
                                    return {
                                        status: 'SUCCESS',
                                        verified: true,
                                        message: 'Workday submitted',
                                        resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined
                                    };
                                }
                                return {
                                    status: 'FAILED',
                                    reason: 'SUBMISSION_NOT_VERIFIED',
                                    verified: false,
                                    message: 'Workday submission could not be verified on confirmation page',
                                    resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined
                                };
                            },
                            promptFn: options.promptFn,
                            isInteractive: options.isInteractive
                        });
                        return submissionGate;
                    }

                    console.log(chalk.yellow(`  Clicking "${btnText}"...`));
                    await nextBtn.click();
                    await randomDelay(6000, 10000);
                    continue;
                }
                
                if (await isSuccessPage(page)) {
                    return { status: 'SUCCESS', verified: true, message: 'Workday submitted' };
                }
                
                console.log(chalk.red('    [Error] Form flow interrupted: Next button not found, and not on success page.'));
                return { status: 'FAILED', reason: 'SUBMISSION_NOT_VERIFIED', message: 'Form flow interrupted prematurely.' };
            }
        }

        if (dryRun) {
            return await confirmAndExecuteSubmission({
                dryRun: true,
                job: jobContext,
                resumeUsed: RESUME_PATH ? path.basename(RESUME_PATH) : undefined,
                destination: 'Workday ATS',
                actionName: 'Workday Review/Submit Boundary',
                execute: async () => ({ status: 'SUCCESS' })
            });
        }
        
        if (await isSuccessPage(page)) {
            return { status: 'SUCCESS', verified: true, message: 'Workday submitted successfully' };
        }
        return { status: 'FAILED', reason: 'SUBMISSION_NOT_VERIFIED', verified: false, message: 'Workday automation reached end of detected forms without verified submission.' };

    } catch (err) {
        console.error(chalk.red(`  ❌ Workday Error: ${err.message}`));
        return { status: 'FAILED', message: err.message };
    }
}

async function isFormPage(page) {
    const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (hasPassword) return false;
    return await page.locator('h2:has-text("My Information"), [data-automation-id="contactInformationSection"], [data-automation-id^="formField-"]').first().isVisible();
}

async function isSuccessPage(page) {
    return await page.locator('text=/congratulations|submitted|thank you/i').first().isVisible();
}

async function errorAlert(page) {
    return await page.locator('[data-automation-id="errorBanner"], .alert-danger, .css-1dbjc4n:has-text("Invalid")').first().isVisible();
}

async function getErrorText(page) {
    return (await page.locator('[data-automation-id="errorBanner"], .alert-danger, .css-1dbjc4n:has-text("Invalid")').first().innerText()).catch(() => 'Unknown Error');
}

async function fillWorkdayForm(page) {

    // ── Personal / address constants (derived dynamically from profile.json) ───
    const FULL_NAME      = profile.fullName || '';
    const FAMILY_NAME    = profile.lastName || '';
    const GIVEN_NAME     = profile.firstName || '';
    const ADDR_LINE_1    = profile.address?.street || '';
    const CITY           = profile.address?.city || profile.currentLocation || '';
    const POSTAL_CODE    = profile.address?.zipCode || profile.postalCode || '';
    const PHONE_NUMBER   = (profile.mobile || '').replace(/^\+91\s*/, '');

    // ── Helper: is this field required (red *)? ────────────────────────────────
    async function isFieldRequired(container) {
        return container.evaluate(el => {
            // 1. Label / legend text contains '*'
            const label = el.querySelector('label, [data-automation-id="formField-label"], legend');
            if (label && label.innerText.includes('*')) return true;

            // 2. Explicit required-indicator elements
            const reqEl = el.querySelector(
                '[class*="required" i], [aria-label*="required" i], ' +
                '[title*="required" i], abbr[title="required" i]'
            );
            if (reqEl) return true;

            // 3. Native HTML / ARIA attributes on the input
            const input = el.querySelector(
                'input, textarea, select, [role="combobox"], [role="button"], button'
            );
            if (input) {
                if (input.hasAttribute('required') ||
                    input.getAttribute('aria-required') === 'true' ||
                    input.getAttribute('aria-invalid') === 'true') return true;
            }
            return false;
        }).catch(() => false);
    }

    // ── Helper: type into a text input (fill + blur to trigger React) ──────────
    async function typeInto(input, value) {
        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click({ force: true }).catch(() => {});
        await input.fill('');
        await input.fill(value);
        await input.dispatchEvent('input').catch(() => {});
        await input.dispatchEvent('change').catch(() => {});
        await input.blur().catch(() => {});
        await randomDelay(400, 700);
    }

    // ── Helper: pick from a Workday two-tier dropdown (e.g. "How Did You Hear") ─
    // Clicks the trigger, then finds the top-level item, then finds sub-item.
    async function selectTwoLevelDropdown(trigger, topText, subText) {
        await trigger.click({ force: true }).catch(() => {});
        await randomDelay(1200, 2000);

        // Level 1 – find and click the top category (e.g. "Job Board")
        const lvl1Items = await page.locator('[role="option"], [data-automation-id="menuItem"]').all();
        let topItem = null;
        for (const item of lvl1Items) {
            const txt = (await item.innerText().catch(() => '')).trim().toLowerCase();
            if (txt.includes(topText.toLowerCase())) { topItem = item; break; }
        }
        if (!topItem) {
            console.log(chalk.yellow(`    ⚠️  "${topText}" not found in dropdown, pressing Escape.`));
            await page.keyboard.press('Escape');
            return false;
        }
        await topItem.click({ force: true }).catch(() => {});
        await randomDelay(1200, 2000);

        // Level 2 – find sub-item (e.g. "Naukri", "Job Board - Naukri")
        const lvl2Items = await page.locator('[role="option"], [data-automation-id="menuItem"]').all();
        let subItem = null;
        for (const item of lvl2Items) {
            const txt = (await item.innerText().catch(() => '')).trim().toLowerCase();
            if (txt.includes(subText.toLowerCase())) { subItem = item; break; }
        }

        if (subItem) {
            await subItem.click({ force: true }).catch(() => {});
            await randomDelay(800, 1400);
            return true;
        }

        // Sub-item not found – try "Other" / first option
        const fallback = lvl2Items[0];
        if (fallback) {
            const fallbackTxt = (await fallback.innerText().catch(() => '')).trim();
            console.log(chalk.yellow(`    ⚠️  "${subText}" not found — picking fallback: "${fallbackTxt}"`));
            await fallback.click({ force: true }).catch(() => {});
            await randomDelay(800, 1400);
            return true;
        }

        await page.keyboard.press('Escape');
        return false;
    }

    // ── Helper: single-level select with text search ───────────────────────────
    async function selectDropdownOption(trigger, searchText) {
        await trigger.click({ force: true }).catch(() => {});
        await randomDelay(1000, 1600);

        // Try typing in any search box inside the open dropdown
        const searchInput = page.locator(
            'input[role="searchbox"], [role="combobox"] input, [role="listbox"] input, input[placeholder*="Search" i]'
        ).first();
        if (await searchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
            await searchInput.fill(searchText);
            await randomDelay(1200, 2000);
        }

        // Find option by text (diacritics-insensitive)
        const clean = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        const searchClean = clean(searchText);
        const optionEls = await page.locator('[role="option"], [data-automation-id="menuItem"]').all();
        let found = null;
        for (const opt of optionEls) {
            const txt = clean(await opt.innerText().catch(() => ''));
            if (txt === searchClean || txt.includes(searchClean) || searchClean.includes(txt)) {
                found = opt; break;
            }
        }
        if (found) {
            await found.click({ force: true }).catch(() => {});
            await randomDelay(800, 1400);
            return true;
        }
        await page.keyboard.press('Escape');
        return false;
    }

    // ── Expand section stubs (Work Experience, Education, Language) ────────────
    const addSectionSelectors = [
        { name: 'Education',       selector: '[data-automation-id="addEducation"], button:has-text("Add Education")',             checkSelector: 'input[id*="degree" i], [data-automation-id*="degree" i] input' },
        { name: 'Language',        selector: '[data-automation-id="addLanguage"], button:has-text("Add Language")',               checkSelector: '[data-automation-id*="language" i] input' },
        { name: 'Work Experience', selector: '[data-automation-id="addWorkExperience"], button:has-text("Add Work Experience")',   checkSelector: 'input[id*="company" i], [data-automation-id*="company" i] input' },
    ];
    for (const item of addSectionSelectors) {
        const addBtn = page.locator(item.selector).first();
        if (await addBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            const alreadyOpen = await page.locator(item.checkSelector).first().isVisible({ timeout: 500 }).catch(() => false);
            if (!alreadyOpen) {
                console.log(chalk.cyan(`    → Expanding "${item.name}" section...`));
                await addBtn.click();
                await randomDelay(1500, 2500);
            }
        }
    }

    // ── Walk every formField container ─────────────────────────────────────────
    const fieldContainers = await page.locator('[data-automation-id^="formField-"]').all();
    console.log(chalk.blue(`  Found ${fieldContainers.length} form field containers.`));

    for (const container of fieldContainers) {
        try {
            // Read label
            let labelText = await container.evaluate(el => {
                const label = el.querySelector('label, [data-automation-id="formField-label"], legend');
                if (label?.innerText.trim()) return label.innerText.trim();
                const input = el.querySelector('input, textarea, select, [role="combobox"]');
                return input?.getAttribute('aria-label') || input?.getAttribute('placeholder') || '';
            }).catch(() => '');

            if (!labelText) continue;
            const cleanLabel = labelText.replace(/\s+/g, ' ').trim(); // keep * for detection
            const labelLower = cleanLabel.toLowerCase();
            const required   = await isFieldRequired(container);

            // Always skip phone extension
            if (/phone extension|ext\./i.test(cleanLabel)) {
                console.log(chalk.gray(`    → Skip (extension): "${cleanLabel}"`));
                continue;
            }

            // ── ALWAYS ignore optional fields (no red *) ──────────────────────
            if (!required) {
                const isAgreement = /agree|consent|terms|policy|understand|acknowledge|declaration/i.test(cleanLabel);
                if (!isAgreement) {
                    console.log(chalk.gray(`    → Skip (optional, no *): "${cleanLabel}"`));
                    continue;
                }
            }

            console.log(chalk.cyan(`    → Processing required field: "${cleanLabel}"`));

            // ══════════════════════════════════════════════════════════════════
            // HARDCODED FIELD RULES — checked before any AI/manual fallback
            // ══════════════════════════════════════════════════════════════════

            // ── 1. "How Did You Hear About Us" → Job Board → Naukri ──────────
            if (/how did you hear|how did you find|source|hear about us/i.test(cleanLabel)) {
                const trigger = container.locator(
                    '[data-automation-id="selectControl"], [role="combobox"], [role="button"], button'
                ).first();
                if (await trigger.isVisible().catch(() => false)) {
                    console.log(chalk.green('    → "How Did You Hear About Us": selecting Job Board → Naukri...'));
                    const ok = await selectTwoLevelDropdown(trigger, 'Job Board', 'naukri');
                    if (!ok) {
                        // Fallback: pick "Other" at top level
                        await selectTwoLevelDropdown(trigger, 'Other', '');
                    }
                }
                continue;
            }

            // ── 2. Name fields ────────────────────────────────────────────────
            // Check if BOTH Given Name AND Family Name have red * on THIS page
            const familyNameContainer = await page.locator('[data-automation-id^="formField-"]')
                .filter({ hasText: /family name|last name|surname/i }).first();
            const familyNameRequired = await isFieldRequired(familyNameContainer).catch(() => false);

            if (/given name|first name/i.test(labelLower)) {
                const input = container.locator('input[type="text"], input:not([type])').first();
                if (await input.isVisible().catch(() => false)) {
                    const nameToType = familyNameRequired ? GIVEN_NAME : FULL_NAME;
                    console.log(chalk.green(`    → Given Name: "${nameToType}"`));
                    await typeInto(input, nameToType);
                }
                continue;
            }

            if (/family name|last name|surname/i.test(labelLower)) {
                const input = container.locator('input[type="text"], input:not([type])').first();
                if (await input.isVisible().catch(() => false)) {
                    console.log(chalk.green(`    → Family Name: "${FAMILY_NAME}"`));
                    await typeInto(input, FAMILY_NAME);
                }
                continue;
            }

            // ── 3. Address fields ─────────────────────────────────────────────
            if (/address line 1|street address 1/i.test(labelLower)) {
                const input = container.locator('input[type="text"], textarea').first();
                if (await input.isVisible().catch(() => false)) {
                    console.log(chalk.green(`    → Address Line 1: "${ADDR_LINE_1}"`));
                    await typeInto(input, ADDR_LINE_1);
                }
                continue;
            }

            if (/\bcity\b/i.test(labelLower) && !/city of birth/i.test(labelLower)) {
                const input = container.locator('input[type="text"], input:not([type])').first();
                if (await input.isVisible().catch(() => false)) {
                    console.log(chalk.green(`    → City: "${CITY}"`));
                    await typeInto(input, CITY);
                }
                continue;
            }

            if (/postal code|zip code|pin code/i.test(labelLower)) {
                const input = container.locator('input[type="text"], input[type="number"], input:not([type])').first();
                if (await input.isVisible().catch(() => false)) {
                    console.log(chalk.green(`    → Postal Code: "${POSTAL_CODE}"`));
                    await typeInto(input, POSTAL_CODE);
                }
                continue;
            }

            // ── 4. Phone Device Type → Personal / Mobile / Main ──────────────
            if (/phone device type|device type/i.test(labelLower)) {
                const trigger = container.locator(
                    '[data-automation-id="selectControl"], [role="combobox"], [role="button"], button'
                ).first();
                if (await trigger.isVisible().catch(() => false)) {
                    // Open dropdown, read options, pick "personal" or "mobile" or "main"
                    await trigger.click({ force: true }).catch(() => {});
                    await randomDelay(1000, 1600);
                    const optionEls = await page.locator('[role="option"], [data-automation-id="menuItem"]').all();
                    let chosen = null;
                    for (const opt of optionEls) {
                        const txt = (await opt.innerText().catch(() => '')).trim().toLowerCase();
                        if (/personal|mobile|main/i.test(txt)) { chosen = opt; break; }
                    }
                    if (!chosen && optionEls.length > 0) chosen = optionEls[0];
                    if (chosen) {
                        const txt = (await chosen.innerText().catch(() => '')).trim();
                        console.log(chalk.green(`    → Phone Device Type: "${txt}"`));
                        await chosen.click({ force: true }).catch(() => {});
                        await randomDelay(600, 1000);
                    } else {
                        await page.keyboard.press('Escape');
                    }
                }
                continue;
            }

            // ── 5. Country Phone Code → India (+91) ──────────────────────────
            if (/country phone code|phone country code|country code/i.test(labelLower)) {
                const trigger = container.locator(
                    '[data-automation-id="selectControl"], [role="combobox"], [role="button"], button'
                ).first();
                if (await trigger.isVisible().catch(() => false)) {
                    console.log(chalk.green('    → Country Phone Code: India (+91)'));
                    await selectDropdownOption(trigger, 'India');
                }
                continue;
            }

            // ── 6. Phone Number ───────────────────────────────────────────────
            if (/phone number|mobile number|telephone/i.test(labelLower) &&
                !/extension|device type|country/i.test(labelLower)) {
                const input = container.locator(
                    'input[type="tel"], input[type="text"], input[type="number"], input:not([type])'
                ).first();
                if (await input.isVisible().catch(() => false)) {
                    const currentVal = await input.inputValue().catch(() => '');
                    if (!currentVal.trim()) {
                        console.log(chalk.green(`    → Phone Number: "${PHONE_NUMBER}"`));
                        await typeInto(input, PHONE_NUMBER);
                    }
                }
                continue;
            }

            // ══════════════════════════════════════════════════════════════════
            // GENERIC REQUIRED-FIELD HANDLING (AI → manual fallback)
            // ══════════════════════════════════════════════════════════════════

            // A. Checkboxes (agreement, consent, etc.)
            const checkbox = container.locator('input[type="checkbox"], [role="checkbox"]').first();
            if (await checkbox.isVisible().catch(() => false)) {
                const isAgreement = /agree|consent|terms|policy|understand|acknowledge|declaration/i.test(cleanLabel);
                if (isAgreement) {
                    const isChecked = await checkbox.isChecked().catch(() => false);
                    if (!isChecked) {
                        console.log(chalk.green(`    → Checking agreement: "${cleanLabel}"`));
                        await checkbox.check({ force: true }).catch(() => checkbox.click({ force: true }).catch(() => {}));
                    }
                } else if (required) {
                    const answer = await getAnswer(cleanLabel.replace('*', '').trim(), ['Yes', 'No'], false, 'workday');
                    if (answer) {
                        const shouldCheck = /yes|true|agree|check/i.test(answer);
                        const isChecked = await checkbox.isChecked().catch(() => false);
                        if (shouldCheck && !isChecked) {
                            await checkbox.check({ force: true }).catch(() => checkbox.click({ force: true }).catch(() => {}));
                        } else if (!shouldCheck && isChecked) {
                            await checkbox.uncheck({ force: true }).catch(() => checkbox.click({ force: true }).catch(() => {}));
                        }
                    }
                }
                continue;
            }

            // B. Radio buttons
            const radios = await container.locator('[role="radio"], input[type="radio"]').all();
            if (radios.length > 0) {
                const radioOptions = [];
                for (const r of radios) {
                    let txt = await r.innerText().catch(() => '');
                    if (!txt.trim()) {
                        const id = await r.getAttribute('id').catch(() => null);
                        if (id) txt = await page.locator(`label[for="${id}"]`).innerText().catch(() => '');
                    }
                    if (!txt.trim()) txt = await r.locator('xpath=./ancestor::label').first().innerText().catch(() => '');
                    if (!txt.trim()) txt = await r.locator('xpath=../descendant::label').first().innerText().catch(() => '');
                    if (txt.trim() && !radioOptions.includes(txt.trim())) radioOptions.push(txt.trim());
                }
                const answer = await getAnswer(cleanLabel.replace('*', '').trim(), radioOptions, false, 'workday');
                if (answer) {
                    for (const r of radios) {
                        let txt = await r.innerText().catch(() => '');
                        if (!txt.trim()) {
                            const id = await r.getAttribute('id').catch(() => null);
                            if (id) txt = await page.locator(`label[for="${id}"]`).innerText().catch(() => '');
                        }
                        if (!txt.trim()) txt = await r.locator('xpath=./ancestor::label').first().innerText().catch(() => '');
                        const matchText = (txt + ' ' + (await r.getAttribute('value').catch(() => ''))).toLowerCase();
                        if (matchText.includes(answer.toLowerCase()) || answer.toLowerCase().includes(txt.toLowerCase().trim())) {
                            console.log(chalk.green(`    → ${cleanLabel} (Radio): "${txt.trim()}"`));
                            await r.click({ force: true });
                            await randomDelay(600, 1200);
                            break;
                        }
                    }
                }
                continue;
            }

            // C. Dropdowns
            const selectTrigger = container.locator(
                '[data-automation-id="selectControl"], [role="combobox"], [role="button"], button, input[placeholder*="Search" i]'
            ).first();
            const hasDateInput = await container.locator(
                'input[placeholder*="YYYY" i], input[placeholder*="MM" i], input[placeholder*="DD" i]'
            ).first().isVisible({ timeout: 500 }).catch(() => false);

            if (await selectTrigger.isVisible({ timeout: 500 }).catch(() => false) && !hasDateInput) {
                const currentVal = await selectTrigger.innerText().catch(() => '') ||
                                   await selectTrigger.inputValue().catch(() => '');
                if (currentVal && !/select|search/i.test(currentVal) && currentVal.trim()) {
                    console.log(chalk.gray(`    → Already filled: "${cleanLabel}" = "${currentVal.trim()}"`));
                    continue;
                }

                // Read available options
                await selectTrigger.click({ force: true }).catch(() => {});
                await randomDelay(1000, 1600);
                const optEls = await page.locator('[role="option"], [data-automation-id="menuItem"]').all();
                const detectedOptions = [];
                for (const o of optEls) {
                    const t = (await o.innerText().catch(() => '')).trim();
                    if (t && !detectedOptions.includes(t)) detectedOptions.push(t);
                }
                await page.keyboard.press('Escape');
                await randomDelay(600, 1000);

                const answer = await getAnswer(
                    cleanLabel.replace('*', '').trim(),
                    detectedOptions.length > 0 ? detectedOptions : ['Select option'],
                    false,
                    'workday'
                );
                if (answer) {
                    await selectDropdownOption(selectTrigger, answer);
                }
                continue;
            }

            // D. Date inputs
            const dateInput = container.locator(
                '[data-automation-id="dateSection"] input, input[placeholder*="yyyy" i], input[placeholder*="mm" i]'
            ).first();
            if (await dateInput.isVisible({ timeout: 500 }).catch(() => false)) {
                const answer = await getAnswer(cleanLabel.replace('*', '').trim(), [], false, 'workday');
                if (answer) {
                    console.log(chalk.green(`    → ${cleanLabel} (Date): "${answer}"`));
                    await dateInput.click({ force: true }).catch(() => {});
                    await dateInput.press('Control+A').catch(() => {});
                    await dateInput.fill(answer).catch(() => {});
                    await page.keyboard.press('Escape').catch(() => {});
                    await page.keyboard.press('Tab').catch(() => {});
                    await randomDelay(600, 1200);
                }
                continue;
            }

            // E. Text / email / tel inputs
            const textInput = container.locator(
                'input[type="text"], input[type="email"], input[type="tel"], textarea'
            ).first();
            if (await textInput.isVisible({ timeout: 500 }).catch(() => false)) {
                const currentVal = await textInput.inputValue().catch(() => '');
                if (currentVal.trim()) {
                    console.log(chalk.gray(`    → Already filled: "${cleanLabel}" = "${currentVal.trim()}"`));
                    continue;
                }
                const answer = await getAnswer(cleanLabel.replace('*', '').trim(), [], false, 'workday');
                if (answer) {
                    console.log(chalk.green(`    → ${cleanLabel}: "${answer}"`));
                    await typeInto(textInput, answer);
                }
                continue;
            }

        } catch (e) {
            console.log(chalk.red(`    [Error] Field processing failed: ${e.message}`));
        }
    }
}


module.exports = { handleWorkdayApplication };
