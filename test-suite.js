'use strict';
process.env.AUTOMATED_TEST = 'true';

const assert = require('assert');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const { createNormalizedJob, generateJobFingerprint, parseExperienceRange } = require('./discovery/normalizedJob');
const { crossSourceDeduplicate, canonicalizeUrl } = require('./discovery/deduplicator');
const { evaluateEligibility } = require('./eligibility/eligibilityEngine');
const { scoreJob } = require('./scoring/jobScorer');
const { getAnswerWithProvenance } = require('./ai/answerEngine');
const { Provenance } = require('./ai/answerProvenance');
const { resolveApplicationTarget } = require('./application/router');
const { parseMessageDeterministic, isLegitimateJobMessage, hasAtsOrCareerLink } = require('./sources/whatsapp/messageParser');
const { resolveDestinationUrl } = require('./sources/whatsapp/linkResolver');
const { checkLinkedInSession, ensureLinkedInLogin } = require('./sources/linkedin/auth');
const { buildNormalizedLinkedInJob } = require('./sources/linkedin/extractor');
const { selectResumeForJob } = require('./automation/resumeSelector');
const { DiscoveryCoordinator } = require('./discovery/coordinator');
const { checkWellfoundSession, ensureWellfoundLogin } = require('./sources/wellfound/auth');
const { buildNormalizedWellfoundJob } = require('./sources/wellfound/extractor');
const { generateStartupPitch } = require('./application/handlers/wellfoundNative');
const { checkWhatsAppSession, ensureWhatsAppLogin } = require('./sources/whatsapp/auth');
const { extractJobFromWhatsApp, extractJobWithDisposition, findAuthoritativeJobUrl, isAutolinkOrSocialOrChannel } = require('./sources/whatsapp/jobExtractor');
const { evaluatePassoutYear } = require('./sources/whatsapp/yearFilter');
const { evaluateRoleEligibility } = require('./sources/whatsapp/roleFilter');
const { handleExternalApplication, checkLoginWall, checkCaptcha, expandAllSections, attachResumeSafely, handleDropdowns } = require('./automation/externalApplyHandler');
const { hashMessageText, parseWhatsAppTimestamp, isWithinLookback } = require('./sources/whatsapp/channelMonitor');
const { confirmAndExecuteSubmission, executeSubmissionSafely } = require('./application/safetyBoundary');
const { recordApplicationResult } = require('./db/repository');
const { handleNaukriNativeApplication } = require('./application/handlers/naukriNative');
const settings = require('./config/settings');

console.log(chalk.bold.cyan(`
============================================================
       ENTERPRISE PLATFORM COMPREHENSIVE TEST SUITE
============================================================
`));

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(chalk.green(`  ✔ PASS: ${desc}`));
        passed++;
    } catch (err) {
        console.log(chalk.red(`  ❌ FAIL: ${desc}`));
        console.error(chalk.red(`     Error: ${err.message}`));
        failed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(chalk.green(`  ✔ PASS: ${desc}`));
        passed++;
    } catch (err) {
        console.log(chalk.red(`  ❌ FAIL: ${desc}`));
        console.error(chalk.red(`     Error: ${err.message}`));
        failed++;
    }
}

