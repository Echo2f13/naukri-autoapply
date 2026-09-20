'use strict';

/**
 * WhatsApp Discovery Diagnostic — Dumps raw message content and classification details.
 * Usage: node scripts/whatsappDiagnostic.js
 * 
 * Must run with QR-scan ready browser. Outputs full message text, URLs,
 * keyword signals, structural headline detection, and disposition for each message.
 */

require('dotenv').config();
const chalk = require('chalk');
const { launchBrowser } = require('../automation/browser');
const { ensureWhatsAppLogin } = require('../sources/whatsapp/auth');
const { scrapeChannelMessages } = require('../sources/whatsapp/channelMonitor');
const { isLegitimateJobMessage, detectStructuralHeadline, parseMessageDeterministic } = require('../sources/whatsapp/messageParser');
const { extractLinksFromText } = require('../sources/whatsapp/linkResolver');
const { findAuthoritativeJobUrl, isAutolinkOrSocialOrChannel } = require('../sources/whatsapp/jobExtractor');
const settings = require('../config/settings');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log(chalk.bold.cyan('\n=== WhatsApp Discovery Diagnostic ===\n'));

    const { browser, page, context } = await launchBrowser({ headless: false });

    try {
        // Navigate to WhatsApp Web and wait for login
        await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const loginResult = await ensureWhatsAppLogin(page, { maxWaitMs: 60000 });
        if (!loginResult.authenticated) {
            console.log(chalk.red('❌ WhatsApp login failed. Exiting.'));
            return;
        }

        // Scrape messages with 20-day lookback
        const channelUrl = settings.whatsappChannelUrl || 'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25';
        const messages = await scrapeChannelMessages(page, {
            channelUrl,
            limit: 50,
            whatsappDays: 20
        });

        console.log(chalk.bold.yellow(`\n=== RAW MESSAGE DIAGNOSTIC (${messages.length} potential job messages) ===\n`));

        const diagnosticReport = [];

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const text = msg.text || '';
            const urls = extractLinksFromText(text);
            const isLegit = isLegitimateJobMessage(text, urls);
            const structural = detectStructuralHeadline(text);
            const parsed = parseMessageDeterministic(text);
            const authUrl = findAuthoritativeJobUrl(urls);

            // Compute keyword signals manually for diagnostic
            const lower = text.toLowerCase();
            const jobKeywords = [
                'hiring', 'vacancy', 'openings', 'opening', 'job', 'role', 'position',
                'apply', 'salary', 'ctc', 'package', 'lpa', 'experience', 'eligibility',
                'fresher', 'intern', 'internship', 'engineer', 'developer', 'analyst',
                'work from home', 'remote', 'full time', 'passouts', 'tech stack', 'send resume',
                'associate', 'trainee', 'consultant', 'lead', 'architect'
            ];
            const matchedKeywords = jobKeywords.filter(kw => {
                if (kw === 'experience') {
                    return /\b([0-9]+\+?\s*(?:yrs?|years?)|experience\s*:|exp\s*:|years?\s*of\s*experience)\b/i.test(text);
                }
                return lower.includes(kw);
            });

            // URL classification
            const urlDetails = urls.map(u => ({
                url: u,
                isAutolink: isAutolinkOrSocialOrChannel(u),
                isValid: !isAutolinkOrSocialOrChannel(u)
            }));

            const entry = {
                index: i + 1,
                textPreview: text.slice(0, 200),
                fullTextLength: text.length,
                timestamp: msg.timestamp,
                urls,
                urlDetails,
                authoritativeUrl: authUrl,
                isLegitimateJob: isLegit,
                structuralHeadline: structural,
                matchedKeywords,
                keywordCount: matchedKeywords.length,
                effectiveSignalCount: matchedKeywords.length + (structural ? 2 : 0),
                parsedResult: parsed
            };

            diagnosticReport.push(entry);

            // Console output
            const statusIcon = isLegit ? '✔' : '❌';
            const urlStatus = authUrl ? chalk.green(`✔ ${authUrl}`) : chalk.red('✗ No valid application URL');
            
            console.log(chalk.bold(`\n─── Message #${i + 1} ───`));
            console.log(chalk.gray(`  Text (first 200 chars): "${text.slice(0, 200)}..."`));
            console.log(`  Full text length: ${text.length} chars`);
            console.log(`  isLegitimateJob: ${statusIcon} ${isLegit}`);
            console.log(`  Structural headline: ${structural ? '✔ YES' : '✗ NO'}`);
            console.log(`  Matched keywords (${matchedKeywords.length}): [${matchedKeywords.join(', ')}]`);
            console.log(`  Effective signal count: ${matchedKeywords.length + (structural ? 2 : 0)} (keywords=${matchedKeywords.length}, structural=${structural ? '+2' : '+0'})`);
            console.log(`  URLs found (${urls.length}):`);
            for (const ud of urlDetails) {
                const icon = ud.isValid ? chalk.green('✔ VALID') : chalk.red('✗ FILTERED');
                console.log(`    ${icon}: ${ud.url}`);
            }
            console.log(`  Authoritative URL: ${urlStatus}`);
            if (parsed.isJobPosting !== false) {
                console.log(`  Parsed title: ${parsed.title || '(none)'}`);
                console.log(`  Parsed company: ${parsed.company || '(none)'}`);
                console.log(`  Parsed location: ${parsed.location || '(none)'}`);
            }
        }

        // Save diagnostic report to file
        const reportPath = path.join(__dirname, '..', 'data', 'whatsapp_diagnostic_report.json');
        fs.writeFileSync(reportPath, JSON.stringify(diagnosticReport, null, 2));
        console.log(chalk.bold.green(`\n✅ Diagnostic report saved to: ${reportPath}`));
        console.log(chalk.bold.cyan(`\n=== Diagnostic Complete: ${messages.length} messages analyzed ===\n`));

    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch(err => {
    console.error(chalk.red(`Diagnostic failed: ${err.message}`));
    process.exit(1);
});
