'use strict';

const readline = require('readline');
const chalk = require('chalk');

let profile = {};
try {
    profile = require('../config/profile');
} catch (_) {
    profile = {};
}

/**
 * Prompts user on active terminal.
 * @param {string} query
 * @returns {Promise<string>}
 */
function promptTerminal(query) {
    return new Promise(resolve => {
        if (!process.stdin || !process.stdout || process.stdin.destroyed) {
            return resolve('');
        }
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(query, answer => {
            rl.close();
            resolve((answer || '').trim());
        });
    });
}

/**
 * Shared Final Human Confirmation & Submission Safety Gate.
 * Enforces defense-in-depth:
 * 1. When dryRun === true: Irreversible submission actions NEVER execute. Returns DRY_RUN_READY_TO_SUBMIT.
 * 2. When dryRun === false:
 *    - If running in non-interactive environment (no TTY / no prompt handler), ABORTS immediately.
 *    - Prompts user with structured job & candidate preview.
 *    - Requires explicit affirmative confirmation ('y', 'yes', 'Y', 'YES') before calling execute().
 *    - Default is NO. Empty or unexpected input aborts.
 * 
 * @param {Object} params
 * @param {boolean} [params.dryRun=true] - Whether dry-run mode is active
 * @param {Object} [params.job={}] - Normalized job data
 * @param {string} [params.resumeUsed] - Name of resume file selected
 * @param {string} [params.destination='Direct ATS'] - ATS destination name
 * @param {string} [params.actionName='Submit Application'] - Action description
 * @param {Function} params.execute - Irreversible submission callback
 * @param {Function} [params.promptFn] - Optional mock/custom prompt callback for testing
 * @param {boolean} [params.isInteractive] - Optional override for interactive TTY check
 * @returns {Promise<{ submitted: boolean, status: string, message: string, actionName: string, reason?: string, result?: any }>}
 */
async function confirmAndExecuteSubmission({
    dryRun = true,
    job = {},
    resumeUsed = 'Default Profile Resume',
    destination = 'Direct ATS',
    actionName = 'Submit Application',
    execute,
    promptFn = null,
    isInteractive = undefined
}) {
    // 1. Dry-Run Barrier
    if (dryRun) {
        console.log(chalk.bold.yellow(`\n  🛡️  [SAFETY BARRIER] Dry-Run active. Blocking irreversible action: "${actionName}".`));
        console.log(chalk.yellow(`     Form is filled and validated. Stopped exactly at the submission boundary.`));
        return {
            submitted: false,
            actionExecuted: false,
            status: 'DRY_RUN_READY_TO_SUBMIT',
            actionName,
            message: `[DRY-RUN] Reached final boundary for "${actionName}" without submitting.`
        };
    }

    // 2. Non-Interactive Environment Safety Check
    const interactive = isInteractive !== undefined
        ? isInteractive
        : (process.env.FORCE_INTERACTIVE === 'true' || Boolean(process.stdin && process.stdin.isTTY && !process.stdin.destroyed));

    if (!interactive && typeof promptFn !== 'function') {
        console.log(chalk.bold.red('\n=================================================='));
        console.log(chalk.bold.red('  🛡️  [SAFETY BARRIER] LIVE SUBMISSION BLOCKED'));
        console.log(chalk.bold.red('=================================================='));
        console.log(chalk.red('  Non-interactive environment detected (no active TTY terminal).'));
        console.log(chalk.red('  Live mode requires explicit human confirmation for each submission.'));
        console.log(chalk.red('  Aborting: Automatic submission without human approval is strictly prohibited.\n'));
        return {
            submitted: false,
            actionExecuted: false,
            status: 'CONFIRMATION_ABORTED',
            reason: 'NON_INTERACTIVE',
            actionName,
            message: 'Aborted: Non-interactive environment cannot provide confirmation'
        };
    }

    // 3. Application Preview
    const candidateName = profile.fullName || profile.name || 'Candidate';
    const company = job.company || 'Unknown Company';
    const position = job.title || job.role || 'Unknown Position';
    const source = job.source || 'Direct';
    const url = job.applicationUrl || job.sourceUrl || 'N/A';

    console.log(chalk.bold.magenta('\n=================================================='));
    console.log(chalk.bold.magenta('FINAL APPLICATION CONFIRMATION'));
    console.log(chalk.bold.magenta('=============================='));
    console.log(chalk.white(`Company:     ${chalk.bold.yellow(company)}`));
    console.log(chalk.white(`Position:    ${chalk.bold.cyan(position)}`));
    console.log(chalk.white(`Source:      ${chalk.bold(source)}`));
    console.log(chalk.white(`Destination: ${chalk.bold(destination)}`));
    console.log(chalk.white(`Candidate:   ${candidateName}`));
    console.log(chalk.white(`Resume:      ${resumeUsed || 'Default Profile Resume'}`));
    if (url && url !== 'N/A') {
        console.log(chalk.gray(`URL:         ${url}`));
    }
    console.log(chalk.yellow('\nThe application is ready to be submitted.'));
    console.log(chalk.bold.magenta('=================================================='));

    // 4. Request Human Confirmation
    const query = chalk.bold.white('\nSubmit this application? [y/N]: ');
    let rawAnswer = '';
    if (typeof promptFn === 'function') {
        rawAnswer = await promptFn(query);
    } else {
        rawAnswer = await promptTerminal(query);
    }

    const answer = (rawAnswer || '').trim().toLowerCase();
    const isApproved = answer === 'y' || answer === 'yes';

    if (!isApproved) {
        console.log(chalk.yellow(`\n  🛑 Application submission aborted by user for "${position}" at "${company}".\n`));
        return {
            submitted: false,
            actionExecuted: false,
            status: 'CONFIRMATION_ABORTED',
            reason: 'USER_ABORTED',
            actionName,
            message: 'Submission aborted by user at confirmation prompt.'
        };
    }

    // 5. User Approved -> Execute Irreversible Submission
    console.log(chalk.bold.green(`\n  ✅ Human authorization confirmed. Executing "${actionName}"...`));
    try {
        let result;
        let executed = false;
        if (typeof execute === 'function') {
            result = await execute();
            executed = true;
        }

        const finalStatus = (result && result.status) ? result.status : (result && result.verified === false ? 'SUBMISSION_NOT_VERIFIED' : 'SUCCESS');
        const isActuallySuccess = finalStatus === 'SUCCESS' && result?.verified === true;

        return {
            submitted: isActuallySuccess,
            actionExecuted: executed,
            status: isActuallySuccess ? 'SUCCESS' : (finalStatus === 'SUCCESS' && !result?.verified ? 'SUBMISSION_NOT_VERIFIED' : finalStatus),
            verified: isActuallySuccess,
            reason: isActuallySuccess ? undefined : (result?.reason || 'SUBMISSION_NOT_VERIFIED'),
            actionName,
            message: (result && result.message) || (isActuallySuccess ? `Successfully executed "${actionName}".` : `Executed "${actionName}" but submission could not be verified.`),
            result
        };
    } catch (err) {
        console.error(chalk.red(`  ❌ Execution of "${actionName}" failed: ${err.message}`));
        return {
            submitted: false,
            actionExecuted: false,
            status: 'FAILED',
            actionName,
            message: `Execution failed: ${err.message}`,
            error: err.message
        };
    }
}

/**
 * Backwards-compatible alias to confirmAndExecuteSubmission.
 */
async function executeSubmissionSafely(params) {
    return await confirmAndExecuteSubmission(params);
}

module.exports = {
    confirmAndExecuteSubmission,
    executeSubmissionSafely
};
