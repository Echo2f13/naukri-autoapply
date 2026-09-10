'use strict';

const chalk = require('chalk');
const { handleExternalApplication } = require('../../automation/externalApplyHandler');
const { selectResumeForJob } = require('../../automation/resumeSelector');

/**
 * Handles generic external ATS portals (Greenhouse, Lever, Ashby, SmartRecruiters, custom career forms).
 * 
 * @param {import('playwright').Page} page
 * @param {import('../../discovery/normalizedJob').NormalizedJob} job
 * @param {string} [targetUrl]
 * @param {Object} [resume]
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string, resumeUsed?: string, externalUrl?: string }>}
 */
async function handleGenericATSApplication(page, job, targetUrl, resume, options = {}) {
    const selectedResume = resume || selectResumeForJob(job);
    const url = targetUrl || job.applicationUrl || page.url();
    console.log(chalk.magenta.bold(`\n[Application Router] Routing to Generic ATS Handler for ${job.company || 'External'} (${url})...`));
    return await handleExternalApplication(page, job, url, selectedResume, options);
}

module.exports = {
    handleGenericATSApplication,
    handleGenericATS: handleGenericATSApplication
};
