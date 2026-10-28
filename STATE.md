# Estado

- Página de reservas tipo Calendly (Node + SQLite + Google Calendar + SMTP). Ver README.md.
- Webhooks: varios destinos con nombre (kv `webhooks`); cada tipo de evento elige el suyo con `webhookId` ('main' por defecto, 'none' = ninguno). La URL vieja de los ajustes generales se migra sola a «Principal».
- Colores: el panel de admin y la página con el listado de eventos usan siempre el verde de la marca (#477a6f, de ~/.config/motion/brands/gus-pascaner). Cada página de reserva usa el color de su evento.
- Tests: `npm test` (incluye e2e).
