import path from "node:path";

import { config as loadEnv } from "dotenv";

// Igual que prisma.config.ts: v7 no autocarga .env. Orden .env.local -> .env
// (dotenv no pisa lo ya definido, así que el primero gana).
loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

const POOLER_PORT = "6543";

type SmokeRow = { ok: number };

function describeConnection(rawUrl: string): string {
  const url = new URL(rawUrl);

  return `${url.hostname}:${url.port || "5432"}`;
}

/**
 * Verifica que DATABASE_URL apunte al pooler en transaction mode.
 * El runtime NUNCA debe ir por la conexión directa (5432): esa queda
 * reservada para `prisma migrate`.
 */
function assertPooler(rawUrl: string): void {
  const url = new URL(rawUrl);

  if (url.port !== POOLER_PORT) {
    throw new Error(
      `DATABASE_URL apunta a ${describeConnection(rawUrl)}; el runtime tiene que ir al pooler (puerto ${POOLER_PORT}).`
    );
  }

  if (url.searchParams.get("pgbouncer") !== "true") {
    throw new Error(
      "DATABASE_URL debe incluir ?pgbouncer=true (el pooler está en transaction mode)."
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "Falta DATABASE_URL en .env.local (pooler de Supabase, puerto 6543)."
    );
  }

  assertPooler(connectionString);

  // Import diferido: el módulo valida DATABASE_URL al instanciar, así que
  // primero cargamos el env y recién después traemos el cliente.
  const { prisma } = await import("../src/lib/db/prisma");

  const rows = await prisma.$queryRaw<SmokeRow[]>`SELECT 1 AS ok`;

  if (rows[0]?.ok !== 1) {
    throw new Error(`Respuesta inesperada del SELECT: ${JSON.stringify(rows)}`);
  }

  console.log(`OK — conexión al pooler ${describeConnection(connectionString)}`);

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  // Mensaje seguro + detalle técnico en consola.
  console.error("Smoke test FALLÓ: no se pudo verificar la conexión.");
  console.error(error);

  process.exitCode = 1;
});
