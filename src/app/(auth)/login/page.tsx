import { redirect } from "next/navigation";

import { login, type AuthFormState } from "@/app/(auth)/actions";
import { CredentialsForm } from "@/app/(auth)/credentials-form";
import { getSessionUser } from "@/lib/auth/session";

export const metadata = { title: "Ingresar — Cubicca" };

/**
 * `/auth/callback` manda acá con `?error=auth` cuando no pudo canjear el code.
 * El motivo real ya quedó en el log del servidor: al usuario se le da un mensaje
 * accionable y nada más.
 */
function initialStateFor(error: string | undefined): AuthFormState {
  if (error !== "auth") {
    return undefined;
  }

  return { error: "No pudimos confirmar el enlace. Puede haber vencido o ya haberse usado." };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  // La verificación de verdad (el proxy solo mira si la cookie existe). Va acá
  // y no en el proxy porque una cookie vencida haría rebotar al usuario entre
  // /login y / para siempre.
  if (await getSessionUser()) {
    redirect("/");
  }

  // En Next 16 searchParams es una Promise: hay que await-earla.
  const { next, error } = await searchParams;

  return (
    <CredentialsForm
      action={login}
      title="Ingresar"
      submitLabel="Ingresar"
      next={next}
      initialState={initialStateFor(error)}
      footer={{ question: "¿No tenés cuenta?", linkLabel: "Creá una", href: "/signup" }}
    />
  );
}
