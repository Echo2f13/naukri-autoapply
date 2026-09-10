'use strict';

const chalk = require('chalk');
const { randomDelay, humanScroll } = require('../../automation/utils');
const { createNormalizedJob } = require('../../discovery/normalizedJob');
const selectors = require('./selectors');

/**
 * Extracts recommended jobs from Naukri and returns NormalizedJob[].
 * @param {import('playwright').Page} page 
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
 */
async function extractRecommendedJobs(page) {
    console.log(chalk.blue('\n[Naukri] Navigating to Recommended Jobs page...'));
    const recommendedUrl = 'https://www.naukri.com/recommendedjobs';

    try {
        await page.goto(recommendedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3000);

        // Scroll to trigger lazy-loaded job tuples
        console.log(chalk.gray('  [Naukri] Scrolling page to trigger lazy-loading...'));
        await humanScroll(page);
        await randomDelay(1000, 2000);

        // Extract raw job tuples from page DOM
        const rawJobs = await page.evaluate((sel) => {
            const cards = Array.from(document.querySelectorAll(sel.jobCard));
            return cards.map(card => {
                const titleEl = card.querySelector(sel.jobTitle);
                const companyEl = card.querySelector(sel.companyName);
                const expEl = card.querySelector(sel.experience);
                const locEl = card.querySelector(sel.location);
                const jobUrl = titleEl ? titleEl.href : '';

                // Extract tags and posting age
                const tags = Array.from(card.querySelectorAll(sel.tags)).map(t => t.innerText.trim());
                let postedAge = '';
                const dateEl = card.querySelector(sel.postedAge);
                if (dateEl) {
                    postedAge = dateEl.innerText.trim();
                }

                const hasAppliedTag = !!card.querySelector('.applied-tag, [class*="applied-tag"], .applied');
                const hasAppliedText = card.innerText.includes('Applied');

                return {
                    title: titleEl?.innerText?.trim() || 'Unknown Title',
                    company: companyEl?.innerText?.trim() || 'Unknown Company',
                    experience: expEl?.innerText?.trim() || '0-1 Yrs',
                    location: locEl?.innerText?.trim() || 'India',
                    jobUrl,
                    skills: tags,
                    postedAge,
                    isAppliedOnPage: hasAppliedTag || hasAppliedText
                };
            });
        }, selectors);

        const normalizedJobs = rawJobs
            .filter(j => j.jobUrl && j.jobUrl.startsWith('http'))
            .map(j => createNormalizedJob({
                source: 'NAUKRI',
                sourceUrl: j.jobUrl,
                applicationUrl: j.jobUrl,
                title: j.title,
                company: j.company,
                location: j.location,
                experience: j.experience,
                skills: j.skills,
                postedAge: j.postedAge,
                rawPayload: j
            }));

        console.log(chalk.green(`  [Naukri] Extracted ${normalizedJobs.length} recommended jobs.`));
        return normalizedJobs;

    } catch (err) {
        console.error(chalk.red(`  ❌ [Naukri] Error extracting recommended jobs: ${err.message}`));
        return [];
    }
}

module.exports = { extractRecommendedJobs };
