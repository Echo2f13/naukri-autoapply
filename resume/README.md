# Resume Configuration

This directory is intended to store your personal resume PDF files for automated job applications.

## Privacy Notice
To protect candidate privacy, **all `*.pdf` files in this directory are ignored by Git** and will never be committed to the public repository.

## Setup Instructions

1. Place your resume PDF(s) into this `resume/` directory.
2. The system supports dynamic resume selection based on job role matching (e.g. AI/ML vs Backend vs General).
3. Recommended naming conventions:
   - `resume.pdf` or `Main_resume.pdf` — General / default software engineering resume
   - `AI_resume.pdf` — Specialized AI / Machine Learning resume
   - `Backend_resume.pdf` — Specialized Backend / Systems engineering resume
4. Alternatively, you can configure an explicit custom path in your `.env` file:
   ```env
   RESUME_PATH="./resume/your_custom_resume.pdf"
   ```

The dynamic resume selector (`automation/resumeSelector.js`) will automatically match job roles and select the most relevant resume from this directory.
