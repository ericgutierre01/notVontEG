// Protocolo Bluetooth de emparejamiento de Vont/Topband (ver vont-alexa-bridge/BLE_PAIRING.md).
// Paquete big-endian: AA55 | longitud total | serial | flag (80 petición / 40 ack) | cmd | payload | checksum.

export const SERVICE = 0xffe0;
export const CHAR = 0xffe1;
export const COMPANY_ID = 0x4254;            // "TB" en los datos de fabricante del anuncio
export const MQTT_HOST = 'us-tsmart-mqtt.topband-cloud.com:8883';
export const CMD = { TIME: 135, BROKER: 13, WIFI: 121 } as const;

const enc = new TextEncoder();

export function pack(cmd: number, payload: Uint8Array, serial: number, flag = 0x80): Uint8Array {
  const len = payload.length + 9;
  const p = new Uint8Array(len);
  p.set([0xaa, 0x55, len >> 8, len & 0xff, serial >> 8, serial & 0xff, flag, cmd]);
  p.set(payload, 8);
  let sum = 0;
  for (let i = 0; i < len - 1; i++) sum += p[i];
  p[len - 1] = (sum ^ 0x33) & 0xff;
  return p;
}

export interface Packet { serial: number; flag: number; cmd: number; payload: Uint8Array; }

export function parse(b: Uint8Array): Packet | null {
  if (b.length < 9 || b[0] !== 0xaa || b[1] !== 0x55) return null;
  const len = (b[2] << 8) | b[3];
  if (len !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < len - 1; i++) sum += b[i];
  if (((sum ^ 0x33) & 0xff) !== b[len - 1]) return null;
  return { serial: (b[4] << 8) | b[5], flag: b[6], cmd: b[7], payload: b.slice(8, len - 1) };
}

export const timePayload = (epochSec: number, offsetSec: number) => {
  const p = new Uint8Array(8), v = new DataView(p.buffer);
  v.setUint32(0, epochSec >>> 0); v.setInt32(4, offsetSec);
  return p;
};

export function wifiPayload(ssid: string, password: string): Uint8Array {
  const s = enc.encode(ssid), k = enc.encode(password);
  if (s.length > 32) throw new Error('El nombre de la red Wi-Fi es demasiado largo');
  if (k.length > 64) throw new Error('La contraseña del Wi-Fi es demasiado larga');
  return Uint8Array.from([s.length, ...s, k.length, ...k]);
}

export const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Datos del anuncio Bluetooth: tipo de producto, MAC y si está en modo emparejamiento. */
export interface AdInfo { productCode: number; mac: string; pairing: boolean; }

export function parseAd(view: DataView): AdInfo | null {
  if (view.byteLength < 11) return null;
  const mac = Array.from({ length: 6 }, (_, i) => view.getUint8(4 + i).toString(16).padStart(2, '0')).join('');
  return { productCode: view.getUint32(0), mac, pairing: (view.getUint8(10) & 0x10) !== 0 };
}

/** Tamaño de cada escritura: 20 bytes = MTU mínimo de BLE (23) menos la cabecera ATT. */
export const CHUNK = 20;
export function chunks(b: Uint8Array, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n));
  return out.length ? out : [b];
}

/** Conexión GATT con el aparato: envía comandos, contesta acks y espera respuestas. */
export class VontBle {
  private ch: any;
  private serial = 0xffff;
  private waiters = new Map<number, (p: Packet) => void>();

  constructor(private device: any) {}

  async connect() {
    this.device.addEventListener('gattserverdisconnected', () => console.info('[ble] desconectado', new Date().toISOString()));
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    this.ch = await svc.getCharacteristic(CHAR);
    this.ch.addEventListener('characteristicvaluechanged', (e: any) => this.onData(e.target.value as DataView));
    await this.ch.startNotifications();
  }

  get connected(): boolean { return !!this.device.gatt?.connected; }

  disconnect() { try { this.device.gatt?.disconnect(); } catch { /* ya desconectado */ } }

