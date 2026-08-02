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
**TD-003 -> HECHO**: proyectos (CRUD mínimo), upload de PDF directo a Storage,
viewer con pdf.js y diagnóstico vector/raster persistido.
**TD-004 -> HECHO**: calibración de escala por plano (el usuario marca una cota
conocida) + motor geométrico puro y testeado en `src/lib/geometry/`.
**Próximo: TD-005** (herramientas de medición: largo / muro / área con
persistencia).

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

## TD-003 — Proyectos, upload de planos, viewer y diagnóstico vector/raster

Primer flujo de producto: crear un proyecto, subirle un PDF de plano, verlo, y
decidir si ese PDF está **dibujado** (vectorial) o **escaneado** (raster). Ese
veredicto es la precondición de la auto-detección de muros: sobre un escaneo no
hay geometría que leer.

Fuera de alcance a propósito: medición y calibración (TD-004/005). El viewer es
render + navegación + zoom, sin una sola herramienta de dibujo.

### Storage: bytes por afuera del server

**Decisión: los bytes NUNCA pasan por el lambda.** El límite de body de una
Server Action / función de Vercel ronda los 4,5 MB y un plano de obra lo pasa
sin esfuerzo. El archivo va **directo del browser a Supabase Storage**; el
servidor solo autoriza antes y confirma después.

| Momento | Quién | Qué hace |
| --- | --- | --- |
| Autorizar | `requestPlanUpload` (server action) | Valida sesión + org + proyecto + MIME + tamaño, crea la fila `plans` en `PENDING` y mintea una **signed upload URL** |
| Subir | Browser | `PUT` del `File` a esa URL, con barra de progreso |
| Diagnosticar | Browser | pdf.js sobre el `File` que ya está en memoria |
| Confirmar | `finalizePlanUpload` (server action) | Verifica el objeto **contra Storage**, recalcula el veredicto y pasa el plan a `READY` |
| Re-visitar | `GET /api/plans/[planId]/file` | Mintea una **signed download URL** de 5 minutos |

**Decisión: tenancy en la app, no en RLS de Storage.** El bucket `plans` es
privado y no tiene políticas: la autorización vive en el código. Toda operación
de Storage se firma **recién después** de haber probado, vía
`getTenantPrisma(orgId)`, que la fila es de la organización de la sesión. Es la
misma frontera que ya usa todo lo demás, en vez de una segunda frontera en otro
lenguaje que haya que mantener sincronizada.

- **La `storagePath` la arma el servidor, nunca el cliente**:
  `{orgId}/{projectId}/{planId}.pdf`. El orgId adelante no es cosmético: deja la
  clave particionada por tenant desde el día uno, por si algún día se suman
  políticas de Storage.
- **El bucket topea lo mismo que el código**: privado, `application/pdf`,
  50 MB. El límite se repite en tres lugares (input del browser, server action,
  bucket) y los tres tienen que decir lo mismo — el que manda es el bucket,
  porque es el único que el cliente no puede saltear.
- **`SUPABASE_SERVICE_ROLE_KEY` vive en un solo módulo**,
  `src/lib/supabase/admin.ts`, que arranca con `import "server-only"`: si algún
  día un client component lo importa —directo o por una cadena de imports— el
  build **falla** en vez de mandar la llave al browser. Sin prefijo
  `NEXT_PUBLIC_` (esas se inlinean en el bundle del cliente), sin loguearse y
  sin volver en ninguna respuesta: lo único que sale son URLs firmadas.
- **`PENDING` no es decoración.** Es el estado real entre "se firmó la URL" y
  "el objeto está confirmado". Si el usuario cierra la pestaña en el medio, la
  fila queda en `PENDING` y el viewer no la ofrece. Pasó de verdad durante la
  verificación de esta TD y se comportó como corresponde.
- **XHR en vez de `uploadToSignedUrl()` del SDK.** El SDK usa `fetch`, que no
  reporta progreso de subida; para 40 MB eso es una pantalla congelada. El
  destino es exactamente el mismo endpoint (`src/lib/plans/upload.ts`).
