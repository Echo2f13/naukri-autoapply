'use strict';

const chalk = require('chalk');
const { createNormalizedJob } = require('../../discovery/normalizedJob');
const { resolveDestinationUrl } = require('./linkResolver');
const { parseWhatsAppMessage } = require('./messageParser');
const { evaluatePassoutYear } = require('./yearFilter');
const { evaluateRoleEligibility } = require('./roleFilter');

/**
 * Checks whether a URL is a social link, WhatsApp channel/group invite,
 * or an autolinked technical/educational acronym (e.g. ASP.NET, B.Tech, Node.js).
 * @param {string} url 
 * @returns {boolean}
 */
function isAutolinkOrSocialOrChannel(url = '') {
    if (!url || typeof url !== 'string') return true;
    const lower = url.toLowerCase().trim();

    // 1. WhatsApp channel or community/chat invites
    if (lower.includes('whatsapp.com/channel/') || lower.includes('chat.whatsapp.com/')) {
        return true;
    }

    // 2. Pure social media platforms
    if (lower.includes('instagram.com') ||
        lower.includes('facebook.com') ||
        lower.includes('tiktok.com') ||
        lower.includes('youtube.com') ||
        lower.includes('youtu.be') ||
        lower.includes('twitter.com') ||
        lower.includes('x.com') ||
        lower.includes('t.me')) {
        return true;
    }

    // 3. Technical framework and degree acronyms autolinked by chat clients
    const autolinkHost = lower.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
    if (autolinkHost === 'asp.net' ||
        autolinkHost === 'b.tech' ||
        autolinkHost === 'm.tech' ||
        autolinkHost === 'node.js' ||
        autolinkHost === 'react.js' ||
        autolinkHost === 'vue.js' ||
        autolinkHost === 'angular.js' ||
        autolinkHost === 'next.js' ||
        autolinkHost === 'express.js' ||
        autolinkHost === 'dot.net') {
        return true;
    }

    return false;
}

/**
 * Identifies the authoritative job application URL from candidate links,
 * strictly excluding WhatsApp channel invites, social links, and autolinked acronyms.
 * 
 * @param {string[]} urls
 * @returns {string|null}
 */
function findAuthoritativeJobUrl(urls = []) {
    if (!urls || !Array.isArray(urls) || urls.length === 0) return null;

    const validUrls = urls.filter(u => !isAutolinkOrSocialOrChannel(u));
    if (validUrls.length === 0) return null;

    // 1. Prioritize ATS, verified career portals, and Google Forms
    for (const u of validUrls) {
        const lower = u.toLowerCase();
        if (lower.includes('myworkdayjobs.com') ||
            lower.includes('workdayjobs.com') ||
            lower.includes('greenhouse.io') ||
            lower.includes('lever.co') ||
            lower.includes('ashbyhq.com') ||
            lower.includes('zohorecruit.com') ||
            lower.includes('smartrecruiters.com') ||
            lower.includes('taleo.net') ||
            lower.includes('bamboohr.com') ||
            lower.includes('jobs.') ||
            lower.includes('careers.') ||
            lower.includes('/job/') ||
            lower.includes('/jobs/') ||
            lower.includes('/careers/') ||
            lower.includes('forms.gle') ||
            lower.includes('docs.google.com/forms')) {
            return u;
        }
    }

    // 2. Select first legitimate non-social web application URL
    return validUrls[0];
}

/**
 * Inspects a destination URL's HTML content for authoritative job titles and metadata.
 * @param {string} url 
 * @returns {Promise<{ pageTitle: string, description: string, h1: string }>}
 */
async function scrapeDestinationMetadata(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        clearTimeout(timeout);

        if (!resp.ok) return { pageTitle: '', description: '', h1: '' };
        const html = await resp.text();

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                          html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

        return {
            pageTitle: titleMatch ? titleMatch[1].trim() : '',
            description: descMatch ? descMatch[1].trim() : '',
            h1: h1Match ? h1Match[1].trim() : ''
        };
    } catch {
        return { pageTitle: '', description: '', h1: '' };
    }
}

/**
 * Infers company name from known ATS hostnames and career domains without fabrication.
 */
