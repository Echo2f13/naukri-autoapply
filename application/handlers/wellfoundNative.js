'use strict';

const chalk = require('chalk');
const profile = require('../../config/profile');
const { executeSubmissionSafely } = require('../safetyBoundary');
const { getAnswerWithProvenance } = require('../../ai/answerEngine');
const { Provenance } = require('../../ai/answerProvenance');
const { randomDelay } = require('../../automation/utils');
const selectors = require('../../sources/wellfound/selectors');

/**
 * Generates a tailored startup pitch note for Wellfound applications.
 * 
 * @param {import('../../discovery/normalizedJob').NormalizedJob} job 
 * @returns {string}
 */
function generateStartupPitch(job) {
    const candidateName = profile.fullName || profile.firstName || 'Candidate';
    const candidateRole = profile.jobRoles?.[0] || 'AI / Software Engineer';
    const topSkills = (profile.skills || ['Python', 'PyTorch', 'Node.js']).slice(0, 4).join(', ');

    return `Hi ${job.company} Team,\n\nI am writing to express my strong interest in the ${job.title} role. With practical experience as an ${candidateRole} specializing in ${topSkills}, I have developed autonomous agent workflows, scalable backend architectures, and production-ready machine learning pipelines.\n\nI am excited about what ${job.company} is building and would love the opportunity to contribute. Thank you for your time and consideration!\n\nBest regards,\n${candidateName}`;
}

/**
 * Handles Wellfound (AngelList Talent) native 1-click or note-based application flow.
 * 
 * @param {import('playwright').Page} page
 * @param {import('../../discovery/normalizedJob').NormalizedJob} job
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string }>}
 */
async function handleWellfoundNative(page, job, options = {}) {
    const dryRun = options.dryRun || false;
    console.log(chalk.blue.bold(`\n[Wellfound Native] Starting application for "${job.title}" at "${job.company}"...`));

    try {
        // 0. Verify Security / Cloudflare State
        const currentUrl = page.url() || '';
        if (/challenge|turnstile|cloudflare/i.test(currentUrl)) {
            console.log(chalk.red.bold('  ⚠️ Cloudflare bot challenge detected on Wellfound. Aborting.'));
            return { status: 'FAILED', message: 'Cloudflare challenge detected' };
        }
        if (/wellfound\.com\/login|\/auth/i.test(currentUrl)) {
            console.log(chalk.yellow('  ⚠️ Wellfound session not active (login required).'));
            return { status: 'FAILED', message: 'Authentication required' };
        }

        // Check if already applied
        const alreadyApplied = page.locator(selectors.alreadyAppliedBadge).first();
        if (await alreadyApplied.isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log(chalk.green('  ✔ Already applied to this startup role on Wellfound.'));
            return { status: 'SKIPPED', message: 'Already applied on Wellfound' };
        }

        // 1. Locate and inspect "Apply" or "Quick Apply"
        const applyBtn = page.locator(selectors.applyButton).first();
        if (!(await applyBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
            console.log(chalk.yellow('  ⚠️ Apply button not found or visible on Wellfound.'));
            return { status: 'SKIPPED', message: 'Apply button not found on Wellfound' };
        }

        const btnText = (await applyBtn.innerText().catch(() => '')).trim();
        const isInstantApply = /quick apply|1-click|instant/i.test(btnText);

        if (dryRun && isInstantApply) {
            return await executeSubmissionSafely({
                dryRun: true,
                actionName: `Wellfound 1-Click Apply ("${btnText}")`,
                execute: async () => ({ status: 'SUCCESS' })
            });
        }

        await applyBtn.click();
        await randomDelay(1500, 2500);

        // 2. Check if a Note / Application Modal opens
        const noteModal = page.locator(selectors.noteModal).first();
        if (await noteModal.isVisible({ timeout: 4000 }).catch(() => false)) {
            const noteTextarea = noteModal.locator(selectors.noteTextarea).first();
            if (await noteTextarea.isVisible({ timeout: 2000 }).catch(() => false)) {
                const pitchNote = generateStartupPitch(job);
                console.log(chalk.cyan(`  [Wellfound] Filling tailored startup pitch (${pitchNote.length} chars)...`));
                await noteTextarea.fill(pitchNote);
                await randomDelay(800, 1200);
            }

            // Check for additional custom screening questions inside the modal
            const customInputs = await noteModal.locator('input[type="text"], input[type="number"]').all();
            for (const inp of customInputs) {
                const isVis = await inp.isVisible().catch(() => false);
                if (!isVis) continue;
                const val = await inp.inputValue().catch(() => '');
                if (val.trim() !== '') continue;

                const label = await inp.getAttribute('aria-label') || await inp.getAttribute('placeholder') || '';
                if (label) {
                    const ansObj = await getAnswerWithProvenance(label, { role: job.title, company: job.company });
                    if (ansObj && (ansObj.provenance === Provenance.VERIFIED_PROFILE || ansObj.confidence >= 0.8)) {
                        await inp.fill(ansObj.answer);
                        console.log(chalk.green(`    -> Answered screening question "${label}": ${ansObj.answer}`));
                    }
                }
            }

            // 3. Submit or Dry Run
            const sendBtn = noteModal.locator(selectors.submitButton).first();
            if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                if (dryRun) {
                    console.log(chalk.bold.yellow('  [DRY RUN] Final Send application button reached on Wellfound. Stopping before submission.'));
                    const closeBtn = noteModal.locator(selectors.dismissButton).first();
                    await closeBtn.click().catch(() => {});
                    return await executeSubmissionSafely({
                        dryRun: true,
                        actionName: 'Wellfound Send Application Note',
                        execute: async () => ({ status: 'SUCCESS' })
                    });
                }

                console.log(chalk.yellow('  Clicking Send application...'));
                await sendBtn.click();
                await randomDelay(2000, 3000);
            }
        } else {
            // Instant 1-click apply succeeded without modal
            if (dryRun) {
                return { status: 'DRY_RUN_READY_TO_SUBMIT', message: '[DRY-RUN] Reached 1-click apply on Wellfound' };
            }
            console.log(chalk.green('  ✔ 1-click apply triggered directly without note modal.'));
        }

        console.log(chalk.green.bold('  🎉 Wellfound application successfully processed!'));
        return { status: 'SUCCESS', message: 'Submitted via Wellfound Native flow' };

    } catch (err) {
        console.error(chalk.red(`  ❌ Wellfound apply error: ${err.message}`));
        return { status: 'FAILED', message: err.message };
    }
}

module.exports = {
    handleWellfoundNative,
    generateStartupPitch
};