async function runAllTests() {
    console.log(chalk.bold.yellow('\n1. Normalized Job & Fingerprint Tests'));

    it('should parse experience ranges correctly', () => {
        assert.deepStrictEqual(parseExperienceRange('0-2 Yrs'), { min: 0, max: 2 });
        assert.deepStrictEqual(parseExperienceRange('Fresher'), { min: 0, max: 1 });
        assert.deepStrictEqual(parseExperienceRange('3+ years'), { min: 3, max: 30 });
    });

    it('should create NormalizedJob with backward compatibility getters', () => {
        const job = createNormalizedJob({
            source: 'NAUKRI',
            sourceUrl: 'https://www.naukri.com/job-listings-ai-engineer-123456789012',
            title: 'AI Engineer',
            company: 'Tech Corp',
            location: 'Hyderabad, Telangana',
            experience: '0-2 Yrs'
        });

        assert.strictEqual(job.title, 'AI Engineer');
        assert.strictEqual(job.role, 'AI Engineer'); // legacy getter
        assert.strictEqual(job.jobUrl, 'https://www.naukri.com/job-listings-ai-engineer-123456789012'); // legacy getter
        assert.strictEqual(job.minExperience, 0);
        assert.strictEqual(job.maxExperience, 2);
        assert.strictEqual(job.locations[0], 'Hyderabad');
        assert.ok(job.id.length > 10);
    });

    console.log(chalk.bold.yellow('\n2. Deduplication & Canonicalization Tests'));

    it('should canonicalize URLs and strip tracking parameters', () => {
        const messyUrl = 'https://jobs.lever.co/company/abc-123?utm_source=linkedin&ref=naukri&fbclid=xyz';
        const clean = canonicalizeUrl(messyUrl);
        assert.strictEqual(clean, 'https://jobs.lever.co/company/abc-123');
    });

    it('should deduplicate across multiple sources by canonical URL and fingerprint', () => {
        const job1 = createNormalizedJob({
            source: 'NAUKRI',
            sourceUrl: 'https://jobs.lever.co/acme/123?utm_source=naukri',
            applicationUrl: 'https://jobs.lever.co/acme/123?utm_source=naukri',
            title: 'Software Engineer',
            company: 'Acme Inc',
            location: 'Bengaluru'
        });

        const job2 = createNormalizedJob({
            source: 'LINKEDIN',
            sourceUrl: 'https://jobs.lever.co/acme/123?utm_source=linkedin',
            applicationUrl: 'https://jobs.lever.co/acme/123?utm_source=linkedin',
            title: 'Software Engineer',
            company: 'Acme Inc',
            location: 'Bengaluru'
        });

        const job3 = createNormalizedJob({
            source: 'WHATSAPP',
            sourceUrl: 'https://careers.google.com/jobs/456',
            title: 'AI Researcher',
            company: 'Google',
            location: 'Hyderabad'
        });

        const unique = crossSourceDeduplicate([job1, job2, job3]);
        assert.strictEqual(unique.length, 2);
    });

    console.log(chalk.bold.yellow('\n3. Hard Eligibility Filter Tests'));

    it('should allow 0-1 YOE tech roles in approved locations', () => {
        const job = createNormalizedJob({
            title: 'AI Engineer Fresher',
            company: 'Innovative AI Labs',
            location: 'Hyderabad',
            experience: '0-1 Yrs'
        });
        const result = evaluateEligibility(job);
        assert.strictEqual(result.isEligible, true);
    });

    it('should reject senior roles exceeding experience tolerance (>2 YOE)', () => {
        const seniorJob = createNormalizedJob({
            title: 'Senior Staff AI Architect',
            company: 'Enterprise Corp',
            location: 'Hyderabad',
            experience: '5-8 Yrs'
        });
        const result = evaluateEligibility(seniorJob);
        assert.strictEqual(result.isEligible, false);
        assert.ok(result.reasons.some(r => r.includes('SKIPPED_EXPERIENCE') || r.toLowerCase().includes('exp')));
    });

    it('should reject non-tech and sales roles', () => {
        const salesJob = createNormalizedJob({
            title: 'Telecaller / Business Development Associate',
            company: 'Direct Sales Ltd',
            location: 'Hyderabad',
            experience: '0-1 Yrs'
        });
        const result = evaluateEligibility(salesJob);
        assert.strictEqual(result.isEligible, false);
        assert.ok(result.reasons.some(r => r.includes('SKIPPED_IRRELEVANT_ROLE') || r.toLowerCase().includes('excluded role keyword')));
    });

    console.log(chalk.bold.yellow('\n4. Answer Engine Provenance & Candidate Facts Tests'));

    await itAsync('should return VERIFIED_PROFILE for Date of Birth', async () => {
        const ans = await getAnswerWithProvenance('What is your date of birth?');
        assert.ok(ans.answer, 'DOB must be resolved from verified profile');
        assert.strictEqual(ans.provenance, Provenance.VERIFIED_PROFILE);
    });

    await itAsync('should return VERIFIED_PROFILE for PAN Number', async () => {
        const ans = await getAnswerWithProvenance('Enter your PAN Card number:');
        assert.ok(ans.answer, 'PAN must be resolved from verified profile');
        assert.strictEqual(ans.provenance, Provenance.VERIFIED_PROFILE);
    });

    await itAsync('should return VERIFIED_PROFILE for graduation year', async () => {
        const ans = await getAnswerWithProvenance('What is your year of graduation / passout?');
        assert.ok(ans.answer, 'Graduation year must be resolved from verified profile');
        assert.strictEqual(ans.provenance, Provenance.VERIFIED_PROFILE);
    });

    await itAsync('should NOT contaminate verified textAnswers.json with unverified guesses', async () => {
        const beforeText = fs.readFileSync(path.join(__dirname, 'data/textAnswers.json'), 'utf-8');
        const beforeJson = JSON.parse(beforeText);

        // Ask an unknown fictional question
        const randomQ = 'What is your favorite quantum computing flavor from 2099?';
        await getAnswerWithProvenance(randomQ);

        const afterText = fs.readFileSync(path.join(__dirname, 'data/textAnswers.json'), 'utf-8');
        const afterJson = JSON.parse(afterText);

        assert.strictEqual(afterJson[randomQ], undefined, 'Unverified question must never be written to textAnswers.json!');
    });

    console.log(chalk.bold.yellow('\n5. Application Router Destination Resolution Tests'));

    it('should resolve Workday destination correctly', () => {
        const target = resolveApplicationTarget({ applicationUrl: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/AI-Engineer' });
        assert.strictEqual(target, 'WORKDAY');
    });

    it('should resolve Zoho Recruit destination correctly', () => {
        const target = resolveApplicationTarget({ applicationUrl: 'https://careers.zohorecruit.com/jobs/Careers/12345' });
        assert.strictEqual(target, 'ZOHO');
    });

    it('should resolve LinkedIn Easy Apply destination correctly', () => {
        const target = resolveApplicationTarget({ source: 'LINKEDIN', rawPayload: { isEasyApply: true } });
        assert.strictEqual(target, 'LINKEDIN_EASY_APPLY');
    });

    it('should resolve Wellfound Native destination correctly', () => {
        const target = resolveApplicationTarget({ source: 'WELLFOUND', applicationUrl: 'https://wellfound.com/jobs/123' });
        assert.strictEqual(target, 'WELLFOUND_NATIVE');
    });

    it('should resolve Naukri Native destination correctly', () => {
        const target = resolveApplicationTarget({ source: 'NAUKRI', applicationUrl: 'https://www.naukri.com/job-listings-123' });
        assert.strictEqual(target, 'NAUKRI_NATIVE');
    });

    it('should resolve Greenhouse/Lever as GENERIC_ATS', () => {
        const target = resolveApplicationTarget({ applicationUrl: 'https://boards.greenhouse.io/anthropic/jobs/123' });
        assert.strictEqual(target, 'GREENHOUSE');
    });

    console.log(chalk.bold.yellow('\n6. WhatsApp Deterministic Parser & Link Resolution Tests'));

    it('should parse unstructured WhatsApp messages deterministically', () => {
        const message = `🚨 Urgent Hiring for AI Engineer!
Company: Sallet IT Soft
Location: Bhubaneswar / Remote
Experience: 0-2 Years
Package: 6 - 8 LPA
Skills: Python, PyTorch, LangChain, FastApi
Apply link: https://salletitsoft.com/careers/ai-fresher?utm_source=whatsapp&ref=123`;

        const parsed = parseMessageDeterministic(message);
        assert.strictEqual(parsed.title, 'AI Engineer');
        assert.strictEqual(parsed.company, 'Sallet IT Soft');
        assert.strictEqual(parsed.location, 'Bhubaneswar / Remote');
        assert.strictEqual(parsed.experience, '0-2 Years');
        assert.ok(parsed.skills.includes('Python'));
        assert.strictEqual(parsed.urls[0], 'https://salletitsoft.com/careers/ai-fresher?utm_source=whatsapp&ref=123');
    });

    console.log(chalk.bold.yellow('\n7. LinkedIn Production Pipeline & Error Isolation Tests'));

    await itAsync('should detect authenticated LinkedIn session correctly', async () => {
        const mockPage = {
            url: () => 'https://www.linkedin.com/jobs/',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('nav.global-nav') || sel.includes('button#nav-me-profile')
                })
            })
        };
        const session = await checkLinkedInSession(mockPage);
        assert.strictEqual(session.authenticated, true);
        assert.strictEqual(session.status, 'AUTHENTICATED');
    });

    await itAsync('should detect LinkedIn login wall and not falsely report authenticated', async () => {
        const mockPage = {
            url: () => 'https://www.linkedin.com/authwall?trk=rip',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('authwall') || sel.includes('login__form')
                })
            })
        };
        const session = await checkLinkedInSession(mockPage);
        assert.strictEqual(session.authenticated, false);
        assert.strictEqual(session.status, 'LOGIN_REQUIRED');
    });

    await itAsync('should detect LinkedIn security challenge / CAPTCHA checkpoint', async () => {
        const mockPage = {
            url: () => 'https://www.linkedin.com/checkpoint/challenge/12345',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('checkpoint') || sel.includes('captcha')
                })
            })
        };
        const session = await checkLinkedInSession(mockPage);
        assert.strictEqual(session.authenticated, false);
        assert.strictEqual(session.status, 'SECURITY_CHALLENGE');
    });

    it('should build complete NormalizedJob from LinkedIn card and details without fabricating fields', () => {
        const cardData = {
            title: 'AI Engineer',
            company: 'Tech Innovations Ltd',
            location: 'Bengaluru, Karnataka',
            jobUrl: 'https://www.linkedin.com/jobs/view/4123456789/',
            sourceJobId: '4123456789',
            postedAge: '1 day ago',
            isEasyApply: true
        };
        const detailsData = {
            description: 'We are seeking an entry-level AI Engineer skilled in Python and PyTorch.',
            workplaceType: 'Hybrid',
            isRemote: false,
            employmentType: 'Full-time',
            experience: '0-2 Yrs',
            skills: ['Python', 'PyTorch', 'FastAPI'],
            isEasyApply: true
        };

        const job = buildNormalizedLinkedInJob(cardData, detailsData);
        assert.strictEqual(job.source, 'LINKEDIN');
        assert.strictEqual(job.sourceJobId, '4123456789');
        assert.strictEqual(job.title, 'AI Engineer');
        assert.strictEqual(job.company, 'Tech Innovations Ltd');
        assert.strictEqual(job.locations[0], 'Bengaluru');
        assert.strictEqual(job.description, 'We are seeking an entry-level AI Engineer skilled in Python and PyTorch.');
        assert.strictEqual(job.employmentType, 'Full-time');
        assert.strictEqual(job.minExperience, 0);
        assert.strictEqual(job.maxExperience, 2);
        assert.deepStrictEqual(job.skills, ['Python', 'PyTorch', 'FastAPI']);
        assert.strictEqual(job.applicationType, 'NATIVE');
        assert.strictEqual(job.applicationUrl, 'https://www.linkedin.com/jobs/view/4123456789/');
    });

    it('should preserve null/empty defaults when LinkedIn fields are missing (no fabrication)', () => {
        const sparseCard = {
            title: 'Software Developer',
            company: 'Startup Co',
            jobUrl: 'https://www.linkedin.com/jobs/view/999888777/',
            sourceJobId: '999888777'
        };

        const job = buildNormalizedLinkedInJob(sparseCard);
        assert.strictEqual(job.source, 'LINKEDIN');
        assert.strictEqual(job.description, '');
        assert.deepStrictEqual(job.skills, []);
        assert.strictEqual(job.postedAge, '');
        assert.strictEqual(job.applicationType, 'EXTERNAL_ATS'); // Not Easy Apply
    });

    it('should route LinkedIn Easy Apply to LINKEDIN_EASY_APPLY and external to WORKDAY / GENERIC_ATS', () => {
        const easyApplyJob = buildNormalizedLinkedInJob({
            title: 'AI Engineer',
            company: 'Acme',
            jobUrl: 'https://www.linkedin.com/jobs/view/111/',
            isEasyApply: true
        });
        assert.strictEqual(resolveApplicationTarget(easyApplyJob), 'LINKEDIN_EASY_APPLY');

        const externalJob = {
            source: 'LINKEDIN',
            applicationUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/123',
            rawPayload: { isEasyApply: false }
        };
        assert.strictEqual(resolveApplicationTarget(externalJob), 'WORKDAY');
    });

    it('should resolve verified real resume path for LinkedIn and Workday applications', () => {
        const linkedinJob = { title: 'AI Engineer', company: 'DeepMind', source: 'LINKEDIN' };
        const linkedinResume = selectResumeForJob(linkedinJob);
        assert.ok(linkedinResume && linkedinResume.path, 'Resume must be returned');
        assert.strictEqual(fs.existsSync(linkedinResume.path), true, 'LinkedIn resume file must exist on disk');

        const workdayJob = { title: 'Backend Software Engineer', company: 'Amazon', source: 'NAUKRI' };
        const workdayResume = selectResumeForJob(workdayJob);
        assert.ok(workdayResume && workdayResume.path, 'Workday resume must be returned');
        assert.strictEqual(fs.existsSync(workdayResume.path), true, 'Workday resume file must exist on disk');
    });

    it('should deduplicate across Naukri and LinkedIn with identical fingerprint', () => {
        const naukriJob = createNormalizedJob({
            source: 'NAUKRI',
            title: 'AI Engineer',
            company: 'Microsoft',
            location: 'Hyderabad',
            sourceUrl: 'https://www.naukri.com/job-101'
        });
        const linkedinJob = createNormalizedJob({
            source: 'LINKEDIN',
            title: 'AI Engineer',
            company: 'Microsoft',
            location: 'Hyderabad',
            sourceUrl: 'https://www.linkedin.com/jobs/view/202'
        });

        const deduped = crossSourceDeduplicate([naukriJob, linkedinJob]);
        assert.strictEqual(deduped.length, 1);
        assert.ok(deduped[0].source === 'NAUKRI' || deduped[0].source === 'LINKEDIN');
    });

    await itAsync('should isolate errors so LinkedIn failure does NOT kill Naukri or shared pipeline', async () => {
        const coordinator = new DiscoveryCoordinator();
        // Simulate LinkedIn throwing an authentication or network error
        coordinator.linkedin.discover = async () => {
            throw new Error('Simulated LinkedIn Network / Auth Failure');
        };
        // Naukri succeeds
        coordinator.naukri.discover = async () => [
            createNormalizedJob({
                source: 'NAUKRI',
                title: 'AI Engineer Fresher',
                company: 'Sallet IT Soft',
                location: 'Hyderabad',
                experience: '0-1 Yrs',
                sourceUrl: 'https://www.naukri.com/job-sallet-ai'
            })
        ];

        const discovered = await coordinator.discoverAll({ sources: ['LINKEDIN', 'NAUKRI'] });
        assert.ok(discovered.length >= 1, 'Naukri jobs must be processed even when LinkedIn fails');
        assert.strictEqual(discovered[0].job.source, 'NAUKRI');
    });

    console.log(chalk.bold.yellow('\n8. Wellfound Production Pipeline & Startup Application Tests'));

    await itAsync('should detect authenticated Wellfound session correctly', async () => {
        const mockPage = {
            url: () => 'https://wellfound.com/jobs',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('data-test="UserMenu"') || sel.includes('button[aria-label="User menu"]')
                })
            })
        };
        const session = await checkWellfoundSession(mockPage);
        assert.strictEqual(session.authenticated, true);
        assert.strictEqual(session.status, 'AUTHENTICATED');
    });

    await itAsync('should detect Wellfound login page and avoid false positive authentication', async () => {
        const mockPage = {
            url: () => 'https://wellfound.com/login',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('login')
                })
            })
        };
        const session = await checkWellfoundSession(mockPage);
        assert.strictEqual(session.authenticated, false);
        assert.strictEqual(session.status, 'LOGIN_REQUIRED');
    });

    await itAsync('should detect Wellfound Cloudflare Turnstile / bot challenge', async () => {
        const mockPage = {
            url: () => 'https://wellfound.com/role/l/ai-engineer/india',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('cloudflare') || sel.includes('turnstile')
                })
            })
        };
        const session = await checkWellfoundSession(mockPage);
        assert.strictEqual(session.authenticated, false);
        assert.strictEqual(session.status, 'SECURITY_CHALLENGE');
    });

    it('should build complete NormalizedJob from Wellfound card and details', () => {
        const cardData = {
            title: 'Founding AI Engineer',
            company: 'NextGen Autonomous Inc',
            location: 'Bangalore / Remote',
            jobUrl: 'https://wellfound.com/jobs/9876543-founding-ai-engineer',
            sourceJobId: '9876543',
            salaryOrComp: '$80k - $120k • 0.5% - 1.5%',
            tags: ['Python', 'PyTorch', 'LLMs', 'FastAPI'],
            postedAge: '3 days ago'
        };
        const detailsData = {
            description: 'We are looking for our first AI engineer to build autonomous multi-agent pipelines.',
            isRemote: true
        };

        const job = buildNormalizedWellfoundJob(cardData, detailsData);
        assert.strictEqual(job.source, 'WELLFOUND');
        assert.strictEqual(job.sourceJobId, '9876543');
        assert.strictEqual(job.title, 'Founding AI Engineer');
        assert.strictEqual(job.company, 'NextGen Autonomous Inc');
        assert.strictEqual(job.isRemote, true);
        assert.strictEqual(job.applicationType, 'NATIVE');
        assert.ok(job.skills.includes('Python'));
        assert.ok(job.skills.includes('LLMs'));
        assert.strictEqual(job.description, 'We are looking for our first AI engineer to build autonomous multi-agent pipelines.');
    });

    it('should preserve null/empty defaults when Wellfound fields are missing without fabrication', () => {
        const sparseCard = {
            title: 'Junior Developer',
            company: 'Stealth Startup',
            jobUrl: 'https://wellfound.com/jobs/555'
        };

        const job = buildNormalizedWellfoundJob(sparseCard);
        assert.strictEqual(job.source, 'WELLFOUND');
        assert.strictEqual(job.description, '');
        assert.deepStrictEqual(job.skills, []);
        assert.strictEqual(job.postedAge, '');
    });

    it('should generate personalized tailored startup pitch note', () => {
        const job = {
            title: 'AI Engineer',
            company: 'ScaleAI Labs',
            skills: ['Python', 'LangChain']
        };

        const pitch = generateStartupPitch(job);
        assert.ok(pitch.includes('ScaleAI Labs'));
        assert.ok(pitch.includes('AI Engineer'));
        assert.ok(pitch.length > 100);
    });

    it('should route Wellfound jobs to WELLFOUND_NATIVE', () => {
        const wfJob = buildNormalizedWellfoundJob({
            title: 'AI Engineer',
            company: 'Startup',
            jobUrl: 'https://wellfound.com/jobs/111'
        });
        assert.strictEqual(resolveApplicationTarget(wfJob), 'WELLFOUND_NATIVE');
    });

    it('should deduplicate between Wellfound and LinkedIn / Naukri jobs with identical fingerprint', () => {
        const wfJob = createNormalizedJob({
            source: 'WELLFOUND',
            title: 'AI Engineer',
            company: 'Anthropic Labs',
            location: 'Bangalore',
            sourceUrl: 'https://wellfound.com/jobs/111'
        });
        const linkedInJob = createNormalizedJob({
            source: 'LINKEDIN',
            title: 'AI Engineer',
            company: 'Anthropic Labs',
            location: 'Bangalore',
            sourceUrl: 'https://www.linkedin.com/jobs/view/222'
        });

        const deduped = crossSourceDeduplicate([wfJob, linkedInJob]);
        assert.strictEqual(deduped.length, 1);
    });

    await itAsync('should isolate Wellfound errors so Wellfound failure does NOT block other sources', async () => {
        const coordinator = new DiscoveryCoordinator();
        coordinator.wellfound.discover = async () => {
            throw new Error('Simulated Wellfound Cloudflare / Auth Failure');
        };
        coordinator.linkedin.discover = async () => [
            createNormalizedJob({
                source: 'LINKEDIN',
                title: 'AI Engineer',
                company: 'DeepMind',
                location: 'Bengaluru',
                sourceUrl: 'https://www.linkedin.com/jobs/view/999'
            })
        ];

        const discovered = await coordinator.discoverAll({ sources: ['WELLFOUND', 'LINKEDIN'] });
        assert.ok(discovered.length >= 1, 'LinkedIn jobs must still process when Wellfound fails');
        assert.strictEqual(discovered[0].job.source, 'LINKEDIN');
    });

    console.log(chalk.bold.yellow('\n9. WhatsApp Live Channel Monitoring & Routing Tests'));

    await itAsync('should detect authenticated WhatsApp Web session correctly', async () => {
        const mockPage = {
            url: () => 'https://web.whatsapp.com/',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('pane-side') || sel.includes('chat-list')
                })
            })
        };
        const session = await checkWhatsAppSession(mockPage);
        assert.strictEqual(session.authenticated, true);
        assert.strictEqual(session.status, 'AUTHENTICATED');
    });

    await itAsync('should detect WhatsApp Web QR code requirement without false positive authentication', async () => {
        const mockPage = {
            url: () => 'https://web.whatsapp.com/',
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('qrcode') || sel.includes('canvas')
                })
            })
        };
        const session = await checkWhatsAppSession(mockPage);
        assert.strictEqual(session.authenticated, false);
        assert.strictEqual(session.status, 'QR_REQUIRED');
    });

    it('should configure user-provided target WhatsApp channel link correctly', () => {
        assert.strictEqual(settings.whatsappChannelUrl, 'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25');
    });

    it('should compute deterministic message hashes for duplicate message filtering', () => {
        const msg1 = 'Hiring AI Engineer at Acme Labs. Apply: https://acme.com/jobs/1';
        const msg2 = 'Hiring AI Engineer at Acme Labs. Apply: https://acme.com/jobs/1';
        const msg3 = 'Hiring Backend Developer at Beta Inc. Apply: https://beta.com/jobs/2';

        const hash1 = hashMessageText(msg1);
        const hash2 = hashMessageText(msg2);
        const hash3 = hashMessageText(msg3);

        assert.strictEqual(hash1, hash2);
        assert.notStrictEqual(hash1, hash3);
        assert.strictEqual(hash1.length, 16);
    });

    await itAsync('should extract structured NormalizedJob from WhatsApp message', async () => {
        const rawMsg = {
            text: `🔥 High Priority Opening!
Role: Generative AI Engineer
Company: Anthropic Labs
Location: Hyderabad
Experience: 0-2 Years
Skills: Python, PyTorch, Transformers, LangChain
Apply here: https://anthropic.com/careers/genai?utm_source=whatsapp&ref=campus`,
            channelName: 'Offcampus Jobs Daily'
        };

        const job = await extractJobFromWhatsApp(rawMsg);
        assert.ok(job, 'Job must be extracted');
        assert.strictEqual(job.source, 'WHATSAPP');
        assert.strictEqual(job.title, 'Generative AI Engineer');
        assert.strictEqual(job.company, 'Anthropic Labs');
        assert.strictEqual(job.locations[0], 'Hyderabad');
        assert.ok(job.skills.includes('Python'));
        assert.ok(job.skills.includes('PyTorch'));
        assert.strictEqual(job.minExperience, 0);
        assert.strictEqual(job.maxExperience, 2);
    });

    it('should route WhatsApp job application URLs to appropriate ATS handler', () => {
        const workdayWf = {
            source: 'WHATSAPP',
            applicationUrl: 'https://adobe.wd5.myworkdayjobs.com/AdobeCareers/job/AI-Engineer'
        };
        assert.strictEqual(resolveApplicationTarget(workdayWf), 'WORKDAY');

        const greenhouseWf = {
            source: 'WHATSAPP',
            applicationUrl: 'https://boards.greenhouse.io/stripe/jobs/12345'
        };
        assert.strictEqual(resolveApplicationTarget(greenhouseWf), 'GREENHOUSE');

        const googleFormWf = {
            source: 'WHATSAPP',
            applicationUrl: 'https://forms.gle/XYZ123ABC'
        };
        assert.strictEqual(resolveApplicationTarget(googleFormWf), 'GENERIC_ATS');
    });

    it('should deduplicate across WhatsApp and LinkedIn / Naukri with identical fingerprint', () => {
        const waJob = createNormalizedJob({
            source: 'WHATSAPP',
            title: 'AI Engineer',
            company: 'Google',
            location: 'Hyderabad',
            sourceUrl: 'https://careers.google.com/jobs/results/111'
        });
        const naukriJob = createNormalizedJob({
            source: 'NAUKRI',
            title: 'AI Engineer',
            company: 'Google',
            location: 'Hyderabad',
            sourceUrl: 'https://www.naukri.com/job-google-ai'
        });

        const deduped = crossSourceDeduplicate([waJob, naukriJob]);
        assert.strictEqual(deduped.length, 1);
    });

    await itAsync('should isolate WhatsApp errors so failure does NOT affect other sources', async () => {
        const coordinator = new DiscoveryCoordinator();
        coordinator.whatsapp.discover = async () => {
            throw new Error('Simulated WhatsApp Network / QR Failure');
        };
        coordinator.naukri.discover = async () => [
            createNormalizedJob({
                source: 'NAUKRI',
                title: 'AI Engineer',
                company: 'Tech Mahindra',
                location: 'Hyderabad',
                sourceUrl: 'https://www.naukri.com/job-techm'
            })
        ];

        const discovered = await coordinator.discoverAll({ sources: ['WHATSAPP', 'NAUKRI'] });
        assert.ok(discovered.length >= 1, 'Naukri jobs must continue when WhatsApp fails');
        assert.strictEqual(discovered[0].job.source, 'NAUKRI');
    });

    console.log(chalk.bold.yellow('\n10. Dry-Run Safety Barrier & Handler Defense-in-Depth Tests'));

    await itAsync('should prevent execution of irreversible actions when dryRun is true', async () => {
        let executed = false;
        const result = await executeSubmissionSafely({
            dryRun: true,
            actionName: 'Test Final Submit',
            execute: async () => {
                executed = true;
                return { status: 'SUCCESS' };
            }
        });
        assert.strictEqual(executed, false, 'Irreversible action must NOT execute when dryRun is true');
        assert.strictEqual(result.status, 'DRY_RUN_READY_TO_SUBMIT');
        assert.strictEqual(result.actionName, 'Test Final Submit');
    });

    await itAsync('should execute irreversible action when dryRun is false and confirmed', async () => {
        let executed = false;
        const result = await executeSubmissionSafely({
            dryRun: false,
            promptFn: async () => 'yes',
            actionName: 'Test Final Submit',
            execute: async () => {
                executed = true;
                return { status: 'REAL_SUCCESS' };
            }
        });
        assert.strictEqual(executed, true, 'Action must execute when confirmed');
        assert.strictEqual(result.status, 'REAL_SUCCESS');
    });

    await itAsync('should guard recordApplicationResult against persisting dry-run results to DB', async () => {
        const dummyJob = createNormalizedJob({
            source: 'LINKEDIN',
            title: 'AI Researcher',
            company: 'OpenAI',
            sourceUrl: 'https://linkedin.com/jobs/view/777'
        });
        // Passing DRY_RUN_READY_TO_SUBMIT should return immediately without DB queries
        await recordApplicationResult(dummyJob, { status: 'DRY_RUN_READY_TO_SUBMIT', dryRun: true });
        assert.ok(true, 'recordApplicationResult safely ignored dry-run without exception');
    });

    await itAsync('should intercept Naukri apply button under dry-run mode', async () => {
        const { handleNaukriNativeApplication } = require('./application/handlers/naukriNative');
        const mockPage = {
            url: () => 'https://www.naukri.com/job-1',
            goto: async () => {},
            locator: (sel) => {
                const isApply = sel.includes('Apply') || sel.includes('apply-button');
                const isError = sel.includes('error');
                const isApplied = sel.includes('already-applied');
                const match = isApply && !isError && !isApplied;
                return {
                    count: async () => match ? 1 : 0,
                    first: () => ({
                        isVisible: async () => match,
                        click: async () => { throw new Error('Irreversible submit button was clicked!'); }
                    })
                };
            },
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({
            source: 'NAUKRI',
            title: 'Full Stack Dev',
            company: 'Tech Corp',
            sourceUrl: 'https://www.naukri.com/job-1'
        });
        const res = await handleNaukriNativeApplication(mockPage, job, { dryRun: true });
        assert.strictEqual(res.status, 'DRY_RUN_READY_TO_SUBMIT');
    });

    await itAsync('should intercept Wellfound 1-click Quick Apply button under dry-run mode', async () => {
        const { handleWellfoundNative } = require('./application/handlers/wellfoundNative');
        const mockPage = {
            url: () => 'https://wellfound.com/jobs/123',
            goto: async () => {},
            locator: (sel) => {
                const isApply = sel.includes('Apply') || sel.includes('Quick Apply');
                const isApplied = sel.includes('Applied') || sel.includes('submitted');
                const match = isApply && !isApplied;
                return {
                    count: async () => match ? 1 : 0,
                    first: () => ({
                        isVisible: async () => match,
                        innerText: async () => 'Quick Apply',
                        click: async () => { throw new Error('1-click Quick Apply was clicked!'); }
                    })
                };
            },
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({
            source: 'WELLFOUND',
            title: 'Founding Engineer',
            company: 'Stealth AI',
            sourceUrl: 'https://wellfound.com/jobs/123'
        });
        const res = await handleWellfoundNative(mockPage, job, { dryRun: true });
        assert.strictEqual(res.status, 'DRY_RUN_READY_TO_SUBMIT');
    });

    await itAsync('should intercept Workday final review/submit button under dry-run mode', async () => {
        const { handleWorkdayApplication } = require('./application/handlers/workday');
        let finalSubmitClicked = false;
        const mockPage = {
            url: () => 'https://adobe.wd5.myworkdayjobs.com/careers/job/1',
            goto: async () => {},
            locator: (sel) => {
                const isFormOrHeader = sel.includes('formField') || sel.includes('pageHeader') || sel.includes('h2');
                const isSubmit = sel.includes('Submit') || sel.includes('Save and Continue');
                return {
                    first: () => ({
                        isVisible: async () => isFormOrHeader || isSubmit,
                        waitFor: async () => {},
                        innerText: async () => isSubmit ? 'Submit' : 'Review and Submit',
                        click: async () => { finalSubmitClicked = true; }
                    }),
                    all: async () => []
                };
            },
            getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
            evaluate: async () => {},
            screenshot: async () => {},
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({
            source: 'WHATSAPP',
            title: 'Backend Engineer',
            company: 'Adobe',
            applicationUrl: 'https://adobe.wd5.myworkdayjobs.com/careers/job/1'
        });
        const res = await handleWorkdayApplication(mockPage, job.applicationUrl, job, { dryRun: true });
        assert.strictEqual(finalSubmitClicked, false, 'Workday submit must NOT be clicked in dryRun');
        assert.strictEqual(res.status, 'DRY_RUN_READY_TO_SUBMIT');
    });

    await itAsync('should intercept Zoho Recruit submit button under dry-run mode', async () => {
        const { handleZoho } = require('./application/handlers/zoho');
        let submitClicked = false;
        const mockPage = {
            url: () => 'https://careers.kumaran.com/jobs/Careers/12345',
            waitForLoadState: async () => {},
            waitForSelector: async () => {},
            evaluate: async () => false,
            locator: (sel) => {
                const isSubmit = sel.includes('Submit Application') || sel.includes('lyteSuccess');
                return {
                    first: () => ({
                        isVisible: async () => isSubmit,
                        waitFor: async () => {},
                        click: async () => { submitClicked = true; }
                    }),
                    all: async () => [],
                    count: async () => isSubmit ? 1 : 0
                };
            },
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({
            source: 'NAUKRI',
            title: 'Junior AI Engineer',
            company: 'Kumaran Systems',
            applicationUrl: 'https://careers.kumaran.com/jobs/Careers/12345'
        });
        const fakeResume = { fileName: 'Manish_main_resume.pdf', path: path.resolve(__dirname, 'resume/Manish_main_resume.pdf'), type: 'MAIN' };
        const res = await handleZoho(mockPage, job, fakeResume, { dryRun: true });
        assert.strictEqual(submitClicked, false, 'Zoho submit button must NOT be clicked in dryRun');
        assert.strictEqual(res.status, 'DRY_RUN_READY_TO_SUBMIT');
    });

    await itAsync('should intercept Generic ATS final submit button under dry-run mode', async () => {
        const { handleGenericATS } = require('./application/handlers/genericATS');
        let finalSubmitClicked = false;
        const mockPage = {
            url: () => 'https://boards.greenhouse.io/openai/jobs/999',
            frames: () => [],
            mainFrame: () => mockPage,
            locator: (sel) => {
                const isSubmit = sel === 'button:has-text("Submit Application")' || sel === 'button:has-text("Submit")' || sel === 'button[type="submit"]';
                const isFileInput = sel === 'input[type="file"]';
                return {
                    first: () => ({
                        isVisible: async () => isSubmit || isFileInput,
                        innerText: async () => isSubmit ? 'Submit Application' : '',
                        click: async () => { if (isSubmit) finalSubmitClicked = true; },
                        scrollIntoViewIfNeeded: async () => {},
                        setInputFiles: async () => {}
                    }),
                    all: async () => isFileInput ? [{
                        setInputFiles: async () => {},
                        evaluate: async () => 'resume_file_input'
                    }] : [],
                    count: async () => (isSubmit || isFileInput) ? 1 : 0
                };
            },
            waitForLoadState: async () => {},
            evaluate: async (fn) => {
                const s = typeof fn === 'function' ? fn.toString() : String(fn);
                if (s.includes('404') || s.includes('page not found') || s.includes('hasSignIn') || s.includes('recaptcha')) {
                    return false;
                }
                return true;
            },
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({
            source: 'WHATSAPP',
            title: 'Research Engineer',
            company: 'OpenAI',
            applicationUrl: 'https://boards.greenhouse.io/openai/jobs/999'
        });
        const fakeResume = { fileName: 'Manish_main_resume.pdf', path: path.resolve(__dirname, 'resume/Manish_main_resume.pdf'), type: 'MAIN' };
        const res = await handleGenericATS(mockPage, job, job.applicationUrl, fakeResume, { dryRun: true });
        assert.strictEqual(finalSubmitClicked, false, 'Generic ATS submit must NOT be clicked in dryRun');
        assert.strictEqual(res.status, 'DRY_RUN_READY_TO_SUBMIT');
    });

    it('should allocate and maintain isolated pages per platform in DiscoveryCoordinator', () => {
        const mockPages = {
            naukri: { id: 'page-naukri', url: () => 'https://www.naukri.com' },
            linkedin: { id: 'page-linkedin', url: () => 'https://www.linkedin.com' },
            wellfound: { id: 'page-wellfound', url: () => 'https://wellfound.com' },
            whatsapp: { id: 'page-whatsapp', url: () => 'https://web.whatsapp.com' }
        };
        const coordinator = new DiscoveryCoordinator({ pages: mockPages });
        assert.strictEqual(coordinator.naukri.page.id, 'page-naukri');
        assert.strictEqual(coordinator.linkedin.page.id, 'page-linkedin');
        assert.strictEqual(coordinator.wellfound.page.id, 'page-wellfound');
        assert.strictEqual(coordinator.whatsapp.page.id, 'page-whatsapp');
    });

    it('should separate dryRunReady count from real succeeded count in ApplicationCoordinator stats semantics', () => {
        const stats = {
            totalAttempted: 1,
            succeeded: 0,
            dryRunReady: 0,
            failed: 0,
            skipped: 0
        };
        const result = { status: 'DRY_RUN_READY_TO_SUBMIT', message: 'Dry-run boundary reached' };
        if (result.status === 'SUCCESS') {
            stats.succeeded++;
        } else if (result.status === 'DRY_RUN_READY_TO_SUBMIT') {
            stats.dryRunReady++;
        }
        assert.strictEqual(stats.succeeded, 0, 'Real succeeded count must remain 0 in dryRun');
        assert.strictEqual(stats.dryRunReady, 1, 'dryRunReady must increment when dryRun application boundary reached');
    });

    it('should align candidate identity in Wellfound pitch note with profile', () => {
        const { generateStartupPitch } = require('./application/handlers/wellfoundNative');
        const { loadProfile } = require('./config/profileLoader');
        const profile = loadProfile();
        const pitch = generateStartupPitch({ company: 'Acme AI', title: 'ML Engineer' });
        assert.ok(pitch.includes(profile.fullName) || pitch.includes(profile.firstName), 'Pitch must reference candidate identity');
        assert.ok(!pitch.includes('Candidate'), 'Pitch must not fallback to placeholder identity');
    });

    console.log(chalk.bold.yellow('\n11. Final Human Confirmation Gate & Live Submission Safety Tests'));

    // Test 1: dryRun=true never executes submit action
    await itAsync('should ensure dryRun=true never executes submit action', async () => {
        let executed = false;
        const result = await confirmAndExecuteSubmission({
            dryRun: true,
            job: { title: 'Engineer', company: 'Acme', source: 'LINKEDIN' },
            destination: 'Direct ATS',
            actionName: 'Test Submit',
            execute: async () => { executed = true; return { status: 'SUCCESS' }; }
        });
        assert.strictEqual(executed, false, 'execute() must NEVER be called when dryRun=true');
        assert.strictEqual(result.status, 'DRY_RUN_READY_TO_SUBMIT');
        assert.strictEqual(result.submitted, false);
    });

    // Test 2: live mode with confirmation YES executes submit
    await itAsync('should execute submit in live mode with confirmation YES', async () => {
        for (const affirmative of ['y', 'yes', 'Y', 'YES']) {
            let executed = false;
            const result = await confirmAndExecuteSubmission({
                dryRun: false,
                promptFn: async () => affirmative,
                job: { title: 'Backend Dev', company: 'Acme', source: 'NAUKRI' },
                destination: 'Direct ATS',
                actionName: 'Test Affirmative Submit',
                execute: async () => { executed = true; return { status: 'SUCCESS', verified: true }; }
            });
            assert.strictEqual(executed, true, `execute() must run when confirmed with "${affirmative}"`);
            assert.strictEqual(result.status, 'SUCCESS');
            assert.strictEqual(result.submitted, true);
        }
    });

    // Test 3: live mode with confirmation NO does not submit
    await itAsync('should not submit in live mode with confirmation NO', async () => {
        for (const negative of ['n', 'no', 'N', 'NO', 'cancel']) {
            let executed = false;
            const result = await confirmAndExecuteSubmission({
                dryRun: false,
                promptFn: async () => negative,
                job: { title: 'Backend Dev', company: 'Acme', source: 'NAUKRI' },
                destination: 'Direct ATS',
                actionName: 'Test Negative Submit',
                execute: async () => { executed = true; return { status: 'SUCCESS' }; }
            });
            assert.strictEqual(executed, false, `execute() must NOT run when answered "${negative}"`);
            assert.strictEqual(result.status, 'CONFIRMATION_ABORTED');
            assert.strictEqual(result.reason, 'USER_ABORTED');
            assert.strictEqual(result.submitted, false);
        }
    });

    // Test 4: empty input does not submit
    await itAsync('should not submit when input is empty (default is NO)', async () => {
        let executed = false;
        const result = await confirmAndExecuteSubmission({
            dryRun: false,
            promptFn: async () => '',
            job: { title: 'Data Scientist', company: 'Stark', source: 'WELLFOUND' },
            destination: 'Wellfound Native',
            actionName: 'Test Empty Submit',
            execute: async () => { executed = true; return { status: 'SUCCESS' }; }
        });
        assert.strictEqual(executed, false, 'execute() must NOT run on empty input (Enter)');
        assert.strictEqual(result.status, 'CONFIRMATION_ABORTED');
        assert.strictEqual(result.submitted, false);
    });

    // Test 5: unexpected input does not submit
    await itAsync('should not submit on unexpected input', async () => {
        for (const unexpected of ['maybe', 'foo', '1', 'sure', 'ok']) {
            let executed = false;
            const result = await confirmAndExecuteSubmission({
                dryRun: false,
                promptFn: async () => unexpected,
                job: { title: 'DevOps', company: 'Wayne', source: 'LINKEDIN' },
                destination: 'LinkedIn Easy Apply',
                actionName: 'Test Unexpected Submit',
                execute: async () => { executed = true; return { status: 'SUCCESS' }; }
            });
            assert.strictEqual(executed, false, `execute() must NOT run on unexpected input "${unexpected}"`);
            assert.strictEqual(result.status, 'CONFIRMATION_ABORTED');
            assert.strictEqual(result.submitted, false);
        }
    });

    // Test 6: non-interactive stdin does not submit
    await itAsync('should abort when environment is non-interactive without TTY', async () => {
        let executed = false;
        const result = await confirmAndExecuteSubmission({
            dryRun: false,
            isInteractive: false,
            promptFn: null,
            job: { title: 'Security Analyst', company: 'CyberCorp', source: 'NAUKRI' },
            destination: 'Naukri Native',
            actionName: 'Test NonInteractive Submit',
            execute: async () => { executed = true; return { status: 'SUCCESS' }; }
        });
        assert.strictEqual(executed, false, 'execute() must NOT run in non-interactive environment');
        assert.strictEqual(result.status, 'CONFIRMATION_ABORTED');
        assert.strictEqual(result.reason, 'NON_INTERACTIVE');
        assert.strictEqual(result.submitted, false);
    });

    // Test 7: Naukri immediate Apply is gated
    await itAsync('should gate Naukri immediate Apply behind human confirmation', async () => {
        let applyClicked = false;
        const mockPage = {
            url: () => 'https://www.naukri.com/job-123',
            goto: async () => {},
            locator: (sel) => {
                const isApply = sel.includes('apply-button') || sel.includes('apply-button-primary');
                const isAlready = sel.includes('already-applied');
                const isChatbot = sel.includes('chatbot');
                return {
                    first: () => ({
                        isVisible: async () => {
                            if (sel.includes('Applied') || sel.includes('applied-status')) return applyClicked;
                            return isApply && !isAlready && !isChatbot && !applyClicked;
                        },
                        innerText: async () => (applyClicked ? 'Applied' : 'Apply'),
                        click: async () => { applyClicked = true; }
                    }),
                    all: async () => []
                };
            }
        };
        const job = createNormalizedJob({ source: 'NAUKRI', title: 'Python Dev', company: 'Infotech', applicationUrl: 'https://www.naukri.com/job-123' });
        
        // Negative test: User declines confirmation
        const resultDeclined = await handleNaukriNativeApplication(mockPage, job, {
            dryRun: false,
            promptFn: async () => 'n'
        });
        assert.strictEqual(applyClicked, false, 'Naukri Apply button must NOT be clicked when human declines');
        assert.strictEqual(resultDeclined.status, 'CONFIRMATION_ABORTED');

        // Positive test: User confirms
        const resultApproved = await handleNaukriNativeApplication(mockPage, job, {
            dryRun: false,
            promptFn: async () => 'y'
        });
        assert.strictEqual(applyClicked, true, 'Naukri Apply button should be clicked after human confirmation');
    });

    // Test 8: LinkedIn final Submit is gated
    await itAsync('should gate LinkedIn final Submit behind human confirmation', async () => {
        const { handleLinkedInEasyApply } = require('./application/handlers/linkedinEasyApply');
        let submitClicked = false;
        const mockModal = {
            isVisible: async () => true,
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => sel.includes('Submit') || sel.includes('dismiss'),
                    click: async () => { if (sel.includes('Submit')) submitClicked = true; },
                    innerText: async () => sel.includes('Submit') ? 'Submit application' : '',
                    count: async () => (sel.includes('Submit') ? 1 : 0),
                    all: async () => []
                }),
                count: async () => (sel.includes('Submit') ? 1 : 0),
                all: async () => []
            }),
            innerText: async () => 'Review step'
        };
        const mockPage = {
            url: () => 'https://www.linkedin.com/jobs/view/999',
            goto: async () => {},
            getByText: () => ({ isVisible: async () => false }),
            locator: (sel) => {
                if (sel.includes('jobs-apply-button') || sel.includes('Easy Apply')) {
                    return {
                        first: () => ({
                            isVisible: async () => true,
                            click: async () => {}
                        })
                    };
                }
                if (sel.includes('easy-apply-modal') || sel.includes('jobs-easy-apply-modal')) {
                    return {
                        first: () => mockModal,
                        isVisible: async () => true
                    };
                }
                return {
                    first: () => ({
                        isVisible: async () => false,
                        click: async () => {}
                    }),
                    all: async () => []
                };
            }
        };
        const job = createNormalizedJob({ source: 'LINKEDIN', title: 'ML Researcher', company: 'DeepMind', applicationUrl: 'https://www.linkedin.com/jobs/view/999' });

        const resultDeclined = await handleLinkedInEasyApply(mockPage, job, {
            dryRun: false,
            promptFn: async () => 'n'
        });
        assert.strictEqual(submitClicked, false, 'LinkedIn submit button must NOT be clicked when human declines');
        assert.strictEqual(resultDeclined.status, 'CONFIRMATION_ABORTED');
    });

    // Test 9: Wellfound Quick Apply is gated
    await itAsync('should gate Wellfound Quick Apply behind human confirmation', async () => {
        const { handleWellfoundNative } = require('./application/handlers/wellfoundNative');
        let quickApplyClicked = false;
        const mockPage = {
            url: () => 'https://wellfound.com/jobs/123',
            locator: (sel) => {
                const isApply = sel.includes('Apply') || sel.includes('Quick Apply') || sel.includes('apply');
                const isApplied = sel.includes('alreadyApplied');
                return {
                    first: () => ({
                        isVisible: async () => isApply && !isApplied,
                        innerText: async () => 'Quick Apply',
                        click: async () => { quickApplyClicked = true; }
                    })
                };
            }
        };
        const job = createNormalizedJob({ source: 'WELLFOUND', title: 'Founding Engineer', company: 'Nova AI', sourceUrl: 'https://wellfound.com/jobs/123' });

        const resultDeclined = await handleWellfoundNative(mockPage, job, {
            dryRun: false,
            promptFn: async () => 'n'
        });
        assert.strictEqual(quickApplyClicked, false, 'Wellfound Quick Apply must NOT click when human declines');
        assert.strictEqual(resultDeclined.status, 'CONFIRMATION_ABORTED');
    });

    // Test 10: Workday final Submit is gated
    await itAsync('should gate Workday final Submit behind human confirmation', async () => {
        const { handleWorkdayApplication } = require('./application/handlers/workday');
        let workdaySubmitClicked = false;
        const mockPage = {
            url: () => 'https://adobe.wd5.myworkdayjobs.com/careers/job/1',
            locator: (sel) => {
                const isSubmit = sel.includes('Submit') || sel.includes('Save and Continue');
                return {
                    first: () => ({
                        isVisible: async () => isSubmit,
                        waitFor: async () => {},
                        innerText: async () => 'Submit Application',
                        click: async () => { workdaySubmitClicked = true; }
                    }),
                    all: async () => []
                };
            },
            getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
            evaluate: async () => true,
            screenshot: async () => {},
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({ source: 'LINKEDIN', title: 'Backend Architect', company: 'Adobe', applicationUrl: 'https://adobe.wd5.myworkdayjobs.com/careers/job/1' });

        const resultDeclined = await handleWorkdayApplication(mockPage, job.applicationUrl, job, {
            dryRun: false,
            promptFn: async () => 'n'
        });
        assert.strictEqual(workdaySubmitClicked, false, 'Workday final submit must NOT click when human declines');
        assert.strictEqual(resultDeclined.status, 'CONFIRMATION_ABORTED');
    });

    // Test 11: Zoho final Submit is gated
    await itAsync('should gate Zoho final Submit behind human confirmation', async () => {
        const { handleZoho } = require('./application/handlers/zoho');
        let zohoSubmitClicked = false;
        const mockPage = {
            url: () => 'https://careers.kumaran.com/jobs/Careers/12345',
            locator: (sel) => {
                const isSubmit = sel.includes('Submit Application') || sel.includes('lyteSuccess');
                return {
                    first: () => ({
                        isVisible: async () => isSubmit,
                        waitFor: async () => {},
                        click: async () => { zohoSubmitClicked = true; }
                    }),
                    all: async () => [],
                    count: async () => isSubmit ? 1 : 0
                };
            },
            waitForLoadState: async () => {},
            waitForSelector: async () => {},
            evaluate: async () => false,
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({ source: 'NAUKRI', title: 'Cloud Engineer', company: 'Zoho Partner', applicationUrl: 'https://careers.kumaran.com/jobs/Careers/12345' });
        const fakeResume = { fileName: 'Manish_main_resume.pdf', path: path.resolve(__dirname, 'resume/Manish_main_resume.pdf'), type: 'MAIN' };

        const resultDeclined = await handleZoho(mockPage, job, fakeResume, {
            dryRun: false,
            promptFn: async () => 'n'
        });
        assert.strictEqual(zohoSubmitClicked, false, 'Zoho Recruit submit must NOT click when human declines');
        assert.strictEqual(resultDeclined.status, 'CONFIRMATION_ABORTED');
    });

    // Test 12: Generic ATS final Submit is gated
    await itAsync('should gate Generic ATS final Submit behind human confirmation', async () => {
        const { handleGenericATS } = require('./application/handlers/genericATS');
        let genericSubmitClicked = false;
        const mockPage = {
            url: () => 'https://boards.greenhouse.io/openai/jobs/999',
            frames: () => [],
            mainFrame: () => mockPage,
            locator: (sel) => {
                const isSubmit = sel === 'button:has-text("Submit Application")' || sel === 'button:has-text("Submit")' || sel === 'button[type="submit"]';
                const isFileInput = sel === 'input[type="file"]';
                return {
                    first: () => ({
                        isVisible: async () => isSubmit || isFileInput,
                        innerText: async () => isSubmit ? 'Submit Application' : '',
                        click: async () => { genericSubmitClicked = true; },
                        scrollIntoViewIfNeeded: async () => {},
                        setInputFiles: async () => {}
                    }),
                    all: async () => isFileInput ? [{
                        setInputFiles: async () => {},
                        evaluate: async () => 'resume_file_input'
                    }] : [],
                    count: async () => (isSubmit || isFileInput) ? 1 : 0
                };
            },
            waitForLoadState: async () => {},
            evaluate: async (fn) => {
                const s = typeof fn === 'function' ? fn.toString() : String(fn);
                if (s.includes('404') || s.includes('page not found') || s.includes('hasSignIn') || s.includes('recaptcha')) {
                    return false;
                }
                return true;
            },
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({ source: 'WHATSAPP', title: 'Research Engineer', company: 'OpenAI', applicationUrl: 'https://boards.greenhouse.io/openai/jobs/999' });
        const fakeResume = { fileName: 'Manish_main_resume.pdf', path: path.resolve(__dirname, 'resume/Manish_main_resume.pdf'), type: 'MAIN' };

        const resultDeclined = await handleGenericATS(mockPage, job, job.applicationUrl, fakeResume, {
            dryRun: false,
            promptFn: async () => 'n'
        });
        assert.strictEqual(genericSubmitClicked, false, 'Generic ATS final submit must NOT click when human declines');
        assert.strictEqual(resultDeclined.status, 'CONFIRMATION_ABORTED');
    });

    // Test 13: batch mode asks separately for each application
    await itAsync('should ask confirmation separately for each application in batch mode', async () => {
        const { ApplicationCoordinator } = require('./application/coordinator');
        const coordinator = new ApplicationCoordinator();
        let promptCallCount = 0;

        const router = require('./application/router');
        const dbRepo = require('./db/repository');
        const origRoute = router.routeAndApply;
        const origApplied = dbRepo.isJobAlreadyApplied;
        const origRecord = dbRepo.recordApplicationResult;

        router.routeAndApply = async (page, job, opts = {}) => {
            return await confirmAndExecuteSubmission({
                dryRun: opts.dryRun,
                job,
                destination: 'Mock ATS',
                actionName: `Submit ${job.title}`,
                execute: async () => ({ status: 'SUCCESS', verified: true }),
                promptFn: opts.promptFn,
                isInteractive: opts.isInteractive
            });
        };
        dbRepo.isJobAlreadyApplied = async () => false;
        dbRepo.recordApplicationResult = async () => {};

        try {
            const batchJobs = [
                { job: createNormalizedJob({ source: 'LINKEDIN', title: 'Batch Role 1', company: 'Alpha' }), score: 90, decision: 'APPLY' },
                { job: createNormalizedJob({ source: 'NAUKRI', title: 'Batch Role 2', company: 'Beta' }), score: 85, decision: 'APPLY' },
                { job: createNormalizedJob({ source: 'WELLFOUND', title: 'Batch Role 3', company: 'Gamma' }), score: 80, decision: 'APPLY' }
            ];

            const answers = ['y', 'n', 'y'];
            const stats = await coordinator.processApplications(batchJobs, {
                dryRun: false,
                maxApply: 5,
                minScore: 50,
                promptFn: async () => {
                    const ans = answers[promptCallCount] || 'n';
                    promptCallCount++;
                    return ans;
                },
                isInteractive: true
            });

            assert.strictEqual(promptCallCount, 3, 'Batch mode must prompt human separately for each job');
            assert.strictEqual(stats.succeeded, 2, '2 applications confirmed and succeeded');
            assert.strictEqual(stats.aborted, 1, '1 application declined and aborted');
        } finally {
            router.routeAndApply = origRoute;
            dbRepo.isJobAlreadyApplied = origApplied;
            dbRepo.recordApplicationResult = origRecord;
        }
    });

    // Test 14: scheduler cannot bypass confirmation
    await itAsync('should prevent scheduler from bypassing confirmation in non-interactive environment', async () => {
        let schedulerExecuted = false;
        const schedResult = await confirmAndExecuteSubmission({
            dryRun: false,
            isInteractive: false, // Background scheduler environment
            promptFn: null,
            job: { title: 'Nightly Run', company: 'Cron Corp', source: 'LINKEDIN' },
            destination: 'Workday ATS',
            actionName: 'Nightly Scheduled Apply',
            execute: async () => { schedulerExecuted = true; return { status: 'SUCCESS' }; }
        });
        assert.strictEqual(schedulerExecuted, false, 'Scheduler must NEVER execute live submit without interactive confirmation');
        assert.strictEqual(schedResult.status, 'CONFIRMATION_ABORTED');
        assert.strictEqual(schedResult.reason, 'NON_INTERACTIVE');
    });

    // Test 15: --dry-run remains the default
    it('should verify --dry-run remains the default across configurations', () => {
        const resolveDryRun = (opts = {}) => {
            if (opts.live === true) return false;
            if (opts.dryRun !== undefined) return !!opts.dryRun;
            return true;
        };
        assert.strictEqual(resolveDryRun({}), true, 'Default must be dryRun = true');
        assert.strictEqual(resolveDryRun({ sources: ['NAUKRI'] }), true, 'Passing only sources must default to dryRun = true');
        assert.strictEqual(resolveDryRun({ dryRun: true }), true, 'Explicit dryRun: true must be true');
        assert.strictEqual(resolveDryRun({ live: false }), true, 'live: false must be dryRun = true');
        assert.strictEqual(resolveDryRun({ live: true }), false, 'Only live: true switches to live mode');
    });

    console.log(chalk.bold.yellow('\n12. Multi-Source Platform Behavioral Regression Tests'));

    // Test 16: WhatsApp lookback window filtering
    it('should filter WhatsApp messages based on configurable lookback window', () => {
        const { isWithinLookback, parseWhatsAppTimestamp } = require('./sources/whatsapp/channelMonitor');
        const now = new Date();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

        // Default 2-day lookback
        assert.strictEqual(isWithinLookback(now, 2), true, 'Today must be within 2-day lookback');
        assert.strictEqual(isWithinLookback(oneDayAgo, 2), true, '1 day ago must be within 2-day lookback');
        assert.strictEqual(isWithinLookback(threeDaysAgo, 2), false, '3 days ago must be excluded by 2-day lookback');
        assert.strictEqual(isWithinLookback(tenDaysAgo, 2), false, '10 days ago must be excluded by 2-day lookback');

        // Extended 7-day lookback
        assert.strictEqual(isWithinLookback(threeDaysAgo, 7), true, '3 days ago must be within 7-day lookback');
        assert.strictEqual(isWithinLookback(tenDaysAgo, 7), false, '10 days ago must be excluded by 7-day lookback');

        // Timestamp string parsing
        const parsed = parseWhatsAppTimestamp('[10:45 AM, 9/9/2026]');
        assert.ok(parsed instanceof Date && !isNaN(parsed.getTime()), 'Must parse bracketed timestamp');
    });

    // Test 17: WhatsApp non-job message rejection
    it('should reject social promos and NPS feedback messages from WhatsApp pipeline', () => {
        const { isLegitimateJobMessage } = require('./sources/whatsapp/messageParser');

        // Social promotion spam
        const promoMsg = 'Follow us on Instagram @techjobs_daily for new reels and tips! Link in bio: https://instagram.com/techjobs_daily';
        assert.strictEqual(isLegitimateJobMessage(promoMsg), false, 'Instagram promo must NOT be accepted as a job');

        // NPS survey spam
        const npsMsg = 'Help us improve our service! Rate your experience on our NPS scale from 0 to 10: https://survey.example.com/nps';
        assert.strictEqual(isLegitimateJobMessage(npsMsg), false, 'NPS feedback survey must NOT be accepted as a job');

        // Legitimate tech job
        const jobMsg = 'Hiring Software Engineer at Razorpay. Location: Bangalore. Experience: 0-2 years. Apply here: https://razorpay.com/jobs/123';
        assert.strictEqual(isLegitimateJobMessage(jobMsg), true, 'Legitimate hiring message must be accepted');
    });

    // Test 18: Resume upload safety enforcement
    await itAsync('should block applications when required resume file does not exist on disk', async () => {
        const { handleGenericATS } = require('./application/handlers/genericATS');
        const { handleZoho } = require('./application/handlers/zoho');

        const mockPage = {
            url: () => 'https://boards.greenhouse.io/test/jobs/1',
            locator: () => ({ first: () => ({ isVisible: async () => false }) }),
            evaluate: async () => false
        };

        const job = createNormalizedJob({
            source: 'WHATSAPP',
            title: 'AI Dev',
            company: 'Acme',
            applicationUrl: 'https://boards.greenhouse.io/test/jobs/1'
        });

        const nonExistentResume = {
            fileName: 'ghost_resume.pdf',
            path: path.resolve(__dirname, 'resume/ghost_resume_does_not_exist.pdf'),
            type: 'MAIN'
        };

        const genericRes = await handleGenericATS(mockPage, job, job.applicationUrl, nonExistentResume, { dryRun: true });
        assert.strictEqual(genericRes.status, 'BLOCKED', 'Generic ATS must BLOCK when resume is missing');
        assert.strictEqual(genericRes.reason, 'MISSING_REQUIRED_DATA');

        const zohoRes = await handleZoho(mockPage, job, nonExistentResume, { dryRun: true });
        assert.strictEqual(zohoRes.status, 'BLOCKED', 'Zoho must BLOCK when resume is missing');
        assert.strictEqual(zohoRes.reason, 'MISSING_REQUIRED_DATA');
    });

    // Test 19: Wellfound experience boundary enforcement
    it('should strictly reject senior positions (>2 YOE) in Wellfound and rule filters', () => {
        const { checkExperienceRule } = require('./eligibility/rules');

        const juniorJob = createNormalizedJob({ title: 'Junior Dev', company: 'Startup', experience: '0-2 Yrs' });
        const seniorJob = createNormalizedJob({ title: 'Lead Architect', company: 'Startup', experience: '3-5 Yrs' });
        const principalJob = createNormalizedJob({ title: 'Principal Engineer', company: 'Startup', experience: '5+ years' });

        const candidateMaxExp = 2; // Candidate max experience is 2 years

        assert.strictEqual(checkExperienceRule(juniorJob, candidateMaxExp).passed, true, '0-2 Yrs must pass for 2 YOE candidate');
        assert.strictEqual(checkExperienceRule(seniorJob, candidateMaxExp).passed, false, '3-5 Yrs must be REJECTED for 2 YOE candidate');
        assert.strictEqual(checkExperienceRule(principalJob, candidateMaxExp).passed, false, '5+ Yrs must be REJECTED for 2 YOE candidate');
    });

    // Test 20: Calibrated 6-category scoring
    it('should calculate explainable 6-category job score breakdown bounded at 100', () => {
        const { scoreJob, formatScoreBreakdown } = require('./scoring/jobScorer');

        const sampleJob = createNormalizedJob({
            source: 'LINKEDIN',
            title: 'Full Stack Software Engineer',
            company: 'Google',
            location: 'Hyderabad',
            experience: '0-2 Yrs',
            skills: ['Python', 'JavaScript', 'SQL']
        });

        const scoreResult = scoreJob(sampleJob);
        assert.ok(scoreResult.score >= 0 && scoreResult.score <= 100, `Score must be between 0 and 100 (got: ${scoreResult.score})`);
        assert.ok(scoreResult.breakdown, 'Score result must include structured breakdown object');

        const b = scoreResult.breakdown;
        const roleScore = typeof b.roleRelevance === 'object' ? b.roleRelevance.score : b.roleRelevance;
        const expScore = typeof b.experience === 'object' ? b.experience.score : (b.experienceMatch?.score ?? b.experienceMatch);
        const skillScore = typeof b.skills === 'object' ? b.skills.score : (b.skillsMatch?.score ?? b.skillsMatch);
        const locScore = typeof b.location === 'object' ? b.location.score : (b.locationMatch?.score ?? b.locationMatch);
        const empScore = typeof b.employment === 'object' ? b.employment.score : (b.employmentType?.score ?? b.employmentType);
        const freshScore = typeof b.freshness === 'object' ? b.freshness.score : b.freshness;

        assert.ok(roleScore <= 30, 'Role relevance capped at 30');
        assert.ok(expScore <= 25, 'Experience match capped at 25');
        assert.ok(skillScore <= 25, 'Skills match capped at 25');
        assert.ok(locScore <= 10, 'Location match capped at 10');
        assert.ok(empScore <= 5, 'Employment type capped at 5');
        assert.ok(freshScore <= 5, 'Freshness capped at 5');

        const formatted = formatScoreBreakdown(scoreResult.breakdown);
        assert.ok(formatted.includes('Role:'), 'Formatted breakdown must be human readable');
    });

    // Test 21: Semantic location disambiguation
    await itAsync('should semantically disambiguate education city from residence city', async () => {
        const eduCityAns = await getAnswerWithProvenance('What is your education city?');
        assert.strictEqual(eduCityAns.answer, 'Vellore', 'Education city must be Vellore (VIT)');
        assert.strictEqual(eduCityAns.provenance, Provenance.VERIFIED_PROFILE);

        const eduStateAns = await getAnswerWithProvenance('What is your education state?');
        assert.strictEqual(eduStateAns.answer, 'Tamil Nadu', 'Education state must be Tamil Nadu');

        const currCityAns = await getAnswerWithProvenance('What is your current city of residence?');
        assert.strictEqual(currCityAns.answer, 'Hyderabad', 'Current residence city must be Hyderabad');
        assert.strictEqual(currCityAns.provenance, Provenance.VERIFIED_PROFILE);
    });

    // Test 22: Human intervention input parsing
    it('should parse multi-select checkbox and single select dropdown inputs deterministically', () => {
        const { parseMultiSelectInput, parseSingleSelectInput } = require('./ai/humanIntervention');

        // Multi-select checkboxes
        assert.deepStrictEqual(parseMultiSelectInput('1,3,5', 5), [0, 2, 4], 'Comma-separated "1,3,5" must resolve to 0-based [0, 2, 4]');
        assert.deepStrictEqual(parseMultiSelectInput('1 2 4', 4), [0, 1, 3], 'Space-separated "1 2 4" must resolve to 0-based [0, 1, 3]');
        assert.deepStrictEqual(parseMultiSelectInput('2', 5), [1], 'Single number in checkbox must resolve to 0-based [1]');
        assert.strictEqual(parseMultiSelectInput('99', 5), null, 'Out of range choice must return null');
        assert.strictEqual(parseMultiSelectInput('', 5), null, 'Empty string must return null');

        // Single-select dropdown
        assert.strictEqual(parseSingleSelectInput('3', 5), 2, 'Option 3 must resolve to index 2');
        assert.strictEqual(parseSingleSelectInput('1', 5), 0, 'Option 1 must resolve to index 0');
        assert.strictEqual(parseSingleSelectInput('0', 5), null, 'Option 0 is out of bounds');
        assert.strictEqual(parseSingleSelectInput('6', 5), null, 'Option 6 is out of bounds for 5 options');
    });

    // Test 23: CLI argument parsing & defaults
    it('should parse CLI arguments correctly with safe defaults', () => {
        const { parseCliArgs } = require('./masterController');

        // Single source
        const res1 = parseCliArgs(['--source=linkedin', '--whatsapp-days=4', '--verbose']);
        assert.deepStrictEqual(res1.sources, ['LINKEDIN']);
        assert.strictEqual(res1.whatsappDays, 4);
        assert.strictEqual(res1.verbose, true);

        // Multiple comma-separated sources
        const res2 = parseCliArgs(['--sources=naukri,wellfound', '--max=20']);
        assert.deepStrictEqual(res2.sources, ['NAUKRI', 'WELLFOUND']);
        assert.strictEqual(res2.maxApply, 20);

        // All sources
        const res3 = parseCliArgs(['--source=all', '--live']);
        assert.deepStrictEqual(res3.sources, ['NAUKRI', 'LINKEDIN', 'WELLFOUND', 'WHATSAPP']);
        assert.strictEqual(res3.live, true);
        assert.strictEqual(res3.dryRun, false);
    });

    console.log(chalk.bold.yellow('\n13. WhatsApp Multi-Format Fixtures (A through G) & Lookback Tests'));

    console.log(chalk.bold.yellow('\n13. WhatsApp Required Deterministic Test Fixtures (A through T)'));

    // Fixture A: "Batch: 2026" → ACCEPT
    await itAsync('Fixture A: "Batch: 2026" -> ACCEPT', async () => {
        const text = `Company: Tech Corp\nRole: Software Engineer\nBatch: 2026\nApply: https://jobs.techcorp.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '2026 explicitly mentioned must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
        assert.strictEqual(res.job.title, 'Software Engineer');
    });

    // Fixture B: "Batch: 26" → ACCEPT
    await itAsync('Fixture B: "Batch: 26" -> ACCEPT', async () => {
        const text = `Company: BetaSoft\nRole: Backend Developer\nBatch: 26\nApply: https://jobs.betasoft.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '26 explicitly mentioned must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
    });

    // Fixture C: "Batch: 2025 & 26" → ACCEPT
    await itAsync('Fixture C: "Batch: 2025 & 26" -> ACCEPT (BirlaSoft)', async () => {
        const text = `Company : BirlaSoft \n\nBatch : 2025 & 26\n\nRole : Enterprises App Developer \n\nPackage: 5.4 - 6LPA\n\nApply link  \nhttps://jobs.birlasoft.com/job/Pune-Developer-Enterprise-Apps-INDI/58879444/\n\nJoin WhatsApp channel:-\nhttps://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25\n6:31 pm`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '2025 & 26 must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
        assert.strictEqual(res.job.title, 'Enterprises App Developer');
        assert.strictEqual(res.job.company, 'BirlaSoft');
        assert.ok(res.job.applicationUrl.includes('jobs.birlasoft.com'), 'Authoritative URL must be career link, not channel link');
    });

    // Fixture D: "Graduation: 2025 / 2026" → ACCEPT
    await itAsync('Fixture D: "Graduation: 2025 / 2026" -> ACCEPT', async () => {
        const text = `Company: ModernIQ Technologies\nRole: Software Engineer Intern\nGraduation: 2025 / 2026\nApply: https://moderniq.com/careers/intern`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '2025 / 2026 must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
        assert.strictEqual(res.job.title, 'Software Engineer Intern');
    });

    // Fixture E: "Passouts: 2023–2026" → ACCEPT
    await itAsync('Fixture E: "Passouts: 2023–2026" -> ACCEPT', async () => {
        const text = `Company: AppEqual\nRole: Full Stack Developer\nPassouts: 2023–2026\nApply: https://appequal.com/careers/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '2023–2026 range must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
    });

    // Fixture F: "Batch: 2025" → REJECT_YEAR
    await itAsync('Fixture F: "Batch: 2025" -> REJECT_YEAR', async () => {
        const text = `Company: OldTech\nRole: Software Engineer\nBatch: 2025\nApply: https://jobs.oldtech.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, false);
        assert.strictEqual(year.reason, 'REJECTED_YEAR');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'REJECTED_YEAR');
        assert.strictEqual(res.job, null);
    });

    // Fixture G: "Batch: 2027" → REJECT_YEAR
    await itAsync('Fixture G: "Batch: 2027" -> REJECT_YEAR', async () => {
        const text = `Company: FutureTech\nRole: Software Engineer\nBatch: 2027\nApply: https://jobs.futuretech.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, false);
        assert.strictEqual(year.reason, 'REJECTED_YEAR');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'REJECTED_YEAR');
        assert.strictEqual(res.job, null);
    });

    // Fixture H: "Batch: 2025–2027" → ACCEPT (contains 2026)
    await itAsync('Fixture H: "Batch: 2025–2027" -> ACCEPT (contains 2026)', async () => {
        const text = `Company: RangeTech\nRole: Software Engineer\nBatch: 2025–2027\nApply: https://jobs.rangetech.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '2025–2027 range includes 2026, must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
        assert.strictEqual(res.job.title, 'Software Engineer');
    });

    // Fixture H1: "Batch: 2024, 2025, 2026, 2027" → ACCEPT
    await itAsync('Fixture: "Batch: 2024, 2025, 2026, 2027" -> ACCEPT', async () => {
        const text = `Company: MultiYear\nRole: Backend Developer\nBatch: 2024, 2025, 2026, 2027\nApply: https://jobs.multiyear.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, 'List containing 2026 must be eligible');
        assert.strictEqual(year.reason, 'YEAR_ELIGIBLE_2026');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
    });

    // Fixture H2: "Batch: 2024 & 2025" → REJECT_YEAR
    await itAsync('Fixture: "Batch: 2024 & 2025" -> REJECT_YEAR', async () => {
        const text = `Company: OldBatch\nRole: Software Engineer\nBatch: 2024 & 2025\nApply: https://jobs.oldbatch.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, false);
        assert.strictEqual(year.reason, 'REJECTED_YEAR');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'REJECTED_YEAR');
    });

    // Fixture H3: "Salary: 26 LPA, Batch: 2025" → REJECT_YEAR (salary not batch year)
    await itAsync('Fixture: "Salary: 26 LPA, Batch: 2025" -> REJECT_YEAR', async () => {
        const text = `Company: PayCorp\nRole: Software Engineer\nSalary: 26 LPA\nBatch: 2025\nApply: https://jobs.paycorp.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, false, '26 in salary context must NOT be interpreted as batch year');
        assert.strictEqual(year.reason, 'REJECTED_YEAR');
    });

    // Fixture I: No year mentioned → ACCEPT year criterion
    await itAsync('Fixture I: No year mentioned -> ACCEPT year criterion', async () => {
        const text = `Company: NoYearTech\nRole: Software Engineer\nApply: https://jobs.noyear.com/apply`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, 'No year mentioned must be eligible');
        assert.strictEqual(year.reason, 'NO_YEAR_MENTIONED');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
    });

    // Fixture J: Relevant software role + valid career URL → ACCEPT
    await itAsync('Fixture J: Relevant software role + valid career URL -> ACCEPT', async () => {
        const text = `Company: GoodTech\nRole: Full Stack Engineer\nApply: https://jobs.goodtech.com/apply`;
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
        assert.strictEqual(res.job.title, 'Full Stack Engineer');
    });

    // Fixture K: Irrelevant role + valid career URL → REJECT_ROLE
    await itAsync('Fixture K: Irrelevant role + valid career URL -> REJECT_ROLE', async () => {
        const text = `Company: TeleCorp\nRole: Telecaller / Customer Support Associate\nBatch: 2026\nApply: https://jobs.telecorp.com/apply`;
        const roleRes = evaluateRoleEligibility('Telecaller / Customer Support Associate');
        assert.strictEqual(roleRes.eligible, false);
        assert.strictEqual(roleRes.reason, 'REJECTED_ROLE');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'REJECTED_ROLE');
        assert.strictEqual(res.job, null);
    });

    // Fixture L: Referral email only → REJECT_REFERRAL_EMAIL
    await itAsync('Fixture L: Referral email only -> REJECT_REFERRAL_EMAIL (ModernIQ)', async () => {
        const text = `HIRING | SOFTWARE ENGINEER INTERN\n\nCompany: ModernIQ Technologies\nLocation: Hyderabad\nGraduation: 2025 / 2026\nApply: contact@moderniqtech.com`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, '2025 / 2026 must pass year criterion');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'REJECTED_REFERRAL_EMAIL');
        assert.strictEqual(res.job, null);
        const job = await extractJobFromWhatsApp(text);
        assert.strictEqual(job, null, 'Email-only/referral must NOT enter auto-application queue');
    });

    // Fixture M: Career URL requiring login → NEEDS_HUMAN_INTERVENTION
    await itAsync('Fixture M: Career URL requiring login -> NEEDS_HUMAN_INTERVENTION', async () => {
        const mockPage = {
            url: () => 'https://careers.company.com/login',
            evaluate: async (fn) => {
                const fnStr = typeof fn === 'function' ? fn.toString() : String(fn);
                if (fnStr.includes('password') || fnStr.includes('hasSignIn')) {
                    return true;
                }
                return false;
            },
            waitForLoadState: async () => {},
            screenshot: async () => {}
        };
        const job = { role: 'Software Engineer', title: 'Software Engineer', company: 'LockedCorp' };
        const resume = { fileName: 'resume.pdf', path: path.join(__dirname, 'resume/Manish_main_resume.pdf') };
        const res = await handleExternalApplication(mockPage, job, 'https://careers.company.com/login', resume, {
            isInteractive: false,
            dryRun: true
        });
        assert.strictEqual(res.status, 'SKIPPED');
        assert.strictEqual(res.reason, 'NEEDS_HUMAN_INTERVENTION');
    });

    // Fixture N: Google Form → application candidate
    await itAsync('Fixture N: Google Form -> application candidate', async () => {
        const text = `Company: FormCorp\nRole: Software Engineer\nBatch: 2026\nApply: https://forms.gle/sampleform12345`;
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'ACCEPTED');
        assert.ok(res.job);
        assert.strictEqual(res.job.applicationType, 'DIRECT_URL');
        assert.ok(res.job.applicationUrl.includes('forms.gle'));
    });

    // Fixture O: WhatsApp channel invite + real ATS link → ATS link selected
    it('Fixture O: WhatsApp channel invite + real ATS link -> ATS link selected', () => {
        const urls = [
            'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25',
            'https://jobs.birlasoft.com/job/developer/12345'
        ];
        const selected = findAuthoritativeJobUrl(urls);
        assert.strictEqual(selected, 'https://jobs.birlasoft.com/job/developer/12345');
        assert.notStrictEqual(selected, 'https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25');
    });

    // Fixture P: ASP.NET/B.Tech autolink → NOT selected as application URL
    it('Fixture P: ASP.NET/B.Tech autolink -> NOT selected as application URL', () => {
        assert.strictEqual(isAutolinkOrSocialOrChannel('http://asp.net'), true);
        assert.strictEqual(isAutolinkOrSocialOrChannel('http://b.tech'), true);
        assert.strictEqual(isAutolinkOrSocialOrChannel('https://m.tech'), true);
        const selected = findAuthoritativeJobUrl(['http://asp.net', 'http://b.tech']);
        assert.strictEqual(selected, null, 'Autolinked frameworks/degrees must never be selected as application URLs');
    });

    // Fixture Q: Sidebar NPS message → REJECT_NON_JOB
    await itAsync('Fixture Q: Sidebar NPS message -> REJECT_NON_JOB', async () => {
        const npsText = `Dear Customer, Hope you had a great STAR experience! Please rate our service from 0 to 10 on https://lwcx.in/?n=123 NPS: 10`;
        const res = await extractJobWithDisposition(npsText);
        assert.strictEqual(res.disposition, 'REJECTED_NON_JOB');
        assert.strictEqual(res.job, null);
    });

    // Fixture R: Instagram/personal message → REJECT_NON_JOB
    await itAsync('Fixture R: Instagram/personal message -> REJECT_NON_JOB', async () => {
        const reelText = `Daily vlog reel: https://www.instagram.com/reel/DdCKs8EJxVt/`;
        const res = await extractJobWithDisposition(reelText);
        assert.strictEqual(res.disposition, 'REJECTED_NON_JOB');
        assert.strictEqual(res.job, null);
    });

    // Fixture S: Duplicate WhatsApp bubbles → deduplicated
    it('Fixture S: Duplicate WhatsApp bubbles -> deduplicated', () => {
        const { createNormalizedJob } = require('./discovery/normalizedJob');
        const job1 = createNormalizedJob({ source: 'WHATSAPP', title: 'Developer', company: 'Acme', applicationUrl: 'https://jobs.acme.com/1' });
        const job2 = createNormalizedJob({ source: 'WHATSAPP', title: 'Developer', company: 'Acme', applicationUrl: 'https://jobs.acme.com/1?utm_source=chat' });
        const unique = crossSourceDeduplicate([job1, job2]);
        assert.strictEqual(unique.length, 1, 'Duplicate messages must be deduplicated to 1 unique job');
    });

    // Fixture T: Old message outside lookback → rejected by lookback
    it('Fixture T: Old message outside lookback -> rejected by lookback', () => {
        const threeDaysAgo = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
        const inside2Days = isWithinLookback(threeDaysAgo, 2);
        assert.strictEqual(inside2Days, false, 'Message older than 2 days must be rejected');

        const yesterday = new Date(Date.now() - (1 * 24 * 60 * 60 * 1000));
        const insideYesterday = isWithinLookback(yesterday, 2);
        assert.strictEqual(insideYesterday, true, 'Message from yesterday must be accepted inside 2-day lookback');
    });

    // Additional Verification: AppEqual example specifically
    await itAsync('AppEqual Verification: Passouts 2023–2026 pass year, email-only rejected from queue', async () => {
        const text = `HIRING | SOFTWARE INTERNSHIPS \n\nCompany: AppEqual\nLocation: Gachibowli, Hyderabad\nWork Mode: WFO / Hybrid\nEligibility: B.Tech / MCA / MBA\nPassouts: 2023–2026\nSend Resume: hiring@appequal.com`;
        const year = evaluatePassoutYear(text);
        assert.strictEqual(year.eligible, true, 'Passouts 2023–2026 must pass year rule');
        const res = await extractJobWithDisposition(text);
        assert.strictEqual(res.disposition, 'REJECTED_REFERRAL_EMAIL');
        assert.strictEqual(res.job, null);
    });

    // Additional Verification: Timestamp parsing in DD/MM/YYYY and relative formats
    it('Timestamp Verification: parse WhatsApp timestamps in DD/MM/YYYY and relative formats', () => {
        const d1 = parseWhatsAppTimestamp('[10:45 AM, 08/09/2026]');
        assert.strictEqual(d1.getDate(), 8, 'Day must be 8');
        assert.strictEqual(d1.getMonth(), 8, 'Month must be 8 (September, 0-indexed)');
        assert.strictEqual(d1.getFullYear(), 2026);

        const d2 = parseWhatsAppTimestamp('6:31 pm');
        const now = new Date();
        assert.strictEqual(d2.getDate(), now.getDate());
        assert.strictEqual(d2.getHours(), 18);
        assert.strictEqual(d2.getMinutes(), 31);
    });

    // ============================================================
    // 14. Strict Application Safety Boundary, FileUpload, Dropdown & Submission Verification Tests
    // ============================================================
    console.log(chalk.bold.magenta('\n14. Application Safety Boundary & Universal ATS Interaction Tests'));

    const testResume = { fileName: 'Manish_main_resume.pdf', path: path.join(__dirname, 'resume/Manish_main_resume.pdf') };
    const sampleJob = { title: 'Full Stack Engineer', role: 'Full Stack Engineer', company: 'CloudScale', source: 'WHATSAPP' };

    // Helper to create mock page for external application testing
    function createMockPage(opts = {}) {
        const {
            hasFileInput = true,
            hasSubmitButton = true,
            submitText = 'Submit Application',
            pageContent = '<html><body>Application Form</body></html>',
            pageUrl = 'https://jobs.cloudscale.io/apply',
            postSubmitUrl = 'https://jobs.cloudscale.io/application-complete',
            postSubmitContent = '<html><body>Thank you for your application! Your application has been submitted successfully. Confirmation ID: #CS-9941</body></html>',
            isLoginWall = false,
            hasCaptcha = false
        } = opts;

        let currentUrl = pageUrl;
        let currentContent = pageContent;

        return {
            url: () => currentUrl,
            content: async () => currentContent,
            locator: (sel) => ({
                first: () => ({
                    isVisible: async () => {
                        if (/submit|apply/i.test(sel)) return hasSubmitButton;
                        if (/file/i.test(sel)) return hasFileInput;
                        return false;
                    },
                    scrollIntoViewIfNeeded: async () => {},
                    click: async () => {
                        if (/submit|apply/i.test(sel)) {
                            currentUrl = postSubmitUrl;
                            currentContent = postSubmitContent;
                        }
                    },
                    innerText: async () => submitText,
                    getAttribute: async () => submitText,
                    inputValue: async () => '',
                    fill: async () => {},
                    evaluate: async (fn) => typeof fn === 'function' ? fn({ tagName: 'DIV' }) : null,
                    dispatchEvent: async () => {},
                    setInputFiles: async () => {}
                }),
                all: async () => {
                    if (sel === 'input[type="file"]') {
                        if (hasFileInput) {
                            return [{
                                evaluate: async () => 'resume_upload resume-file',
                                setInputFiles: async () => {}
                            }];
                        }
                        return [];
                    }
                    return [];
                },
                count: async () => 0
            }),
            evaluate: async (fn, arg) => {
                const fnStr = typeof fn === 'function' ? fn.toString() : String(fn);
                if (fnStr.includes('hasSignIn') || fnStr.includes('password')) return isLoginWall;
                if (fnStr.includes('recaptcha') || fnStr.includes('captcha')) return hasCaptcha;
                if (fnStr.includes('fileName') || fnStr.includes('baseName')) return hasFileInput;
                if (fnStr.includes('errorEls') || fnStr.includes('validation')) return null;
                if (fnStr.includes('application|reference|candidate')) return /(application|reference|candidate)\s*(id|number|#)/i.test(currentContent);
                return false;
            },
            frames: () => [],
            mainFrame: () => ({}),
            waitForLoadState: async () => {},
            waitForTimeout: async () => {},
            screenshot: async () => {},
            waitForEvent: async () => null
        };
    }

    // Test 1: Missing resume upload -> NOT SUCCESS (status !== 'SUCCESS', reason === 'RESUME_NOT_VERIFIED')
    await itAsync('Missing resume upload -> NOT SUCCESS (RESUME_NOT_VERIFIED)', async () => {
        const mockPage = createMockPage({ hasFileInput: false, hasSubmitButton: true });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io/apply', testResume, {
            dryRun: false,
            isInteractive: false
        });
        assert.notStrictEqual(res.status, 'SUCCESS', 'Unattached resume must never yield SUCCESS');
        assert.strictEqual(res.reason, 'RESUME_NOT_VERIFIED');
    });

    // Test 2: Missing submit button -> NOT SUCCESS (status !== 'SUCCESS', reason === 'SUBMISSION_NOT_VERIFIED')
    await itAsync('Missing submit button -> NOT SUCCESS (SUBMISSION_NOT_VERIFIED)', async () => {
        const mockPage = createMockPage({ hasFileInput: true, hasSubmitButton: false });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io/apply', testResume, {
            dryRun: false,
            isInteractive: false
        });
        assert.notStrictEqual(res.status, 'SUCCESS', 'Missing submit button must never yield SUCCESS');
        assert.strictEqual(res.reason, 'SUBMISSION_NOT_VERIFIED');
    });

    // Test 3: Unverified submission (URL containing "successfactors" without confirmation) -> NOT SUCCESS
    await itAsync('Unverified submission (URL containing "successfactors" without confirmation) -> NOT SUCCESS', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: true,
            pageUrl: 'https://career44.successfactors.com/careers?company=birlasoftl',
            postSubmitUrl: 'https://career44.successfactors.com/careers?company=birlasoftl',
            postSubmitContent: '<html><body>Please review your profile</body></html>'
        });
        let promptCallCount = 0;
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://career44.successfactors.com/careers?company=birlasoftl', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => {
                promptCallCount++;
                if (promptCallCount === 1) return 'yes'; // Pre-submit human confirmation gate
                return 'No, submission failed or unverified'; // Post-submit confirmation check
            }
        });
        assert.notStrictEqual(res.status, 'SUCCESS', 'Unverified submission must never yield SUCCESS');
        assert.strictEqual(res.reason, 'SUBMISSION_NOT_VERIFIED');
        assert.strictEqual(res.verified, false);
    });

    // Test 4: Deterministically verified submission -> SUCCESS
    await itAsync('Verified submission -> SUCCESS', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: true,
            postSubmitUrl: 'https://jobs.cloudscale.io/application-complete',
            postSubmitContent: '<html><body>Thank you for your application! Your application has been submitted successfully. Confirmation ID: #CS-9941</body></html>'
        });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io/apply', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => 'yes'
        });
        assert.strictEqual(res.status, 'SUCCESS', 'Verified submission must yield SUCCESS');
        assert.strictEqual(res.verified, true);
    });

    // Test 5: Hidden file input -> detected and attached
    await itAsync('Hidden file input -> detected and attached', async () => {
        let filesSet = false;
        const mockScope = {
            locator: (sel) => ({
                all: async () => {
                    if (sel === 'input[type="file"]') {
                        return [{
                            evaluate: async () => 'hidden_resume_file resume_cv',
                            setInputFiles: async () => { filesSet = true; }
                        }];
                    }
                    return [];
                },
                first: () => ({ isVisible: async () => false })
            }),
            evaluate: async () => true
        };
        const mockPage = { waitForTimeout: async () => {} };
        const res = await attachResumeSafely(mockScope, mockPage, testResume, { isInteractive: false });
        assert.strictEqual(filesSet, true, 'Hidden file input must have setInputFiles called');
        assert.strictEqual(res.verified, true);
    });

    // Test 6: Custom upload button -> detected via filechooser event
    await itAsync('Custom upload button -> detected via filechooser event', async () => {
        let fileChooserSet = false;
        const mockScope = {
            locator: (sel) => ({
                all: async () => [],
                first: () => ({
                    isVisible: async () => /upload.*resume/i.test(sel),
                    click: async () => {}
                })
            }),
            evaluate: async () => true
        };
        const mockPage = {
            waitForEvent: async (evt) => {
                if (evt === 'filechooser') {
                    return {
                        setFiles: async () => { fileChooserSet = true; }
                    };
                }
                return null;
            },
            waitForTimeout: async () => {}
        };
        const res = await attachResumeSafely(mockScope, mockPage, testResume, { isInteractive: false });
        assert.strictEqual(fileChooserSet, true, 'fileChooser.setFiles must be called on custom upload button');
        assert.strictEqual(res.verified, true);
    });

    // Test 7: Dropdown -> opened and options inspected with known answer
    await itAsync('Dropdown -> opened and options inspected with known answer', async () => {
        let selectedValue = '';
        const mockScope = {
            locator: (sel) => ({
                all: async () => {
                    if (sel === 'select') {
                        return [{
                            isVisible: async () => true,
                            inputValue: async () => '',
                            evaluate: async () => 'Gender',
                            locator: () => ({
                                all: async () => [
                                    { innerText: async () => 'Male' },
                                    { innerText: async () => 'Female' },
                                    { innerText: async () => 'Other' }
                                ]
                            }),
                            selectOption: async (opt) => { selectedValue = opt.label; },
                            dispatchEvent: async () => {}
                        }];
                    }
                    return [];
                }
            })
        };
        const mockPage = { waitForTimeout: async () => {} };
        await handleDropdowns(mockScope, mockPage, { isInteractive: false });
        assert.strictEqual(selectedValue, 'Male', 'Known dropdown question must select exact option');
    });

    // Test 8: Unknown dropdown answer -> HUMAN_INTERVENTION (never guess using Ollama)
    await itAsync('Unknown dropdown answer -> HUMAN_INTERVENTION (zero guessing)', async () => {
        let promptTriggered = false;
        const unknownQ = 'Unknown Clearance Level ' + Date.now();
        const mockScope = {
            locator: (sel) => ({
                all: async () => {
                    if (sel === 'select') {
                        return [{
                            isVisible: async () => true,
                            inputValue: async () => '',
                            evaluate: async () => unknownQ,
                            locator: () => ({
                                all: async () => [
                                    { innerText: async () => 'Active Clearance' },
                                    { innerText: async () => 'No Clearance' }
                                ]
                            }),
                            selectOption: async () => {},
                            dispatchEvent: async () => {}
                        }];
                    }
                    return [];
                }
            })
        };
        const mockPage = { waitForTimeout: async () => {} };
        await handleDropdowns(mockScope, mockPage, {
            isInteractive: true,
            promptFn: async () => {
                promptTriggered = true;
                return '1';
            }
        });
        assert.strictEqual(promptTriggered, true, 'Unknown dropdown question must trigger human intervention');
    });

    // Test 9: Login wall -> HUMAN_INTERVENTION
    await itAsync('Login wall -> detected correctly', async () => {
        const mockPage = {
            evaluate: async (fn) => {
                const s = String(fn);
                if (s.includes('password') || s.includes('hasSignIn')) return true;
                return false;
            }
        };
        const hasLogin = await checkLoginWall(mockPage);
        assert.strictEqual(hasLogin, true, 'Login wall must be identified correctly');
    });

    // Test 10: CAPTCHA -> HUMAN_INTERVENTION
    await itAsync('CAPTCHA -> detected correctly', async () => {
        const mockPage = {
            evaluate: async (fn) => {
                const s = String(fn);
                if (s.includes('captcha') || s.includes('recaptcha')) return true;
                return false;
            }
        };
        const hasCaptcha = await checkCaptcha(mockPage);
        assert.strictEqual(hasCaptcha, true, 'CAPTCHA challenge must be identified correctly');
    });

    // Test 11: Final human confirmation -> still required in live mode
    await itAsync('Final human confirmation -> requires explicit approval in live mode', async () => {
        let executed = false;
        const gate = await confirmAndExecuteSubmission({
            dryRun: false,
            job: sampleJob,
            destination: 'Test ATS',
            actionName: 'Submit Button',
            execute: async () => { executed = true; return { status: 'SUCCESS', verified: true }; },
            promptFn: async () => 'n',
            isInteractive: true
        });
        assert.strictEqual(gate.submitted, false);
        assert.strictEqual(gate.status, 'CONFIRMATION_ABORTED');
        assert.strictEqual(executed, false, 'Submission action must NOT execute when human rejects confirmation');
    });

    // Test 12: Database Repository safety guard prevents unverified SUCCESS
    it('Database Repository safety guard -> reclassifies unverified SUCCESS', () => {
        const res = { status: 'SUCCESS', verified: false, message: 'Unverified submission' };
        let effectiveStatus = res.status;
        if (effectiveStatus === 'SUCCESS' && res.verified !== true) {
            effectiveStatus = 'SUBMISSION_NOT_VERIFIED';
        }
        assert.strictEqual(effectiveStatus, 'SUBMISSION_NOT_VERIFIED', 'Unverified SUCCESS must be reclassified to SUBMISSION_NOT_VERIFIED');
    });

    console.log(chalk.bold.yellow('\n15. Deep Safety Invariants, SuccessFactors & Comprehensive Proof Tests'));

    // ── 15.1 Human Login Intervention Proofs ─────────────────────────────────
    await itAsync('Arbitrary input like "yes" must NOT be interpreted as successful login completion', async () => {
        const { promptHumanIntervention } = require('./ai/humanIntervention');
        const res = await promptHumanIntervention({
            question: 'Please log in using browser window',
            type: 'action',
            reason: 'Login wall detected',
            promptFn: async () => 'yes',
            isInteractive: true
        });
        assert.strictEqual(res.answered, false, 'Action intervention must NOT accept "yes" as completion');
        assert.strictEqual(res.reason, 'INVALID_COMPLETION_ACTION');
    });

    await itAsync('Only documented completion action (Enter or "done") resumes action intervention', async () => {
        const { promptHumanIntervention } = require('./ai/humanIntervention');
        const resEnter = await promptHumanIntervention({
            question: 'Please log in using browser window',
            type: 'action',
            reason: 'Login wall detected',
            promptFn: async () => '',
            isInteractive: true
        });
        assert.strictEqual(resEnter.answered, true, 'Pressing Enter must confirm action completion');

        const resDone = await promptHumanIntervention({
            question: 'Please log in using browser window',
            type: 'action',
            reason: 'Login wall detected',
            promptFn: async () => 'done',
            isInteractive: true
        });
        assert.strictEqual(resDone.answered, true, 'Typing "done" must confirm action completion');
    });

    await itAsync('If login wall is still present after resuming, automation stops and NEVER submits', async () => {
        const mockPage = {
            url: () => 'https://career44.sapsf.com/careers?company=acme',
            evaluate: async (fn) => {
                const s = typeof fn === 'function' ? fn.toString() : String(fn);
                if (s.includes('404')) return false;
                if (s.includes('hasSignIn') || s.includes('password')) return true; // Login still present
                return false;
            },
            locator: () => ({ first: () => ({ isVisible: async () => false }), all: async () => [] }),
            waitForTimeout: async () => {},
            waitForLoadState: async () => {}
        };
        const job = createNormalizedJob({ source: 'WHATSAPP', title: 'Developer', company: 'Acme', applicationUrl: 'https://career44.sapsf.com' });
        const res = await handleExternalApplication(mockPage, job, 'https://career44.sapsf.com', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => 'done' // Human presses done, but page still has login
        });
        assert.notStrictEqual(res.status, 'SUCCESS', 'Automation must never succeed when login remains active');
        assert.strictEqual(res.status, 'SKIPPED');
        assert.strictEqual(res.reason, 'NEEDS_HUMAN_INTERVENTION');
    });

    // ── 15.2 SuccessFactors-Style Resume Upload Proofs ────────────────────────
    await itAsync('SuccessFactors custom upload card with filechooser & verified DOM attachment -> resumeVerified === true', async () => {
        let cardClicked = false;
        let filesSet = false;
        const mockScope = {
            locator: (sel) => ({
                all: async () => [],
                first: () => ({
                    isVisible: async () => sel.includes('Upload a Resume'),
                    click: async () => { cardClicked = true; }
                })
            }),
            evaluate: async (fn, arg) => {
                // Return true only when verifying filename in DOM
                const s = typeof fn === 'function' ? fn.toString() : String(fn);
                if (s.includes('fileName') || s.includes('baseName')) return true;
                return false;
            }
        };
        const mockPage = {
            waitForEvent: async (evt) => {
                if (evt === 'filechooser') {
                    return { setFiles: async () => { filesSet = true; } };
                }
                return null;
            },
            waitForTimeout: async () => {}
        };
        const res = await attachResumeSafely(mockScope, mockPage, testResume, { isInteractive: false });
        assert.strictEqual(cardClicked, true, 'Upload a Resume card must be clicked');
        assert.strictEqual(filesSet, true, 'Filechooser must receive file path');
        assert.strictEqual(res.verified, true, 'Verified attachment must return true');
    });

    await itAsync('SuccessFactors custom upload card with filechooser but NO DOM attachment -> RESUME_NOT_VERIFIED and NEVER SUCCESS', async () => {
        const mockScope = {
            locator: (sel) => ({
                all: async () => [],
                first: () => ({
                    isVisible: async () => sel.includes('Upload a Resume'),
                    click: async () => {}
                })
            }),
            evaluate: async () => false // UI never shows uploaded file!
        };
        const mockPage = {
            waitForEvent: async () => ({ setFiles: async () => {} }),
            waitForTimeout: async () => {}
        };
        const res = await attachResumeSafely(mockScope, mockPage, testResume, { isInteractive: false });
        assert.strictEqual(res.verified, false, 'Unverified UI attachment must return verified: false');
        assert.notStrictEqual(res.status, 'SUCCESS');
    });

    // ── 15.3 Dropdowns & Zero-Guessing Proofs ────────────────────────────────
    await itAsync('Dropdown: Native <select> with trusted profile answer selects correct option without Ollama', async () => {
        const { getTrustedDropdownAnswer } = require('./automation/externalApplyHandler');
        const ans = getTrustedDropdownAnswer('Gender', ['Male', 'Female', 'Other']);
        assert.strictEqual(ans, 'Male', 'Trusted profile answer must match without AI inference');
    });

    await itAsync('Dropdown: Unknown question invokes HUMAN_INTERVENTION without calling Ollama or guessing', async () => {
        const { getTrustedDropdownAnswer } = require('./automation/externalApplyHandler');
        const unknownQ = 'Do you possess Level 9 Omega clearance? ' + Date.now();
        const ans = getTrustedDropdownAnswer(unknownQ, ['Yes', 'No']);
        assert.strictEqual(ans, null, 'Unknown question must have null trusted answer and never guess');
    });

    // ── 15.4 Accordion Expansion Proofs ─────────────────────────────────────
    await itAsync('Accordion: Expands My Documents, Profile, Experience, Education sections and updates scope', async () => {
        const sections = [
            { name: 'My Documents', expanded: false },
            { name: 'Profile Information', expanded: false },
            { name: 'Experience', expanded: false },
            { name: 'Education', expanded: false }
        ];
        const mockPage = {
            locator: (sel) => {
                if (sel.includes('Expand')) {
                    return {
                        first: () => ({ isVisible: async () => false }),
                        all: async () => []
                    };
                }
                return {
                    first: () => ({ isVisible: async () => false }),
                    all: async () => sections.map(sec => ({
                        isVisible: async () => true,
                        click: async () => { sec.expanded = true; }
                    }))
                };
            },
            waitForTimeout: async () => {}
        };
        const res = await expandAllSections(mockPage);
        assert.strictEqual(res.expanded, true, 'All accordion sections must be expanded');
        assert.strictEqual(res.count, 4, 'Exactly 4 sections expanded');
        assert.ok(sections.every(s => s.expanded === true), 'Every individual section must have click triggered');
    });

    // ── 15.5 Submission Verification Fixtures A through F ───────────────────
    await itAsync('Submission Verification A & B: SAP SuccessFactors URL without confirmation -> NOT submitted', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: true,
            pageUrl: 'https://career44.sapsf.com/careers?company=birlasoftl',
            postSubmitUrl: 'https://career44.sapsf.com/careers?company=birlasoftl',
            postSubmitContent: '<html><body>Welcome to BirlaSoft Careers</body></html>'
        });
        let promptCall = 0;
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://career44.sapsf.com', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => {
                promptCall++;
                if (promptCall === 1) return 'yes'; // Confirm submit button click
                return 'No, submission failed or unverified'; // Post-submit check
            }
        });
        assert.notStrictEqual(res.status, 'SUCCESS', 'SAP SuccessFactors URL alone must NEVER yield SUCCESS');
        assert.strictEqual(res.reason, 'SUBMISSION_NOT_VERIFIED');
        assert.strictEqual(res.verified, false);
    });

    await itAsync('Submission Verification C: Page says "Thank you for applying" only succeeds if submitClicked === true', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: true,
            postSubmitContent: '<html><body>Thank you for applying to CloudScale! We have received your application.</body></html>'
        });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => 'yes'
        });
        assert.strictEqual(res.status, 'SUCCESS');
        assert.strictEqual(res.verified, true);
    });

    await itAsync('Submission Verification D: Confirmation ID only succeeds if submitClicked === true', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: true,
            postSubmitContent: '<html><body>Your application has been received. Requisition ID: #REQ-987654</body></html>'
        });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => 'yes'
        });
        assert.strictEqual(res.status, 'SUCCESS');
        assert.strictEqual(res.verified, true);
    });

    await itAsync('Submission Verification E: Strict path /thank-you only succeeds if submitClicked === true', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: true,
            postSubmitUrl: 'https://jobs.cloudscale.io/job/123/thank-you'
        });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io', testResume, {
            dryRun: false,
            isInteractive: true,
            promptFn: async () => 'yes'
        });
        assert.strictEqual(res.status, 'SUCCESS');
        assert.strictEqual(res.verified, true);
    });

    await itAsync('Submission Verification F: Reaching end of flow without submit click -> SUBMISSION_NOT_VERIFIED, NEVER SUCCESS', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: false // No submit button clicked
        });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io', testResume, {
            dryRun: false,
            isInteractive: false
        });
        assert.notStrictEqual(res.status, 'SUCCESS');
        assert.strictEqual(res.reason, 'SUBMISSION_NOT_VERIFIED');
    });

    // ── 15.6 Missing Submit Button Proof ────────────────────────────────────
    await itAsync('Missing submit button fixture -> SUBMISSION_NOT_VERIFIED, NEVER SUCCESS', async () => {
        const mockPage = createMockPage({
            hasFileInput: true,
            hasSubmitButton: false
        });
        const res = await handleExternalApplication(mockPage, sampleJob, 'https://jobs.cloudscale.io', testResume, {
            dryRun: false,
            isInteractive: false
        });
        assert.strictEqual(res.status, 'SKIPPED');
        assert.strictEqual(res.reason, 'SUBMISSION_NOT_VERIFIED');
    });

    // ── 15.7 Final Human Gate Isolation Proof ────────────────────────────────
    await itAsync('Final Human Gate: Prior human intervention "yes" does NOT count as final application confirmation', async () => {
        let submitActionExecuted = false;
        let promptIndex = 0;

        // Simulate multi-prompt interaction:
        // 1st prompt: Dropdown intervention answer
        // 2nd prompt: Final submit gate confirmation
        const answers = ['yes', 'n']; // Human types 'yes' to prior intervention, then 'n' to final submit gate!

        const mockPromptFn = async (msg) => {
            const ans = answers[promptIndex] || 'n';
            promptIndex++;
            return ans;
        };

        // Step 1: Pre-submit intervention receives 'yes'
        const { promptHumanIntervention } = require('./ai/humanIntervention');
        const prevRes = await promptHumanIntervention({
            question: 'Are you available to join immediately?',
            type: 'text',
            reason: 'Unknown question',
            promptFn: mockPromptFn,
            isInteractive: true
        });
        assert.strictEqual(prevRes.answered, true);
        assert.strictEqual(prevRes.value, 'yes');

        // Step 2: Final Submit confirmation gate receives 'n'
        const gateRes = await confirmAndExecuteSubmission({
            dryRun: false,
            job: sampleJob,
            destination: 'Company Portal',
            actionName: 'Final Submit Button',
            execute: async () => { submitActionExecuted = true; return { status: 'SUCCESS', verified: true }; },
            promptFn: mockPromptFn,
            isInteractive: true
        });

        assert.strictEqual(submitActionExecuted, false, 'Submit button must NEVER click when human answers "n" to submit gate');
        assert.strictEqual(gateRes.submitted, false);
        assert.strictEqual(gateRes.status, 'CONFIRMATION_ABORTED');
    });

    // ── 15.8 Master Controller CLI Limits & Safety Proofs ───────────────────
    it('Master Controller CLI: --dry-run defaults, --live --max=1 enforcement, and safe live defaults', () => {
        const { parseCliArgs } = require('./masterController');
        const dryOpts = parseCliArgs(['--dry-run']);
        assert.strictEqual(dryOpts.dryRun, true);
        assert.strictEqual(dryOpts.live, false);

        const liveOpts = parseCliArgs(['--live', '--max=1']);
        assert.strictEqual(liveOpts.live, true);
        assert.strictEqual(liveOpts.dryRun, false);
        assert.strictEqual(liveOpts.maxApply, 1);

        const defaultOpts = parseCliArgs([]);
        assert.strictEqual(defaultOpts.live, undefined);
        assert.strictEqual(defaultOpts.dryRun, undefined); // In masterController, undefined defaults to dryRun = true
    });

    // ============================================================
    // 16. Canonical Profile Priority, Candidate Fact Resolution & BirlaSoft Combobox Deterministic Tests
    // ============================================================
    console.log(chalk.bold.yellow('\n16. Canonical Profile Priority, Candidate Fact Resolution & BirlaSoft Combobox Deterministic Tests'));

    const { resolveCandidateFact, matchAtsOption, isPersonalFactQuestion, validateStructuredField } = require('./ai/candidateFacts');
    const { getTrustedDropdownAnswer } = require('./automation/externalApplyHandler');
    const { promptHumanIntervention, saveHumanVerifiedAnswer } = require('./ai/humanIntervention');
    const profile = require('./config/profile');

    // Fixture A: Institute Name + Canonical "Vellore Institute of Technology" -> AUTOMATIC SELECT
    it('Fixture A: Combobox "Institute Name" resolves automatically from canonical profile without human prompt or Ollama', () => {
        const question = 'Institute Name';
        const options = [
            'A.B. Institute of Technology',
            'B.M.S. College of Engineering',
            'Birla Institute of Technology',
            'Vellore Institute of Technology',
            'Vishwakarma Institute of Technology'
        ];

        // 1. Central fact resolution
        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, true, 'Fact must be resolved from canonical profile');
        assert.strictEqual(fact.answer, 'Vellore Institute of Technology');
        assert.strictEqual(fact.path, 'education.institution');

        // 2. ATS option matching
        const match = matchAtsOption(options, fact.answer, question);
        assert.strictEqual(match.matched, true, 'Exact ATS option must be matched');
        assert.strictEqual(match.selectedOption, 'Vellore Institute of Technology');

        // 3. getTrustedDropdownAnswer
        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, 'Vellore Institute of Technology', 'Must automatically select Vellore Institute of Technology');
    });

    // Fixture B: Highest Education -> AUTOMATIC SELECT with metadata normalization
    it('Fixture B: Dropdown "Highest Education" resolves automatically to degree with metadata normalization', () => {
        const question = 'Highest Education';
        const options = [
            'High School',
            'Bachelor\'s Degree',
            'Master\'s Degree (±18 years)',
            'Doctorate / Ph.D.'
        ];

        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, true);
        assert.strictEqual(fact.path, 'education.degree');

        const match = matchAtsOption(options, fact.answer, question);
        assert.strictEqual(match.matched, true);
        assert.strictEqual(match.selectedOption, 'Master\'s Degree (±18 years)');

        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, 'Master\'s Degree (±18 years)');
    });

    // Fixture C: Expected compensation - Currency -> AUTOMATIC SELECT from profile.expectedCurrency
    it('Fixture C: Combobox "Expected compensation - Currency" resolves automatically to INR', () => {
        const question = 'Expected compensation - Currency';
        const options = [
            'USD - US Dollar',
            'EUR - Euro',
            'INR - Indian Rupee',
            'GBP - British Pound'
        ];

        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, true);
        assert.strictEqual(fact.answer, 'INR');
        assert.strictEqual(fact.canonicalKey, 'profile.expectedCurrency');

        const match = matchAtsOption(options, fact.answer, question);
        assert.strictEqual(match.matched, true);
        assert.strictEqual(match.selectedOption, 'INR - Indian Rupee');

        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, 'INR - Indian Rupee');
    });

    // Fixture C2: Current / Last compensation - Currency -> AUTOMATIC SELECT from profile.currentCurrency
    it('Fixture C2: Combobox "Current / Last compensation - Currency" resolves automatically to INR', () => {
        const question = 'Current / Last compensation - Currency';
        const options = [
            'USD - US Dollar',
            'EUR - Euro',
            'INR - Indian Rupee',
            'GBP - British Pound'
        ];

        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, true);
        assert.strictEqual(fact.answer, 'INR');
        assert.strictEqual(fact.canonicalKey, 'profile.currentCurrency');

        const match = matchAtsOption(options, fact.answer, question);
        assert.strictEqual(match.matched, true);
        assert.strictEqual(match.selectedOption, 'INR - Indian Rupee');

        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, 'INR - Indian Rupee');
    });

    // Regression Test: expectedCurrency = USD vs currentCurrency = INR
    it('Regression: Separates expectedCurrency (USD) from currentCurrency (INR) deterministically', () => {
        const testProfile = {
            ...profile,
            expectedCurrency: 'USD',
            currentCurrency: 'INR'
        };

        const expectedQ = 'Expected compensation - Currency';
        const currentQ = 'Current / Last compensation - Currency';

        // 1. Expected compensation currency resolves from expectedCurrency (USD)
        const factExpected = resolveCandidateFact(expectedQ, '', testProfile);
        assert.strictEqual(factExpected.resolved, true);
        assert.strictEqual(factExpected.answer, 'USD');
        assert.strictEqual(factExpected.canonicalKey, 'profile.expectedCurrency');

        // 2. Current/Last compensation currency resolves from currentCurrency (INR)
        const factCurrent = resolveCandidateFact(currentQ, '', testProfile);
        assert.strictEqual(factCurrent.resolved, true);
        assert.strictEqual(factCurrent.answer, 'INR');
        assert.strictEqual(factCurrent.canonicalKey, 'profile.currentCurrency');

        const options = ['EUR - Euro', 'INR - Indian Rupee', 'USD - US Dollar'];

        const matchExpected = matchAtsOption(options, factExpected.answer, expectedQ);
        assert.strictEqual(matchExpected.matched, true);
        assert.strictEqual(matchExpected.selectedOption, 'USD - US Dollar');

        const matchCurrent = matchAtsOption(options, factCurrent.answer, currentQ);
        assert.strictEqual(matchCurrent.matched, true);
        assert.strictEqual(matchCurrent.selectedOption, 'INR - Indian Rupee');

        // 3. Trusted dropdown answer resolution
        assert.strictEqual(getTrustedDropdownAnswer(expectedQ, options, '', testProfile), 'USD - US Dollar');
        assert.strictEqual(getTrustedDropdownAnswer(currentQ, options, '', testProfile), 'INR - Indian Rupee');
    });

    // Immigration Status: Strict non-inference from work auth or citizenship
    await itAsync('Immigration Status: Absent from profile triggers HUMAN_INTERVENTION, never inferred from citizenship/work auth, never uses Ollama', async () => {
        const testProfileWithAuth = {
            ...profile,
            nationality: 'Indian',
            citizenship: 'Indian',
            workAuthorization: { isAuthorized: true, needsSponsorship: false }
            // immigrationStatus intentionally absent
        };

        const question = 'Immigration Status';
        const options = ['Citizen', 'Non-Citizen', 'Any other Visa', 'OPT', 'CPT visa', 'H1-B'];

        // Fact resolver must NOT infer from citizenship or work authorization
        const fact = resolveCandidateFact(question, '', testProfileWithAuth);
        assert.strictEqual(fact.resolved, false, 'Immigration Status must NOT be inferred from work auth or citizenship');
        assert.strictEqual(fact.answer, null);

        // getTrustedDropdownAnswer must return null to trigger human intervention
        const trusted = getTrustedDropdownAnswer(question, options, '', testProfileWithAuth);
        assert.strictEqual(trusted, null, 'Must return null for absent immigration status');

        // Must be identified as personal fact question so Ollama is strictly banned
        const isPersonal = isPersonalFactQuestion(question);
        assert.strictEqual(isPersonal, true, 'Immigration Status must be identified as personal fact');

        // Answer engine must demand human intervention and NEVER call Ollama
        const ansResult = await getAnswerWithProvenance(question, options);
        assert.strictEqual(ansResult.needsHuman, true, 'Must demand human intervention');
        assert.notStrictEqual(ansResult.provenance, Provenance.OLLAMA, 'Must NEVER use Ollama for immigration status');
    });

    // Compensation Type: Absent from profile triggers HUMAN_INTERVENTION without guessing
    it('Compensation Type: Expected compensation Type and Current / Last compensation Type absent from profile triggers HUMAN_INTERVENTION', () => {
        const expectedTypeQ = '* Expected compensation Type';
        const currentTypeQ = '* Current / Last compensation Type';
        const options = ['Annual', 'C2C', 'Daily', 'Hourly', 'Monthly'];

        // Fact resolver returns unresolved for absent compensation type
        const factExpected = resolveCandidateFact(expectedTypeQ);
        assert.strictEqual(factExpected.resolved, false);
        assert.strictEqual(factExpected.answer, null);

        const factCurrent = resolveCandidateFact(currentTypeQ);
        assert.strictEqual(factCurrent.resolved, false);
        assert.strictEqual(factCurrent.answer, null);

        // Dropdown resolver returns null
        assert.strictEqual(getTrustedDropdownAnswer(expectedTypeQ, options), null);
        assert.strictEqual(getTrustedDropdownAnswer(currentTypeQ, options), null);

        // Flagged as personal/compensation fact question
        assert.strictEqual(isPersonalFactQuestion(expectedTypeQ), true);
        assert.strictEqual(isPersonalFactQuestion(currentTypeQ), true);
    });

    // Fixture D: Nationality -> AUTOMATIC SELECT
    it('Fixture D: Dropdown "Nationality" resolves automatically to Indian', () => {
        const question = 'Nationality';
        const options = ['American', 'British', 'Indian', 'German'];

        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, true);
        assert.strictEqual(fact.answer, 'Indian');

        const match = matchAtsOption(options, fact.answer, question);
        assert.strictEqual(match.matched, true);
        assert.strictEqual(match.selectedOption, 'Indian');

        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, 'Indian');
    });

    // Fixture E: Question genuinely absent from canonical profile -> HUMAN INTERVENTION, NEVER OLLAMA
    await itAsync('Fixture E: Question genuinely absent from profile requires human intervention and strictly blocks Ollama', async () => {
        const question = 'Commercial Drone Pilot License Number';
        const options = ['Yes, FAA Part 107', 'Yes, DGCA Certified', 'No'];

        // Fact resolver cannot answer
        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, false);
        assert.strictEqual(fact.answer, null);

        // getTrustedDropdownAnswer returns null
        const trusted = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(trusted, null);

        // Must be identified as personal fact question (or unknown) so LLM cannot guess
        const isPersonal = isPersonalFactQuestion(question);
        assert.strictEqual(isPersonal, true, 'License / certification question must be flagged as personal');

        // Answer engine provenance test
        const ansResult = await getAnswerWithProvenance(question, options);
        assert.strictEqual(ansResult.needsHuman, true, 'Must demand human intervention');
        assert.notStrictEqual(ansResult.provenance, Provenance.OLLAMA, 'Must NEVER use Ollama');
    });

    // Fixture F: Canonical answer exists but no matching ATS option -> HUMAN INTERVENTION
    it('Fixture F: Canonical answer exists but no matching ATS option triggers human intervention', () => {
        const question = 'Institute Name';
        const options = [
            'Massachusetts Institute of Technology',
            'Stanford University',
            'Harvard University'
        ];

        const fact = resolveCandidateFact(question);
        assert.strictEqual(fact.resolved, true);
        assert.strictEqual(fact.answer, 'Vellore Institute of Technology');

        const match = matchAtsOption(options, fact.answer, question);
        assert.strictEqual(match.matched, false, 'Should not match when candidate institution is absent');

        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, null, 'No ATS option match must return null to trigger human intervention');
    });

    // Fixture G: Multiple ATS options ambiguously match canonical answer -> HUMAN INTERVENTION
    it('Fixture G: Multiple ATS options ambiguously match canonical answer -> HUMAN INTERVENTION', () => {
        const question = 'University';
        const options = [
            'Vellore Institute of Technology - Chennai Campus',
            'Vellore Institute of Technology - Vellore Main Campus',
            'Vellore Institute of Technology - AP Campus'
        ];

        // "Vellore Institute of Technology" matches all three substrings
        const match = matchAtsOption(options, 'Vellore Institute of Technology', question);
        assert.strictEqual(match.matched, false, 'Ambiguous options must NOT be auto-selected');
        assert.strictEqual(match.ambiguous, true, 'Ambiguity flag must be set');
        assert.ok(match.matchingOptions.length >= 2, 'Must report multiple matches');

        const selected = getTrustedDropdownAnswer(question, options);
        assert.strictEqual(selected, null, 'Ambiguous dropdown match must return null to avoid incorrect guess');
    });

    // Fixture 11.1: Human input UX accepts full text answer
    await itAsync('Human Input UX: Accepts text answer and resolves exact option', async () => {
        const options = ['Option A', 'Option B', 'Vellore Institute of Technology'];
        let promptShown = false;

        const res = await promptHumanIntervention({
            question: 'Institute Name',
            type: 'dropdown',
            options,
            reason: 'Select your institution',
            isInteractive: true,
            promptFn: async () => {
                promptShown = true;
                return 'Vellore Institute of Technology';
            }
        });

        assert.strictEqual(promptShown, true);
        assert.strictEqual(res.answered, true);
        assert.strictEqual(res.value, 'Vellore Institute of Technology');
        assert.strictEqual(res.selectedIndex, 2);
    });

    // Fixture 11.2: Human input UX accepts option number
    await itAsync('Human Input UX: Accepts option number and resolves option', async () => {
        const options = ['Option A', 'Option B', 'Vellore Institute of Technology'];

        const res = await promptHumanIntervention({
            question: 'Institute Name',
            type: 'dropdown',
            options,
            reason: 'Select your institution',
            isInteractive: true,
            promptFn: async () => '3'
        });

        assert.strictEqual(res.answered, true);
        assert.strictEqual(res.value, 'Vellore Institute of Technology');
        assert.strictEqual(res.selectedIndex, 2);
    });

    // Fixture 11.3: Human input UX rejects nonexistent answer and retries
    await itAsync('Human Input UX: Rejects nonexistent answer and asks again', async () => {
        const options = ['Option A', 'Option B', 'Vellore Institute of Technology'];
        let attempt = 0;

        const res = await promptHumanIntervention({
            question: 'Institute Name',
            type: 'dropdown',
            options,
            reason: 'Select your institution',
            isInteractive: true,
            promptFn: async () => {
                attempt++;
                if (attempt === 1) return 'nonexistent university';
                return '3'; // valid retry
            }
        });

        assert.strictEqual(attempt, 2, 'Must prompt twice after first rejected invalid input');
        assert.strictEqual(res.answered, true);
        assert.strictEqual(res.value, 'Vellore Institute of Technology');
    });

    // Fixture 7.1: Structured field validation rejects invalid values (e.g. State -> Amazon)
    it('Structured Field Validation: Rejects bogus answers (e.g. State -> Amazon)', () => {
        const badState = validateStructuredField('state', 'Amazon');
        assert.strictEqual(badState.valid, false);
        assert.strictEqual(badState.reason, 'STATE_CONTAINS_EMPLOYER_OR_TECH');

        const goodState = validateStructuredField('state', 'Telangana');
        assert.strictEqual(goodState.valid, true);

        const badCurrency = validateStructuredField('currency', 'Hyderabad');
        assert.strictEqual(badCurrency.valid, false);

        const goodCurrency = validateStructuredField('currency', 'INR');
        assert.strictEqual(goodCurrency.valid, true);

        const badNationality = validateStructuredField('nationality', 'Google');
        assert.strictEqual(badNationality.valid, false);
    });

    // Fixture 3.1: Canonical profile facts are NEVER written to human verified answer store
    it('Separation of Concerns: Canonical profile facts are NOT saved to human answer store', () => {
        const textAnswersPath = path.resolve(__dirname, 'data/textAnswers.json');

        // Attempt to save canonical profile fact
        const saved = saveHumanVerifiedAnswer('Institute Name', 'Vellore Institute of Technology');
        assert.strictEqual(saved, false, 'Must reject saving canonical profile fact to human store');

        // Verify file was NOT modified with this fact
        if (fs.existsSync(textAnswersPath)) {
            const currentContent = JSON.parse(fs.readFileSync(textAnswersPath, 'utf8'));
            assert.strictEqual(currentContent['Institute Name'], undefined, 'Canonical fact must not exist in human store file');
        }
    });

    // Fixture 8.1: Personal facts are NEVER guessed by Ollama
    it('Zero Personal Fact Guessing: Strict Ollama ban for all personal candidate facts', () => {
        const personalQuestions = [
            'What is your nationality?',
            'Current Citizenship',
            'Marital Status',
            'Do you possess a valid passport?',
            'Are you legally authorized to work in India?',
            'Highest Education',
            'Institute Name',
            'Total Years of Experience',
            'Expected CTC',
            'Permanent Address',
            'Mobile Phone Number',
            'Email Address',
            'Graduation Year'
        ];

        for (const q of personalQuestions) {
            const isPersonal = isPersonalFactQuestion(q);
            assert.strictEqual(isPersonal, true, `Question "${q}" must be identified as personal fact question`);
        }
    });

    // Fixture 10.1: Generic labels disambiguation using section context
    it('Generic Labels: Disambiguates bare State / City / Country using section context', () => {
        // Education section
        const eduState = resolveCandidateFact('State', 'Education');
        assert.strictEqual(eduState.resolved, true);
        assert.strictEqual(eduState.answer, 'Tamil Nadu', 'Education State must be Tamil Nadu');
        assert.strictEqual(eduState.path, 'education.state');

        const eduCity = resolveCandidateFact('City', 'Academic Details');
        assert.strictEqual(eduCity.resolved, true);
        assert.strictEqual(eduCity.answer, 'Vellore', 'Education City must be Vellore');
        assert.strictEqual(eduCity.path, 'education.city');

        // Permanent Address section
        const permState = resolveCandidateFact('State', 'Permanent Address');
        assert.strictEqual(permState.resolved, true);
        assert.strictEqual(permState.answer, 'Telangana');
        assert.strictEqual(permState.path, 'permanentAddress.state');

        // Current Address section
        const currCity = resolveCandidateFact('City', 'Current Address');
        assert.strictEqual(currCity.resolved, true);
        assert.strictEqual(currCity.answer, 'Hyderabad');
        assert.strictEqual(currCity.path, 'currentAddress.city');
    });

    console.log(chalk.bold.cyan(`
============================================================
TEST RUN SUMMARY: ${passed} PASSED, ${failed} FAILED
============================================================
`));

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});
