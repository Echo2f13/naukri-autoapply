'use strict';

const prisma = require('../db/prisma');
const chalk = require('chalk');

async function auditCorrectBirlaSoft() {
    console.log(chalk.bold.yellow('=== BirlaSoft Database Record Audit Correction ===\n'));

    try {
        const appliedJob = await prisma.appliedJob.findFirst({
            where: {
                OR: [
                    { company: { contains: 'Birla', mode: 'insensitive' } },
                    { jobUrl: { contains: 'birlasoft', mode: 'insensitive' } }
                ]
            }
        });

        const appRecord = await prisma.application.findFirst({
            where: {
                job: {
                    OR: [
                        { company: { contains: 'Birla', mode: 'insensitive' } },
                        { applicationUrl: { contains: 'birlasoft', mode: 'insensitive' } }
                    ]
                }
            }
        });

        console.log('BEFORE AUDIT CORRECTION:');
        console.log('AppliedJob:', appliedJob ? { id: appliedJob.id, status: appliedJob.status, appliedAt: appliedJob.appliedAt } : 'None');
        console.log('Application:', appRecord ? { id: appRecord.id, status: appRecord.status, appliedAt: appRecord.appliedAt } : 'None');

        if (!appliedJob && !appRecord) {
            console.log('No BirlaSoft record found to correct.');
            return;
        }

        // Apply audit correction
        if (appliedJob && appliedJob.status === 'SUCCESS') {
            await prisma.appliedJob.update({
                where: { id: appliedJob.id },
                data: {
                    status: 'FAILED',
                    errorMessage: 'AUDIT_CORRECTION: Unverified external application. Reclassified from false positive SUCCESS because resume upload and submission were never executed on SuccessFactors portal.'
                }
            });
            console.log(chalk.green('✔ AppliedJob record corrected: status=FAILED'));
        }

        if (appRecord && appRecord.status === 'SUCCESS') {
            await prisma.application.update({
                where: { id: appRecord.id },
                data: {
                    status: 'FAILED',
                    appliedAt: null,
                    failureReason: 'AUDIT_CORRECTION: SUBMISSION_NOT_VERIFIED - Reclassified from false positive SUCCESS because resume upload and submission were never executed on SuccessFactors portal.',
                    notes: 'AUDIT_CORRECTION: Previously misclassified as SUCCESS by hostname substring match on successfactors.'
                }
            });
            console.log(chalk.green('✔ Application record corrected: status=FAILED, appliedAt=null'));

            // Also update any attempt records
            await prisma.applicationAttempt.updateMany({
                where: { applicationId: appRecord.id },
                data: {
                    status: 'FAILED',
                    message: 'AUDIT_CORRECTION: Reclassified as FAILED (SUBMISSION_NOT_VERIFIED)',
                    errorDetails: 'No resume upload or submit button execution occurred on SuccessFactors.'
                }
            });
            console.log(chalk.green('✔ ApplicationAttempt records updated'));
        }

        // Fetch again to verify
        const updatedApplied = await prisma.appliedJob.findUnique({ where: { id: appliedJob.id } });
        const updatedApp = await prisma.application.findUnique({ where: { id: appRecord.id } });

        console.log('\nAFTER AUDIT CORRECTION:');
        console.log('AppliedJob:', { id: updatedApplied.id, status: updatedApplied.status, appliedAt: updatedApplied.appliedAt, error: updatedApplied.errorMessage });
        console.log('Application:', { id: updatedApp.id, status: updatedApp.status, appliedAt: updatedApp.appliedAt, failureReason: updatedApp.failureReason });

    } catch (err) {
        console.error('Audit correction failed:', err.message);
    } finally {
        await prisma.$disconnect();
    }
}

auditCorrectBirlaSoft();
