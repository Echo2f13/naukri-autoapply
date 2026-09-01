const cron = require('node-cron');
const { runAutomation } = require('../index');
const chalk = require('chalk');

// Schedule to run every day at 10:00 AM
// Cron: 0 10 * * *
cron.schedule('0 10 * * *', async () => {
    console.log(chalk.magenta.bold(`[${new Date().toLocaleString()}] Scheduled Automation Triggered.`));
    try {
        await runAutomation();
        console.log(chalk.magenta.bold(`[${new Date().toLocaleString()}] Scheduled Automation Completed.`));
    } catch (error) {
        console.error(chalk.red(`[${new Date().toLocaleString()}] Scheduled Automation Failed: ${error.message}`));
    }
});

console.log(chalk.cyan("Naukri Auto Apply Scheduler is active."));
console.log(chalk.cyan("Scheduled to run daily at 10:00 AM (0 10 * * *)."));
