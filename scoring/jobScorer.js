'use strict';

const profile = require('../config/profile');

/**
 * Evaluates candidate fit and calculates a 0-100 match score with a decision.
 * @param {import('../discovery/normalizedJob').NormalizedJob|Object} job 
 * @returns {{ score: number, decision: 'APPLY'|'REVIEW'|'SKIP', reasons: string[], concerns: string[] }}
 */
function scoreNormalizedJob(job) {
    const reasons = [];
    const concerns = [];
    let score = 50; // Baseline score

    const title = (job.title || job.role || '').toLowerCase();
    const company = (job.company || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const jobSkills = (job.skills || []).map(s => s.toLowerCase());
    const fullText = `${title} ${company} ${desc} ${jobSkills.join(' ')}`;

    // 1. Role / Title Match
    const targetRoles = (profile.jobRoles || []).map(r => r.toLowerCase());
    const matchedRole = targetRoles.find(r => title.includes(r) || r.includes(title));
    if (matchedRole) {
        score += 25;
        reasons.push(`Target role match: "${matchedRole}"`);
    }

    // 2. Skills Match
    const candidateSkills = (profile.skills || []).map(s => s.toLowerCase());
    let skillMatches = 0;
    candidateSkills.forEach(skill => {
        if (fullText.includes(skill) || jobSkills.includes(skill)) {
            skillMatches++;
        }
    });

    if (skillMatches > 0) {
        const skillBonus = Math.min(25, skillMatches * 4);
        score += skillBonus;
        reasons.push(`${skillMatches} matching skills found (+${skillBonus} pts)`);
    } else {
        concerns.push('Low explicit skill overlap');
    }

    // 3. Experience Match
    const minExp = typeof job.minExperience === 'number' ? job.minExperience : 0;
    if (minExp <= 1) {
        score += 10;
        reasons.push('Experience requirement aligns with fresher/1-yr candidate');
    } else if (minExp > 2) {
        score -= 20;
        concerns.push(`Job requires ${minExp} yrs experience`);
    }

    // 4. Remote or Preferred Location
    if (job.isRemote) {
        score += 10;
        reasons.push('Remote / Work from home opportunity');
    } else {
        const candidateLocs = (profile.locations || []).map(l => l.toLowerCase());
        const locMatch = (job.locations || []).some(jl => 
            candidateLocs.some(cl => cl !== 'remote' && (jl.toLowerCase().includes(cl) || cl.includes(jl.toLowerCase())))
        );
        if (locMatch) {
            score += 5;
            reasons.push('Located in preferred city');
        } else {
            concerns.push('Outside primary preferred cities');
        }
    }

    // Clamp score to 0-100
    const finalScore = Math.max(0, Math.min(100, score));

    // Determine decision
    let decision = 'SKIP';
    if (finalScore >= 50) {
        decision = 'APPLY';
    } else if (finalScore >= 40) {
        decision = 'REVIEW';
    }

    return {
        score: finalScore,
        decision,
        reasons,
        concerns
    };
}

module.exports = {
    scoreNormalizedJob,
    scoreJob: scoreNormalizedJob
};
