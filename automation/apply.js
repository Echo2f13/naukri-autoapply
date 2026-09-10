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
async function applyToJob(page, job) {
    return await routeAndApply(page, job);
}

module.exports = { applyToJob };
