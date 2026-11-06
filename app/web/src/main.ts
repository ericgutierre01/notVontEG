import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { captureInstallPrompt } from './app/install';
import { loadConfig } from './app/config';

// Android avisa una sola vez que se puede instalar, a veces antes de que Angular arranque.
captureInstallPrompt();

// Service worker: solo en producción (no en localhost de desarrollo) y con la app ya montada.
// Si hay una versión nueva esperando, se activa ahora; nunca a mitad de la carga (en iOS traba el arranque).
function registerServiceWorker() {
  if (location.hostname === 'localhost' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const activate = (sw: ServiceWorker | null) => sw?.postMessage('activar');
    activate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => { if (next.state === 'installed') activate(next); });
    });
  }).catch(err => console.error('Service worker', err));
}

// config.json se lee al arrancar (sin compilar): ahí va la dirección del API.
loadConfig()
  .then(() => bootstrapApplication(AppComponent, appConfig))
  .then(() => {
    try { sessionStorage.removeItem('app-reintento'); } catch { /* modo privado */ }
    registerServiceWorker();
  })
  .catch(err => {
    console.error(err);
    document.body.innerHTML = '<p style="font-family:system-ui;padding:24px">No se pudo iniciar la app. Recarga la página.</p>';
  });
