'use strict';

const chalk = require('chalk');
const { NaukriPipeline } = require('../sources/naukri');
const { LinkedInPipeline } = require('../sources/linkedin');
const { WellfoundPipeline } = require('../sources/wellfound');
const { WhatsAppPipeline } = require('../sources/whatsapp');
const { crossSourceDeduplicate } = require('./deduplicator');
const { evaluateEligibility } = require('../eligibility/eligibilityEngine');
const { scoreJob } = require('../scoring/jobScorer');
const { saveDiscoveredJobs, isJobAlreadyApplied } = require('../db/repository');

/**
 * Universal Discovery Coordinator.
 * Runs enabled source pipelines, aggregates, deduplicates, persists,
 * and filters by hard eligibility rules and AI scoring.
 */
class DiscoveryCoordinator {
    /**
     * @param {Object} options
     * @param {import('playwright').Page} [options.page]
     * @param {import('playwright').BrowserContext} [options.context]
     * @param {Object.<string, import('playwright').Page>} [options.pages] - Dedicated isolated pages per source
     */
    constructor({ page, context, pages = {} } = {}) {
        this.page = page;
        this.context = context;

        this.naukri = new NaukriPipeline({ page: pages.naukri || page, context });
        this.linkedin = new LinkedInPipeline({ page: pages.linkedin || page, context });
        this.wellfound = new WellfoundPipeline({ page: pages.wellfound || page, context });
        this.whatsapp = new WhatsAppPipeline({ page: pages.whatsapp || page, context });
    }

    /**
     * Updates active browser tab and context for all pipelines
     * @param {import('playwright').Page} page 
     * @param {import('playwright').BrowserContext} [context] 
     */
    setPage(page, context) {
        this.page = page;
        this.context = context;
        this.naukri.setPage(page, context);
        this.linkedin.setPage(page, context);
        this.wellfound.setPage(page, context);
        this.whatsapp.setPage(page, context);
    }

    /**
     * Discovers jobs across all enabled sources.
     * 
     * @param {Object} [options]
     * @param {string[]} [options.sources=['NAUKRI']] - Array of sources to query ('NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP')
     * @param {Object} [options.naukriOptions]
     * @param {Object} [options.linkedinOptions]
     * @param {Object} [options.wellfoundOptions]
     * @param {Object} [options.whatsappOptions]
     * @returns {Promise<import('./normalizedJob').NormalizedJob[]>}
     */
    async discoverAll(options = {}) {
        const sources = (options.sources || ['NAUKRI']).map(s => s.toUpperCase());
        console.log(chalk.bold.cyan(`\n============================================================`));
        console.log(chalk.bold.cyan(`  DISCOVERY COORDINATOR: Querying Sources [${sources.join(', ')}]`));
        console.log(chalk.bold.cyan(`============================================================\n`));

        const allDiscovered = [];

        // 1. Naukri
        if (sources.includes('NAUKRI')) {
            try {
                const naukriJobs = await this.naukri.discover(options.naukriOptions);
                allDiscovered.push(...naukriJobs);
            } catch (err) {
                console.error(chalk.red(`[Discovery] Naukri source error: ${err.message}`));
            }
        }

        // 2. LinkedIn
        if (sources.includes('LINKEDIN')) {
            try {
                const linkedinJobs = await this.linkedin.discover(options.linkedinOptions);
                allDiscovered.push(...linkedinJobs);
            } catch (err) {
                console.error(chalk.red(`[Discovery] LinkedIn source error: ${err.message}`));
            }
        }

        // 3. Wellfound
        if (sources.includes('WELLFOUND')) {
            try {
                const wellfoundJobs = await this.wellfound.discover(options.wellfoundOptions);
                allDiscovered.push(...wellfoundJobs);
            } catch (err) {
                console.error(chalk.red(`[Discovery] Wellfound source error: ${err.message}`));
            }
        }

        // 4. WhatsApp
        if (sources.includes('WHATSAPP')) {
            try {
                const whatsappJobs = await this.whatsapp.discover(options.whatsappOptions);
                allDiscovered.push(...whatsappJobs);
            } catch (err) {
                console.error(chalk.red(`[Discovery] WhatsApp source error: ${err.message}`));
            }
        }

        console.log(chalk.blue(`\n[Discovery] Total raw jobs collected across sources: ${allDiscovered.length}`));

        // 5. Cross-Source Deduplication
        const uniqueJobs = crossSourceDeduplicate(allDiscovered);
        console.log(chalk.cyan(`[Discovery] Unique jobs after cross-source deduplication: ${uniqueJobs.length}`));

        // 6. Persist all discovered jobs to Database
        try {
            const { inserted, updated } = await saveDiscoveredJobs(uniqueJobs);
            console.log(chalk.gray(`[Discovery] Database sync: ${inserted} new jobs saved, ${updated} updated.`));
        } catch (dbErr) {
            console.warn(chalk.yellow(`[Discovery] DB save failed: ${dbErr.message}`));
        }

        // 7. Hard Eligibility Filter
        const eligibleJobs = [];
        for (const job of uniqueJobs) {
            // Check if already applied
            const alreadyApplied = await isJobAlreadyApplied(job);
            if (alreadyApplied) {
                console.log(chalk.gray(`  [Skip] Already applied: "${job.title}" at "${job.company}"`));
                continue;
            }

            const evalResult = evaluateEligibility(job);
            if (!evalResult.isEligible) {
                console.log(chalk.gray(`  [Ineligible] "${job.title}" at "${job.company}" — ${evalResult.reasons.join('; ')}`));
                continue;
            }

            eligibleJobs.push(job);
        }

        console.log(chalk.green(`[Discovery] Eligible unapplied jobs: ${eligibleJobs.length}`));

        // 8. Soft Scoring & Ranking
        const scoredJobs = [];
        for (const job of eligibleJobs) {
            const scoreResult = await scoreJob(job);
            scoredJobs.push({
                job,
                score: scoreResult.score,
                decision: scoreResult.decision,
                reasons: scoreResult.reasons
            });
        }

        // Sort descending by match score
        scoredJobs.sort((a, b) => b.score - a.score);

        console.log(chalk.bold.green(`\n=== Discovery Complete: ${scoredJobs.length} Ranked Jobs Ready for Application ===\n`));
        return scoredJobs;
    }
}

module.exports = { DiscoveryCoordinator };
