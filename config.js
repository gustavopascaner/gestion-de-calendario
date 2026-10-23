// Reglas de disponibilidad. Editá este archivo y reiniciá el servidor.
export default {
  ownerName: 'Gus Pascaner',
  title: 'Reunión de 30 minutos',

  // Zona horaria en la que están escritas las reglas semanales (nombre IANA).
  timezone: 'America/Argentina/Buenos_Aires',

  slotMinutes: 30, // duración de cada reunión
  bufferMinutes: 15, // descanso mínimo entre reuniones
  minNoticeHours: 4, // no se puede reservar con menos antelación que esto
  horizonDays: 14, // cuántos días hacia adelante se muestran (incluye hoy)

  // Rangos [desde, hasta] por día de la semana, en la zona horaria de arriba.
  // Un día sin rangos (o ausente) no tiene disponibilidad. Se admiten varios rangos por día:
  //   mon: [['10:00', '13:00'], ['14:30', '17:00']]
  weekly: {
    mon: [['10:00', '17:00']],
    tue: [['10:00', '17:00']],
    wed: [['10:00', '17:00']],
    thu: [['10:00', '17:00']],
    fri: [['10:00', '17:00']],
    sat: [],
    sun: [],
  },
};