- **La ruta de lectura es un Route Handler, no un action.** No muta nada, y los
  Server Actions se despachan de a uno por cliente: una lectura no tiene por qué
  hacer cola detrás de una mutación. Devuelve la URL firmada con
  `Cache-Control: no-store` — es una credencial de vida corta.

### Modelo de datos

`projects.escantillonDefault` (metros, default 2.4) y la tabla `plans`:
puntero al objeto (`storagePath`, `originalFilename`, `contentType`,
`fileSizeBytes`), resultado del diagnóstico (`pageCount`, `hasVectorGeometry`,
`diagnosisJson`) y `status` (`PENDING` | `READY`). `organizationId` y
`projectId` con FK e índice; el segundo con `onDelete: Cascade`.

`Plan` es tenant-scoped: está en `TENANT_SCOPED_MODELS`, tiene su bloque de
tipos en `tenant.ts` (el `organizationId` opcional en los creates) y sus casos
en `scripts/test-tenant-isolation.ts` — las tres cosas que pide la primitiva.
El caso de fuga propio de esta feature está cubierto explícitamente: filtrar
`plan.findMany({ where: { projectId } })` con el `projectId` de otra
organización **no devuelve nada**, porque el filtro natural del detalle de
proyecto es justamente el que invita a olvidarse de la org.

La calibración (`scaleFactor` / `unit`) queda **diferida a TD-004**.

### Diagnóstico vector/raster

Corre **en el browser** (pdf.js necesita un DOM y ya tiene el archivo en
memoria) y no renderiza nada: cuenta operadores con `getOperatorList()`.

**Decisión: el cliente CUENTA, el servidor DECIDE.** El payload que viaja son
conteos crudos por página; el veredicto lo calcula `diagnosePlan()`
(`src/lib/plans/diagnosis.ts`), una función pura que el server vuelve a aplicar
sobre esos números. Así lo guardado nunca puede contradecir a sus propios
conteos, y mover un umbral mañana es recalcular sobre lo ya persistido. Si el
veredicto del cliente difiere del recalculado, se loguea como drift entre las
dos puntas (deploy a medio camino, bundle viejo en caché) y manda el servidor.

Qué se cuenta por página: segmentos de path, operaciones de pintado, de imagen,
de texto, y **cuánto de la página tapa la imagen más grande**.

- **⚠️ En pdf.js v6 no existen `moveTo` / `lineTo` / `rectangle` sueltos.** El
  worker los comprime en un único `constructPath` cuyos args traen los segmentos
  codificados en un `Float32Array`. Contar `fnArray` a secas daría "12 paths"
  donde hay 9.400 segmentos, que es justo el dato que decide todo. Los códigos
  de `DrawOPS` son internos y **no están exportados**: van escritos a mano en
  `diagnose.ts`, y el recorrido corta ante un código desconocido (conteo corto,
  nunca inventado). Revisar esa tabla al subir de major.
- **La cobertura de imagen se calcula con un solo número.** pdf.js dibuja toda
  imagen sobre el cuadrado unitario de la transformación corriente, así que el
  área cubierta es `|det(CTM)|`; y como `det(A·B) = det(A)·det(B)`, no hace
  falta llevar la matriz entera: alcanza con el determinante y su pila de
  `save`/`restore`. Ignora clips y grupos de transparencia, así que
  **sobreestima** la cobertura — el error empuja hacia "raster", que es el lado
  conservador: un falso "vectorial" mandaría la auto-detección a buscar
  geometría que no existe.
- **La heurística tiene dos umbrales, no uno.** Página vectorial = al menos 40
  segmentos de path **y** que no esté dominada por una imagen a página completa
  (≥60% del área). Lo segundo importa tanto como lo primero: un plano escaneado
  con cajetín y marco vectoriales pasa los 40 segmentos sin tener una sola pared
  que detectar. Para ganarle a una imagen a página completa hacen falta 200
  segmentos. Documento vectorial = **alguna** página lo es (un PDF de 12 hojas
  donde solo la planta baja está dibujada igual sirve, en esa hoja).
