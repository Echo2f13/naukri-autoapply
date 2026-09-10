const profile = require('../config/profile.json');
const { scoreNormalizedJob } = require('../scoring/jobScorer');

/**
 * Keyword-based job scorer with backward compatibility.
 * @param {Object} job 
 * @returns {number} 0-100 score
 */
function scoreJob(job) {
    if (job.title && (job.source || Array.isArray(job.locations))) {
        return scoreNormalizedJob(job).score;
    }

    // Priority Rule: If experience is 2 years or lower, return 100
    if (job.experience) {
        const expMatch = job.experience.match(/\d+/);
        if (expMatch) {
            const requiredExp = parseInt(expMatch[0], 10);
            if (requiredExp <= 2) {
                return 100; // Perfect match for user's criteria
            }
        }
    }

    // Default scoring for legacy job format
    return scoreNormalizedJob({
        title: job.role,
        company: job.company,
        location: job.location,
        description: job.description,
        experience: job.experience
    }).score;
}

module.exports = { scoreJob, scoreNormalizedJob };

