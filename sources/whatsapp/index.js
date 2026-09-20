'use strict';

const chalk = require('chalk');
const settings = require('../../config/settings');
const { scrapeChannelMessages, monitorChannelLive, navigateToChannel, isWithinLookback } = require('./channelMonitor');
const { checkWhatsAppSession, ensureWhatsAppLogin } = require('./auth');
const { extractJobFromWhatsApp, extractJobWithDisposition } = require('./jobExtractor');
const { crossSourceDeduplicate } = require('../../discovery/deduplicator');

/**
 * Independent WhatsApp Channels Discovery Pipeline.
 * Extracts job opportunities from WhatsApp channels and community chats,
 * resolves destination URLs, evaluates year and role eligibility, and transforms
 * them into NormalizedJob items with observable stage dispositions.
 */
class WhatsAppPipeline {
    /**
     * @param {Object} [options]
     * @param {import('playwright').Page} [options.page]
     * @param {import('playwright').BrowserContext} [options.context]
     */
    constructor({ page, context } = {}) {
        this.page = page;
        this.context = context;
        this.defaultChannelUrl = settings.whatsappChannelUrl || 'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25';
    }

    /**
     * Set active page and context
     * @param {import('playwright').Page} page 
     * @param {import('playwright').BrowserContext} [context] 
     */
    setPage(page, context) {
        this.page = page;
        this.context = context;
    }

    /**
     * Check active WhatsApp Web session
     */
    async checkSession() {
        if (!this.page) return { authenticated: false, status: 'ERROR', message: 'No page available' };
        return await checkWhatsAppSession(this.page);
    }

    /**
     * Ensure active WhatsApp Web session
     */
    async ensureLogin(options = {}) {
        if (!this.page) return { authenticated: false, status: 'ERROR', message: 'No page available' };
        return await ensureWhatsAppLogin(this.page, options);
    }

