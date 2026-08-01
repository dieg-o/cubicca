import { redirect } from "next/navigation";

import { OnboardingForm } from "@/app/onboarding/onboarding-form";
import { getSessionProfile, requireSession } from "@/lib/auth/session";

export const metadata = { title: "Crear organización — Cubicca" };

/**
 * Queda FUERA del grupo (app) a propósito: el layout de ahí manda a
 * /onboarding a quien no tiene profile, así que si esta página viviera adentro
 * se redirigiría a sí misma en loop.
 */
export default async function OnboardingPage() {
  const user = await requireSession();

  // Con profile ya no hay nada que hacer acá.
  if (await getSessionProfile()) {
    redirect("/");
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16">
      <div className="w-full max-w-sm space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Creá tu organización</h1>
        <p className="text-sm text-muted-foreground">
          Entraste como {user.email}. Todo tu trabajo va a vivir dentro de esta organización.
        </p>
      </div>

      <OnboardingForm />
    </div>
  );
}
