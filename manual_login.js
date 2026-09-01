const { launchBrowser } = require('./automation/browser');
const { ensureLogin } = require('./automation/login');
const chalk = require('chalk');

async function manualLogin() {
    console.log(chalk.blue.bold("--- Naukri Manual Login ---"));
    console.log(chalk.yellow("A browser window will open. Please log in to Naukri manually."));
    console.log(chalk.yellow("Once you are logged in, the script will detect it and save your session."));

    const { context, page } = await launchBrowser();

    try {
        await ensureLogin(page);
        console.log(chalk.green.bold("Login successful! Session saved."));
    } catch (error) {
        console.error(chalk.red(`Error during login: ${error.message}`));
    } finally {
        await context.close();
        console.log(chalk.blue("Browser closed. You can now run the auto-apply script."));
    }
}

manualLogin();
