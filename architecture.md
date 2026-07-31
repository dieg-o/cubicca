# CUBICCA — Arquitectura

Bitácora de decisiones y estado por tarjeta técnica (TD).

## Estado

**TD-001 -> HECHO**: bootstrap CORE + primera migración + smoke pooler 6543 + `.env.example`.
**Próximo: TD-002** (auth + onboarding + `getTenantPrisma`).

## TD-001 — Bootstrap CORE

Scaffold Next 16 + shadcn + Prisma 7 (driver adapter `@prisma/adapter-pg`), schema
inicial `organizations` / `profiles`, migración aplicada y smoke de conexión verde.

### Conexiones a la base

Dos URLs, dos usos, sin excepciones:

| Var | Puerto | Quién la usa | Por qué |
| --- | --- | --- | --- |
| `DATABASE_URL` | 6543 (pooler, transaction mode) | Runtime de la app / Prisma Client | Serverless abre y cierra conexiones todo el tiempo; el pooler es lo único que aguanta ese patrón. |
| `DIRECT_URL` | 5432 (conexión directa) | `prisma migrate` únicamente | El pooler en transaction mode no soporta el DDL ni los advisory locks que usa migrate. |

`npm run db:smoke` falla explícito si `DATABASE_URL` no apunta a 6543 o no trae
`pgbouncer=true`: la regla se verifica, no se confía.

### Decisiones

- **Prisma 7 no autocarga `.env`.** La carga es explícita vía `dotenv` en
  `prisma.config.ts` y en `scripts/smoke-db.ts`, en orden `.env.local` → `.env`
  (el primero gana, dotenv no pisa lo ya definido).
- **La URL del datasource vive solo en `prisma.config.ts`.** Declararla también en
  `schema.prisma` tira P1012 en v7.
- **`uselibpqcompat=true` en `DATABASE_URL`.** Desde `pg@8.22`, `sslmode=require`
  se trata como `verify-full` y el cert del pooler de Supabase no valida contra los
  CAs del sistema (`self-signed certificate in certificate chain`). El flag restaura
  la semántica libpq: encripta sin verificar la cadena. Afecta solo al runtime —
  `prisma migrate` va por el schema engine (Rust), que no cambió de criterio.
  Si algún día se quiere verificación real: bajar el CA del proyecto desde el
  dashboard de Supabase y pasar a `sslmode=verify-full&sslrootcert=...`.
- **`profiles.user_id` no tiene FK.** La identidad vive en `auth.users` (Supabase
  Auth) y Prisma nunca toca el schema `auth`: es una referencia lógica.
- **El cliente Prisma base es interno.** `src/lib/db/prisma.ts` se instancia lazy
  (vía Proxy) para que `next build` no explote sin env. Cuando exista
  `getTenantPrisma(orgId)` en TD-002, ningún feature debe importar este cliente
  directo.

### Secretos

`.gitignore` ignora `.env*` con una única negación: `!.env.example`. La plantilla
se commitea con placeholders; ningún valor real entra al repo.
