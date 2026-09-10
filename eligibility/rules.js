'use strict';

const profile = require('../config/profile');

/**
 * Predicate rule: Evaluates minimum experience against candidate's threshold.
 */
function checkExperienceRule(job, maxCandidateExp = 1) {
    const threshold = maxCandidateExp + 1; // 1-year tolerance for bucket ranges (e.g. 1-3 yrs)
    if (typeof job.minExperience === 'number' && job.minExperience > threshold) {
        return {
            passed: false,
            reason: 'SKIPPED_EXPERIENCE',
            detail: `Job requires minimum ${job.minExperience} yrs exp (candidate max: ${threshold} yrs)`
        };
    }
    return { passed: true };
}

/**
 * Predicate rule: Evaluates job location against candidate preferences.
 */
function checkLocationRule(job, allowedLocations = profile.locations) {
    if (job.isRemote) {
        return { passed: true, detail: 'Remote position' };
    }

    const jobLocs = (job.locations || []).map(l => l.toLowerCase());
    const allowed = (allowedLocations || ['Hyderabad', 'Bangalore', 'Chennai', 'Remote']).map(l => l.toLowerCase());

    const hasAllowed = jobLocs.some(jLoc => 
        allowed.some(aLoc => aLoc === 'remote' || aLoc === 'india' || jLoc.includes(aLoc) || aLoc.includes(jLoc))
    );

    if (!hasAllowed && jobLocs.length > 0) {
        return {
            passed: false,
            reason: 'SKIPPED_LOCATION',
            detail: `Job locations [${job.locations.join(', ')}] outside allowed: [${allowed.join(', ')}]`
        };
    }

    return { passed: true };
}

/**
 * Predicate rule: Checks if company is blacklisted in profile.
 */
function checkCompanyRule(job, excludedCompanies = profile.excludedCompanies) {
    const comp = (job.company || '').toLowerCase().trim();
    if (!comp) return { passed: true };

    const isExcluded = (excludedCompanies || []).some(exc => comp.includes(exc.toLowerCase()));
    if (isExcluded) {
        return {
            passed: false,
            reason: 'SKIPPED_EXCLUDED_COMPANY',
            detail: `Company "${job.company}" is in excluded list`
        };
    }
    return { passed: true };
}

/**
 * Predicate rule: Rejects obvious non-technical roles.
 */
function checkRoleRelevanceRule(job) {
    const title = (job.title || '').toLowerCase();
    const blacklist = [
        'telecaller', 'telesales', 'bpo', 'voice process', 'customer support',
        'sales executive', 'business development executive', 'marketing executive',
        'content writer', 'accountant', 'hr recruiter', 'recruiter'
    ];

    for (const b of blacklist) {
        if (title.includes(b) && !title.includes('engineer') && !title.includes('developer')) {
            return {
                passed: false,
                reason: 'SKIPPED_IRRELEVANT_ROLE',
                detail: `Title "${job.title}" matches excluded role keyword: "${b}"`
            };
        }
    }
    return { passed: true };
}

module.exports = {
    checkExperienceRule,
    checkLocationRule,
    checkCompanyRule,
    checkRoleRelevanceRule
};
