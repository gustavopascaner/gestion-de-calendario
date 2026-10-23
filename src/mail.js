import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import config from '../config.js';

let transport;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function send(message) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail] SMTP no configurado, no se envió: "${message.subject}" → ${message.to}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, ...message });
  } catch (err) {
    // Un fallo de mail no debe romper una reserva ya confirmada.
    console.error(`[mail] error enviando a ${message.to}: ${err.message}`);
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

function whenText(booking, tz) {
  const s = DateTime.fromMillis(booking.start_utc, { zone: tz }).setLocale('es');
  const e = DateTime.fromMillis(booking.end_utc, { zone: tz }).setLocale('es');
  return `${s.toFormat("cccc d 'de' LLLL, HH:mm")}–${e.toFormat('HH:mm')} (${tz})`;
}

const TITLES = {
  confirmed: ['Reserva confirmada', 'Tu reunión está confirmada'],
  rescheduled: ['Reserva reprogramada', 'Tu reunión fue reprogramada'],
  cancelled: ['Reserva cancelada', 'Tu reunión fue cancelada'],
};

function layout(heading, rows, links) {
  const body = rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td>${v}</td></tr>`).join('');
  const actions = links.map(([label, href]) => `<a href="${esc(href)}">${esc(label)}</a>`).join(' · ');
  return `<div style="font-family:system-ui,sans-serif;max-width:520px"><h2>${esc(heading)}</h2><table>${body}</table>${actions ? `<p>${actions}</p>` : ''}</div>`;
}

const plain = (heading, rows, links) =>
  [heading, '', ...rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '')}`), '', ...links.map(([l, h]) => `${l}: ${h}`)].join('\n');

/**
 * kind: 'confirmed' | 'rescheduled' | 'cancelled'
 * Manda un mail al visitante (en su zona horaria) y otro al dueño.
 */
export async function notify(kind, booking, { manageUrl }) {
  const [subj, visitorHeading] = TITLES[kind];
  const meet = booking.meet_url ? [['Google Meet', `<a href="${esc(booking.meet_url)}">${esc(booking.meet_url)}</a>`]] : [];

  const visitorRows = [['Cuándo', esc(whenText(booking, booking.tz))], ['Con', esc(config.ownerName)], ...(kind === 'cancelled' ? [] : meet)];
  const visitorLinks = kind === 'cancelled' ? [] : [['Cancelar o reprogramar', manageUrl]];
  const mails = [
    {
      to: booking.email,
      subject: `${subj}: ${config.title}`,
      html: layout(visitorHeading, visitorRows, visitorLinks),
      text: plain(visitorHeading, visitorRows, visitorLinks),
    },
  ];

  if (process.env.OWNER_EMAIL) {
    const ownerRows = [
      ['Cuándo', esc(whenText(booking, config.timezone))],
      ['Quién', `${esc(booking.name)} &lt;${esc(booking.email)}&gt;`],
      ['Nota', booking.note ? esc(booking.note).replace(/\n/g, '<br>') : '—'],
      ...(kind === 'cancelled' ? [] : meet),
    ];
    mails.push({
      to: process.env.OWNER_EMAIL,
      subject: `${subj}: ${oneLine(booking.name)}`,
      html: layout(subj, ownerRows, []),
      text: plain(subj, ownerRows, []),
      replyTo: booking.email,
    });
  }

  await Promise.all(mails.map(send));
}
