const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const resumeDir = path.resolve(__dirname, '../resume');

function findResumeFile(pattern) {
    if (!fs.existsSync(resumeDir)) return null;
    const files = fs.readdirSync(resumeDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    const matched = files.find(f => pattern.test(f));
    return matched ? path.join(resumeDir, matched) : null;
}

const RESUMES = {
    get AI() { return findResumeFile(/ai|ml/i) || path.join(resumeDir, 'AI_resume.pdf'); },
    get BACKEND() { return findResumeFile(/backend|be/i) || path.join(resumeDir, 'Backend_resume.pdf'); },
    get MAIN() { return findResumeFile(/main|general|full/i) || findResumeFile(/.+/) || path.join(resumeDir, 'resume.pdf'); }
};

const AI_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning',
    'nlp', 'natural language', 'llm', 'large language', 'genai', 'generative ai',
    'rag', 'computer vision', 'data scientist', 'data science', 'applied ai',
    'prompt engineer', 'pytorch', 'tensorflow', 'hugging face', 'langchain',
    'langgraph', 'chromadb', 'embeddings', 'vector search', 'transformers'
];

const BACKEND_KEYWORDS = [
    'backend', 'back end', 'back-end', 'python', 'python developer', 'python engineer',
    'golang', 'go developer', 'django', 'fastapi', 'flask', 'rest api', 'api developer',
    'microservices', 'database', 'postgres', 'postgresql', 'sql', 'server',
    'distributed systems', 'systems engineer', 'cloud engineer', 'gorm', 'node', 'nodejs',
    'devops', 'docker', 'kubernetes', 'aws', 'ci/cd', 'linux', 'cloud'
];

/**
 * Helper to check if a keyword exists in text using word boundaries to prevent
 * partial matches (e.g. 'ai' matching 'trainee' or 'email', 'rag' matching 'storage').
 */
function hasKeyword(text, kw) {
    if (!text || !kw) return false;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Selects the most relevant resume from the resume/ directory based on job details.
 *
 * @param {Object} job - Job object containing role, company, description, etc.
 * @returns {{ type: 'AI'|'BACKEND'|'MAIN', path: string, fileName: string }}
 */
function selectResumeForJob(job = {}) {
    const titleStr = job.title || job.role || '';
    const roleText = titleStr.toLowerCase();
    const fullText = `${titleStr} ${job.company || ''} ${job.description || ''} ${Array.isArray(job.skills) ? job.skills.join(' ') : ''}`.toLowerCase();

    let aiScore = 0;
    let beScore = 0;

    // Role title has 3x weight
    AI_KEYWORDS.forEach(kw => {
        if (hasKeyword(roleText, kw)) aiScore += 3;
        else if (hasKeyword(fullText, kw)) aiScore += 1;
    });

    BACKEND_KEYWORDS.forEach(kw => {
        if (hasKeyword(roleText, kw)) beScore += 3;
        else if (hasKeyword(fullText, kw)) beScore += 1;
    });

    let chosenType = 'MAIN';
    if (aiScore > 0 && aiScore >= beScore) {
        chosenType = 'AI';
    } else if (beScore > 0 && beScore > aiScore) {
        chosenType = 'BACKEND';
    }

    let chosenPath = RESUMES[chosenType];

    // Fallback if the chosen file does not exist on disk
    if (!fs.existsSync(chosenPath)) {
        console.log(chalk.yellow(`[ResumeSelector] ⚠️ ${chosenType} resume not found at ${chosenPath}. Falling back to MAIN.`));
        chosenType = 'MAIN';
        chosenPath = RESUMES.MAIN;
    }

    if (!fs.existsSync(chosenPath)) {
        // Find any existing PDF in the resume directory
        const resumeDir = path.resolve(__dirname, '../resume');
        if (fs.existsSync(resumeDir)) {
            const files = fs.readdirSync(resumeDir).filter(f => f.toLowerCase().endsWith('.pdf'));
            if (files.length > 0) {
                chosenPath = path.join(resumeDir, files[0]);
                chosenType = 'MAIN';
            }
        }
    }

    const fileName = path.basename(chosenPath);
    console.log(chalk.cyan(`[ResumeSelector] Selected ${chalk.bold(chosenType)} resume: "${fileName}" for role: "${job.role || 'Unknown'}" (Scores — AI: ${aiScore}, BE: ${beScore})`));

    return {
        type: chosenType,
        path: chosenPath,
        fileName
    };
}

module.exports = { selectResumeForJob, RESUMES };
