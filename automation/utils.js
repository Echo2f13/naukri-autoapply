const settings = require('../config/settings');

/**
 * Wait for a random duration between min and max.
 * @param {number} min 
 * @param {number} max 
 */
async function randomDelay(min = settings.delays.min, max = settings.delays.max) {
    if (process.env.AUTOMATED_TEST === 'true' || process.env.NODE_ENV === 'test') {
        return Promise.resolve();
    }
    const delay = Math.floor(Math.random() * (max - min + 1) + min);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Types text with human-like delays.
 * @param {Object} element Playwright locator
 * @param {string} text 
 */
async function humanType(element, text) {
    // Use fill() for instant input — no character-by-character delay needed.
    await element.fill(text);
}

/**
 * Scrolls down the page gradually.
 * @param {Object} page Playwright page
 */
async function humanScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400;   // larger jumps
            const interval = 40;    // faster interval
            let timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, interval);
        });
    });
}

module.exports = { randomDelay, humanType, humanScroll };
