'use strict';

const profile = require('../config/profile.json');
const { scoreNormalizedJob, formatScoreBreakdown } = require('../scoring/jobScorer');

/**
 * Keyword-based job scorer with backward compatibility.
 * Delegates to the calibrated multi-factor scoring engine.
 * 
 * @param {Object} job 
 * @returns {number} 0-100 score
 */
function scoreJob(job) {
    if (job.title && (job.source || Array.isArray(job.locations))) {
        return scoreNormalizedJob(job).score;
    }

    // Default scoring for legacy job format
    return scoreNormalizedJob({
        title: job.role || job.title,
        company: job.company,
        location: job.location,
        description: job.description,
        experience: job.experience
    }).score;
}

module.exports = {
    scoreJob,
    scoreNormalizedJob,
    formatScoreBreakdown
};
