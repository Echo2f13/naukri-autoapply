'use strict';

/**
 * Scoped DOM selectors for Wellfound (formerly AngelList Talent) job discovery and application.
 */
module.exports = {
    // Search Results & Job Cards
    jobCard: '[data-test="JobListingCard"], div[class*="styles_jobListing"], div[class*="styles_result"], div[class*="styles_component__Ey28k"], a[class*="styles_jobLink"]',
    jobTitle: 'a[data-test="JobListingTitle"], h2[class*="styles_title"], [class*="styles_jobTitle"] a, a[class*="styles_jobLink"]',
    companyName: 'a[data-test="StartupResultHeader"], [class*="styles_startupName"] a, [class*="styles_companyName"], a[href*="/company/"]',
    location: '[data-test="JobListingLocation"], [class*="styles_location"]',
    salaryOrComp: '[data-test="JobListingCompensation"], [class*="styles_compensation"]',
    tags: '[data-test="JobListingTags"] span, [class*="styles_tags"] span, [class*="styles_tag"]',
    postedAge: '[class*="styles_posted"], [class*="styles_timestamp"], time',
    
    // Details View
    detailsContainer: '[data-test="JobDescription"], [class*="styles_descriptionContainer"], div[class*="styles_jobView"]',
    description: '[data-test="JobDescription"], div[class*="styles_description"], div[class*="styles_body"]',
    equityOrCompDetail: '[data-test="JobCompensation"], [class*="styles_compensation"]',
    
    // Application Controls
    applyButton: 'button:has-text("Apply"), [data-test="JobListingApplyButton"], button:has-text("Quick Apply")',
    alreadyAppliedBadge: 'text=/Applied|Application submitted|Applied on Wellfound/i, [data-test="JobListingAppliedButton"]',
    noteModal: 'div[role="dialog"], [data-test="ApplicationModal"], div[class*="styles_modal"]',
    noteTextarea: 'textarea[name="note"], textarea[placeholder*="note" i], textarea[placeholder*="message" i], textarea',
    submitButton: 'button:has-text("Send application"), button:has-text("Submit"), button[type="submit"]',
    dismissButton: 'button[aria-label="Close"], button:has-text("Cancel")',

    // Authentication & Security Boundaries
    loggedInIndicators: [
        '[data-test="UserMenu"]',
        'button[aria-label="User menu"]',
        '[class*="styles_userMenu"]',
        'a[href*="/profile"]',
        'a[href*="/jobs/applied"]'
    ],
    loginIndicators: [
        'a[href*="/login"]',
        'form[action*="login"]',
        'input[type="email"][name="email"]',
        'a:has-text("Log In")',
        'button:has-text("Log In")'
    ],
    securityChallengeIndicators: [
        'iframe[src*="cloudflare"]',
        'iframe[src*="turnstile"]',
        'div.cf-turnstile',
        '#challenge-running',
        'div[id*="cf-wrapper"]'
    ]
};
