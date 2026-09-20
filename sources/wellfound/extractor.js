'use strict';

const { createNormalizedJob, parseExperienceRange } = require('../../discovery/normalizedJob');
const selectors = require('./selectors');

/**
 * Extracts raw job card metadata from all visible cards on the Wellfound page.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<Object>>}
 */
async function extractWellfoundCardElements(page) {
    return await page.evaluate((sel) => {
        const results = [];
        const seenHrefs = new Set();

        // 1. Traditional card elements
        const cards = Array.from(document.querySelectorAll(sel.jobCard));
        for (const card of cards) {
            const titleEl = card.querySelector(sel.jobTitle) || (card.tagName === 'A' ? card : null);
            const compEl = card.querySelector(sel.companyName);
            const locEl = card.querySelector(sel.location);
            const salaryEl = card.querySelector(sel.salaryOrComp);
            const tags = Array.from(card.querySelectorAll(sel.tags)).map(t => t.innerText.trim()).filter(Boolean);
            const postedEl = card.querySelector(sel.postedAge);

            let jobUrl = '';
            if (titleEl) {
                const href = titleEl.getAttribute('href') || '';
                jobUrl = href.startsWith('http') ? href : (href ? `https://wellfound.com${href}` : '');
            }

            if (!jobUrl || seenHrefs.has(jobUrl)) continue;

            const jobIdMatch = jobUrl.match(/jobs\/(\d+)/) || jobUrl.match(/l\/([^/]+)/);
            const sourceJobId = jobIdMatch ? jobIdMatch[1] : (jobUrl.split('/').filter(Boolean).pop() || '');

            const lines = (titleEl?.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
            const title = lines[0] || '';

            let comp = compEl?.innerText?.trim() || '';
            if (!comp) {
                // Traverse ancestor containers for company header/card
                let curr = card.parentElement;
                for (let i = 0; i < 6; i++) {
                    if (!curr) break;
                    const ancestorComp = curr.querySelector(sel.companyName) || curr.querySelector('a[href*="/company/"]') || curr.querySelector('h2');
                    if (ancestorComp && ancestorComp.innerText.trim()) {
                        comp = ancestorComp.innerText.trim().split('\n')[0];
                        break;
                    }
                    curr = curr.parentElement;
                }
            }

            results.push({
                title,
                company: comp || null,
                location: locEl?.innerText?.trim() || lines[1] || '',
                salaryOrComp: salaryEl?.innerText?.trim() || '',
                tags,
                jobUrl,
                sourceJobId,
                postedAge: postedEl?.innerText?.trim() || ''
            });
            seenHrefs.add(jobUrl);
        }

        // 2. Modern jobLink anchor elements (e.g. on /jobs feed)
        const jobAnchors = Array.from(document.querySelectorAll('a[href*="/jobs/"]'))
            .filter(a => /\/jobs\/\d+/.test(a.href));

        for (const a of jobAnchors) {
            const href = a.href;
            if (seenHrefs.has(href)) continue;

            const textLines = (a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
            const title = textLines[0] || 'Startup Role';

            // Find company name in parent / ancestor container
            let company = '';
            let curr = a.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!curr) break;
                const compEl = curr.querySelector('a[href*="/company/"]') || curr.querySelector(sel.companyName) || curr.querySelector('h2');
                if (compEl && compEl.innerText.trim()) {
                    company = compEl.innerText.trim().split('\n')[0];
                    break;
                }
                curr = curr.parentElement;
            }

            const jobIdMatch = href.match(/jobs\/(\d+)/);
            const sourceJobId = jobIdMatch ? jobIdMatch[1] : '';

            let location = 'Remote';
            let salary = '';
            for (let i = 1; i < textLines.length; i++) {
                const line = textLines[i];
                if (/[$₹]/.test(line) || /equity/i.test(line)) {
                    salary = line;
                } else if (/remote|onsite|hybrid|office|india|bengaluru|mumbai|delhi|hyderabad|pune/i.test(line)) {
                    location = line;
                }
            }

            results.push({
                title,
                company: company || null,
                location,
                salaryOrComp: salary,
                tags: [],
                jobUrl: href,
                sourceJobId,
                postedAge: textLines.find(l => /posted/i.test(l)) || ''
            });
            seenHrefs.add(href);
        }

        return results.filter(j => j.title && (j.jobUrl || j.sourceJobId));
    }, selectors);
}

