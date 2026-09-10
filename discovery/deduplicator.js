'use strict';

const { generateJobFingerprint } = require('./normalizedJob');

/**
 * Strips tracking queries and fragments to produce a canonical job URL.
 * @param {string} rawUrl 
 * @returns {string}
 */
function canonicalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const parsed = new URL(rawUrl);
        // Strips common tracking query parameters across platforms
        const trackingParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'src', 'sid', 'xp', 'px', 'ref', 'source', 'trackingId',
            'refId', 'currentJobId', 'eBP', 'midToken', 'trk', 'fbclid', 'gclid', 'si', 'ref_id'
        ];
        trackingParams.forEach(p => parsed.searchParams.delete(p));
        // Remove trailing slash and fragment
        let clean = parsed.origin + parsed.pathname;
        if (clean.endsWith('/')) clean = clean.slice(0, -1);
        if (parsed.searchParams.toString()) {
            clean += `?${parsed.searchParams.toString()}`;
        }
        return clean;
    } catch (_) {
        return rawUrl.trim();
    }
}

/**
 * Extracts ATS Job ID if present in the URL.
 * e.g. /jobs/Careers/23850000026342334 -> 23850000026342334
 * e.g. gh_jid=123456 -> 123456
 * @param {string} url 
 * @returns {string|null}
 */
function extractAtsJobId(url) {
    if (!url) return null;
    const ghMatch = url.match(/[?&]gh_jid=(\d+)/i) || url.match(/boards\.greenhouse\.io\/[^\/]+\/jobs\/(\d+)/i);
    if (ghMatch) return `gh_${ghMatch[1]}`;
    
    const leverMatch = url.match(/jobs\.lever\.co\/[^\/]+\/([a-f0-9-]+)/i);
    if (leverMatch) return `lever_${leverMatch[1]}`;

    const zohoMatch = url.match(/jobs\/Careers\/(\d+)/i);
    if (zohoMatch) return `zoho_${zohoMatch[1]}`;

    const workdayMatch = url.match(/\/job\/[^\/]+\/([A-Za-z0-9_-]+)/i);
    if (workdayMatch) return `wd_${workdayMatch[1]}`;

    return null;
}

class JobDeduplicator {
    constructor() {
        this.seenCanonicalUrls = new Set();
        this.seenFingerprints = new Set();
        this.seenAtsIds = new Set();
    }

    /**
     * Checks if a job has already been seen in the current batch.
     * @param {import('./normalizedJob').NormalizedJob} job 
     * @returns {boolean} true if already seen/duplicate
     */
    isDuplicate(job) {
        const canonical = canonicalizeUrl(job.applicationUrl || job.sourceUrl);
        if (canonical && this.seenCanonicalUrls.has(canonical)) {
            return true;
        }

        const atsId = extractAtsJobId(job.applicationUrl);
        if (atsId && this.seenAtsIds.has(atsId)) {
            return true;
        }

        const fp = generateJobFingerprint(job.company, job.title, job.locations[0]);
        if (fp && this.seenFingerprints.has(fp)) {
            return true;
        }

        return false;
    }

    /**
     * Registers a job as seen in the deduplication cache.
     * @param {import('./normalizedJob').NormalizedJob} job 
     */
    register(job) {
        const canonical = canonicalizeUrl(job.applicationUrl || job.sourceUrl);
        if (canonical) this.seenCanonicalUrls.add(canonical);

        const atsId = extractAtsJobId(job.applicationUrl);
        if (atsId) this.seenAtsIds.add(atsId);

        const fp = generateJobFingerprint(job.company, job.title, job.locations[0]);
        if (fp) this.seenFingerprints.add(fp);
    }

    /**
     * Filters a list of jobs, retaining only the first unique instance of each.
     * @param {import('./normalizedJob').NormalizedJob[]} jobs 
     * @returns {import('./normalizedJob').NormalizedJob[]}
     */
    filterUnique(jobs = []) {
        const unique = [];
        for (const job of jobs) {
            if (!this.isDuplicate(job)) {
                this.register(job);
                unique.push(job);
            }
        }
        return unique;
    }

    clear() {
        this.seenCanonicalUrls.clear();
        this.seenFingerprints.clear();
        this.seenAtsIds.clear();
    }
}

/**
 * Convenience helper to deduplicate a list of jobs across sources.
 * @param {import('./normalizedJob').NormalizedJob[]} jobs 
 * @returns {import('./normalizedJob').NormalizedJob[]}
 */
function crossSourceDeduplicate(jobs = []) {
    const dedup = new JobDeduplicator();
    return dedup.filterUnique(jobs);
}

module.exports = {
    canonicalizeUrl,
    extractAtsJobId,
    JobDeduplicator,
    crossSourceDeduplicate
};
