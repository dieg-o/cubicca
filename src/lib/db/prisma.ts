import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

// ⚠️ Cliente BASE — no es la puerta de entrada de la app.
// Cuando exista `getTenantPrisma(orgId)` (primitiva de aislamiento multi-tenant),
// este cliente pasa a ser interno y ningún feature debe importarlo directo.
// Ver Reglas críticas del FOUNDING_DOC: nada habla con PrismaClient directo.

// En dev, Next.js recarga los módulos en cada cambio: sin este singleton
// se abre un pool nuevo por recarga y se agotan las conexiones.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL no está definida. Debe apuntar al pooler de Supabase (puerto 6543, pgbouncer=true)."
    );
  }

  // Runtime siempre contra el pooler (6543, transaction mode).
  // DIRECT_URL (5432) queda reservada exclusivamente para `prisma migrate`.
  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}

function getPrismaClient(): PrismaClient {
  const client = globalForPrisma.prisma ?? createPrismaClient();

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }

  return client;
}

// Inicialización diferida: `next build` importa este módulo para analizar las
// rutas, y ahí todavía no hay env. Instanciar en el primer uso real (request
// time) mantiene el build verde sin aflojar la validación de DATABASE_URL.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getPrismaClient();
    const value = Reflect.get(client, property, receiver);

    return typeof value === "function" ? value.bind(client) : value;
  },
});
