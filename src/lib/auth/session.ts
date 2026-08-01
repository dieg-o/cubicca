import { cache } from "react";
import { redirect } from "next/navigation";

import type { Role } from "@/generated/prisma/enums";
import { getRawPrisma } from "@/lib/db/tenant";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Capa de acceso a la sesión. Es el ÚNICO lugar del que sale un `orgId`.
 *
 * Regla: nada de lo que devuelvan estas funciones viene del request. El orgId
 * se resuelve del profile, que se resuelve del userId, que Supabase valida
 * contra su servidor de auth. Un `organizationId` que llegue por body, query o
 * header no se mira nunca.
 *
 * Todo va envuelto en `cache()` de React: durante un mismo render, el layout,
 * la página y los componentes anidados llaman a esto varias veces y se hace
 * una sola verificación por request.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type SessionUser = {
  userId: string;
  email: string;
};

export type SessionProfile = SessionUser & {
  profileId: string;
  organizationId: string;
  role: Role;
};

/**
 * El usuario autenticado, o null.
 *
 * Usa `getUser()`, no `getSession()`: el primero valida el token contra el
 * servidor de auth de Supabase, el segundo se cree lo que diga la cookie. Para
 * decidir permisos, la cookie sola no alcanza.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user?.email) {
    return null;
  }

  return { userId: data.user.id, email: data.user.email };
});

/** Como getSessionUser, pero manda a /login si no hay sesión. */
export const requireSession = cache(async (): Promise<SessionUser> => {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  return user;
});

/**
 * El profile del usuario, o null si todavía no completó el onboarding.
 *
 * Va por `getRawPrisma()` — uno de sus dos usos permitidos: acá justamente
 * estamos resolviendo a qué organización pertenece el usuario, así que todavía
 * no hay orgId con el cual scopear.
 */
export const getSessionProfile = cache(async (): Promise<SessionProfile | null> => {
  const user = await getSessionUser();

  if (!user) {
    return null;
  }

  const profile = await getRawPrisma().profile.findUnique({
    where: { userId: user.userId },
    select: { id: true, organizationId: true, role: true },
  });

  if (!profile) {
    return null;
  }

  return {
    ...user,
    profileId: profile.id,
    organizationId: profile.organizationId,
    role: profile.role,
  };
});

/**
 * La puerta de entrada de todo lo que toca datos de una organización.
 *
 * Sin sesión -> /login. Con sesión pero sin profile -> /onboarding.
 * Devuelve el orgId listo para `getTenantPrisma(orgId)`.
 *
 * ⚠️ Va llamada en CADA página y en CADA server action que toque datos, no solo
 * en el layout: los layouts no se re-renderizan al navegar (partial rendering),
 * y los server actions son POST alcanzables sin pasar por la UI.
 */
export const requireProfile = cache(async (): Promise<SessionProfile> => {
  await requireSession();

  const profile = await getSessionProfile();

  if (!profile) {
    redirect("/onboarding");
  }

  return profile;
});
