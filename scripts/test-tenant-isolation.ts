import { randomUUID } from "node:crypto";
import path from "node:path";

import { config as loadEnv } from "dotenv";

// Igual que smoke-db.ts: v7 no autocarga .env. Orden .env.local -> .env
// (dotenv no pisa lo ya definido, así que el primero gana).
loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Test de la primitiva de aislamiento (src/lib/db/tenant.ts).
 *
 * Corre contra la base real: crea dos organizaciones desechables, verifica que
 * ninguna pueda ver ni tocar las filas de la otra, y las borra al final.
 *
 * No hay framework de tests todavía: esto es un script con aserciones y exit
 * code. Cuando entre uno, la lógica se muda tal cual.
 *
 * ⚠️ Al agregar un modelo tenant-scoped al schema: sumalo a
 * TENANT_SCOPED_MODELS y agregá acá su caso de lectura y de escritura cruzada.
 * ────────────────────────────────────────────────────────────────────────────
 */

let failures = 0;

function check(label: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`  ok   — ${label}`);

    return;
  }

  failures += 1;
  console.error(`  FALLÓ — ${label}${detail ? `: ${detail}` : ""}`);
}

/** El caso más importante del test: lo que TIENE que romper, rompe. */
async function checkThrows(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    check(label, true);

    return;
  }

  check(label, false, "la operación no lanzó error");
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("Falta DATABASE_URL en .env.local (pooler de Supabase, puerto 6543).");
  }

  // Import diferido: el módulo valida DATABASE_URL al instanciar.
  const { getTenantPrisma, getRawPrisma } = await import("../src/lib/db/tenant");

  const raw = getRawPrisma();

  // Sufijo por corrida: el slug es único y no queremos chocar con restos de
  // una corrida anterior que haya muerto antes del cleanup.
  const runId = randomUUID().slice(0, 8);

  const orgA = await raw.organization.create({
    data: { name: `Test A ${runId}`, slug: `test-a-${runId}` },
  });
  const orgB = await raw.organization.create({
    data: { name: `Test B ${runId}`, slug: `test-b-${runId}` },
  });

  try {
    const db = getTenantPrisma(orgA.id);

    // Semilla por fuera de la primitiva: queremos filas de B existiendo de
    // verdad, para que un fallo de aislamiento tenga algo que filtrar.
    const projectA = await raw.project.create({
      data: { organizationId: orgA.id, name: "Proyecto de A" },
    });
    const projectB = await raw.project.create({
      data: { organizationId: orgB.id, name: "Proyecto de B" },
    });

    console.log("\nLecturas");

    const visibles = await db.project.findMany();
    check(
      "findMany() sin where devuelve solo las filas de la propia org",
      visibles.length === 1 && visibles[0]?.id === projectA.id,
      `devolvió ${visibles.length} fila(s): ${visibles.map((p) => p.name).join(", ")}`
    );

    const ajenoPorId = await db.project.findUnique({ where: { id: projectB.id } });
    check(
      "findUnique() por id de otra org devuelve null",
      ajenoPorId === null,
      `devolvió ${JSON.stringify(ajenoPorId)}`
    );

    const ajenoPorFirst = await db.project.findFirst({ where: { name: "Proyecto de B" } });
    check(
      "findFirst() con where propio del caller sigue filtrado por org",
      ajenoPorFirst === null,
      `devolvió ${JSON.stringify(ajenoPorFirst)}`
    );

    const total = await db.project.count();
    check("count() cuenta solo la propia org", total === 1, `contó ${total}`);

    const porOrg = await db.project.groupBy({ by: ["organizationId"], _count: true });
    check(
      "groupBy() no agrupa filas de otra org",
      porOrg.length === 1 && porOrg[0]?.organizationId === orgA.id,
      `agrupó ${porOrg.length} organización(es)`
    );

    console.log("\nEscrituras");

    // El caso normal: el call site NO escribe organizationId y no necesita
    // castear nada para eso — el tipo lo declara opcional y la primitiva lo pone.
    const creado = await db.project.create({ data: { name: "Creado sin declarar org" } });
    check(
      "create() sin organizationId lo inyecta desde la sesión",
      creado.organizationId === orgA.id,
      `quedó en ${creado.organizationId}`
    );

    const declarado = await db.project.create({
      data: { name: "Creado declarando la propia org", organizationId: orgA.id },
    });
    check(
      "create() declarando el organizationId propio pasa",
      declarado.organizationId === orgA.id,
      `quedó en ${declarado.organizationId}`
    );

    await checkThrows("create() con el organizationId de otra org lanza error", () =>
      db.project.create({ data: { name: "Intruso", organizationId: orgB.id } })
    );

    await checkThrows("createMany() con una fila apuntando a otra org lanza error", () =>
      db.project.createMany({
        data: [{ name: "Propio" }, { name: "Intruso", organizationId: orgB.id }],
      })
    );

    // La forma anidada elude el campo plano. El tipo ya no la ofrece, así que
    // este caso solo se alcanza por fuera de TS (JS, datos armados en runtime);
    // el cast vive en el test para poder probarlo, nunca en un call site.
    const conRelacion = {
      data: { name: "Por relación", organization: { connect: { id: orgB.id } } },
    } as unknown as { data: { name: string } };

    await checkThrows("create() con `organization: { connect }` a otra org lanza error", () =>
      db.project.create(conRelacion)
    );

    await checkThrows("findMany() con un organizationId ajeno en el where lanza error", () =>
      db.project.findMany({ where: { organizationId: orgB.id } })
    );

    const upserted = await db.project.upsert({
      where: { id: projectB.id },
      create: { name: "Upsert desde A" },
      update: { name: "Pisado por A" },
    });
    check(
      "upsert() sobre un id de otra org crea en la propia en vez de pisar el ajeno",
      upserted.organizationId === orgA.id && upserted.id !== projectB.id,
      `resolvió a ${upserted.id} (org ${upserted.organizationId})`
    );

    const tocadas = await db.project.updateMany({ data: { name: "Renombrado masivo" } });
    check(
      "updateMany() sin where no alcanza filas de otra org",
      tocadas.count === 4,
      `actualizó ${tocadas.count} fila(s)`
    );

    await checkThrows("update() por id de otra org no encuentra la fila", () =>
      db.project.update({ where: { id: projectB.id }, data: { name: "Pisado" } })
    );

    // El where scopeado no alcanza acá: la fila es propia, lo que se cuela es
    // el destino. Un update así la sacaría del tenant.
    await checkThrows("update() no puede mover una fila propia a otra org", () =>
      db.project.update({
        where: { id: projectA.id },
        data: { organizationId: orgB.id },
      })
    );

    await checkThrows("updateMany() tampoco puede moverlas con la forma `{ set }`", () =>
      db.project.updateMany({ data: { organizationId: { set: orgB.id } } })
    );

    const borradas = await db.project.deleteMany();
    check(
      "deleteMany() sin where borra solo la propia org",
      borradas.count === 4,
      `borró ${borradas.count} fila(s)`
    );

    const sobrevivienteB = await raw.project.findUnique({ where: { id: projectB.id } });
    check(
      "la fila de la otra org sigue intacta después de todo lo anterior",
      sobrevivienteB !== null && sobrevivienteB.name === "Proyecto de B",
      `quedó ${JSON.stringify(sobrevivienteB)}`
    );

    console.log("\nContrato de la primitiva");

    await checkThrows("getTenantPrisma('') lanza error", async () => getTenantPrisma(""));

    // Documenta la frontera, no un bug: Organization NO es tenant-scoped (se
    // filtra por su propio id) y por eso la extensión la deja pasar sin tocar.
    const orgs = await db.organization.findMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    check(
      "los modelos fuera de TENANT_SCOPED_MODELS pasan sin filtrar (esperado)",
      orgs.length === 2,
      `devolvió ${orgs.length} organización(es)`
    );
  } finally {
    // onDelete: Cascade se lleva los projects de ambas orgs.
    await raw.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await raw.$disconnect();
  }

  if (failures > 0) {
    throw new Error(`${failures} verificación(es) de aislamiento fallaron.`);
  }

  console.log("\nOK — el aislamiento multi-tenant se sostiene.");
}

main().catch((error: unknown) => {
  console.error("\nTest de aislamiento FALLÓ.");
  console.error(error);

  process.exitCode = 1;
});
