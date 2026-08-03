-- CreateEnum
CREATE TYPE "MeasurementType" AS ENUM ('LARGO_CONTINUO', 'MURO', 'AREA');

-- CreateTable
CREATE TABLE "measurements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "type" "MeasurementType" NOT NULL,
    "page_index" INTEGER NOT NULL,
    "geometry_json" JSONB NOT NULL,
    "computed_value" DOUBLE PRECISION NOT NULL,
    "alto" DOUBLE PRECISION,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "measurements_organization_id_idx" ON "measurements"("organization_id");

-- CreateIndex
CREATE INDEX "measurements_plan_id_idx" ON "measurements"("plan_id");

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
