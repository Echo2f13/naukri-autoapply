'use strict';

const chalk = require('chalk');
const { randomDelay, humanScroll } = require('../../automation/utils');
const { createNormalizedJob } = require('../../discovery/normalizedJob');
const selectors = require('./selectors');

const EXP_LABELS = { 0: 'Fresher', 1: '1 year', 2: '2 years' };

/**
 * Opens the Naukri "Sort by" dropdown and selects "Date".
 * @param {import('playwright').Page} tab 
 */
async function selectSortByDate(tab) {
    try {
        const triggerBtn = tab.locator(selectors.sortTrigger);
        if (!(await triggerBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
            return;
        }

        const titleAttr = await triggerBtn.getAttribute('title').catch(() => '');
        const btnText = await triggerBtn.innerText().catch(() => '');
        if ((titleAttr || btnText).toLowerCase().includes('date')) {
            return;
        }

        await triggerBtn.click();
        await randomDelay(400, 700);

        const dateAnchor = tab.locator(selectors.sortDateOption);
        if (await dateAnchor.isVisible({ timeout: 2500 }).catch(() => false)) {
            await dateAnchor.click();
            await randomDelay(1500, 2500);
            console.log(chalk.green('  [Naukri] Sort by Date applied.'));
        }
    } catch (err) {
        console.log(chalk.yellow(`  ⚠️ [Naukri] selectSortByDate: ${err.message}`));
    }
}

/**
 * Sets the experience slider filter.
 * @param {import('playwright').Page} tab 
 * @param {number} maxYears 
 */
async function setExperienceFilter(tab, maxYears) {
    try {
        const handle = tab.locator(selectors.experienceSliderHandle).first();
        const rail = tab.locator(selectors.experienceSliderRail).first();

        if (!(await handle.isVisible({ timeout: 4000 }).catch(() => false))) {
            return;
        }

        const railBox = await rail.boundingBox();
        const handleBox = await handle.boundingBox();
        if (!railBox || !handleBox) return;

        const SLIDER_MAX_YEARS = 30;
        const targetX = railBox.x + (maxYears / SLIDER_MAX_YEARS) * railBox.width;
        const handleCenterX = handleBox.x + handleBox.width / 2;
        const handleCenterY = handleBox.y + handleBox.height / 2;

        await tab.mouse.move(handleCenterX, handleCenterY);
        await tab.mouse.down();
        await tab.mouse.move(targetX, handleCenterY, { steps: 8 });
        await tab.mouse.up();
        await randomDelay(1000, 1800);
        console.log(chalk.green(`  [Naukri] Experience slider set to ${maxYears} yr(s).`));
    } catch (err) {
        console.log(chalk.yellow(`  ⚠️ [Naukri] setExperienceFilter: ${err.message}`));
    }
}

/**
 * Extracts raw job cards from search result page DOM.
 * @param {import('playwright').Page} tab 
 * @returns {Promise<Array>}
 */
async function extractRawJobCards(tab) {
    return tab.evaluate((sel) => {
        const cards = Array.from(document.querySelectorAll(sel.jobCard));
        return cards.map(card => {
            const titleEl = card.querySelector(sel.jobTitle);
            const companyEl = card.querySelector(sel.companyName);
            const expEl = card.querySelector(sel.experience);
            const locEl = card.querySelector(sel.location);
            const jobUrl = titleEl ? titleEl.href : '';

            let postedAge = '';
            const dateEl = card.querySelector(sel.postedAge);
            if (dateEl) postedAge = dateEl.innerText.trim();

            const tags = Array.from(card.querySelectorAll(sel.tags)).map(t => t.innerText.trim());
            const hasApplied = card.innerText.includes('Applied') || !!card.querySelector('.applied-tag');

            return {
                title: titleEl?.innerText?.trim() || 'Unknown',
                company: companyEl?.innerText?.trim() || 'Unknown',
                location: locEl?.innerText?.trim() || 'India',
                experience: expEl?.innerText?.trim() || 'N/A',
                jobUrl,
                skills: tags,
                postedAge,
                isAppliedOnPage: hasApplied
            };
        });
    }, selectors);
}

/**
 * Searches Naukri using keywords, locations, and experience bands.
 * @param {import('playwright').Page} page 
 * @param {Object} opts 
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
 */
async function searchNaukri(page, opts = {}) {
    const {
        keyword = 'AI Engineer',
        location = 'india',
        experienceLevels = [0, 1],
        maxPages = 2
    } = opts;

    const allNormalized = [];
    const seenUrls = new Set();
    const slug = keyword.toLowerCase().replace(/\s+/g, '-');

    for (let i = 0; i < experienceLevels.length; i++) {
        const expVal = experienceLevels[i];
        const expLabel = EXP_LABELS[expVal] ?? `${expVal} yr`;
        console.log(chalk.blue(`\n[Naukri Search] "${keyword}" | ${location} | ${expLabel}`));

        let activeTab = page;
        let isSideTab = false;
        if (i > 0) {
            activeTab = await page.context().newPage();
            isSideTab = true;
        }

        try {
            let baseUrl = null;
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
                let url;
                if (pageNum === 1 || !baseUrl) {
                    url = `https://www.naukri.com/${slug}-jobs?k=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}&experience=${expVal}&sortType=1&pageNo=1`;
                } else {
                    url = baseUrl.includes('pageNo=')
                        ? baseUrl.replace(/pageNo=\d+/, `pageNo=${pageNum}`)
                        : `${baseUrl}&pageNo=${pageNum}`;
                }

                console.log(chalk.gray(`  [Naukri] Page ${pageNum}: ${url}`));
                await activeTab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await randomDelay(1500, 2500);

                if (pageNum === 1) {
                    await selectSortByDate(activeTab);
                    await setExperienceFilter(activeTab, expVal);
                    await randomDelay(400, 700);
                    baseUrl = activeTab.url();
                }

                await humanScroll(activeTab);
                await randomDelay(600, 1000);

                const rawCards = await extractRawJobCards(activeTab);
                let addedThisPage = 0;

                for (const raw of rawCards) {
                    if (raw.jobUrl && !seenUrls.has(raw.jobUrl)) {
                        seenUrls.add(raw.jobUrl);
                        allNormalized.push(createNormalizedJob({
                            source: 'NAUKRI',
                            sourceUrl: raw.jobUrl,
                            applicationUrl: raw.jobUrl,
                            title: raw.title,
                            company: raw.company,
                            location: raw.location,
                            experience: raw.experience,
                            skills: raw.skills,
                            postedAge: raw.postedAge,
                            rawPayload: raw
                        }));
                        addedThisPage++;
                    }
                }

                console.log(chalk.gray(`  [Naukri] Page ${pageNum}: +${addedThisPage} new unique jobs (running total: ${allNormalized.length})`));
                if (rawCards.length === 0) break;
            }
        } finally {
            if (isSideTab) {
                await activeTab.close().catch(() => {});
            }
        }
    }

    console.log(chalk.green(`[Naukri Search] Complete — ${allNormalized.length} unique normalized jobs collected.`));
    return allNormalized;
}

module.exports = {
    searchNaukri,
    selectSortByDate,
    setExperienceFilter
};
