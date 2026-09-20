'use strict';

require('dotenv').config();
const chalk = require('chalk');
const { launchBrowser } = require('./automation/browser');
const { ensureLogin } = require('./automation/login');
const { ensureLinkedInLogin } = require('./sources/linkedin/auth');
const { ensureWellfoundLogin } = require('./sources/wellfound/auth');
const { ensureWhatsAppLogin } = require('./sources/whatsapp/auth');
const settings = require('./config/settings');
const { checkOllama } = require('./ai/ollama');
const { DiscoveryCoordinator } = require('./discovery/coordinator');
const { ApplicationCoordinator } = require('./application/coordinator');

/**
 * Universal Master Controller.
 * Runs multi-source autonomous job discovery, deduplication, eligibility scoring,
 * and ATS application execution.
 * 
 * @param {Object} options
 * @param {string[]|string} [options.sources=['NAUKRI']] - Sources: 'NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP'
 * @param {string} [options.mode='both'] - For Naukri: 'recommended', 'search', 'both'
 * @param {number} [options.maxApply]
 * @param {number} [options.minScore=50]
 * @param {number} [options.whatsappDays=2]
 * @param {boolean} [options.dryRun=true]
 * @param {boolean} [options.live=false]
 * @param {boolean} [options.verbose=false]
 * @param {boolean} [options.headless=false]
 */
