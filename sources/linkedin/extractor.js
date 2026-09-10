'use strict';

const { createNormalizedJob, parseExperienceRange } = require('../../discovery/normalizedJob');
const selectors = require('./selectors');

/**
 * Extracts raw job card metadata from all visible cards in the search results.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<Object>>}
 */
async function extractLinkedInCardElements(page) {
    return await page.evaluate((sel) => {
        const cards = Array.from(document.querySelectorAll(sel.jobCard));
        return cards.map(card => {
            const titleEl = card.querySelector(sel.jobTitle);
            const companyEl = card.querySelector(sel.companyName);
            const locEl = card.querySelector(sel.location);
            const postedEl = card.querySelector(sel.postedAge);
            const easyApplyEl = card.querySelector(sel.easyApplyBadge) || (card.innerText.includes('Easy Apply') ? card : null);

            let jobUrl = '';
            if (titleEl) {
                jobUrl = titleEl.getAttribute('href') || '';
                if (jobUrl.startsWith('/')) {
                    jobUrl = `https://www.linkedin.com${jobUrl.split('?')[0]}`;
                } else if (jobUrl.startsWith('http')) {
                    jobUrl = jobUrl.split('?')[0];
                }
            }

            const cardJobId = card.getAttribute('data-job-id') || card.getAttribute('data-occludable-job-id') || '';
            const urlJobId = (jobUrl.match(/view\/(\d+)/) || jobUrl.match(/currentJobId=(\d+)/))?.[1] || '';
            const sourceJobId = urlJobId || cardJobId;

            return {
                title: titleEl?.innerText?.trim() || '',
                company: companyEl?.innerText?.trim() || '',
                location: locEl?.innerText?.trim() || '',
                jobUrl,
                sourceJobId,
                postedAge: postedEl?.innerText?.trim() || '',
                isEasyApply: !!easyApplyEl
            };
        }).filter(j => j.title && (j.jobUrl || j.sourceJobId));
    }, selectors);
}

/**
 * Extracts complete job details from the active right-hand details pane or full job page.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   description: string,
 *   workplaceType: string|null,
 *   isRemote: boolean,
 *   employmentType: string|null,
 *   experience: string|null,
 *   skills: string[],
 *   isEasyApply: boolean,
 *   alreadyApplied: boolean
 * }>}
 */
async function extractJobDetailsFromPane(page) {
    try {
        return await page.evaluate((sel) => {
            // 1. Description
            let descText = '';
            const descEl = document.querySelector(sel.description);
            if (descEl) {
                descText = descEl.innerText.trim();
            }

            // 2. Insights (Workplace type, Employment type, Experience level)
            const insightEls = Array.from(document.querySelectorAll(sel.insights));
            const insightsText = insightEls.map(el => el.innerText.trim()).join(' · ');

            let workplaceType = null;
            if (/remote/i.test(insightsText)) workplaceType = 'Remote';
            else if (/hybrid/i.test(insightsText)) workplaceType = 'Hybrid';
            else if (/on-site/i.test(insightsText)) workplaceType = 'On-site';

            const isRemote = workplaceType === 'Remote' || /work from home|remote/i.test(descText.slice(0, 500));

            let employmentType = null;
            if (/full-time/i.test(insightsText)) employmentType = 'Full-time';
            else if (/part-time/i.test(insightsText)) employmentType = 'Part-time';
            else if (/contract/i.test(insightsText)) employmentType = 'Contract';
            else if (/internship/i.test(insightsText)) employmentType = 'Internship';

            let experience = null;
            if (/entry level/i.test(insightsText)) experience = '0-2 Yrs';
            else if (/associate/i.test(insightsText)) experience = '1-3 Yrs';
            else if (/mid-senior/i.test(insightsText)) experience = '3-5 Yrs';

            // 3. Skills extraction
            const skills = [];
            const skillsMatch = insightsText.match(/(\d+)\s+skills?/i);
            const skillChips = Array.from(document.querySelectorAll('.job-details-how-you-match__skills-section li, .job-details-preference-and-skills li'));
            for (const chip of skillChips) {
                const s = chip.innerText.trim();
                if (s && s.length < 40 && !skills.includes(s)) skills.push(s);
            }

            // 4. Apply status
            const buttons = Array.from(document.querySelectorAll('button'));
            const applyBtn = buttons.find(b => 
                b.classList.contains('jobs-apply-button') ||
                /easy apply/i.test(b.innerText || '') ||
                /easy apply/i.test(b.getAttribute('aria-label') || '')
            );
            const isEasyApply = !!applyBtn;

            const alreadyAppliedEl = document.querySelector(sel.alreadyAppliedBadge) ||
                buttons.find(b => /applied/i.test(b.innerText || ''));
            const alreadyApplied = !!alreadyAppliedEl && (
                /applied/i.test(alreadyAppliedEl.innerText || '') || 
                /applied/i.test(alreadyAppliedEl.getAttribute('aria-label') || '')
            );

            return {
                description: descText,
                workplaceType,
                isRemote,
                employmentType,
                experience,
                skills,
                isEasyApply,
                alreadyApplied
            };
        }, selectors);
    } catch (err) {
        return {
            description: '',
            workplaceType: null,
            isRemote: false,
            employmentType: null,
            experience: null,
            skills: [],
            isEasyApply: false,
            alreadyApplied: false
        };
    }
}