function inferCompanyFromUrl(url = '') {
    if (!url) return null;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();

        // Workday tenant e.g. adobe.wd5.myworkdayjobs.com -> Adobe
        const wdMatch = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
        if (wdMatch) {
            const name = wdMatch[1];
            return name.charAt(0).toUpperCase() + name.slice(1);
        }

        // Greenhouse: boards.greenhouse.io/<company>
        if (host.includes('greenhouse.io')) {
            const part = u.pathname.split('/').filter(Boolean)[0];
            if (part && part !== 'embed' && part !== 'jobs') {
                return part.charAt(0).toUpperCase() + part.slice(1);
            }
        }

        // Lever: jobs.lever.co/<company>
        if (host.includes('lever.co')) {
            const part = u.pathname.split('/').filter(Boolean)[0];
            if (part) return part.charAt(0).toUpperCase() + part.slice(1);
        }

        // Ashby: jobs.ashbyhq.com/<company>
        if (host.includes('ashbyhq.com')) {
            const part = u.pathname.split('/').filter(Boolean)[0];
            if (part) return part.charAt(0).toUpperCase() + part.slice(1);
        }

        // Zoho Recruit: <company>.zohorecruit.com
        if (host.includes('zohorecruit.com')) {
            const part = host.split('.')[0];
            if (part && part !== 'recruit') return part.charAt(0).toUpperCase() + part.slice(1);
        }

        // Career domains e.g. careers.kumaran.com -> Kumaran, jobs.birlasoft.com -> Birlasoft
        const parts = host.replace(/^www\./, '').split('.');
        if (parts.length >= 2 && (parts[0] === 'careers' || parts[0] === 'jobs')) {
            const main = parts[1];
            if (main && main.length > 2 && !/^(google|forms|bit|tinyurl|t|linktr)$/i.test(main)) {
                return main.charAt(0).toUpperCase() + main.slice(1);
            }
        } else if (host.includes('google.com') && (u.pathname.includes('/careers') || u.pathname.includes('/jobs'))) {
            return 'Google';
        }
    } catch (_) {}
    return null;
}

/**
 * Evaluates a WhatsApp message and extracts a NormalizedJob if eligible,
 * or returns an explicit, observable disposition at each pipeline stage.
 * 
 * @param {string|{ text: string, timestamp?: Date, channelName?: string }} rawMessage
 * @param {Object} [options]
 * @returns {Promise<{
 *   job: import('../../discovery/normalizedJob').NormalizedJob|null,
 *   disposition: 'ACCEPTED'|'REJECTED_YEAR'|'REJECTED_ROLE'|'REJECTED_NON_JOB'|'REJECTED_REFERRAL_EMAIL'|'REJECTED_INVALID_URL'|'NEEDS_REVIEW',
 *   stage: string,
 *   reason: string,
 *   detail?: string,
 *   yearEvidence?: string|null,
 *   roleEvidence?: string|null
 * }>}
 */
