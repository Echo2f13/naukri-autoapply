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
 * @param {string[]} [options.sources=['NAUKRI']] - Sources: 'NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP'
 * @param {string} [options.mode='both'] - For Naukri: 'recommended', 'search', 'both'
 * @param {number} [options.maxApply=10]
 * @param {number} [options.minScore=50]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.headless=false]
 */
async function runAutonomousAutoApply(options = {}) {
    const { validateProfileSetup } = require('./config/profileLoader');
    if (!validateProfileSetup()) {
        process.exit(1);
    }

    console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════════════╗
║        ENTERPRISE MULTI-SOURCE AUTONOMOUS JOB PLATFORM           ║
║       Naukri  •  LinkedIn  •  Wellfound  •  WhatsApp Channels    ║
╚══════════════════════════════════════════════════════════════════╝
`));

    // Parse options with environment and flag defaults
    const sources = options.sources || (process.env.AUTOAPPLY_SOURCES ? process.env.AUTOAPPLY_SOURCES.split(',').map(s => s.trim().toUpperCase()) : ['NAUKRI']);
    const mode = options.mode || process.env.NAUKRI_MODE || 'both';
    const maxApply = options.maxApply || parseInt(process.env.MAX_APPLY || '10', 10);
    const minScore = options.minScore !== undefined ? options.minScore : 50;
    const dryRun = options.dryRun !== undefined ? options.dryRun : process.env.DRY_RUN === 'true';

    console.log(chalk.yellow(`⚙️  Active Configuration:`));
    console.log(chalk.gray(`   Sources   : ${sources.join(', ')}`));
    console.log(chalk.gray(`   Mode      : ${mode}`));
    console.log(chalk.gray(`   Max Apply : ${maxApply}`));
    console.log(chalk.gray(`   Min Score : ${minScore}`));
    console.log(chalk.gray(`   Dry Run   : ${dryRun}\n`));

    // Check AI Engine
    const ollamaOk = await checkOllama();
    if (!ollamaOk) {
        console.log(chalk.yellow('⚠️  Ollama is offline or unreachable. Will rely on verified profile and rule fallbacks.'));
    }

    // Launch Browser
    console.log(chalk.blue('🌐 Launching automation browser...'));
    const { browser, context, page } = await launchBrowser({ headless: options.headless });

    try {
        // True multi-source browser tab isolation: Allocate dedicated page per active source
        const pages = {
            naukri: sources.includes('NAUKRI') ? page : null,
            linkedin: sources.includes('LINKEDIN') ? (sources.includes('NAUKRI') ? await context.newPage() : page) : null,
            wellfound: sources.includes('WELLFOUND') ? await context.newPage() : null,
            whatsapp: sources.includes('WHATSAPP') ? await context.newPage() : null
        };

        // Authenticate Naukri if Naukri is in sources
        if (sources.includes('NAUKRI') && pages.naukri) {
            console.log(chalk.blue('🔐 Verifying Naukri authentication...'));
            const loggedIn = await ensureLogin(pages.naukri);
            if (!loggedIn) {
                console.log(chalk.red('❌ Naukri login failed. Continuing with external sources...'));
            }
        }

        // Authenticate LinkedIn if LinkedIn is in sources (independent session on dedicated tab)
        if (sources.includes('LINKEDIN') && pages.linkedin) {
            console.log(chalk.blue('🔐 Verifying LinkedIn authentication on dedicated tab...'));
            try {
                const linkedInAuth = await ensureLinkedInLogin(pages.linkedin);
                if (!linkedInAuth.authenticated) {
                    console.log(chalk.yellow(`⚠️  LinkedIn session not authenticated (${linkedInAuth.status}). Pipeline will operate safely.`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`⚠️  LinkedIn login check error: ${err.message}`));
            }
        }

        // Authenticate Wellfound if Wellfound is in sources (independent session on dedicated tab)
        if (sources.includes('WELLFOUND') && pages.wellfound) {
            console.log(chalk.blue('🔐 Verifying Wellfound authentication on dedicated tab...'));
            try {
                const wellfoundAuth = await ensureWellfoundLogin(pages.wellfound);
                if (!wellfoundAuth.authenticated) {
                    console.log(chalk.yellow(`⚠️  Wellfound session not authenticated (${wellfoundAuth.status}). Pipeline will operate safely.`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`⚠️  Wellfound login check error: ${err.message}`));
            }
        }

        // Authenticate WhatsApp Web if WhatsApp is in sources (independent session on dedicated tab)
        if (sources.includes('WHATSAPP') && pages.whatsapp) {
            console.log(chalk.blue('🔐 Verifying WhatsApp Web authentication on dedicated tab...'));
            try {
                const whatsAppAuth = await ensureWhatsAppLogin(pages.whatsapp);
                if (!whatsAppAuth.authenticated) {
                    console.log(chalk.yellow(`⚠️  WhatsApp Web session not linked (${whatsAppAuth.status}). Pipeline will operate safely.`));
                }
            } catch (err) {
                console.warn(chalk.yellow(`⚠️  WhatsApp login check error: ${err.message}`));
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
                limit: 30
            }
        });

        if (rankedJobs.length === 0) {
            console.log(chalk.yellow('ℹ️  No unapplied eligible jobs found during this run.'));
            return { applied: 0, succeeded: 0, failed: 0, skipped: 0 };
        }

        // Step 2: Execute Applications
        const stats = await appCoordinator.processApplications(rankedJobs, {
            maxApply,
            minScore,
            dryRun
        });

        console.log(chalk.bold.green(`\n🎉 Autonomous Auto-Apply Run Completed Successfully!`));
        return stats;

    } catch (err) {
        console.error(chalk.red(`\n❌ Fatal error in Autonomous Controller: ${err.message}`));
        return { applied: 0, succeeded: 0, failed: 0, skipped: 0, error: err.message };
    } finally {
        console.log(chalk.gray('Closing browser session...'));
        if (context) await context.close().catch(() => {});
        if (browser && browser !== context && typeof browser.close === 'function') await browser.close().catch(() => {});
    }
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────
if (require.main === module) {
    const args = process.argv.slice(2);
    const cliOptions = {};

    args.forEach(arg => {
        if (arg.startsWith('--sources=')) {
            cliOptions.sources = arg.split('=')[1].split(',').map(s => s.trim().toUpperCase());
        } else if (arg.startsWith('--mode=')) {
            cliOptions.mode = arg.split('=')[1].trim();
        } else if (arg.startsWith('--max=')) {
            cliOptions.maxApply = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--min-score=')) {
            cliOptions.minScore = parseInt(arg.split('=')[1], 10);
        } else if (arg === '--dry-run') {
            cliOptions.dryRun = true;
        } else if (arg === '--headless') {
            cliOptions.headless = true;
        }
    });

    runAutonomousAutoApply(cliOptions).catch(err => {
        console.error('Unhandled CLI execution error:', err);
        process.exit(1);
    });
}

module.exports = { runAutonomousAutoApply };
