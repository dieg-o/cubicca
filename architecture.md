# CUBICCA — Arquitectura

Bitácora de decisiones y estado por tarjeta técnica (TD).

## Estado

**TD-001 -> HECHO**: bootstrap CORE + primera migración + smoke pooler 6543 + `.env.example`.
**TD-002 -> EN CURSO**: `getTenantPrisma` hecho y verificado; falta auth + onboarding.

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

## TD-002 — Aislamiento multi-tenant, auth y onboarding

### `getTenantPrisma(orgId)` — la primitiva

`src/lib/db/tenant.ts`. Extensión de Prisma (`$allOperations`) que scopea a una
organización todos los modelos listados en `TENANT_SCOPED_MODELS`. El `orgId`
sale SIEMPRE de la sesión server-side, nunca del request.

Se agregó el modelo `Project` como primer modelo tenant-scoped: sin una tabla
real contra la cual cruzar tenants, el aislamiento no se puede verificar.

**La primitiva es el ÚNICO lugar que setea `organizationId`.** Ningún call site
lo escribe. Tres tratamientos según de qué lado de la query esté el riesgo:

| Lado | Qué hace | Por qué |
| --- | --- | --- |
| `where` (lecturas, updates, deletes) | **Inyecta** `organizationId = orgId` | El caller puede olvidarse del filtro; la primitiva es la red de seguridad. |
| `data` de los creates | **Inyecta** el `organizationId` de la sesión | Un solo lugar setea la org. Si el caller la declara igual, pasa; distinta, rompe. |
| `data` de los updates | **Verifica** que no muevan la fila a otra org | Ahí no se setea nada nuevo: lo único que puede colarse es el destino. |

### Decisiones

- **En los creates se inyecta, no se exige.** El call site escribe
  `db.project.create({ data: { name } })` y nada más: la org es responsabilidad
  de la primitiva, no de cada feature. Un campo que hay que acordarse de poner
  en cada create es un campo que algún día alguien va a poner mal.
- **Los tipos acompañan: `organizationId` OPCIONAL en el create input de los
  modelos tenant-scoped.** Es un retoque acotado y concreto por modelo
  (`TenantProjectDelegate` en `tenant.ts`), armado con los tipos públicos de
  Prisma 7 — `SelectSubset`, `Result`, `Prisma__ProjectClient` — redeclarando
  solo las cuatro operaciones que insertan filas. Sin `any` y sin envolver los
  tipos de Prisma con genéricos: al sumar un modelo scopeado se copia el bloque.
  La única aserción de tipo del módulo está en el `return` de `getTenantPrisma`,
  y describe lo que el runtime realmente hace. **Castear en un call site está
  prohibido**; si hiciera falta, el que está mal es el retoque de tipos.
- **Discrepancia = error, nunca sobreescritura silenciosa.** Un `organizationId`
  distinto al de la sesión es siempre un bug del caller o un intento de cruzar
  tenants. Pisarlo callado convertiría un acceso indebido en un "funcionó igual".
  Rompe con `Error` y deja log técnico (recibido vs. esperado) del lado del
  servidor.
- **`organization: { connect }` en un create se rechaza.** La forma anidada
  esquiva el campo plano y permitiría conectar la fila a otra organización; la
  extensión no intercepta nested writes. Además, inyectar el FK al lado de la
  relación da un input inválido para Prisma. Se corta con mensaje propio, y los
  tipos tampoco la ofrecen (el input parte del `UncheckedCreateInput`).
- **Un update no puede mover una fila a otra org.** El `where` scopeado garantiza
  que solo tocamos filas propias, pero no dice nada del destino:
  `data: { organizationId: otraOrg }` la sacaría del tenant sin que ningún filtro
  se entere. Se verifica el `data`, en su forma pelada y en la forma `{ set }`.
- **Operación no contemplada sobre un modelo scopeado = error.** Preferimos
  romper fuerte a filtrar de menos: una operación nueva de Prisma que no esté en
  las listas no pasa sin aislar.
- **`Organization` y `Profile` NO son tenant-scoped.** La primera es el modelo
  raíz (se filtra por su propio `id`); el segundo lo maneja el flujo de auth
  antes de que exista una org a la cual scopear. Van por `getRawPrisma()`, que
  existe solo para eso y está documentado como prohibido en features.

### Límites conocidos (no cubiertos por la primitiva)

- `$queryRaw` / `$executeRaw`: el SQL crudo esquiva la extensión. Si hace falta
  raw sobre un modelo scopeado, el filtro va escrito a mano.
- Nested writes sobre modelos scopeados a través de relaciones desde un modelo
  no scopeado.
- La defensa es de aplicación, no de base: **no hay RLS todavía**. Cualquier
  cosa que hable con Postgres por fuera de este cliente ve todas las filas.

### Verificación

`npm run db:test-isolation` (`scripts/test-tenant-isolation.ts`) corre contra la
base real: crea dos organizaciones desechables, intenta cruzarlas de 20 maneras
distintas (lecturas, creates, upsert, updates, deletes, mover filas de org) y las
borra al final. Todo verde al cierre de la primitiva.

⚠️ **Al agregar un modelo con `organizationId`** hay que hacer las tres cosas:
sumarlo a `TENANT_SCOPED_MODELS`, copiarle el bloque de tipos del delegate
(`organizationId` opcional en los creates) y agregarle sus casos al test. Un
modelo tenant-scoped que no esté en la lista queda sin aislar y sus filas se ven
cruzadas entre organizaciones.

### Pendiente de TD-002

Auth propiamente dicha: cliente de Supabase (browser + server), middleware de
sesión, y el onboarding que crea `organization` + `profile` vía `getRawPrisma()`.
Las vars `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` ya están en
`.env.example`; la `service_role` no entra al proyecto.
