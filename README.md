# Página de reservas personal

Un Calendly casero: un solo proceso Node, SQLite, sin cuentas y sin framework.

- `/book` muestra tus horarios libres de los próximos 14 días **en la zona horaria del visitante**: se detecta sola desde su navegador, se muestra bien visible arriba del calendario («Horarios en hora de Madrid (GMT+2)») y puede cambiarla. La reserva, la confirmación y los mails usan esa zona; a vos te llegan en la tuya.
- Flujo en dos pasos clickeables («Fecha y hora» → «Tus datos») que conserva lo que el visitante ya eligió o escribió al ir y volver; pensado y probado para celular.
- Diseño tipo Calendly: calendario mensual, horarios, y formulario que configurás vos desde un panel `/admin`.
- Disponibilidad = reglas semanales (configurables en el panel) − reservas − eventos ocupados de Google Calendar.
- Al reservar: se crea el evento en tu Google Calendar con link de **Google Meet** y el visitante invitado.
- Emails de confirmación a ambos por SMTP, con links firmados para **cancelar o reprogramar**.
- Se puede embeber en una landing con un `<iframe>`.

Google Calendar y SMTP son opcionales: sin ellos funciona igual (solo SQLite; los mails se escriben en la consola), útil para probar.

## ⚠️ Aviso: la parte pesada es Google

**Configurar la app OAuth en Google Cloud es la parte engorrosa de todo el proyecto. Reservá una hora solo para la consola de Google Cloud** (proyecto, pantalla de consentimiento, credenciales, usuarios de prueba). El código funciona sin esto; dejalo para el final.

## Requisitos e instalación

Node ≥ 22.13 (usa `node:sqlite` incluido, sin compilar nada).

```bash
npm install
cp .env.example .env     # completá SIGNING_SECRET como mínimo
npm start                # http://localhost:3000/book
npm test                 # unitarios + end-to-end del flujo completo
```

`npm test` incluye un test de punta a punta (`test/e2e.test.js`) que levanta el servidor real con una base temporal y recorre todo: login del panel, ABM de eventos, reservar (con validaciones y doble reserva), agenda compartida entre eventos, reprogramar, cancelar, links manipulados y el webhook. Conviene correrlo antes de cada deploy.

## Panel de configuración (`/admin`)

Definí `ADMIN_SECRET` en `.env` y entrá a `http://localhost:3000/admin` con esa contraseña. Desde ahí, sin tocar código:

- **Inicio:** próximas reservas, reservas y horas agendadas del mes, canceladas, reservas por evento y el estado de las integraciones (Google, SMTP, webhook).
- **Eventos (ABM):** creá, editá, duplicá, ordená, activá/desactivá y eliminá tipos de evento (p. ej. «Llamada de 15 min», «Mentoría de 60 min»). Cada uno tiene su propio link `/book/<slug>`, y botones para copiar el link o el código del `<iframe>`. Un evento con reservas no se puede borrar: desactivalo para ocultarlo. Al editar un evento:
  - **Detalles:** título, link, activo, descripción, ubicación, duración, descanso entre reuniones, antelación mínima y días hacia adelante.
  - **Horarios:** días y tramos horarios propios de ese evento (varios tramos por día).
  - **Formulario:** preguntas adicionales además de nombre y email — texto corto, texto largo, teléfono, lista desplegable o casilla (p. ej. aceptar términos). Obligatorias u opcionales, con texto de ayuda y reordenables.
  - **Apariencia:** color principal, mensaje que se muestra al confirmar y, opcionalmente, redirigir a tu propia página de «gracias» (si el sitio está embebido en un iframe, se redirige la ventana completa).
- **Reservas:** próximas reservas (con el evento y las respuestas del formulario) y botón para cancelar (avisa al visitante).
- **General:** tu nombre y tu zona horaria, compartidos por todos los eventos.
- **Integraciones:** estado de Google Calendar (con botón para conectar) y SMTP.

`/book` muestra la lista de tus eventos activos (si hay uno solo, abre ese directamente) y `/book/<slug>` abre uno puntual. **Todos los eventos comparten tu agenda**: si te reservan uno, los horarios que se pisan se bloquean en los demás.

