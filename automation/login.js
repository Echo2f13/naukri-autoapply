const settings = require('../config/settings');
const { randomDelay } = require('./utils');

/**
 * Ensures the user is logged into Naukri.
 * @param {Object} page Playwright page
 */
async function ensureLogin(page) {
    await page.goto(settings.naukriUrl);
    await randomDelay();

    const loginButton = page.locator(settings.selectors.loginButton);
    const isLoggedOut = await loginButton.isVisible();

    if (isLoggedOut) {
        console.log("Not logged in. Please log in manually in the browser window.");
        console.log("Waiting for login success...");
        
        // Wait for the login button to disappear, indicating successful login
        await page.waitForFunction((selector) => {
            return !document.querySelector(selector);
        }, settings.selectors.loginButton, { timeout: 0 }); // 0 means no timeout

        console.log("Login detected!");
    } else {
        console.log("Active session detected.");
    }
}

module.exports = { ensureLogin };
