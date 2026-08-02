-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('PENDING', 'READY');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "escantillon_default" DOUBLE PRECISION NOT NULL DEFAULT 2.4;

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "page_count" INTEGER,
    "has_vector_geometry" BOOLEAN,
    "diagnosis_json" JSONB,
    "status" "PlanStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plans_organization_id_idx" ON "plans"("organization_id");

-- CreateIndex
CREATE INDEX "plans_project_id_idx" ON "plans"("project_id");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