Los cambios se aplican al instante. Se guardan en SQLite; [config.js](config.js) solo aporta los **valores iniciales** la primera vez (después manda lo guardado en el panel). Si venías de la versión de un solo evento, tus ajustes y reservas se migran solos al primer evento. Las respuestas viajan en los emails que te llegan y en la descripción del evento de Google.

El buffer separa reuniones: con una reunión de 10:00 a 10:30 y 15 min de descanso, el siguiente horario ofrecido es 11:00.

## Variables de entorno

Todas están documentadas en [.env.example](.env.example). Imprescindible: `SIGNING_SECRET` (genera los tokens de cancelación) y `BASE_URL` (la URL pública, usada en los links de los emails).

## Email (SMTP)

Completá `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` y `OWNER_EMAIL`. Para probar sin enviar nada real sirve [Mailpit](https://mailpit.axllent.org/) (`SMTP_HOST=localhost`, `SMTP_PORT=1025`).

## Google Calendar + Meet (≈ 1 hora la primera vez)

1. En [console.cloud.google.com](https://console.cloud.google.com) creá un proyecto.
2. **APIs y servicios → Biblioteca**: habilitá **Google Calendar API**.
3. **Pantalla de consentimiento OAuth** (Google Auth Platform): tipo *Externo*, completá nombre y emails de contacto.
   - Agregá los scopes `.../auth/calendar.events` y `.../auth/calendar.freebusy`.
   - Agregá tu cuenta de Google como **usuario de prueba**.
   - ⚠️ En modo *Testing* el refresh token **caduca a los 7 días** y tendrías que reconectar. Para que dure, pasá la app a *En producción* (como es solo para vos, no hace falta verificación; vas a ver la advertencia de "app no verificada" y la aceptás).
4. **Credenciales → Crear credenciales → ID de cliente OAuth**: tipo *Aplicación web*. En *URI de redireccionamiento autorizados* poné exactamente el valor de `GOOGLE_REDIRECT_URI` (p. ej. `http://localhost:3000/admin/google/callback`, o tu dominio público con https).
5. Copiá el ID y el secreto a `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) y definí `ADMIN_SECRET`.
6. Arrancá el servidor, entrá a `/admin` → pestaña **Integraciones** → **Conectar con Google** y aceptá los permisos. El refresh token queda guardado en SQLite.

Notas:
- Los eventos se crean en `GOOGLE_CALENDAR_ID` (por defecto `primary`) y se consulta el mismo calendario para ver qué estás ocupado. Los eventos de día completo marcados como "ocupado" bloquean ese día.
- Google también envía su propia invitación al visitante, además del mail de este sistema.
- Si Google falla al reservar, la reserva **no** se confirma (para no prometer un horario que no está en tu calendario).
- Para crear Meet necesitás una cuenta que lo permita (las cuentas personales de Gmail sirven).

### Cuentas de Google extra (solo disponibilidad)

En `/admin` → **Integraciones** → **+ Conectar otra cuenta de Google**. Esas cuentas **solo se consultan** para saber si estás ocupado (permiso `calendar.freebusy`, sin acceso a los eventos): no se crea ningún evento ni link de Meet ahí. Los horarios ocupados en cualquiera de las cuentas (la principal o las extra) se bloquean en tus páginas de reserva. No hace falta tocar Google Cloud: usan el mismo cliente OAuth y la misma URI de redirección. Si una cuenta extra deja de responder (por ejemplo, revocaste el acceso), las reservas se frenan con un error en vez de arriesgar una doble reserva: reconectala o quitala desde el panel.

## Webhook para n8n

En `/admin` → **Integraciones** → **Webhooks (n8n)**: pegá la URL de producción de tu nodo *Webhook* de n8n (método `POST`), un secreto opcional y usá **Enviar prueba** para ver el payload en n8n. Podés agregar varios webhooks con nombre (hasta 10); en cada tipo de evento, pestaña **Detalles** → **Webhook (n8n)**, elegís a cuál van sus reservas o «No enviar a ningún webhook». «Principal» siempre existe y es el de los eventos que no eligieron otro; un webhook que usa algún evento no se puede quitar. Cada vez que alguien reserva, reprograma o cancela se envía un `POST` JSON, **con la misma forma que el de Calendly** (`event` + `payload`), así que los flujos que hoy leen Calendly se adaptan casi sin cambios:

| `event` | Cuándo |
|---|---|
| `invitee.created` | nueva reserva |
| `invitee.rescheduled` | el visitante cambió el horario (`payload.rescheduled: true`, `payload.old_start_time`) |
| `invitee.canceled` | cancelación (del visitante o desde el panel) |
| `test` | el botón «Enviar prueba» |

Campos principales de `payload`: `booking_id`, `name`, `first_name`, `last_name`, `email`, `timezone`, `status`, `cancel_url`, `reschedule_url`, `questions_and_answers` (`[{question, answer, position}]` con las preguntas de tu formulario, p. ej. el WhatsApp), `scheduled_event` (`name`, `start_time`, `end_time` en UTC, `status`, `event_type`, `event_type_slug`, `location.join_url` con el Meet, `event_memberships`) y `tracking` (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`).

- **UTM:** agregalos al link o al `src` del iframe (`/book/reunion?utm_source=instagram`) y llegan en `payload.tracking`.
- **Seguridad:** si definís un secreto, se envía en el header `X-Webhook-Secret`; en n8n podés validarlo con *Authentication → Header Auth* en el nodo Webhook.
- **Reintentos:** si n8n no responde 2xx, se reintenta a los 2 s, 10 s y 60 s. El panel muestra los últimos envíos con su estado. El webhook nunca bloquea ni hace fallar la reserva.

## Embeber en una landing

```html
<iframe id="booking" src="https://reservas.tudominio.com/book/reunion" title="Reservar una reunión"
        style="width:100%;height:560px;border:0"></iframe>
<script src="https://reservas.tudominio.com/assets/embed.js"></script> <!-- opcional: ajusta la altura -->
```

- Por defecto cualquier sitio puede embeberla. Para restringirlo: `EMBED_ORIGINS=https://tulanding.com`.
- Podés embeber un evento puntual (`/book/<slug>`) o la lista completa (`/book`). El panel genera el código con el botón **Copiar iframe**.
- Hay un ejemplo en `/embed-example`.
- Tras reservar, el visitante ve la confirmación dentro del mismo iframe.

## Despliegue

Un único proceso: `npm start` detrás de HTTPS (Caddy/nginx) con `BASE_URL` público y `TRUST_PROXY=1`. Persistí la carpeta `data/` (SQLite). Para hacer backup basta copiar `data/bookings.db`.

## Cómo está hecho

| Archivo | Qué hace |
|---|---|
| `src/server.js` | HTTP, rutas, reservas, CSP/iframe, rate-limit |
| `src/availability.js` | genera slots (reglas, buffer, antelación) |
| `src/google.js` | OAuth, freeBusy, crear/mover/borrar evento con Meet |
| `src/mail.js` | emails a visitante y dueño |
| `src/tokens.js` | tokens HMAC-SHA256 con expiración (90 días) |
| `src/db.js` | esquema SQLite |
| `public/` | front en HTML/JS vanilla, sin build |

Los links de cancelar/reprogramar llevan un token firmado; siguen siendo válidos tras reprogramar y dejan de permitir cambios una vez comenzada la reunión.

## Despliegue en Easypanel

1. **Create → App**, fuente: tu repo de GitHub (rama `main`); el build usa el `Dockerfile`.
2. **Mounts → Volume**: montar un volumen en `/app/data` (ahí vive SQLite; sin esto se pierden las reservas en cada deploy).
3. **Domains**: tu dominio, puerto `3000`, HTTPS activado.
4. **Environment**: pegar las variables de [.env.example](.env.example) (como mínimo `BASE_URL`, `TRUST_PROXY=1`, `SIGNING_SECRET`, `ADMIN_SECRET`).
5. **Deploy**, y entrar a `/admin`.
