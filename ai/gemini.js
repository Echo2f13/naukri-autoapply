const { GoogleGenerativeAI } = require('@google/generative-ai');
const settings = require('../config/settings');

const genAI = new GoogleGenerativeAI(settings.geminiApiKey);

/**
 * Sends a prompt to Gemini and returns the generated text.
 * @param {string} prompt 
 * @param {number} retries 
 * @returns {Promise<string>}
 */
async function askGemini(prompt, retries = 3) {
    if (!settings.geminiApiKey || settings.geminiApiKey === "YOUR_GEMINI_API_KEY_HERE") {
        console.warn("GEMINI_API_KEY is not set. Skipping AI response.");
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        console.error(`Gemini API Error: ${error.message}`);
        if (retries > 0) {
            console.log(`Retrying Gemini request... (${retries} left)`);
            return askGemini(prompt, retries - 1);
        }
        return null;
    }
}

module.exports = { askGemini };
