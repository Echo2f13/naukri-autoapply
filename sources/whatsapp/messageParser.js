'use strict';

const chalk = require('chalk');
const { extractLinksFromText } = require('./linkResolver');
const { parseExperienceRange } = require('../../discovery/normalizedJob');
const { askOllama } = require('../../ai/ollama');

/**
 * Checks if a list of URLs contains known ATS or career portal patterns.
 * @param {string[]} urls
 * @returns {boolean}
 */
function hasAtsOrCareerLink(urls = []) {
    if (!urls || urls.length === 0) return false;
    return urls.some(u => {
        const l = u.toLowerCase();
        return l.includes('myworkdayjobs.com') ||
               l.includes('workdayjobs.com') ||
               l.includes('greenhouse.io') ||
               l.includes('lever.co') ||
               l.includes('ashbyhq.com') ||
               l.includes('zohorecruit.com') ||
               l.includes('smartrecruiters.com') ||
               l.includes('taleo.net') ||
               l.includes('bamboohr.com') ||
               l.includes('jobs.') ||
               l.includes('careers.') ||
               l.includes('/job/') ||
               l.includes('/jobs/') ||
               l.includes('/careers/') ||
               l.includes('forms.gle') ||
               l.includes('docs.google.com/forms');
    });
}

/**
 * Validates whether raw message text represents an actual job opportunity.
 * Discards social promos (Instagram, YouTube, NPS polls) while treating
 * verified ATS and career URLs as dominant primary signal.
 * 
 * Includes STRUCTURAL HEADLINE detection for compact WhatsApp job posts:
 * e.g. "Associate Project Engineer | Chennai, India" or "Backend Developer - Remote"
 * A pipe/dash-delimited headline with a role token + location/company counts as 2 signals.
 * 
 * @param {string} text 
 * @param {string[]} urls 
 * @returns {boolean}
 */
function isLegitimateJobMessage(text = '', urls = []) {
    if (!text || text.trim().length < 20) return false;
    const lower = text.toLowerCase();

    // 1. Hard Disqualifiers: NPS surveys, standalone spam, crypto, ratings, customer feedback
    const hardSpamPatterns = [
        'net promoter score',
        /\bnps[:\s]*[0-9]+/i,
        'rate our service',
        'rate your experience',
        'share your feedback',
        'share feedback',
        'feedback here',
        'customer feedback',
        'dear customer',
        'daily quote',
        'good morning',
        'daily quiz',
        'poll of the day',
        'crypto pump',
        'earn money from home by clicking'
    ];

    for (const pat of hardSpamPatterns) {
        if (pat instanceof RegExp ? pat.test(text) : lower.includes(pat)) {
            return false;
        }
    }

    // Pure social channel promotion without any job signals
    const isChannelPromoOnly = (lower.includes('join our whatsapp channel') || lower.includes('join channel')) &&
                               !lower.includes('role') && !lower.includes('position') && !lower.includes('apply') && !lower.includes('hiring');
    if (isChannelPromoOnly) {
        return false;
    }

    // Disqualify messages whose only URLs are purely social platforms (Instagram, TikTok, personal reels)
    if (urls.length > 0) {
        const onlySocial = urls.every(u => {
            const l = u.toLowerCase();
            return l.includes('instagram.com') ||
                   l.includes('facebook.com') ||
                   l.includes('tiktok.com') ||
                   l.includes('youtube.com') ||
                   l.includes('youtu.be') ||
                   l.includes('twitter.com') ||
                   l.includes('x.com');
        });
        if (onlySocial && !lower.includes('hiring') && !lower.includes('vacancy') && !lower.includes('apply')) {
            return false;
        }
    }

    // 2. Primary Signal: ATS or Career URL
    if (hasAtsOrCareerLink(urls)) {
        return true;
    }

    // 3. Structural Headline Detection (compact WhatsApp job headlines)
    // Detects pipe/dash-delimited patterns: "Role Token | Location/Company"
    // e.g. "Associate Project Engineer - Cyber Security | Chennai, India"
    //      "Software Developer | Hyderabad | TCS"
    //      "Graduate Engineer Trainee | Multiple Openings"
    const structuralSignal = detectStructuralHeadline(text);

    // 4. Positive Job Signals
    const jobKeywords = [
        'hiring', 'vacancy', 'openings', 'opening', 'job', 'role', 'position',
        'apply', 'salary', 'ctc', 'package', 'lpa', 'experience', 'eligibility',
        'fresher', 'intern', 'internship', 'engineer', 'developer', 'analyst',
        'work from home', 'remote', 'full time', 'passouts', 'tech stack', 'send resume',
        'associate', 'trainee', 'consultant', 'lead', 'architect'
    ];

    const matchedSignals = jobKeywords.filter(kw => {
        if (kw === 'experience') {
            // Avoid false positive on "customer experience", "experience in residential", etc.
            // Only match: "3+ yrs experience", "experience:", "exp:", "years of experience"
            return /\b([0-9]+\+?\s*(?:yrs?|years?)|experience\s*:|exp\s*:|years?\s*of\s*experience)\b/i.test(text);
        }
        return lower.includes(kw);
    });

    // If structural headline is detected, it counts as 2 signals (sufficient alone)
    const effectiveSignalCount = matchedSignals.length + (structuralSignal ? 2 : 0);

    // If message contains a verified ATS/form link or an application email, 1 positive job signal is sufficient
    const hasApplicationEmail = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/.test(text) &&
                                (lower.includes('send resume') || lower.includes('apply') || lower.includes('contact'));
    if (hasApplicationEmail && effectiveSignalCount >= 1) {
        return true;
    }

    return effectiveSignalCount >= 2;
}

