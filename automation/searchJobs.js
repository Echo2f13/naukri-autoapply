const settings = require('../config/settings');
const { randomDelay, humanScroll } = require('./utils');
const chalk = require('chalk');

const EXP_LABELS = { 0: 'Fresher', 1: '1 year', 2: '2 years' };

// ─── Sort by Date ─────────────────────────────────────────────────────────────
/**
 * Opens the Naukri "Sort by" dropdown and selects the "Date" option.
 * Exact selectors confirmed from live DOM inspection:
 *   - Trigger : button#filter-sort
 *   - Date opt: a[data-id="filter-sort-f"]
 * @param {import('playwright').Page} tab
 */
async function selectSortByDate(tab) {
    try {
        const triggerBtn = tab.locator('button#filter-sort');
        const triggerVisible = await triggerBtn.isVisible({ timeout: 4000 }).catch(() => false);

        if (!triggerVisible) {
            console.log(chalk.yellow('  ⚠️  Sort trigger (button#filter-sort) not found — skipping sort.'));
            return;
        }

        // Check current state
        const titleAttr  = await triggerBtn.getAttribute('title').catch(() => '');
        const btnText    = await triggerBtn.innerText().catch(() => '');
        const currentSort = (titleAttr || btnText).toLowerCase();

        if (currentSort.includes('date')) {
            console.log(chalk.gray('  [Sort] Already sorted by Date.'));
            return;
        }

        // Open dropdown
        console.log(chalk.gray(`  [Sort] Opening dropdown (current: "${titleAttr || btnText}")...`));
        await triggerBtn.click();
        await randomDelay(400, 700);

        // Click Date anchor
        const dateAnchor = tab.locator('a[data-id="filter-sort-f"]');
        if (await dateAnchor.isVisible({ timeout: 2500 }).catch(() => false)) {
            console.log(chalk.gray('  [Sort] Clicking "Date"...'));
            await dateAnchor.click();
            await randomDelay(1500, 2500); // wait for results to reload
            console.log(chalk.green('  ✅ Sort by Date applied.'));
        } else {
            // Fallback — click the LI that wraps the anchor
            const dateLi = tab.locator('li:has(a[data-id="filter-sort-f"])');
            if (await dateLi.isVisible({ timeout: 1000 }).catch(() => false)) {
                await dateLi.click();
                await randomDelay(1500, 2500);
                console.log(chalk.green('  ✅ Sort by Date applied (LI fallback).'));
            } else {
                console.log(chalk.yellow('  ⚠️  Date option not found in sort dropdown.'));
            }
        }
    } catch (err) {
        console.log(chalk.yellow(`  ⚠️  selectSortByDate: ${err.message}`));
    }
}


// ─── Experience Slider Filter ─────────────────────────────────────────────────
/**
 * Sets the Naukri experience slider to the desired maximum (e.g. 0 = Fresher, 1 = 1 yr).
 * The slider rail spans 0–30 years. We drag the handle to the proportional position.
 *
 * @param {import('playwright').Page} tab
 * @param {number} maxYears  - 0 for Fresher, 1 for 1 year
 */
async function setExperienceFilter(tab, maxYears) {
    try {
        const handle = tab.locator('section.experiencecontainer .handle').first();
        const rail   = tab.locator('section.experiencecontainer .rc-slider-rail').first();

        const handleVisible = await handle.isVisible({ timeout: 5000 }).catch(() => false);
        if (!handleVisible) {
            console.log(chalk.yellow('  ⚠️  Experience slider not found — skipping filter.'));
            return;
        }

        const railBox   = await rail.boundingBox();
        const handleBox = await handle.boundingBox();
        if (!railBox || !handleBox) {
            console.log(chalk.yellow('  ⚠️  Could not get slider bounding boxes — skipping filter.'));
            return;
        }

        const SLIDER_MAX_YEARS = 30;
        // Target X = left edge of rail + proportional offset
        const targetX = railBox.x + (maxYears / SLIDER_MAX_YEARS) * railBox.width;
        const handleCenterX = handleBox.x + handleBox.width / 2;
        const handleCenterY = handleBox.y + handleBox.height / 2;

        console.log(chalk.gray(
            `  [Filter] Dragging experience slider to ${maxYears} yr(s) ` +
            `(rail: ${railBox.x.toFixed(0)}–${(railBox.x + railBox.width).toFixed(0)}px, ` +
            `target: ${targetX.toFixed(0)}px)`
        ));

        // Drag the handle to the target position
        await tab.mouse.move(handleCenterX, handleCenterY);
        await tab.mouse.down();
        await tab.mouse.move(targetX, handleCenterY, { steps: 10 });
        await tab.mouse.up();

        // Wait for filter to apply (page reloads or results update)
        await randomDelay(1500, 2500);
        console.log(chalk.green(`  ✅ Experience filter set to max ${maxYears} yr(s).`));

    } catch (err) {
        console.log(chalk.yellow(`  ⚠️  setExperienceFilter: ${err.message}`));
    }
}

