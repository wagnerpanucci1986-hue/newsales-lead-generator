-- CreateTable
CREATE TABLE "InstagramProfile" (
    "username" TEXT NOT NULL,
    "igId" TEXT,
    "name" TEXT,
    "biography" TEXT,
    "website" TEXT,
    "followersCount" INTEGER,
    "followsCount" INTEGER,
    "mediaCount" INTEGER,
    "profilePictureUrl" TEXT,
    "lastPostAt" TIMESTAMP(3),
    "phones" TEXT[],
    "emails" TEXT[],
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramProfile_pkey" PRIMARY KEY ("username")
);

-- CreateIndex
CREATE INDEX "InstagramProfile_fetchedAt_idx" ON "InstagramProfile"("fetchedAt");
