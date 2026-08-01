import { redirect } from "next/navigation";

import { signup } from "@/app/(auth)/actions";
import { CredentialsForm } from "@/app/(auth)/credentials-form";
import { getSessionUser } from "@/lib/auth/session";

export const metadata = { title: "Crear cuenta — Cubicca" };

export default async function SignupPage() {
  // Igual que /login: la sesión se verifica acá, no en el proxy.
  if (await getSessionUser()) {
    redirect("/");
  }

  return (
    <CredentialsForm
      action={signup}
      title="Crear cuenta"
      submitLabel="Crear cuenta"
      footer={{ question: "¿Ya tenés cuenta?", linkLabel: "Ingresá", href: "/login" }}
    />
  );
}
