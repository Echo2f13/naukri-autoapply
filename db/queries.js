const prisma = require('./prisma');

/**
 * Checks if a job has already been applied to.
 * @param {string} jobUrl 
 * @returns {Promise<boolean>}
 */
async function isAlreadyApplied(jobUrl) {
    const job = await prisma.appliedJob.findUnique({
        where: { jobUrl }
    });
    return !!job;
}

/**
 * Saves a job application result to the database.
 * @param {Object} jobData 
 */
async function saveApplication(jobData) {
    try {
        await prisma.appliedJob.upsert({
            where: { jobUrl: jobData.jobUrl },
            update: {
                status: jobData.status,
                appliedAt: new Date(),
                errorMessage: jobData.errorMessage || null,
                recruiterQuestions: jobData.questions || [],
                aiAnswers: jobData.answers || [],
                matchScore: jobData.matchScore || 0,
                externalUrl: jobData.externalUrl || null
            },
            create: {
                company: jobData.company,
                role: jobData.role,
                location: jobData.location,
                jobUrl: jobData.jobUrl,
                status: jobData.status,
                errorMessage: jobData.errorMessage || null,
                recruiterQuestions: jobData.questions || [],
                aiAnswers: jobData.answers || [],
                matchScore: jobData.matchScore || 0,
                externalUrl: jobData.externalUrl || null
            }
        });
    } catch (error) {
        console.error(`Error saving application to DB: ${error.message}`);
    }
}

/**
 * Logs a system event.
 * @param {string} event 
 * @param {Object} metadata 
 */
async function logEvent(event, metadata = {}) {
    try {
        await prisma.jobLog.create({
            data: {
                event,
                metadata
            }
        });
    } catch (error) {
        console.error(`Error logging event to DB: ${error.message}`);
    }
}

module.exports = { isAlreadyApplied, saveApplication, logEvent };