  private nextSerial() { const s = this.serial; this.serial = this.serial <= 1 ? 0xffff : this.serial - 1; return s; }

  /** Trocear en 20 bytes: solo si el paquete entero falla (el aparato puede no juntar los trozos). */
  chunked = false;

  // Una escritura a la vez (Chrome falla si se cruzan dos). Como la app (MTU 250), primero el paquete entero;
  // si Chrome/el aparato lo rechaza, en trozos de 20 bytes con 20 ms entre ellos.
  private queue: Promise<unknown> = Promise.resolve();
  private write(b: Uint8Array) {
    const one = (part: Uint8Array) => this.ch.properties?.write
      ? this.ch.writeValueWithResponse(part) : this.ch.writeValueWithoutResponse(part);
    const run = this.queue.then(async () => {
      if (!this.chunked || b.length <= CHUNK) {
        try { return await one(b); } catch (e: any) {
          console.info('[ble] falló escritura entera de', b.length, 'bytes:', e?.message);
          if (b.length <= CHUNK || !this.connected) throw e;
          this.chunked = true;
        }
      }
      for (const part of chunks(b, CHUNK)) { await one(part); await new Promise(r => setTimeout(r, 20)); }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  send(cmd: number, payload: Uint8Array) { return this.write(pack(cmd, payload, this.nextSerial())); }

  waitFor(cmd: number, ms: number): Promise<Packet | null> {
    return new Promise(res => {
      const t = setTimeout(() => { this.waiters.delete(cmd); res(null); }, ms);
      this.waiters.set(cmd, p => { clearTimeout(t); res(p); });
    });
  }

  private onData(v: DataView) {
    const p = parse(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (!p) return;
    if (p.flag === 0x80 && p.cmd !== 224 && p.cmd !== 225)
      this.write(pack(p.cmd, new Uint8Array(0), p.serial, 0x40)).catch(() => {});
    const w = this.waiters.get(p.cmd);
    if (w) { this.waiters.delete(p.cmd); w(p); }
  }
}

// Autoprueba contra los paquetes de ejemplo calculados del APK.
(() => {
  console.assert(toHex(pack(CMD.WIFI, wifiPayload('Casa', '12345678'), 0xfffd))
    === 'AA550017FFFD8079044361736108313233343536373800', 'ble wifi');
  console.assert(toHex(pack(CMD.TIME, timePayload(1793800000, -14400), 0xffff))
    === 'AA550011FFFF80876AEB3740FFFFC7C055', 'ble time');
  console.assert(chunks(new Uint8Array(45), CHUNK).map(c => c.length).join() === '20,20,5', 'ble chunks');
  console.assert(chunks(new Uint8Array(20), CHUNK).length === 1, 'ble chunk exacto');
  console.assert(toHex(pack(129, new Uint8Array(0), 0x0001, 0x40)) === 'AA55000900014081F9', 'ble ack');
  console.assert(parse(pack(CMD.BROKER, enc.encode(MQTT_HOST), 0xfffe))?.cmd === CMD.BROKER, 'ble parse');
})();

/** MAC de los aparatos que desvinculas, para volver a agregarlos sin buscar la etiqueta (va debajo del bombillo). */
export interface KnownMac { name: string; productId: string; mac: string; }
const REMOVED_KEY = 'notvont-removed';
export function removedMacs(): KnownMac[] {
  try { return JSON.parse(localStorage.getItem(REMOVED_KEY) ?? '[]'); } catch { return []; }
}
export function rememberRemoved(d: KnownMac) {
  try {
    const list = [d, ...removedMacs().filter(x => x.mac !== d.mac)].slice(0, 20);
    localStorage.setItem(REMOVED_KEY, JSON.stringify(list));
  } catch { /* modo privado */ }
}
/** Chrome solo deja leer la MAC del anuncio con "Experimental Web Platform features" activado. */
export const canReadAds = () =>
  typeof (globalThis as any).BluetoothDevice !== 'undefined' && 'watchAdvertisements' in (globalThis as any).BluetoothDevice.prototype;
