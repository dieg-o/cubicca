import { redirect } from "next/navigation";

import { login, type AuthFormState } from "@/app/(auth)/actions";
import { CredentialsForm } from "@/app/(auth)/credentials-form";
import { getSessionUser } from "@/lib/auth/session";

export const metadata = { title: "Ingresar — Cubicca" };

/**
 * Las rutas de `/auth/*` mandan acá con `?error=` cuando no pudieron establecer
 * la sesión. El motivo técnico ya quedó en el log del servidor: al usuario se le
 * da un mensaje accionable y nada más.
 *
 * `used` no es una falla del sistema sino el desenlace normal de re-clickear un
 * link ya usado, así que va como `notice` —gris, informativo— y no como error en
 * rojo. Cubre también el link vencido: Supabase devuelve el mismo error para los
 * dos casos, y en ambos lo que corresponde hacer es iniciar sesión.
 */
function initialStateFor(error: string | undefined): AuthFormState {
  if (error === "used") {
    return { notice: "Este enlace ya se usó o venció. Si ya confirmaste tu cuenta, ingresá." };
  }

  if (error === "auth") {
    return { error: "No pudimos confirmar el enlace. Probá de nuevo o pedí uno nuevo." };
  }

  return undefined;
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
