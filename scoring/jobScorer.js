'use strict';

const profile = require('../config/profile');

/**
 * Formats a score breakdown into a clean, human-readable CLI string.
 * @param {{ score: number, breakdown: Object }} scoreResult 
 * @returns {string}
 */
function formatScoreBreakdown(scoreResult) {
    if (!scoreResult || !scoreResult.breakdown) {
        return `Score: ${scoreResult?.score || 0}/100`;
    }
    const b = scoreResult.breakdown;
    return [
        `Score: ${scoreResult.score}/100`,
        `  Role relevance: ${b.roleRelevance.score}/${b.roleRelevance.max}`,
        `  Experience:     ${b.experience.score}/${b.experience.max}`,
        `  Skills:         ${b.skills.score}/${b.skills.max}`,
        `  Location:       ${b.location.score}/${b.location.max}`,
        `  Employment:     ${b.employment.score}/${b.employment.max}`,
        `  Freshness:      ${b.freshness.score}/${b.freshness.max}`,
        `  Total:          ${scoreResult.score}/100`
    ].join('\n');
}

/**
 * Evaluates candidate fit and calculates a calibrated 0-100 match score with a transparent breakdown.
 * A score of 100 is rare and reserved for exact matches across all 6 dimensions.
 *
 * Dimension weights:
 * 1. Role relevance: 0 - 30 pts
 * 2. Experience match: 0 - 25 pts
 * 3. Skills match: 0 - 25 pts
 * 4. Location match: 0 - 10 pts
 * 5. Employment type: 0 - 5 pts
 * 6. Freshness: 0 - 5 pts
 * Total: 100 pts
 *
 * @param {import('../discovery/normalizedJob').NormalizedJob|Object} job 
 * @returns {{
 *   score: number,
 *   decision: 'APPLY'|'REVIEW'|'SKIP',
 *   breakdown: {
 *     roleRelevance: { score: number, max: 30 },
 *     experience: { score: number, max: 25 },
 *     skills: { score: number, max: 25 },
 *     location: { score: number, max: 10 },
 *     employment: { score: number, max: 5 },
 *     freshness: { score: number, max: 5 }
 *   },
 *   reasons: string[],
 *   concerns: string[]
 * }}
 */
