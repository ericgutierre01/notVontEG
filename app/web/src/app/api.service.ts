import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, throwError } from 'rxjs';
import { config } from './config';

export interface DataPoint { index: number; type: number; value: string | null; }

export interface Device {
  id: string; name: string; model: string; productId: string; uid: string;
  online: boolean; signal: number | null; firmware: string | null; mac: string | null;
  /** Último cambio de estado reportado (UTC, ISO) */
  changed: string | null;
  points: Record<string, DataPoint>;
}

const TOKEN_KEY = 'vont_token';

@Injectable({ providedIn: 'root' })
export class Api {
  private get base() { return config.apiUrl; }
  readonly authed = signal(!!localStorage.getItem(TOKEN_KEY));

  constructor(private http: HttpClient, private router: Router) {}

  private get headers() {
    return new HttpHeaders({ Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}` });
  }

  private guard<T>(o: Observable<T>): Observable<T> {
    return o.pipe(catchError((e: HttpErrorResponse) => {
      if (e.status === 401) this.logout();
      return throwError(() => e);
    }));
  }

  login(username: string, password: string) {
    return this.http.post<{ token: string }>(`${this.base}/auth/login`, { username, password });
  }
  me() {
    return this.http.get<{ email: string | null; name: string | null; photo: string | null }>(`${this.base}/me`, { headers: this.headers });
  }
  setPhoto(image: string) {
    return this.http.put<{ photo: string | null }>(`${this.base}/me/photo`, { image }, { headers: this.headers });
  }
  setNickname(name: string) {
    return this.http.put<{ name: string }>(`${this.base}/me/name`, { name }, { headers: this.headers });
  }
  sendCode(username: string, purpose: 'register' | 'reset') {
    return this.http.post<{ ok: boolean }>(`${this.base}/auth/code`, { username, purpose });
  }
  account(kind: 'register' | 'reset', username: string, password: string, code: string) {
    return this.http.post<{ ok: boolean }>(`${this.base}/auth/${kind}`, { username, password, code });
  }
  setToken(t: string) { localStorage.setItem(TOKEN_KEY, t); this.authed.set(true); }
  logout() {
    localStorage.removeItem(TOKEN_KEY); this.authed.set(false);
    localStorage.removeItem('notvont-removed'); // MACs de aparatos desvinculados: son de esta cuenta, no del navegador
    this.router.navigateByUrl('/login');
  }

  devices() {
    return this.guard(this.http.get<{ devices: Device[] }>(`${this.base}/devices`, { headers: this.headers }));
  }
  device(id: string) {
    return this.guard(this.http.get<Device>(`${this.base}/devices/${id}`, { headers: this.headers }));
  }
  /** Envía una o varias funciones en un solo comando: { power_onoff: true, brightness: 60 } */
  setDp(id: string, values: Record<string, unknown>) {
    const points = Object.entries(values).map(([name, value]) => ({ name, value }));
    return this.guard(this.http.post(`${this.base}/devices/${id}/dp`, { points }, { headers: this.headers }));
  }
  rename(id: string, name: string) {
    return this.guard(this.http.put(`${this.base}/devices/${id}/name`, { name }, { headers: this.headers }));
  }
  catalog() {
    return this.guard(this.http.get<{ productCode: number; productId: string; name: string; image: string | null }[]>(
      `${this.base}/devices/catalog`, { headers: this.headers }));
  }
  bind(productCode: number, mac: string) {
    return this.guard(this.http.post<{ uid: string }>(`${this.base}/devices/bind`,
      { productCode, mac }, { headers: this.headers }));
  }
  unbind(id: string, confirmName: string) {
    return this.guard(this.http.delete(`${this.base}/devices/${id}`,
      { headers: this.headers, body: { confirmName } }));
  }
}

/**
 * La nube de Topband tarda en reflejar los cambios en /device/v2/detail, así que lo que
 * el usuario acaba de cambiar se recuerda localmente unos segundos y tiene prioridad
 * sobre lecturas viejas del servidor.
 */
const OVERRIDE_MS = 90_000;
const overrides = new Map<string, Map<string, { value: string; at: number }>>();

export function remember(id: string, values: Record<string, unknown>) {
  const m = overrides.get(id) ?? new Map();
  for (const [k, v] of Object.entries(values)) m.set(k, { value: String(v), at: Date.now() });
  overrides.set(id, m);
}

export function withOverrides(d: Device): Device {
  const m = overrides.get(d.id);
  if (!m) return d;
  const points = { ...d.points };
  for (const [k, o] of m) {
    if (Date.now() - o.at > OVERRIDE_MS) { m.delete(k); continue; }
    if (points[k]) points[k] = { ...points[k], value: o.value };
  }
  return { ...d, points };
}

// ---------- helpers de presentación compartidos ----------
export const isBulb = (d: Device) => d.model.toUpperCase().startsWith('SLB');
export const val = (d: Device, k: string) => d.points[k]?.value ?? null;
export const isOn = (d: Device) => val(d, 'power_onoff') === 'true';
export const has = (d: Device, k: string) => k in d.points;

export function rgbHex(n: number) { return '#' + (n & 0xffffff).toString(16).padStart(6, '0'); }
export function hexRgbInt(hex: string) { return parseInt(hex.replace('#', ''), 16) & 0xffffff; }

/** Modo actual de un bombillo. work_mode: 1 blanco, 2 color, 3 escena, 4 DIY; warm_switch=true fuerza blanco. */
export type Mode = 'white' | 'color' | 'scene';
export function mode(d: Device): Mode {
  const wm = val(d, 'work_mode');
  if (wm === '3' || wm === '4') return 'scene';
  if (val(d, 'warm_switch') === 'true' || wm === '1') return 'white';
  return 'color';
}

/** Color con el que "brilla" la tarjeta según el modo. */
export function glow(d: Device): string | null {
  if (!isOn(d)) return null;
  if (!isBulb(d)) return '#34d399'; // enchufe: verde (= --ok), en literal porque se mezcla con color-mix
  const m = mode(d);
  if (m === 'white') return '#ffd59a';
  if (m === 'scene') return '#b18cff';
  const c = Number(val(d, 'color_data'));
  return Number.isFinite(c) && c > 0 ? rgbHex(c) : '#ffd59a';
}
