'use strict';

require('dotenv').config();
const chalk = require('chalk');
const { launchBrowser } = require('../automation/browser');
const { ensureWhatsAppLogin } = require('../sources/whatsapp/auth');
const { scrapeChannelMessages, parseWhatsAppTimestamp, isWithinLookback } = require('../sources/whatsapp/channelMonitor');
const { extractLinksFromText, resolveDestinationUrl } = require('../sources/whatsapp/linkResolver');
const { isLegitimateJobMessage, parseMessageDeterministic, parseWhatsAppMessage } = require('../sources/whatsapp/messageParser');
const { extractJobFromWhatsApp } = require('../sources/whatsapp/jobExtractor');
const { resolveApplicationTarget } = require('../application/router');
const settings = require('../config/settings');

async function diagnose() {
    console.log(chalk.bold.cyan('\n=== WHATSAPP 8-MESSAGE DIAGNOSTIC TRACE ===\n'));

    const channelUrl = settings.whatsappChannelUrl || 'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25';
    const { browser, context, page } = await launchBrowser({ headless: false });

    try {
        const auth = await ensureWhatsAppLogin(page);
        if (!auth.authenticated) {
            console.error('WhatsApp not authenticated');
            return;
        }

        const rawMessages = await scrapeChannelMessages(page, {
            channelUrl,
            limit: 30,
            whatsappDays: 2
        });

        console.log(chalk.bold.yellow(`\nCollected ${rawMessages.length} candidate messages inside lookback.\n`));

        for (let i = 0; i < rawMessages.length; i++) {
            const m = rawMessages[i];
            const text = m.text || '';
            const ts = m.timestamp;

            console.log(chalk.bold.blue(`==================================================`));
            console.log(chalk.bold.blue(`MESSAGE #${i + 1}`));
            console.log(chalk.bold.blue(`==================================================`));
            console.log(`Timestamp: ${ts ? ts.toISOString() : 'N/A'}`);
            console.log(`Within lookback: ${isWithinLookback(ts, 2)}`);
            
            const sanitizedPreview = text.replace(/\s+/g, ' ').slice(0, 160) + (text.length > 160 ? '...' : '');
            console.log(`Raw text preview: ${sanitizedPreview}`);

            const urls = extractLinksFromText(text);
            const isJob = isLegitimateJobMessage(text, urls);
            console.log(`Detected as job: ${isJob}`);

            const det = parseMessageDeterministic(text);
            console.log(`Deterministic fields: title="${det.title || ''}", company="${det.company || ''}", location="${det.location || ''}", exp="${det.experience || ''}"`);

            const rawUrl = (urls && urls[0]) || null;
            console.log(`Extracted URL: ${rawUrl || 'None'}`);

            let resolvedUrl = '';
            let detectedAts = 'NONE';
            if (rawUrl) {
                try {
                    resolvedUrl = await resolveDestinationUrl(rawUrl);
                    detectedAts = resolveApplicationTarget({ applicationUrl: resolvedUrl, source: 'WHATSAPP' });
                } catch (e) {
                    resolvedUrl = `Error: ${e.message}`;
                }
            }
            console.log(`Resolved URL: ${resolvedUrl || 'None'}`);
            console.log(`Detected ATS: ${detectedAts}`);

            // Test extractJobFromWhatsApp
            let finalJob = null;
            let failureReason = '';
            try {
                finalJob = await extractJobFromWhatsApp(m);
            } catch (e) {
                failureReason = `Exception: ${e.message}`;
            }

            if (!finalJob) {
                if (!isJob) failureReason = 'Rejected by isLegitimateJobMessage (social promo/NPS or insufficient positive job keywords)';
                else if (!rawUrl) failureReason = 'No application URL found in message';
                else if (!det.title && !resolvedUrl) failureReason = 'Missing both job title and resolvable application URL';
                else failureReason = 'Job extraction returned null';
            }

            console.log(`Extracted title: ${finalJob ? finalJob.title : (det.title || 'null')}`);
            console.log(`Extracted company: ${finalJob ? finalJob.company : (det.company || 'null')}`);
            console.log(`Reason: ${failureReason || 'Accepted as valid job'}`);
            console.log(`Final parser result: ${finalJob ? 'NormalizedJob CREATED (' + finalJob.title + ' @ ' + finalJob.company + ')' : 'DROPPED (' + failureReason + ')'}\n`);
        }

    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

diagnose().catch(err => {
    console.error('Fatal diagnostic error:', err);
    process.exit(1);
});
