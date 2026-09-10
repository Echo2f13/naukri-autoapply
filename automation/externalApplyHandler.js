const { getAnswer } = require('../ai/answerEngine');
const { loadResume } = require('../ai/prompts');
const { randomDelay } = require('./utils');
const profile = require('../config/profile');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

/**
 * Safely matches an answer string against an array of option strings.
 * Avoids short substring collisions (e.g. 'No' matching 'Technology').
 */
function matchOption(options, ans) {
    if (!ans || !options || options.length === 0) return null;
    const cleanAns = ans.trim().toLowerCase();

    // 1. Exact match
    const exact = options.find(o => o.trim().toLowerCase() === cleanAns);
    if (exact) return exact;

    // 2. Strict word-boundary match (e.g. "Yes" in "Yes, I am authorized")
    const wordBoundary = options.find(o => {
        const escaped = cleanAns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(o.trim());
    });
    if (wordBoundary) return wordBoundary;

    // 3. Substring match ONLY if answer is at least 4 characters long
    if (cleanAns.length >= 4) {
        const sub = options.find(o => o.toLowerCase().includes(cleanAns) || cleanAns.includes(o.toLowerCase()));
        if (sub) return sub;
    }

    return null;
}

/**
 * Helper to safely fill an input field if it exists, is visible, and is currently empty.
 * Supports both standard CSS selectors and label-based lookup for ATS platforms with dynamic IDs (e.g. Zoho Recruit, Workday).
 */
async function fillFieldIfEmpty(scope, selectors, value, fieldLabel = '', labelAliases = []) {
    if (!value) return false;

    // 1. Try standard CSS selectors
    for (const selector of selectors) {
        try {
            const loc = scope.locator(selector).first();
            if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
                const currentVal = await loc.inputValue().catch(() => '');
                if (!currentVal || currentVal.trim() === '') {
                    await loc.scrollIntoViewIfNeeded().catch(() => {});
                    await loc.fill(String(value));
                    await loc.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true }))).catch(() => {});
                    await loc.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});
                    console.log(chalk.green(`    -> Filled ${fieldLabel || 'field'}: "${value}"`));
                    return true;
                } else {
                    return true; // already filled
                }
            }
        } catch (_) {}
    }

    // 2. Try label-based lookup (e.g. Zoho Recruit, Workday, custom ATS with generated IDs)
    const labelsToCheck = [fieldLabel, ...labelAliases].filter(Boolean);
    for (const lbl of labelsToCheck) {
        try {
            const labelLoc = scope.locator(`label:has-text("${lbl}")`).first();
            if (await labelLoc.isVisible({ timeout: 800 }).catch(() => false)) {
                const forId = await labelLoc.getAttribute('for').catch(() => '');
                let inp = forId ? scope.locator(`#${forId}`).first() : null;
                if (!inp || !(await inp.isVisible().catch(() => false))) {
                    inp = labelLoc.locator('..').locator('input:not([type="hidden"]), textarea').first();
                }
                if (inp && (await inp.isVisible().catch(() => false))) {
                    const currentVal = await inp.inputValue().catch(() => '');
                    if (!currentVal || currentVal.trim() === '') {
                        await inp.scrollIntoViewIfNeeded().catch(() => {});
                        await inp.fill(String(value));
                        await inp.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true }))).catch(() => {});
                        await inp.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});
                        console.log(chalk.green(`    -> Filled ${fieldLabel || lbl} (by label): "${value}"`));
                        return true;
                    } else {
                        return true;
                    }
                }
            }
        } catch (_) {}
    }

    return false;
}

/**
 * Checks if the external site presents an authentication/login gate before allowing application.
 */
async function checkLoginWall(page) {
    return await page.evaluate(() => {
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const hasSignIn = bodyText.includes('sign in') || bodyText.includes('log in') || bodyText.includes('login') || bodyText.includes('create an account to apply');
        const hasPasswordField = !!document.querySelector('input[type="password"]');
        const hasEmailField = !!document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]');
        return hasSignIn && hasPasswordField && hasEmailField;
    }).catch(() => false);
}

/**
 * Dedicated handler for Zoho Recruit ATS forms (e.g. Kumaran Systems, Zoho Recruit hosted portals)
 */
