'use strict';

const chalk = require('chalk');
const { randomDelay, humanScroll } = require('../../automation/utils');
const { checkWellfoundSession, ensureWellfoundLogin } = require('./auth');
const { extractWellfoundCardElements, extractWellfoundJobDetails, buildNormalizedWellfoundJob } = require('./extractor');
const selectors = require('./selectors');

/**
 * Searches Wellfound for startup jobs matching target roles and locations.
 * Performs session check, navigates role listings, extracts job cards and full descriptions.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string[]} [options.roles=['software-engineer', 'machine-learning-engineer', 'artificial-intelligence-engineer']]
 * @param {number} [options.maxJobsPerSearch=20]
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
 */
async function searchWellfound(page, options = {}) {
    const roles = options.roles || ['software-engineer', 'machine-learning-engineer', 'artificial-intelligence-engineer'];
    const maxJobs = options.maxJobsPerSearch || 20;

    // 1. Verify Session
    const session = await checkWellfoundSession(page);
    if (session.status === 'SECURITY_CHALLENGE') {
        console.log(chalk.red.bold('  ⚠️ [Wellfound Search] Cloudflare challenge active. Aborting automated search.'));
        return [];
    }

    if (session.status === 'LOGIN_REQUIRED') {
        console.log(chalk.yellow('  ⚠️ [Wellfound Search] Login required. Attempting session verification...'));
        const loginRes = await ensureWellfoundLogin(page, { maxWaitMs: 30000 });
        if (!loginRes.authenticated) {
            console.log(chalk.yellow('  ⚠️ [Wellfound Search] Active session required for authenticated search. Continuing safely...'));
            return [];
        }
    }

    const allJobs = [];
    const seenUrls = new Set();
    const searchUrls = [
        'https://wellfound.com/jobs',
        ...roles.map(role => `https://wellfound.com/role/l/${encodeURIComponent(role)}/india`)
    ];

    for (const url of searchUrls) {
        if (allJobs.length >= maxJobs) break;

        console.log(chalk.cyan(`\n[Wellfound Search] Navigating: ${url}...`));

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
            await randomDelay(2000, 3000);

            // Post-navigation Cloudflare/login check
            const postNavCheck = await checkWellfoundSession(page);
            if (postNavCheck.status === 'SECURITY_CHALLENGE') {
                console.log(chalk.red.bold('  ⚠️ [Wellfound Search] Cloudflare challenge encountered during navigation. Pausing search.'));
                return allJobs;
            }
            if (postNavCheck.status === 'LOGIN_REQUIRED') {
                console.log(chalk.yellow('  ⚠️ [Wellfound Search] Redirected to login page. Stopping search safely.'));
                return allJobs;
            }

            // Trigger lazy-loaded startup cards
            await humanScroll(page);
            await randomDelay(1200, 2000);

            const searchLabel = url.includes('/jobs') ? 'Jobs Feed' : url.split('/').pop();
            const cards = await extractWellfoundCardElements(page);
            if (cards.length === 0) {
                console.log(chalk.gray(`  [Wellfound] No job cards found for: ${searchLabel}`));
                continue;
            }

            console.log(chalk.gray(`  [Wellfound] Discovered ${cards.length} cards for ${searchLabel}. Extracting details...`));

            const cardLocators = page.locator(selectors.jobCard);
            const count = await cardLocators.count();

            for (let i = 0; i < cards.length && i < count; i++) {
                if (allJobs.length >= maxJobs) break;

                const card = cards[i];
                if (!card.jobUrl || seenUrls.has(card.jobUrl)) continue;

                let details = {};
                try {
                    const cardItem = cardLocators.nth(i);
                    if (await cardItem.isVisible().catch(() => false)) {
                        await cardItem.click({ timeout: 2000 }).catch(() => {});
                        await randomDelay(800, 1500);
                        details = await extractWellfoundJobDetails(page);
                    }
                } catch (e) {
                    details = {};
                }

                const normalized = buildNormalizedWellfoundJob(card, details);
                seenUrls.add(card.jobUrl);
                allJobs.push(normalized);

                const descSnippet = normalized.description ? `${normalized.description.length} chars` : 'card-only';
                console.log(chalk.green(`    -> [Startup Job] "${normalized.title}" at "${normalized.company}" (${descSnippet})`));
            }

        } catch (err) {
            console.warn(chalk.yellow(`  ⚠️ [Wellfound] Failed to load url ${url}: ${err.message}`));
        }
    }

    return allJobs;
}

module.exports = { searchWellfound };
