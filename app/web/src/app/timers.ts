// Codificación de los temporizadores que guarda el firmware del aparato
// (formatos extraídos del APK; ver vont-alexa-bridge/FEATURES.md §4b).
// Máscara de días: bit0=domingo … bit6=sábado.

export const DAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
export const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const hex = (n: number, bytes: number) => n.toString(16).padStart(bytes * 2, '0').toUpperCase();
const num = (h: string, from: number, bytes: number) => parseInt(h.substr(from * 2, bytes * 2), 16) || 0;

export const toHHMM = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const fromHHMM = (s: string) => { const [h, m] = s.split(':').map(Number); return (h * 60 + m) % 1440; };

/** Bombillo `general_timer` (6 bytes): [mask|0x80 activo][inicio 2B][fin 2B][tipo 1=enciende al inicio]. */
export interface BulbTimer { enabled: boolean; days: number; start: number; end: number; onAtStart: boolean; }

export function decodeBulbTimer(h: string | null): BulbTimer {
  if (!h || h.length < 12) return { enabled: false, days: 0x7f, start: 19 * 60, end: 23 * 60, onAtStart: true };
  const b0 = num(h, 0, 1);
  return { enabled: !!(b0 & 0x80), days: b0 & 0x7f, start: num(h, 1, 2), end: num(h, 3, 2), onAtStart: num(h, 5, 1) === 1 };
}

export function encodeBulbTimer(t: BulbTimer): string {
  return hex((t.days & 0x7f) | (t.enabled ? 0x80 : 0), 1) + hex(t.start, 2) + hex(t.end, 2) + hex(t.onAtStart ? 1 : 0, 1);
}

/** Enchufe `Timer_message` (5 bytes): [mask][minuto 2B][acción 1=encender][activo]. */
export interface PlugTimer { enabled: boolean; days: number; at: number; turnOn: boolean; }

export function decodePlugTimer(h: string | null): PlugTimer {
  if (!h || h.length < 10) return { enabled: false, days: 0x7f, at: 19 * 60, turnOn: true };
  return { days: num(h, 0, 1) & 0x7f, at: num(h, 1, 2), turnOn: num(h, 3, 1) === 1, enabled: num(h, 4, 1) === 1 };
}

export function encodePlugTimer(t: PlugTimer): string {
  return hex(t.days & 0x7f, 1) + hex(t.at, 2) + hex(t.turnOn ? 1 : 0, 1) + hex(t.enabled ? 1 : 0, 1);
}

/** Enchufe `Auto_message` cuenta regresiva (6 bytes): [activo][acción][epoch fin 4B, segundos]. */
export interface Countdown { enabled: boolean; turnOn: boolean; endsAt: number; }

export function decodeCountdown(h: string | null): Countdown {
  if (!h || h.length < 12) return { enabled: false, turnOn: false, endsAt: 0 };
  return { enabled: num(h, 0, 1) === 1, turnOn: num(h, 1, 1) === 1, endsAt: num(h, 2, 4) };
}

export function encodeCountdown(minutes: number, turnOn: boolean, enabled = true): string {
  const end = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
  return hex(enabled ? 1 : 0, 1) + hex(turnOn ? 1 : 0, 1) + hex(end >>> 0, 4);
}

export function daysLabel(mask: number): string {
  if ((mask & 0x7f) === 0x7f) return 'Todos los días';
  if ((mask & 0x7f) === 0) return 'Una vez';
  if (mask === 0b0111110) return 'Lunes a viernes';
  if (mask === 0b1000001) return 'Fines de semana';
  return DAY_NAMES.filter((_, i) => mask & (1 << i)).map(n => n.slice(0, 3)).join(', ');
}

// Autoprueba contra valores reales leídos de los aparatos del usuario.
(() => {
  const b = decodeBulbTimer('00007D008C00');
  console.assert(!b.enabled && b.start === 125 && b.end === 140 && !b.onAtStart, 'bulb decode');
  console.assert(encodeBulbTimer(b) === '00007D008C00', 'bulb roundtrip');
  const p = decodePlugTimer('7F04920101');
  console.assert(p.days === 0x7f && p.at === 19 * 60 + 30 && p.turnOn && p.enabled, 'plug decode');
  console.assert(encodePlugTimer(p) === '7F04920101', 'plug roundtrip');
})();
