'use strict';

require('dotenv').config();
const cron = require('node-cron');
const chalk = require('chalk');
const { runAutonomousAutoApply } = require('../masterController');

// Determine enabled sources from env flags (supporting both LINKEDIN_ENABLED and ENABLE_LINKEDIN conventions)
const isSourceEnabled = (name, defaultEnabled = false) => {
    const val1 = process.env[`${name}_ENABLED`];
    const val2 = process.env[`ENABLE_${name}`];
    if (val1 !== undefined) return val1 === 'true' || val1 === '1';
    if (val2 !== undefined) return val2 === 'true' || val2 === '1';
    return defaultEnabled;
};

const enabledSources = [];
if (isSourceEnabled('NAUKRI', true)) enabledSources.push('NAUKRI');
if (isSourceEnabled('LINKEDIN', true)) enabledSources.push('LINKEDIN');
if (isSourceEnabled('WELLFOUND', false)) enabledSources.push('WELLFOUND');
if (isSourceEnabled('WHATSAPP', false)) enabledSources.push('WHATSAPP');

const cronExpression = process.env.CRON_SCHEDULE || '0 10 * * *';

console.log(chalk.cyan("=== Autonomous Multi-Source Scheduler Active ==="));
console.log(chalk.gray(`Schedule : ${cronExpression}`));
console.log(chalk.gray(`Sources  : [${enabledSources.join(', ')}]`));
console.log(chalk.cyan("Waiting for next trigger...\n"));

cron.schedule(cronExpression, async () => {
    console.log(chalk.magenta.bold(`\n[${new Date().toLocaleString()}] Scheduled Auto-Apply Triggered.`));
    try {
        // Safety invariant: Default to dryRun: true unless explicitly configured as false
        const isDryRun = process.env.SCHEDULED_DRY_RUN !== undefined
            ? (process.env.SCHEDULED_DRY_RUN === 'true' || process.env.SCHEDULED_DRY_RUN === '1')
            : (process.env.DRY_RUN !== undefined ? (process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1') : true);

        await runAutonomousAutoApply({
            sources: enabledSources,
            maxApply: parseInt(process.env.SCHEDULED_MAX_APPLY || '15', 10),
            minScore: parseInt(process.env.SCHEDULED_MIN_SCORE || '50', 10),
            dryRun: isDryRun
        });
        console.log(chalk.magenta.bold(`[${new Date().toLocaleString()}] Scheduled Auto-Apply Completed.`));
    } catch (error) {
        console.error(chalk.red(`[${new Date().toLocaleString()}] Scheduled Auto-Apply Failed: ${error.message}`));
    }
});
