# CUBICCA — Arquitectura

Bitácora de decisiones y estado por tarjeta técnica (TD).

## Estado

**TD-001 -> HECHO**: bootstrap CORE + primera migración + smoke pooler 6543 + `.env.example`.
**TD-002 -> HECHO**: `getTenantPrisma` + tests de aislamiento, auth con Supabase,
proxy, gate de profile y onboarding.
**TD-002-FIX**: callback PKCE de confirmación de email (`/auth/callback`) +
`emailRedirectTo`. Superado por FIX-3 para el mail; la ruta queda para OAuth.
**TD-002-FIX-2**: `getUser()` degrada a "deslogueado" ante throws que auth-js no
clasifica como `AuthError`. Cookie-only asumido para el MVP.
**TD-002-FIX-3**: confirmación de email por `token_hash` + `verifyOtp`
(`/auth/confirm`). Destraba el E2E desde cualquier dispositivo.
**TD-002-FIX-4**: **confirmación de email APAGADA para el MVP** (toggle del
dashboard). `signUp()` devuelve sesión directa y el alta va derecho a
`/onboarding`. `/auth/confirm` y `/auth/callback` quedan en el repo, dormidas.

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

## TD-002 (2da mitad) — Auth, sesión y onboarding

Supabase Auth con `@supabase/ssr`. La identidad vive en `auth.users`; `profiles`
la referencia lógicamente (sin FK) y es lo que ata un usuario a una organización.

### Las tres capas, y qué garantiza cada una

| Capa | Archivo | Qué hace | Qué NO garantiza |
| --- | --- | --- | --- |
| Proxy | `src/proxy.ts` | Mira si existe la cookie de sesión y redirige | Nada: no valida firma ni expiración, no sabe si hay profile |
| DAL | `src/lib/auth/session.ts` | `getUser()` contra Supabase + resuelve el profile | — |
| Layout `(app)` | `src/app/(app)/layout.tsx` | Gate de conveniencia + chrome de la app | No es frontera: no re-renderiza al navegar |

La frontera real es el DAL, y se lo llama en **cada página y cada server
action**, no solo en el layout.

### Decisiones

- **El proxy no toca la base ni llama a Supabase.** Corre en cada request,
  incluidos los prefetch del router: cualquier I/O ahí se paga en todas las
  navegaciones. Solo mira si la cookie `sb-<ref>-auth-token` existe.
- **El proxy NO redirige de `/login` a `/`.** Parece la simétrica obvia, pero
  con una cookie presente y vencida arma un loop infinito: el proxy manda
  `/login -> /` y la verificación real de `/` manda `/ -> /login`. Esa
  redirección vive en la página de login, que sí puede preguntar si la sesión
  sirve. Verificado con curl: 1 salto, termina en 200.
- **`getUser()`, nunca `getSession()`.** El primero valida el token contra el
  servidor de auth; el segundo se cree lo que diga la cookie. Para decidir
  permisos, la cookie sola no alcanza.
- **El `orgId` sale del profile, jamás del request.** `requireProfile()` es el
  único proveedor de `organizationId`, y lo que entrega va directo a
  `getTenantPrisma(orgId)`. Un `organizationId` que venga por body, query o
  header no se mira nunca.
- **El gate del layout es conveniencia, no seguridad.** Los layouts no se
  re-renderizan al navegar entre rutas hermanas (partial rendering), y los
  server actions son POST alcanzables sin pasar por la UI. Como `requireProfile`
  está envuelto en `cache()` de React, repetirlo en cada página sale gratis
  dentro de un mismo render.
- **`/onboarding` queda fuera del grupo `(app)`.** Si viviera adentro, el gate
  del layout la redirigiría a sí misma.
- **El onboarding usa `$transaction`.** Crear la organización y no el profile
  dejaría una org huérfana a la que nadie puede entrar. Va por `getRawPrisma()`:
  es su segundo uso permitido, porque justo ahí todavía no hay orgId.
- **Login y signup son Server Actions, no llamadas desde el browser.** Las
  cookies de sesión solo se pueden escribir del lado del servidor: durante el
  render de un Server Component el store es de solo lectura, y desde el cliente
  serían manipulables.
- **Error de login genérico.** Distinguir "no existe" de "contraseña incorrecta"
  regala un enumerador de cuentas.

### Confirmación de email: apagada en el MVP

**Estado hoy: "Confirm email" está OFF en el dashboard** (Authentication →
Sign In / Providers). Con el toggle apagado `supabase.auth.signUp()` devuelve
`data.session` en la misma respuesta: no sale mail, no hay link que clickear y el
alta termina en `/onboarding` sin salir del browser.

**Por qué se apagó.** Dos razones, ninguna técnica. Supabase bloquea la edición
del template de confirmación detrás de un SMTP propio, así que el paso 2 del
flujo de abajo no se podía completar sin montar Resend primero. Y para un único
usuario en el MVP, confirmar el mail es ceremonia: no protege nada que hoy
importe.

