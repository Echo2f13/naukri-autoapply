'use strict';

const {
    checkExperienceRule,
    checkLocationRule,
    checkCompanyRule,
    checkRoleRelevanceRule
} = require('./rules');
const chalk = require('chalk');

class EligibilityEngine {
    constructor(options = {}) {
        let profile = {};
        try {
            const { loadProfile } = require('../config/profileLoader');
            profile = loadProfile({ throwOnError: false }) || {};
        } catch (_) {}
        this.maxCandidateExp = options.maxCandidateExp ?? (profile.maxExperience || profile.experience || 2);
        this.allowedLocations = options.allowedLocations ?? null;
        this.excludedCompanies = options.excludedCompanies ?? null;
    }

    /**
     * Evaluates all hard eligibility rules on a NormalizedJob.
     * @param {import('../discovery/normalizedJob').NormalizedJob} job 
     * @returns {{ eligible: boolean, reason?: string, detail?: string }}
     */
    evaluate(job) {
        // 1. Company exclusion
        const compRes = checkCompanyRule(job, this.excludedCompanies);
        if (!compRes.passed) return { eligible: false, isEligible: false, reason: compRes.reason, detail: compRes.detail, reasons: [compRes.reason, compRes.detail].filter(Boolean) };

        // 2. Role relevance blacklist
        const roleRes = checkRoleRelevanceRule(job);
        if (!roleRes.passed) return { eligible: false, isEligible: false, reason: roleRes.reason, detail: roleRes.detail, reasons: [roleRes.reason, roleRes.detail].filter(Boolean) };

        // 3. Experience upper bound
        const expRes = checkExperienceRule(job, this.maxCandidateExp);
        if (!expRes.passed) return { eligible: false, isEligible: false, reason: expRes.reason, detail: expRes.detail, reasons: [expRes.reason, expRes.detail].filter(Boolean) };

        // 4. Location match
        const locRes = checkLocationRule(job, this.allowedLocations);
        if (!locRes.passed) return { eligible: false, isEligible: false, reason: locRes.reason, detail: locRes.detail, reasons: [locRes.reason, locRes.detail].filter(Boolean) };

        return { eligible: true, isEligible: true, reasons: [] };
    }

    /**
     * Filters a list of jobs, separating eligible from ineligible with reasons.
     * @param {import('../discovery/normalizedJob').NormalizedJob[]} jobs 
     * @returns {{ eligibleJobs: import('../discovery/normalizedJob').NormalizedJob[], rejected: Array<{ job: any, reason: string, detail: string }> }}
     */
    filter(jobs = []) {
        const eligibleJobs = [];
        const rejected = [];

        for (const job of jobs) {
            const result = this.evaluate(job);
            if (result.eligible) {
                eligibleJobs.push(job);
            } else {
                rejected.push({
                    job,
                    reason: result.reason,
                    detail: result.detail
                });
            }
        }

        if (rejected.length > 0) {
            console.log(chalk.gray(`[Eligibility] Filtered out ${rejected.length} jobs (e.g. ${rejected[0].reason}: ${rejected[0].detail})`));
        }

        return { eligibleJobs, rejected };
    }
}

const defaultEngine = new EligibilityEngine();

/**
 * Convenience helper to evaluate eligibility using standard engine.
 * @param {import('../discovery/normalizedJob').NormalizedJob} job 
 */
function evaluateEligibility(job) {
    return defaultEngine.evaluate(job);
}

module.exports = {
    EligibilityEngine,
    evaluateEligibility
};
