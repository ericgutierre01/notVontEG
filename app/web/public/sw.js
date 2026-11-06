// Service worker de Not Vont EG (basado en pwa-movil). Solo la página y los archivos de la app;
// el API (/api/...) va SIEMPRE a la red: son datos de tu cuenta y no deben guardarse.
const CACHE = 'vontcasa-v1'; // súbelo (v2…) cuando cambie lo que se guarda: activate borra las viejas

// La versión nueva espera a que la página la active ya montada (main.ts).
self.addEventListener('message', (event) => {
  if (event.data === 'activar') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Guarda cada respuesta buena para poder abrir sin conexión
function traer(req, clave) {
  return fetch(req).then((res) => {
    if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(clave || req, copia)); }
    return res;
  });
}

// Red primero; si tarda más de `ms` o no hay conexión, la copia guardada
function redOCopia(req, ms, clave) {
  const red = traer(req, clave);
  red.catch(() => {});
  const copia = () => caches.match(clave || req);
  const espera = new Promise((listo) => setTimeout(listo, ms)).then(copia);
  return Promise.race([red, espera]).then((r) => r || red).catch(() => copia().then((r) => r || Response.error()));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  const ruta = new URL(req.url).pathname;
  if (ruta.startsWith('/api/')) return; // nunca el API

  // Página: cualquier navegación a una ruta de la app sin extensión (/, /device/…, /add, /login).
  // Todas sirven el mismo index.html, así que se guardan bajo una sola clave: la raíz.
  // Red primero: una copia vieja haría que iOS guarde la pantalla blanca al "Agregar a inicio".
  if (req.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(ruta)) {
    event.respondWith(redOCopia(req, 2500, self.registration.scope));
    return;
  }
  if (!/\.(js|css|json|png|svg|ico|webmanifest|woff2?)$/.test(ruta)) return;

  // Archivos con huella en el nombre (main-XV2HOIMG.js): nunca cambian, la copia vale
  if (/-[A-Z0-9]{8}\.(js|css)$/.test(ruta)) {
    event.respondWith(caches.match(req).then((r) => r || traer(req)));
    return;
  }
  // Lo demás (manifest, íconos): red primero, copia si tarda más de 3 s o no hay conexión
  event.respondWith(redOCopia(req, 3000));
});
