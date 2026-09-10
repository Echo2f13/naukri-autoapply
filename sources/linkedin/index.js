'use strict';

const chalk = require('chalk');
const { searchLinkedIn } = require('./search');
const { checkLinkedInSession, ensureLinkedInLogin } = require('./auth');
const { extractLinkedInJobCards, extractJobDetailsFromPane, buildNormalizedLinkedInJob } = require('./extractor');
const { crossSourceDeduplicate } = require('../../discovery/deduplicator');

/**
 * Independent LinkedIn Discovery Pipeline.
 * Searches LinkedIn Jobs with Easy Apply and recent posting filters, returning NormalizedJob items.
 */
class LinkedInPipeline {
    /**
     * @param {Object} options
     * @param {import('playwright').Page} options.page
     * @param {import('playwright').BrowserContext} [options.context]
     */
    constructor({ page, context } = {}) {
        this.page = page;
        this.context = context || page?.context?.();
    }

    /**
     * Set active page and context
     * @param {import('playwright').Page} page 
     * @param {import('playwright').BrowserContext} [context] 
     */
    setPage(page, context) {
        this.page = page;
        this.context = context || page?.context?.();
    }

    /**
     * Verify session
     */
    async checkSession() {
        if (!this.page) return { authenticated: false, status: 'ERROR', message: 'No page available' };
        return await checkLinkedInSession(this.page);
    }

    /**
     * Ensure login
     */
    async ensureLogin(options = {}) {
        if (!this.page) return { authenticated: false, status: 'ERROR', message: 'No page available' };
        return await ensureLinkedInLogin(this.page, options);
    }

    /**
     * Discover jobs on LinkedIn
     * @param {Object} [options]
     * @param {string[]} [options.keywords]
     * @param {string} [options.location]
     * @param {boolean} [options.easyApplyOnly=true]
     * @param {number} [options.maxPages=2]
     * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
     */
    async discover(options = {}) {
        if (!this.page) {
            throw new Error('[LinkedInPipeline] Playwright Page instance is required for discovery.');
        }

        console.log(chalk.bold.blue('\n=== Starting LinkedIn Discovery Pipeline ==='));
        try {
            const rawJobs = await searchLinkedIn(this.page, options);
            const uniqueJobs = crossSourceDeduplicate(rawJobs);
            console.log(chalk.bold.green(`=== LinkedIn Discovery Finished: ${uniqueJobs.length} unique jobs found ===\n`));
            return uniqueJobs;
        } catch (err) {
            console.error(chalk.red(`❌ [LinkedInPipeline] Discovery failed: ${err.message}`));
            return [];
        }
    }
}

module.exports = {
    LinkedInPipeline,
    searchLinkedIn,
    checkLinkedInSession,
    ensureLinkedInLogin,
    extractLinkedInJobCards,
    extractJobDetailsFromPane,
    buildNormalizedLinkedInJob
};
