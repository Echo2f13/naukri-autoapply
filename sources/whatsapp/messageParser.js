'use strict';

const chalk = require('chalk');
const { extractLinksFromText } = require('./linkResolver');
const { parseExperienceRange } = require('../../discovery/normalizedJob');
const { askOllama } = require('../../ai/ollama');

/**
 * Deterministically parses key job fields from raw message text using regex.
 * @param {string} text 
 * @returns {Record<string, any>}
 */
function parseMessageDeterministic(text = '') {
    if (!text) return {};

    const urls = extractLinksFromText(text);

    // 1. Experience extraction
    let expStr = '';
    const expMatch = text.match(/(?:experience|exp|eligibility)[:\s]*([0-9\s\-+toYrsYears]+)/i) ||
                     text.match(/\b([0-9]+\s*(?:-|to)\s*[0-9]+\s*(?:yrs?|years?))\b/i) ||
                     text.match(/\b(fresher|entry\s*level)\b/i) ||
                     text.match(/\b([0-9]+\+?\s*(?:yrs?|years?))\b/i);
    if (expMatch) {
        expStr = expMatch[1].trim();
    }

    // 2. Company extraction
    let company = '';
    const compMatch = text.match(/(?:company(?:\s*name)?|organization|client)[:\s]*([A-Za-z0-9 &.,'-]+)/i) ||
                      text.match(/(?:hiring\s*for)[:\s]*([A-Za-z0-9 &.,'-]+)/i);
    if (compMatch) {
        company = compMatch[1].trim().split('\n')[0].replace(/[#*!]/g, '').trim();
    }

    // 3. Role / Title extraction
    let title = '';
    const roleMatch = text.match(/(?:role|position|job\s*profile|job\s*title|opening\s*for|urgent\s*hiring(?:\s*for)?|hiring(?:\s*for)?)[:\s]*([A-Za-z0-9 \/+-]+)/i);
    if (roleMatch) {
        title = roleMatch[1].trim().split('\n')[0].replace(/[#*!]/g, '').trim();
        title = title.replace(/^(?:for|as|a|an)\s+/i, '').trim();
    }

    // 4. Location extraction
    let location = '';
    const locMatch = text.match(/(?:location|job\s*location|work\s*location|city)[:\s]*([A-Za-z0-9 ,/|-]+)/i);
    if (locMatch) {
        location = locMatch[1].trim().split('\n')[0].replace(/[#*]/g, '');
    }

    // 5. Skills extraction
    const skills = [];
    const skillsMatch = text.match(/(?:skills|key\s*skills|tech\s*stack|technologies)[:\s]*([A-Za-z0-9 ,/+#.-]+)/i);
    if (skillsMatch) {
        skills.push(...skillsMatch[1].split(/[,/|]/).map(s => s.trim()).filter(Boolean));
    }

    return {
        title,
        company,
        location,
        experience: expStr,
        skills,
        urls
    };
}

/**
 * Parses message using deterministic regex first, and falls back to Ollama
 * for unstructured messages where company or title was not clearly labeled.
 * 
 * @param {string} text
 * @returns {Promise<Record<string, any>>}
 */
async function parseWhatsAppMessage(text = '') {
    if (!text || typeof text !== 'string') return null;

    const deterministic = parseMessageDeterministic(text);

    // If both title and company were found deterministically, we have a confident match
    if (deterministic.title && deterministic.company) {
        return deterministic;
    }

    // Unstructured text fallback: Use Ollama with strict JSON prompt
    try {
        const prompt = `You are a precision job parser. Extract job details from this WhatsApp message into JSON format.
Strict rules:
- Only output valid JSON, nothing else.
- If a field is not mentioned, use null.
JSON structure:
{
  "title": "Exact job title or null",
  "company": "Company name or null",
  "location": "Job location or null",
  "minExperience": number or 0,
  "maxExperience": number or 2,
  "skills": ["skill1", "skill2"],
  "isJobPosting": boolean
}

Message:
"""
${text.slice(0, 1500)}
"""`;

        const response = await askOllama(prompt);
        const jsonMatch = response?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.isJobPosting !== false) {
                return {
                    title: deterministic.title || parsed.title || '',
                    company: deterministic.company || parsed.company || '',
                    location: deterministic.location || parsed.location || 'India',
                    experience: deterministic.experience || `${parsed.minExperience || 0}-${parsed.maxExperience || 2} Yrs`,
                    skills: deterministic.skills.length > 0 ? deterministic.skills : (parsed.skills || []),
                    urls: deterministic.urls
                };
            }
        }
    } catch (err) {
        // Fall back to deterministic result
    }

    return deterministic;
}

module.exports = {
    parseMessageDeterministic,
    parseWhatsAppMessage
};
