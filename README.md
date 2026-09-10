# Autonomous Multi-Source Job Discovery & Application Platform

An enterprise-grade, multi-source autonomous job discovery, deduplication, eligibility filtering, and application system built with Node.js, Playwright, PostgreSQL/Prisma, and local LLMs (Ollama / LMStudio).

The platform continuously discovers opportunities across **four independent peer pipelines** (**Naukri**, **LinkedIn**, **Wellfound**, and **WhatsApp Channels**), normalizes them into a unified schema, performs cross-source deduplication, filters against strict candidate constraints, scores job relevance using local AI, and routes applications to native flows and external Applicant Tracking Systems (**Workday**, **Zoho Recruit**, **Greenhouse**, **Lever**, and **Ashby**).

---

## Architecture Overview

```
                          ┌─────────────────────────────┐
                          │    masterController.js      │
                          │   (Universal Multi-Source)  │
                          └──────────────┬──────────────┘
                                         │
        ┌──────────────────┬─────────────┴────────────┬──────────────────┐
        ▼                  ▼                          ▼                  ▼
┌───────────────┐  ┌───────────────┐          ┌───────────────┐  ┌───────────────┐
│    Naukri     │  │   LinkedIn    │          │   Wellfound   │  │   WhatsApp    │
│   Pipeline    │  │   Pipeline    │          │   Pipeline    │  │   Channels    │
└───────┬───────┘  └───────┬───────┘          └───────┬───────┘  └───────┬───────┘
        │                  │                          │                  │
        └──────────────────┼──────────────────────────┴──────────────────┘
                           ▼
        ┌─────────────────────────────────────────────┐
        │        discovery/normalizedJob.js           │
        │      Universal NormalizedJob Factory        │
        └──────────────────┬──────────────────────────┘
                           ▼
        ┌─────────────────────────────────────────────┐
        │        discovery/deduplicator.js            │
        │  Canonical URL + Fingerprints + ATS ID      │
        └──────────────────┬──────────────────────────┘
                           ▼
        ┌─────────────────────────────────────────────┐
        │  eligibilityEngine.js & jobScorer.js        │
        │  Hard Constraints + Soft AI Match (0-100)   │
        └──────────────────┬──────────────────────────┘
                           ▼
        ┌─────────────────────────────────────────────┐
        │             application/router.js           │
        │  Target Resolution & Independent Handlers   │
        └──────┬──────────┬───────────┬─────────┬─────┘
               ▼          ▼           ▼         ▼
          [Naukri]   [LinkedIn]  [Wellfound] [Workday] [Zoho] [Generic ATS]
```

---

## Key Features

- **4 Peer Discovery Pipelines**:
  - **Naukri**: Search keywords, date-sorted multi-pass freshers filtering, and recruiter recommendations.
  - **LinkedIn**: Easy Apply job filtering, past-24h search, detail pane extraction, and multi-step modal automation.
  - **Wellfound (AngelList)**: Startup roles, salary/equity extraction, and custom tailored pitch notes.
  - **WhatsApp Channels**: Automated live monitoring of WhatsApp community job channels (e.g. `https://whatsapp.com/channel/0029Vb6KXjg2Jl8LVXUr5X25`), link unshortening, deterministic regex parsing, and SHA-256 message deduplication.
- **Universal NormalizedJob Contract**: Every pipeline produces consistent job objects with canonical URLs, source metadata, salary ranges, experience boundaries, and composite fingerprints.
- **Cross-Source Deduplication**: Eliminates duplicate listings across channels using canonical URLs, ATS job IDs, and company + normalized title fingerprints.
- **Hard Eligibility Filtering**: Pre-screens every role against candidate constraints (0-1 year experience tolerance, strict non-tech/sales blacklist, and approved locations).
- **Cognitive Answer Engine with Provenance Guard**:
  - Distinguishes **`VERIFIED_PROFILE`**, **`VERIFIED_CACHE`**, and **`LLM_INFERRED`** answers.
  - **Anti-Hallucination Guarantee**: AI guesses are strictly prohibited from mutating human-verified `textAnswers.json`.
- **Dynamic Role-Based Resume Selector**: Matches job requirements (AI/ML vs Backend vs Full Stack) against resume keyword matrices and validates real filesystem paths before submitting.
- **Human-in-the-Loop Security Boundaries**:
  - Never uses brittle CAPTCHA or Cloudflare bypass hacks.
  - Detects auth walls, bot challenges (Turnstile), and WhatsApp QR codes with `DETECT -> PAUSE / REPORT -> REQUIRE HUMAN ACTION`.

---

## Candidate Verified Facts (Ground Truth Architecture)

The Cognitive Answer Engine enforces strict candidate facts configured locally by the user:

| Field | Example Ground Truth Value | Origin |
|---|---|---|
| **Full Name** | Jane Doe | `config/profile.json` |
| **Email** | jane.doe@example.com | `config/profile.json` |
| **Mobile** | +91 9876543210 | `config/profile.json` |
| **Date of Birth** | **01/01/2001** (01 January 2001) | `config/profile.json` & `ai/answerEngine.js` |
| **PAN Card** | **ABCDE1234F** | `config/profile.json` & `ai/answerEngine.js` |
| **Degree & Major** | **Bachelor of Technology** in Computer Science | `config/profile.json` |
| **University** | Example Institute of Technology | `config/profile.json` |
| **Passout Year** | **2024** | `config/profile.json` |
| **Currently Pursuing** | **false** (coursework complete / seeking immediate full-time employment) | `config/profile.json` |
| **Experience** | 1 Year (configurable; tolerance allows applying for 0-2 YOE postings) | `config/profile.json` |
| **Notice Period** | Immediate (0 days) | `config/profile.json` |
| **Expected CTC** | ₹8,00,000 (8 LPA) | `config/profile.json` |

---

## User Configuration & Privacy Setup

> [!IMPORTANT]
> **Privacy Architecture:** This repository intentionally contains **NO real candidate personal information, passwords, resumes, or session cookies**. All user-specific files are strictly ignored by Git so that you can safely fork, clone, and customize the system.

### 1. Configure Your Candidate Profile
```bash
# Copy the example profile template to local config
cp config/profile.example.json config/profile.json
# Windows PowerShell:
# Copy-Item config/profile.example.json config/profile.json
```
Open `config/profile.json` and fill in your actual candidate facts (full name, email, phone, education, job roles, skills, and address). The application uses this as the single source of truth.

### 2. Configure Your Resumes
Place your personal resume PDF(s) into the `resume/` directory:
- `resume/Main_resume.pdf` (or `resume/resume.pdf`) — Default software engineering resume
- `resume/AI_resume.pdf` — Specialized AI / ML resume
- `resume/Backend_resume.pdf` — Specialized Backend / Systems engineering resume

All PDF files in `resume/` are automatically ignored by Git.

### 3. Configure Environment Variables
```bash
cp .env.example .env
```
Edit `.env` and fill in your database credentials and optional settings.

### 4. Authenticate Browser Sessions
Run the interactive session manager to log into target job boards:
```bash
npm run login
```
Session cookies are saved locally in the ignored `./auth` directory.

### Privacy Protected Files (Never Tracked in Git):
| Path | Reason |
|---|---|
| `config/profile.json` | Personal candidate facts (DOB, PAN, Address, Contact) |
| `.env` | Local credentials and database passwords |
| `resume/*.pdf` | Real candidate resume documents |
| `auth/` | Playwright browser profiles, storage, and cookies |
| `data/*.json` | Personal QA answer databases |
| `screenshots/`, `videos/` | Local run recordings |

---

## Getting Started

### 1. Prerequisites
- **Node.js** (v18 or higher)
- **PostgreSQL** database running locally or remotely
- **Playwright Chromium**
- **Ollama** or **LMStudio** running locally with a compatible model (e.g. `qwen2.5:7b`, `gemma:7b`)

### 2. Installation
```bash
npm install
npx playwright install chromium
```

### 3. Database Setup
1. Create a database in PostgreSQL named `naukri_autoapply`.
2. Configure `.env` with your connection string:
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naukri_autoapply"
   ```
3. Run migrations and generate Prisma client:
   ```bash
   npx prisma migrate dev
   npx prisma generate
   ```

---

## Running the Automation

### 1. Run Automated Test Suite (55 Tests)
Validates normalization contracts, cross-source deduplication, eligibility filters, provenance security, and all 4 pipelines:
```bash
npm test
```

### 2. Autonomous Multi-Source Job Discovery & Application (`masterController.js`)

#### Apply Across All 4 Sources (Naukri, LinkedIn, Wellfound, WhatsApp):
```bash
npm run autoapply:all
# or directly:
node masterController.js --sources=naukri,linkedin,wellfound,whatsapp --max=20 --min-score=50
```

#### Safe Dry-Run Mode (Test discovery, deduplication, scoring, and routing without clicking submit):
```bash
npm run autoapply:dry
# or:
node masterController.js --sources=naukri,linkedin,wellfound,whatsapp --dry-run
```

#### Headless Multi-Source Run:
```bash
node masterController.js --sources=naukri,linkedin,wellfound,whatsapp --headless --max=15
```

#### Single Source Execution:
```bash
# Run LinkedIn Easy Apply only:
node masterController.js --sources=linkedin --max=10

# Run Wellfound startup pipeline only:
node masterController.js --sources=wellfound --max=10