- **Tope de 30 páginas analizadas.** El conteo es O(operadores) y corre en la
  pestaña del usuario. `pageCount` sigue siendo el real y la UI aclara cuántas
  se miraron.
- **`diagnosisJson` se relee con Zod.** La columna es `Json`: lo que hay adentro
  lo escribió una versión anterior del código. Si no valida, el plano se muestra
  sin desglose en vez de romper la página.

### pdf.js bajo Next 16 / Turbopack

- **Build LEGACY, no el moderno.** No es conservadurismo: el build moderno de
  pdf.js v6 llama a `Map.prototype.getOrInsertComputed` (propuesta reciente de
  TC39), y en un Chromium sin ese método `getOperatorList()` explota con
  `this._intentStates.getOrInsertComputed is not a function`. Verificado en
  Chromium headless durante esta TD, no es teoría: el primer E2E falló
  exactamente ahí. El build legacy trae el polyfill adentro. Se paga un bundle
  algo más grande; la alternativa era que el diagnóstico no corra en la máquina
  de un cliente.
- **El worker se sirve desde `/public`.** `scripts/copy-pdf-worker.mjs` lo copia
  en cada `npm install` (postinstall) desde la versión instalada, y está en
  `.gitignore`: commitearlo es la forma segura de que se desincronice de la
  librería, y pdf.js aborta si las versiones difieren. La alternativa —dejar que
  el bundler resuelva `new URL(<paquete>, import.meta.url)`— depende de que
  Turbopack entienda esa forma con un specifier de paquete, y un fallo ahí
  aparece recién en runtime como "Setting up fake worker failed".
- **El import de pdf.js es dinámico.** Los client components también se
  renderizan en el servidor, y pdf.js toca `document` y `Worker` al evaluarse.
- **El viewer se remonta con `key`, no se resetea con efectos.** Cambiar de
  plano tiene que reabrir el documento desde cero; escribir estado
  sincrónicamente en el cuerpo de un efecto además dispara renders en cascada
  (y el lint de React 19 lo marca como error).
- **El canvas se dibuja a resolución de dispositivo** (topeada en 2×) y se
  muestra a tamaño CSS: sin eso, las líneas finas de un plano salen borrosas en
  una pantalla retina.

### Verificación

- `npm run db:test-isolation` en verde, ahora con **14 casos nuevos de `plans`**
  (lecturas cruzadas, `where` olvidado, create sin org, create/createMany/upsert
  hacia otra org, update que intenta mover la fila, deletes).
- E2E real con Chromium headless contra el dev server: signup → onboarding →
  crear proyecto → subir PDF → badge → viewer (render, zoom, navegación) →
  re-visita por URL firmada → rechazo de un no-PDF. Sin errores de consola.
  Confirmado en el Network que el `PUT` de los bytes va a
  `supabase.co/storage/v1/...` y **no** al server de la app.
- Cuatro PDFs de prueba construidos a mano para cubrir los cuatro cuadrantes de
  la heurística: vectorial puro, imagen a página completa, escaneo con cajetín
  vectorial (la trampa) y vectorial con logo chico. Los cuatro veredictos
  salieron como corresponde, en el browser y persistidos en la base.
- `next build`, `tsc --noEmit` y `eslint` limpios. Verificado por grep sobre
  `.next/static` que **ni la service_role key ni su nombre** aparecen en el
  bundle del cliente (control positivo: un string de la UI sí aparece, así que
  el grep mira donde tiene que mirar).

**Pendiente para Diego**: no hay planos reales en la máquina, así que el
veredicto sobre PDFs de obra de verdad —el dato que decide el enfoque de la
auto-detección de muros— todavía no se puede reportar. Subir dos o tres planos
reales y mirar el desglose por página.

## TD-004 — Calibración de escala y motor geométrico

