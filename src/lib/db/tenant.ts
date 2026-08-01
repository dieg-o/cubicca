import type { Prisma } from "@/generated/prisma/client";

import { prisma as basePrisma } from "@/lib/db/prisma";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Primitiva de aislamiento multi-tenant.
 *
 * TODA la app toca la base vía `getTenantPrisma(orgId)`. El orgId sale SIEMPRE
 * de la sesión server-side, nunca del request (body/query/headers).
 *
 * Esta primitiva es el ÚNICO lugar que setea `organizationId` en los modelos
 * tenant-scoped. Ningún call site lo escribe: los tipos lo declaran opcional
 * (ver TenantProjectDelegate más abajo) y la extensión lo inyecta.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Modelos con `organizationId`, en PascalCase (así los nombra Prisma en runtime).
 *
 * ⚠️ Esta lista es la superficie de seguridad: un modelo tenant-scoped que NO
 * esté acá queda SIN aislar y sus filas se ven cruzadas entre organizaciones.
 * Al agregar un modelo con `organizationId` al schema hay que, además de
 * sumarlo acá: darle su tipo de delegate con `organizationId` opcional (ver
 * TenantPrisma) y agregar su caso a scripts/test-tenant-isolation.ts.
 *
 * `Organization` NO va: es el modelo raíz, se filtra por su propio `id`.
 * `Profile` tampoco: lo maneja el flujo de auth con el cliente sin scopear.
 */
const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(["Project"]);

/** Operaciones que filtran filas existentes: les inyectamos el `where`. */
const WHERE_OPERATIONS: ReadonlySet<string> = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

/** Operaciones que insertan filas: les inyectamos el `organizationId` en el `data`. */
const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
]);

/** Subconjunto de WHERE_OPERATIONS que además escribe: hay que mirarles el `data`. */
const UPDATE_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "updateMany",
  "updateManyAndReturn",
]);

const ORG_FIELD = "organizationId";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lee una propiedad de los `args` de la operación.
 *
 * Toma `unknown` a propósito: `args` es la unión de TODOS los tipos de args de
 * Prisma, y estrecharla con isRecord deja una intersección que sigue sin tener
 * `data`. Entrando por unknown miramos el objeto como lo que es en runtime.
 */
function readArg(args: unknown, key: string): unknown {
  return isRecord(args) ? args[key] : undefined;
}

/**
 * Si el caller mandó un organizationId, tiene que ser el de su propia sesión.
 *
 * DECISIÓN: fallamos, no sobreescribimos en silencio. Un orgId distinto es
 * siempre un bug del caller o un intento de cruzar tenants; pisarlo callado
 * convertiría un acceso indebido en un "funcionó igual" y taparía el problema.
 * Preferimos romper fuerte y que quede en el log.
 */
function assertOwnOrg(value: unknown, orgId: string, context: string): void {
  if (value !== undefined && value !== orgId) {
    // Log técnico: el throw sube al caller, pero el detalle queda en el servidor.
    console.error(
      `[tenant-isolation] ${context}: ${ORG_FIELD} recibido=${String(value)} ` +
        `esperado=${orgId}`
    );

    throw new Error(
      `Violación de aislamiento: se intentó operar con ${ORG_FIELD}=${String(value)} ` +
        `desde la organización ${orgId} (${context}).`
    );
  }
}

/** Mergea `{ organizationId }` en el where sin pisar el resto de los filtros. */
function scopeWhere(args: unknown, orgId: string, context: string): Record<string, unknown> {
  const base = isRecord(args) ? args : {};
  const where = isRecord(base.where) ? base.where : {};

  assertOwnOrg(where[ORG_FIELD], orgId, context);

  // El organizationId va al tope del where: Prisma hace AND de los campos de
  // primer nivel, así que se combina con cualquier OR/AND/NOT del caller.
  return { ...base, where: { ...where, [ORG_FIELD]: orgId } };
}

/**
 * Inyecta `organizationId` en las filas a insertar (objeto o array de createMany).
 *
 * Ausente -> se inyecta el orgId de la sesión (el caso normal: el call site no
 * lo escribe). Presente e igual -> pasa. Presente y distinto -> rompe.
 */
