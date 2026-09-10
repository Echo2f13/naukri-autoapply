'use strict';

const crypto = require('crypto');
const chalk = require('chalk');
const selectors = require('./selectors');
const { randomDelay } = require('../../automation/utils');

/**
 * Computes a deterministic hash for a message text to deduplicate message streams.
 * @param {string} text 
 * @returns {string}
 */
function hashMessageText(text = '') {
    return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

/**
 * Navigates to a specific WhatsApp Channel via public preview URL or WhatsApp Web search.
 * 
 * @param {import('playwright').Page} page
 * @param {string} channelUrlOrName 
 * @returns {Promise<boolean>}
 */
async function navigateToChannel(page, channelUrlOrName) {
    if (!channelUrlOrName) return false;

    // Direct Channel URL (e.g. https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25)
    if (channelUrlOrName.startsWith('http')) {
        const channelCodeMatch = channelUrlOrName.match(/channel\/([A-Za-z0-9]+)/);
        const targetUrl = channelCodeMatch 
            ? `https://web.whatsapp.com/accept?channel_invite_code=${channelCodeMatch[1]}&source_surface=`
            : channelUrlOrName;

        // If page is already mounted on WhatsApp Web and target channel code is loaded, avoid full page reloads
        const currentUrl = page.url() || '';
        if (channelCodeMatch && currentUrl.includes(channelCodeMatch[1])) {
            return true;
        }

        console.log(chalk.cyan(`  [WhatsApp Monitor] Navigating to WhatsApp Web Channel: ${targetUrl}...`));
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await randomDelay(3000, 5000);
            return true;
        } catch (err) {
            console.warn(chalk.yellow(`  ⚠️ [WhatsApp Monitor] Navigation to channel URL warning: ${err.message}`));
            return false;
        }
    }

    // Channel / Chat Name search inside WhatsApp Web
    try {
        const searchBox = page.locator(selectors.searchBox).first();
        if (await searchBox.isVisible({ timeout: 3000 }).catch(() => false)) {
            await searchBox.click();
            await searchBox.fill(channelUrlOrName);
            await randomDelay(1000, 1500);

            const chatResult = page.locator(`span[title="${channelUrlOrName}"], span:has-text("${channelUrlOrName}")`).first();
            if (await chatResult.isVisible({ timeout: 3000 }).catch(() => false)) {
                await chatResult.click();
                await randomDelay(1500, 2500);
                return true;
            }
        }
    } catch (e) {
        // Fall through
    }
    return false;
}

/**
 * Scrapes recent messages from an active WhatsApp Web channel or chat.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string} [options.channelUrl]
 * @param {string} [options.channelName]
 * @param {number} [options.limit=30]
 * @returns {Promise<Array<{ text: string, channelName?: string, channelUrl?: string, hash: string, timestamp: Date }>>}
 */
async function scrapeChannelMessages(page, options = {}) {
    const channelUrl = options.channelUrl;
    const channelName = options.channelName || (channelUrl ? 'Target Channel' : 'Active Chat');
    const limit = options.limit || 30;

    console.log(chalk.cyan(`\n[WhatsApp Monitor] Reading messages from "${channelName}"...`));

    // Navigate to channel if URL or name provided
    if (channelUrl) {
        await navigateToChannel(page, channelUrl);
    } else if (options.channelName) {
        await navigateToChannel(page, options.channelName);
    }

    try {
        // Extract message bubbles from current conversation pane
        const rawMessages = await page.evaluate(({ sel, maxLimit }) => {
            const bubbles = Array.from(document.querySelectorAll(sel.messageBubbles));
            const results = [];

            for (let i = bubbles.length - 1; i >= 0 && results.length < maxLimit; i--) {
                const b = bubbles[i];
                const textEl = b.querySelector(sel.messageText) || b.querySelector('.selectable-text');
                const text = textEl ? textEl.innerText?.trim() : b.innerText?.trim();

                if (text && text.length > 20) {
                    const lower = text.toLowerCase();
                    // Keep candidate messages with links or recruitment keywords
                    if (lower.includes('http') || lower.includes('hiring') || lower.includes('role') ||
                        lower.includes('job') || lower.includes('engineer') || lower.includes('experience') ||
                        lower.includes('careers') || lower.includes('developer') || lower.includes('project') ||
                        lower.includes('referral') || lower.includes('intern') || lower.includes('apply')) {
                        results.push({
                            text,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
            return results;
        }, { sel: selectors, maxLimit: limit });

        const processed = rawMessages.map(m => ({
            text: m.text,
            channelName,
            channelUrl,
            hash: hashMessageText(m.text),
            timestamp: new Date(m.timestamp)
        }));

        console.log(chalk.green(`  [WhatsApp Monitor] Collected ${processed.length} relevant candidate messages.`));
        return processed;

    } catch (err) {
        console.warn(chalk.yellow(`  ⚠️ [WhatsApp Monitor] Error reading messages: ${err.message}`));
        return [];
    }
}

/**
 * Continuous watcher daemon that polls the channel at intervals for real-time applications.
 * 
 * @param {import('playwright').Page} page 
 * @param {Function} onNewMessageCallback 
 * @param {Object} [options]
 * @param {number} [options.intervalMs=10000]
 * @param {string} [options.channelUrl]
 * @returns {{ stop: Function }}
 */
function monitorChannelLive(page, onNewMessageCallback, options = {}) {
    const intervalMs = options.intervalMs || 10000;
    const seenHashes = new Set();
    let isRunning = true;

    console.log(chalk.bold.green(`\n[WhatsApp Live Watcher] Started continuous channel listener (interval: ${intervalMs / 1000}s)...`));

    const poll = async () => {
        if (!isRunning) return;
        try {
            const messages = await scrapeChannelMessages(page, options);
            for (const msg of messages) {
                if (!seenHashes.has(msg.hash)) {
                    seenHashes.add(msg.hash);
                    console.log(chalk.magenta.bold(`  🔔 [WhatsApp Watcher] New message received (${msg.hash})!`));
                    await onNewMessageCallback(msg);
                }
            }
        } catch (e) {
            console.warn(chalk.yellow(`  ⚠️ [WhatsApp Watcher] Poll error: ${e.message}`));
        }

        if (isRunning) {
            setTimeout(poll, intervalMs);
        }
    };

    poll();

    return {
        stop: () => {
            console.log(chalk.yellow('[WhatsApp Live Watcher] Stopping channel monitor.'));
            isRunning = false;
        }
    };
}

module.exports = {
    scrapeChannelMessages,
    monitorChannelLive,
    navigateToChannel,
    hashMessageText
};
