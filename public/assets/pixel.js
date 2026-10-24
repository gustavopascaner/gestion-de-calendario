// Meta Pixel sin código inline (la CSP no lo permite): el loader oficial, escrito como módulo.
export function initPixel(id) {
  if (window.fbq) return;
  const fbq = (window.fbq = (...args) => (fbq.callMethod ? fbq.callMethod(...args) : fbq.queue.push(args)));
  window._fbq = fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.queue = [];
  const script = Object.assign(document.createElement('script'), { async: true, src: 'https://connect.facebook.net/en_US/fbevents.js' });
  document.head.append(script);
  fbq('init', id);
  fbq('track', 'PageView');
}

// Da un instante para que el navegador despache el evento antes de navegar a la confirmación o al redirect.
export async function trackPixel(name, params = {}) {
  if (!window.fbq) return;
  window.fbq(/^(Schedule|Lead|CompleteRegistration|Contact|SubmitApplication|ViewContent|Purchase|InitiateCheckout|AddToCart)$/.test(name) ? 'track' : 'trackCustom', name, params);
  await new Promise((r) => setTimeout(r, 500));
}
