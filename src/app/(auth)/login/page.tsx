import { redirect } from "next/navigation";

import { login } from "@/app/(auth)/actions";
import { CredentialsForm } from "@/app/(auth)/credentials-form";
import { getSessionUser } from "@/lib/auth/session";

export const metadata = { title: "Ingresar — Cubicca" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // La verificación de verdad (el proxy solo mira si la cookie existe). Va acá
  // y no en el proxy porque una cookie vencida haría rebotar al usuario entre
  // /login y / para siempre.
  if (await getSessionUser()) {
    redirect("/");
  }

  // En Next 16 searchParams es una Promise: hay que await-earla.
  const { next } = await searchParams;

  return (
    <CredentialsForm
      action={login}
      title="Ingresar"
      submitLabel="Ingresar"
      next={next}
      footer={{ question: "¿No tenés cuenta?", linkLabel: "Creá una", href: "/signup" }}
    />
  );
}