async function extractJobCards(tab) {
    return tab.evaluate((sel) => {
        const cards = document.querySelectorAll(sel.jobCard);
        return Array.from(cards).map(el => {
            const titleEl   = el.querySelector(sel.jobTitle);
            const companyEl = el.querySelector(sel.companyName);
            const locEl     = el.querySelector('.location, [class*="location"]');
            const expEl     = el.querySelector('.experience, [class*="experience"]');
            let jobUrl      = titleEl?.href || '';

            const jobId = el.getAttribute('data-job-id');
            if (!jobUrl && jobId) {
                jobUrl = `https://www.naukri.com/job-listings-${jobId}`;
            }

            const hasAppliedTag  = !!el.querySelector('.applied-status, .applied-tag');
            const hasAppliedText = Array.from(el.querySelectorAll('span, p, div'))
                .some(s => s.innerText?.includes('Applied'));

            // Extract posting age
            let postedAge = '';
            const ageEl = el.querySelector(
                '.posted-ago, .post-age, [class*="date"], [class*="posted"]'
            );
            if (ageEl) {
                postedAge = ageEl.innerText?.trim() || '';
            } else {
                const tags = Array.from(el.querySelectorAll('span, p, div, label'));
                const found = tags.find(t => {
                    const text = (t.innerText || '').toLowerCase();
                    return text.includes('ago') || text.includes('today') || text.includes('just now');
                });
                if (found) postedAge = found.innerText?.trim() || '';
            }

            return {
                role:            titleEl?.innerText?.trim()   || 'N/A',
                company:         companyEl?.innerText?.trim() || 'N/A',
                location:        locEl?.innerText?.trim()     || 'N/A',
                experience:      expEl?.innerText?.trim()     || 'N/A',
                jobUrl,
                isAppliedOnPage: hasAppliedTag || hasAppliedText,
                postedAge
            };
        });
    }, settings.selectors);
}

// ─── Recommended Jobs ─────────────────────────────────────────────────────────
/**
 * Extracts job listings from the Naukri recommended jobs page.
 * @param {import('playwright').Page} page
 */