**El código no distingue los dos modos.** El server action ya ramifica por
`data.session` (`src/app/(auth)/actions.ts`): con sesión redirige a
`/onboarding`, sin sesión devuelve el `notice` de "revisá tu mail". Volver a
prender el toggle no exige tocar código — por eso `/auth/confirm` y
`/auth/callback` se dejan en el repo aunque hoy no las pise nadie.

**TD pre-lanzamiento:** SMTP propio (Resend) + template apuntando a
`/auth/confirm` + toggle en ON. Recién ahí aplica todo lo que sigue en esta
sección, que se conserva como la especificación del flujo dormido.

#### El flujo dormido: `token_hash` + `verifyOtp`

El mail de alta **no va por PKCE**. Va por `token_hash`: el link trae un hash de
un solo uso que se verifica con `verifyOtp()`, sin depender de ninguna cookie
previa.

**Por qué se cambió.** El primer intento fue PKCE (`/auth/callback` +
`exchangeCodeForSession`). Ese canje necesita el *code verifier* que quedó en una
cookie al hacer el signUp, así que **solo funciona en el mismo browser donde se
hizo el alta**. Abrir el mail en el teléfono —el caso normal— deja el canje sin
verifier y la confirmación falla. La evidencia en prod: el `/verify` de Supabase
respondía **303** y redirigía bien, pero el canje moría después por falta de
`code_verifier`. No es un bug del código: es el modelo de PKCE, que asume un
único agente de usuario de punta a punta.

`verifyOtp()` no tiene esa restricción. El `token_hash` se valida solo contra el
servidor de auth, **desde cualquier browser o dispositivo**.

El flujo completo, y qué pieza sostiene cada tramo:

| Paso | Dónde | Qué pasa |
| --- | --- | --- |
| 1. signUp | `src/app/(auth)/actions.ts` | Crea el usuario; manda `emailRedirectTo` |
| 2. el mail | Template del dashboard | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` |
| 3. el proxy deja pasar | `src/proxy.ts` | `/auth/confirm` está en `PUBLIC_PATHS` |
| 4. verificación | `src/app/auth/confirm/route.ts` | `verifyOtp({ token_hash, type })` escribe las cookies de sesión |
| 5. destino | idem | `/onboarding` por defecto, o `safeNextPath(next)` si vino `next` |

- **El link lo arma el template del dashboard, no el código**
  (Authentication → Email Templates). De ahí que el **orden de deploy** importe:
  primero tiene que existir `/auth/confirm` en producción, recién después se
  cambia el template. Al revés, los links nuevos apuntan a una ruta inexistente
  y dan 404.
- **El `type` se pasa tal cual viene en la query, sin lista blanca.** Si Supabase
  rechazara `email` y hubiera que mandar `signup`, el ajuste es editar el
  template y nada más — sin recompilar ni redeployar. `EmailOtpType` acepta
  cualquier string por diseño y quien valida de verdad es el servidor de auth.
- **Es un Route Handler, no una página.** `verifyOtp` **escribe** cookies, y
  durante el render de un Server Component el store es de solo lectura — el mismo
  motivo por el que login y signup son server actions.
- **`/auth/confirm` va en `PUBLIC_PATHS` por obligación.** Quien llega ahí
  todavía NO tiene sesión: esa es la razón de existir de la ruta.
- **Re-clic de un link ya usado → mensaje amable, nunca 500.** `verifyOtp`
  devuelve error y el route redirige a `/login?error=used`, que se pinta como
  `notice` gris y no como error rojo. No se puede distinguir "ya usado" de
  "vencido" —Supabase devuelve lo mismo para los dos, a propósito— así que el
  texto cubre ambos y empuja a la acción útil: iniciar sesión.
- **Las fallas técnicas van a `/login?error=auth`**: link sin `token_hash` o sin
  `type`, y excepciones inesperadas. El motivo real queda en el log del servidor.

#### Lo que queda de PKCE, y por qué

`/auth/callback` + `exchangeCodeForSession` **siguen vivos**. No son código
muerto: OAuth y los magic links los van a necesitar, y ahí el flujo sí empieza y
termina en el mismo browser, que es la condición que PKCE requiere.

- **`emailRedirectTo` se sigue resolviendo en el server action** desde
  `NEXT_PUBLIC_SITE_URL`, con fallback al `Origin` del request.
  ⚠️ La URL tiene que estar cargada en **Authentication → URL Configuration →
  Redirect URLs** del dashboard, o el redirect se rechaza. Y al ser una
  `NEXT_PUBLIC_*` se inlinea en build time: cambiarla en el hosting exige
  redeploy, no alcanza con reiniciar (ver la sección de Next más abajo).
- **La red de contención del `code` huérfano se queda.** El proxy detecta
  `!hasSession && pathname === "/" && searchParams.has("code")` y reenvía al
  callback con la query intacta. Ojo: los mails viejos que ya salieron con
  `?code=` **van a seguir fallando** — es el bug que dejamos atrás, no algo que
  el net arregle. Se mantiene porque no molesta y cubre el caso OAuth futuro.
- **`safeNextPath()` vive en `src/lib/auth/redirects.ts`.** Lo usan los tres
  lados —server actions, `/auth/callback` y `/auth/confirm`— y en todos un
  `//evil.com` o un `https://…` sin sanear serían un open redirect.

