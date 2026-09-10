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
const { parseMessageDeterministic } = require('./sources/whatsapp/messageParser');
const { resolveDestinationUrl } = require('./sources/whatsapp/linkResolver');
const { checkLinkedInSession, ensureLinkedInLogin } = require('./sources/linkedin/auth');
const { buildNormalizedLinkedInJob } = require('./sources/linkedin/extractor');
const { selectResumeForJob } = require('./automation/resumeSelector');
const { DiscoveryCoordinator } = require('./discovery/coordinator');
const { checkWellfoundSession, ensureWellfoundLogin } = require('./sources/wellfound/auth');
const { buildNormalizedWellfoundJob } = require('./sources/wellfound/extractor');
const { generateStartupPitch } = require('./application/handlers/wellfoundNative');
const { checkWhatsAppSession, ensureWhatsAppLogin } = require('./sources/whatsapp/auth');
const { extractJobFromWhatsApp } = require('./sources/whatsapp/jobExtractor');
const { hashMessageText } = require('./sources/whatsapp/channelMonitor');
const { executeSubmissionSafely } = require('./application/safetyBoundary');
const { recordApplicationResult } = require('./db/repository');
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

    await itAsync('should execute irreversible action when dryRun is false', async () => {
        let executed = false;
        const result = await executeSubmissionSafely({
            dryRun: false,
            actionName: 'Test Final Submit',
            execute: async () => {
                executed = true;
                return { status: 'REAL_SUCCESS' };
            }
        });
        assert.strictEqual(executed, true, 'Action must execute when dryRun is false');
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
        const fakeResume = { fileName: 'resume.pdf', path: path.resolve(__dirname, 'resume/resume.pdf'), type: 'MAIN' };
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
                return {
                    first: () => ({
                        isVisible: async () => isSubmit,
                        innerText: async () => 'Submit Application',
                        click: async () => { if (isSubmit) finalSubmitClicked = true; },
                        scrollIntoViewIfNeeded: async () => {}
                    }),
                    all: async () => [],
                    count: async () => isSubmit ? 1 : 0
                };
            },
            waitForLoadState: async () => {},
            evaluate: async () => false,
            waitForTimeout: async () => {}
        };
        const job = createNormalizedJob({
            source: 'WHATSAPP',
            title: 'Research Engineer',
            company: 'OpenAI',
            applicationUrl: 'https://boards.greenhouse.io/openai/jobs/999'
        });
        const fakeResume = { fileName: 'resume.pdf', path: path.resolve(__dirname, 'resume/resume.pdf'), type: 'MAIN' };
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
