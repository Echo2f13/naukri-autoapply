require('dotenv').config();
const path = require('path');

const settings = {
  databaseUrl: process.env.DATABASE_URL,
  geminiApiKey: process.env.GEMINI_API_KEY,
  // LMStudio local AI settings
  lmStudioBaseUrl: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234',
  lmStudioModel: process.env.LMSTUDIO_MODEL || 'gemma-4-e4b',
  // Ollama local AI settings
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  resumePath: path.resolve(process.env.RESUME_PATH || './YOUR_RESUME.pdf'),
  maxDailyApplications: parseInt(process.env.MAX_DAILY_APPLICATIONS || '30', 10),
  headless: process.env.HEADLESS === 'true',
  slowMo: parseInt(process.env.BROWSER_SLOW_MO || '0', 10),
  authDir: path.resolve(process.env.AUTH_DIR || './auth'),
  naukriUrl: 'https://www.naukri.com/',
  recommendedJobsUrl: 'https://www.naukri.com/recommendedjobs',
  selectors: {
    loginButton: 'a#login_Layer',
    usernameInput: 'input[placeholder="Enter your active Email ID / Username"]',
    passwordInput: 'input[placeholder="Enter your password"]',
    submitLogin: 'button[type="submit"]',
    jobCard: '.cust-job-tuple, article.jobTuple',
    jobTitle: 'a.title, p.title, .title',
    companyName: 'a.comp-name, .subTitle',
    applyButton: '#apply-button, button:has-text("Apply")',
    submitApplication: 'button:has-text("Submit")',
    questionsContainer: '.recruiter-questions-container',
  },
  delays: {
    min: 300,
    max: 1000,
    typing: {
      min: 0,
      max: 0
    }
  }
};

module.exports = settings;
