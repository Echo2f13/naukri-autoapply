const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { launchBrowser } = require('../../automation/browser');
const { ensureLogin } = require('../../automation/login');

async function test() {
    const { context, page } = await launchBrowser();
    try {
        await ensureLogin(page);
        await page.goto('https://www.naukri.com/job-listings-associate-software-engineer-tredence-bengaluru-0-to-2-years-040926011650?src=drecomm_apply&sid=1788903337779641&xp=1&px=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        const applyBtn = page.locator('button:text-is("Apply"), #apply-button, .apply-button').first();
        if (await applyBtn.isVisible()) {
            console.log("Clicking apply...");
            await applyBtn.click({ force: true });
        }
        await page.waitForTimeout(3000);

        const overlay = page.locator('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]').first();
        console.log("Overlay visible:", await overlay.isVisible());

        // Find all elements containing text "Yes" inside overlay
        const yesElements = await overlay.locator('*:text-matches("^\\s*Yes\\s*$", "i")').all();
        console.log("Yes elements found:", yesElements.length);

        for (let i = 0; i < yesElements.length; i++) {
            const el = yesElements[i];
            const html = await el.evaluate(e => e.outerHTML);
            console.log(`Element ${i} HTML:`, html);
            const isVis = await el.isVisible();
            console.log(`Element ${i} isVisible:`, isVis);
            
            // Try clicking it via DOM dispatch
            console.log(`Clicking element ${i}...`);
            await el.evaluate(e => {
                e.click();
                e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            await page.waitForTimeout(3000);
            
            // Check what happened to chatbot
            const msgs = await overlay.locator('.botMsg, [class*="msg"]').allInnerTexts();
            console.log("Messages after click:", msgs.slice(-3));
            break;
        }

        await page.screenshot({ path: path.resolve(__dirname, '../../screenshots/inspect_after_click.png') });
        console.log("Screenshot saved to screenshots/inspect_after_click.png");

    } finally {
        await context.close();
    }
}

test().catch(console.error);
