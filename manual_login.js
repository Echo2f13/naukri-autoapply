'use strict';

require('dotenv').config();
const readline = require('readline');
const chalk = require('chalk');
const { launchBrowser } = require('./automation/browser');
const { checkLinkedInSession } = require('./sources/linkedin/auth');
const { checkWellfoundSession } = require('./sources/wellfound/auth');
const { checkWhatsAppSession } = require('./sources/whatsapp/auth');
const settings = require('./config/settings');

/**
 * Checks Naukri session status on page.
 */
async function checkNaukriSession(page) {
    try {
        const url = page.url() || '';
        const isLoggedOut = await page.locator(settings.selectors.loginButton).first().isVisible({ timeout: 500 }).catch(() => false);
        const hasProfile = await page.locator('.nI-gNb-drawer__icon, a[href*="mnjuser/profile"], .view-profile-wrapper').first().isVisible({ timeout: 500 }).catch(() => false);
        
        if (hasProfile || (!isLoggedOut && (url.includes('mnjuser') || url.includes('homepage')))) {
            return { authenticated: true, status: 'AUTHENTICATED', message: 'Naukri session active' };
        }
        if (isLoggedOut || url.includes('nlogin')) {
            return { authenticated: false, status: 'LOGIN_REQUIRED', message: 'Login required' };
        }
        return { authenticated: false, status: 'WAITING', message: 'Page loading...' };
    } catch {
        return { authenticated: false, status: 'UNKNOWN', message: 'Checking...' };
    }
}

async function runMultiSourceManualLogin() {
    const { validateProfileSetup } = require('./config/profileLoader');
    if (!validateProfileSetup()) {
        process.exit(1);
    }

    const args = process.argv.slice(2);
    let targetPlatform = 'all';
    args.forEach(arg => {
        if (arg.startsWith('--platform=')) {
            targetPlatform = arg.split('=')[1].toLowerCase().trim();
        }
    });

    console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════════════╗
║             MULTI-SOURCE INTERACTIVE SESSION MANAGER             ║
║       Naukri  •  LinkedIn  •  Wellfound  •  WhatsApp Web         ║
╚══════════════════════════════════════════════════════════════════╝
`));

    console.log(chalk.yellow(`Target Platforms: ${chalk.bold(targetPlatform.toUpperCase())}`));
    console.log(chalk.gray(`Launching a visible browser window with persistent profile in ./auth...\n`));

    // Always launch in HEADED mode for manual login
    const { context, page } = await launchBrowser({ headless: false });

    const tabs = {};

    try {
        // 1. Naukri Tab
        if (targetPlatform === 'all' || targetPlatform === 'naukri') {
            console.log(chalk.blue('🌐 Opening Naukri...'));
            tabs.naukri = page;
            await tabs.naukri.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }

        // 2. LinkedIn Tab
        if (targetPlatform === 'all' || targetPlatform === 'linkedin') {
            console.log(chalk.blue('🌐 Opening LinkedIn...'));
            tabs.linkedin = targetPlatform === 'linkedin' ? page : await context.newPage();
            await tabs.linkedin.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }

        // 3. Wellfound Tab
        if (targetPlatform === 'all' || targetPlatform === 'wellfound') {
            console.log(chalk.blue('🌐 Opening Wellfound...'));
            tabs.wellfound = targetPlatform === 'wellfound' ? page : await context.newPage();
            await tabs.wellfound.goto('https://wellfound.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }

        // 4. WhatsApp Web Tab
        if (targetPlatform === 'all' || targetPlatform === 'whatsapp') {
            console.log(chalk.blue('🌐 Opening WhatsApp Web...'));
            tabs.whatsapp = targetPlatform === 'whatsapp' ? page : await context.newPage();
            await tabs.whatsapp.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }

        console.log(chalk.green.bold('\n✔ Browser window is open on your screen!'));
        console.log(chalk.yellow(`
Instructions:
  1. Switch to each tab in the opened browser window.
  2. Log into your accounts (and scan the QR code on the WhatsApp tab).
  3. Complete any two-factor authentication or CAPTCHAs.
  4. Live status is displayed below.
  5. Press [ENTER] in this terminal when finished to save all sessions!
`));

        // Live polling dashboard
        let polling = true;
        const statusMap = {};

        const pollStatus = async () => {
            if (!polling) return;

            if (tabs.naukri) {
                const s = await checkNaukriSession(tabs.naukri);
                statusMap.Naukri = s.authenticated ? chalk.green.bold('✔ AUTHENTICATED') : chalk.yellow('⏳ LOGIN REQUIRED');
            }
            if (tabs.linkedin) {
                const s = await checkLinkedInSession(tabs.linkedin);
                statusMap.LinkedIn = s.authenticated ? chalk.green.bold('✔ AUTHENTICATED') : (s.status === 'SECURITY_CHALLENGE' ? chalk.red.bold('⚠️ CHALLENGE / CAPTCHA') : chalk.yellow('⏳ LOGIN REQUIRED'));
            }
            if (tabs.wellfound) {
                const s = await checkWellfoundSession(tabs.wellfound);
                statusMap.Wellfound = s.authenticated ? chalk.green.bold('✔ AUTHENTICATED') : (s.status === 'SECURITY_CHALLENGE' ? chalk.red.bold('⚠️ CLOUDFLARE TURNSTILE') : chalk.yellow('⏳ LOGIN REQUIRED'));
            }
            if (tabs.whatsapp) {
                const s = await checkWhatsAppSession(tabs.whatsapp);
                statusMap['WhatsApp Web'] = s.authenticated ? chalk.green.bold('✔ AUTHENTICATED') : chalk.magenta.bold('📱 SCAN QR CODE ON PHONE');
            }

            // Print status line
            const summary = Object.entries(statusMap).map(([k, v]) => `${chalk.bold(k)}: ${v}`).join('  |  ');
            process.stdout.write(`\r[Live Status] ${summary}   `);

            if (polling) {
                setTimeout(pollStatus, 3000);
            }
        };

        pollStatus();

        // Wait for user to press ENTER
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        await new Promise((resolve) => {
            rl.question(chalk.cyan.bold('\n\n👉 Press [ENTER] in this terminal when you are ready to save sessions and close: '), () => {
                polling = false;
                rl.close();
                resolve();
            });
        });

        console.log(chalk.yellow('\n\nSaving sessions and closing browser...'));
        await context.close();
        console.log(chalk.bold.green('🎉 All authenticated sessions saved to ./auth!'));
        console.log(chalk.gray('You can now run autonomous discovery and auto-apply:'));
        console.log(chalk.cyan('   npm run autoapply:all\n'));

    } catch (err) {
        console.error(chalk.red(`\n❌ Error during session login: ${err.message}`));
        await context.close().catch(() => {});
    }
}

if (require.main === module) {
    runMultiSourceManualLogin().catch(console.error);
}

module.exports = { runMultiSourceManualLogin };
