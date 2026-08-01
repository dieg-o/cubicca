"use server";

import { randomUUID } from "node:crypto";

import { redirect } from "next/navigation";

import { getSessionProfile, requireSession } from "@/lib/auth/session";
import { getRawPrisma } from "@/lib/db/tenant";

export type OnboardingFormState = { error: string } | undefined;

const MAX_NAME_LENGTH = 80;

/**
 * Slug único a partir del nombre.
 *
 * El sufijo aleatorio no es decorativo: `organizations.slug` es UNIQUE, y dos
 * personas creando "Estudio Contable" el mismo día es un choque garantizado.
 */
function toSlug(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca los acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);

  return `${base || "org"}-${randomUUID().slice(0, 8)}`;
}

/**
 * Crea la organización del usuario y su profile como OWNER.
 *
 * Es el momento exacto en que un usuario autenticado pasa a tener organización,
 * o sea: el único lugar, junto con la resolución del profile, donde se toca la
 * base sin scopear. De acá en adelante todo va por getTenantPrisma(orgId).
 */
export async function createOrganization(
  _state: OnboardingFormState,
  formData: FormData
): Promise<OnboardingFormState> {
  // No usamos requireProfile: acá justamente todavía no hay profile.
  const user = await requireSession();

  // Un segundo submit (doble click, request repetido) no puede crear una
  // segunda organización: el action es un POST alcanzable sin pasar por la UI.
  if (await getSessionProfile()) {
    redirect("/");
  }

  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { error: "Poné un nombre para la organización." };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return { error: `El nombre no puede pasar de ${MAX_NAME_LENGTH} caracteres.` };
  }

  try {
    await getRawPrisma().$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name, slug: toSlug(name) },
      });

      // Quien crea la organización es su OWNER. Va en la misma transacción que
      // el create de arriba: una organización sin profile sería una org
      // huérfana a la que nadie puede entrar.
      await tx.profile.create({
        data: {
          userId: user.userId,
          email: user.email,
          organizationId: organization.id,
          role: "OWNER",
        },
      });
    });
  } catch (error) {
    console.error("[onboarding] falló la creación de organización + profile:", error);

    return { error: "No se pudo crear la organización. Probá de nuevo." };
  }

  redirect("/");
}