async function extractRecommendedJobs(page) {
    console.log(chalk.blue('[Jobs] Navigating to Recommended Jobs...'));
    await page.goto(settings.recommendedJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(800, 1400);
    await humanScroll(page);

    const jobs = await page.evaluate((sel) => {
        const jobElements = document.querySelectorAll(sel.jobCard);
        return Array.from(jobElements).map(el => {
            const titleEl   = el.querySelector(sel.jobTitle);
            const companyEl = el.querySelector(sel.companyName);
            const locEl     = el.querySelector('.location');
            const expEl     = el.querySelector('.experience');
            let jobUrl      = titleEl?.href || 'N/A';

            const jobId = el.getAttribute('data-job-id');
            if ((jobUrl === 'N/A' || !jobUrl) && jobId) {
                jobUrl = `https://www.naukri.com/job-listings-${jobId}`;
            }

            const hasAppliedTag  = !!el.querySelector('.applied-status, .applied-tag');
            const hasAppliedText = Array.from(el.querySelectorAll('span, p, div'))
                .some(s => s.innerText?.includes('Applied'));

            let postedAge = '';
            const ageEl = el.querySelector('.posted-ago, .post-age, [class*="date"], [class*="posted"]');
            if (ageEl) {
                postedAge = ageEl.innerText?.trim() || '';
            } else {
                const tags = Array.from(el.querySelectorAll('span, p, div, label'));
                const found = tags.find(t => {
                    const text = (t.innerText || '').toLowerCase();
                    return text.includes('ago') || text.includes('today') || text.includes('just now');
                });
                if (found) postedAge = found.innerText?.trim() || '';
            }

            return {
                role:            titleEl?.innerText?.trim()   || 'N/A',
                company:         companyEl?.innerText?.trim() || 'N/A',
                location:        locEl?.innerText?.trim()     || 'N/A',
                experience:      expEl?.innerText?.trim()     || 'N/A',
                jobUrl,
                isAppliedOnPage: hasAppliedTag || hasAppliedText,
                postedAge
            };
        });
    }, settings.selectors);

    const filteredJobs = jobs.filter(j => j.jobUrl && j.jobUrl !== 'N/A');
    console.log(chalk.gray(`  Extracted ${jobs.length} jobs, ${filteredJobs.length} with valid URLs.`));
    return filteredJobs;
}

// ─── Keyword Search ───────────────────────────────────────────────────────────
/**
 * Searches Naukri by keyword + experience filter, sorts by Date, scrolls each
 * page fully, then collects and returns all job listings.
 *
 * Workflow per experience level (sequential, never closes the main page):
 *   1. Navigate to search results page N
 *   2. On page 1: click Sort by Date → wait for reload
 *   3. Scroll the full page to load lazy content
 *   4. Extract all job cards
 *   5. Navigate to page N+1, repeat from step 3 (sort is preserved via URL sortType=1)
 *
 * When multiple experience levels are chosen (Fresher + 1 yr), a new browser
 * tab is opened for the second pass so the main page is NEVER closed.
 *
 * @param {import('playwright').Page} page   - Main browser page (used for applying later)
 * @param {Object}  opts
 * @param {string}    opts.keyword
 * @param {string}    opts.location
 * @param {number[]}  opts.experienceLevels  - e.g. [0] or [1] or [0, 1]
 * @param {number}    opts.maxPages          - Pages per experience level (default 2)
 * @returns {Promise<Array>}
 */
async function searchNaukriJobs(page, opts = {}) {
    const {
        keyword        = 'python',
        location       = 'india',
        experienceLevels = [0, 1],
        maxPages       = 2
    } = opts;

    const allJobs  = [];
    const seenUrls = new Set();

    /**
     * Run one experience-level pass on the given tab.
     * The tab is ONLY closed if it is not the original main page.
     */
    async function runSearchPass(tab, expVal) {
        const expLabel = EXP_LABELS[expVal] ?? `${expVal} yr`;
        const slug     = keyword.toLowerCase().replace(/\s+/g, '-');
        console.log(chalk.blue(`\n[Search] "${keyword}" | ${location} | ${expLabel}`));

        let baseUrl = null; // Will be set from the actual URL after filters are applied on page 1

        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            let url;

            if (pageNum === 1 || !baseUrl) {
                // Build the initial URL for page 1 (sortType=1 requests date sort in URL)
                url = `https://www.naukri.com/${slug}-jobs` +
                      `?k=${encodeURIComponent(keyword)}` +
                      `&l=${encodeURIComponent(location)}` +
                      `&experience=${expVal}` +
                      `&sortType=1` +
                      `&pageNo=1`;
            } else {
                // Replace pageNo in the filtered base URL from page 1
                if (baseUrl.includes('pageNo=')) {
                    url = baseUrl.replace(/pageNo=\d+/, `pageNo=${pageNum}`);
                } else {
                    url = `${baseUrl}&pageNo=${pageNum}`;
                }
            }

            console.log(chalk.gray(`  → Page ${pageNum}: ${url}`));

            try {
                await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await randomDelay(1500, 2500);

                if (pageNum === 1) {
                    // Step 1: Sort by Date
                    await selectSortByDate(tab);
                    // Step 2: Set experience slider
                    await setExperienceFilter(tab, expVal);

                    // Capture the page URL AFTER all filters are applied
                    // (Naukri updates the URL when filters change)
                    await randomDelay(300, 500);
                    baseUrl = tab.url();
                    console.log(chalk.gray(`  [Search] Filtered base URL: ${baseUrl}`));
                }

                // Scroll the full page to trigger lazy-loading of all cards
                await humanScroll(tab);
                await randomDelay(600, 1000);

                // Extract job cards
                const jobs = await extractJobCards(tab);

                let newCount = 0;
                for (const job of jobs) {
                    if (job.jobUrl && !seenUrls.has(job.jobUrl)) {
                        seenUrls.add(job.jobUrl);
                        allJobs.push(job);
                        newCount++;
                    }
                }

                console.log(chalk.gray(
                    `  Page ${pageNum}: ${jobs.length} cards found, ` +
                    `${newCount} new (running total: ${allJobs.length})`
                ));

                if (jobs.length === 0) {
                    console.log(chalk.yellow('  No cards found — stopping this pass early.'));
                    break;
                }

            } catch (err) {
                console.log(chalk.yellow(`  ⚠️  Page ${pageNum} error: ${err.message}`));
                break;
            }
        }
    }

    // ── Run each experience level pass ─────────────────────────────────────────
    // First pass always uses the main page (so it survives to the apply phase).
    // Extra passes open a temporary side-tab that is closed when done.
    for (let i = 0; i < experienceLevels.length; i++) {
        const expVal = experienceLevels[i];

        if (i === 0) {
            // Use the main page for the first experience level
            await runSearchPass(page, expVal);
        } else {
            // Open a side tab for each additional experience level
            const sideTab = await page.context().newPage();
            try {
                await runSearchPass(sideTab, expVal);
            } finally {
                // Always close the side tab — never the main page
                console.log(chalk.gray(`  Closing side tab for experience=${expVal}.`));
                await sideTab.close().catch(() => {});
            }
        }
    }

    console.log(chalk.green(`\n[Search] Done — ${allJobs.length} unique jobs collected.`));
    return allJobs;
}

module.exports = { extractRecommendedJobs, searchNaukriJobs };