/**
 * Detects compact WhatsApp job headline patterns using pipe/dash delimiters.
 * Returns true if the text contains a structural pattern like:
 *   "<RoleToken> <separator> <LocationOrCompany>"
 * 
 * This catches compact headlines without making single keywords sufficient:
 *   ✔ "Associate Project Engineer - Cyber Security | Chennai, India"
 *   ✔ "Software Developer | Hyderabad | TCS"
 *   ✔ "Backend Engineer - Remote - 5 LPA"
 *   ✔ "Graduate Engineer Trainee | Multiple Openings"
 *   ✗ "Looking for an engineer to fix my plumbing" (no structural delimiter)
 *   ✗ "Our engineer visited the site" (no structural delimiter)
 * 
 * @param {string} text
 * @returns {boolean}
 */
function detectStructuralHeadline(text = '') {
    if (!text) return false;

    // Role tokens: words that indicate a job role when combined with structural delimiters
    const roleTokens = [
        'engineer', 'developer', 'analyst', 'designer', 'architect',
        'intern', 'trainee', 'associate', 'lead', 'manager', 'consultant',
        'programmer', 'coder', 'administrator', 'specialist', 'executive',
        'officer', 'coordinator', 'scientist', 'researcher', 'tester',
        'sde', 'swe', 'mts', 'sse', 'sdet'
    ];

    // Indian cities and location signals for the structural context
    const locationSignals = [
        'mumbai', 'delhi', 'bangalore', 'bengaluru', 'hyderabad', 'chennai',
        'kolkata', 'pune', 'ahmedabad', 'jaipur', 'lucknow', 'surat',
        'chandigarh', 'noida', 'gurgaon', 'gurugram', 'kochi', 'coimbatore',
        'indore', 'nagpur', 'thiruvananthapuram', 'visakhapatnam', 'bhubaneswar',
        'mysore', 'mysuru', 'mangalore', 'mangaluru', 'vadodara', 'rajkot',
        'india', 'remote', 'hybrid', 'wfh', 'work from home', 'on-site', 'onsite',
        'pan india', 'across india', 'multiple locations'
    ];

    // Structural separators used in WhatsApp job headlines
    const separatorPattern = /\s*[|–—·]\s*|\s+-\s+/;

    // Split text into segments by structural separators
    const segments = text.split(separatorPattern).map(s => s.trim()).filter(s => s.length > 0);

    // Need at least 2 segments for a structural headline
    if (segments.length < 2) return false;

    // Check if any segment contains a role token
    const hasRoleSegment = segments.some(seg => {
        const segLower = seg.toLowerCase();
        return roleTokens.some(rt => segLower.includes(rt));
    });

    if (!hasRoleSegment) return false;

    // Check if any OTHER segment contains a location signal, company-like proper noun, or job context
    const hasContextSegment = segments.some(seg => {
        const segLower = seg.toLowerCase();
        // Don't match the same segment as the role segment for context
        const isRoleSegment = roleTokens.some(rt => segLower.includes(rt));

        // Location signal
        if (locationSignals.some(loc => segLower.includes(loc))) return true;

        // Job context signals (openings, hiring, apply, salary markers)
        if (/\b(opening|openings|hiring|apply|lpa|ctc|salary|package|fresher|batch|passout)\b/i.test(seg)) return true;

        // Company-like proper noun: Starts with uppercase, 2+ chars, not a common word
        if (!isRoleSegment && /^[A-Z][A-Za-z0-9\s&.,'-]{1,}$/.test(seg) && seg.length >= 2) {
            const commonWords = ['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been', 'were', 'are', 'was'];
            if (!commonWords.includes(segLower)) return true;
        }

        return false;
    });

    return hasContextSegment;
}


/**
 * Deterministically parses key job fields from raw message text using regex.
 * @param {string} text 
 * @returns {Record<string, any>}
 */
function parseMessageDeterministic(text = '') {
    if (!text) return {};

    const urls = extractLinksFromText(text);
    if (!isLegitimateJobMessage(text, urls)) {
        return { isJobPosting: false };
    }

    // 1. Experience extraction
    let expStr = '';
    const expMatch = text.match(/(?:experience|exp|eligibility)[:\s]*([0-9\s\-+toYrsYears]+)/i) ||
                     text.match(/\b([0-9]+\s*(?:-|to)\s*[0-9]+\s*(?:yrs?|years?))\b/i) ||
                     text.match(/\b(fresher|entry\s*level)\b/i) ||
                     text.match(/\b([0-9]+\+?\s*(?:yrs?|years?))\b/i);
    if (expMatch) {
        expStr = expMatch[1].trim();
    } else {
        const batchMatch = text.match(/batch\s*[:\s]*([0-9\s&+-]+)/i);
        if (batchMatch) {
            expStr = '0-1 Yrs';
        }
    }

    // 2. Company extraction
    let company = null;
    const compMatch = text.match(/(?:company(?:\s*name)?|organization|client)[:\s]*([A-Za-z0-9 &.,'-]+)/i) ||
                      text.match(/(?:hiring\s*for)[:\s]*([A-Za-z0-9 &.,'-]+)/i);
    if (compMatch) {
        const candidateComp = compMatch[1].trim().split('\n')[0].replace(/[#*!]/g, '').trim();
        if (candidateComp && candidateComp.length > 1 && !/^(0|nps|instagram|facebook|click here|tech employer|unknown startup)$/i.test(candidateComp)) {
            company = candidateComp;
        }
    }

    // 3. Role / Title extraction
    let title = null;
    // Strategy A: Explicit labels (exclude 'hiring for' which denotes company)
    const roleMatch = text.match(/(?:role|position|job\s*profile|job\s*title|opening\s*for|urgent\s*hiring|looking\s*for)[:\s]*([A-Za-z0-9 \/+-]+)/i);
    if (roleMatch) {
        let candidateTitle = roleMatch[1].trim().split('\n')[0].replace(/[#*!]/g, '').trim();
        candidateTitle = candidateTitle.replace(/^(?:for|as|a|an)\s+/i, '').trim();
        if (candidateTitle && candidateTitle.length > 2 && !/^(0|nps|instagram|facebook|link|click|info)$/i.test(candidateTitle)) {
            if (!company || candidateTitle.toLowerCase() !== company.toLowerCase()) {
                title = candidateTitle;
            }
        }
    }

    // Strategy B: Real headline format (e.g. "HIRING | SOFTWARE ENGINEER INTERN" or "HIRING - FULL STACK DEVELOPER")
    if (!title) {
        const headlineMatch = text.match(/(?:^|\n)\s*(?:urgent\s*)?hiring\s*[|:-]\s*([A-Za-z0-9 \/+-]+?)(?:\s*(?:\n|company|location|type|batch|work\s*mode|eligibility|tech|requirements|$))/i);
        if (headlineMatch) {
            let candidateTitle = headlineMatch[1].trim().split('\n')[0].replace(/[#*!]/g, '').trim();
            if (candidateTitle && candidateTitle.length > 2 && !/^(0|nps|instagram|facebook|link|click|info)$/i.test(candidateTitle)) {
                if (!company || candidateTitle.toLowerCase() !== company.toLowerCase()) {
                    title = candidateTitle;
                }
            }
        }
    }

    // Strategy C: Extract role segment from structural headline if not explicitly labeled
    if (!title && detectStructuralHeadline(text)) {
        const roleTokens = [
            'engineer', 'developer', 'analyst', 'designer', 'architect',
            'intern', 'trainee', 'associate', 'lead', 'manager', 'consultant',
            'programmer', 'coder', 'administrator', 'specialist', 'executive',
            'officer', 'coordinator', 'scientist', 'researcher', 'tester',
            'sde', 'swe', 'mts', 'sse', 'sdet'
        ];
        const separatorPattern = /\s*[|–—·]\s*|\s+-\s+/;
        const segments = text.split(separatorPattern).map(s => s.trim()).filter(Boolean);
        for (const seg of segments) {
            const segLower = seg.toLowerCase();
            if (roleTokens.some(rt => segLower.includes(rt))) {
                let cleanTitle = seg.split(/\s+(?:in|at)\s+[A-Z]/i)[0].replace(/[#*!]/g, '').trim();
                if (cleanTitle.length > 2 && (!company || cleanTitle.toLowerCase() !== company.toLowerCase())) {
                    title = cleanTitle;
                    break;
                }
            }
        }
    }

    // 4. Location extraction
    let location = '';
    const locMatch = text.match(/(?:location|job\s*location|work\s*location|city)[:\s]*([A-Za-z0-9 ,/|-]+)/i);
    if (locMatch) {
        location = locMatch[1].trim().split('\n')[0].replace(/[#*]/g, '').trim();
    }

    // 5. Skills extraction
    const skills = [];
    const skillsMatch = text.match(/(?:skills|key\s*skills|tech\s*stack|technologies)[:\s]*([A-Za-z0-9 ,/+#.-]+)/i);
    if (skillsMatch) {
        skills.push(...skillsMatch[1].split(/[,/|]/).map(s => s.trim()).filter(Boolean));
    }

    // 6. Contact Email extraction
    let contactEmail = null;
    const emailMatch = text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
    if (emailMatch && !/example\.com|test\.com/i.test(emailMatch[1])) {
        contactEmail = emailMatch[1].trim();
    }

    return {
        isJobPosting: true,
        title: title || null,
        company: company || null,
        location: location || null,
        experience: expStr || null,
        skills,
        urls,
        contactEmail
    };
}

/**
 * Parses message using deterministic regex first, and falls back to Ollama
 * for unstructured messages where company or title was not clearly labeled.
 * 
 * @param {string} text
 * @returns {Promise<Record<string, any>|null>}
 */
async function parseWhatsAppMessage(text = '') {
    if (!text || typeof text !== 'string') return null;

    const deterministic = parseMessageDeterministic(text);
    if (deterministic.isJobPosting === false) {
        return null; // Rejected as NON_JOB_MESSAGE
    }

    // If both title and company were found deterministically, we have a confident match
    if (deterministic.title && deterministic.company) {
        return deterministic;
    }

    // Unstructured text fallback: Use Ollama with strict JSON prompt
    try {
        const prompt = `You are a precision job parser. Extract job details from this WhatsApp message into JSON format.
Strict rules:
- Only output valid JSON, nothing else.
- If a message is NOT a genuine job posting (e.g. social media promo, NPS survey, chat announcement), set "isJobPosting": false.
- If a field is not explicitly mentioned, use null. NEVER invent company or role names.
JSON structure:
{
  "title": "Exact job title or null",
  "company": "Company name or null",
  "location": "Job location or null",
  "minExperience": number or null,
  "maxExperience": number or null,
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
            if (parsed.isJobPosting === false) {
                return null; // Non-job message
            }
            return {
                isJobPosting: true,
                title: deterministic.title || parsed.title || '',
                company: deterministic.company || parsed.company || '',
                location: deterministic.location || parsed.location || 'India',
                experience: deterministic.experience || (parsed.minExperience !== null ? `${parsed.minExperience}-${parsed.maxExperience || 2} Yrs` : ''),
                skills: deterministic.skills.length > 0 ? deterministic.skills : (parsed.skills || []),
                urls: deterministic.urls,
                contactEmail: deterministic.contactEmail
            };
        }
    } catch (_) {
        // Fall back to deterministic result
    }

    return deterministic;
}

module.exports = {
    hasAtsOrCareerLink,
    isLegitimateJobMessage,
    detectStructuralHeadline,
    parseMessageDeterministic,
    parseWhatsAppMessage
};
