import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma v7 no autocarga archivos .env: hay que hacerlo explícito.
// Orden: .env.local primero (gana, es el override del dev), después .env.
// dotenv no pisa variables ya definidas, así que el primero en cargar manda.
loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    // Las migraciones van SIEMPRE por la conexión directa (5432, sin pgbouncer).
    // El pooler en transaction mode no soporta el DDL/advisory locks que usa migrate.
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
