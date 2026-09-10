'use strict';

const { extractRecommendedJobs: naukriExtractRecommended, searchNaukriJobs: naukriSearchJobs } = require('../sources/naukri');
const { selectSortByDate, setExperienceFilter } = require('../sources/naukri/search');

/**
 * Backward compatibility wrapper around sources/naukri
 * Extracts job listings from the Naukri recommended jobs page.
 * @param {import('playwright').Page} page
 */
async function extractRecommendedJobs(page) {
    return await naukriExtractRecommended(page);
}

/**
 * Backward compatibility wrapper around sources/naukri
 * Multi-pass search on Naukri.
 * @param {import('playwright').Page} page
 * @param {Object} searchOptions
 * @param {number} maxDays
 */
async function searchNaukriJobs(page, searchOptions = {}, maxDays = 1) {
    return await naukriSearchJobs(page, searchOptions, maxDays);
}

module.exports = {
    extractRecommendedJobs,
    searchNaukriJobs,
    selectSortByDate,
    setExperienceFilter
};
