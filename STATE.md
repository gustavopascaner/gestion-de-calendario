# Estado

- Página de reservas tipo Calendly (Node + SQLite + Google Calendar + SMTP). Ver README.md.
- Webhooks: varios destinos con nombre (kv `webhooks`); cada tipo de evento elige el suyo con `webhookId` ('main' por defecto, 'none' = ninguno). La URL vieja de los ajustes generales se migra sola a «Principal».
- Colores: el panel de admin y la página con el listado de eventos usan siempre el verde de la marca (#477a6f, de ~/.config/motion/brands/gus-pascaner). Cada página de reserva usa el color de su evento.
- Tests: `npm test` (incluye e2e).
- Login del panel: sesión de 30 días que se renueva sola con el uso (cookie HttpOnly). El formulario tiene un usuario oculto fijo («admin») y avisa a Chrome con `PasswordCredential` para que guarde bien la contraseña.
- Sincronización desde Google Calendar: `syncFromGoogle` (server.js) hace GET de cada evento de reserva futura (como mucho 1 vez por minuto; al reservar, en fresco). Borrado → cancela; movido → reprograma; invitado rechazó → cancela y borra el evento sin avisar. Ante error de Google no toca nada.