/**
 * Builds a NormalizedJob instance strictly preserving the shared architecture contract.
 * Does not fabricate fields: missing fields remain null/empty.
 * 
 * @param {Object} cardData
 * @param {Object} [detailsData={}]
 * @returns {import('../../discovery/normalizedJob').NormalizedJob}
 */
function buildNormalizedLinkedInJob(cardData, detailsData = {}) {
    const title = detailsData.title || cardData.title || 'Unknown Title';
    const company = detailsData.company || cardData.company || 'Unknown Company';
    const location = detailsData.location || cardData.location || '';
    const jobUrl = cardData.jobUrl || (cardData.sourceJobId ? `https://www.linkedin.com/jobs/view/${cardData.sourceJobId}/` : '');

    const isEasyApply = detailsData.isEasyApply !== undefined ? detailsData.isEasyApply : cardData.isEasyApply;
    const applicationType = isEasyApply ? 'NATIVE' : 'EXTERNAL_ATS';

    const expStr = detailsData.experience || cardData.experience || '';
    const expRange = expStr ? parseExperienceRange(expStr) : { min: 0, max: 30 };

    return createNormalizedJob({
        source: 'LINKEDIN',
        sourceJobId: cardData.sourceJobId || '',
        sourceUrl: jobUrl,
        applicationUrl: jobUrl,
        applicationType,
        title,
        company,
        location: location || 'India',
        isRemote: detailsData.isRemote !== undefined ? detailsData.isRemote : (location.toLowerCase().includes('remote')),
        minExperience: expRange.min,
        maxExperience: expRange.max,
        skills: Array.isArray(detailsData.skills) ? detailsData.skills : [],
        employmentType: detailsData.employmentType || (title.toLowerCase().includes('intern') ? 'Internship' : 'Full-time'),
        description: detailsData.description || '',
        postedAge: cardData.postedAge || '',
        rawPayload: {
            ...cardData,
            ...detailsData,
            isEasyApply
        }
    });
}

/**
 * Legacy wrapper: Extracts cards directly from search page.
 * @param {import('playwright').Page} page
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
 */
async function extractLinkedInJobCards(page) {
    const rawCards = await extractLinkedInCardElements(page);
    return rawCards.map(c => buildNormalizedLinkedInJob(c));
}

module.exports = {
    extractLinkedInCardElements,
    extractJobDetailsFromPane,
    buildNormalizedLinkedInJob,
    extractLinkedInJobCards
};
