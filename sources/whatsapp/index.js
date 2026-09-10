'use strict';

const chalk = require('chalk');
const settings = require('../../config/settings');
const { scrapeChannelMessages, monitorChannelLive, navigateToChannel } = require('./channelMonitor');
const { checkWhatsAppSession, ensureWhatsAppLogin } = require('./auth');
const { extractJobFromWhatsApp } = require('./jobExtractor');
const { crossSourceDeduplicate } = require('../../discovery/deduplicator');

/**
 * Independent WhatsApp Channels Discovery Pipeline.
 * Extracts job opportunities from WhatsApp channels and community chats,
 * resolves destination URLs, and transforms them into NormalizedJob items.
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
     * @param {Array<string|{ text: string, channelName?: string, channelUrl?: string }>} messages 
     * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob[]>}
     */
    async processRawMessages(messages = []) {
        console.log(chalk.bold.green(`\n=== Processing ${messages.length} WhatsApp Messages ===`));
        const normalizedJobs = [];

        for (const msg of messages) {
            try {
                const job = await extractJobFromWhatsApp(msg);
                if (job) {
                    normalizedJobs.push(job);
                    console.log(chalk.green(`    -> [WhatsApp Job] "${job.title}" at "${job.company}" (${job.applicationType})`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`  ⚠️ [WhatsAppPipeline] Error processing message: ${err.message}`));
            }
        }

        const uniqueJobs = crossSourceDeduplicate(normalizedJobs);
        console.log(chalk.bold.green(`=== Finished WhatsApp Processing: ${uniqueJobs.length} unique jobs discovered ===\n`));
        return uniqueJobs;
    }

    /**
     * Discover jobs by monitoring WhatsApp Web channel(s).
     * @param {Object} [options]
     * @param {string} [options.channelUrl]
     * @param {string[]} [options.channels]
     * @param {number} [options.limit=30]
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

        console.log(chalk.bold.green('\n=== Starting WhatsApp Channel Discovery Pipeline ==='));
        const rawMessages = [];
        const targetChannelUrl = options.channelUrl || this.defaultChannelUrl;

        if (targetChannelUrl) {
            const msgs = await scrapeChannelMessages(this.page, {
                channelUrl: targetChannelUrl,
                limit: options.limit || 30
            });
            rawMessages.push(...msgs);
        } else {
            const channels = options.channels || [undefined];
            for (const ch of channels) {
                const msgs = await scrapeChannelMessages(this.page, {
                    channelName: ch,
                    limit: options.limit || 30
                });
                rawMessages.push(...msgs);
            }
        }

        return await this.processRawMessages(rawMessages);
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
    navigateToChannel
};
