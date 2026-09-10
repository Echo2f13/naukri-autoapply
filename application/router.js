'use strict';

const chalk = require('chalk');
const { handleNaukriNativeApplication } = require('./handlers/naukriNative');
const { handleWorkdayApplication } = require('./handlers/workday');
const { handleZohoRecruitApplication } = require('./handlers/zoho');
const { handleGenericATSApplication } = require('./handlers/genericATS');
const { handleLinkedInEasyApply } = require('./handlers/linkedinEasyApply');
const { handleWellfoundNative } = require('./handlers/wellfoundNative');
const { selectResumeForJob } = require('../automation/resumeSelector');
const { randomDelay } = require('../automation/utils');

/**
 * Resolves the target ATS platform or application flow from job metadata and current URL.
 * 
 * @param {import('../discovery/normalizedJob').NormalizedJob} job 
 * @param {import('playwright').Page} [page]
 * @returns {'WORKDAY'|'ZOHO'|'GREENHOUSE'|'LEVER'|'ASHBY'|'LINKEDIN_EASY_APPLY'|'WELLFOUND_NATIVE'|'NAUKRI_NATIVE'|'GENERIC_ATS'}
 */
function resolveApplicationTarget(job = {}, page) {
    const jobUrl = typeof job === 'string' ? job : (job?.applicationUrl || job?.jobUrl || job?.sourceUrl || '');
    const checkUrl = (page ? page.url() : '') || jobUrl || '';
    const lowerUrl = checkUrl.toLowerCase();

    // 1. Workday
    if (lowerUrl.includes('workdayjobs.com') || lowerUrl.includes('myworkdayjobs.com') || /\.wd\d+\.myworkdayjobs\.com/.test(lowerUrl)) {
        return 'WORKDAY';
    }

    // 2. Zoho Recruit
    if (lowerUrl.includes('zohorecruit.com') || lowerUrl.includes('recruit.zoho.') || lowerUrl.includes('zoho.com/recruit') || lowerUrl.includes('rec-form_') || lowerUrl.includes('rec-form-row')) {
        return 'ZOHO';
    }

    // 3. Known ATS patterns
    if (lowerUrl.includes('greenhouse.io') || lowerUrl.includes('boards.greenhouse.io')) {
        return 'GREENHOUSE';
    }
    if (lowerUrl.includes('jobs.lever.co')) {
        return 'LEVER';
    }
    if (lowerUrl.includes('ashbyhq.com')) {
        return 'ASHBY';
    }

    // 4. Source-native flows
    if (lowerUrl.includes('wellfound.com') || job.source === 'WELLFOUND') {
        return 'WELLFOUND_NATIVE';
    }

    if (lowerUrl.includes('linkedin.com/jobs') || job.source === 'LINKEDIN') {
        if (job.rawPayload?.isEasyApply === false || lowerUrl.includes('linkedin.com/jobs/view/external')) {
            return 'GENERIC_ATS';
        }
        return 'LINKEDIN_EASY_APPLY';
    }

    if (job.source === 'NAUKRI') {
        // If external URL is already present or known
        if (job.applicationUrl && !job.applicationUrl.includes('naukri.com')) {
            return 'GENERIC_ATS';
        }
        return 'NAUKRI_NATIVE';
    }

    // Default to generic ATS
    return 'GENERIC_ATS';
}

/**
 * Universal Application Router.
 * Directs an application attempt to the appropriate ATS or native handler.
 * 
 * @param {import('playwright').Page} page
 * @param {import('../discovery/normalizedJob').NormalizedJob} job
 * @param {Object} [context]
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string, resumeUsed?: string, externalUrl?: string }>}
 */
