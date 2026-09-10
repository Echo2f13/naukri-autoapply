'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const profilePath = path.resolve(__dirname, 'profile.json');
const examplePath = path.resolve(__dirname, 'profile.example.json');

/**
 * Checks whether the candidate profile is configured.
 * If missing, prints clear setup instructions.
 * @returns {boolean} true if profile.json exists, false otherwise.
 */
function validateProfileSetup() {
    if (!fs.existsSync(profilePath)) {
        console.error(`
${chalk.red.bold('══════════════════════════════════════════════════════════════════════')}
${chalk.red.bold('  CONFIGURATION REQUIRED: Missing Candidate Profile (config/profile.json)')}
${chalk.red.bold('══════════════════════════════════════════════════════════════════════')}

  This repository does not include a personal candidate profile by design.
  To protect privacy, personal candidate configurations are ignored by Git.

  ${chalk.yellow.bold('Follow these steps to set up your profile:')}

  1. Copy the example profile template:
     ${chalk.cyan('cp config/profile.example.json config/profile.json')}
     ${chalk.gray('(On Windows PowerShell: Copy-Item config/profile.example.json config/profile.json)')}

  2. Open ${chalk.cyan('config/profile.json')} in your editor and enter your candidate details:
     - Name, email, mobile number, date of birth, PAN
     - Current employment, expected salary, notice period
     - Education details and technical skills

  3. Place your resume PDF in the ${chalk.cyan('resume/')} folder.

  4. Re-run your command.
${chalk.red.bold('══════════════════════════════════════════════════════════════════════')}
`);
        return false;
    }
    return true;
}

/**
 * Loads the local candidate profile.
 * Throws a clean error if profile.json is not configured.
 * @param {Object} [options={}]
 * @returns {Object} Parsed profile JSON
 */
function loadProfile(options = {}) {
    if (!fs.existsSync(profilePath)) {
        validateProfileSetup();
        if (options.throwOnError !== false) {
            const err = new Error('Candidate profile not configured. Please copy config/profile.example.json to config/profile.json and fill in your details.');
            err.code = 'ERR_PROFILE_NOT_CONFIGURED';
            throw err;
        }
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (e) {
        console.error(chalk.red(`[Profile Error] Failed to parse config/profile.json: ${e.message}`));
        throw e;
    }
}

module.exports = {
    profilePath,
    examplePath,
    validateProfileSetup,
    loadProfile
};
