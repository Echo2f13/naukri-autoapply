# Naukri Auto Apply System

An intelligent, AI-powered autonomous system that automatically applies to relevant jobs on Naukri daily using Playwright, local LLMs (LMStudio or Ollama), and PostgreSQL.

## Features

- **Local LLM Integration**: Auto-detects and integrates with LMStudio or Ollama running locally. Uses your PDF resume for context when answering recruiter questions.
- **Interactive Startup Menu**: Choose between processing **Recommended Jobs** or performing a **Custom Keyword Search**.
- **Multi-Pass Custom Search**: Run searches with custom keywords (e.g. `python`), location (e.g. `india`), run consecutive passes for `Fresher` and `1 year` experience levels, and force **Sort by Date**.
- **Global Experience Filter**: Automatically filters out jobs requiring > 2 years of experience in both search and recommendation modes.
- **Persistent Login**: Logs in once manually and reuses the session to avoid OTPs.
- **Anti-Detection**: Implements human-like typing, scrolling, and random delays.
- **Database Tracking**: Keeps a full history of applied jobs, status, and AI answers in PostgreSQL.
- **Daily Scheduling**: Runs automatically every day at 10:00 AM using `node-cron`.

## Tech Stack

- **Node.js** & **Playwright** (Automation)
- **Prisma** & **PostgreSQL** (Database)
- **LMStudio** & **Ollama** (Local AI Question Answering)
- **Node-cron** (Scheduling)

## Setup Instructions

### 1. Prerequisites
- Node.js installed.
- PostgreSQL database running.
- Local LLM server running:
  - **LMStudio** running on port `1234` with a loaded model (e.g., `gemma-4-e4b`), OR
  - **Ollama** running on port `11434` with a loaded model (e.g., `gemma3:4b` or `qwen2.5:3b`).

### 2. Installation
```bash
npm install
npx playwright install chromium
```

### 3. Database Setup
1. Create a database named `naukri_autoapply` in your PostgreSQL.
2. Update the `DATABASE_URL` in `.env` with your credentials (default password is `postgres`). (And all the required variables in .env)
3. Run migrations and client generator:
```bash
npx prisma migrate dev
npx prisma generate
```

### 4. Configuration
1. **Resume**: Make sure your resume is named `YOUR_RESUME.pdf` and placed in the project root directory (or update `RESUME_PATH` in `.env`).
2. **Profile**: Edit `config/profile.json` with your professional details, skills, and preferences.
3. **Environment**: Configure the local URLs in `.env` if your local AI uses custom ports.

### 5. Manual Login (First Run)
To save your session, run the login script once:
```bash
node manual_login.js
```
Wait for the browser to open, log in manually, and then close the browser. Your session will be saved in the `./auth` directory.

## Usage

### Run Bot
```bash
node index.js
```
Upon startup, the CLI will auto-detect active local LLMs and prompt you to configure your job search parameters (Recommended vs Custom Search).



### FOR SCHEDULE RUNNING
### Start Scheduler
To keep the system running daily in the background:
```bash
node scheduler/cron.js
```

## Anti-Detection & Safety
- **Daily Limit**: Controlled by `MAX_DAILY_APPLICATIONS` in `.env` (default 30).
- **Human-like Interaction**: The system types at varying speeds and pauses between actions.
- **Headed Mode**: By default, it runs in headed mode (`HEADLESS=false`) which is less likely to be detected as a bot.

## Troubleshooting
- **Prisma Client Error**: If you see `Cannot find module '.prisma/client/default'`, run:
  ```bash
  npx prisma generate
  ```
- **Captcha**: If a captcha appears, the system will take a screenshot in the `/screenshots` folder and log the event. You may need to solve it manually once in the persistent browser.
- **Login Expired**: If the session expires, run the Manual Login step again.
