'use strict';

const chalk = require('chalk');

/**
 * Resolves redirects, unshortens URLs (bit.ly, lnkd.in, t.co, tinyurl),
 * and strips tracking query parameters.
 * 
 * @param {string} rawUrl 
 * @param {number} [maxRedirects=5]
 * @returns {Promise<string>} Authoritative resolved destination URL
 */
async function resolveDestinationUrl(rawUrl, maxRedirects = 5) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    let currentUrl = rawUrl.trim();

    try {
        // Fast HTTP HEAD/GET resolution with redirect follow
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(currentUrl, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        }).catch(async () => {
            // Some servers reject HEAD, fallback to GET with small range
            return await fetch(currentUrl, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Range': 'bytes=0-1024'
                }
            });
        });

        clearTimeout(timeout);

        if (response && response.url) {
            currentUrl = response.url;
        }
    } catch (err) {
        // Network or SSL timeout; return original URL
    }

    // Strip marketing/tracking query parameters
    try {
        const parsed = new URL(currentUrl);
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'ref_id', 'fbclid', 'gclid', 'si'];
        trackingParams.forEach(p => parsed.searchParams.delete(p));
        return parsed.toString();
    } catch {
        return currentUrl;
    }
}

/**
 * Extracts all HTTP/HTTPS links from a raw text message.
 * @param {string} text 
 * @returns {string[]}
 */
function extractLinksFromText(text = '') {
    if (!text) return [];
    const urlRegex = /(https?:\/\/[^\s<>"'{}|\\^`[\]]+)/gi;
    const matches = text.match(urlRegex) || [];
    return Array.from(new Set(matches.map(u => u.replace(/[.,;!]+$/, ''))));
}

module.exports = {
    resolveDestinationUrl,
    extractLinksFromText
};