Lo que convierte al viewer en una herramienta de cubicación: saber cuánto mide
en la realidad lo que se ve en el plano. Dos cimientos, ninguna herramienta de
medición todavía (eso es TD-005).

### El motor geométrico: `src/lib/geometry/`

Funciones puras, sin React, sin Next, sin pdf.js: `distance`, `polylineLength`,
`polygonArea` (shoelace), `toMeters`, `scaleFactorFromCalibration`,
`applyScaleLength`, `applyScaleArea`. `npm test` (vitest) corre 20 casos contra
resultados conocidos — 3-4-5, cuadrado de 2×2, triángulo de base 4 y altura 3 —
en 300 ms y sin levantar nada.

Que sea puro no es prolijidad: es lo que permite que las cuentas del negocio se
verifiquen sin browser ni base, y que el server pueda hacerlas sin importar una
línea de UI.

**Dos convenciones que valen para todo el sistema:**

1. **Los puntos van en USER-SPACE del PDF, nunca en píxeles.** Un píxel depende
   del zoom, del ancho de la ventana y del DPR de la pantalla; el user-space es
   del documento y no se mueve. La conversión ocurre en un solo lugar —el
   viewer— y de ahí para adentro no entra un píxel.
2. **Toda longitud real está en METROS.** `scaleFactor` son metros por unidad de
   user-space. El usuario tipea en m/cm/mm y se normaliza en el borde. De ahí
   salen las dos fórmulas: `longitud real = longitud_pdf × scaleFactor` y
   `área real = área_pdf × scaleFactor²`.

**Invariantes que los tests fijan, y por qué cada uno:**

- **`polylineLength` NO cierra la figura.** Un cuadrado unitario marcado con sus
  4 vértices mide 3, no 4: el usuario marcó tres segmentos, y cerrarlo por
  nuestra cuenta sería inventarle un cuarto muro.
- **`polygonArea` SÍ cierra, y devuelve valor absoluto.** El signo del shoelace
  solo dice si se marcó en sentido horario o antihorario; un área negativa
  porque el usuario giró para el otro lado no significa nada físico.
- **El área lleva el factor al cuadrado.** 400 unidades² con `scaleFactor` 0,05
  son 1 m², no 20. Es el error que más caro sale y por eso tiene su test.
- **Las divisiones tienen guarda.** Dos puntos en el mismo lugar (doble click,
  que pasa) darían `Infinity`, y ese infinito quedaría persistido envenenando
  toda medición futura del plano. Rompe con mensaje, no con un número.

### Calibración: el cliente marca, el servidor calcula

| Paso | Dónde | Qué pasa |
| --- | --- | --- |
| Marcar | Browser | Dos clicks sobre una cota conocida; cada uno se convierte a user-space con `viewport.convertToPdfPoint()` |
| Tipear | Browser | La medida real + su unidad (m/cm/mm) |
| Derivar | `calibratePlan` (server action) | Zod valida; el motor calcula `pdfDistance`, `realMeters` y `scaleFactor` |
| Guardar | `getTenantPrisma(orgId)` | `plans.scaleFactor` + `plans.calibrationJson` |

**El `scaleFactor` NO viaja desde el cliente.** Un server action es un POST
alcanzable sin pasar por la UI: si el factor viniera del browser, alcanzaría un
POST a mano para declarar cualquier escala y todas las cubicaciones del plano
saldrían de un número que nadie derivó. Lo que viaja son los dos puntos y la
cota; la cuenta es del servidor. Es la misma decisión que en el diagnóstico
vector/raster de TD-003, por la misma razón.

- **`calibrationJson` guarda el CÓMO, no solo el cuánto**: página, los dos
  puntos, el valor y la unidad tipeados, la distancia PDF y el timestamp. Sin
  eso, un factor sospechoso no se puede revisar; con eso, se rehace la cuenta
  sin volver a marcar nada.
- **Solo se calibran planos `READY`**, y el `pageIndex` se valida contra el
  `pageCount` real del documento.
