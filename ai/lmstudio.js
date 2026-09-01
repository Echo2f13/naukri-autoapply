const axios = require('axios');
const chalk = require('chalk');
const settings = require('../config/settings');

// LMStudio is online flag (set at startup by checkLMStudio)
let lmStudioOnline = false;
let loadedModelId = null;

/**
 * Pings LMStudio's /v1/models endpoint.
 * Logs result to terminal. Sets the module-level online flag.
 * Never throws — returns true/false.
 * @returns {Promise<boolean>}
 */
async function checkLMStudio() {
    const base = settings.lmStudioBaseUrl;
    console.log(chalk.cyan(`[LMStudio] Checking connection at ${base}...`));

    try {
        const res = await axios.get(`${base}/v1/models`, { timeout: 5000 });
        const models = res.data?.data || [];

        if (models.length === 0) {
            console.log(chalk.yellow(`[LMStudio] ⚠️  Connected but NO model is currently loaded.`));
            console.log(chalk.yellow(`[LMStudio]    → Load ${settings.lmStudioModel} in LMStudio and restart.`));
            console.log(chalk.yellow(`[LMStudio]    → Falling back to manual terminal prompts.\n`));
            lmStudioOnline = false;
            return false;
        }

        // Find the configured model (or use first available)
        const configuredModel = models.find(m =>
            m.id?.toLowerCase().includes(settings.lmStudioModel.toLowerCase())
        );
        loadedModelId = configuredModel ? configuredModel.id : models[0].id;

        console.log(chalk.green(`[LMStudio] ✅ Connected! Active model: ${chalk.bold(loadedModelId)}`));
        lmStudioOnline = true;
        return true;

    } catch (err) {
        console.log(chalk.yellow(`[LMStudio] ⚠️  LMStudio not detected at ${base}`));
        console.log(chalk.yellow(`[LMStudio]    → Make sure LMStudio is open and the server is running.`));
        console.log(chalk.yellow(`[LMStudio]    → Falling back to manual terminal prompts.\n`));
        lmStudioOnline = false;
        return false;
    }
}

/**
 * Sends a prompt to LMStudio and returns the answer text.
 * Uses the OpenAI-compatible /v1/chat/completions endpoint.
 *
 * @param {string} systemPrompt - The system-level instruction
 * @param {string} userMessage  - The actual question/task
 * @returns {Promise<string|null>} - Trimmed answer string, or null on failure
 */
async function askLMStudio(systemPrompt, userMessage) {
    if (!lmStudioOnline) return null;

    const base = settings.lmStudioBaseUrl;
    const model = loadedModelId || settings.lmStudioModel;

    try {
        const response = await axios.post(
            `${base}/v1/chat/completions`,
            {
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userMessage  }
                ],
                temperature: 0.2,   // Low temperature = more deterministic, concise answers
                max_tokens: 60,     // Force short answers
                stream: false
            },
            { timeout: 30000 }
        );

        const raw = response.data?.choices?.[0]?.message?.content?.trim();
        if (!raw) return null;

        // Strip any stray quotes, markdown, or newlines the model might add
        return raw
            .replace(/^["'`]+|["'`]+$/g, '')   // Remove surrounding quotes/backticks
            .replace(/\*\*/g, '')               // Remove bold markdown
            .replace(/\n.*/s, '')              // Take only first line
            .trim();

    } catch (err) {
        console.error(chalk.red(`[LMStudio] ❌ Request failed: ${err.message}`));
        return null;
    }
}

/**
 * Returns whether LMStudio is currently online.
 */
function isLMStudioOnline() {
    return lmStudioOnline;
}

module.exports = { checkLMStudio, askLMStudio, isLMStudioOnline };
