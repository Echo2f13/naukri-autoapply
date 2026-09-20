'use strict';

const chalk = require('chalk');
const router = require('./router');
const dbRepo = require('../db/repository');
const { randomDelay } = require('../automation/utils');
const settings = require('../config/settings');

/**
 * Universal Application Coordinator.
 * Sequentially executes applications across any ATS or source platform,
 * enforcing rate limits, score thresholds, and persistence logging.
 */
class ApplicationCoordinator {
    /**
     * @param {Object} options
     * @param {import('playwright').Page} options.page
     * @param {import('playwright').BrowserContext} [options.context]
     */
    constructor({ page, context } = {}) {
        this.page = page;
        this.context = context;
    }

    /**
     * Set active page
     * @param {import('playwright').Page} page 
     * @param {import('playwright').BrowserContext} [context] 
     */
    setPage(page, context) {
        this.page = page;
        this.context = context;
    }

    /**
     * Executes applications for a batch of ranked jobs.
     * 
     * @param {Array<{ job: import('../discovery/normalizedJob').NormalizedJob, score: number, decision: string }>} rankedJobs
     * @param {Object} [options]
     * @param {number} [options.maxApply]
     * @param {number} [options.minScore=50]
     * @param {boolean} [options.dryRun=false]
     * @returns {Promise<{ applied: number, succeeded: number, failed: number, skipped: number, results: any[] }>}
     */
    async processApplications(rankedJobs = [], options = {}) {
        const maxApply = options.maxApply !== undefined && !isNaN(options.maxApply)
            ? options.maxApply
            : (settings.maxApplicationsPerRun || 10);
        const minScore = options.minScore !== undefined ? options.minScore : 50;
        const dryRun = !!options.dryRun;

        console.log(chalk.bold.magenta(`\n============================================================`));
        console.log(chalk.bold.magenta(`  APPLICATION COORDINATOR: Starting Batch Run`));
        console.log(chalk.magenta(`  Max Limit: ${maxApply} | Min Score: ${minScore} | Dry Run: ${dryRun}`));
        console.log(chalk.bold.magenta(`============================================================\n`));

        let appliedCount = 0;
        const stats = {
            totalAttempted: 0,
            succeeded: 0,
            dryRunReady: 0,
            aborted: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
            results: []
        };

        for (const item of rankedJobs) {
            if (appliedCount >= maxApply) {
                console.log(chalk.yellow(`\n[Application Coordinator] Reached max applications limit (${maxApply}). Stopping batch.`));
                break;
            }

            const { job, score, decision } = item;

            // Check match score
            if (score < minScore || decision === 'SKIP') {
                console.log(chalk.gray(`[Skip Score] "${job.title}" at "${job.company}" (Score: ${score} < ${minScore})`));
                stats.skipped++;
                continue;
            }

            // Fresh database check
            const alreadyApplied = await dbRepo.isJobAlreadyApplied(job);
            if (alreadyApplied) {
                console.log(chalk.gray(`[Already Applied] "${job.title}" at "${job.company}". Skipping.`));
                stats.skipped++;
                continue;
            }

            const maxLabel = maxApply === Infinity ? '∞' : maxApply;
            console.log(chalk.bold.cyan(`\n>>> [${appliedCount + 1}/${maxLabel}] Applying: "${job.title}" at "${job.company}" (Score: ${score}/100, Source: ${job.source})`));

            stats.totalAttempted++;
            try {
                if (dryRun) {
                    console.log(chalk.yellow(`  [Dry Run Defense-In-Depth] Exercising form application up to submission boundary: ${job.applicationUrl || job.sourceUrl}`));
                }

                const result = await router.routeAndApply(this.page, job, {
                    context: this.context,
                    dryRun,
                    promptFn: options.promptFn,
                    isInteractive: options.isInteractive
                });
                result.matchScore = score;

                // Record result to database only if NOT in dryRun mode and successfully submitted
                if (!dryRun && result.status === 'SUCCESS') {
                    await dbRepo.recordApplicationResult(job, result);
                }

                if (result.status === 'SUCCESS') {
                    stats.succeeded++;
                    appliedCount++;
                } else if (result.status === 'DRY_RUN_READY_TO_SUBMIT') {
                    console.log(chalk.green(`  🛡️ [Dry Run Safe Barrier] Reached submission boundary for "${job.title}". Final submit was prevented.`));
                    stats.dryRunReady++;
                    appliedCount++;
                } else if (result.status === 'CONFIRMATION_ABORTED') {
                    console.log(chalk.yellow(`  🛑 [Human Gate] Submission aborted for "${job.title}". No action taken.`));
                    stats.aborted++;
                } else if (result.status === 'BLOCKED') {
                    console.log(chalk.red(`  🚫 [Safety Boundary] Application blocked: ${result.reason || result.detail || 'Missing required data'}`));
                    stats.blocked++;
                } else if (result.status === 'SKIPPED') {
                    stats.skipped++;
                } else {
                    stats.failed++;
                }

                stats.results.push({ job, result });

            } catch (err) {
                console.error(chalk.red(`  ❌ Error applying to "${job.title}": ${err.message}`));
                if (!dryRun) {
                    await dbRepo.recordApplicationResult(job, { status: 'FAILED', message: err.message, matchScore: score });
                }
                stats.failed++;
                stats.results.push({ job, result: { status: 'FAILED', message: err.message } });
            }

            // Human delay between applications
            const minWait = (settings.delays && settings.delays.min) || 500;
            const maxWait = (settings.delays && settings.delays.max) || 1500;
            const delay = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
            console.log(chalk.gray(`  Pausing ${(delay / 1000).toFixed(1)}s before next application...`));
            await randomDelay(minWait, maxWait);
        }

        console.log(chalk.bold.cyan(`
════════════════════════════════════════════════════════════
                 PIPELINE EXECUTION SUMMARY                 
════════════════════════════════════════════════════════════
  Total Ranked in Batch : ${rankedJobs.length}
  Attempted Execution   : ${stats.totalAttempted}
  Real Succeeded (Live) : ${chalk.bold(stats.succeeded)}
  Dry-Run Ready         : ${chalk.bold(stats.dryRunReady)}
  Blocked (Data/Resume) : ${stats.blocked}
  Human Aborted         : ${stats.aborted}
  Failed (Errors)       : ${stats.failed}
  Skipped (Score/Apply) : ${stats.skipped}
════════════════════════════════════════════════════════════
`));
        console.log(chalk.bold.green(`  BATCH COMPLETE: ${stats.succeeded} Succeeded | ${stats.dryRunReady} Dry-Run Ready | ${stats.aborted} Aborted | ${stats.failed} Failed | ${stats.skipped} Skipped\n`));

        return stats;
    }
}

module.exports = { ApplicationCoordinator };
