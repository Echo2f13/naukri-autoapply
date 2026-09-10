'use strict';

/**
 * Scoped DOM selectors for LinkedIn Jobs search, details, authentication, and Easy Apply.
 */
module.exports = {
    // Search Results Container & Cards
    jobListContainer: '.jobs-search-results-list, ul.scaffold-layout__list-container',
    jobCard: 'li.jobs-search-results__list-item, li.scaffold-layout__list-item, .job-card-container',
    
    // Within Job Card
    jobTitle: 'a.job-card-list__title, a.job-card-container__link, strong',
    companyName: '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .base-search-card__subtitle',
    location: '.job-card-container__metadata-item, .artdeco-entity-lockup__caption, .job-search-card__location',
    postedAge: 'time, .job-card-container__footer-item, .job-search-card__listdate',
    easyApplyBadge: '.job-card-container__apply-method, [class*="easy-apply"], .job-card-container__footer-item',
    
    // Details Pane
    detailsPane: '.jobs-search__job-details--container, .job-view-layout, .jobs-description',
    detailsTitle: '.job-details-jobs-unified-top-card__job-title, h1.t-24, h1',
    detailsCompany: '.job-details-jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__primary-description a',
    detailsLocation: '.job-details-jobs-unified-top-card__primary-description-container span, .job-details-jobs-unified-top-card__bullet',
    description: '#job-details, .jobs-box__html-content, .jobs-description__content, .show-more-less-html__markup',
    insights: '.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight, .job-details-jobs-unified-top-card__attribute',
    applyButton: 'button.jobs-apply-button, button[aria-label*="Easy Apply"]',
    externalApplyButton: 'button.jobs-apply-button--top-card, a[data-tracking-control-name="public_jobs_apply-link-offsite"]',
    alreadyAppliedBadge: '.artdeco-inline-feedback--success, [aria-label*="Applied"]',

    // Authentication & Security Boundaries
    loggedInIndicators: [
        'nav.global-nav',
        'header#global-nav',
        '.global-nav__primary-items',
        '.global-nav__me-photo',
        'button#nav-me-profile',
        '.feed-identity-module',
        '[data-view-name="feed-identity-module"]',
        'button[aria-label*="Me"]',
        'button[aria-label*="Profile"]',
        '.scaffold-layout__main',
        '#global-nav-search',
        'a[href*="/in/"]',
        '[data-control-name="nav.settings_signout"]'
    ],
    loginIndicators: [
        'form.login__form',
        '.sign-in-form',
        'input#username',
        'a[data-tracking-control-name="guest_homepage-basic_nav-header-signin"]',
        'button[type="submit"]:has-text("Sign in")'
    ],
    authwallIndicators: [
        '[data-tracking-control-name="authwall"]',
        '.authwall-join-form',
        '.contextual-sign-in-modal'
    ],
    securityChallengeIndicators: [
        'iframe[src*="captcha"]',
        '#captcha-internal',
        '.challenge-page',
        'div[data-test-id="checkpoint"]',
        'iframe[src*="challenge"]',
        '[data-test-id="recaptcha"]'
    ],

    // Easy Apply Modals & Fields
    easyApplyModal: 'dialog, .jobs-easy-apply-modal, div[role="dialog"]',
    textInputs: 'input[type="text"], input[type="number"], input[type="tel"], textarea',
    radioGroups: 'fieldset, [role="radiogroup"]',
    selectDropdowns: 'select, [role="combobox"], button[aria-haspopup="listbox"]',
    checkboxes: 'input[type="checkbox"], [role="checkbox"]',
    fileInput: 'input[type="file"]',
    uploadedResumeIndicator: '.jobs-document-upload__title, [class*="resume-picker__resume"]',
    nextButton: 'button[aria-label*="Continue to next step"], button:has-text("Next")',
    reviewButton: 'button[aria-label*="Review your application"], button:has-text("Review")',
    submitButton: 'button[aria-label*="Submit application"], button:has-text("Submit application")',
    dismissButton: 'button[aria-label="Dismiss"], button[aria-label="Cancel"]',
    discardConfirmButton: 'button[data-control-name="discard_application_confirm_btn"], button:has-text("Discard")',
    submissionSuccess: 'text=/Application submitted|Application sent/i, .artdeco-inline-feedback--success',
    validationError: '.artdeco-inline-feedback--error, [data-test-form-element-error-messages], .fb-form-element__error-text'
};