async function extractJobWithDisposition(rawMessage, options = {}) {
    const text = typeof rawMessage === 'string' ? rawMessage : (rawMessage?.text || '');
    if (!text || text.trim().length < 15) {
        return {
            job: null,
            disposition: 'REJECTED_NON_JOB',
            stage: 'Message Length Validation',
            reason: 'REJECTED_NON_JOB',
            detail: 'Message text is too short to represent a valid job posting'
        };
    }

    // ── STAGE 1: Job / Non-Job Classification ──────────────────────────────────
    const parsed = await parseWhatsAppMessage(text);
    if (!parsed || parsed.isJobPosting === false) {
        return {
            job: null,
            disposition: 'REJECTED_NON_JOB',
            stage: 'Job/Non-Job Classification',
            reason: 'REJECTED_NON_JOB',
            detail: 'Message classified as non-job content (social promotion, survey, or personal greeting)'
        };
    }

    // ── STAGE 2: Passout-Year Eligibility ──────────────────────────────────────
    const yearRes = evaluatePassoutYear(text);
    if (!yearRes.eligible) {
        return {
            job: null,
            disposition: 'REJECTED_YEAR',
            stage: 'Passout-Year Eligibility',
            reason: yearRes.reason || 'REJECTED_YEAR',
            detail: yearRes.detail || `Passout year "${yearRes.yearEvidence}" does not contain 2026 or 26`,
            yearEvidence: yearRes.yearEvidence
        };
    }

    // ── STAGE 3: Application Link vs Referral/Email Rule ──────────────────────
    const rawUrl = findAuthoritativeJobUrl(parsed.urls);
    const isReferralOrEmail = Boolean(
        parsed.contactEmail ||
        /send\s*(?:your\s*)?resume|email\s*(?:your\s*)?resume|referral\s*[:\s]|dm\s*(?:for\s*)?referral|mail\s*(?:your\s*)?cv|send\s*(?:your\s*)?cv/i.test(text)
    );

    if (!rawUrl) {
        if (isReferralOrEmail) {
            return {
                job: null,
                disposition: 'REJECTED_REFERRAL_EMAIL',
                stage: 'Application URL Extraction',
                reason: 'REJECTED_REFERRAL_EMAIL',
                detail: `Referral or email-only application (${parsed.contactEmail || 'email instruction'}) is not supported for auto-application`,
                yearEvidence: yearRes.yearEvidence
            };
        }
        return {
            job: null,
            disposition: 'REJECTED_INVALID_URL',
            stage: 'Application URL Extraction',
            reason: 'REJECTED_INVALID_URL',
            detail: 'No legitimate career portal, ATS, or form URL found in message',
            yearEvidence: yearRes.yearEvidence
        };
    }

    // ── STAGE 4: URL Resolution & Destination Metadata ────────────────────────
    let authoritativeUrl = await resolveDestinationUrl(rawUrl);
    let meta = { pageTitle: '', description: '', h1: '' };
    if (authoritativeUrl) {
        meta = await scrapeDestinationMetadata(authoritativeUrl);
    }

    // Reconcile Title without fabrication
    let title = parsed.title || null;
    if (!title && meta.h1) {
        const cleanH1 = meta.h1.replace(/job|opening|hiring|career/gi, '').trim();
        if (cleanH1.length > 2) title = cleanH1;
    }
    if (!title && meta.pageTitle) {
        const cleanPage = meta.pageTitle.split(/[-–|]/)[0].trim();
        if (cleanPage.length > 2 && !/^(home|careers?|jobs?|apply)$/i.test(cleanPage)) {
            title = cleanPage;
        }
    }

    // Reconcile Company without fabrication
    let company = parsed.company || null;
    if (!company && meta.pageTitle && meta.pageTitle.includes('-')) {
        const parts = meta.pageTitle.split(/[-–|]/);
        if (parts.length > 1) {
            const cand = parts[parts.length - 1].trim();
            if (cand.length > 1 && !/careers?|jobs?|portal/i.test(cand)) {
                company = cand;
            }
        }
    }
    if (!company && authoritativeUrl) {
        company = inferCompanyFromUrl(authoritativeUrl) || null;
    }

    // ── STAGE 5: Role Eligibility ──────────────────────────────────────────────
    let roleRes = { eligible: true, matchedRole: null };
    let disposition = 'ACCEPTED';
    let detail = `Eligible candidate: "${title || 'Job'}" at "${company || 'Direct'}" (Year: ${yearRes.yearEvidence || 'No Year Mentioned'})`;

    if (title) {
        roleRes = evaluateRoleEligibility(title);
        if (!roleRes.eligible) {
            return {
                job: null,
                disposition: 'REJECTED_ROLE',
                stage: 'Role Eligibility',
                reason: roleRes.reason || 'REJECTED_ROLE',
                detail: roleRes.detail || `Role "${title}" does not match configured target tech roles`,
                roleEvidence: title,
                yearEvidence: yearRes.yearEvidence
            };
        }
    } else {
        disposition = 'NEEDS_REVIEW';
        detail = 'Job title missing from message; flagged for human review before application queue';
    }

    // ── STAGE 6: Application Destination Type & Normalization ──────────────────
    let applicationType = 'EXTERNAL_ATS';
    const lowerUrl = (authoritativeUrl || '').toLowerCase();
    if (lowerUrl.includes('forms.gle') || lowerUrl.includes('docs.google.com/forms')) {
        applicationType = 'DIRECT_URL';
    } else {
        applicationType = 'EXTERNAL_ATS';
    }

    const needsReview = !title || !company || disposition === 'NEEDS_REVIEW';

    const job = createNormalizedJob({
        source: 'WHATSAPP',
        sourceUrl: authoritativeUrl,
        applicationUrl: authoritativeUrl,
        applicationType,
        title: title || null,
        company: company || null,
        location: parsed.location || 'India',
        experience: parsed.experience || '0-2 Yrs',
        skills: parsed.skills || [],
        description: text,
        postedAge: 'Recent',
        needsReview,
        rawPayload: {
            originalText: text,
            channelName: typeof rawMessage === 'object' ? rawMessage.channelName : undefined,
            extractedUrls: parsed.urls,
            authoritativeUrl,
            contactEmail: parsed.contactEmail,
            yearEvidence: yearRes.yearEvidence,
            roleEvidence: roleRes.matchedRole || title,
            disposition,
            meta
        }
    });

    job.disposition = disposition;

    return {
        job,
        disposition,
        stage: disposition === 'NEEDS_REVIEW' ? 'Role Review' : 'Normalization',
        reason: disposition,
        detail,
        yearEvidence: yearRes.yearEvidence,
        roleEvidence: roleRes.matchedRole || title
    };
}

/**
 * Backward-compatible wrapper returning NormalizedJob or null.
 * 
 * @param {string|{ text: string, timestamp?: Date, channelName?: string }} rawMessage
 * @param {Object} [options]
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob|null>}
 */
async function extractJobFromWhatsApp(rawMessage, options = {}) {
    const res = await extractJobWithDisposition(rawMessage, options);
    return res.job;
}

module.exports = {
    extractJobFromWhatsApp,
    extractJobWithDisposition,
    findAuthoritativeJobUrl,
    scrapeDestinationMetadata,
    inferCompanyFromUrl,
    isAutolinkOrSocialOrChannel
};
