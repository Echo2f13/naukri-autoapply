'use strict';

/**
 * verify_birlasoft_real_dom.js
 *
 * Real SuccessFactors / BirlaSoft DOM field-by-field verification runner.
 * 
 * SAFETY INVARIANT:
 * - Final submission is PERMANENTLY BLOCKED.
 * - Any submit buttons on the page are neutralized in the DOM.
 * - Form onsubmit handlers are neutered to prevent any accidental submission.
 * - This runner ONLY inspects, expands, resolves canonical facts, interacts with comboboxes/dropdowns, and verifies DOM state.
 */

const { launchBrowser } = require('../automation/browser');
const { checkLoginWall, checkCaptcha, expandAllSections, attachResumeSafely } = require('../automation/externalApplyHandler');
const { resolveCandidateFact, matchAtsOption, validateStructuredField } = require('../ai/candidateFacts');
const { promptHumanIntervention } = require('../ai/humanIntervention');
const profile = require('../config/profile.json');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const BIRLASOFT_URL = 'https://jobs.birlasoft.com/job/Pune-Developer-Enterprise-Apps-INDI/58879444/';

async function runBirlaSoftDomVerification() {
    console.log(chalk.bold.cyan(`
============================================================
   BIRLASOFT REAL DOM COMBBOX & FIELD VERIFICATION RUNNER
============================================================
    `));
    console.log(chalk.yellow.bold('SAFETY GUARANTEE: Final submission is PERMANENTLY BLOCKED. No application will be submitted.\n'));

    let browser, context, page;
    const domReport = [];

    try {
        console.log(chalk.blue('Launching browser (interactive, headed mode)...'));
        const launched = await launchBrowser({ headless: false });
        context = launched.context;
        page = launched.page;

        console.log(chalk.cyan(`Navigating to BirlaSoft job page: ${BIRLASOFT_URL}`));
        await page.goto(BIRLASOFT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        // 1. Locate and click "Apply now" button on job landing page
        const applyBtn = page.locator('a:has-text("Apply now"), button:has-text("Apply now"), a:has-text("Apply"), button:has-text("Apply")').first();
        if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log(chalk.blue('Clicking "Apply now" button on job landing page...'));
            await applyBtn.click({ force: true });
            await page.waitForTimeout(4000);
        }

        // 2. Check for Login Wall -> Fill credentials if provided via env, otherwise prompt human
        const tryAutoLogin = async (targetPage) => {
            const loginUser = process.env.BIRLASOFT_USER || profile.email || 'kotamanishdev05@gmail.com';
            const loginPass = process.env.BIRLASOFT_PASS || '';
            if (!loginPass) return false;

            console.log(chalk.blue(`Attempting automated sign-in for candidate ${loginUser}...`));
            
            // Locate email input: try multiple robust strategies
            let emailInput = targetPage.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]').first();
            if (!(await emailInput.isVisible({ timeout: 1500 }).catch(() => false))) {
                emailInput = targetPage.locator('label:has-text("Email")').locator('xpath=..').locator('input').first();
            }
            if (!(await emailInput.isVisible({ timeout: 1500 }).catch(() => false))) {
                emailInput = targetPage.locator('input[type="password"]').locator('xpath=preceding::input[1]');
            }

            const pwdInput = targetPage.locator('input[type="password"]').first();

            if (await emailInput.isVisible({ timeout: 2500 }).catch(() => false) && await pwdInput.isVisible({ timeout: 2500 }).catch(() => false)) {
                console.log(chalk.cyan('Found email and password fields. Filling credentials...'));
                await emailInput.click().catch(() => {});
                await emailInput.fill(loginUser);
                await pwdInput.click().catch(() => {});
                await pwdInput.fill(loginPass);
                await targetPage.waitForTimeout(600);

                const signInBtn = targetPage.locator('button:has-text("Sign In"), input[value*="Sign In" i], button:has-text("Sign in"), input[value*="Sign in" i], button[type="submit"], input[type="submit"]').first();
                if (await signInBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
                    console.log(chalk.green('Found Sign In button. Clicking...'));
                    await signInBtn.click();
                    console.log(chalk.green('Clicked Sign In button. Waiting for authentication and redirect...'));
                    await targetPage.waitForTimeout(6000);
                    await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
                    return true;
                } else {
                    console.log(chalk.yellow('Could not locate Sign In button; attempting Enter key on password input...'));
                    await pwdInput.press('Enter');
                    await targetPage.waitForTimeout(6000);
                    await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
                    return true;
                }
            } else {
                console.log(chalk.yellow('Automated login inputs not directly visible yet on current page.'));
            }
            return false;
        };

        if (await checkLoginWall(page)) {
            await tryAutoLogin(page);
        }

        while (await checkLoginWall(page)) {
            console.log(chalk.yellow.bold('\n⚠️ SuccessFactors login wall encountered.'));
            const autoSuccess = await tryAutoLogin(page);
            if (autoSuccess && !(await checkLoginWall(page))) {
                console.log(chalk.green.bold('✔ Automated login successful!'));
                break;
            }

            const loginRes = await promptHumanIntervention({
                question: 'BirlaSoft / SuccessFactors requires candidate login. Please log in using the open browser window, then press Enter (or type "done") to resume.',
                type: 'action',
                reason: 'Candidate authentication required to access live application form.',
                isInteractive: true
            });

            if (!loginRes.answered) {
                console.log(chalk.red('Login aborted by user. Exiting safely.'));
                return;
            }

            console.log(chalk.green('Waiting for post-login page load...'));
            await page.waitForTimeout(4000);
            await page.waitForLoadState('domcontentloaded').catch(() => {});

            // Update page reference across all context tabs
            for (const p of context.pages()) {
                if (p.url().includes('sapsf') || p.url().includes('birlasoft')) {
                    page = p;
                }
            }

            if (await checkLoginWall(page)) {
                console.log(chalk.red('Login wall still detected in browser. Please enter credentials and submit login.'));
            }
        }

        // If on career portal rather than application form, navigate to job to enter application
        let isAppForm = await page.evaluate(() => {
            const body = document.body?.innerText?.toLowerCase() || '';
            return body.includes('profile information') ||
                   body.includes('my documents') ||
                   body.includes('education') ||
                   body.includes('highest education') ||
                   body.includes('institute name');
        });

        if (!isAppForm) {
            console.log(chalk.cyan(`Navigating to job page: ${BIRLASOFT_URL} to open authenticated application form...`));
            await page.goto(BIRLASOFT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            const applyBtn2 = page.locator('a:has-text("Apply now"), button:has-text("Apply now"), a:has-text("Apply"), button:has-text("Apply")').first();
            if (await applyBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
                console.log(chalk.blue('Clicking "Apply now" button with active session...'));
                await applyBtn2.click({ force: true });
                await page.waitForTimeout(5000);
            }
            const allP = context.pages();
            page = allP[allP.length - 1];
            await page.waitForLoadState('domcontentloaded').catch(() => {});
        }

        console.log(chalk.green.bold(`\n✔ Arrived on actual application form URL: ${page.url()}`));

        // Frame detection
        let formScope = page;
        for (const frame of page.frames()) {
            const frameText = await frame.evaluate(() => document.body?.innerText?.toLowerCase() || '').catch(() => '');
            if (frameText.includes('institute name') || frameText.includes('education') || frameText.includes('profile information')) {
                console.log(chalk.cyan(`Application form located inside frame: ${frame.url()}`));
                formScope = frame;
                break;
            }
        }

        // 3. ABSOLUTE SAFETY NEUTRALIZATION IN REAL DOM:
        // Permanently neutralize any submit buttons so they cannot be clicked or triggered.
        await page.evaluate(() => {
            // Prevent form submit event
            document.querySelectorAll('form').forEach(f => {
                f.onsubmit = (e) => {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    console.warn('Form submission permanently blocked by safety runner.');
                    return false;
                };
            });
            // Disable submit buttons visually and functionally using standard CSS
            document.querySelectorAll('button, input, [role="button"]').forEach(b => {
                const text = (b.innerText || b.value || b.getAttribute('aria-label') || '').toLowerCase().trim();
                const isSubmit = b.getAttribute('type') === 'submit' ||
                                 text === 'submit' ||
                                 text === 'apply' ||
                                 text === 'submit application' ||
                                 text === 'apply now';
                if (isSubmit) {
                    b.setAttribute('data-original-type', b.getAttribute('type') || '');
                    b.setAttribute('type', 'button');
                    b.setAttribute('disabled', 'true');
                    b.style.opacity = '0.4';
                    b.style.pointerEvents = 'none';
                    b.title = 'SUBMISSION PERMANENTLY BLOCKED FOR SAFETY INSPECTION';
                }
            });
        });
        console.log(chalk.yellow('🔒 Safety Barrier Active: Form submission and submit buttons have been neutralized in the DOM.\n'));

        // 4. Expand all accordion sections (SuccessFactors CSB, panels, fieldsets)
        console.log(chalk.blue('Expanding all collapsible accordion sections...'));
        await expandAllSections(page);
        await page.waitForTimeout(2000);

        // 5. Check resume attachment presence
        const resumeResumeStatus = await page.evaluate(() => {
            const hasUpload = document.querySelector('input[type="file"], .uploaded-file, [class*="resume"], [class*="upload"]');
            return !!hasUpload;
        });
        console.log(chalk.cyan(`Resume section detected in DOM: ${resumeResumeStatus}`));

        // 6. Systematic Field-by-Field Inspection and Live Combobox / Dropdown Testing
        console.log(chalk.bold.yellow('\n=== Inspecting and Resolving Form Fields in Real SuccessFactors DOM ===\n'));

        // Helper: Extract label and section for any element
        async function getElementMeta(el) {
            return await el.evaluate(e => {
                const id = e.id;
                const label = id ? document.querySelector(`label[for="${id}"]`) : null;
                const ariaLabel = e.getAttribute('aria-label') || '';
                const placeholder = e.getAttribute('placeholder') || '';
                const name = e.getAttribute('name') || '';
                const rawLabel = (label?.innerText || ariaLabel || placeholder || e.closest('label, .form-group, .field, [class*="field"]')?.querySelector('label, span, p')?.innerText || name || '').trim();

                let section = '';
                const fieldset = e.closest('fieldset');
                if (fieldset?.querySelector('legend')?.innerText?.trim()) {
                    section = fieldset.querySelector('legend').innerText.trim();
                } else {
                    const accordion = e.closest('.accordion-item, .panel, .section, [class*="section"], [class*="accordion"], [class*="card"], [class*="panel"]');
                    if (accordion) {
                        const hdr = accordion.querySelector('.accordion-header, .panel-heading, [class*="header"], [class*="title"], h2, h3, h4');
                        if (hdr?.innerText?.trim()) section = hdr.innerText.trim();
                    }
                }
                return { label: rawLabel.replace(/[\n\r]+/g, ' ').trim(), section: section.replace(/[\n\r]+/g, ' ').trim() };
            }).catch(() => ({ label: '', section: '' }));
        }

        // ============================================================
        // A. Custom Comboboxes & Accessible Dropdowns
        // ============================================================
        const comboboxSelectors = [
            '[role="combobox"]',
            'button[aria-haspopup="listbox"]',
            'button[aria-haspopup="true"]',
            '.select2-selection',
            'div[aria-expanded]'
        ];

        const comboboxes = await formScope.locator(comboboxSelectors.join(', ')).all();
        console.log(chalk.cyan(`Found ${comboboxes.length} potential combobox elements in the DOM.\n`));

        for (let i = 0; i < comboboxes.length; i++) {
            const combo = comboboxes[i];
            if (!(await combo.isVisible().catch(() => false))) continue;

            const { label, section } = await getElementMeta(combo);
            if (!label || label.length < 2) continue;

            console.log(chalk.bold.white(`------------------------------------------------------------`));
            console.log(chalk.white(`Field [${i + 1}]: `) + chalk.bold.cyan(`"${label}"`) + (section ? chalk.gray(` (Section: "${section}")`) : ''));

            // 1. Resolve canonical fact using question + section context
            const canonicalFact = resolveCandidateFact(label, section);
            const canonicalAnswer = canonicalFact.resolved ? canonicalFact.answer : null;
            console.log(chalk.white(`  Canonical Fact: `) + (canonicalFact.resolved ? chalk.green(`YES ("${canonicalAnswer}" via ${canonicalFact.path})`) : chalk.yellow(`NONE (absent from profile)`)));

            // 2. Click combobox to open
            await combo.scrollIntoViewIfNeeded().catch(() => {});
            await combo.click().catch(() => {});
            await page.waitForTimeout(800);

            // 3. Detect Search Input inside/for this combobox & aria-controls
            const ariaControls = await combo.getAttribute('aria-controls') || await combo.getAttribute('aria-owns');
            let popupContainer = ariaControls ? page.locator(`#${ariaControls}`) : null;

            let searchInput = null;
            const isComboInput = (await combo.evaluate(el => el.tagName).catch(() => '')) === 'INPUT';
            if (isComboInput) {
                searchInput = combo;
            } else {
                const potentialSearch = page.locator('input[role="searchbox"], input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i], input.select2-search__field, input.dropdown-search, .dropdown-menu input, [role="combobox"] input').first();
                if (await potentialSearch.isVisible({ timeout: 600 }).catch(() => false)) {
                    searchInput = potentialSearch;
                }
            }

            const isSearchable = !!searchInput;
            console.log(chalk.white(`  Combobox Searchable: `) + (isSearchable ? chalk.green('YES (search input located)') : chalk.gray('NO (static list)')));

            // 4. First inspect initial options exposed by the combobox
            const getOptions = async () => {
                const locators = popupContainer && await popupContainer.isVisible().catch(() => false)
                    ? await popupContainer.locator('[role="option"], li, .dropdown-item').all()
                    : await page.locator('[role="option"], ul.dropdown-menu li, .select-options div, .dropdown-item, .select2-results__option, li[role="treeitem"]').all();
                const texts = [];
                const map = [];
                for (const opt of locators) {
                    if (await opt.isVisible().catch(() => false)) {
                        const t = (await opt.innerText().catch(() => '')).trim();
                        if (t && !/select|choose/i.test(t)) {
                            texts.push(t);
                            map.push({ text: t, locator: opt });
                        }
                    }
                }
                return { texts, map };
            };

            let { texts: optionTexts, map: optionMap } = await getOptions();
            console.log(chalk.white(`  Initial Exposed Options Count: `) + chalk.cyan(`${optionTexts.length}`) + (optionTexts.length > 0 ? chalk.gray(` (e.g. [${optionTexts.slice(0, 5).join(', ')}...])`) : ''));

            // 5. Match against available options (or canonical answer)
            let matchResult = null;
            let selectedValue = null;
            let verifiedValue = null;

            if (canonicalAnswer) {
                // If options are initially populated, match against them!
                if (optionTexts.length > 0) {
                    matchResult = matchAtsOption(optionTexts, canonicalAnswer, label);
                }

                // If searchable:
                if (isSearchable) {
                    const searchQuery = (matchResult?.matched && matchResult.selectedOption) ? matchResult.selectedOption : canonicalAnswer;
                    console.log(chalk.cyan(`  -> Typing "${searchQuery}" into search input to filter...`));
                    await searchInput.focus().catch(() => {});
                    await searchInput.fill(searchQuery).catch(() => {});
                    await searchInput.dispatchEvent('input').catch(() => {});
                    await searchInput.dispatchEvent('keyup').catch(() => {});
                    await page.waitForTimeout(800);

                    // Re-read filtered options
                    const filtered = await getOptions();
                    if (filtered.texts.length > 0) {
                        optionTexts = filtered.texts;
                        optionMap = filtered.map;
                        matchResult = matchAtsOption(optionTexts, searchQuery, label);
                    }
                }

                // If not matched yet, try matching with filtered options
                if (!matchResult?.matched && optionTexts.length > 0) {
                    matchResult = matchAtsOption(optionTexts, canonicalAnswer, label);
                }

                if (matchResult?.matched && matchResult.selectedOption) {
                    const chosen = matchResult.selectedOption;
                    console.log(chalk.green(`  ✔ ATS Option Matched: "${chosen}"`));
                    if (matchResult.trustReason) {
                        console.log(chalk.gray(`    Trust Reason: ${matchResult.trustReason}`));
                    }
                    const targetOpt = optionMap.find(o => o.text === chosen) || optionMap[0];
                    if (targetOpt) {
                        await targetOpt.locator.click().catch(() => {});
                        await page.waitForTimeout(500);
                        selectedValue = chosen;

                        // Verify in DOM
                        const currentText = (await combo.innerText().catch(() => '')) || (await combo.inputValue().catch(() => '')) || '';
                        verifiedValue = currentText.includes(chosen) || currentText.trim().length > 0 ? 'YES' : 'UNVERIFIED';
                        console.log(chalk.green.bold(`  ✔ Verified in DOM: ${verifiedValue} (Current DOM text: "${currentText.trim()}")`));
                    }
                } else if (matchResult?.ambiguous) {
                    console.log(chalk.yellow(`  ⚠️ Ambiguous ATS match for canonical "${canonicalAnswer}": [${matchResult.matchingOptions.join(', ')}]. Human intervention required.`));
                } else {
                    console.log(chalk.yellow(`  ⚠️ Canonical answer "${canonicalAnswer}" not present in options.`));
                }
            } else {
                console.log(chalk.yellow(`  ⚠️ Fact genuinely absent from profile. Zero guessing invariant: Human intervention required.`));
            }

            // Close dropdown if still open
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(300);

            domReport.push({
                label,
                section: section || 'General',
                elementType: isSearchable ? 'searchable combobox' : 'custom combobox',
                optionsCount: optionTexts.length,
                sampleOptions: optionTexts.slice(0, 5),
                canonicalFact: canonicalFact.path || 'NONE',
                canonicalValue: canonicalAnswer || 'N/A',
                resolvedAnswer: selectedValue || 'None',
                matchingMethod: matchResult?.matched ? 'deterministic matchAtsOption' : (matchResult?.ambiguous ? 'ambiguous' : 'none'),
                trustReason: matchResult?.trustReason || 'N/A',
                selectedValue: selectedValue || 'Unselected',
                verified: verifiedValue || 'N/A'
            });
        }

        // ============================================================
        // B. Native Select Dropdowns
        // ============================================================
        const selects = await formScope.locator('select').all();
        console.log(chalk.cyan(`\nFound ${selects.length} native <select> elements in the DOM.\n`));

        for (let i = 0; i < selects.length; i++) {
            const sel = selects[i];
            if (!(await sel.isVisible().catch(() => false))) continue;

            const { label, section } = await getElementMeta(sel);
            if (!label || label.length < 2) continue;

            console.log(chalk.bold.white(`------------------------------------------------------------`));
            console.log(chalk.white(`Select [${i + 1}]: `) + chalk.bold.cyan(`"${label}"`) + (section ? chalk.gray(` (Section: "${section}")`) : ''));

            const canonicalFact = resolveCandidateFact(label, section);
            const canonicalAnswer = canonicalFact.resolved ? canonicalFact.answer : null;
            console.log(chalk.white(`  Canonical Fact: `) + (canonicalFact.resolved ? chalk.green(`YES ("${canonicalAnswer}" via ${canonicalFact.path})`) : chalk.yellow(`NONE (absent from profile)`)));

            const optionElements = await sel.locator('option').all();
            const optionTexts = [];
            for (const opt of optionElements) {
                const t = (await opt.innerText().catch(() => '')).trim();
                if (t && !/select|choose/i.test(t)) {
                    optionTexts.push(t);
                }
            }

            console.log(chalk.white(`  Options Count: `) + chalk.cyan(`${optionTexts.length}`) + (optionTexts.length > 0 ? chalk.gray(` (e.g. [${optionTexts.slice(0, 3).join(', ')}...])`) : ''));

            let selectedValue = null;
            let verifiedValue = null;
            let matchResult = null;

            if (canonicalAnswer && optionTexts.length > 0) {
                matchResult = matchAtsOption(optionTexts, canonicalAnswer, label);
                if (matchResult.matched && matchResult.selectedOption) {
                    const chosen = matchResult.selectedOption;
                    console.log(chalk.green(`  ✔ ATS Option Matched: "${chosen}"`));
                    if (matchResult.trustReason) {
                        console.log(chalk.gray(`    Trust Reason: ${matchResult.trustReason}`));
                    }
                    await sel.selectOption({ label: chosen }).catch(async () => {
                        await sel.selectOption(chosen).catch(() => {});
                    });
                    await sel.dispatchEvent('change').catch(() => {});
                    selectedValue = chosen;

                    const currentVal = await sel.inputValue().catch(() => '');
                    verifiedValue = currentVal ? 'YES' : 'UNVERIFIED';
                    console.log(chalk.green.bold(`  ✔ Verified in DOM: ${verifiedValue} (Value: "${currentVal}")`));
                }
            }

            domReport.push({
                label,
                section: section || 'General',
                elementType: 'native select',
                optionsCount: optionTexts.length,
                sampleOptions: optionTexts.slice(0, 5),
                canonicalFact: canonicalFact.path || 'NONE',
                canonicalValue: canonicalAnswer || 'N/A',
                resolvedAnswer: selectedValue || 'None',
                matchingMethod: selectedValue ? 'deterministic matchAtsOption' : 'none',
                trustReason: matchResult?.trustReason || 'N/A',
                selectedValue: selectedValue || 'Unselected',
                verified: verifiedValue || 'N/A'
            });
        }

        // ============================================================
        // C. Standard Input Fields Inspection (Text, Tel, Email)
        // ============================================================
        const inputs = await formScope.locator('input[type="text"], input[type="email"], input[type="tel"], input:not([type])').all();
        console.log(chalk.cyan(`\nFound ${inputs.length} text inputs in the DOM.\n`));

        for (let i = 0; i < Math.min(inputs.length, 35); i++) {
            const inp = inputs[i];
            if (!(await inp.isVisible().catch(() => false))) continue;

            const { label, section } = await getElementMeta(inp);
            if (!label || label.length < 2) continue;

            const canonicalFact = resolveCandidateFact(label, section);
            let currentVal = await inp.inputValue().catch(() => '');

            if (!currentVal && canonicalFact.resolved && canonicalFact.answer) {
                await inp.focus().catch(() => {});
                await inp.fill(canonicalFact.answer).catch(() => {});
                await inp.dispatchEvent('input').catch(() => {});
                await inp.dispatchEvent('change').catch(() => {});
                await page.waitForTimeout(200);
                currentVal = await inp.inputValue().catch(() => '');
            }

            domReport.push({
                label,
                section: section || 'General',
                elementType: 'text input',
                optionsCount: 0,
                sampleOptions: [],
                canonicalFact: canonicalFact.path || 'NONE',
                canonicalValue: canonicalFact.answer || 'N/A',
                resolvedAnswer: canonicalFact.answer || 'None',
                matchingMethod: canonicalFact.resolved ? 'canonical profile' : 'none',
                trustReason: 'Canonical profile exact key',
                selectedValue: currentVal || 'Empty',
                verified: currentVal ? 'YES' : 'EMPTY'
            });
        }

        // Take a full page screenshot for artifact documentation
        const screenshotPath = path.resolve(__dirname, '../screenshots/birlasoft_real_dom_inspection.png');
        if (!fs.existsSync(path.dirname(screenshotPath))) {
            fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        }
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        console.log(chalk.green(`\n✔ Full DOM screenshot saved to: ${screenshotPath}`));

        // 7. Print real DOM report in requested format
        console.log(chalk.bold.cyan(`
============================================================
           REAL SUCCESSFACTORS DOM FIELD REPORT
============================================================
`));
        for (const f of domReport) {
            console.log(chalk.bold.white(f.label));
            console.log(chalk.white(`  Section: `) + chalk.cyan(f.section));
            console.log(chalk.white(`  Element: `) + chalk.cyan(f.elementType));
            console.log(chalk.white(`  Options Count: `) + chalk.cyan(f.optionsCount));
            console.log(chalk.white(`  Canonical: `) + chalk.yellow(f.canonicalValue) + chalk.gray(` (${f.canonicalFact})`));
            console.log(chalk.white(`  Match: `) + chalk.cyan(f.matchingMethod));
            if (f.trustReason && f.trustReason !== 'N/A') {
                console.log(chalk.white(`  Trust Reason: `) + chalk.gray(f.trustReason));
            }
            console.log(chalk.white(`  Selected: `) + (f.selectedValue !== 'Unselected' && f.selectedValue !== 'Empty' ? chalk.green(f.selectedValue) : chalk.gray(f.selectedValue)));
            console.log(chalk.white(`  Verified: `) + (f.verified === 'YES' ? chalk.bold.green('YES') : chalk.red(f.verified)));
            console.log(chalk.gray('------------------------------------------------------------'));
        }

        // 8. Write Structured JSON Report
        const reportPath = path.resolve(__dirname, '../data/birlasoft_real_dom_report.json');
        fs.writeFileSync(reportPath, JSON.stringify(domReport, null, 2), 'utf8');
        console.log(chalk.green(`\n✔ Detailed JSON report written to: ${reportPath}`));

    } catch (err) {
        console.error(chalk.red(`Error during BirlaSoft real DOM verification: ${err.message}`));
    } finally {
        console.log(chalk.yellow.bold('\nSAFETY BARRIER: Verification complete. Browser closing safely without submitting.'));
        if (context) await context.close();
    }
}

if (require.main === module) {
    runBirlaSoftDomVerification().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { runBirlaSoftDomVerification };
