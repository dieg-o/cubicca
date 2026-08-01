import { logout } from "@/app/(auth)/actions";
import { requireProfile } from "@/lib/auth/session";

/**
 * Node explícito. Ya es el default en Next 16, pero acá abajo cuelga todo lo
 * que toca Prisma (driver `pg`, sockets TCP): dejarlo escrito hace que un
 * `runtime = "edge"` puesto sin pensar choque contra esta línea.
 */
export const runtime = "nodejs";

/**
 * Layout de la app logueada. Sin sesión -> /login; sin profile -> /onboarding.
 *
 * ⚠️ Este gate es conveniencia, NO la frontera de seguridad. Los layouts no se
 * vuelven a renderizar al navegar entre rutas hermanas (partial rendering), y
 * los server actions son POST que se pueden mandar sin pasar por esta UI. Por
 * eso cada página y cada action vuelve a llamar a `requireProfile()`: es
 * cache() de React, así que dentro de un mismo render no cuesta nada.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="text-sm font-medium">Cubicca</span>

        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{profile.email}</span>

          {/* Logout como form: es una mutación, va por POST y no por un link. */}
          <form action={logout}>
            <button type="submit" className="text-sm underline underline-offset-4">
              Salir
            </button>
          </form>
        </div>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
