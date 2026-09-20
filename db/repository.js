'use strict';

const prisma = require('./prisma');
const { generateJobFingerprint } = require('../discovery/normalizedJob');
const chalk = require('chalk');

/**
 * Persists discovered normalized jobs to the database.
 * Uses upsert on fingerprint to prevent duplicate records across multiple runs.
 * 
 * @param {import('../discovery/normalizedJob').NormalizedJob[]} jobs
 * @returns {Promise<{ inserted: number, updated: number }>}
 */
async function saveDiscoveredJobs(jobs = []) {
    let inserted = 0;
    let updated = 0;

    for (const job of jobs) {
        try {
            const fingerprint = job.fingerprint || job.id || generateJobFingerprint(job.company, job.title, job.locations?.[0] || 'India');
            const sourceKey = (job.source || 'NAUKRI').toUpperCase();
            const validSource = ['NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP'].includes(sourceKey) ? sourceKey : 'NAUKRI';

            const existing = await prisma.job.findUnique({
                where: { fingerprint }
            });

            if (existing) {
                await prisma.job.update({
                    where: { fingerprint },
                    data: {
                        applicationUrl: job.applicationUrl || existing.applicationUrl,
                        skills: Array.isArray(job.skills) && job.skills.length > 0 ? job.skills : existing.skills,
                        postedAge: job.postedAge || existing.postedAge,
                        updatedAt: new Date()
                    }
                });
                updated++;
            } else {
                await prisma.job.create({
                    data: {
                        fingerprint,
                        source: validSource,
                        sourceJobId: job.sourceJobId || null,
                        sourceUrl: job.sourceUrl || '',
                        applicationUrl: job.applicationUrl || job.sourceUrl || '',
                        applicationType: job.applicationType || 'UNKNOWN',
                        title: job.title || job.role || 'Unknown Title',
                        company: job.company || 'Unknown Company',
                        locations: Array.isArray(job.locations) ? job.locations : [job.location || 'India'],
                        isRemote: !!job.isRemote,
                        minExperience: typeof job.minExperience === 'number' ? job.minExperience : 0,
                        maxExperience: typeof job.maxExperience === 'number' ? job.maxExperience : 30,
                        skills: Array.isArray(job.skills) ? job.skills : [],
                        description: job.description || null,
                        postedAge: job.postedAge || null,
                        discoveredAt: job.discoveredAt || new Date()
                    }
                });
                inserted++;
            }
        } catch (err) {
            console.error(chalk.yellow(`  ⚠️ [Repository] Failed to save job "${job.title}": ${err.message}`));
        }
    }

    return { inserted, updated };
}

/**
 * Checks if a job has already been successfully applied to or is currently pending.
 * Checks both the new multi-entity schema and the legacy AppliedJob table.
 * 
 * @param {import('../discovery/normalizedJob').NormalizedJob|{ jobUrl: string, company?: string, role?: string }} job
 * @returns {Promise<boolean>}
 */
async function isJobAlreadyApplied(job) {
    if (!job) return false;

    const targetUrl = job.applicationUrl || job.jobUrl || job.sourceUrl;
    const fingerprint = job.fingerprint || (job.company && (job.title || job.role) ? generateJobFingerprint(job.company, job.title || job.role, job.locations?.[0] || 'India') : null);

    try {
        // 1. Check legacy AppliedJob table
        if (targetUrl) {
            const legacyMatch = await prisma.appliedJob.findUnique({
                where: { jobUrl: targetUrl }
            });
            if (legacyMatch && ['SUCCESS', 'PENDING'].includes(legacyMatch.status)) {
                return true;
            }
        }

        // 2. Check multi-source Job + Application table
        if (fingerprint) {
            const jobRecord = await prisma.job.findUnique({
                where: { fingerprint },
                include: {
                    applications: {
                        orderBy: { createdAt: 'desc' },
                        take: 1
                    }
                }
            });

            if (jobRecord && jobRecord.applications.length > 0) {
                const latestApp = jobRecord.applications[0];
                if (['SUCCESS', 'PENDING'].includes(latestApp.status)) {
                    return true;
                }
            }
        }

        return false;
    } catch (err) {
        console.error(chalk.yellow(`  ⚠️ [Repository] isJobAlreadyApplied error: ${err.message}`));
        return false;
    }
}