async function handleZohoRecruitApplication(page, job, selectedResume, options = {}) {
    const dryRun = options.dryRun || false;
    console.log(chalk.magenta.bold('  🎯 Detected Zoho Recruit ATS! Running specialized Zoho Recruit automation flow...'));

    // 1. Accept cookies banner if present
    const cookieBtn = page.locator('career-cookie-consent button.cookie-accept-btn, career-cookie-consent button:has-text("Accept all"), button.cookie-accept-btn, button:has-text("Accept all"), button:has-text("Accept All"), button:has-text("Accept cookies")').first();
    if (await cookieBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        console.log(chalk.blue('  Accepting cookies banner...'));
        await cookieBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
    }

    // 2. Click "I'm interested" / Apply trigger if on landing view
    const interestedBtn = page.locator('button:has-text("I\'m interested"), a:has-text("I\'m interested"), text=/I.m interested/i').first();
    if (await interestedBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
        console.log(chalk.blue('  Clicking "I\'m interested" button...'));
        await interestedBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(3000);
    }

    // Wait for the form container or inputs to mount
    await page.waitForSelector('rec-form-component, portal-manual-apply, input[name*="rec-form_"], [data-zcqa*="First_Name" i], .crc-form-row', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Helper to find and set input by visible label
    const fillByLabel = async (labelText, value) => {
        return await page.evaluate(({ labelText, value }) => {
            const labels = Array.from(document.querySelectorAll('label, .crm-from-label, span.crc-label-text, .cw-section-title'));
            const match = labels.find(l => l.innerText?.toLowerCase().includes(labelText.toLowerCase()));
            if (!match) return false;
            let container = match.closest('.crc-form-row, .rec-form-row') || match.parentElement;
            const input = container?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="file"]), textarea');
            if (input) {
                input.focus();
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        }, { labelText, value }).catch(() => false);
    };

    // 3. Attach Resume to the designated file input (Zoho typically has easy-resume at index 0 and standard application attachment at index 1)
    await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
    const fileInputs = await page.locator('input[type="file"]').all();
    console.log(chalk.blue(`  Found ${fileInputs.length} file upload inputs...`));
    if (fileInputs.length > 1) {
        await fileInputs[1].setInputFiles(selectedResume.path);
        console.log(chalk.green(`  ✔ Attached resume to application attachment input: "${selectedResume.fileName}"`));
    } else if (fileInputs.length > 0) {
        await fileInputs[0].setInputFiles(selectedResume.path);
        console.log(chalk.green(`  ✔ Attached resume: "${selectedResume.fileName}"`));
    }
    await page.waitForTimeout(1000);

    // 4. Fill standard Crux / Lyte form fields
    const textFields = [
        { key: 'First_Name', nameKey: '3149', val: profile.firstName || profile.fullName.split(' ')[0] },
        { key: 'Last_Name', nameKey: '3151', val: profile.lastName || (profile.fullName || '').split(' ').slice(1).join(' ') },
        { key: 'Email', nameKey: '3155', val: profile.email || '' },
        { key: 'Total_Years_Of_Experience', nameKey: '3179', val: String(profile.experience || '1') },
        { key: 'Experience_in_Years', nameKey: '3179', val: String(profile.experience || '1') },
        { key: 'Relevant_Years_Of_Experience', nameKey: '3179', val: String(profile.experience || '1') },
        { key: 'Current_Employer', nameKey: 'employer', val: profile.currentCompany || '' },
        { key: 'Current_Salary', nameKey: '3199', val: profile.currentCTC || '0' },
        { key: 'Expected_Salary', nameKey: '3197', val: profile.expectedCTC || '800000' }
    ];

    for (const tf of textFields) {
        let filled = false;
        // Direct name match e.g. input[name*="3149"] or zcqa
        const comp = page.locator(`input[name*="${tf.nameKey}"], [data-zcqa*="${tf.key}" i], [cx-prop-label*="${tf.key}" i]`).first();
        if (await comp.isVisible({ timeout: 600 }).catch(() => false)) {
            const inp = (await comp.evaluate(el => el.tagName).catch(() => '')) === 'INPUT' ? comp : comp.locator('input:not([type="hidden"])').first();
            if (await inp.isVisible({ timeout: 600 }).catch(() => false)) {
                await inp.fill(String(tf.val));
                await inp.evaluate(e => {
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
                console.log(chalk.green(`    -> Filled ${tf.key}: "${tf.val}"`));
                filled = true;
            }
        }
        if (!filled) {
            const labelKey = tf.key.replace(/_/g, ' ');
            const ok = await fillByLabel(labelKey, String(tf.val));
            if (ok) {
                console.log(chalk.green(`    -> Filled by label [${labelKey}]: "${tf.val}"`));
            }
        }
    }

    // Mobile Number (unique to Zoho schema 3161)
    const phoneInp = page.locator('input[name*="3161"], .crc-rec-form_23850000000003161 input.cxBorderBottom, [class*="3161"] input.cxBorderBottom, [data-zcqa*="Mobile" i] input.cxBorderBottom').first();
    if (await phoneInp.isVisible({ timeout: 1000 }).catch(() => false)) {
        const phoneVal = (profile.mobile || '').replace(/^\+91\s*/, '');
        await phoneInp.fill(phoneVal);
        await phoneInp.evaluate(e => {
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch(() => {});
        console.log(chalk.green(`    -> Filled Mobile: ${phoneVal}`));
    }

    // Address fields (sequential typing for Zoho combobox inputs)
    const streetVal = profile.address?.street || '';
    const cityVal = profile.address?.city || profile.currentLocation || '';
    const stateVal = profile.address?.state || '';
    const zipVal = profile.address?.zipCode || profile.postalCode || '';
    const countryVal = profile.address?.country || 'India';

    const addrSpecs = [
        { key: 'Street', val: streetVal },
        { key: 'City', val: cityVal },
        { key: 'State', val: stateVal },
        { key: 'Zip_Code', val: zipVal },
        { key: 'Country', val: countryVal }
    ];

    for (const a of addrSpecs) {
        const comp = page.locator(`[data-zcqa*="${a.key}" i]`).first();
        if (await comp.isVisible({ timeout: 600 }).catch(() => false)) {
            const inp = comp.locator('input').first();
            if (await inp.isVisible({ timeout: 600 }).catch(() => false)) {
                await inp.click();
                await inp.fill('');
                await inp.pressSequentially(a.val, { delay: 20 });
                await inp.evaluate(e => {
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
                console.log(chalk.green(`    -> Typed ${a.key}: "${a.val}"`));
            }
        }
    }

    // 5. Highest Qualification Held Dropdown
    const qualBtn = page.locator('[data-zcqa="manual_Highest_Qualification_Held"], lyte-dropdown[id*="3195"], lyte-dropdown:has-text("Highest Qualification")').first();
    if (await qualBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
        await qualBtn.scrollIntoViewIfNeeded().catch(() => {});
        await qualBtn.click();
        await page.waitForTimeout(500);

        const qualItem = page.locator('lyte-drop-box:visible lyte-drop-item:has-text("M.Tech"), lyte-drop-box:visible lyte-drop-item:has-text("B.Tech"), lyte-drop-box:visible lyte-drop-item:has-text("M.S."), lyte-drop-box:visible lyte-drop-item:has-text("B.E.")').first();
        if (await qualItem.count() > 0) {
            const chosenQual = (await qualItem.innerText().catch(() => '')).trim();
            await qualItem.evaluate(el => el.click());
            console.log(chalk.green(`    -> Selected Highest Qualification Held: "${chosenQual}"`));
        }
        await page.waitForTimeout(500);
    }

    // 6. Skill Set
    const skillComp = page.locator('#addSkills, input[name="-add-skills"], #rec-form_31840000000003185, [data-zcqa*="Skill_Set" i]').first();
    if (await skillComp.isVisible({ timeout: 1200 }).catch(() => false)) {
        await skillComp.scrollIntoViewIfNeeded().catch(() => {});
        const skillInp = (await skillComp.evaluate(el => el.tagName).catch(() => '')) === 'INPUT' ? skillComp : skillComp.locator('input').first();
        const skillsToAdd = (job.role && /devops/i.test(job.role)) ? ['DevOps'] : ['Python', 'Machine Learning'];
        for (const s of skillsToAdd) {
            await skillInp.fill(s);
            await page.waitForTimeout(400);
            const pill = page.locator('.skl-suggested-skill, .skl-suggested-tag-container, [class*="skillTag"]').locator(`text=/^${s}$/i`).first();
            if (await pill.isVisible({ timeout: 800 }).catch(() => false)) {
                await pill.click();
            } else {
                await skillInp.press('Enter');
            }
            await page.waitForTimeout(200);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.locator('body').click({ position: { x: 10, y: 10 } }).catch(() => {});
        await page.waitForTimeout(500);
        console.log(chalk.green(`    -> Added Skills: ${skillsToAdd.join(', ')}`));
    }

    // 7. Check if multi-step form (has "Next" button) or single-page form
    const nextBtn = page.locator('button:has-text("Next")').first();
    const isMultiStep = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (isMultiStep) {
        // Multi-step (Kumaran Systems style)
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        console.log(chalk.yellow('  Clicking Next to advance to Educational Details...'));
        await nextBtn.click();
        await page.waitForTimeout(2500);

        // 8. Step 2: Educational Details
        console.log(chalk.blue('  Filling Educational Details...'));
        await page.evaluate(({ uni, field, deg }) => {
            const findAndSet = (labelText, val) => {
                const all = Array.from(document.querySelectorAll('*'));
                const label = all.find(e => e.innerText?.trim().startsWith(labelText) && e.children.length <= 2);
                if (!label) return;
                let curr = label.parentElement;
                for (let i = 0; i < 4; i++) {
                    if (!curr) break;
                    const inp = curr.querySelector('input:not([type="hidden"]):not([type="checkbox"])');
                    if (inp) {
                        inp.focus();
                        inp.value = val;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                    curr = curr.parentElement;
                }
            };

            findAndSet('Institute / School', uni);
            findAndSet('Major / Department', field);
            findAndSet('Degree', deg);
        }, {
            uni: profile.education?.university || 'Vellore Institute of Technology',
            field: profile.education?.field || 'Computer Science and Engineering',
            deg: profile.education?.degree || 'Integrated M.Tech'
        });
        console.log(chalk.green('    -> Filled Institute, Major, and Degree'));

        // Handle "Currently pursuing" checkbox
        const shouldPursue = !!profile.education?.currentlyPursuing;
        await page.evaluate((pursue) => {
            const cb = document.querySelector('input[type="checkbox"][name*="127075"], input[type="checkbox"][id*="pursuing" i]') ||
                       Array.from(document.querySelectorAll('lyte-checkbox')).find(e => e.innerText?.includes('Currently pursuing'));
            if (!cb) return;
            const isChecked = cb.checked || cb.getAttribute('lt-prop-checked') === 'true';
            if (pursue && !isChecked) {
                const clickTarget = cb.tagName.toLowerCase() === 'lyte-checkbox' ? 
                                   (cb.querySelector('.lyteCheckBoxDefault') || cb) : 
                                   (cb.closest('lyte-checkbox') || cb);
                clickTarget.click();
            } else if (!pursue && isChecked) {
                const clickTarget = cb.tagName.toLowerCase() === 'lyte-checkbox' ? 
                                   (cb.querySelector('.lyteCheckBoxDefault') || cb) : 
                                   (cb.closest('lyte-checkbox') || cb);
                clickTarget.click();
            }
        }, shouldPursue);
        console.log(chalk.green(`    -> "Currently pursuing" set to: ${shouldPursue}`));

        // Duration dropdown helper
        const selectLyteDropdown = async (btnLocator, searchText) => {
            if (!(await btnLocator.isVisible().catch(() => false))) return;
            await btnLocator.scrollIntoViewIfNeeded().catch(() => {});
            await btnLocator.click();
            await page.waitForTimeout(400);

            const dropBox = page.locator('lyte-drop-box:visible').first();
            const searchInp = dropBox.locator('input').first();
            if (await searchInp.isVisible({ timeout: 600 }).catch(() => false)) {
                await searchInp.fill(searchText);
                await page.waitForTimeout(300);
                const filteredItem = dropBox.locator(`lyte-drop-item:has-text("${searchText}")`).first();
                if (await filteredItem.count() > 0) {
                    await filteredItem.click();
                } else {
                    await page.keyboard.press('Enter');
                }
            } else {
                const item = dropBox.locator(`lyte-drop-item:has-text("${searchText}")`).first();
                if (await item.count() > 0) {
                    await item.click();
                }
            }
            await page.waitForTimeout(300);
        };

        const fromMonthBtn = page.locator('lyte-dropdown[id*="from_month"] lyte-drop-button, lyte-dropdown[id*="from_month"]').first();
        await selectLyteDropdown(fromMonthBtn, 'Jun');
        console.log(chalk.green('    -> Selected From Month: Jun'));

        const fromYearBtn = page.locator('lyte-dropdown[id*="from_year"] lyte-drop-button, lyte-dropdown[id*="from_year"]').first();
        await selectLyteDropdown(fromYearBtn, '2021');
        console.log(chalk.green('    -> Selected From Year: 2021'));

        if (!shouldPursue) {
            const toMonthBtn = page.locator('lyte-dropdown[id*="to_month"] lyte-drop-button, lyte-dropdown[id*="to_month"]').first();
            await selectLyteDropdown(toMonthBtn, 'Jun');
            console.log(chalk.green('    -> Selected To Month: Jun'));

            const toYearBtn = page.locator('lyte-dropdown[id*="to_year"] lyte-drop-button, lyte-dropdown[id*="to_year"]').first();
            await selectLyteDropdown(toYearBtn, '2026');
            console.log(chalk.green('    -> Selected To Year: 2026'));
        }

        // Year of Passed out: 2026 (if present)
        const passOutInp = page.locator('xpath=//*[contains(text(), "Year of Passed out")]/following::input[1]').first();
        if (await passOutInp.isVisible({ timeout: 1000 }).catch(() => false)) {
            await passOutInp.fill(profile.education?.passoutYear || '2026');
            console.log(chalk.green(`    -> Filled Year of Passed out: ${profile.education?.passoutYear || '2026'}`));
        }

        // 9. Click Next to advance to Step 3 (Compliance Survey)
        const step2Submit = page.locator('button:has-text("Next"), button:has-text("Submit"), button[type="submit"]').first();
        console.log(chalk.yellow('  Clicking Next to advance to Step 3 (Compliance)...'));
        await step2Submit.click();
        await page.waitForTimeout(3500);

        // 10. Step 3: EEO Compliance Survey
        const selectRadio = async (textPattern) => {
            const loc = page.locator(`lyte-radiobutton:has-text("${textPattern}"), label:has-text("${textPattern}"), span:has-text("${textPattern}")`).first();
            if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
                await loc.scrollIntoViewIfNeeded().catch(() => {});
                await loc.click();
                console.log(chalk.green(`    -> Selected survey option: "${textPattern}"`));
                await page.waitForTimeout(300);
            }
        };

        const isCompliance = await page.locator('text=/EEO Compliance Survey|Disability Status/i').first().isVisible({ timeout: 2500 }).catch(() => false);
        if (isCompliance) {
            console.log(chalk.blue('  Filling EEO Compliance Survey...'));
            await selectRadio('No, I do not have a disability and have not had one in the past');
            await selectRadio('Asian');
            await selectRadio('Male');
            await selectRadio('I am not a veteran.');

            // Click final Submit on EEO page
            const submitEEO = page.locator('button:has-text("Submit"), button[type="submit"]').first();
            if (await submitEEO.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(chalk.yellow('  Clicking final Submit button on Compliance survey...'));
                await submitEEO.click();
                await page.waitForTimeout(5000);
            }
        }
    } else {
        // Single-page Zoho Recruit form (e.g. Addweb Solution)
        console.log(chalk.blue('  Single-page Zoho Recruit form detected (e.g. Addweb Solution)...'));

        // Handle CAPTCHA if present
        const captchaImg = page.locator('img[alt="CAPTCHA"]').first();
        if (await captchaImg.isVisible({ timeout: 2000 }).catch(() => false)) {
            const captchaPath = path.resolve(__dirname, '../scratch/current_captcha.png');
            await captchaImg.screenshot({ path: captchaPath });
            console.log(chalk.yellow(`\n📸 CAPTCHA detected! Image saved to: ${captchaPath}`));

            const solPath = path.resolve(__dirname, '../scratch/captcha_solution.txt');
            try { if (fs.existsSync(solPath)) fs.unlinkSync(solPath); } catch (_) {}

            console.log(chalk.yellow.bold('  👉 Waiting up to 35 seconds for solution in scratch/captcha_solution.txt or browser entry...'));
            const captchaInp = page.locator('input[placeholder*="below image text" i], [class*="captcha" i] input, rec-captcha-component input').first();

            let solution = '';
            const start = Date.now();
            while (Date.now() - start < 35000) {
                if (fs.existsSync(solPath)) {
                    solution = fs.readFileSync(solPath, 'utf8').trim();
                    if (solution) break;
                }
                const val = await captchaInp.inputValue().catch(() => '');
                if (val && val.length >= 4) {
                    solution = val;
                    break;
                }
                await page.waitForTimeout(1000);
            }

            if (solution) {
                await captchaInp.fill(solution);
                await captchaInp.evaluate(e => {
                    e.dispatchEvent(new Event('input', { bubbles: true }));
                    e.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
                console.log(chalk.green(`  ✔ Entered CAPTCHA: "${solution}"`));
            } else {
                console.log(chalk.red('  ⚠️ No CAPTCHA solution received before timeout.'));
            }
        }

        // Click Submit Application
        const submitAppBtn = page.locator('button:has-text("Submit Application"), button:has-text("Submit"), button.lyteSuccess').first();
        if (await submitAppBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            if (dryRun) {
                console.log(chalk.bold.yellow('  🛡️  [SAFETY BARRIER] Zoho Recruit "Submit Application" button reached. Stopped in Dry-Run.'));
                return {
                    status: 'DRY_RUN_READY_TO_SUBMIT',
                    message: '[DRY-RUN] Zoho Recruit form completed up to final Submit step without submitting',
                    resumeUsed: selectedResume?.fileName,
                    externalUrl: page.url()
                };
            }
            console.log(chalk.yellow('  Clicking "Submit Application" button...'));
            await submitAppBtn.click();
            await page.waitForTimeout(6000);
        }
    }

    if (dryRun) {
        return {
            status: 'DRY_RUN_READY_TO_SUBMIT',
            message: '[DRY-RUN] Zoho Recruit form reached submit boundary in Dry-Run',
            resumeUsed: selectedResume?.fileName,
            externalUrl: page.url()
        };
    }

    // 11. Final Verification
    const pageText = await page.content().catch(() => '');
    const isSuccess = /application has been submitted successfully|thank you|success!|application submitted/i.test(pageText);

    // Save screenshot
    const scPath = path.resolve(__dirname, `../screenshots/external-zoho-${Date.now()}.png`);
    if (!fs.existsSync(path.dirname(scPath))) fs.mkdirSync(path.dirname(scPath), { recursive: true });
    await page.screenshot({ path: scPath, fullPage: true }).catch(() => {});
    console.log(chalk.gray(`  Screenshot saved to ${scPath}`));

    if (isSuccess) {
        console.log(chalk.green.bold('  🎉 SUCCESS: Zoho Recruit application submitted successfully!'));
        return {
            status: 'SUCCESS',
            message: 'Your application has been submitted successfully on Zoho Recruit',
            resumeUsed: selectedResume.fileName,
            externalUrl: page.url()
        };
    } else {
        console.log(chalk.red.bold('  ❌ FAILED: Application confirmation not detected on page.'));
        return {
            status: 'FAILED',
            message: 'Zoho Recruit application submission could not be confirmed',
            resumeUsed: selectedResume.fileName,
            externalUrl: page.url()
        };
    }
}

/**
 * Handles application on an external company careers portal / ATS.
 *
 * @param {import('playwright').Page} page - Active browser page on the external site
 * @param {Object} job - Target job details
 * @param {string} targetUrl - External site URL
 * @param {{ type: string, path: string, fileName: string }} selectedResume - Chosen resume
 * @returns {Promise<{ status: string, message: string, resumeUsed?: string, externalUrl?: string }>}
 */
async function handleExternalApplication(page, job, targetUrl, selectedResume, options = {}) {
    const dryRun = options.dryRun || false;
    console.log(chalk.magenta.bold(`\n--- STARTING EXTERNAL APPLICATION AUTOMATION ---`));
    console.log(chalk.cyan(`Target: ${job.role || job.title} @ ${job.company}`));
    console.log(chalk.cyan(`URL: ${targetUrl}`));
    console.log(chalk.cyan(`Using Resume: ${selectedResume.fileName} (${selectedResume.type})`));
    if (dryRun) console.log(chalk.bold.yellow('Mode: DRY-RUN (Safety Barrier Active)'));

    // Load the selected resume into Ollama context for custom question answering
    await loadResume(selectedResume.path);

    try {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await randomDelay(2000, 3000);

        // 1. Detect 404 / Page Not Found / Broken Link
        const isNotFound = await page.evaluate(() => {
            const text = document.body?.innerText?.toLowerCase() || '';
            const title = document.title?.toLowerCase() || '';
            return (text.includes('404') && (text.includes('page not found') || text.includes("doesn't exist") || text.includes('not found') || text.includes('cannot be found'))) ||
                   title.includes('404') || title.includes('page not found');
        }).catch(() => false);

        if (isNotFound) {
            console.log(chalk.red('  ❌ Destination page returned 404 / Page Not Found. Broken career URL on recruiter listing.'));
            return {
                status: 'FAILED',
                message: 'External career link returned 404 Page Not Found (broken link posted on job portal)',
                resumeUsed: selectedResume?.fileName,
                externalUrl: page.url()
            };
        }

        // 1a. Detect Login / Registration Wall (User asked to ignore/skip this case)
        if (await checkLoginWall(page)) {
            console.log(chalk.yellow('  ⚠️ External portal requires login / sign-in credentials. Skipping as requested.'));
            return { status: 'SKIPPED', message: 'External site requires login', externalUrl: page.url() };
        }

        // 1b. Detect Zoho Recruit ATS platform (e.g. Kumaran Systems)
        const isZoho = targetUrl.includes('zoho.com') || targetUrl.includes('careers.kumaran.com') || page.url().includes('zoho') ||
                       (await page.locator('[data-zcqa], lyte-dropdown, lyte-drop-button').count().catch(() => 0)) > 0;
        if (isZoho) {
            return await handleZohoRecruitApplication(page, job, selectedResume, options);
        }

        // Dismiss any cookie consent banners first
        const cookieButtons = [
            'button:has-text("Accept all")',
            'button:has-text("Accept All")',
            'button:has-text("Accept cookies")',
            'button:has-text("I Accept")',
            '#onetrust-accept-btn-handler',
            'button:has-text("Allow all")'
        ];
        for (const cSel of cookieButtons) {
            const cBtn = page.locator(cSel).first();
            if (await cBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                await cBtn.click().catch(() => {});
                await randomDelay(400, 800);
                break;
            }
        }

        // 2. Handle Landing Page -> Open Application Form
        // Some career sites display a description page first with an "Apply" button before rendering the form
        // Also detect embedded ATS iframes (e.g. Ceipal, Greenhouse, Workable)
        let targetScope = page;
        let formExists = await page.locator('input[type="file"], input[name*="name" i], input[type="email"]').first().isVisible().catch(() => false);

        if (!formExists) {
            // Check embedded frames
            for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                const frameHasForm = await frame.locator('input[type="file"], input[type="email"], a:has-text("Submit Resume"), a:has-text("Apply"), button:has-text("Apply")').first().isVisible().catch(() => false);
                if (frameHasForm) {
                    console.log(chalk.cyan(`  Targeting embedded ATS application frame: ${frame.url()}`));
                    targetScope = frame;
                    formExists = await targetScope.locator('input[type="file"], input[name*="name" i], input[type="email"]').first().isVisible().catch(() => false);
                    break;
                }
            }
        }

        if (!formExists) {
            const applyButtons = [
                'button:has-text("I\'m interested")',
                'a:has-text("I\'m interested")',
                'button:has-text("Interested")',
                'a:has-text("Interested")',
                'a:has-text("Apply for this job")',
                'button:has-text("Apply for this job")',
                'a:has-text("Apply Now")',
                'button:has-text("Apply Now")',
                'a:has-text("Submit Resume")',
                'button:has-text("Submit Resume")',
                '[data-qa="apply-button"]',
                '[class*="apply-btn"]',
                '[class*="apply-button"]',
                'button:text-is("Apply")',
                'a:text-is("Apply")'
            ];
            for (const sel of applyButtons) {
                const btn = targetScope.locator(sel).first();
                if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    console.log(chalk.blue(`  Clicking external landing page apply trigger: "${sel}"`));
                    await btn.scrollIntoViewIfNeeded().catch(() => {});
                    await btn.click({ force: true }).catch(() => {});
                    await randomDelay(2000, 3500);
                    break;
                }
            }
        }

        // Re-check for login wall after clicking apply button
        if (await checkLoginWall(page)) {
            console.log(chalk.yellow('  ⚠️ External site requires login after clicking apply. Skipping as requested.'));
            return { status: 'SKIPPED', message: 'External site requires login', externalUrl: page.url() };
        }

        // 3. Upload Resume PDF
        console.log(chalk.blue('  Attaching resume file...'));
        const fileInputs = await targetScope.locator('input[type="file"]').all();
        let resumeUploaded = false;

        if (fileInputs.length > 0) {
            // Find the input most likely to be for resume/cv
            let targetFileInput = fileInputs[0];
            for (const fi of fileInputs) {
                const html = await fi.evaluate(e => `${e.name} ${e.id} ${e.getAttribute('aria-label') || ''} ${e.className}`).catch(() => '');
                if (/resume|cv|document|attachment/i.test(html)) {
                    targetFileInput = fi;
                    break;
                }
            }

            try {
                await targetFileInput.setInputFiles(selectedResume.path);
                resumeUploaded = true;
                console.log(chalk.green.bold(`  ✔ Attached resume: "${selectedResume.fileName}"`));
                await randomDelay(1500, 2500);
            } catch (err) {
                console.log(chalk.yellow(`  ⚠️ Could not attach resume via setInputFiles: ${err.message}`));
            }
        } else {
            console.log(chalk.yellow('  ⚠️ No file input found on the page for resume upload.'));
        }

        // 4. Fill Standard Candidate Profile Fields
        console.log(chalk.blue('  Filling standard candidate information...'));
        const firstName = profile.firstName || profile.fullName.split(' ')[0];
        const lastName = profile.lastName || profile.fullName.split(' ').slice(1).join(' ');

        await fillFieldIfEmpty(targetScope, ['input[name*="first_name" i]', 'input[name*="firstname" i]', 'input[id*="first_name" i]', 'input[id*="firstname" i]', 'input[name="first" i]', 'input[id="first" i]', 'input[placeholder*="first name" i]', 'input[autocomplete="given-name"]'], firstName, 'First Name', ['First Name *', 'First Name']);
        await fillFieldIfEmpty(targetScope, ['input[name*="last_name" i]', 'input[name*="lastname" i]', 'input[id*="last_name" i]', 'input[id*="lastname" i]', 'input[name="last" i]', 'input[id="last" i]', 'input[placeholder*="last name" i]', 'input[autocomplete="family-name"]'], lastName, 'Last Name', ['Last Name *', 'Last Name']);
        await fillFieldIfEmpty(targetScope, ['input[name*="full_name" i]', 'input[name*="fullname" i]', 'input[placeholder*="full name" i]', 'input[name="name" i]', 'input[id="name" i]'], profile.fullName, 'Full Name', ['Full Name *', 'Full Name']);
        await fillFieldIfEmpty(targetScope, ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]'], profile.email, 'Email', ['Email *', 'Email Address']);
        const phoneVal = (profile.mobile || '').replace(/^\+91\s*/, '');
        await fillFieldIfEmpty(targetScope, ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="mobile" i]', 'input[id*="phone" i]', 'input[placeholder*="phone" i]'], phoneVal, 'Phone', ['Mobile *', 'Phone *', 'Mobile Number']);
        await fillFieldIfEmpty(targetScope, ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[placeholder*="linkedin" i]'], profile.linkedin || '', 'LinkedIn', ['LinkedIn Profile', 'LinkedIn URL']);
        await fillFieldIfEmpty(targetScope, ['input[name*="github" i]', 'input[id*="github" i]', 'input[placeholder*="github" i]'], profile.github || '', 'GitHub', ['GitHub Profile', 'GitHub URL']);
        await fillFieldIfEmpty(targetScope, ['input[name*="portfolio" i]', 'input[name*="website" i]', 'input[id*="website" i]', 'input[placeholder*="website" i]'], profile.github || '', 'Website/Portfolio', ['Website', 'Portfolio']);
        await fillFieldIfEmpty(targetScope, ['input[name*="city" i]', 'input[name*="location" i]', 'input[id*="location" i]', 'input[placeholder*="city" i]', 'input[placeholder*="location" i]'], profile.address?.city || profile.currentLocation || '', 'City', ['City *', 'Current Location']);
        await fillFieldIfEmpty(targetScope, ['input[name*="street" i]', 'input[placeholder*="street" i]'], profile.address?.street || '', 'Street', ['Street *', 'Address *', 'Street Address']);
        await fillFieldIfEmpty(targetScope, ['input[name*="state" i]', 'input[placeholder*="state" i]'], profile.address?.state || '', 'State', ['State *', 'State/Province *']);
        await fillFieldIfEmpty(targetScope, ['input[name*="country" i]', 'input[placeholder*="country" i]'], profile.address?.country || 'India', 'Country', ['Country *']);
        await fillFieldIfEmpty(targetScope, ['input[name*="total_exp" i]', 'input[id*="total_exp" i]'], String(profile.experience || '1'), 'Total Years Of Experience', ['Total Years Of Experience *', 'Total Experience']);
        await fillFieldIfEmpty(targetScope, ['input[name*="rel_exp" i]', 'input[id*="rel_exp" i]'], String(profile.experience || '1'), 'Relevant Years Of Experience', ['Relevant Years Of Experience *', 'Relevant Experience']);
        await fillFieldIfEmpty(targetScope, ['input[name*="company" i]', 'input[name*="organization" i]', 'input[id*="company" i]', 'input[placeholder*="company" i]'], profile.currentCompany || '', 'Current Company', ['Current Company *', 'Company Name']);
        await fillFieldIfEmpty(targetScope, ['input[name*="title" i]', 'input[name*="role" i]', 'input[id*="title" i]', 'input[placeholder*="title" i]'], profile.currentJobTitle || '', 'Job Title', ['Current Job Title *', 'Job Title']);

        // 5. Auto-check Terms / Consent / Declaration Checkboxes
        const checkboxes = await targetScope.locator('input[type="checkbox"]').all();
        for (const cb of checkboxes) {
            try {
                if (await cb.isVisible().catch(() => false)) {
                    const isChecked = await cb.isChecked().catch(() => false);
                    if (!isChecked) {
                        const parentText = await cb.evaluate(el => el.closest('label, div, p')?.innerText?.toLowerCase() || '').catch(() => '');
                        if (/agree|consent|terms|privacy|policy|certify|acknowledge|declare|authorized/i.test(parentText)) {
                            console.log(chalk.green('  ✔ Checking agreement/consent checkbox'));
                            await cb.click({ force: true }).catch(() => {});
                        }
                    }
                }
            } catch (_) {}
        }

        // 6. Handle Select Dropdowns (EEO, Work Authorization, Notice Period, etc.)
        const selects = await targetScope.locator('select').all();
        for (const sel of selects) {
            try {
                if (!(await sel.isVisible().catch(() => false))) continue;
                const currentVal = await sel.inputValue().catch(() => '');
                if (currentVal && currentVal !== '0' && currentVal !== '') continue; // already chosen

                const labelText = await sel.evaluate(el => {
                    const id = el.id;
                    const label = id ? document.querySelector(`label[for="${id}"]`) : null;
                    return (label?.innerText || el.closest('label, .form-group, .field')?.querySelector('label, span, p')?.innerText || el.name || '').trim();
                }).catch(() => '');

                const options = await sel.locator('option').all();
                const optionTexts = [];
                for (const opt of options) {
                    const t = (await opt.innerText().catch(() => '')).trim();
                    if (t && !t.toLowerCase().includes('select') && !t.toLowerCase().includes('choose')) {
                        optionTexts.push(t);
                    }
                }

                if (optionTexts.length > 0 && labelText) {
                    console.log(chalk.cyan(`  Answering dropdown: "${labelText}" (Options: ${optionTexts.slice(0, 4).join(', ')}...)`));
                    const ans = await getAnswer(labelText, optionTexts, false);
                    if (ans) {
                        const matched = matchOption(optionTexts, ans);
                        if (matched) {
                            console.log(chalk.green(`    -> Selected dropdown option: "${matched}"`));
                            await sel.selectOption({ label: matched }).catch(() => {});
                        }
                    }
                }
            } catch (_) {}
        }

        // 6b. Handle Radio Button Groups (Compliance, Work Auth, Sponsorship, EEO, etc.)
        const radioInputs = await targetScope.locator('input[type="radio"]').all();
        const handledRadioNames = new Set();

        for (const radio of radioInputs) {
            try {
                const name = await radio.getAttribute('name').catch(() => '');
                if (!name || handledRadioNames.has(name)) continue;
                handledRadioNames.add(name);

                const groupRadios = await targetScope.locator(`input[type="radio"][name="${name}"]`).all();
                if (groupRadios.length === 0) continue;

                // Check if already selected
                let alreadyChecked = false;
                for (const r of groupRadios) {
                    if (await r.isChecked().catch(() => false)) {
                        alreadyChecked = true;
                        break;
                    }
                }
                if (alreadyChecked) continue;

                // Extract the question text
                const questionText = await groupRadios[0].evaluate(el => {
                    const fieldset = el.closest('fieldset');
                    const legend = fieldset?.querySelector('legend');
                    if (legend?.innerText?.trim()) return legend.innerText.trim();

                    const container = el.closest('.field, .form-group, .application-question, [class*="question"], div');
                    const label = container?.querySelector('label, .application-label, p, h3, h4, span');
                    return (label?.innerText || '').trim();
                }).catch(() => '');

                if (!questionText || questionText.length < 3) continue;

                // Collect options
                const radioOptions = [];
                for (const r of groupRadios) {
                    const optLabel = await r.evaluate(el => {
                        const id = el.id;
                        const labelFor = id ? document.querySelector(`label[for="${id}"]`) : null;
                        if (labelFor?.innerText?.trim()) return labelFor.innerText.trim();
                        const parentLabel = el.closest('label');
                        if (parentLabel?.innerText?.trim()) return parentLabel.innerText.trim();
                        return el.value || '';
                    }).catch(() => '');
                    if (optLabel) radioOptions.push({ locator: r, text: optLabel.trim() });
                }

                if (radioOptions.length > 0) {
                    const optTexts = radioOptions.map(o => o.text);
                    console.log(chalk.cyan(`  Answering radio question: "${questionText.slice(0, 60)}" (Options: [${optTexts.join(', ')}])`));
                    const ans = await getAnswer(questionText, optTexts, false);
                    if (ans) {
                        const matched = matchOption(optTexts, ans);
                        if (matched) {
                            const targetRadio = radioOptions.find(o => o.text === matched);
                            if (targetRadio) {
                                console.log(chalk.green(`    -> Selected radio option: "${matched}"`));
                                await targetRadio.locator.scrollIntoViewIfNeeded().catch(() => {});
                                await targetRadio.locator.check({ force: true }).catch(async () => {
                                    await targetRadio.locator.evaluate(e => {
                                        e.checked = true;
                                        e.dispatchEvent(new Event('change', { bubbles: true }));
                                    });
                                });
                            }
                        }
                    }
                }
            } catch (_) {}
        }

        // 7. Handle Unfilled Textareas and Custom Inputs
        const textareas = await targetScope.locator('textarea').all();
        for (const ta of textareas) {
            try {
                if (!(await ta.isVisible().catch(() => false))) continue;
                const val = await ta.inputValue().catch(() => '');
                if (val && val.trim()) continue;

                const qText = await ta.evaluate(el => {
                    const id = el.id;
                    const label = id ? document.querySelector(`label[for="${id}"]`) : null;
                    return (label?.innerText || el.placeholder || el.name || '').trim();
                }).catch(() => '');

                if (qText) {
                    console.log(chalk.cyan(`  Answering textarea: "${qText.slice(0, 60)}..."`));
                    const ans = await getAnswer(qText, [], false);
                    if (ans) {
                        await ta.fill(ans);
                        console.log(chalk.green(`    -> Filled textarea answer`));
                    }
                }
            } catch (_) {}
        }

        await randomDelay(1500, 2500);

        // 8. Submit Application (or Advance to Next Step)
        console.log(chalk.blue('  Locating application submit/next button...'));
        const submitSelectors = [
            'button:has-text("Submit Application")',
            'button:has-text("Submit application")',
            'button:has-text("Submit")',
            'button:has-text("Next")',
            'input[value="Next"]',
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Apply")',
            '[data-qa="btn-submit"]',
            '[class*="submit-btn"]'
        ];

        let submitted = false;
        for (const sel of submitSelectors) {
            const btn = targetScope.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                const btnText = ((await btn.innerText().catch(() => '')) || sel).trim();
                const isFinalSubmit = /submit|apply/i.test(btnText) && !/save|next|continue/i.test(btnText);

                if (dryRun && isFinalSubmit) {
                    console.log(chalk.bold.yellow(`  🛡️  [SAFETY BARRIER] External form final "${btnText}" button reached. Stopped in Dry-Run.`));
                    return {
                        status: 'DRY_RUN_READY_TO_SUBMIT',
                        message: `[DRY-RUN] External form filled up to final "${btnText}" step without submitting`,
                        resumeUsed: selectedResume?.fileName,
                        externalUrl: page.url()
                    };
                }

                console.log(chalk.yellow(`  Clicking submit/next button: "${sel}"...`));
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ force: true });
                submitted = true;
                break;
            }
        }

        if (!submitted) {
            console.log(chalk.yellow('  ⚠️ No explicit submit button found.'));
        }

        // 9. Verification
        await randomDelay(4000, 6000);
        const finalUrl = page.url();
        const pageContent = await page.content().catch(() => '');

        const isSuccess = /thank you|application received|successfully submitted|application submitted|your application has been sent/i.test(pageContent) ||
                          /thanks|success|confirmation|submitted/i.test(finalUrl);

        // Detect if active validation errors remain on the form
        const validationError = await page.evaluate(() => {
            const errorEls = document.querySelectorAll('.error, .error-message, [class*="error-message"], [class*="errorMessage"], [aria-invalid="true"], .invalid-feedback, .field-error');
            for (const el of errorEls) {
                if (el.offsetParent !== null && el.innerText.trim()) return el.innerText.trim();
            }
            return null;
        }).catch(() => null);

        // Save verification screenshot
        const screenshotPath = path.resolve(__dirname, `../screenshots/external-${Date.now()}.png`);
        if (!fs.existsSync(path.dirname(screenshotPath))) {
            fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        }
        await page.screenshot({ path: screenshotPath }).catch(() => {});
        console.log(chalk.gray(`  Screenshot saved to ${screenshotPath}`));

        if (isSuccess) {
            console.log(chalk.green.bold('  🎉 SUCCESS: External application submitted successfully!'));
            return {
                status: 'SUCCESS',
                message: 'Submitted on company career site',
                resumeUsed: selectedResume.fileName,
                externalUrl: finalUrl
            };
        } else if (validationError) {
            console.log(chalk.red(`  ⚠️ Form submission blocked by validation error: "${validationError}"`));
            return {
                status: 'FAILED',
                message: `External form validation error: ${validationError}`,
                resumeUsed: selectedResume.fileName,
                externalUrl: finalUrl
            };
        } else if (!submitted && !resumeUploaded) {
            console.log(chalk.red(`  ❌ No application form or submission action found on external page: ${finalUrl}`));
            return {
                status: 'FAILED',
                message: 'External page did not contain an application form or submit action',
                resumeUsed: selectedResume.fileName,
                externalUrl: finalUrl
            };
        } else {
            if (dryRun) {
                return {
                    status: 'DRY_RUN_READY_TO_SUBMIT',
                    message: '[DRY-RUN] External application filled up to submit boundary',
                    resumeUsed: selectedResume.fileName,
                    externalUrl: finalUrl
                };
            }
            console.log(chalk.cyan(`  Form submitted. Current URL: ${finalUrl}`));
            return {
                status: 'SUCCESS',
                message: 'External application filled and submitted',
                resumeUsed: selectedResume.fileName,
                externalUrl: finalUrl
            };
        }

    } catch (err) {
        console.error(chalk.red(`  ❌ External application error: ${err.message}`));
        return {
            status: 'FAILED',
            message: `External application error: ${err.message}`,
            resumeUsed: selectedResume?.fileName,
            externalUrl: page.url()
        };
    }
}

module.exports = { handleExternalApplication };
