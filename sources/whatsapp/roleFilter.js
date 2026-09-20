'use strict';

const profile = require('../../config/profile');

/**
 * Checks whether a job title matches canonical software/technology target roles.
 * Uses profile.jobRoles and canonical tech-role patterns.
 * 
 * @param {string} title - Job title or role name
 * @returns {{ eligible: boolean, matchedRole?: string, reason?: string, detail?: string }}
 */
function evaluateRoleEligibility(title = '') {
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return {
            eligible: false,
            reason: 'REJECTED_ROLE',
            detail: 'Missing or empty job title'
        };
    }

    const cleanTitle = title.trim();
    const lower = cleanTitle.toLowerCase();

    // 1. Strict blacklist of non-technical roles
    const nonTechRoles = [
        'telecaller', 'telesales', 'bpo', 'voice process', 'customer support',
        'customer service', 'sales executive', 'sales associate', 'sales manager',
        'business development', 'marketing executive', 'digital marketing',
        'content writer', 'copywriter', 'accountant', 'hr recruiter', 'recruiter',
        'talent acquisition', 'graphic designer', 'video editor', 'office assistant',
        'data entry', 'civil engineer', 'site engineer', 'mechanical engineer',
        'nurse', 'receptionist'
    ];

    for (const b of nonTechRoles) {
        if (lower.includes(b) && !lower.includes('software') && !lower.includes('developer')) {
            return {
                eligible: false,
                reason: 'REJECTED_ROLE',
                detail: `Role "${cleanTitle}" matches non-technical excluded role: "${b}"`
            };
        }
    }

    // 2. Canonical target roles from profile.jobRoles
    const targetJobRoles = (profile.jobRoles && Array.isArray(profile.jobRoles) && profile.jobRoles.length > 0)
        ? profile.jobRoles
        : [
            'Software Engineer',
            'Backend Developer',
            'Software Developer',
            'AI Engineer',
            'Full Stack Developer'
        ];

    // Check exact or partial match against canonical profile roles
    for (const target of targetJobRoles) {
        const targetLower = target.toLowerCase();
        if (lower.includes(targetLower) || targetLower.includes(lower)) {
            return {
                eligible: true,
                matchedRole: target,
                reason: 'TARGET_ROLE_MATCH'
            };
        }
    }

    // 3. Technical keywords match
    const techKeywords = [
        'developer', 'software', 'engineer', 'programmer', 'coder',
        'frontend', 'backend', 'full stack', 'fullstack', 'web developer',
        'app developer', 'application developer', 'enterprise app', 'enterprises app',
        'ai engineer', 'machine learning', 'data engineer', 'cloud engineer',
        'devops', 'sdet', 'qa engineer', 'systems engineer', 'systems', 'distributed',
        'architect', 'intern', 'internship'
    ];

    const matchedKeyword = techKeywords.find(kw => lower.includes(kw));
    if (matchedKeyword) {
        return {
            eligible: true,
            matchedRole: matchedKeyword,
            reason: 'TECH_ROLE_MATCH'
        };
    }

    return {
        eligible: false,
        reason: 'REJECTED_ROLE',
        detail: `Role "${cleanTitle}" does not match configured target software/technology roles: [${targetJobRoles.join(', ')}]`
    };
}

module.exports = {
    evaluateRoleEligibility
};
