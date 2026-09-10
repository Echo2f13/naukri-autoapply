'use strict';

const chalk = require('chalk');
const { randomDelay, humanScroll } = require('../../automation/utils');
const { checkLinkedInSession, ensureLinkedInLogin } = require('./auth');
const { extractLinkedInCardElements, extractJobDetailsFromPane, buildNormalizedLinkedInJob } = require('./extractor');
const selectors = require('./selectors');

/**
 * Searches LinkedIn for jobs matching keywords and filters.
 * Navigates through search result cards, opens details pane to extract full descriptions,
 * and normalizes each opportunity into a NormalizedJob.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string[]} [options.keywords=['AI Engineer', 'Python Developer', 'Software Engineer Fresher']]
 * @param {string} [options.location='India']
 * @param {boolean} [options.easyApplyOnly=true]
 * @param {number} [options.maxPages=2]
 * @param {number} [options.maxJobsPerSearch=15]
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
 */
async function searchLinkedIn(page, options = {}) {
    const rawKeywords = options.keywords || ['AI Engineer', 'Python Developer', 'Software Engineer Fresher'];
    const keywords = Array.isArray(rawKeywords) ? rawKeywords : [rawKeywords];
    const location = options.location || 'India';
    const easyApplyOnly = options.easyApplyOnly !== false;
    const maxPages = options.maxPages || 2;
    const maxJobsPerSearch = options.maxJobsPerSearch || 20;

    // 1. Session Verification
    const session = await checkLinkedInSession(page);
    if (session.status === 'SECURITY_CHALLENGE') {
        console.log(chalk.red.bold('  ⚠️ [LinkedIn Search] Security challenge / CAPTCHA active. Aborting automated search.'));
        return [];
    }

    if (session.status === 'LOGIN_REQUIRED') {
        console.log(chalk.yellow('  ⚠️ [LinkedIn Search] Login wall detected. Attempting session verification...'));
        const loginRes = await ensureLinkedInLogin(page, { maxWaitMs: 30000 });
        if (!loginRes.authenticated) {
            console.log(chalk.yellow('  ⚠️ [LinkedIn Search] Active session required for authenticated search. Continuing safely...'));
            return [];
        }
    }

    const allJobs = [];
    const seenUrls = new Set();

    for (const kw of keywords) {
        if (allJobs.length >= maxJobsPerSearch) break;
        console.log(chalk.cyan(`\n[LinkedIn Search] Querying: "${kw}" in "${location}"...`));

        for (let pageNum = 0; pageNum < maxPages; pageNum++) {
            if (allJobs.length >= maxJobsPerSearch) break;

            const startParam = pageNum * 25;
            let searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(location)}&start=${startParam}`;
            
            // Apply verified filters: Easy Apply, Past 24h, Entry/Associate level
            if (easyApplyOnly) {
                searchUrl += '&f_AL=true';
            }
            searchUrl += '&f_TPR=r86400';
            searchUrl += '&f_E=1,2';

            try {
                console.log(chalk.gray(`  [LinkedIn] Navigating page ${pageNum + 1}: ${searchUrl}`));
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                await randomDelay(2000, 3000);

                // Check for immediate authwall or security checkpoint post-navigation
                const pageCheck = await checkLinkedInSession(page);
                if (pageCheck.status === 'SECURITY_CHALLENGE') {
                    console.log(chalk.red.bold('  ⚠️ [LinkedIn Search] Security challenge encountered during navigation. Pausing search.'));
                    return allJobs;
                }
                if (pageCheck.status === 'LOGIN_REQUIRED') {
                    console.log(chalk.yellow('  ⚠️ [LinkedIn Search] Redirected to login wall during search. Stopping search safely.'));
                    return allJobs;
                }

                // Scroll the left search results container to trigger lazy loaded items
                const listContainer = page.locator(selectors.jobListContainer).first();
                if (await listContainer.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await listContainer.evaluate(el => el.scrollBy(0, 800)).catch(() => {});
                    await randomDelay(800, 1400);
                    await listContainer.evaluate(el => el.scrollBy(0, 1200)).catch(() => {});
                } else {
                    await humanScroll(page);
                }
                await randomDelay(1000, 1500);

                // Extract all card elements metadata
                const cardList = await extractLinkedInCardElements(page);
                if (cardList.length === 0) {
                    console.log(chalk.gray(`  [LinkedIn] No job cards found on page ${pageNum + 1}.`));
                    break;
                }

                console.log(chalk.gray(`  [LinkedIn] Discovered ${cardList.length} cards on page ${pageNum + 1}. Extracting details...`));

                const cardLocators = page.locator(selectors.jobCard);
                const count = await cardLocators.count();

                for (let i = 0; i < cardList.length && i < count; i++) {
                    if (allJobs.length >= maxJobsPerSearch) break;

                    const card = cardList[i];
                    if (!card.jobUrl || seenUrls.has(card.jobUrl)) continue;

                    // Open job card to reveal full details pane
                    let details = {};
                    try {
                        const cardItem = cardLocators.nth(i);
                        if (await cardItem.isVisible().catch(() => false)) {
                            await cardItem.click({ timeout: 3000 }).catch(() => {});
                            await randomDelay(1000, 1800);

                            // Extract complete details from the loaded right pane
                            details = await extractJobDetailsFromPane(page);
                        }
                    } catch (detailErr) {
                        // Fallback gracefully to card data if clicking fails
                        details = {};
                    }

                    const normalized = buildNormalizedLinkedInJob(card, details);
                    seenUrls.add(card.jobUrl);
                    allJobs.push(normalized);

                    const descSnippet = normalized.description ? `${normalized.description.length} chars` : 'no desc';
                    console.log(chalk.green(`    -> [Job] "${normalized.title}" at "${normalized.company}" (${normalized.applicationType}, ${descSnippet})`));
                }

            } catch (err) {
                console.warn(chalk.yellow(`  ⚠️ [LinkedIn] Page ${pageNum + 1} navigation error: ${err.message}`));
                break;
            }
        }
    }

    return allJobs;
}

module.exports = { searchLinkedIn };
