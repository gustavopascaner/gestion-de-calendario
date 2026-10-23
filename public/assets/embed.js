// Ajusta la altura del iframe al contenido. Copiá esto a tu landing y ponele id="booking" al <iframe>.
window.addEventListener('message', (e) => {
  if (e.data?.type !== 'booking:height') return;
  const frame = document.getElementById('booking');
  if (frame && e.source === frame.contentWindow) frame.style.height = `${e.data.height}px`;
});
