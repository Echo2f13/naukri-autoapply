'use strict';

const crypto = require('crypto');

/**
 * Universal NormalizedJob representation across all discovery sources.
 *
 * @typedef {Object} NormalizedJob
 * @property {string} id - Deterministic unique identifier
 * @property {'NAUKRI'|'LINKEDIN'|'WELLFOUND'|'WHATSAPP'} source - Platform of discovery
 * @property {string} sourceJobId - Platform-specific job ID
 * @property {string} sourceUrl - Listing URL where job was found
 * @property {string} applicationUrl - True destination / ATS application URL
 * @property {'NATIVE'|'EXTERNAL_ATS'|'DIRECT_URL'|'UNKNOWN'} applicationType - Application routing type
 * @property {string} title - Standardized job title
 * @property {string} company - Standardized company name
 * @property {string[]} locations - List of locations / cities
 * @property {boolean} isRemote - Whether the role is remote / WFH
 * @property {number} minExperience - Minimum experience requirement in years
 * @property {number} maxExperience - Maximum experience requirement in years
 * @property {string[]} skills - Array of required or preferred skills
 * @property {string} employmentType - Full-time, Internship, Contract, etc.
 * @property {string} description - Job description text
 * @property {string|null} postedAge - Human-readable age (e.g. "Just now", "2 days ago")
 * @property {Date|null} postedAt - Inferred or exact posting date
 * @property {Date} discoveredAt - Timestamp when the job was discovered
 * @property {Record<string, any>} rawPayload - Original unprocessed source payload
 */

/**
 * Generates a consistent hash fingerprint for deduplication.
 * @param {string} company 
 * @param {string} title 
 * @param {string} location 
 * @returns {string} SHA-256 hex string
 */
function generateJobFingerprint(company = '', title = '', location = '') {
    const cleanCompany = (company || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    const cleanTitle = (title || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    const cleanLoc = (location || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    return crypto.createHash('sha256').update(`${cleanCompany}_${cleanTitle}_${cleanLoc}`).digest('hex');
}

/**
 * Parses min and max experience from raw text strings.
 * e.g. "0-2 Yrs" -> { min: 0, max: 2 }
 * e.g. "Fresher" -> { min: 0, max: 0 }
 * e.g. "5+ years" -> { min: 5, max: 30 }
 * @param {string} expStr 
 * @returns {{ min: number, max: number }}
 */
function parseExperienceRange(expStr = '') {
    if (!expStr || typeof expStr !== 'string') return { min: 0, max: 30 };
    const clean = expStr.toLowerCase().trim();
    if (clean.includes('fresher') || clean.includes('entry')) {
        return { min: 0, max: 1 };
    }
    const nums = clean.match(/\d+/g);
    if (!nums || nums.length === 0) {
        return { min: 0, max: 30 };
    }
    if (nums.length === 1) {
        const val = parseInt(nums[0], 10);
        return { min: val, max: clean.includes('+') ? 30 : val };
    }
    return {
        min: parseInt(nums[0], 10),
        max: parseInt(nums[1], 10)
    };
}

/**
 * Factory to build a NormalizedJob contract from raw source data.
 * @param {Partial<NormalizedJob>} data 
 * @returns {NormalizedJob}
 */
function createNormalizedJob(data = {}) {
    const rawTitle = data.title !== undefined ? data.title : data.role;
    const title = rawTitle !== null && rawTitle !== undefined ? String(rawTitle).trim() : null;
    const rawCompany = data.company;
    const company = rawCompany !== null && rawCompany !== undefined ? String(rawCompany).trim() : null;
    const needsReview = !!data.needsReview || !title || !company;
    
    // Normalize locations array
    let locations = [];
    if (Array.isArray(data.locations)) {
        locations = data.locations.map(l => String(l).trim()).filter(Boolean);
    } else if (typeof data.location === 'string' && data.location.trim()) {
        locations = data.location.split(/[,/|]/).map(l => l.trim()).filter(Boolean);
    } else {
        locations = ['India'];
    }

    const locText = locations.join(' ').toLowerCase();
    const isRemote = data.isRemote ?? (
        locText.includes('remote') ||
        locText.includes('wfh') ||
        locText.includes('work from home') ||
        (title ? title.toLowerCase().includes('remote') : false) ||
        (title ? title.toLowerCase().includes('wfh') : false)
    );

    // Experience calculation
    let minExperience = 0;
    let maxExperience = 30;
    if (typeof data.minExperience === 'number') {
        minExperience = data.minExperience;
        maxExperience = typeof data.maxExperience === 'number' ? data.maxExperience : 30;
    } else if (data.experience) {
        const parsed = parseExperienceRange(data.experience);
        minExperience = parsed.min;
        maxExperience = parsed.max;
    }

    const sourceUrl = data.sourceUrl || data.jobUrl || '';
    const applicationUrl = data.applicationUrl || data.externalUrl || sourceUrl;
    
    let applicationType = data.applicationType || 'UNKNOWN';
    if (applicationType === 'UNKNOWN') {
        if (/workday|greenhouse|lever|ashby|smartrecruiters|taleo|zoho|careers\./i.test(applicationUrl)) {
            applicationType = 'EXTERNAL_ATS';
        } else if (data.source === 'NAUKRI' && !data.externalUrl) {
            applicationType = 'NATIVE';
        } else if (data.source === 'LINKEDIN' && data.isEasyApply) {
            applicationType = 'NATIVE';
        }
    }

    const fingerprint = generateJobFingerprint(company, title, locations[0] || 'India');
    const id = data.id || fingerprint;

    const normalized = {
        id,
        source: data.source || 'NAUKRI',
        sourceJobId: data.sourceJobId || (sourceUrl.match(/(\d{10,})/)?.[1] || id.slice(0, 16)),
        sourceUrl,
        applicationUrl,
        applicationType,
        title,
        company,
        locations,
        isRemote,
        minExperience,
        maxExperience,
        skills: Array.isArray(data.skills) ? data.skills : [],
        employmentType: data.employmentType || 'Full-time',
        description: data.description || '',
        postedAge: data.postedAge || '',
        postedAt: data.postedAt || null,
        discoveredAt: data.discoveredAt || new Date(),
        needsReview,
        rawPayload: data.rawPayload || { ...data },

        // Backward compatibility getters for legacy modules
        get role() { return this.title; },
        get jobUrl() { return this.applicationUrl || this.sourceUrl; },
        get location() { return this.locations.join(', '); },
        get experience() { return `${this.minExperience}-${this.maxExperience} Yrs`; }
    };

    return normalized;
}

module.exports = {
    createNormalizedJob,
    generateJobFingerprint,
    parseExperienceRange
};