    /**
     * Ingest and process a list of raw text messages directly.
     * Evaluates Passout-Year, Role relevance, and Web Application URLs,
     * assigning clear observable dispositions to each message.
     * 
     * @param {Array<string|{ text: string, channelName?: string, channelUrl?: string, timestamp?: Date|string }>} messages 
     * @param {Object} [options]
     * @param {number} [options.whatsappDays=2]
     * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
     */
    async processRawMessages(messages = [], options = {}) {
        const lookbackDays = options.whatsappDays !== undefined ? Number(options.whatsappDays) : 2;
        const verbose = options.verbose !== undefined ? !!options.verbose : true;
        const now = new Date();
        const cutoffDate = new Date(now.getTime() - (lookbackDays * 24 * 60 * 60 * 1000));
        
        console.log(chalk.bold.green(`\n=== Processing ${messages.length} WhatsApp Messages (Lookback: ${lookbackDays}d) ===`));
        const normalizedJobs = [];
        let rejectedYearCount = 0;
        let rejectedRoleCount = 0;
        let rejectedReferralEmailCount = 0;
        let rejectedInvalidUrlCount = 0;
        let rejectedNonJobCount = 0;
        let rejectedLookbackCount = 0;
        let needsReviewCount = 0;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const text = (typeof msg === 'string' ? msg : msg?.text || '').trim();
            const preview = text.replace(/\s+/g, ' ').slice(0, 80);

            try {
                // 1. Lookback Verification
                if (typeof msg === 'object' && msg.timestamp) {
                    const msgDate = msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp);
                    if (!isWithinLookback(msgDate, lookbackDays)) {
                        rejectedLookbackCount++;
                        console.log(chalk.gray(`  [WhatsApp Msg #${i+1}] Stage: Date Lookback | Disposition: REJECTED_LOOKBACK | Timestamp: ${msgDate.toISOString()} older than cutoff: ${cutoffDate.toISOString()}`));
                        continue;
                    }
                }

                // 2. Extract with observable stage disposition
                const result = await extractJobWithDisposition(msg, options);
                const { job, disposition, stage, reason, detail, yearEvidence, roleEvidence } = result;

                switch (disposition) {
                    case 'ACCEPTED':
                        normalizedJobs.push(job);
                        console.log(chalk.green(`  ✔ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('ACCEPTED')} | "${job.title}" @ "${job.company || 'Direct'}" (${job.applicationType})`));
                        console.log(chalk.gray(`     Evidence -> Year: "${yearEvidence || 'None (No-Year Rule)'}", Role: "${roleEvidence || job.title}", URL: ${job.applicationUrl}`));
                        break;
                    case 'REJECTED_YEAR':
                        rejectedYearCount++;
                        console.log(chalk.yellow(`  ❌ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('REJECTED_YEAR')} | Evidence: "${yearEvidence}" | Detail: ${detail}`));
                        break;
                    case 'REJECTED_ROLE':
                        rejectedRoleCount++;
                        console.log(chalk.yellow(`  ❌ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('REJECTED_ROLE')} | Role: "${roleEvidence || 'Unknown'}" | Detail: ${detail}`));
                        break;
                    case 'REJECTED_REFERRAL_EMAIL':
                        rejectedReferralEmailCount++;
                        console.log(chalk.yellow(`  ❌ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('REJECTED_REFERRAL_EMAIL')} | Detail: ${detail}`));
                        break;
                    case 'REJECTED_INVALID_URL':
                        rejectedInvalidUrlCount++;
                        console.log(chalk.yellow(`  ❌ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('REJECTED_INVALID_URL')} | Detail: ${detail}`));
                        break;
                    case 'REJECTED_NON_JOB':
                        rejectedNonJobCount++;
                        if (verbose) {
                            console.log(chalk.gray(`  ❌ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('REJECTED_NON_JOB')} | Preview: "${preview}..."`));
                        }
                        break;
                    case 'NEEDS_REVIEW':
                        needsReviewCount++;
                        console.log(chalk.magenta(`  ⚠️ [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${chalk.bold('NEEDS_REVIEW')} | Detail: ${detail}`));
                        break;
                    default:
                        console.log(chalk.gray(`  [WhatsApp Msg #${i+1}] Stage: ${stage} | Disposition: ${disposition} | Reason: ${reason}`));
                        break;
                }
            } catch (err) {
                console.warn(chalk.red(`  ⚠️ [WhatsAppPipeline] Error evaluating message #${i+1}: ${err.message}`));
            }
        }

        // 3. Deduplication
        const uniqueJobs = crossSourceDeduplicate(normalizedJobs);
        const duplicateCount = normalizedJobs.length - uniqueJobs.length;

        // 4. Structured Breakdown Summary
        const stats = messages.stats || {};
        console.log(chalk.bold.cyan(`\n════════════════════════════════════════════════════════════`));
        console.log(chalk.bold.cyan(`               WHATSAPP DISCOVERY BREAKDOWN                `));
        console.log(chalk.bold.cyan(`════════════════════════════════════════════════════════════`));
        if (stats.totalDOMBubbles !== undefined || stats.totalInspected !== undefined) {
            const total = stats.totalDOMBubbles ?? stats.totalInspected;
            console.log(chalk.gray(`  Total DOM Leaf Bubbles     : ${total}`));
            console.log(chalk.gray(`  Inside Lookback Window     : ${stats.insideLookback}`));
            console.log(chalk.gray(`  Outside Lookback Window    : ${stats.outsideLookback ?? stats.olderThanLookback ?? 0}`));
            if (stats.duplicateBubbles !== undefined) {
                console.log(chalk.gray(`  Duplicate DOM Bubbles      : ${stats.duplicateBubbles}`));
            }
            if (stats.nonMessage !== undefined) {
                console.log(chalk.gray(`  Non-Message / System UI    : ${stats.nonMessage}`));
            }
        }
        console.log(chalk.gray(`  Candidate Messages Read    : ${messages.length}`));
        console.log(chalk.gray(`  Disqualified (Non-Job)     : ${rejectedNonJobCount + (stats.nonJobPosts || stats.nonJob || 0)}`));
        console.log(chalk.gray(`  Disqualified (Year Rule)   : ${rejectedYearCount}`));
        console.log(chalk.gray(`  Disqualified (Role Rule)   : ${rejectedRoleCount}`));
        console.log(chalk.gray(`  Disqualified (Referral/Mail: ${rejectedReferralEmailCount}`));
        console.log(chalk.gray(`  Disqualified (Invalid URL) : ${rejectedInvalidUrlCount}`));
        console.log(chalk.gray(`  Accepted Candidates        : ${normalizedJobs.length}`));
        if (duplicateCount > 0) {
            console.log(chalk.yellow(`  Duplicates Removed in Queue: ${duplicateCount}`));
        }
        console.log(chalk.green.bold(`  Final Unique Jobs to Queue : ${uniqueJobs.length}`));
        console.log(chalk.bold.cyan(`════════════════════════════════════════════════════════════\n`));

        return uniqueJobs;
    }

    /**
     * Discover jobs by monitoring WhatsApp Web channel(s).
     * @param {Object} [options]
     * @param {string} [options.channelUrl]
     * @param {string[]} [options.channels]
     * @param {number} [options.limit=30]
     * @param {number} [options.whatsappDays=2]
     * @param {boolean} [options.verbose=false]
     * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
     */
    async discover(options = {}) {
        if (!this.page) {
            console.log(chalk.yellow('[WhatsAppPipeline] No active page instance provided. Skipping browser scrape.'));
            return [];
        }

        // 1. Check Session
        const session = await checkWhatsAppSession(this.page);
        if (session.status === 'QR_REQUIRED') {
            console.log(chalk.yellow('  ⚠️ [WhatsAppPipeline] QR code link required. Waiting/prompting for scan...'));
            const loginRes = await ensureWhatsAppLogin(this.page, { maxWaitMs: 30000 });
            if (!loginRes.authenticated) {
                console.log(chalk.yellow('  ⚠️ [WhatsAppPipeline] WhatsApp Web linking not verified. Skipping live channel scrape.'));
                return [];
            }
        }

        const whatsappDays = options.whatsappDays !== undefined ? Number(options.whatsappDays) : 2;
        console.log(chalk.bold.green(`\n=== Starting WhatsApp Channel Discovery Pipeline (Lookback: ${whatsappDays}d) ===`));
        const rawMessages = [];
        const targetChannelUrl = options.channelUrl || this.defaultChannelUrl;

        if (targetChannelUrl) {
            const msgs = await scrapeChannelMessages(this.page, {
                channelUrl: targetChannelUrl,
                limit: options.limit || 30,
                whatsappDays
            });
            rawMessages.push(...msgs);
            if (msgs.stats) rawMessages.stats = msgs.stats;
        } else {
            const channels = options.channels || [undefined];
            for (const ch of channels) {
                const msgs = await scrapeChannelMessages(this.page, {
                    channelName: ch,
                    limit: options.limit || 30,
                    whatsappDays
                });
                rawMessages.push(...msgs);
                if (msgs.stats) rawMessages.stats = msgs.stats;
            }
        }

        return await this.processRawMessages(rawMessages, { whatsappDays, verbose: options.verbose });
    }

    /**
     * Start live monitoring daemon for the target channel.
     * @param {Function} onNewJobCallback 
     * @param {Object} [options]
     * @returns {{ stop: Function }}
     */
    monitorLive(onNewJobCallback, options = {}) {
        if (!this.page) throw new Error('[WhatsAppPipeline] Page required for live monitoring.');

        const targetChannelUrl = options.channelUrl || this.defaultChannelUrl;
        return monitorChannelLive(this.page, async (msg) => {
            const job = await extractJobFromWhatsApp(msg);
            if (job) {
                await onNewJobCallback(job);
            }
        }, { ...options, channelUrl: targetChannelUrl });
    }
}

module.exports = {
    WhatsAppPipeline,
    checkWhatsAppSession,
    ensureWhatsAppLogin,
    scrapeChannelMessages,
    monitorChannelLive,
    extractJobFromWhatsApp,
    extractJobWithDisposition,
    navigateToChannel
};