function scopeData(data: unknown, orgId: string, context: string): unknown {
  if (Array.isArray(data)) {
    return (data as unknown[]).map((row) => scopeData(row, orgId, context));
  }

  const row = isRecord(data) ? data : {};

  // La forma anidada (`organization: { connect }`) elude el campo plano y esta
  // extensión no intercepta nested writes. Inyectar el FK al lado de la relación
  // además da un input inválido para Prisma, así que la cortamos acá con un
  // mensaje propio en vez de dejar que falle más abajo y más confuso.
  if (row.organization !== undefined) {
    throw new Error(
      `Violación de aislamiento: la relación anidada 'organization' no está cubierta ` +
        `por la primitiva (${context}). El ${ORG_FIELD} lo pone la primitiva sola.`
    );
  }

  assertOwnOrg(row[ORG_FIELD], orgId, context);

  return { ...row, [ORG_FIELD]: orgId };
}

/**
 * Impide que un update mueva la fila a otra organización.
 *
 * El `where` scopeado garantiza que solo tocamos filas propias, pero no dice
 * nada sobre el destino: `data: { organizationId: otraOrg }` sacaría la fila del
 * tenant sin que ningún filtro se entere.
 */
function assertUpdateOrg(data: unknown, orgId: string, context: string): void {
  const row = isRecord(data) ? data : {};
  const value = row[ORG_FIELD];

  if (value === undefined) {
    return;
  }

  // Prisma acepta el valor pelado o envuelto en `{ set: valor }`.
  assertOwnOrg(isRecord(value) ? value.set : value, orgId, context);
}

/**
 * Cliente scopeado, sin el retoque de tipos. Separado de `getTenantPrisma` solo
 * para poder nombrar su tipo (ScopedClient) y derivar de ahí el retoque.
 */
function createScopedClient(orgId: string) {
  return basePrisma.$extends({
    name: "tenant-isolation",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (model === undefined || !TENANT_SCOPED_MODELS.has(model)) {
            // Modelo no scopeado (Organization, Profile): pasa sin tocar.
            return query(args);
          }

          const context = `${model}.${operation}`;

          if (WHERE_OPERATIONS.has(operation)) {
            if (UPDATE_OPERATIONS.has(operation)) {
              assertUpdateOrg(readArg(args, "data"), orgId, context);
            }

            return query(scopeWhere(args, orgId, context));
          }

          if (CREATE_OPERATIONS.has(operation)) {
            // Copia mutable, igual que en scopeWhere: armar un literal dispara
            // el chequeo de exceso de propiedades de TS contra el tipo de `query`.
            const scoped: Record<string, unknown> = isRecord(args) ? { ...args } : {};

            scoped.data = scopeData(scoped.data, orgId, context);

            return query(scoped);
          }

          if (operation === "upsert") {
            // upsert filtra Y crea: le corresponden los tres tratamientos.
            const scoped = scopeWhere(args, orgId, context);

            assertUpdateOrg(scoped.update, orgId, context);
            // Mutamos en vez de armar un literal nuevo: el literal dispara el
            // chequeo de exceso de propiedades de TS contra el tipo de `query`.
            scoped.create = scopeData(scoped.create, orgId, context);

            return query(scoped);
          }

          // Operación desconocida sobre un modelo scopeado: no la dejamos pasar
          // sin filtrar. Es preferible romper a filtrar de menos.
          throw new Error(
            `Operación '${operation}' no contemplada por la primitiva de aislamiento (${context}).`
          );
        },
      },
    },
  });
}

type ScopedClient = ReturnType<typeof createScopedClient>;

type ProjectDelegate = ScopedClient["project"];

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Retoque de tipos, un bloque por modelo tenant-scoped.
 *
 * Los tipos generados exigen `organizationId` en los creates, pero acá lo pone
 * la extensión: sin este retoque, todo call site tendría que escribirlo (o
 * castear, que es peor). Se declara opcional, y el runtime lo inyecta.
 *
 * Se toma como base el input UNCHECKED (el que lleva el FK plano) a propósito:
 * la forma anidada `organization: { connect }` no está cubierta por la
 * extensión y el runtime la rechaza, así que tampoco la ofrecemos en los tipos.
 *
 * Es un retoque acotado y concreto por modelo — nada de envolver los tipos de
 * Prisma con genéricos. Al sumar un modelo tenant-scoped, se copia este bloque.
 * ────────────────────────────────────────────────────────────────────────────
 */

type ProjectCreateInput = Omit<Prisma.ProjectUncheckedCreateInput, "organizationId"> & {
  organizationId?: string;
};

type ProjectCreateManyInput = Omit<Prisma.ProjectCreateManyInput, "organizationId"> & {
  organizationId?: string;
};

