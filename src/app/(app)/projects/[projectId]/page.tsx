import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PlansPanel } from "@/app/(app)/projects/[projectId]/plans-panel";
import { requireProfile } from "@/lib/auth/session";
import { getTenantPrisma } from "@/lib/db/tenant";
import { toMeasurementSummary, toPlanSummary } from "@/lib/plans/view";

const projectIdSchema = z.uuid();

export default async function ProjectPage({ params }: PageProps<"/projects/[projectId]">) {
  const profile = await requireProfile();
  const { projectId } = await params;

  // Un id que ni siquiera es UUID no llega a la base: Prisma tiraría P2023 y
  // eso sería un 500 donde corresponde un 404.
  const parsed = projectIdSchema.safeParse(projectId);

  if (!parsed.success) {
    notFound();
  }

  const db = getTenantPrisma(profile.organizationId);

  // La pertenencia no se chequea a mano: la primitiva inyecta el organizationId
  // en el where, así que un proyecto de otra organización simplemente no existe.
  const project = await db.project.findUnique({
    where: { id: parsed.data },
    select: {
      id: true,
      name: true,
      escantillonDefault: true,
      plans: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          originalFilename: true,
          fileSizeBytes: true,
          status: true,
          pageCount: true,
          hasVectorGeometry: true,
          createdAt: true,
          diagnosisJson: true,
          scaleFactor: true,
          calibrationJson: true,
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  // Las mediciones van en su propia consulta, no como relación anidada del
  // proyecto: así también ellas pasan por la primitiva y se les inyecta el
  // `organizationId`. Leerlas colgando de `plans` funcionaría —el plano ya está
  // probado como propio— pero dejaría una lectura sin scopear por sí misma, y
  // esa excepción es justo la que después nadie recuerda.
  const measurements = await db.measurement.findMany({
    where: { planId: { in: project.plans.map((plan) => plan.id) } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      planId: true,
      type: true,
      pageIndex: true,
      geometryJson: true,
      computedValue: true,
      alto: true,
      label: true,
      createdAt: true,
    },
  });

  return (
    <div className="flex flex-1 flex-col gap-6 px-6 py-10">
      <div className="space-y-2">
        <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Proyectos
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>

        <p className="text-sm text-muted-foreground">
          Escantillón por defecto: {project.escantillonDefault} m
        </p>
      </div>

      <PlansPanel
        projectId={project.id}
        escantillonDefault={project.escantillonDefault}
        plans={project.plans.map(toPlanSummary)}
        measurements={measurements.map(toMeasurementSummary)}
      />
    </div>
  );
}
