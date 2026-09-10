'use strict';

const chalk = require('chalk');
const selectors = require('./selectors');
const { randomDelay } = require('../../automation/utils');

/**
 * Checks the current LinkedIn session state on the given page without modifying state.
 * Detects:
 * - Authenticated sessions (presence of global navigation, me profile, feed identity)
 * - Login walls / Authwalls / Sign-in forms
 * - Security challenges / CAPTCHA checkpoints
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<{ authenticated: boolean, status: 'AUTHENTICATED'|'LOGIN_REQUIRED'|'SECURITY_CHALLENGE'|'UNKNOWN', message: string }>}
 */
async function checkLinkedInSession(page) {
    try {
        const currentUrl = page.url() || '';

        // 1. Detect Security Challenges / Checkpoints / CAPTCHA
        const isChallengeUrl = /checkpoint|challenge|captcha/i.test(currentUrl);
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
                message: 'LinkedIn checkpoint / security verification / CAPTCHA challenge detected.'
            };
        }

        // 2. Detect Login Walls / Authwalls / Sign-in Forms
        const isLoginUrl = /authwall|login|uas\/login|signup|guest/i.test(currentUrl);
        let isLoginElement = false;
        for (const sel of [...selectors.loginIndicators, ...selectors.authwallIndicators]) {
            if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
                isLoginElement = true;
                break;
            }
        }

        if (isLoginUrl || isLoginElement) {
            return {
                authenticated: false,
                status: 'LOGIN_REQUIRED',
                message: 'LinkedIn authentication required (login wall / authwall detected).'
            };
        }

        // 3. Detect Authenticated Session Indicators
        let isAuthenticated = false;
        for (const sel of selectors.loggedInIndicators) {
            if (await page.locator(sel).first().isVisible({ timeout: 1200 }).catch(() => false)) {
                isAuthenticated = true;
                break;
            }
        }

        // Feed / Jobs URL verification when login wall and challenges are absent
        if (!isAuthenticated && !isLoginUrl && !isChallengeUrl && !isLoginElement && !isChallengeElement) {
            if (currentUrl.includes('/feed') || currentUrl.includes('/jobs') || currentUrl.includes('/in/')) {
                isAuthenticated = true;
            }
        }

        if (isAuthenticated) {
            return {
                authenticated: true,
                status: 'AUTHENTICATED',
                message: 'Active LinkedIn session confirmed.'
            };
        }

        // 4. Ambiguous / Still Loading
        return {
            authenticated: false,
            status: 'UNKNOWN',
            message: 'Unable to conclusively verify LinkedIn session state.'
        };
    } catch (err) {
        return {
            authenticated: false,
            status: 'UNKNOWN',
            message: `LinkedIn session check error: ${err.message}`
        };
    }
}

/**
 * Ensures the persistent browser context has an active LinkedIn session.
 * Reuses the existing session; if authentication is needed, reports to user
 * and waits for manual login without attempting to bypass security boundaries.
 * 
 * @param {import('playwright').Page} page
 * @param {Object} [options]
 * @param {number} [options.maxWaitMs=120000] - Max time to wait for manual login/challenge
 * @returns {Promise<{ authenticated: boolean, status: string, message: string }>}
 */
async function ensureLinkedInLogin(page, options = {}) {
    const maxWaitMs = options.maxWaitMs || 120000;
    console.log(chalk.blue('  [LinkedIn Auth] Verifying LinkedIn session...'));

    const currentUrl = page.url();
    if (!currentUrl || !currentUrl.includes('linkedin.com')) {
        try {
            await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 35000 });
            await randomDelay(1500, 2500);
        } catch (navErr) {
            console.warn(chalk.yellow(`  ⚠️ [LinkedIn Auth] Initial navigation warning: ${navErr.message}`));
        }
    }

    let session = await checkLinkedInSession(page);

    if (session.status === 'AUTHENTICATED') {
        console.log(chalk.green('  ✔ [LinkedIn Auth] Active authenticated session confirmed!'));
        return session;
    }

    if (session.status === 'SECURITY_CHALLENGE') {
        console.log(chalk.red.bold('\n  ╔══════════════════════════════════════════════════════════════════╗'));
        console.log(chalk.red.bold('  ║  ⚠️  LINKEDIN SECURITY CHALLENGE / CAPTCHA DETECTED!            ║'));
        console.log(chalk.red.bold('  ║  Action Required: Complete verification manually in the browser. ║'));
        console.log(chalk.red.bold('  ╚══════════════════════════════════════════════════════════════════╝\n'));

        if (process.env.AUTOMATED_TEST === 'true') {
            return session;
        }

        // Wait for human resolution
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            await randomDelay(3000, 5000);
            session = await checkLinkedInSession(page);
            if (session.status === 'AUTHENTICATED') {
                console.log(chalk.green.bold('  🎉 [LinkedIn Auth] Security challenge cleared! Active session confirmed.'));
                return session;
            }
        }

        console.log(chalk.red('  ❌ [LinkedIn Auth] Timed out waiting for human to resolve security challenge.'));
        return session;
    }

    if (session.status === 'LOGIN_REQUIRED' || session.status === 'UNKNOWN') {
        console.log(chalk.yellow('\n  ℹ️ [LinkedIn Auth] Not logged in. Please log in manually in the opened browser window.'));
        console.log(chalk.gray(`     Waiting up to ${Math.round(maxWaitMs / 1000)}s for login...`));

        if (process.env.AUTOMATED_TEST === 'true') {
            return session;
        }

        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            await randomDelay(3000, 5000);
            session = await checkLinkedInSession(page);
            if (session.status === 'AUTHENTICATED') {
                console.log(chalk.green.bold('  🎉 [LinkedIn Auth] Successful LinkedIn login detected! Session stored in persistent context.'));
                return session;
            }
        }

        console.log(chalk.red('  ❌ [LinkedIn Auth] Timed out waiting for manual LinkedIn login.'));
        return session;
    }

    return session;
}

module.exports = {
    checkLinkedInSession,
    ensureLinkedInLogin
};
