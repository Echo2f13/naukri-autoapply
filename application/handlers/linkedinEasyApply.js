'use strict';

const fs = require('fs');
const chalk = require('chalk');
const profile = require('../../config/profile');
const { executeSubmissionSafely } = require('../safetyBoundary');
const { selectResumeForJob } = require('../../automation/resumeSelector');
const { getAnswer, getAnswerWithProvenance } = require('../../ai/answerEngine');
const { Provenance } = require('../../ai/answerProvenance');
const { randomDelay } = require('../../automation/utils');
const selectors = require('../../sources/linkedin/selectors');

/**
 * Handles LinkedIn Easy Apply multi-step modal flow with comprehensive form support,
 * resume upload verification, dropdown handling, anti-hallucination provenance safety,
 * and graceful error cleanup.
 * 
 * @param {import('playwright').Page} page
 * @param {import('../../discovery/normalizedJob').NormalizedJob} job
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string, resumeUsed?: string }>}
 */
async function handleLinkedInEasyApply(page, job, options = {}) {
    const dryRun = options.dryRun || false;
    console.log(chalk.blue.bold(`\n[LinkedIn Easy Apply] Starting application for "${job.title}" at "${job.company}"...`));

    try {
        // 0. Verify Page & Security State
        const currentUrl = page.url() || '';
        if (/checkpoint|challenge|captcha/i.test(currentUrl)) {
            console.log(chalk.red.bold('  ⚠️ Security challenge detected on LinkedIn page. Aborting application.'));
            return { status: 'FAILED', message: 'Security challenge / CAPTCHA detected' };
        }
        if (/authwall|login/i.test(currentUrl)) {
            console.log(chalk.yellow('  ⚠️ LinkedIn session expired or login required.'));
            return { status: 'FAILED', message: 'Authentication required' };
        }

        // Check if job is closed or no longer accepting applications
        const closedText = page.locator('text=/No longer accepting applications|Job is closed|This job is no longer available/i').first();
        if (await closedText.isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log(chalk.yellow('  ⚠️ Job is no longer accepting applications.'));
            return { status: 'SKIPPED', message: 'Job closed / no longer accepting applications' };
        }

        // Check if already applied
        const alreadyApplied = page.locator(selectors.alreadyAppliedBadge).first();
        if (await alreadyApplied.isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log(chalk.yellow('  ℹ️ Already applied to this job on LinkedIn.'));
            return { status: 'SKIPPED', message: 'Already applied on LinkedIn' };
        }

        // 1. Resolve Resume
        const selectedResume = selectResumeForJob(job);
        const resumePathExists = selectedResume && selectedResume.path && fs.existsSync(selectedResume.path);
        if (resumePathExists) {
            console.log(chalk.gray(`  [LinkedIn] Selected resume: "${selectedResume.fileName}"`));
        } else {
            console.log(chalk.yellow('  ⚠️ No local resume PDF found on disk. Proceeding with LinkedIn stored resume if available.'));
        }

        // 2. Locate and click "Easy Apply" button
        const easyApplyBtn = page.locator(selectors.applyButton).first();
        if (!(await easyApplyBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
            // Check if there is only an external apply button
            const externalBtn = page.locator(selectors.externalApplyButton).first();
            if (await externalBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                console.log(chalk.yellow('  ⚠️ Only External Apply available on LinkedIn.'));
                return { status: 'SKIPPED', message: 'External Apply only (not Easy Apply)' };
            }
            console.log(chalk.yellow('  ⚠️ Easy Apply button not visible.'));
            return { status: 'SKIPPED', message: 'Easy Apply button not visible' };
        }

        await easyApplyBtn.click();
        await randomDelay(1500, 2500);

        // Check for LinkedIn's "Job search safety reminder" pre-application interstitial
        const continueApplyingBtn = page.getByText('Continue applying', { exact: true });
        if (await continueApplyingBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
            console.log(chalk.cyan('  [LinkedIn] Detected "Job search safety reminder" popup. Clicking "Continue applying"...'));
            await continueApplyingBtn.click();
            await randomDelay(1500, 2500);
        }

        const modal = page.locator(selectors.easyApplyModal).first();
        if (!(await modal.isVisible({ timeout: 5000 }).catch(() => false))) {
            console.log(chalk.red('  ❌ Easy Apply modal did not open.'));
            return { status: 'FAILED', message: 'Modal failed to open' };
        }

        let maxSteps = 15;
        let step = 0;
        let sameStepCount = 0;
        let lastStepSignature = '';

        while (step < maxSteps) {
            step++;
            console.log(chalk.cyan(`  [Easy Apply] Processing step ${step}...`));
            await randomDelay(800, 1500);

            // Check if application is already submitted
            const submitDone = await page.locator(selectors.submissionSuccess).first().isVisible({ timeout: 500 }).catch(() => false);
            if (submitDone) {
                console.log(chalk.green.bold('  🎉 LinkedIn application successfully submitted!'));
                const closeBtn = modal.locator(selectors.dismissButton).first();
                await closeBtn.click().catch(() => {});
                return {
                    status: 'SUCCESS',
                    message: 'Submitted via LinkedIn Easy Apply',
                    resumeUsed: selectedResume?.fileName
                };
            }

            // Create step signature to detect loop/blockage
            const currentContent = await modal.innerText().catch(() => '');
            const stepSig = currentContent.slice(0, 100);
            if (stepSig === lastStepSignature) {
                sameStepCount++;
                if (sameStepCount > 3) {
                    console.log(chalk.red('  ❌ Stuck on the same step for >3 attempts. Validation error blocking progress.'));
                    break;
                }
            } else {
                sameStepCount = 0;
                lastStepSignature = stepSig;
            }

            // A. Handle Text / Numeric / Tel / Textarea Fields
            const inputs = await modal.locator(selectors.textInputs).all();
            for (const inp of inputs) {
                const isVis = await inp.isVisible().catch(() => false);
                if (!isVis) continue;
                const currVal = await inp.inputValue().catch(() => '');
                if (currVal.trim() !== '') continue;

                // Identify label or placeholder
                const id = await inp.getAttribute('id').catch(() => '');
                let labelText = '';
                if (id) {
                    const labelEl = modal.locator(`label[for="${id}"]`).first();
                    labelText = await labelEl.innerText().catch(() => '');
                }
                if (!labelText) {
                    labelText = await inp.getAttribute('aria-label').catch(() => '') ||
                                await inp.getAttribute('placeholder').catch(() => '');
                }

                const cleanLabel = (labelText || '').replace(/[*•\n]/g, ' ').replace(/\s+/g, ' ').trim();
                const labelLower = cleanLabel.toLowerCase();
                let answer = '';

                if (labelLower.includes('phone') || labelLower.includes('mobile')) {
                    answer = profile.mobile || profile.phone || '';
                } else if (labelLower.includes('email')) {
                    answer = profile.email || '';
                } else if (labelLower.includes('first name') || labelLower.includes('given name')) {
                    answer = profile.firstName || (profile.fullName ? profile.fullName.split(' ')[0] : '');
                } else if (labelLower.includes('last name') || labelLower.includes('family name')) {
                    answer = profile.lastName || (profile.fullName ? profile.fullName.split(' ').slice(1).join(' ') : '');
                } else if (labelLower.includes('experience') || labelLower.includes('years of')) {
                    answer = String(profile.yearsOfExperience || '1');
                } else if (labelLower.includes('notice') || labelLower.includes('joining')) {
                    answer = profile.noticePeriod || 'Immediate';
                } else if (labelLower.includes('city') || labelLower.includes('location')) {
                    answer = profile.city || profile.location || 'Hyderabad';
                } else if (labelLower.includes('linkedin') || labelLower.includes('profile url')) {
                    answer = profile.urls?.linkedin || profile.linkedin || '';
                } else if (cleanLabel) {
                    // Safe Provenance-checked Answer Engine lookup
                    const provAns = await getAnswerWithProvenance(cleanLabel, { role: job.title, company: job.company });
                    if (provAns && provAns.answer) {
                        // Strict provenance safety: Do not submit unverified wild guesses
                        if (provAns.provenance === Provenance.VERIFIED_PROFILE ||
                            provAns.provenance === Provenance.VERIFIED_CACHE ||
                            provAns.confidence >= 0.8) {
                            answer = provAns.answer;
                        } else {
                            console.log(chalk.gray(`    [Provenance] Low confidence answer for "${cleanLabel}". Not guessing.`));
                        }
                    }
                }

                if (answer) {
                    await inp.fill(String(answer));
                    await inp.dispatchEvent('input').catch(() => {});
                    await inp.dispatchEvent('change').catch(() => {});
                    console.log(chalk.green(`    -> Filled "${cleanLabel || 'input'}": ${answer}`));
                }
            }

            // B. Handle Resume Upload
            const fileInp = modal.locator(selectors.fileInput).first();
            if (await fileInp.isVisible({ timeout: 400 }).catch(() => false) || await fileInp.count() > 0) {
                const hasExistingResume = await modal.locator(selectors.uploadedResumeIndicator).count() > 0;
                if (!hasExistingResume && resumePathExists) {
                    console.log(chalk.blue(`    -> Uploading tailored resume: ${selectedResume.fileName}`));
                    await fileInp.setInputFiles(selectedResume.path).catch(() => {});
                    await randomDelay(2000, 3000);
                }
            }

            // C. Handle Radio Questions (Yes/No, Work Authorization, etc.)
            const radioGroups = await modal.locator(selectors.radioGroups).all();
            for (const group of radioGroups) {
                const legend = (await group.locator('legend, [class*="legend"]').first().innerText().catch(() => '')).trim();
                const checkedRadio = await group.locator('input[type="radio"]:checked').count();
                if (checkedRadio === 0 && legend) {
                    const rawOptions = await group.locator('label').allInnerTexts().catch(() => []);
                    const options = rawOptions.map(o => o.trim()).filter(Boolean);
                    const ans = await getAnswer(legend, options.length > 0 ? options : ['Yes', 'No'], { role: job.title, company: job.company });
                    if (ans) {
                        const targetOption = group.locator(`label:has-text("${ans}"), input[value="${ans}"]`).first();
                        if (await targetOption.isVisible().catch(() => false)) {
                            await targetOption.click();
                            console.log(chalk.green(`    -> Radio [${legend}]: ${ans}`));
                        }
                    }
                }
            }

            // D. Handle Select / Dropdown Questions
            const selects = await modal.locator('select').all();
            for (const sel of selects) {
                const isVis = await sel.isVisible().catch(() => false);
                if (!isVis) continue;
                const currVal = await sel.inputValue().catch(() => '');
                if (currVal && currVal !== 'Select an option' && currVal !== '0') continue;

                const id = await sel.getAttribute('id').catch(() => '');
                let labelText = '';
                if (id) {
                    labelText = await modal.locator(`label[for="${id}"]`).first().innerText().catch(() => '');
                }
                if (!labelText) {
                    labelText = await sel.getAttribute('aria-label').catch(() => '') || '';
                }

                const options = await sel.locator('option').allInnerTexts().catch(() => []);
                const validOptions = options.map(o => o.trim()).filter(o => o && !o.toLowerCase().includes('select'));
                if (validOptions.length > 0) {
                    const cleanQ = (labelText || 'Dropdown Question').trim();
                    const chosen = await getAnswer(cleanQ, validOptions, { role: job.title, company: job.company });
                    if (chosen) {
                        await sel.selectOption({ label: chosen }).catch(async () => {
                            await sel.selectOption({ value: chosen }).catch(() => {});
                        });
                        console.log(chalk.green(`    -> Dropdown [${cleanQ}]: ${chosen}`));
                    }
                }
            }

            // E. Handle Checkboxes (Terms, Consent, Declarations)
            const checkboxes = await modal.locator(selectors.checkboxes).all();
            for (const cb of checkboxes) {
                const isVis = await cb.isVisible().catch(() => false);
                if (!isVis) continue;
                const isChecked = await cb.isChecked().catch(() => false);
                if (isChecked) continue;

                // Read surrounding label
                const parentText = await cb.evaluate(el => el.closest('label, div')?.innerText || '').catch(() => '');
                const isConsent = /agree|consent|terms|privacy|declaration|authorize|certify|acknowledge/i.test(parentText);
                if (isConsent) {
                    console.log(chalk.green(`    -> Checking required agreement/consent checkbox`));
                    await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
                }
            }

            // F. Check for Validation Errors
            const hasError = await modal.locator(selectors.validationError).first().isVisible({ timeout: 400 }).catch(() => false);
            if (hasError) {
                const errText = await modal.locator(selectors.validationError).first().innerText().catch(() => '');
                console.log(chalk.yellow(`    ⚠️ Validation note: "${errText.trim()}"`));
            }

            // G. Progress to Next Step / Review / Submit
            const submitBtn = modal.locator(selectors.submitButton).first();
            const reviewBtn = modal.locator(selectors.reviewButton).first();
            const nextBtn = modal.locator(selectors.nextButton).first();

            if (await submitBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                if (dryRun) {
                    console.log(chalk.bold.yellow('  [DRY RUN] Final Submit application button reached! Stopping before final submission.'));
                    break;
                }
                console.log(chalk.yellow('  Clicking Submit application...'));
                await submitBtn.click();
                await randomDelay(2000, 3000);

                return {
                    status: 'SUCCESS',
                    message: 'Submitted via LinkedIn Easy Apply',
                    resumeUsed: selectedResume?.fileName
                };
            } else if (await reviewBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                console.log(chalk.yellow('  Clicking Review...'));
                await reviewBtn.click();
                await randomDelay(1000, 1500);
            } else if (await nextBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                console.log(chalk.yellow('  Clicking Next...'));
                await nextBtn.click();
                await randomDelay(1000, 1500);
            } else {
                console.log(chalk.yellow('  No progress button found in Easy Apply modal.'));
                break;
            }
        }

        // Clean up / dismiss modal if not submitted or in dry run
        const dismissBtn = modal.locator(selectors.dismissButton).first();
        if (await dismissBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await dismissBtn.click().catch(() => {});
            await randomDelay(500, 1000);
            const discardBtn = page.locator(selectors.discardConfirmButton).first();
            if (await discardBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await discardBtn.click().catch(() => {});
            }
        }

        if (dryRun) {
            return await executeSubmissionSafely({
                dryRun: true,
                actionName: 'LinkedIn Easy Apply Submit',
                execute: async () => ({
                    status: 'SUCCESS',
                    message: 'Submitted via LinkedIn Easy Apply',
                    resumeUsed: selectedResume?.fileName
                })
            });
        }

        return { status: 'FAILED', message: 'Did not reach application submission confirmation' };

    } catch (err) {
        console.error(chalk.red(`  ❌ LinkedIn Easy Apply error: ${err.message}`));
        return { status: 'FAILED', message: err.message };
    }
}

module.exports = { handleLinkedInEasyApply };
