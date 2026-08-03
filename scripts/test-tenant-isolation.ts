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

    console.log("\nPlanos (modelo scopeado con FK a otro modelo scopeado)");

    // Proyecto nuevo para A: el deleteMany() de arriba se llevó los anteriores.
    // El de B sobrevivió, así que sirve de anclaje para las filas ajenas.
    const proyectoA = await raw.project.create({
      data: { organizationId: orgA.id, name: "Proyecto de A (planos)" },
    });

    const planFields = {
      storagePath: "seed/plan.pdf",
      originalFilename: "plano.pdf",
      contentType: "application/pdf",
      fileSizeBytes: 1024,
    };

    const planA = await raw.plan.create({
      data: { ...planFields, organizationId: orgA.id, projectId: proyectoA.id },
    });
    const planB = await raw.plan.create({
      data: {
        ...planFields,
        organizationId: orgB.id,
        projectId: projectB.id,
        originalFilename: "plano-de-b.pdf",
      },
    });

    const planesVisibles = await db.plan.findMany();
    check(
      "plan.findMany() sin where devuelve solo los planos de la propia org",
      planesVisibles.length === 1 && planesVisibles[0]?.id === planA.id,
      `devolvió ${planesVisibles.length} fila(s)`
    );

    const planAjeno = await db.plan.findUnique({ where: { id: planB.id } });
    check(
      "plan.findUnique() por id de otra org devuelve null",
      planAjeno === null,
      `devolvió ${JSON.stringify(planAjeno)}`
    );

    // El caso realista de fuga en esta feature: el call site filtra por
    // projectId —que ES el filtro natural del detalle de proyecto— y se olvida
    // de la org. El projectId de otra organización no puede devolver nada.
    const porProyectoAjeno = await db.plan.findMany({ where: { projectId: projectB.id } });
    check(
      "plan.findMany() por un projectId de otra org no devuelve nada",
      porProyectoAjeno.length === 0,
      `devolvió ${porProyectoAjeno.length} fila(s)`
    );

    const planesContados = await db.plan.count();
    check("plan.count() cuenta solo la propia org", planesContados === 1, `contó ${planesContados}`);

    const planCreado = await db.plan.create({
      data: { ...planFields, projectId: proyectoA.id },
    });
    check(
      "plan.create() sin organizationId lo inyecta desde la sesión",
      planCreado.organizationId === orgA.id,
      `quedó en ${planCreado.organizationId}`
    );

    await db.plan.create({
      data: { ...planFields, projectId: proyectoA.id, organizationId: orgA.id },
    });

    await checkThrows("plan.create() con el organizationId de otra org lanza error", () =>
      db.plan.create({
        data: { ...planFields, projectId: projectB.id, organizationId: orgB.id },
      })
    );

    await checkThrows("plan.createMany() con una fila apuntando a otra org lanza error", () =>
      db.plan.createMany({
        data: [
          { ...planFields, projectId: proyectoA.id },
          { ...planFields, projectId: projectB.id, organizationId: orgB.id },
        ],
      })
    );

    const planConRelacion = {
      data: {
        ...planFields,
        projectId: proyectoA.id,
        organization: { connect: { id: orgB.id } },
      },
    } as unknown as { data: typeof planFields & { projectId: string } };

    await checkThrows("plan.create() con `organization: { connect }` a otra org lanza error", () =>
      db.plan.create(planConRelacion)
    );

    await checkThrows("plan.findMany() con un organizationId ajeno en el where lanza error", () =>
      db.plan.findMany({ where: { organizationId: orgB.id } })
    );

    const planUpserted = await db.plan.upsert({
      where: { id: planB.id },
      create: { ...planFields, projectId: proyectoA.id },
      update: { originalFilename: "pisado-por-a.pdf" },
    });
    check(
      "plan.upsert() sobre un id de otra org crea en la propia en vez de pisar el ajeno",
      planUpserted.organizationId === orgA.id && planUpserted.id !== planB.id,
      `resolvió a ${planUpserted.id} (org ${planUpserted.organizationId})`
    );

    await checkThrows("plan.update() por id de otra org no encuentra la fila", () =>
      db.plan.update({ where: { id: planB.id }, data: { status: "READY" } })
    );

    await checkThrows("plan.update() no puede mover una fila propia a otra org", () =>
      db.plan.update({ where: { id: planA.id }, data: { organizationId: orgB.id } })
    );

    // Calibrar es un update sobre `plans`, así que hereda el aislamiento de la
    // primitiva. Se prueba igual con la forma exacta que usa calibratePlan: es
    // la escritura con la que se van a computar metros, y un plano calibrado
    // desde otra organización sería medir el edificio de otro.
    await checkThrows("no se puede calibrar un plano de otra org (update por id)", () =>
      db.plan.update({
        where: { id: planB.id },
        data: { scaleFactor: 0.05, calibrationJson: { version: 1 } },
      })
    );

    await checkThrows("updateMany() con el organizationId ajeno en el where tampoco calibra", () =>
      db.plan.updateMany({
        where: { organizationId: orgB.id },
        data: { scaleFactor: 0.05 },
      })
    );

    const calibradosDesdeA = await db.plan.updateMany({ data: { scaleFactor: 0.05 } });
    check(
      "una calibración masiva desde A no toca los planos de B",
      calibradosDesdeA.count === 4,
      `calibró ${calibradosDesdeA.count} fila(s)`
    );

    const planBSinCalibrar = await raw.plan.findUnique({ where: { id: planB.id } });
    check(
      "el plano de la otra org sigue sin calibrar",
      planBSinCalibrar !== null && planBSinCalibrar.scaleFactor === null,
      `quedó con scaleFactor=${String(planBSinCalibrar?.scaleFactor)}`
    );

    const planesTocados = await db.plan.updateMany({ data: { status: "READY" } });
    check(
      "plan.updateMany() sin where no alcanza filas de otra org",
      planesTocados.count === 4,
      `actualizó ${planesTocados.count} fila(s)`
    );

    const planesBorrados = await db.plan.deleteMany();
    check(
      "plan.deleteMany() sin where borra solo la propia org",
      planesBorrados.count === 4,
      `borró ${planesBorrados.count} fila(s)`
    );

    const planSobrevivienteB = await raw.plan.findUnique({ where: { id: planB.id } });
    check(
      "el plano de la otra org sigue intacto y sin tocar",
      planSobrevivienteB !== null &&
        planSobrevivienteB.originalFilename === "plano-de-b.pdf" &&
        planSobrevivienteB.status === "PENDING",
      `quedó ${JSON.stringify(planSobrevivienteB)}`
    );

    console.log("\nMediciones (colgadas de un plano, que cuelga de un proyecto)");

    // Los planos de A se borraron arriba: se rehacen los dos lados del cruce.
    const planoA = await raw.plan.create({
      data: { ...planFields, organizationId: orgA.id, projectId: proyectoA.id },
    });

    const geometria = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];

    const medicionA = await raw.measurement.create({
      data: {
        organizationId: orgA.id,
        planId: planoA.id,
        type: "LARGO_CONTINUO",
        pageIndex: 0,
        geometryJson: geometria,
        computedValue: 5,
      },
    });
    const medicionB = await raw.measurement.create({
      data: {
        organizationId: orgB.id,
        planId: planB.id,
        type: "AREA",
        pageIndex: 0,
        geometryJson: geometria,
        computedValue: 99,
        label: "medición de B",
      },
    });

    const medicionesVisibles = await db.measurement.findMany();
    check(
      "measurement.findMany() sin where devuelve solo las de la propia org",
      medicionesVisibles.length === 1 && medicionesVisibles[0]?.id === medicionA.id,
      `devolvió ${medicionesVisibles.length} fila(s)`
    );

    const medicionAjena = await db.measurement.findUnique({ where: { id: medicionB.id } });
    check(
      "measurement.findUnique() por id de otra org devuelve null",
      medicionAjena === null,
      `devolvió ${JSON.stringify(medicionAjena)}`
    );

    // El where olvidado de esta feature: el detalle de un plano lista sus
    // mediciones por planId, y ese es el filtro que invita a saltearse la org.
    const porPlanoAjeno = await db.measurement.findMany({ where: { planId: planB.id } });
    check(
      "measurement.findMany() por el planId de otra org no devuelve nada",
      porPlanoAjeno.length === 0,
      `devolvió ${porPlanoAjeno.length} fila(s)`
    );

    const medicionCreada = await db.measurement.create({
      data: {
        planId: planoA.id,
        type: "MURO",
        pageIndex: 0,
        geometryJson: geometria,
        computedValue: 12,
        alto: 2.4,
      },
    });
    check(
      "measurement.create() sin organizationId lo inyecta desde la sesión",
      medicionCreada.organizationId === orgA.id,
      `quedó en ${medicionCreada.organizationId}`
    );

    await checkThrows("measurement.create() con el organizationId de otra org lanza error", () =>
      db.measurement.create({
        data: {
          planId: planoA.id,
          organizationId: orgB.id,
          type: "AREA",
          pageIndex: 0,
          geometryJson: geometria,
          computedValue: 1,
        },
      })
    );

    // Medir sobre un plano ajeno declarando la org propia: la fila entraría en
    // el tenant de A apuntando a un plano de B. La FK no lo impide —es un uuid
    // válido— así que lo tiene que atajar el server action verificando el plano
    // por getTenantPrisma antes de escribir. Se documenta acá el hueco real.
    const planoAjenoDesdeA = await db.plan.findUnique({ where: { id: planB.id } });
    check(
      "el plano de otra org no se puede cargar para medir sobre él",
      planoAjenoDesdeA === null,
      `devolvió ${JSON.stringify(planoAjenoDesdeA)}`
    );

    await checkThrows(
      "measurement.findMany() con un organizationId ajeno en el where lanza error",
      () => db.measurement.findMany({ where: { organizationId: orgB.id } })
    );

    await checkThrows("measurement.update() por id de otra org no encuentra la fila", () =>
      db.measurement.update({ where: { id: medicionB.id }, data: { label: "pisada por A" } })
    );

    const renombradas = await db.measurement.updateMany({
      where: { id: medicionB.id },
      data: { label: "pisada por A" },
    });
    check(
      "updateMany() sobre el id de una medición ajena no toca nada",
      renombradas.count === 0,
      `actualizó ${renombradas.count} fila(s)`
    );

    const borradasAjenas = await db.measurement.deleteMany({ where: { id: medicionB.id } });
    check(
      "deleteMany() sobre el id de una medición ajena no borra nada",
      borradasAjenas.count === 0,
      `borró ${borradasAjenas.count} fila(s)`
    );

    const medicionesBorradas = await db.measurement.deleteMany();
    check(
      "measurement.deleteMany() sin where borra solo las de la propia org",
      medicionesBorradas.count === 2,
      `borró ${medicionesBorradas.count} fila(s)`
    );

    const medicionSobreviviente = await raw.measurement.findUnique({
      where: { id: medicionB.id },
    });
    check(
      "la medición de la otra org sigue intacta y sin renombrar",
      medicionSobreviviente !== null && medicionSobreviviente.label === "medición de B",
      `quedó ${JSON.stringify(medicionSobreviviente)}`
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
    // onDelete: Cascade se lleva los projects y los plans de ambas orgs.
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
