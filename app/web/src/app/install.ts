import { signal } from '@angular/core';

/** Evento de instalación de Android/Chrome guardado para un botón "Instalar" propio. */
let deferred: any = null;
export const canPrompt = signal(false);

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    canPrompt.set(true);
  });
  window.addEventListener('appinstalled', () => { deferred = null; canPrompt.set(false); });
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null; canPrompt.set(false);
  return outcome === 'accepted';
}

/** Ya abierta como app instalada (desde el ícono). */
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

/** Safari de iPhone/iPad: no hay aviso de instalar, hay que explicar Compartir → Agregar a inicio. */
export const isIosSafari = () => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
};
