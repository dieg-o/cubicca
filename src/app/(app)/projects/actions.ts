"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { getTenantPrisma } from "@/lib/db/tenant";

export type CreateProjectState = { error: string } | undefined;

/**
 * Validación al borde. El formulario ya limita `maxLength` y `min/max`, pero eso
 * es UX: un server action es un POST alcanzable sin pasar por la UI.
 */
const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Poné un nombre para el proyecto.")
    .max(80, "El nombre no puede pasar de 80 caracteres."),
  // Metros de altura. El rango es de sentido común, no de norma: por debajo de
  // 1 m o por encima de 20 m no hay escantillón, hay un dedazo.
  escantillonDefault: z.coerce
    .number("El escantillón tiene que ser un número.")
    .gte(1, "El escantillón tiene que estar entre 1 y 20 metros.")
    .lte(20, "El escantillón tiene que estar entre 1 y 20 metros."),
});

export async function createProject(
  _state: CreateProjectState,
  formData: FormData
): Promise<CreateProjectState> {
  // Se vuelve a exigir sesión + profile acá: el gate del layout no cubre un POST
  // mandado por fuera de la UI. De acá sale el orgId, nunca del formulario.
  const profile = await requireProfile();

  const parsed = createProjectSchema.safeParse({
    name: formData.get("name"),
    escantillonDefault: formData.get("escantillonDefault"),
  });

  if (!parsed.success) {
    // El primer mensaje alcanza: el form tiene dos campos y se muestra arriba.
    return { error: parsed.error.issues[0]?.message ?? "Revisá los datos del proyecto." };
  }

  let projectId: string;

  try {
    const db = getTenantPrisma(profile.organizationId);

    // Sin `organizationId`: lo inyecta la primitiva desde la sesión.
    const project = await db.project.create({
      data: { name: parsed.data.name, escantillonDefault: parsed.data.escantillonDefault },
      select: { id: true },
    });

    projectId = project.id;
  } catch (error) {
    console.error("[projects] falló la creación del proyecto:", error);

    return { error: "No se pudo crear el proyecto. Probá de nuevo." };
  }

  // Fuera del try: redirect() lanza una excepción de control de flujo, y
  // atajarla acá la convertiría en "no se pudo crear el proyecto".
  redirect(`/projects/${projectId}`);
}
