'use strict';

/**
 * WhatsApp Discovery Layer — Deterministic Test Suite
 * 20 test cases covering:
 * - Structural headline detection (pipe/dash-delimited)
 * - Single keyword rejection (no structural pattern)
 * - Multi-keyword acceptance
 * - ATS URL override
 * - Spam / NPS / social / channel promo rejection
 * - Email application & referral messages
 * - Timestamp null safety (parseWhatsAppTimestamp)
 * - Lookback with null timestamps
 * 
 * All tests are deterministic with zero network calls.
 */

const assert = require('assert');
const { isLegitimateJobMessage, detectStructuralHeadline } = require('../sources/whatsapp/messageParser');
const { parseWhatsAppTimestamp, isWithinLookback } = require('../sources/whatsapp/channelMonitor');

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✔ PASS: ${desc}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ FAIL: ${desc}`);
        console.error(`     Error: ${err.message}`);
        failed++;
    }
}

console.log('\n============================================================');
console.log('   WHATSAPP DISCOVERY LAYER — DETERMINISTIC TEST SUITE');
console.log('============================================================\n');

// ── STRUCTURAL HEADLINE DETECTION ──────────────────────────────────────────

console.log('── Structural Headline Detection ──');

it('Test 1: Compact headline with pipe — "Associate Project Engineer- Cyber Security | Chennai, India"', () => {
    const text = 'Associate Project Engineer- Cyber Security | Chennai, India — Birlasoft is looking for talented individuals. Apply now at https://careers.birlasoft.com/jobs/123';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: structural pipe pattern with role token + Indian city');
    assert.strictEqual(detectStructuralHeadline(text), true, 'detectStructuralHeadline should return true');
});

it('Test 2: Multi-pipe headline — "Software Developer | Hyderabad | TCS"', () => {
    const text = 'Software Developer | Hyderabad | TCS — Exciting opportunity for freshers and experienced professionals alike.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: multi-pipe structural headline');
    assert.strictEqual(detectStructuralHeadline(text), true, 'detectStructuralHeadline should return true');
});

it('Test 3: Dash-delimited headline — "Backend Engineer - Remote - 5 LPA"', () => {
    const text = 'Backend Engineer - Remote - 5 LPA starting compensation for qualified candidates with strong fundamentals.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: dash-delimited structural headline');
    assert.strictEqual(detectStructuralHeadline(text), true, 'detectStructuralHeadline should return true');
});

it('Test 4: Pipe with location — "Data Analyst | Bangalore, India"', () => {
    const text = 'Data Analyst | Bangalore, India — Join our team and work with cutting-edge data platforms and analytics tools.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: pipe with analyst + Bangalore');
    assert.strictEqual(detectStructuralHeadline(text), true, 'detectStructuralHeadline should return true');
});

// ── SINGLE KEYWORD REJECTION ───────────────────────────────────────────────

console.log('\n── Single Keyword Rejection ──');

it('Test 5: Single keyword in prose — "Looking for an engineer to fix plumbing"', () => {
    const text = 'Looking for an engineer to fix my plumbing at home, need someone with experience in residential pipework.';
    assert.strictEqual(isLegitimateJobMessage(text, []), false, 'Should reject: "engineer" alone in prose without structural pattern');
    assert.strictEqual(detectStructuralHeadline(text), false, 'No structural headline');
});

it('Test 6: Single keyword in prose — "Our engineer visited the site yesterday"', () => {
    const text = 'Our engineer visited the site yesterday for inspection of the building foundation and prepared a report for review.';
    assert.strictEqual(isLegitimateJobMessage(text, []), false, 'Should reject: "engineer" in casual context without structural pattern');
    assert.strictEqual(detectStructuralHeadline(text), false, 'No structural headline');
});

// ── MULTI-KEYWORD ACCEPTANCE ───────────────────────────────────────────────

console.log('\n── Multi-Keyword Acceptance ──');

it('Test 7: Multi-keyword job post — "Hiring Software Developer, salary 8 LPA, apply now"', () => {
    const text = 'Hiring Software Developer, salary 8 LPA, apply now at our Mumbai office. Walk-in interview on Monday at 10 AM.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: hiring + developer + salary + apply = ≥2 signals');
});

// ── ATS URL OVERRIDE ──────────────────────────────────────────────────────

console.log('\n── ATS URL Override ──');

it('Test 8: ATS URL is dominant signal — Greenhouse URL with minimal text', () => {
    const text = 'Check out this role at our company for great opportunities in tech and innovation: https://boards.greenhouse.io/acme/jobs/123';
    assert.strictEqual(isLegitimateJobMessage(text, ['https://boards.greenhouse.io/acme/jobs/123']), true, 'Should accept: ATS URL is dominant primary signal');
});

// ── SPAM / SURVEY REJECTION ───────────────────────────────────────────────

console.log('\n── Spam / Survey Rejection ──');

it('Test 9: Hard spam rejection — "Rate our service and win prizes"', () => {
    const text = 'Rate our service and win prizes! Share feedback with our team to help us improve the customer experience every day.';
    assert.strictEqual(isLegitimateJobMessage(text, []), false, 'Should reject: hard spam pattern "rate our service"');
});

it('Test 10: Social-only links — Instagram with no job signals', () => {
    const text = 'Follow us on Instagram for amazing daily content, behind the scenes, and team stories! Click the link below to join.';
    assert.strictEqual(isLegitimateJobMessage(text, ['https://instagram.com/company']), false, 'Should reject: social-only URLs without hiring/vacancy/apply signals');
});

it('Test 11: NPS survey — "NPS: 85"', () => {
    const text = 'NPS: 85 - Great month for customer satisfaction! Our team has achieved remarkable results in service delivery metrics.';
    assert.strictEqual(isLegitimateJobMessage(text, []), false, 'Should reject: NPS survey pattern');
});

it('Test 12: Channel promo only — "Join our WhatsApp channel for daily updates"', () => {
    const text = 'Join our WhatsApp channel for daily updates and latest news from around the world. Stay informed and connected always!';
    assert.strictEqual(isLegitimateJobMessage(text, []), false, 'Should reject: channel promo without job signals (role/position/apply/hiring)');
});

// ── EMAIL / REFERRAL MESSAGES ─────────────────────────────────────────────

console.log('\n── Email / Referral Messages ──');

it('Test 13: Email application with job signal — "Send resume to hr@company.com"', () => {
    const text = 'Send resume to hr@company.com for a developer role in our Pune office. We are looking for talented individuals, apply now.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: application email + multiple job signals (developer + apply + role)');
});

it('Test 14: Referral message with job signals — "DM for referral at Google"', () => {
    const text = 'DM for referral at Google, SDE role opening available for qualified candidates with good problem-solving fundamentals and coding skills.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: role + opening = ≥2 job signals');
});

// ── TIMESTAMP NULL SAFETY ─────────────────────────────────────────────────

console.log('\n── Timestamp Null Safety ──');

it('Test 15: parseWhatsAppTimestamp(null) returns null', () => {
    const result = parseWhatsAppTimestamp(null);
    assert.strictEqual(result, null, 'Should return null for null input (never fabricate a timestamp)');
});

it('Test 16: parseWhatsAppTimestamp("garbage text xyz") returns null', () => {
    const result = parseWhatsAppTimestamp('garbage text xyz that cannot be parsed as any date format');
    assert.strictEqual(result, null, 'Should return null for unparseable string (never fabricate a timestamp)');
});

it('Test 17: parseWhatsAppTimestamp("[10:45 AM, 9/9/2026]") returns valid Date', () => {
    const result = parseWhatsAppTimestamp('[10:45 AM, 9/9/2026]');
    assert.ok(result instanceof Date, 'Should return a Date instance');
    assert.ok(!isNaN(result.getTime()), 'Date should be valid (not NaN)');
    assert.strictEqual(result.getFullYear(), 2026, 'Year should be 2026');
});

it('Test 18: parseWhatsAppTimestamp("yesterday") returns valid Date for yesterday', () => {
    const result = parseWhatsAppTimestamp('yesterday');
    assert.ok(result instanceof Date, 'Should return a Date instance');
    assert.ok(!isNaN(result.getTime()), 'Date should be valid (not NaN)');
    const expectedDay = new Date();
    expectedDay.setDate(expectedDay.getDate() - 1);
    assert.strictEqual(result.getDate(), expectedDay.getDate(), 'Day should be yesterday');
});

// ── LOOKBACK WITH NULL ────────────────────────────────────────────────────

console.log('\n── Lookback with Null Timestamps ──');

it('Test 19: isWithinLookback(null, 2) returns true — unknown timestamps are included', () => {
    const result = isWithinLookback(null, 2);
    assert.strictEqual(result, true, 'null timestamp should be treated as UNKNOWN and included');
});

// ── STRUCTURAL HEADLINE EDGE CASES ────────────────────────────────────────

console.log('\n── Structural Headline Edge Cases ──');

it('Test 20: Headline with role + openings — "Graduate Engineer Trainee | Multiple Openings"', () => {
    const text = 'Graduate Engineer Trainee | Multiple Openings across locations for fresh graduates from 2026 batch with strong fundamentals.';
    assert.strictEqual(isLegitimateJobMessage(text, []), true, 'Should accept: structural headline with role token + "openings" context');
    assert.strictEqual(detectStructuralHeadline(text), true, 'detectStructuralHeadline should return true');
});

// ── SUMMARY ───────────────────────────────────────────────────────────────

console.log('\n============================================================');
console.log(`   RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('============================================================\n');

if (failed > 0) {
    process.exit(1);
}