async function routeAndApply(page, job, context = {}) {
    console.log(chalk.bold.magenta(`\n=== [Application Router] Routing Application ===`));
    console.log(chalk.cyan(`  Job: "${job.title}" at "${job.company}" (Source: ${job.source})`));

    const selectedResume = selectResumeForJob(job);
    let target = resolveApplicationTarget(job, page);
    console.log(chalk.cyan(`  Initial Target Resolution: ${target}`));

    // Special case: If Naukri job with potential external redirect
    if (target === 'NAUKRI_NATIVE') {
        const destUrl = job.applicationUrl || job.sourceUrl;
        if (page.url() !== destUrl) {
            await page.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(1000, 2000);
        }

        // Check if there is an "Apply on company site" external button
        const externalBtn = page.locator('button:has-text("Apply on company site"), a:has-text("Apply on company site"), button:has-text("Apply on External Website"), a:has-text("Apply on External Website")').first();
        if (await externalBtn.isVisible().catch(() => false)) {
            console.log(chalk.yellow("  'Apply on company site' button found on Naukri page. Clicking to navigate to true ATS..."));

            let externalPage = page;
            let newPage = null;
            const popupPromise = page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null);

            await externalBtn.scrollIntoViewIfNeeded().catch(() => {});
            await externalBtn.click({ force: true });

            newPage = await popupPromise;
            if (newPage) {
                console.log(chalk.green("  New tab opened for external ATS application."));
                externalPage = newPage;
                await externalPage.waitForLoadState('domcontentloaded').catch(() => {});
            } else {
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
            }

            await randomDelay(2000, 3000);
            const actualExternalUrl = externalPage.url();
            console.log(chalk.blue(`  Destination URL: ${actualExternalUrl}`));

            // Re-resolve target based on actual external URL
            target = resolveApplicationTarget({ ...job, applicationUrl: actualExternalUrl }, externalPage);
            console.log(chalk.magenta(`  Re-resolved external target: ${target}`));

            let result;
            try {
                if (target === 'WORKDAY') {
                    result = await handleWorkdayApplication(externalPage, actualExternalUrl, job, { dryRun: context.dryRun });
                } else if (target === 'ZOHO') {
                    result = await handleZohoRecruitApplication(externalPage, job, selectedResume, { dryRun: context.dryRun });
                } else {
                    result = await handleGenericATSApplication(externalPage, job, actualExternalUrl, selectedResume, { dryRun: context.dryRun });
                }
            } finally {
                if (newPage) {
                    await newPage.close().catch(() => {});
                }
            }
            return result;
        }

        // Native Naukri Flow
        return await handleNaukriNativeApplication(page, job, { dryRun: context.dryRun });
    }

    // Direct routing for non-Naukri or known direct URLs
    switch (target) {
        case 'WORKDAY':
            return await handleWorkdayApplication(page, job.applicationUrl, job, { dryRun: context.dryRun });
        case 'ZOHO':
            return await handleZohoRecruitApplication(page, job, selectedResume, { dryRun: context.dryRun });
        case 'LINKEDIN_EASY_APPLY': {
            const destUrl = job.applicationUrl || job.sourceUrl;
            if (destUrl && !page.url().includes(destUrl) && (!job.sourceJobId || !page.url().includes(job.sourceJobId))) {
                console.log(chalk.gray(`  [Router] Navigating to LinkedIn job: ${destUrl}`));
                await page.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await randomDelay(2000, 3000);
            }
            return await handleLinkedInEasyApply(page, job, { dryRun: context.dryRun });
        }
        case 'WELLFOUND_NATIVE': {
            const destUrl = job.applicationUrl || job.sourceUrl;
            if (destUrl && !page.url().includes(destUrl)) {
                console.log(chalk.gray(`  [Router] Navigating to Wellfound job: ${destUrl}`));
                await page.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await randomDelay(2000, 3000);
            }
            return await handleWellfoundNative(page, job, { dryRun: context.dryRun });
        }
        case 'GREENHOUSE':
        case 'LEVER':
        case 'ASHBY':
        case 'GENERIC_ATS':
        default:
            return await handleGenericATSApplication(page, job, job.applicationUrl, selectedResume, { dryRun: context.dryRun });
    }
}

module.exports = {
    resolveApplicationTarget,
    routeAndApply
};
