# Página de reservas personal

Un Calendly casero: un solo proceso Node, SQLite, sin cuentas y sin framework.

- `/book` muestra tus horarios libres de los próximos 14 días en la zona horaria del visitante.
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
npm test
```

## Panel de configuración (`/admin`)

Definí `ADMIN_SECRET` en `.env` y entrá a `http://localhost:3000/admin` con esa contraseña. Desde ahí, sin tocar código:

- **Evento:** tu nombre, título, descripción, ubicación, duración, descanso entre reuniones, antelación mínima, días hacia adelante y zona horaria.
- **Horarios:** días y tramos horarios de cada día de la semana (varios tramos por día).
- **Formulario:** preguntas adicionales además de nombre y email — texto corto, texto largo, teléfono, lista desplegable o casilla (p. ej. aceptar términos). Obligatorias u opcionales, con texto de ayuda y reordenables.
- **Apariencia:** color principal, mensaje que se muestra al confirmar y, opcionalmente, redirigir a tu propia página de «gracias» (si el sitio está embebido en un iframe, se redirige la ventana completa).
- **Reservas:** próximas reservas con las respuestas del formulario, y botón para cancelar (avisa al visitante).
- **Integraciones:** estado de Google Calendar (con botón para conectar) y SMTP.

Los cambios se aplican al instante. Se guardan en SQLite; [config.js](config.js) solo aporta los **valores iniciales** la primera vez (después manda lo guardado en el panel). Las respuestas viajan en los emails que te llegan y en la descripción del evento de Google.

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

## Embeber en una landing

```html
<iframe id="booking" src="https://reservas.tudominio.com/book" title="Reservar una reunión"
        style="width:100%;height:560px;border:0"></iframe>
<script src="https://reservas.tudominio.com/assets/embed.js"></script> <!-- opcional: ajusta la altura -->
```

- Por defecto cualquier sitio puede embeberla. Para restringirlo: `EMBED_ORIGINS=https://tulanding.com`.
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
