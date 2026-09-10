'use strict';

const chalk = require('chalk');
const selectors = require('./selectors');
const { randomDelay } = require('../../automation/utils');

/**
 * Checks current Wellfound session state.
 * Detects:
 * - Active authenticated session
 * - Login wall / sign-in requirements
 * - Cloudflare Turnstile / bot challenges
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{ authenticated: boolean, status: 'AUTHENTICATED'|'LOGIN_REQUIRED'|'SECURITY_CHALLENGE'|'UNKNOWN', message: string }>}
 */
async function checkWellfoundSession(page) {
    try {
        const currentUrl = page.url() || '';

        // 1. Detect Cloudflare / Security Challenges
        const isChallengeUrl = /challenge|turnstile|cloudflare/i.test(currentUrl);
        let isChallengeElement = false;
        for (const sel of selectors.securityChallengeIndicators) {
            if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
                isChallengeElement = true;
                break;
            }
        }

        if (isChallengeUrl || isChallengeElement) {
            return {
                authenticated: false,
                status: 'SECURITY_CHALLENGE',
                message: 'Wellfound Cloudflare Turnstile / bot challenge detected.'
            };
        }

        // 2. Detect Login Walls / Sign-in Forms
        const isLoginUrl = /wellfound\.com\/login|\/auth/i.test(currentUrl);
        let isLoginElement = false;
        for (const sel of selectors.loginIndicators) {
            if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
                isLoginElement = true;
                break;
            }
        }

        if (isLoginUrl || isLoginElement) {
            return {
                authenticated: false,
                status: 'LOGIN_REQUIRED',
                message: 'Wellfound authentication required (login page detected).'
            };
        }

        // 3. Detect Authenticated Session Indicators
        let isAuthenticated = false;
        for (const sel of selectors.loggedInIndicators) {
            if (await page.locator(sel).first().isVisible({ timeout: 600 }).catch(() => false)) {
                isAuthenticated = true;
                break;
            }
        }

        if (isAuthenticated) {
            return {
                authenticated: true,
                status: 'AUTHENTICATED',
                message: 'Active Wellfound session confirmed.'
            };
        }

        return {
            authenticated: false,
            status: 'UNKNOWN',
            message: 'Unable to conclusively verify Wellfound session state.'
        };
    } catch (err) {
        return {
            authenticated: false,
            status: 'UNKNOWN',
            message: `Wellfound session check error: ${err.message}`
        };
    }
}

/**
 * Ensures the persistent browser context has an active Wellfound session.
 * Reuses existing session; if authentication is needed, pauses and reports
 * for manual login in the opened browser window without attempting to defeat CAPTCHAs.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} [options]
 * @param {number} [options.maxWaitMs=120000]
 * @returns {Promise<{ authenticated: boolean, status: string, message: string }>}
 */
async function ensureWellfoundLogin(page, options = {}) {
    const maxWaitMs = options.maxWaitMs || 120000;
    console.log(chalk.blue('  [Wellfound Auth] Verifying Wellfound session...'));

    const currentUrl = page.url();
    if (!currentUrl || !currentUrl.includes('wellfound.com')) {
        try {
            await page.goto('https://wellfound.com/jobs', { waitUntil: 'domcontentloaded', timeout: 35000 });
            await randomDelay(1500, 2500);
        } catch (navErr) {
            console.warn(chalk.yellow(`  ⚠️ [Wellfound Auth] Initial navigation warning: ${navErr.message}`));
        }
    }

    let session = await checkWellfoundSession(page);

    if (session.status === 'AUTHENTICATED') {
        console.log(chalk.green('  ✔ [Wellfound Auth] Active authenticated session confirmed!'));
        return session;
    }

    if (session.status === 'SECURITY_CHALLENGE') {
        console.log(chalk.red.bold('\n  ╔══════════════════════════════════════════════════════════════════╗'));
        console.log(chalk.red.bold('  ║  ⚠️  WELLFOUND BOT CHALLENGE / CLOUDFLARE DETECTED!             ║'));
        console.log(chalk.red.bold('  ║  Action Required: Complete challenge manually in the browser.    ║'));
        console.log(chalk.red.bold('  ╚══════════════════════════════════════════════════════════════════╝\n'));

        if (process.env.AUTOMATED_TEST === 'true') {
            return session;
        }

        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            await randomDelay(3000, 5000);
            session = await checkWellfoundSession(page);
            if (session.status === 'AUTHENTICATED') {
                console.log(chalk.green.bold('  🎉 [Wellfound Auth] Cloudflare challenge cleared! Active session confirmed.'));
                return session;
            }
        }

        console.log(chalk.red('  ❌ [Wellfound Auth] Timed out waiting for human to resolve Cloudflare challenge.'));
        return session;
    }

    if (session.status === 'LOGIN_REQUIRED' || session.status === 'UNKNOWN') {
        console.log(chalk.yellow('\n  ℹ️ [Wellfound Auth] Not logged in. Please log in manually in the opened browser window.'));
        console.log(chalk.gray(`     Waiting up to ${Math.round(maxWaitMs / 1000)}s for login...`));

        if (process.env.AUTOMATED_TEST === 'true') {
            return session;
        }

        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            await randomDelay(3000, 5000);
            session = await checkWellfoundSession(page);
            if (session.status === 'AUTHENTICATED') {
                console.log(chalk.green.bold('  🎉 [Wellfound Auth] Successful Wellfound login detected! Session stored in persistent context.'));
                return session;
            }
        }

        console.log(chalk.red('  ❌ [Wellfound Auth] Timed out waiting for manual Wellfound login.'));
        return session;
    }

    return session;
}

module.exports = {
    checkWellfoundSession,
    ensureWellfoundLogin
};