type ProjectCreateArgs = Omit<Prisma.ProjectCreateArgs, "data"> & {
  data: ProjectCreateInput;
};

type ProjectCreateManyArgs = Omit<Prisma.ProjectCreateManyArgs, "data"> & {
  data: ProjectCreateManyInput | ProjectCreateManyInput[];
};

type ProjectCreateManyAndReturnArgs = Omit<Prisma.ProjectCreateManyAndReturnArgs, "data"> & {
  data: ProjectCreateManyInput | ProjectCreateManyInput[];
};

type ProjectUpsertArgs = Omit<Prisma.ProjectUpsertArgs, "create"> & {
  create: ProjectCreateInput;
};

/**
 * El delegate de Project con las cuatro operaciones que insertan filas
 * redeclaradas. Todo lo demás (lecturas, updates, deletes) se hereda intacto:
 * ahí `organizationId` no va en el input y los tipos generados ya sirven.
 */
interface TenantProjectDelegate
  extends Omit<
    ProjectDelegate,
    "create" | "createMany" | "createManyAndReturn" | "upsert"
  > {
  create<T extends ProjectCreateArgs>(
    args: Prisma.SelectSubset<T, ProjectCreateArgs>
  ): Prisma.Prisma__ProjectClient<Prisma.Result<ProjectDelegate, T, "create">>;

  createMany<T extends ProjectCreateManyArgs>(
    args: Prisma.SelectSubset<T, ProjectCreateManyArgs>
  ): Prisma.PrismaPromise<Prisma.BatchPayload>;

  createManyAndReturn<T extends ProjectCreateManyAndReturnArgs>(
    args: Prisma.SelectSubset<T, ProjectCreateManyAndReturnArgs>
  ): Prisma.PrismaPromise<Prisma.Result<ProjectDelegate, T, "createManyAndReturn">>;

  upsert<T extends ProjectUpsertArgs>(
    args: Prisma.SelectSubset<T, ProjectUpsertArgs>
  ): Prisma.Prisma__ProjectClient<Prisma.Result<ProjectDelegate, T, "upsert">>;
}

export type TenantPrisma = Omit<ScopedClient, "project"> & {
  project: TenantProjectDelegate;
};

/**
 * Cliente Prisma scopeado a una organización. Dos mecanismos distintos según
 * de qué lado de la query esté el riesgo:
 *
 *   - LECTURAS y filtros (where): se INYECTA `organizationId = orgId`, incluso
 *     si el caller se olvida del where. Es la red de seguridad.
 *   - CREATES (data): se INYECTA el `organizationId` de la sesión. El call site
 *     no lo escribe; si lo escribe distinto al de la sesión, rompe.
 *   - UPDATES (data): se VERIFICA que no muevan la fila a otra organización.
 *
 * ⚠️ NO cubre `$queryRaw` / `$executeRaw`: el SQL crudo esquiva la extensión y
 * NO queda aislado. Si algún día hace falta raw, el filtro va escrito a mano.
 *
 * ⚠️ Tampoco cubre escrituras anidadas (nested writes) sobre modelos scopeados
 * a través de relaciones. Hoy no las usamos; en los creates se rechazan
 * explícitamente, pero un `include`/`connect` desde un modelo NO scopeado no
 * pasa por acá. Si aparecen, hay que extender esto.
 */
export function getTenantPrisma(orgId: string): TenantPrisma {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new Error(
      "getTenantPrisma requiere un orgId no vacío proveniente de la sesión server-side."
    );
  }

  // La única aserción de tipo de la primitiva, y describe la realidad: en
  // runtime el cliente acepta creates sin `organizationId` porque la extensión
  // lo inyecta. Es acá justamente para que ningún call site tenga que castear.
  return createScopedClient(orgId) as TenantPrisma;
}

/**
 * ⚠️ NO USAR EN LA APP. ⚠️
 *
 * Cliente SIN scopear. Existe por una sola razón: el flujo de auth/onboarding
 * necesita tocar la base ANTES de que exista una organización a la cual scopear
 * (crear org + profile) o para resolver el profile a partir del userId.
 *
 * Únicos usos permitidos, todos en server actions controladas:
 *   - crear organization + profile en el onboarding
 *   - resolver el profile por userId de la sesión
 *
 * Cualquier otro uso es un bug de aislamiento. Para todo lo demás:
 * getTenantPrisma(orgId).
 */
export function getRawPrisma() {
  return basePrisma;
}
