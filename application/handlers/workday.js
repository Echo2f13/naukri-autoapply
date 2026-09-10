'use strict';

const chalk = require('chalk');
const { handleWorkdayApplication } = require('../../automation/workdayHandler');

/**
 * Dedicated handler for Workday ATS portal applications.
 * 
 * @param {import('playwright').Page} page
 * @param {string} targetUrl
 * @param {import('../../discovery/normalizedJob').NormalizedJob} [job]
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string }>}
 */
async function handleWorkday(page, targetUrl, job, options = {}) {
    console.log(chalk.magenta.bold(`\n[Application Router] Routing to Workday Handler for ${job?.company || 'Company'}...`));
    return await handleWorkdayApplication(page, targetUrl || job?.applicationUrl, job, options);
}

module.exports = {
    handleWorkdayApplication: handleWorkday
};
