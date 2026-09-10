const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { launchBrowser } = require('../../automation/browser');
const { ensureLogin } = require('../../automation/login');

const targetUrl = 'https://www.naukri.com/job-listings-it-fresher-wfh-hindco-recruitment-consultants-delhi-ncr-0-to-1-years-030926025935?src=drecomm_apply&sid=1788903337779641&xp=5&px=1';

async function main() {
    const { context, page } = await launchBrowser();
    try {
        await ensureLogin(page);
        console.log("Navigating to Hindco job...");
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const title = await page.title();
        console.log("Page title:", title);

        const applyBtn = page.locator('button:text-is("Apply"), #apply-button, .apply-button').first();
        const applyVisible = await applyBtn.isVisible().catch(() => false);
        console.log("Apply button visible:", applyVisible);

        const alreadyApplied = await page.locator('.already-applied, .applied-status, span:text-is("Applied")').first().isVisible().catch(() => false);
        console.log("Already applied:", alreadyApplied);

        if (applyVisible) {
            console.log("Clicking Apply button to inspect form/chatbot...");
            await applyBtn.click({ force: true });
            await page.waitForTimeout(3000);

            const overlay = page.locator('.chatbot_Drawer, .chatbot_Overlay, [class*="chatbot_Overlay"]').first();
            const chatbotVisible = await overlay.isVisible().catch(() => false);
            console.log("Chatbot visible:", chatbotVisible);

            const classicVisible = await page.locator('.apply-message, .apply-dialog, .form-container').first().isVisible().catch(() => false);
            console.log("Classic form visible:", classicVisible);

            const noLabel = overlay.locator('label.ssrc__label').filter({ hasText: /^No$/ }).first();
            console.log('No label visible:', await noLabel.isVisible());
            await noLabel.click({ force: true });
            await page.waitForTimeout(1000);
            
            const sendDisabled = await overlay.locator('.send.disabled').isVisible();
            console.log('.send.disabled visible after click?', sendDisabled);
            
            const saveBtn = overlay.locator('.sendMsg, div:text-is("Save")').first();
            console.log('Clicking Save...');
            await saveBtn.click({ force: true });
            await page.waitForTimeout(3000);
            
            const msgsAfter = await overlay.locator('.botMsg').allInnerTexts();
            console.log('BOT MSGS AFTER CLICKING NO & SAVE:', msgsAfter);

            // Screenshot the state
            await page.screenshot({ path: path.resolve(__dirname, '../../screenshots/inspect_hindco.png') });
            console.log("Saved screenshots/inspect_hindco.png");
        }
    } catch (e) {
        console.error("Error inspecting:", e);
    } finally {
        await context.close();
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { main };
