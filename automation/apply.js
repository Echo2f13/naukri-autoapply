'use strict';

const { routeAndApply } = require('../application/router');

/**
 * Backward-compatible wrapper for applying to a job.
 * Delegates to the universal Application Router.
 * 
 * @param {import('playwright').Page} page 
 * @param {any} job 
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message: string }>}
 */
async function applyToJob(page, job, options = {}) {
    const dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    return await routeAndApply(page, job, { ...options, dryRun });
}

module.exports = { applyToJob };
