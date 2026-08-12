-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "syncProgressCurrent" INTEGER,
ADD COLUMN     "syncProgressTotal" INTEGER,
ADD COLUMN     "syncStartedAt" TIMESTAMP(3);
