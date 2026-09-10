const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const settings = require('../config/settings');
const profile = require('../config/profile');

// ─── Resume Text Extraction ──────────────────────────────────────────────────
let resumeText = '';

async function loadResume(customPath = null) {
    try {
        const targetPath = customPath || settings.resumePath;
        if (!fs.existsSync(targetPath)) {
            console.log(chalk.yellow(`[Prompts] ⚠️  Resume not found at ${targetPath}. Proceeding without it.`));
            return;
        }
        const { PDFParse } = require('pdf-parse');
        const dataBuffer = fs.readFileSync(targetPath);
        const parser = new PDFParse({ data: dataBuffer });
        const pdfData = await parser.getText();
        resumeText = pdfData.text
            .replace(/\s{3,}/g, '  ')   // Collapse excessive whitespace
            .trim()
            .slice(0, 3000);             // Cap at 3000 chars to keep prompts lean
        console.log(chalk.green(`[Prompts] 📄 Resume loaded from ${path.basename(targetPath)}: ${resumeText.length} characters extracted.`));
    } catch (err) {
        console.log(chalk.yellow(`[Prompts] ⚠️  Could not parse resume: ${err.message}`));
        resumeText = '';
    }
}

// ─── System Prompt ─────────────────────────────────────────────────────────
/**
 * The strict system prompt that forces Gemma to return minimal, human-like answers.
 */
const SYSTEM_PROMPT = `You are filling out a job application form on behalf of a candidate.
Your ONLY job is to output the shortest, most natural answer to the question asked.

STRICT RULES — follow every single one:
1. Yes/No questions → respond with exactly "Yes" or "No" (nothing else)
2. Number/years questions → respond with only the number, e.g. "2"
3. Salary/CTC questions → if numeric or "in lakhs/lacs" is specified, respond with ONLY the number (e.g. "0" or "8"). Only include "LPA" if options or prompt explicitly require LPA format
4. Notice period → respond with exactly "Immediate" or the number like "30 days"
5. Short phrase questions → respond with ≤ 5 words, no full sentences
6. Multiple choice → pick the single best option and return ONLY that option text
7. NEVER write full sentences unless the question explicitly asks for one (e.g. "Tell us about yourself")
8. NEVER add phrases like "Based on my profile", "I am", "As a developer", etc.
9. NEVER add punctuation at the end unless the answer is a sentence
10. Sound natural, human, and believable — like a real person typed it quickly

Candidate profile summary:
Name: ${profile.fullName || ''}
Experience: ${profile.experience || 0} year(s)
Current Employment Status: ${profile.currentJobTitle ? `Currently ${profile.currentJobTitle} at ${profile.currentCompany || ''}` : 'Seeking full-time roles'}
Current CTC: ${profile.currentCTC || '0'}
Expected CTC: ${profile.expectedCTC || '800000'}
Location: ${profile.currentLocation || ''}
Relocation: ${profile.relocate ? 'Yes' : 'No'}
Notice Period: ${profile.noticePeriod || 'Immediate'}
Date of Birth: ${profile.dob || profile.dateOfBirth || ''}
PAN Number: ${profile.panNumber || ''}
Education: ${profile.education ? `${profile.education.degree || ''} in ${profile.education.field || ''} from ${profile.education.university || ''} (${profile.education.startMonth || ''} ${profile.education.startYear || ''} to ${profile.education.endMonth || ''} ${profile.education.endYear || ''}, Passout: ${profile.education.passoutYear || ''})` : ''}
Skills: ${Array.isArray(profile.skills) ? profile.skills.join(', ') : ''}`;

// ─── User Message Builder ──────────────────────────────────────────────────
/**
 * Builds the user-side message for a job application question.
 * @param {string} question     - The recruiter's question
 * @param {string[]} options    - Available options (if any)
 * @returns {{ system: string, user: string }}
 */
function buildQuestionPrompt(question, options = []) {
    let userMsg = `Question: "${question}"`;

    if (options && options.length > 0) {
        userMsg += `\n\nAvailable options:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
        userMsg += `\n\nReturn ONLY the exact text of the best matching option.`;
    }

    if (resumeText) {
        userMsg += `\n\n--- Resume (use this for context) ---\n${resumeText.slice(0, 1500)}`;
    }

    userMsg += `\n\nAnswer:`;

    return {
        system: SYSTEM_PROMPT,
        user: userMsg
    };
}

/**
 * Legacy Gemini-style prompt (kept for backwards compatibility).
 */
const prompts = {
    getQuestionPrompt: (question) => {
        const { system, user } = buildQuestionPrompt(question);
        return `${system}\n\n${user}`;
    },
    getMatchScorePrompt: (jobDescription) => {
        return `
Match the following job description with the user's profile and provide a match score from 0 to 100.

User Profile:
${JSON.stringify(profile, null, 2)}

Job Description:
"${jobDescription}"

Instructions:
1. Return ONLY a single integer between 0 and 100.
2. No text, no explanations.

Score:`;
    }
};

module.exports = { prompts, buildQuestionPrompt, loadResume, SYSTEM_PROMPT };
