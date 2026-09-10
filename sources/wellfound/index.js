'use strict';

const chalk = require('chalk');
const { searchWellfound } = require('./search');
const { checkWellfoundSession, ensureWellfoundLogin } = require('./auth');
const { extractWellfoundJobCards, extractWellfoundJobDetails, buildNormalizedWellfoundJob } = require('./extractor');
const { crossSourceDeduplicate } = require('../../discovery/deduplicator');

/**
 * Independent Wellfound Discovery Pipeline.
 * Extracts startup jobs with authentication verification and returns NormalizedJob items.
 */
class WellfoundPipeline {
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
     * Check active Wellfound session
     */
    async checkSession() {
        if (!this.page) return { authenticated: false, status: 'ERROR', message: 'No page available' };
        return await checkWellfoundSession(this.page);
    }

    /**
     * Ensure active Wellfound session
     */
    async ensureLogin(options = {}) {
        if (!this.page) return { authenticated: false, status: 'ERROR', message: 'No page available' };
        return await ensureWellfoundLogin(this.page, options);
    }

    /**
     * Discover startup jobs on Wellfound
     * @param {Object} [options]
     * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
     */
    async discover(options = {}) {
        if (!this.page) {
            throw new Error('[WellfoundPipeline] Playwright Page instance is required for discovery.');
        }

        console.log(chalk.bold.magenta('\n=== Starting Wellfound Discovery Pipeline ==='));
        try {
            const rawJobs = await searchWellfound(this.page, options);
            const uniqueJobs = crossSourceDeduplicate(rawJobs);
            console.log(chalk.bold.green(`=== Wellfound Discovery Finished: ${uniqueJobs.length} unique jobs found ===\n`));
            return uniqueJobs;
        } catch (err) {
            console.error(chalk.red(`❌ [WellfoundPipeline] Discovery failed: ${err.message}`));
            return [];
        }
    }
}

module.exports = {
    WellfoundPipeline,
    searchWellfound,
    checkWellfoundSession,
    ensureWellfoundLogin,
    extractWellfoundJobCards,
    extractWellfoundJobDetails,
    buildNormalizedWellfoundJob
};
