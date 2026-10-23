import { $, el, api, fmtLong, reportHeight } from './common.js';
import { mountPicker } from './picker.js';

const formRoot = $('#form');
let picker;
let choice = null;

function showForm() {
  const error = el('p', { class: 'error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'primary' }, 'Confirmar reserva');
  const form = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        const data = Object.fromEntries(new FormData(form));
        try {
          const { token } = await api('/api/book', { method: 'POST', body: { ...data, start: choice.ms, tz: choice.tz } });
          location.href = `/confirm?t=${encodeURIComponent(token)}`;
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
          if (err.status === 409) {
            formRoot.replaceChildren();
            choice = null;
            picker.reload();
          }
        }
      },
    },
    el('p', { class: 'summary' }, `${fmtLong(choice.ms, choice.tz)} (${choice.tz.replaceAll('_', ' ')})`),
    el('label', {}, 'Nombre', el('input', { name: 'name', required: true, maxlength: '100', autocomplete: 'name' })),
    el('label', {}, 'Email', el('input', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' })),
    el('label', {}, 'Nota (opcional)', el('textarea', { name: 'note', rows: '3', maxlength: '1000', placeholder: '¿De qué querés hablar?' })),
    error,
    submit,
  );
  formRoot.replaceChildren(form);
  $('input[name=name]', form).focus({ preventScroll: true });
}

picker = await mountPicker($('#picker'), {
  onSelect: (ms, tz) => {
    choice = { ms, tz };
    showForm();
  },
});

try {
  const { ownerName, title, slotMinutes } = await api('/api/slots');
  $('#title').textContent = title;
  $('#subtitle').textContent = `con ${ownerName} · ${slotMinutes} min · Google Meet`;
} catch {}

reportHeight();
