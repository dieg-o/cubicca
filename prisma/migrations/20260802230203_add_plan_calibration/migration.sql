-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "calibration_json" JSONB,
ADD COLUMN     "scale_factor" DOUBLE PRECISION;
