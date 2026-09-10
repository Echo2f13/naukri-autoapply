const axios = require('axios');
const chalk = require('chalk');
const settings = require('../config/settings');

let ollamaOnline = false;
let activeModel = null;

/**
 * Pings Ollama's /api/tags endpoint.
 * Logs result, sets the module-level online flag.
 * Never throws — returns true/false.
 * @returns {Promise<boolean>}
 */
async function checkOllama() {
    const base = settings.ollamaBaseUrl;
    console.log(chalk.cyan(`[Ollama]   Checking connection at ${base}...`));

    try {
        const res = await axios.get(`${base}/api/tags`, { timeout: 5000 });
        const models = res.data?.models || [];

        if (models.length === 0) {
            console.log(chalk.yellow(`[Ollama]   ⚠️  Connected but no models loaded.`));
            console.log(chalk.yellow(`[Ollama]   → Run: ollama pull qwen2.5:7b`));
            ollamaOnline = false;
            return false;
        }

        // If a model is pinned in .env (OLLAMA_MODEL), use it — verify it's actually available.
        // Falls back to preference-order auto-detection if pinned model isn't loaded.
        const pinnedModel = settings.ollamaModel;
        if (pinnedModel) {
            const found = models.find(m => m.name === pinnedModel || m.name.startsWith(pinnedModel));
            if (found) {
                activeModel = found.name;
                console.log(chalk.green(`[Ollama]   ✅ Connected! Using pinned model: ${chalk.bold(activeModel)}`));
                ollamaOnline = true;
                return true;
            } else {
                console.log(chalk.yellow(`[Ollama]   ⚠️  Pinned model "${pinnedModel}" not found. Available: ${models.map(m => m.name).join(', ')}`));
                console.log(chalk.yellow(`[Ollama]   → Falling back to auto-detection.`));
            }
        }

        // Prefer qwen2.5 (general), then other known-good families
        const preferred = models.find(m =>
            ['qwen2.5', 'gemma', 'qwen', 'llama', 'mistral', 'phi'].some(k =>
                m.name.toLowerCase().includes(k)
            )
        ) || models[0];

        activeModel = preferred.name;
        console.log(chalk.green(`[Ollama]   ✅ Connected! Active model: ${chalk.bold(activeModel)}`));
        ollamaOnline = true;
        return true;

    } catch (err) {
        console.log(chalk.gray(`[Ollama]   ⚠️  Not detected at ${base}`));
        ollamaOnline = false;
        return false;
    }
}

/**
 * Sends a prompt to Ollama via /api/chat and returns the answer text.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @returns {Promise<string|null>}
 */
async function askOllama(systemPrompt, userMessage) {
    if (!ollamaOnline || !activeModel) {
        // Auto-initialize connection if not previously verified
        const ok = await checkOllama();
        if (!ok || !activeModel) return null;
    }

    const base = settings.ollamaBaseUrl;

    try {
        const response = await axios.post(
            `${base}/api/chat`,
            {
                model: activeModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userMessage  }
                ],
                options: {
                    temperature: 0.2,   // Deterministic, concise
                    num_predict: 60     // Force short answers
                },
                stream: false
            },
            { timeout: 30000 }
        );

        const raw = response.data?.message?.content?.trim();
        if (!raw) return null;

        // Same cleanup as lmstudio.js — strip quotes, markdown, extra lines
        return raw
            .replace(/^["'`]+|["'`]+$/g, '')
            .replace(/\*\*/g, '')
            .replace(/\n.*/s, '')
            .trim();

    } catch (err) {
        console.error(chalk.red(`[Ollama] ❌ Request failed: ${err.message}`));
        return null;
    }
}

function isOllamaOnline() { return ollamaOnline; }
function getOllamaModel() { return activeModel; }

module.exports = { checkOllama, askOllama, isOllamaOnline, getOllamaModel };
