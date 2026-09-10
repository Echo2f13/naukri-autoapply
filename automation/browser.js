const { chromium } = require('playwright');
const settings = require('../config/settings');
const fs = require('fs');

/**
 * Launches a persistent browser context for session management.
 * @returns {Promise<Object>} { context, page }
 */
async function launchBrowser(options = {}) {
    if (!fs.existsSync(settings.authDir)) {
        fs.mkdirSync(settings.authDir, { recursive: true });
    }

    const isHeadless = options.headless !== undefined ? options.headless : settings.headless;
    const channel = options.channel || settings.browserChannel;

    const context = await chromium.launchPersistentContext(settings.authDir, {
        channel,
        headless: isHeadless,
        slowMo: settings.slowMo,
        viewport: null, recordVideo: { dir: 'videos' }, // Set to null to allow --start-maximized to work
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-maximized' // Start browser maximized
        ]
    });

    // Add anti-detection script
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Fix for "about:blank": Reuse the first page created by launchPersistentContext
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    
    return { context, page, browser: context };
}

module.exports = { launchBrowser };
