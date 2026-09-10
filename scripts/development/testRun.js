const { runAutomation } = require('../../index.js');
const settings = require('../../config/settings.js');

// Override max daily applications to 1 for this test run
settings.maxDailyApplications = 1;

const config = {
    mode: 'recommended',
    searchOptions: null,
    maxDays: null
};

console.log("Starting test run for 1 company (recommended mode)...");
runAutomation(config).then(() => {
    console.log("Test run complete.");
    process.exit(0);
}).catch(err => {
    console.error("Test run failed", err);
    process.exit(1);
});
