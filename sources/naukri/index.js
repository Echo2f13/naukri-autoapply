'use strict';

const chalk = require('chalk');
const { extractRecommendedJobs } = require('./recommendations');
const { searchNaukri } = require('./search');
const { crossSourceDeduplicate } = require('../../discovery/deduplicator');

/**
 * Independent Naukri Discovery Pipeline.
 * Extracts recommended and search-based jobs and normalizes them into standard NormalizedJob items.
 */
class NaukriPipeline {
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
     * Discover jobs on Naukri
     * @param {Object} [options]
     * @param {'recommended'|'search'|'both'} [options.mode='both']
     * @param {Object} [options.searchOptions={}]
     * @param {number} [options.maxDays=1]
     * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
     */
    async discover({ mode = 'both', searchOptions = {}, maxDays = 1 } = {}) {
        if (!this.page) {
            throw new Error('[NaukriPipeline] Playwright Page instance is required for discovery.');
        }

        console.log(chalk.bold.cyan(`\n=== Starting Naukri Discovery Pipeline (mode: ${mode}, maxDays: ${maxDays}) ===`));
        const discovered = [];

        // 1. Recommended Jobs Pass
        if (mode === 'recommended' || mode === 'both') {
            try {
                console.log(chalk.cyan('  [NaukriPipeline] Fetching recommended jobs...'));
                const recJobs = await extractRecommendedJobs(this.page);
                console.log(chalk.cyan(`  [NaukriPipeline] Found ${recJobs.length} recommended jobs.`));
                discovered.push(...recJobs);
            } catch (err) {
                console.error(chalk.red(`  ❌ [NaukriPipeline] Recommended jobs failed: ${err.message}`));
            }
        }

        // 2. Keyword Search Pass
        if (mode === 'search' || mode === 'both') {
            try {
                console.log(chalk.cyan('  [NaukriPipeline] Running search queries...'));
                const searchJobs = await searchNaukri(this.page, searchOptions, maxDays);
                console.log(chalk.cyan(`  [NaukriPipeline] Found ${searchJobs.length} search jobs.`));
                discovered.push(...searchJobs);
            } catch (err) {
                console.error(chalk.red(`  ❌ [NaukriPipeline] Search failed: ${err.message}`));
            }
        }

        // 3. Deduplicate across runs/passes
        const uniqueJobs = crossSourceDeduplicate(discovered);
        console.log(chalk.bold.green(`=== Naukri Discovery Finished: ${uniqueJobs.length} unique normalized jobs ===\n`));

        return uniqueJobs;
    }
}

module.exports = {
    NaukriPipeline,
    extractRecommendedJobs,
    searchNaukriJobs: searchNaukri
};
