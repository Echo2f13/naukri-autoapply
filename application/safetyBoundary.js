'use strict';

const chalk = require('chalk');

/**
 * Shared Final Submission Safety Barrier.
 * Enforces defense-in-depth: guarantees that whenever dryRun is true,
 * irreversible submission actions (submit, send, apply now) MUST NOT execute.
 * 
 * @param {Object} params
 * @param {boolean} [params.dryRun=false] - Whether dry-run mode is active
 * @param {string} params.actionName - Human-readable name of the action (e.g. "LinkedIn Easy Apply Submit")
 * @param {Function} params.execute - Irreversible submission callback
 * @returns {Promise<{ submitted: boolean, status: 'SUCCESS'|'DRY_RUN_READY_TO_SUBMIT', message: string }>}
 */
async function executeSubmissionSafely({ dryRun = false, actionName = 'Submit Application', execute }) {
    if (dryRun) {
        console.log(chalk.bold.yellow(`\n  🛡️  [SAFETY BARRIER] Dry-Run active. Blocking irreversible action: "${actionName}".`));
        console.log(chalk.yellow(`     Form is filled and validated. Stopped exactly at the submission boundary.`));
        return {
            submitted: false,
            status: 'DRY_RUN_READY_TO_SUBMIT',
            actionName,
            message: `[DRY-RUN] Reached final boundary for "${actionName}" without submitting.`
        };
    }

    let result;
    if (typeof execute === 'function') {
        result = await execute();
    }

    return {
        submitted: true,
        status: (result && result.status) || 'SUCCESS',
        actionName,
        message: `Successfully executed "${actionName}".`,
        result
    };
}

module.exports = { executeSubmissionSafely };