### Cosas de esta versión de Next que condicionaron el código

- **`middleware.ts` ahora es `proxy.ts`** (Next 16), exporta `proxy`, corre en
  Node por defecto, y `export const runtime` ahí **tira error**.
- **`cookies()` va antes de leer el env** en `createSupabaseServerClient()`: es
  lo que marca la ruta como dinámica. Al revés, `next build` intenta
  prerenderizar `/` y explota por falta de vars. Mismo criterio que la
  instanciación diferida del cliente de Prisma.
- **`searchParams` es una Promise**: hay que await-earla.
- **Las `NEXT_PUBLIC_*` se inlinean en build time**, también en el bundle del
  proxy. Cambiarlas exige rebuild; pasarlas por env al arrancar el server no
  tiene efecto.

### Límite conocido: refresh del token — cookie-only asumido para el MVP

El proxy no refresca la sesión (es cookie-only por diseño). Supabase refresca al
llamar `getUser()`, pero durante el render de un Server Component las cookies son
de solo lectura, así que el token renovado **no se persiste**. Las escrituras de
cookie que sí funcionan son las de los server actions (login, signup, logout).

**Decisión (MVP): nos quedamos con cookie-only y asumimos el re-login.** El costo
del upgrade es una llamada de auth por request, incluidos los prefetch del
router, y no lo vale todavía.

Ojo con cómo se siente el límite: **no es un vencimiento a intervalo fijo**. Con
uso continuo puede no aparecer nunca; aparece al **despertar una pestaña
dormida**, cuando el access token venció entre navegaciones y el render no puede
persistir el renovado.

Lo que sí es obligatorio mientras vivamos con esto es que el fallo degrade
suave. Dos medidas, las dos en el código:

1. **El `setAll` del server client va en try/catch** (`src/lib/supabase/server.ts`).
   En contexto RSC escribir cookies tira; ahí el `setAll` tiene que ser un no-op
   seguro, no una excepción.
2. **Un `getUser()` que falla degrada a "deslogueado"**
   (`src/lib/auth/session.ts`): devuelve `null` y la página pública se renderiza.
   No alcanza con mirar el campo `error`: auth-js devuelve los `AuthError` por
   ahí, pero **relanza** cualquier otra cosa
   (`GoTrueClient._getUser`: `if (isAuthError(error)) return …; throw error`), y
   el `_acquireLock` que envuelve la llamada puede tirar por timeout sin pasar
   por ese catch. Por eso la llamada va envuelta en try/catch.
   La construcción del cliente queda **fuera** del try: si falta una env var eso
   es error de configuración y tiene que explotar, no disfrazarse de sesión
   ausente.

**Qué contiene y qué no la medida 2.** Una cookie inválida/vencida dispara el
refresh del token en el render, pero auth-js la devuelve como `AuthError`
manejado (`isAuthError`) → la página degrada a deslogueado y responde 200. La
medida 2 **NO** evita el 500 en ese caso (ya daba 200); su valor es contener
throws que auth-js **NO** clasifica como `AuthError` (p. ej. timeout de
`_acquireLock`, que escapa al catch interno de `_getUser`). El 500 observado en
prod (Status 0) no está reproducido; hipótesis viva: un throw no-`AuthError`
durante el render, ahora contenido por la medida 2. Pendiente: capturar el stack
real de Vercel.

**Upgrade path, cuando duela:** mover el refresh al `proxy.ts` — que llame a
`getUser()` y escriba las cookies renovadas en la respuesta, a costa de esa
llamada de red por request. No ahora.

### Verificación

`npm run build` verde. Ruteo probado con curl contra el build de producción:
sin cookie, con cookie inválida y assets. `GET /api/_smoke` se eliminó: era del
bootstrap y hoy sería una ruta sin auth que toca la base.

**Pendiente:** el flujo de confirmación por mail —tanto `token_hash` como el
PKCE que quedó para OAuth— está tipado (`tsc --noEmit` verde) pero **nunca se
probó end-to-end** contra Supabase, y con el toggle en OFF no hay forma de
probarlo. Queda para la TD pre-lanzamiento, junto con el SMTP propio: signup
real → mail → click → canje → sesión, con `NEXT_PUBLIC_SITE_URL` cargada en el
hosting y la URL dada de alta en Redirect URLs del dashboard.

El E2E que sí aplica hoy es el del alta directa: signup con email fresco →
sesión inmediata → `/onboarding` → crear organización → home.
