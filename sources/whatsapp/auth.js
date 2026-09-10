'use strict';

const chalk = require('chalk');
const selectors = require('./selectors');
const { randomDelay } = require('../../automation/utils');

/**
 * Checks current WhatsApp Web session state.
 * Detects:
 * - Active authenticated session (presence of chat list pane or channels button)
 * - QR code linking requirement
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{ authenticated: boolean, status: 'AUTHENTICATED'|'QR_REQUIRED'|'UNKNOWN', message: string }>}
 */
async function checkWhatsAppSession(page) {
    try {
        const currentUrl = page.url() || '';

        // 1. Check for QR Code
        const qrCanvas = page.locator(selectors.qrCodeCanvas).first();
        const qrContainer = page.locator(selectors.qrCodeContainer).first();

        if (await qrCanvas.isVisible({ timeout: 500 }).catch(() => false) ||
            await qrContainer.isVisible({ timeout: 500 }).catch(() => false)) {
            return {
                authenticated: false,
                status: 'QR_REQUIRED',
                message: 'WhatsApp Web QR code detected. Phone link scan required.'
            };
        }

        // 2. Check for Logged-In Chat List / Navigation
        const paneSide = page.locator(selectors.paneSide).first();
        const channelsTab = page.locator(selectors.channelsTabButton).first();

        if (await paneSide.isVisible({ timeout: 800 }).catch(() => false) ||
            await channelsTab.isVisible({ timeout: 800 }).catch(() => false)) {
            return {
                authenticated: true,
                status: 'AUTHENTICATED',
                message: 'Active WhatsApp Web session confirmed.'
            };
        }

        return {
            authenticated: false,
            status: 'UNKNOWN',
            message: 'Unable to conclusively verify WhatsApp Web session state.'
        };
    } catch (err) {
        return {
            authenticated: false,
            status: 'UNKNOWN',
            message: `WhatsApp session check error: ${err.message}`
        };
    }
}

/**
 * Ensures the persistent browser context has an active WhatsApp Web session.
 * Reuses existing session in auth/; if a QR code is shown, pauses and prompts
 * the user to link their device without attempting to bypass security boundaries.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} [options]
 * @param {number} [options.maxWaitMs=120000]
 * @returns {Promise<{ authenticated: boolean, status: string, message: string }>}
 */
async function ensureWhatsAppLogin(page, options = {}) {
    const maxWaitMs = options.maxWaitMs || 120000;
    console.log(chalk.blue('  [WhatsApp Auth] Verifying WhatsApp Web session...'));

    const currentUrl = page.url();
    if (!currentUrl || !currentUrl.includes('web.whatsapp.com')) {
        try {
            await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
            await randomDelay(2000, 3000);
        } catch (navErr) {
            console.warn(chalk.yellow(`  ⚠️ [WhatsApp Auth] Initial navigation warning: ${navErr.message}`));
        }
    }

    let session = await checkWhatsAppSession(page);

    if (session.status === 'AUTHENTICATED') {
        console.log(chalk.green('  ✔ [WhatsApp Auth] Active WhatsApp Web session confirmed!'));
        return session;
    }

    if (session.status === 'QR_REQUIRED' || session.status === 'UNKNOWN') {
        console.log(chalk.red.bold('\n  ╔══════════════════════════════════════════════════════════════════╗'));
        console.log(chalk.red.bold('  ║  📱  WHATSAPP WEB QR CODE DETECTED!                             ║'));
        console.log(chalk.red.bold('  ║  Action Required: Scan QR code with WhatsApp on your phone.      ║'));
        console.log(chalk.red.bold('  ║  (Settings -> Linked Devices -> Link a Device)                   ║'));
        console.log(chalk.red.bold('  ╚══════════════════════════════════════════════════════════════════╝\n'));

        if (process.env.AUTOMATED_TEST === 'true') {
            return session;
        }

        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            await randomDelay(3000, 5000);
            session = await checkWhatsAppSession(page);
            if (session.status === 'AUTHENTICATED') {
                console.log(chalk.green.bold('  🎉 [WhatsApp Auth] QR scan successful! Active WhatsApp session confirmed.'));
                return session;
            }
        }

        console.log(chalk.yellow('  ⚠️ [WhatsApp Auth] Timed out waiting for QR code scan.'));
        return session;
    }

    return session;
}

module.exports = {
    checkWhatsAppSession,
    ensureWhatsAppLogin
};
