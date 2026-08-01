import { requireProfile } from "@/lib/auth/session";
import { getTenantPrisma } from "@/lib/db/tenant";

export const metadata = { title: "Cubicca" };

export default async function HomePage() {
  // Se vuelve a pedir acá aunque el layout ya lo haya hecho: el layout no
  // re-renderiza en cada navegación, la página sí.
  const profile = await requireProfile();

  // El orgId sale del profile de la sesión, nunca del request. De acá para
  // abajo, todo lo que se lea ya está aislado por organización.
  const db = getTenantPrisma(profile.organizationId);
  const projects = await db.project.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="flex flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Proyectos</h1>

      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay proyectos.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((project) => (
            <li key={project.id} className="rounded-md border px-4 py-3 text-sm">
              {project.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