function scoreNormalizedJob(job = {}) {
    const reasons = [];
    const concerns = [];

    const title = (job.title || job.role || '').toLowerCase().trim();
    const company = (job.company || '').toLowerCase().trim();
    const desc = (job.description || '').toLowerCase();
    const jobSkills = Array.isArray(job.skills) ? job.skills.map(s => String(s).toLowerCase()) : [];
    const fullText = `${title} ${company} ${desc} ${jobSkills.join(' ')}`;

    // ── 1. Role Relevance (0 - 30 pts) ─────────────────────────────────────────
    let roleScore = 0;
    const targetRoles = (profile.jobRoles || [
        'Software Engineer', 'Backend Developer', 'Software Developer',
        'AI Engineer', 'Applied AI Engineer', 'Python Developer'
    ]).map(r => r.toLowerCase());

    if (title) {
        const exactMatch = targetRoles.find(r => title === r || title.includes(r));
        if (exactMatch) {
            roleScore = 30;
            reasons.push(`Target role match: "${exactMatch}" (30/30)`);
        } else {
            // Check partial technical title tokens
            const primaryKeywords = ['backend', 'software', 'ai', 'machine learning', 'python', 'developer', 'engineer'];
            const matchedKeywords = primaryKeywords.filter(kw => title.includes(kw));
            if (matchedKeywords.length >= 2) {
                roleScore = 24;
                reasons.push(`Strong technical title alignment [${matchedKeywords.join(', ')}] (24/30)`);
            } else if (matchedKeywords.length === 1) {
                roleScore = 15;
                reasons.push(`Partial technical title match [${matchedKeywords[0]}] (15/30)`);
            } else {
                concerns.push(`Role title "${title}" does not align with target roles`);
            }
        }
    } else {
        concerns.push('Missing role title');
    }

    // ── 2. Experience Match (0 - 25 pts) ───────────────────────────────────────
    let expScore = 0;
    const candidateMaxExp = typeof profile.experience === 'number' ? profile.experience : 1;
    const minExp = typeof job.minExperience === 'number' ? job.minExperience : null;

    if (minExp !== null) {
        if (minExp <= 1) {
            expScore = 25;
            reasons.push(`Experience aligns with fresher / 1-yr candidate (${minExp} yrs required) (25/25)`);
        } else if (minExp === 2) {
            expScore = 18;
            reasons.push(`Acceptable experience threshold (${minExp} yrs) (18/25)`);
        } else if (minExp <= 3) {
            expScore = 8;
            concerns.push(`Job requires ${minExp} yrs (candidate has ${candidateMaxExp} yr) (8/25)`);
        } else {
            expScore = 0;
            concerns.push(`High experience requirement: ${minExp} yrs required (0/25)`);
        }
    } else {
        // Experience is unspecified in job listing
        expScore = 10;
        reasons.push('Experience requirement unspecified (default 10/25)');
    }

    // ── 3. Skills Match (0 - 25 pts) ───────────────────────────────────────────
    let skillScore = 0;
    const candidateSkills = (profile.skills || [
        'Python', 'Go', 'FastAPI', 'Django', 'PostgreSQL', 'SQL', 'Docker', 'React', 'Git'
    ]).map(s => s.toLowerCase());

    const matchedSkills = [];
    candidateSkills.forEach(skill => {
        if (fullText.includes(skill) || jobSkills.includes(skill)) {
            matchedSkills.push(skill);
        }
    });

    if (matchedSkills.length >= 6) {
        skillScore = 25;
        reasons.push(`Extensive skill overlap (${matchedSkills.length} skills) (25/25)`);
    } else if (matchedSkills.length >= 4) {
        skillScore = 20;
        reasons.push(`Strong skill overlap [${matchedSkills.slice(0, 4).join(', ')}] (20/25)`);
    } else if (matchedSkills.length >= 2) {
        skillScore = 14;
        reasons.push(`Moderate skill overlap [${matchedSkills.join(', ')}] (14/25)`);
    } else if (matchedSkills.length === 1) {
        skillScore = 7;
        reasons.push(`Single skill match [${matchedSkills[0]}] (7/25)`);
    } else {
        skillScore = 0;
        concerns.push('Zero explicit skill matches with candidate profile (0/25)');
    }

    // ── 4. Location Match (0 - 10 pts) ─────────────────────────────────────────
    let locScore = 0;
    if (job.isRemote) {
        locScore = 10;
        reasons.push('Remote / Work From Home (10/10)');
    } else {
        const preferred = (profile.preferredLocations || profile.locations || ['Hyderabad', 'Bangalore', 'Chennai']).map(l => l.toLowerCase());
        const jobLocs = Array.isArray(job.locations)
            ? job.locations.map(l => String(l).toLowerCase())
            : [(job.location || '').toLowerCase()];

        const matchedPref = preferred.find(p => p !== 'remote' && jobLocs.some(jl => jl.includes(p) || p.includes(jl)));
        if (matchedPref) {
            locScore = 8;
            reasons.push(`Preferred location match: "${matchedPref}" (8/10)`);
        } else if (jobLocs.some(jl => jl.includes('india'))) {
            locScore = 4;
            reasons.push('India general location (4/10)');
        } else if (jobLocs.length > 0 && jobLocs[0]) {
            locScore = 2;
            concerns.push(`Non-preferred location [${jobLocs.join(', ')}] (2/10)`);
        } else {
            locScore = 2;
            concerns.push('Location unspecified (2/10)');
        }
    }

    // ── 5. Employment Type (0 - 5 pts) ─────────────────────────────────────────
    let empScore = 0;
    const empType = (job.employmentType || '').toLowerCase();
    if (empType.includes('full') || empType.includes('permanent') || empType.includes('intern')) {
        empScore = 5;
        reasons.push(`Employment type aligns: "${job.employmentType}" (5/5)`);
    } else if (empType.includes('contract') || empType.includes('temp')) {
        empScore = 3;
        reasons.push(`Contractual employment: "${job.employmentType}" (3/5)`);
    } else {
        empScore = 2;
    }

    // ── 6. Freshness (0 - 5 pts) ───────────────────────────────────────────────
    let freshScore = 0;
    const age = (job.postedAge || '').toLowerCase();
    if (age.includes('just') || age.includes('hour') || age.includes('today') || age.includes('few minutes')) {
        freshScore = 5;
        reasons.push('Posted today / fresh listing (5/5)');
    } else if (age.includes('1 day') || age.includes('2 day') || age.includes('recent')) {
        freshScore = 4;
        reasons.push('Posted recently (1-2 days) (4/5)');
    } else if (age.includes('3 day') || age.includes('4 day') || age.includes('5 day') || age.includes('week')) {
        freshScore = 2;
    } else {
        freshScore = 1;
    }

    const totalScore = Math.max(0, Math.min(100, roleScore + expScore + skillScore + locScore + empScore + freshScore));

    let decision = 'SKIP';
    if (totalScore >= 50) {
        decision = 'APPLY';
    } else if (totalScore >= 40) {
        decision = 'REVIEW';
    }

    return {
        score: totalScore,
        decision,
        breakdown: {
            roleRelevance: { score: roleScore, max: 30 },
            experience: { score: expScore, max: 25 },
            skills: { score: skillScore, max: 25 },
            location: { score: locScore, max: 10 },
            employment: { score: empScore, max: 5 },
            freshness: { score: freshScore, max: 5 }
        },
        reasons,
        concerns
    };
}

/**
 * Formats structured score breakdown into a clean explainable string.
 * @param {Object} breakdown 
 * @returns {string}
 */
function formatScoreBreakdown(breakdown = {}) {
    if (!breakdown) return '';
    const r = breakdown.roleRelevance?.score ?? 0;
    const rMax = breakdown.roleRelevance?.max ?? 30;
    const e = breakdown.experience?.score ?? 0;
    const eMax = breakdown.experience?.max ?? 25;
    const s = breakdown.skills?.score ?? 0;
    const sMax = breakdown.skills?.max ?? 25;
    const l = breakdown.location?.score ?? 0;
    const lMax = breakdown.location?.max ?? 10;
    const em = breakdown.employment?.score ?? 0;
    const emMax = breakdown.employment?.max ?? 5;
    const f = breakdown.freshness?.score ?? 0;
    const fMax = breakdown.freshness?.max ?? 5;

    return `Role: ${r}/${rMax} | Exp: ${e}/${eMax} | Skills: ${s}/${sMax} | Loc: ${l}/${lMax} | Emp: ${em}/${emMax} | Fresh: ${f}/${fMax}`;
}

module.exports = {
    scoreNormalizedJob,
    scoreJob: scoreNormalizedJob,
    formatScoreBreakdown
};