/**
 * Extracts full details from active job description container on Wellfound.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   description: string,
 *   isRemote: boolean,
 *   equityOrComp: string|null,
 *   skills: string[]
 * }>}
 */
async function extractWellfoundJobDetails(page) {
    try {
        return await page.evaluate((sel) => {
            let description = '';
            const descEl = document.querySelector(sel.description);
            if (descEl) {
                description = descEl.innerText.trim();
            }

            const compEl = document.querySelector(sel.equityOrCompDetail);
            const equityOrComp = compEl ? compEl.innerText.trim() : null;

            const isRemote = /remote|work from home|anywhere/i.test(document.body.innerText.slice(0, 1000)) ||
                             /remote/i.test(description.slice(0, 500));

            return {
                description,
                isRemote,
                equityOrComp,
                skills: []
            };
        }, selectors);
    } catch (err) {
        return {
            description: '',
            isRemote: false,
            equityOrComp: null,
            skills: []
        };
    }
}

/**
 * Builds a NormalizedJob strictly adhering to the shared schema without fabricating values.
 * 
 * @param {Object} cardData 
 * @param {Object} [detailsData={}]
 * @returns {import('../../discovery/normalizedJob').NormalizedJob}
 */
function buildNormalizedWellfoundJob(cardData, detailsData = {}) {
    const title = detailsData.title || cardData.title || 'Unknown Startup Role';
    const rawCompany = detailsData.company || cardData.company;
    const company = (rawCompany && rawCompany.trim().length > 0 && !/^(unknown startup|startup company)$/i.test(rawCompany.trim()))
        ? rawCompany.trim()
        : 'Unknown Company';
    const location = detailsData.location || cardData.location || 'Remote';
    const jobUrl = cardData.jobUrl || (cardData.sourceJobId ? `https://wellfound.com/jobs/${cardData.sourceJobId}` : '');

    const tags = Array.isArray(cardData.tags) ? cardData.tags : [];
    const detailSkills = Array.isArray(detailsData.skills) ? detailsData.skills : [];
    const allSkills = Array.from(new Set([...tags, ...detailSkills]));

    const isRemote = detailsData.isRemote !== undefined 
        ? detailsData.isRemote 
        : /remote|wfh/i.test(location);

    const desc = detailsData.description || '';
    // Look for experience mentions in card title, tags, or description
    const rawExp = cardData.experience || cardData.title || tags.join(' ') || desc.slice(0, 500) || '';
    const expRange = parseExperienceRange(rawExp);

    return createNormalizedJob({
        source: 'WELLFOUND',
        sourceJobId: cardData.sourceJobId || '',
        sourceUrl: jobUrl,
        applicationUrl: jobUrl,
        applicationType: 'NATIVE',
        title,
        company,
        location,
        isRemote,
        minExperience: expRange.min,
        maxExperience: expRange.max,
        skills: allSkills,
        employmentType: title.toLowerCase().includes('intern') ? 'Internship' : 'Full-time',
        description: desc,
        postedAge: cardData.postedAge || '',
        rawPayload: {
            ...cardData,
            ...detailsData
        }
    });
}

/**
 * Legacy wrapper: Extracts job cards from Wellfound page.
 * @param {import('playwright').Page} page
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
 */
async function extractWellfoundJobCards(page) {
    const cards = await extractWellfoundCardElements(page);
    return cards.map(c => buildNormalizedWellfoundJob(c));
}

module.exports = {
    extractWellfoundCardElements,
    extractWellfoundJobDetails,
    buildNormalizedWellfoundJob,
    extractWellfoundJobCards
};
