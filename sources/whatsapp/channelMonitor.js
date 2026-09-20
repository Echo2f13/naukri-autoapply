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
 * Parses raw timestamp string or DOM metadata from WhatsApp Web into a Date object.
 * Handles:
 * - data-pre-plain-text: "[10:45 AM, 9/9/2026]" or "[14:30, 09/09/2026]"
 * - ISO date strings
 * - Relative keywords ("yesterday", "today")
 * 
 * SAFETY: Returns null for unparseable inputs. Never fabricates a timestamp.
 * @param {string} dateStr 
 * @returns {Date|null}
 */
function parseWhatsAppTimestamp(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;

    const str = String(dateStr).trim();
    if (!str) return null;

    // 1. WhatsApp Web bracketed timestamp: "[10:45 AM, 9/9/2026]" or "[14:30, 09/09/2026]" or "[08/09/2026, 18:30]"
    const bracketMatch = str.match(/\[(?:.*?,?\s*)?(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (bracketMatch) {
        const p1 = parseInt(bracketMatch[1], 10);
        const p2 = parseInt(bracketMatch[2], 10);
        let year = parseInt(bracketMatch[3], 10);
        if (year < 100) year += 2000;

        let hours = 12, minutes = 0;
        const timeMatch = str.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
        if (timeMatch) {
            hours = parseInt(timeMatch[1], 10);
            minutes = parseInt(timeMatch[2], 10);
            const meridiem = timeMatch[3]?.toLowerCase();
            if (meridiem === 'pm' && hours < 12) hours += 12;
            if (meridiem === 'am' && hours === 12) hours = 0;
        }

        // Default to DD/MM/YYYY
        let day, month;
        if (p1 > 12) {
            day = p1;
            month = p2 - 1;
        } else if (p2 > 12) {
            day = p2;
            month = p1 - 1;
        } else {
            day = p1;
            month = p2 - 1;
        }
        return new Date(year, month, day, hours, minutes);
    }

    // 2. Relative keywords ("yesterday", "today")
    const lower = str.toLowerCase();
    let hours = 12, minutes = 0;
    const timeMatch = str.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
    if (timeMatch) {
        hours = parseInt(timeMatch[1], 10);
        minutes = parseInt(timeMatch[2], 10);
        const meridiem = timeMatch[3]?.toLowerCase();
        if (meridiem === 'pm' && hours < 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
    }

    if (lower.includes('yesterday')) {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        d.setHours(hours, minutes, 0, 0);
        return d;
    }
    if (lower.includes('today')) {
        const d = new Date();
        d.setHours(hours, minutes, 0, 0);
        return d;
    }

    // 3. Time only format: e.g. "6:31 pm", "12:14 pm", "18:30"
    if (/^\d{1,2}:\d{2}(\s*(?:am|pm))?$/i.test(str)) {
        const d = new Date();
        d.setHours(hours, minutes, 0, 0);
        return d;
    }

    // 4. Direct Date parse
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
        return parsed;
    }

    // SAFETY: Never fabricate a timestamp. Return null for unparseable inputs.
    return null;
}

/**
 * Checks if a date falls within the lookback window.
 * 
 * SAFETY: null/undefined timestamps are treated as UNKNOWN and included (returns true).
 * This prevents silent exclusion of messages with unparseable timestamps.
 * 
 * @param {Date|string|number|null} date 
 * @param {number} lookbackDays 
 * @returns {boolean}
 */
function isWithinLookback(date, lookbackDays = 2) {
    if (date === null || date === undefined) return true; // UNKNOWN timestamp -> include
    const msgDate = date instanceof Date ? date : new Date(date);
    if (isNaN(msgDate.getTime())) return true; // Invalid date -> include
    const cutoffTime = Date.now() - (Number(lookbackDays) * 24 * 60 * 60 * 1000);
    return msgDate.getTime() >= cutoffTime;
}

/**
 * Scrapes recent messages from an active WhatsApp Web channel or chat.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string} [options.channelUrl]
 * @param {string} [options.channelName]
 * @param {number} [options.limit=30]
 * @param {number} [options.whatsappDays=2]
 * @returns {Promise<Array<{ text: string, channelName?: string, channelUrl?: string, hash: string, timestamp: Date }>>}
 */
async function scrapeChannelMessages(page, options = {}) {
    const channelUrl = options.channelUrl;
    const channelName = options.channelName || (channelUrl ? 'Target Channel' : 'Active Chat');
    const limit = options.limit || 30;
    const lookbackDays = options.whatsappDays !== undefined ? Number(options.whatsappDays) : 2;
    const lookbackHours = lookbackDays * 24;
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - (lookbackHours * 60 * 60 * 1000));
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const maxScrollIterations = 15; // Safety cap for scroll-based history traversal

    console.log(chalk.cyan(`\n[WhatsApp Monitor] Reading messages from "${channelName}"...`));
    console.log(chalk.cyan(`  [WhatsApp Monitor] Lookback Window: Previous ${lookbackHours} hour(s) (${lookbackDays} day(s))`));
    console.log(chalk.gray(`    Current Time : ${now.toISOString()} (${now.toLocaleString()})`));
    console.log(chalk.gray(`    Cutoff Time  : ${cutoffDate.toISOString()} (${cutoffDate.toLocaleString()})`));
    console.log(chalk.gray(`    Timezone     : ${tz}`));

    // Navigate to channel if URL or name provided
    if (channelUrl) {
        await navigateToChannel(page, channelUrl);
    } else if (options.channelName) {
        await navigateToChannel(page, options.channelName);
    }

    /**
     * Scrapes the currently-visible DOM bubbles from the conversation pane.
     * Returns raw bubble data without processing.
     */
    async function scrapeVisibleBubbles() {
        return await page.evaluate(({ sel, maxLimit }) => {
            const container = document.querySelector(sel.conversationPanel) || document;
            const bubbleNodes = Array.from(container.querySelectorAll(sel.messageBubbles));
            
            // Keep leaf message bubbles to avoid double-processing parent rows
            const leafBubbles = [];
            for (const node of bubbleNodes) {
                const hasChildBubble = bubbleNodes.some(other => other !== node && node.contains(other));
                if (!hasChildBubble) {
                    leafBubbles.push(node);
                }
            }

            const rawBubbles = [];
            for (let i = leafBubbles.length - 1; i >= 0 && rawBubbles.length < maxLimit; i--) {
                const b = leafBubbles[i];

                // Expand "Read more" if collapsed
                const readMoreBtn = b.querySelector('span[role="button"], button');
                if (readMoreBtn && /read more/i.test(readMoreBtn.innerText || '')) {
                    try { readMoreBtn.click(); } catch (_) {}
                }

                const textEl = b.querySelector(sel.messageText) || b.querySelector('.selectable-text');
                const text = (textEl ? textEl.innerText : b.innerText)?.trim() || '';

                // Extract timestamp / date info from copyable-text or metadata
                const copyable = b.querySelector('[data-pre-plain-text]');
                const preText = copyable ? copyable.getAttribute('data-pre-plain-text') : null;
                const metaEl = b.querySelector(sel.messageTimestamp);
                const timeMeta = metaEl ? metaEl.innerText?.trim() : null;

                const lower = text.toLowerCase();
                const isPotentialJob = lower.includes('http') || lower.includes('hiring') || lower.includes('role') ||
                                       lower.includes('job') || lower.includes('engineer') || lower.includes('experience') ||
                                       lower.includes('careers') || lower.includes('developer') || lower.includes('project') ||
                                       lower.includes('referral') || lower.includes('intern') || lower.includes('apply') ||
                                       lower.includes('analyst') || lower.includes('associate') || lower.includes('trainee') ||
                                       lower.includes('consultant') || lower.includes('architect');

                rawBubbles.push({
                    text,
                    preText,
                    timeMeta,
                    isPotentialJob,
                    // SAFETY: Use null instead of new Date().toISOString() for unknown timestamps
                    rawTimestamp: preText || timeMeta || null
                });
            }

            return {
                totalDOMBubbles: leafBubbles.length,
                bubbles: rawBubbles
            };
        }, { sel: selectors, maxLimit: limit });
    }

    try {
        // Wait for conversation pane message bubbles to render in the SPA
        await page.waitForSelector(selectors.messageBubbles, { timeout: 12000 }).catch(() => {});
        await randomDelay(2000, 3000);

        // Scroll-based history traversal: accumulate messages across multiple viewport loads
        const seenTexts = new Set();
        const processed = [];
        let insideLookbackCount = 0;
        let outsideLookbackCount = 0;
        let duplicateBubbleCount = 0;
        let nonMessageCount = 0;
        let potentialJobsCount = 0;
        let nonJobCount = 0;
        let unknownTimestampCount = 0;
        let totalDOMBubblesInspected = 0;
        let scrollIterations = 0;
        let reachedLookbackBoundary = false;
        let previousBubbleCount = -1;
        let consecutiveStagnantScrolls = 0;

        for (let iteration = 0; iteration <= maxScrollIterations; iteration++) {
            const scrapeResult = await scrapeVisibleBubbles();
            const rawBubbles = scrapeResult?.bubbles || [];
            const iterationDOMCount = scrapeResult?.totalDOMBubbles || rawBubbles.length;

            if (iteration === 0) {
                totalDOMBubblesInspected = iterationDOMCount;
            }

            let newMessagesThisIteration = 0;
            let foundOutsideLookback = false;

            for (const b of rawBubbles) {
                const text = (b.text || '').trim();
                if (!text || text.length < 15) {
                    nonMessageCount++;
                    continue;
                }

                // Deduplicate across iterations
                if (seenTexts.has(text)) {
                    duplicateBubbleCount++;
                    continue;
                }

                const msgDate = parseWhatsAppTimestamp(b.preText || b.timeMeta || b.rawTimestamp);

                if (msgDate === null) {
                    unknownTimestampCount++;
                }

                const insideWindow = isWithinLookback(msgDate, lookbackDays);

                if (!insideWindow) {
                    outsideLookbackCount++;
                    foundOutsideLookback = true;
                    continue;
                }

                seenTexts.add(text);
                insideLookbackCount++;
                newMessagesThisIteration++;

                if (b.isPotentialJob) {
                    potentialJobsCount++;
                    processed.push({
                        text,
                        channelName,
                        channelUrl,
                        hash: hashMessageText(text),
                        timestamp: msgDate
                    });
                } else {
                    nonJobCount++;
                }
            }

            // Stop conditions for scroll traversal
            if (foundOutsideLookback) {
                reachedLookbackBoundary = true;
                console.log(chalk.gray(`  [WhatsApp Monitor] Scroll iteration ${iteration}: Reached lookback boundary (messages older than ${lookbackDays}d found). Stopping.`));
                break;
            }

            if (iteration > 0 && newMessagesThisIteration === 0) {
                consecutiveStagnantScrolls++;
                if (consecutiveStagnantScrolls >= 2) {
                    console.log(chalk.gray(`  [WhatsApp Monitor] Scroll iteration ${iteration}: No new messages found after 2 consecutive checks. Stopping.`));
                    break;
                }
            } else if (newMessagesThisIteration > 0) {
                consecutiveStagnantScrolls = 0;
            }

            if (iteration === maxScrollIterations) {
                console.log(chalk.yellow(`  [WhatsApp Monitor] Reached maximum scroll iterations (${maxScrollIterations}). Stopping.`));
                break;
            }

            // Scroll up to load older messages using Playwright keyboard events
            // WhatsApp Web uses a virtualized list that requires native scroll events,
            // not just DOM scrollTop manipulation, to trigger lazy loading of older messages.
            if (iteration < maxScrollIterations) {
                scrollIterations++;
                console.log(chalk.gray(`  [WhatsApp Monitor] Scroll iteration ${iteration}: Scrolling up to load older messages...`));

                // 1. Click inside the conversation pane to ensure it has keyboard focus
                try {
                    const convPane = page.locator(selectors.conversationPanel).first();
                    if (await convPane.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await convPane.click({ position: { x: 200, y: 200 } }).catch(() => {});
                    } else {
                        // Fallback: click the main area
                        await page.locator('#main').first().click({ position: { x: 200, y: 200 } }).catch(() => {});
                    }
                    await randomDelay(300, 500);
                } catch (_) {
                    // Continue even if focus click fails
                }

                // 2. Count bubbles before scrolling to detect if new content loads
                const bubbleCountBefore = await page.evaluate((sel) => {
                    const container = document.querySelector(sel.conversationPanel) || document;
                    return container.querySelectorAll(sel.messageBubbles).length;
                }, selectors);

                // 3. Press PageUp multiple times to trigger WhatsApp's virtual scroll
                const pageUpPresses = 5; // Each PageUp scrolls roughly one viewport
                for (let p = 0; p < pageUpPresses; p++) {
                    await page.keyboard.press('PageUp');
                    await randomDelay(200, 400);
                }

                // 4. Wait for WhatsApp Web to render newly loaded messages
                await randomDelay(2000, 3500);

                // 5. Count bubbles after scrolling to verify new content loaded
                const bubbleCountAfter = await page.evaluate((sel) => {
                    const container = document.querySelector(sel.conversationPanel) || document;
                    return container.querySelectorAll(sel.messageBubbles).length;
                }, selectors);

                console.log(chalk.gray(`  [WhatsApp Monitor] Scroll iteration ${iteration}: Bubbles before=${bubbleCountBefore}, after=${bubbleCountAfter}`));

                if (bubbleCountAfter <= bubbleCountBefore && iteration > 0 && consecutiveStagnantScrolls >= 2) {
                    console.log(chalk.gray(`  [WhatsApp Monitor] Scroll iteration ${iteration}: No new DOM content loaded. Beginning of conversation or channel limit reached.`));
                    break;
                }

                totalDOMBubblesInspected += iterationDOMCount;
            }
        }

        // Attach structured stats
        processed.stats = {
            totalDOMBubbles: totalDOMBubblesInspected,
            insideLookback: insideLookbackCount,
            outsideLookback: outsideLookbackCount,
            duplicateBubbles: duplicateBubbleCount,
            nonMessage: nonMessageCount,
            potentialJobs: potentialJobsCount,
            nonJobPosts: nonJobCount,
            unknownTimestamps: unknownTimestampCount,
            scrollIterations,
            reachedLookbackBoundary,
            totalUniqueMessages: seenTexts.size
        };

        if (outsideLookbackCount > 0) {
            console.log(chalk.gray(`  [WhatsApp Monitor] Filtered out ${outsideLookbackCount} message(s) older than ${lookbackDays} day(s).`));
        }
        if (unknownTimestampCount > 0) {
            console.log(chalk.yellow(`  [WhatsApp Monitor] ⚠️ ${unknownTimestampCount} message(s) had unparseable timestamps (included as UNKNOWN).`));
        }
        console.log(chalk.green(`  [WhatsApp Monitor] Inspected ${totalDOMBubblesInspected} bubbles across ${scrollIterations} scroll(s) -> ${insideLookbackCount} inside lookback (${outsideLookbackCount} outside) -> ${processed.length} potential job messages collected.`));
        console.log(chalk.gray(`  [WhatsApp Monitor] Scroll diagnostics: iterations=${scrollIterations}, uniqueMessages=${seenTexts.size}, reachedBoundary=${reachedLookbackBoundary}, unknownTimestamps=${unknownTimestampCount}`));
        return processed;

    } catch (err) {
        console.warn(chalk.yellow(`  ⚠️ [WhatsApp Monitor] Error reading messages: ${err.message}`));
        const empty = [];
        empty.stats = { totalInspected: 0, insideLookback: 0, potentialJobs: 0, nonJob: 0, olderThanLookback: 0, unknownTimestamps: 0, scrollIterations: 0, reachedLookbackBoundary: false, totalUniqueMessages: 0 };
        return empty;
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
    hashMessageText,
    parseWhatsAppTimestamp,
    isWithinLookback
};
