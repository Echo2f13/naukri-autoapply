'use strict';

const chalk = require('chalk');
const { createNormalizedJob } = require('../../discovery/normalizedJob');
const { resolveDestinationUrl } = require('./linkResolver');
const { parseWhatsAppMessage } = require('./messageParser');

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
 * Transforms a WhatsApp message into an authoritative NormalizedJob.
 * 
 * @param {string|{ text: string, timestamp?: Date, channelName?: string }} rawMessage
 * @returns {Promise<import('../../discovery/normalizedJob').NormalizedJob|null>}
 */
async function extractJobFromWhatsApp(rawMessage) {
    const text = typeof rawMessage === 'string' ? rawMessage : (rawMessage?.text || '');
    if (!text || text.trim().length < 15) return null;

    // 1. Parse structured details from text
    const parsed = await parseWhatsAppMessage(text);
    if (!parsed) return null;

    // 2. Resolve primary application URL
    const rawUrl = parsed.urls && parsed.urls.length > 0 ? parsed.urls[0] : null;
    let authoritativeUrl = '';
    let meta = { pageTitle: '', description: '', h1: '' };

    if (rawUrl) {
        authoritativeUrl = await resolveDestinationUrl(rawUrl);
        meta = await scrapeDestinationMetadata(authoritativeUrl);
    }

    // 3. Reconcile Title & Company
    let title = parsed.title;
    let company = parsed.company;

    if (!title && meta.h1) {
        title = meta.h1.replace(/job|opening|hiring|career/gi, '').trim();
    }
    if (!title && meta.pageTitle) {
        title = meta.pageTitle.split(/[-–|]/)[0].trim();
    }
    if (!company && meta.pageTitle && meta.pageTitle.includes('-')) {
        const parts = meta.pageTitle.split(/[-–|]/);
        if (parts.length > 1) {
            company = parts[parts.length - 1].trim();
        }
    }

    if (!title && !authoritativeUrl) {
        return null; // Not enough actionable information
    }

    title = title || 'Software Engineer';
    company = company || 'Tech Employer';

    // 4. Determine ATS Application Type
    let applicationType = 'EXTERNAL_ATS';
    const lowerUrl = (authoritativeUrl || '').toLowerCase();
    if (lowerUrl.includes('workdayjobs.com') || lowerUrl.includes('myworkdayjobs.com')) {
        applicationType = 'EXTERNAL_ATS';
    } else if (lowerUrl.includes('zohorecruit.com')) {
        applicationType = 'EXTERNAL_ATS';
    } else if (lowerUrl.includes('greenhouse.io') || lowerUrl.includes('lever.co') || lowerUrl.includes('ashbyhq.com')) {
        applicationType = 'EXTERNAL_ATS';
    } else if (lowerUrl.includes('forms.gle') || lowerUrl.includes('docs.google.com/forms')) {
        applicationType = 'DIRECT_URL';
    }

    return createNormalizedJob({
        source: 'WHATSAPP',
        sourceUrl: authoritativeUrl || 'https://web.whatsapp.com',
        applicationUrl: authoritativeUrl || 'https://web.whatsapp.com',
        applicationType,
        title,
        company,
        location: parsed.location || 'India',
        experience: parsed.experience || '0-2 Yrs',
        skills: parsed.skills || [],
        description: text,
        postedAge: 'Recent',
        rawPayload: {
            originalText: text,
            channelName: typeof rawMessage === 'object' ? rawMessage.channelName : undefined,
            extractedUrls: parsed.urls,
            authoritativeUrl,
            meta
        }
    });
}

module.exports = {
    extractJobFromWhatsApp,
    scrapeDestinationMetadata
};