async function runAutonomousAutoApply(options = {}) {
    const { validateProfileSetup } = require('./config/profileLoader');
    if (!validateProfileSetup()) {
        process.exit(1);
    }

    // Normalize sources option
    let sources = ['NAUKRI'];
    if (options.sources) {
        if (Array.isArray(options.sources)) {
            sources = options.sources.map(s => String(s).trim().toUpperCase()).filter(Boolean);
        } else if (typeof options.sources === 'string') {
            const raw = options.sources.trim().toLowerCase();
            if (raw === 'all') {
                sources = ['NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP'];
            } else {
                sources = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            }
        }
    } else if (options.source) {
        const raw = String(options.source).trim().toLowerCase();
        if (raw === 'all') {
            sources = ['NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP'];
        } else {
            sources = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        }
    } else if (process.env.AUTOAPPLY_SOURCES) {
        sources = process.env.AUTOAPPLY_SOURCES.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    }

    const mode = options.mode || process.env.NAUKRI_MODE || 'both';
    const whatsappDays = options.whatsappDays !== undefined ? Number(options.whatsappDays) : 2;
    const verbose = !!options.verbose;

    // Enforce safety invariant: default is ALWAYS dryRun = true
    let dryRun = true;
    if (options.live === true) {
        dryRun = false;
    } else if (options.dryRun !== undefined) {
        dryRun = !!options.dryRun;
    } else if (process.env.AUTOAPPLY_MODE === 'live' || process.env.LIVE === 'true') {
        dryRun = false;
    } else {
        dryRun = true; // Default fallback is DRY-RUN
    }

    // Maximum application limit:
    // Dry-run: process all eligible jobs unless explicitly limited (--max=N)
    // Live: conservative safety default of 1, capped at 5
    let rawMax = options.maxApply !== undefined
        ? options.maxApply
        : (process.env.MAX_APPLY ? parseInt(process.env.MAX_APPLY, 10) : undefined);

    let maxApply;
    if (rawMax !== undefined && !isNaN(rawMax)) {
        maxApply = rawMax <= 0 ? 0 : rawMax;
    } else {
        maxApply = dryRun ? Infinity : 1;
    }

    if (!dryRun && maxApply > 5 && !options.overrideLiveLimit) {
        console.log(chalk.yellow(`⚠️  Live mode safety limit active: Capping batch at 5 applications (requested: ${maxApply}).`));
        maxApply = 5;
    }
    const minScore = options.minScore !== undefined ? options.minScore : 50;

    console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════════════╗
║        ENTERPRISE MULTI-SOURCE AUTONOMOUS JOB PLATFORM           ║
║       Naukri  •  LinkedIn  •  Wellfound  •  WhatsApp Channels    ║
╚══════════════════════════════════════════════════════════════════╝
`));

    console.log(chalk.yellow(`⚙️  Active Configuration:`));
    console.log(chalk.gray(`   Sources          : ${sources.join(', ')}`));
    console.log(chalk.gray(`   Execution Mode   : ${dryRun ? chalk.bold.green('DRY-RUN (Safe - Full Queue Evaluation)') : chalk.bold.red('LIVE (Supervised Human Gate Active)')}`));
    console.log(chalk.gray(`   Application Limit: ${maxApply === Infinity ? 'All Discovered Eligible (Infinity)' : maxApply}`));
    console.log(chalk.gray(`   Score Threshold  : ${minScore} / 100`));
    if (sources.includes('WHATSAPP')) {
        console.log(chalk.gray(`   WhatsApp Lookback: ${whatsappDays} day(s)`));
    }
    if (verbose) {
        console.log(chalk.gray(`   Verbose Logging  : Enabled`));
    }
    console.log('');

    // Check AI Engine
    const ollamaOk = await checkOllama();
    if (!ollamaOk) {
        console.log(chalk.yellow('⚠️  Ollama is offline or unreachable. Will rely on verified profile and rule fallbacks.'));
    }

    // Launch Browser
    console.log(chalk.blue('🌐 Launching automation browser...'));
    const { browser, context, page } = await launchBrowser({ headless: options.headless });

    try {
        // Selective page allocation: Allocate tabs ONLY for requested sources
        let firstUsed = false;
        const pages = {
            naukri: null,
            linkedin: null,
            wellfound: null,
            whatsapp: null
        };

        for (const s of sources) {
            const key = s.toLowerCase();
            if (['naukri', 'linkedin', 'wellfound', 'whatsapp'].includes(key)) {
                if (!firstUsed) {
                    pages[key] = page;
                    firstUsed = true;
                } else {
                    pages[key] = await context.newPage();
                }
            }
        }

        // Selective Authentication: ONLY authenticate requested platforms
        if (sources.includes('NAUKRI') && pages.naukri) {
            console.log(chalk.blue('🔐 [Auth] Verifying Naukri authentication...'));
            try {
                const loggedIn = await ensureLogin(pages.naukri);
                if (!loggedIn) {
                    console.log(chalk.red('  ❌ Naukri login failed. Continuing with remaining sources...'));
                }
            } catch (err) {
                console.warn(chalk.yellow(`  ⚠️ Naukri auth error: ${err.message}. Continuing with other sources.`));
            }
        }

        if (sources.includes('LINKEDIN') && pages.linkedin) {
            console.log(chalk.blue('🔐 [Auth] Verifying LinkedIn authentication...'));
            try {
                const linkedInAuth = await ensureLinkedInLogin(pages.linkedin);
                if (!linkedInAuth.authenticated) {
                    console.log(chalk.yellow(`  ⚠️ LinkedIn session not authenticated (${linkedInAuth.status}). Pipeline will operate safely.`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`  ⚠️ LinkedIn auth error: ${err.message}. Continuing with other sources.`));
            }
        }

        if (sources.includes('WELLFOUND') && pages.wellfound) {
            console.log(chalk.blue('🔐 [Auth] Verifying Wellfound authentication...'));
            try {
                const wellfoundAuth = await ensureWellfoundLogin(pages.wellfound);
                if (!wellfoundAuth.authenticated) {
                    console.log(chalk.yellow(`  ⚠️ Wellfound session not authenticated (${wellfoundAuth.status}). Pipeline will operate safely.`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`  ⚠️ Wellfound auth error: ${err.message}. Continuing with other sources.`));
            }
        }

        if (sources.includes('WHATSAPP') && pages.whatsapp) {
            console.log(chalk.blue('🔐 [Auth] Verifying WhatsApp Web authentication...'));
            try {
                const whatsAppAuth = await ensureWhatsAppLogin(pages.whatsapp);
                if (!whatsAppAuth.authenticated) {
                    console.log(chalk.yellow(`  ⚠️ WhatsApp session not linked (${whatsAppAuth.status}). Pipeline will operate safely.`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`  ⚠️ WhatsApp auth error: ${err.message}. Continuing with other sources.`));
            }
        }

        // Initialize Coordinators with dedicated page isolation
        const discovery = new DiscoveryCoordinator({ page, context, pages });
        const appCoordinator = new ApplicationCoordinator({ page, context });

        // Step 1: Discover and Rank Jobs
        const rankedJobs = await discovery.discoverAll({
            sources,
            naukriOptions: { mode, maxDays: 1 },
            linkedinOptions: { easyApplyOnly: true, maxPages: 2 },
            wellfoundOptions: { roles: ['software-engineer', 'machine-learning-engineer'] },
            whatsappOptions: {
                channelUrl: settings.whatsappChannelUrl || 'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25',
                limit: 30,
                whatsappDays,
                verbose: true
            },
            verbose
        });

        if (rankedJobs.length === 0) {
            console.log(chalk.yellow('ℹ️  No unapplied eligible jobs found during this run.'));
            return { applied: 0, succeeded: 0, dryRunReady: 0, blocked: 0, aborted: 0, failed: 0, skipped: 0 };
        }

        // Step 2: Execute Applications
        const stats = await appCoordinator.processApplications(rankedJobs, {
            maxApply,
            minScore,
            dryRun,
            verbose,
            promptFn: options.promptFn,
            isInteractive: options.isInteractive
        });

        console.log(chalk.bold.green(`\n🎉 Autonomous Auto-Apply Run Completed Successfully!`));
        return stats;

    } catch (err) {
        console.error(chalk.red(`\n❌ Fatal error in Autonomous Controller: ${err.message}`));
        return { applied: 0, succeeded: 0, dryRunReady: 0, blocked: 0, aborted: 0, failed: 0, skipped: 0, error: err.message };
    } finally {
        console.log(chalk.gray('Closing browser session...'));
        if (context) await context.close().catch(() => {});
        if (browser && browser !== context && typeof browser.close === 'function') await browser.close().catch(() => {});
    }
}

/**
 * Parses CLI arguments into structured options.
 * @param {string[]} argv 
 * @returns {Object}
 */
function parseCliArgs(argv = process.argv.slice(2)) {
    const cliOptions = {};

    argv.forEach(arg => {
        if (arg.startsWith('--sources=') || arg.startsWith('--source=')) {
            const val = arg.split('=')[1].trim();
            if (val.toLowerCase() === 'all') {
                cliOptions.sources = ['NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP'];
            } else {
                cliOptions.sources = val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            }
        } else if (arg.startsWith('--whatsapp-days=')) {
            cliOptions.whatsappDays = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--mode=')) {
            cliOptions.mode = arg.split('=')[1].trim();
        } else if (arg.startsWith('--max=')) {
            cliOptions.maxApply = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--min-score=')) {
            cliOptions.minScore = parseInt(arg.split('=')[1], 10);
        } else if (arg === '--dry-run') {
            cliOptions.dryRun = true;
            cliOptions.live = false;
        } else if (arg === '--live') {
            cliOptions.live = true;
            cliOptions.dryRun = false;
        } else if (arg === '--verbose') {
            cliOptions.verbose = true;
        } else if (arg === '--headless') {
            cliOptions.headless = true;
        } else if (arg === '--override-live-limit') {
            cliOptions.overrideLiveLimit = true;
        } else if (arg === '--interactive') {
            cliOptions.isInteractive = true;
        }
    });

    return cliOptions;
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────
if (require.main === module) {
    const cliOptions = parseCliArgs(process.argv.slice(2));

    runAutonomousAutoApply(cliOptions).catch(err => {
        console.error('Unhandled CLI execution error:', err);
        process.exit(1);
    });
}

module.exports = { runAutonomousAutoApply, parseCliArgs };
