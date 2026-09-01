-- CreateTable
CREATE TABLE "AppliedJob" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "location" TEXT,
    "jobUrl" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "recruiterQuestions" JSONB,
    "aiAnswers" JSONB,
    "errorMessage" TEXT,
    "matchScore" INTEGER,

    CONSTRAINT "AppliedJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLog" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "JobLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppliedJob_jobUrl_key" ON "AppliedJob"("jobUrl");

-- CreateIndex
CREATE INDEX "AppliedJob_jobUrl_idx" ON "AppliedJob"("jobUrl");

-- CreateIndex
CREATE INDEX "AppliedJob_appliedAt_idx" ON "AppliedJob"("appliedAt");

-- CreateIndex
CREATE INDEX "JobLog_timestamp_idx" ON "JobLog"("timestamp");
