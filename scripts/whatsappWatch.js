'use strict';

const { launchBrowser } = require('../automation/browser');
const { ensureWhatsAppLogin } = require('../sources/whatsapp/auth');
const { monitorChannelLive } = require('../sources/whatsapp/channelMonitor');
const { extractJobFromWhatsApp } = require('../sources/whatsapp/jobExtractor');
const settings = require('../config/settings');
const chalk = require('chalk');

(async () => {
    console.log(chalk.bold.cyan('\n============================================================'));
    console.log(chalk.bold.cyan('  WHATSAPP LIVE CHANNEL WATCHER'));
    console.log(chalk.bold.cyan('============================================================\n'));

    const { page, context } = await launchBrowser({ headless: false });

    try {
        // 1. Verify session
        console.log(chalk.blue('Checking WhatsApp Web authenticated session...'));
        const authState = await ensureWhatsAppLogin(page);
        if (!authState.authenticated) {
            console.error(chalk.red('❌ WhatsApp authentication required. Please scan QR code in manual login.'));
            await context.close();
            process.exit(1);
        }

        console.log(chalk.green('✔ WhatsApp Web session is active!'));
        console.log(chalk.cyan(`Target Channel: ${settings.whatsappChannelUrl}\n`));

        // 2. Start monitoring
        monitorChannelLive(page, async (msg) => {
            console.log(chalk.magenta(`\n[New Message ${msg.hash}] ${msg.timestamp.toLocaleTimeString()}:`));
            console.log(chalk.gray(msg.text.slice(0, 160) + (msg.text.length > 160 ? '...' : '')));

            const job = await extractJobFromWhatsApp(msg);
            if (job) {
                console.log(chalk.bold.green(`  🎯 Job Extracted: "${job.title}" at "${job.company}"`));
                console.log(chalk.gray(`     Location: ${job.locations?.join(', ') || 'N/A'} | Exp: ${job.minExperience}-${job.maxExperience} yrs`));
                console.log(chalk.gray(`     Apply URL: ${job.applicationUrl || 'N/A'}`));
            } else {
                console.log(chalk.gray('  ℹ️  No structured job identified in message.'));
            }
        }, { channelUrl: settings.whatsappChannelUrl, intervalMs: 15000 });

    } catch (err) {
        console.error(chalk.red(`Fatal WhatsApp Watcher error: ${err.message}`));
    }
})();
