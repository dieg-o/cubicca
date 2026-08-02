import { z } from "zod";

import { getSessionProfile } from "@/lib/auth/session";
import { getTenantPrisma } from "@/lib/db/tenant";
import { PLAN_DOWNLOAD_URL_TTL_SECONDS } from "@/lib/plans/constants";
import { getSupabaseAdmin, PLANS_BUCKET } from "@/lib/supabase/admin";

/** Node explícito: acá abajo cuelga Prisma (driver `pg`, sockets TCP). */
export const runtime = "nodejs";

const planIdSchema = z.uuid();

/**
 * Devuelve una URL firmada de lectura para el PDF de un plano.
 *
 * Por qué un route handler y no un server action: esto no muta nada y lo llama
 * el viewer al abrir un plano ya subido. Los actions son POST secuenciales por
 * cliente; una lectura no tiene por qué hacer cola detrás de una mutación.
 *
 * Lo que NO hace: proxear los bytes. El PDF va del browser a Storage directo —
 * pasarlo por el lambda sería pagar 50 MB de tránsito y chocar con su límite de
 * respuesta. Lo único que sale de acá es una URL de vida corta.
 *
 * `getSessionProfile()` en vez de `requireProfile()`: esto lo consume `fetch()`,
 * y un redirect a /login le devolvería HTML donde espera JSON.
 */
export async function GET(_request: Request, context: RouteContext<"/api/plans/[planId]/file">) {
  const profile = await getSessionProfile();

  if (!profile) {
    return Response.json({ error: "No autenticado." }, { status: 401 });
  }

  const { planId } = await context.params;
  const parsed = planIdSchema.safeParse(planId);

  if (!parsed.success) {
    return Response.json({ error: "Plano inválido." }, { status: 400 });
  }

  // La pertenencia la impone la primitiva: un plano de otra organización
  // simplemente no existe desde acá.
  const db = getTenantPrisma(profile.organizationId);

  const plan = await db.plan.findUnique({
    where: { id: parsed.data },
    select: { storagePath: true, status: true },
  });

  // Un plano PENDING todavía no tiene bytes en Storage: firmar una URL para él
  // daría un 400 recién en el browser, adentro de pdf.js.
  if (!plan || plan.status !== "READY") {
    return Response.json({ error: "El plano no existe." }, { status: 404 });
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .storage.from(PLANS_BUCKET)
      .createSignedUrl(plan.storagePath, PLAN_DOWNLOAD_URL_TTL_SECONDS);

    if (error || !data) {
      throw error ?? new Error("createSignedUrl no devolvió datos.");
    }

    return Response.json(
      { url: data.signedUrl },
      {
        // La URL firmada es una credencial de vida corta: no la cachea nadie,
        // ni el browser ni un CDN intermedio.
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    console.error("[plans] falló createSignedUrl:", error);

    return Response.json({ error: "No se pudo abrir el plano." }, { status: 500 });
  }
}