# Run Naukri search and recommendations:
node masterController.js --sources=naukri --mode=both --max=10
```

### 3. WhatsApp Live Channel Monitoring Daemon
To start real-time watcher on the target WhatsApp job channel:
```bash
npm run whatsapp:watch
```
Or run directly in node:
```bash
node -e "const { monitorChannelLive } = require('./sources/whatsapp/channelMonitor'); monitorChannelLive().catch(console.error);"
```

### 4. Unattended Daily Scheduler (`scheduler/cron.js`)
Runs the multi-source pipeline automatically every day at 10:00 AM:
```bash
npm run scheduler
```

### 5. Interactive Naukri CLI (Legacy UI)
For interactive mode with menu selection:
```bash
npm start
```

---

## CLI Options Reference

| Flag | Values | Default | Description |
|---|---|---|---|
| `--sources` | `naukri`, `linkedin`, `wellfound`, `whatsapp` | `naukri` | Comma-separated list of peer sources to query |
| `--max` | Integer | `10` | Maximum number of applications to submit in this run |
| `--min-score` | Integer (0-100) | `50` | Minimum AI relevance score required to apply |
| `--dry-run` | Flag | `false` | Discovers, scores, and navigates without submitting forms |
| `--headless` | Flag | `false` | Runs Chromium in headless mode |
| `--mode` | `both`, `recommended`, `search` | `both` | Naukri discovery mode |

---

## Directory Structure

```
naukri-autoapply/
├── masterController.js             # Universal multi-source entrypoint & CLI orchestrator
├── test-suite.js                   # Comprehensive 44-test regression suite
├── ARCHITECTURE.md                 # Complete system design & sequence diagrams
├── index.js                        # Interactive CLI (Naukri backward compatibility)
│
├── discovery/                      # Universal Discovery Subsystem
│   ├── normalizedJob.js            # NormalizedJob contract & composite fingerprinting
│   ├── deduplicator.js             # Canonical URL, ATS ID & cross-source deduplication
│   └── coordinator.js              # Multi-source pipeline runner, database sync & ranking
│
├── sources/                        # Peer Source Discovery Pipelines
│   ├── naukri/                     # Naukri discovery (search & recommendations)
│   ├── linkedin/                   # LinkedIn discovery (Easy Apply & past-24h cards)
│   ├── wellfound/                  # Wellfound discovery (startup roles & salary info)
│   └── whatsapp/                   # WhatsApp Channels (live watcher & message parser)
│
├── application/                    # Application Execution Subsystem
│   ├── router.js                   # Universal router (resolves ATS & dispatches handlers)
│   ├── coordinator.js              # Batch applicator with rate-limiting & persistence
│   └── handlers/                   # Decoupled ATS Handlers
│       ├── naukriNative.js         # Naukri 1-click & chatbot drawer flow
│       ├── linkedinEasyApply.js    # LinkedIn multi-step Easy Apply modal flow
│       ├── wellfoundNative.js      # Wellfound 1-click & custom pitch note flow
│       ├── workday.js              # Workday career portal automation
│       ├── zoho.js                 # Zoho Recruit candidate portal & multi-step forms
│       └── genericATS.js           # External career forms (Greenhouse, Lever, Ashby)
│
├── eligibility/                    # Hard Constraint Rejection Subsystem
│   ├── rules.js                    # Predicate rules (experience, company/role blacklist)
│   └── eligibilityEngine.js        # Filter engine
│
├── scoring/                        # Soft Match AI Scoring Subsystem
│   └── jobScorer.js                # 0-100 rubric scoring & decision engine
│
├── ai/                             # Anti-Hallucination Cognitive Answer Engine
│   ├── answerEngine.js             # Question responder with immutable candidate facts
│   ├── answerProvenance.js         # Provenance enum & safety guards
│   ├── ollama.js                   # Local Ollama client (qwen2.5:7b)
│   ├── lmstudio.js                 # Local LMStudio client
│   └── prompts.js                  # Candidate system prompts & PDF context
│
├── db/                             # Persistence & State Management
│   ├── repository.js               # Multi-entity CRUD (Job, Application, Attempt)
│   ├── queries.js                  # Query wrapper
│   └── prisma.js                   # Prisma singleton
│
├── config/
│   ├── profile.json                # Verified candidate profile (DOB, PAN, Degree)
│   ├── settings.js                 # Global timeouts, limits, and channel URLs
│   └── blacklist.json              # Excluded companies and non-tech titles
│
└── scheduler/
    └── cron.js                     # Multi-source unattended cron scheduler
```

---

## Safety & Anti-Detection

1. **Persistent Browser Sessions**: Reuses authentic profiles stored in `./auth` to maintain valid cookies across restarts.
2. **Human Delays & Typing Simulation**: Variable pauses, mouse movements, and natural keystroke cadence.
3. **Session Wall & CAPTCHA Detection**: If a security challenge occurs, the platform halts automation on that specific source and alerts the user for manual completion rather than attempting dangerous automated bypasses.
4. **Error Isolation**: Failure or security challenge on one pipeline (e.g. WhatsApp QR requirement) logs a warning and allows all other peer pipelines to proceed without disruption.
