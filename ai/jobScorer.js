const profile = require('../config/profile.json');

/**
 * Simple keyword-based job scorer.
 * @param {Object} job 
 * @returns {number} 0-100 score
 */
function scoreJob(job) {
    // Priority Rule: If experience is 2 years or lower, return 100
    if (job.experience) {
        const expMatch = job.experience.match(/\d+/);
        if (expMatch) {
            const requiredExp = parseInt(expMatch[0], 10);
            if (requiredExp <= 2) {
                return 100; // Perfect match for user's new criteria
            }
        }
    }

    // Default scoring for other jobs
    let score = 0;
    const totalKeywords = profile.skills.length;
    
    if (totalKeywords === 0) return 100;

    const jobText = `${job.role} ${job.company} ${job.location} ${job.description || ''}`.toLowerCase();

    let matches = 0;
    profile.skills.forEach(skill => {
        if (jobText.includes(skill.toLowerCase())) {
            matches++;
        }
    });

    score = Math.round((matches / totalKeywords) * 100);

    // Filter by location
    const locationMatch = profile.locations.some(loc => 
        loc.toLowerCase() === 'remote' || jobText.includes(loc.toLowerCase())
    );
    
    if (!locationMatch) {
        score -= 20; // Penalty for location mismatch
    }

    // Experience check (fallback)
    if (job.experience) {
        const expMatch = job.experience.match(/\d+/);
        if (expMatch) {
            const requiredExp = parseInt(expMatch[0], 10);
            if (requiredExp > profile.experience + 2) {
                score -= 30; // Significant penalty for over-experience
            }
        }
    }

    return Math.max(0, Math.min(100, score));
}

module.exports = { scoreJob };