- **Recalibrar sobrescribe.** Hay un solo factor por plano y el registro nuevo
  es el que lo explica.
- **La escala 1:N que muestra la UI es comodidad de lectura, no un dato del
  sistema.** El sistema mide con `scaleFactor`; el 1:N sirve para el control que
  cualquier arquitecto hace de memoria contra el cajetín del plano.

### El punto delicado: click → user-space

Está todo en `pdf-viewer.tsx`, y son tres detalles que importan:

- **El viewport que traduce clicks es el CSS, no el del render.** El canvas se
  dibuja multiplicado por el `devicePixelRatio` (topeado en 2) para que las
  líneas finas no salgan borrosas; usar ESE viewport para los clicks daría
  puntos corridos por 2 en cualquier pantalla retina — un error que en un
  monitor común no se ve nunca. Por eso se guarda aparte el viewport a escala
  CSS.
- **`getBoundingClientRect()` para el origen.** Da la caja del canvas ya
  resuelta (scroll, layout), así que restarla de `clientX/Y` da coordenadas
  relativas al canvas, que es exactamente el espacio del viewport CSS.
  `convertToPdfPoint` hace el resto, incluida la rotación de la página y que el
  eje Y del PDF vaya para arriba y el de la pantalla para abajo.
- **El overlay va de vuelta por el mismo camino** (`convertToViewportPoint`), y
  por eso las marcas quedan pegadas al plano al hacer zoom en vez de flotar
  donde se clickeó. Es también la verificación visual de que el viaje de ida y
  vuelta cierra.
- **`convertToPdfPoint` está tipada como `any[]` en pdfjs-dist.** El resultado
  entra por `unknown` y se estrecha a mano (`readPair`): ese `any` de la
  librería no se cuela adentro nuestro.

### Límite conocido: una escala por plano

El MVP guarda **un** `scaleFactor` por plano, junto con la página sobre la que se
calibró. Una lámina con dos escalas distintas (la planta en 1:50 y un detalle en
1:20, algo habitual) no está cubierta: mediciones sobre el detalle van a salir
mal, y hoy nada las frena.

**Multi-escala queda DIFERIDO.** Cuando haga falta, el camino es mover la
calibración a una fila por página o por región, no agregarle campos a `plans`.
El `calibrationJson` ya guarda el `pageIndex`, así que la migración tiene de
dónde agarrarse.

### Verificación

- `npm test`: 20 casos del motor en verde.
- `npm run db:test-isolation`: 4 casos nuevos, específicos de calibrar —
  calibrar por id un plano de otra org, hacerlo por `updateMany` con el
  `organizationId` ajeno en el where, una calibración masiva que no puede
  desbordar el tenant, y la comprobación de que el plano ajeno sigue sin
  calibrar.
- **E2E contra el plano REAL de Diego** (`FUNDACIONES.pdf`, 3370×2384 pt,
  rotada 270°): se marcó la cadena de cotas completa —17,89 m entre dos ticks
  separados 1014,12 unidades de user-space, valor sacado de las 16 etiquetas del
  propio plano— y la app derivó **1:50,01**. El cajetín del plano dice
  "escala 1/50": la verificación es independiente del dato que se le dio.
- **Invariancia al zoom**, la misma cota marcada a dos zooms distintos (×2,44
  entre uno y otro):

  | | plano real (FUNDACIONES) | plano sintético (cota exacta de 300 u) |
  | --- | --- | --- |
  | ajustado al ancho | 0,017643686 (1:50,01) | 0,050014930 |
  | ampliado ×2,44 | 0,017633458 (1:49,98) | 0,050010462 |
  | valor exacto | 0,017640910 | 0,050000000 |
  | diferencia entre ambos | **0,058 %** | **0,0089 %** |

  El residuo es cuantización del click (el puntero cae en un píxel entero), no
  del modelo: la conversión a user-space es exacta. Se achica marcando cotas
  largas, que es lo que conviene hacer igual.
