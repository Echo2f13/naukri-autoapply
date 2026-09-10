'use strict';

const chalk = require('chalk');
const profile = require('../../config/profile');

/**
 * Dedicated handler for Zoho Recruit ATS forms (e.g. Kumaran Systems, Zoho Recruit hosted portals)
 * @param {import('playwright').Page} page
 * @param {import('../../discovery/normalizedJob').NormalizedJob} job
 * @param {Object} selectedResume
 */
async function handleZohoRecruitApplication(page, job, selectedResume, options = {}) {
    // We can delegate to externalApplyHandler or run the proven Zoho flow directly
    const { handleExternalApplication } = require('../../automation/externalApplyHandler');
    return await handleExternalApplication(page, job, page.url(), selectedResume, options);
}

module.exports = {
    handleZohoRecruitApplication,
    handleZoho: handleZohoRecruitApplication
};