/**
 * Records the outcome of an application attempt in both new multi-source schema
 * and legacy AppliedJob table for backward compatibility.
 * 
 * @param {import('../discovery/normalizedJob').NormalizedJob} job
 * @param {{ status: 'SUCCESS'|'FAILED'|'SKIPPED', message?: string, resumeUsed?: string, matchScore?: number, qa?: any[], externalUrl?: string }} result
 */
async function recordApplicationResult(job, result) {
    if (!result || result.status === 'DRY_RUN_READY_TO_SUBMIT' || result.dryRun) {
        // Defense-in-depth: Never record dry-run simulations as real applications in the DB
        return;
    }

    const fingerprint = job.fingerprint || generateJobFingerprint(job.company, job.title || job.role, job.locations?.[0] || 'India');
    const jobUrl = job.applicationUrl || job.jobUrl || job.sourceUrl || '';

    try {
        // 1. Find or create Job record
        let jobRecord = await prisma.job.findUnique({
            where: { fingerprint }
        });

        if (!jobRecord) {
            const saved = await saveDiscoveredJobs([job]);
            jobRecord = await prisma.job.findUnique({
                where: { fingerprint }
            });
        }

        // Safety invariant: NEVER record SUCCESS if submission was unverified
        let effectiveStatus = result.status;
        if (effectiveStatus === 'SUCCESS' && result.verified !== true) {
            console.warn(chalk.red.bold('  ⚠️ [Repository Safety Guard] Blocked unverified SUCCESS. Reclassifying as SUBMISSION_NOT_VERIFIED.'));
            effectiveStatus = 'SUBMISSION_NOT_VERIFIED';
        }

        if (jobRecord) {
            // Map status
            const appStatus = effectiveStatus === 'SUCCESS' ? 'SUCCESS' : (effectiveStatus === 'SKIPPED' ? 'SKIPPED' : 'FAILED');

            // 2. Create Application record
            const application = await prisma.application.create({
                data: {
                    jobId: jobRecord.id,
                    status: appStatus,
                    appliedAt: effectiveStatus === 'SUCCESS' ? new Date() : null,
                    resumeUsed: result.resumeUsed || null,
                    matchScore: result.matchScore || null,
                    failureReason: effectiveStatus !== 'SUCCESS' ? (result.message || null) : null,
                    qaSnapshot: result.qa ? result.qa : null
                }
            });

            // 3. Create ApplicationAttempt record
            await prisma.applicationAttempt.create({
                data: {
                    applicationId: application.id,
                    attemptNumber: 1,
                    status: effectiveStatus,
                    message: result.message || 'Attempt completed',
                    errorDetails: effectiveStatus !== 'SUCCESS' ? result.message : null,
                    attemptedAt: new Date()
                }
            });
        }

        // 4. Update legacy AppliedJob table for full backward compatibility
        if (jobUrl) {
            await prisma.appliedJob.upsert({
                where: { jobUrl },
                update: {
                    status: effectiveStatus,
                    appliedAt: effectiveStatus === 'SUCCESS' ? new Date() : null,
                    errorMessage: effectiveStatus !== 'SUCCESS' ? result.message : null,
                    matchScore: result.matchScore || null,
                    externalUrl: result.externalUrl || null,
                    recruiterQuestions: result.qa ? result.qa.map(q => q.question) : [],
                    aiAnswers: result.qa ? result.qa.map(q => q.answer) : []
                },
                create: {
                    company: job.company || 'Unknown',
                    role: job.title || job.role || 'Unknown',
                    location: Array.isArray(job.locations) ? job.locations.join(', ') : (job.location || 'India'),
                    jobUrl,
                    status: effectiveStatus,
                    errorMessage: effectiveStatus !== 'SUCCESS' ? result.message : null,
                    matchScore: result.matchScore || null,
                    externalUrl: result.externalUrl || null,
                    recruiterQuestions: result.qa ? result.qa.map(q => q.question) : [],
                    aiAnswers: result.qa ? result.qa.map(q => q.answer) : []
                }
            });
        }

        console.log(chalk.green(`  [Repository] Application outcome recorded: ${effectiveStatus} for "${job.title || job.role}"`));
    } catch (err) {
        console.error(chalk.red(`  ❌ [Repository] Failed to record application result: ${err.message}`));
    }
}

module.exports = {
    saveDiscoveredJobs,
    isJobAlreadyApplied,
    recordApplicationResult
};
