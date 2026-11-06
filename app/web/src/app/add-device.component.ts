import { Component, OnDestroy, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, Device } from './api.service';
import { AdInfo, CMD, COMPANY_ID, KnownMac, MQTT_HOST, SERVICE, VontBle, canReadAds, parseAd, removedMacs, timePayload, wifiPayload } from './ble';

type Step = 'type' | 'prepare' | 'identify' | 'pairing' | 'done' | 'fail';
interface LogLine { text: string; state: 'run' | 'ok' | 'err'; }
interface Product { productCode: number; productId: string; name: string; image: string | null; }

const WIFI_KEY = 'notvont-wifi';

/**
 * ¿Es real el "online" de la nube? Tras resetear el aparato, la nube lo sigue marcando en línea varios minutos
 * y no guarda cuándo se conectó. Vale si el aparato acusó recibo de la red (confirmó o cortó el Bluetooth al
 * recibirla), si antes se le vio offline, o si cambió su última comunicación.
 */
export const realOnline = (online: boolean, received: boolean, seenOffline: boolean, changed: string | null, base: string | null) =>
  online && (received || seenOffline || changed !== base);
console.assert(!realOnline(true, false, false, 'a', 'a') && realOnline(true, true, false, 'a', 'a') &&
  realOnline(true, false, true, 'a', 'a') && realOnline(true, false, false, 'b', 'a') && !realOnline(false, true, true, 'b', 'a'), 'realOnline');
const BULBS = [100108, 100223];

@Component({
  selector: 'app-add-device',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './add-device.component.html',
  styleUrl: './add-device.component.css',
})
export class AddDeviceComponent implements OnDestroy {
  supported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  /** Modo "Cambiar Wi-Fi": el aparato ya está en la cuenta; solo se le manda la red nueva (sin volver a vincular). */
  wifiMode: boolean;
  step = signal<Step>('type');
  log = signal<LogLine[]>([]);
  error = signal('');
  catalog = signal<Product[]>([]);
  target = signal<Device | null>(null);

  /** 0 = "no sé el modelo": se buscan todos */
  productCode = 0;
  private code = signal(0);
  product = computed(() => this.catalog().find(p => p.productCode === this.code()) ?? null);
  mac = '';
  ssid = ''; password = ''; showPass = false; remember = true;
  /** La red guardada se muestra resumida; "Cambiar" abre los campos */
  editWifi = signal(true);
  newDeviceId = signal<string | null>(null);
  /** Sin la opción experimental, Chrome no da la MAC: se avisa antes de buscar */
  readsMac = canReadAds();
  /** MACs que la app ya conoce (tus aparatos y los que desvinculaste), del tipo elegido */
  private accountMacs = signal<KnownMac[]>([]);
  knownMacs = computed(() => {
    const pid = this.product()?.productId;
    const all = [...removedMacs(), ...this.accountMacs()];
    return all.filter((k, i) => (!pid || k.productId === pid) && all.findIndex(x => x.mac === k.mac) === i);
  });

  private device: any = null;
  private ble: VontBle | null = null;
  private cancelled = false;

  constructor(private api: Api, private router: Router, route: ActivatedRoute) {
    this.wifiMode = route.snapshot.data['mode'] === 'wifi';
    const saved = this.loadWifi();
    if (saved) { this.ssid = saved.ssid; this.password = saved.password; this.editWifi.set(false); }

    this.api.catalog().subscribe(c => { this.catalog.set(c); this.syncTargetType(); });
    if (!this.wifiMode && !this.readsMac) {
      this.api.devices().subscribe({ next: r => this.accountMacs.set(r.devices
        .filter(d => d.mac).map(d => ({ name: d.name, productId: d.productId, mac: d.mac! }))), error: () => {} });
    }
    if (this.wifiMode) {
      this.step.set('prepare');
      this.api.device(route.snapshot.paramMap.get('id')!).subscribe({
        next: d => { this.target.set(d); this.mac = d.mac ?? ''; this.syncTargetType(); },
        error: () => this.error.set('No se pudo cargar el aparato.'),
      });
    }
  }

  ngOnDestroy() { this.cancelled = true; this.ble?.disconnect(); }

  /** En "Cambiar Wi-Fi" el tipo sale del aparato: así la búsqueda solo muestra ese tipo. */
  private syncTargetType() {
    const t = this.target();
    const p = t && this.catalog().find(x => x.productId === t.productId);
    if (p) this.choose(p.productCode, false);
  }

  choose(code: number, advance = true) {
    this.productCode = code; this.code.set(code);
    if (advance) { this.error.set(''); this.step.set('prepare'); }
  }

  isBulb() { return BULBS.includes(this.code()); }
  isPlug() { return this.code() !== 0 && !this.isBulb(); }

  // --- Wi-Fi recordado (como la app oficial). Se guarda solo en este navegador.
  private loadWifi(): { ssid: string; password: string } | null {
    try { return JSON.parse(localStorage.getItem(WIFI_KEY) ?? 'null'); } catch { return null; }
  }
  private saveWifi() {
    try {
      if (this.remember) localStorage.setItem(WIFI_KEY, JSON.stringify({ ssid: this.ssid, password: this.password }));
    } catch { /* modo privado */ }
  }
  forgetWifi() {
    try { localStorage.removeItem(WIFI_KEY); } catch { /* modo privado */ }
    this.ssid = ''; this.password = ''; this.editWifi.set(true);
  }

  /** Ventana de Chrome filtrada por el tipo elegido (código de producto al inicio de los datos del anuncio). */
  /** Texto del botón mientras busca/lee el aparato ('' = libre) */
  busy = signal('');

  async scan() {
    this.error.set('');
    this.busy.set('Elige tu aparato en la ventana de Chrome…');
    try { await this.scanInner(); } finally { this.busy.set(''); }
  }

  private async scanInner() {
    const byName = [{ namePrefix: 'Vont' }, { namePrefix: 'T-Smart_' }];
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, this.productCode);
    const byType = [{ manufacturerData: [{ companyIdentifier: COMPANY_ID, dataPrefix: prefix }] }];
    const opts = (filters: object[]) => ({ filters, optionalServices: [SERVICE], optionalManufacturerData: [COMPANY_ID] });
    try {
      try {
        this.device = await (navigator as any).bluetooth.requestDevice(opts(this.productCode ? byType : byName));
      } catch (e: any) {
        // Chrome viejo sin filtro por datos de fabricante: se busca por nombre
        if (e?.name !== 'TypeError') throw e;
        this.device = await (navigator as any).bluetooth.requestDevice(opts(byName));
      }
    } catch (e: any) {
      if (e?.name !== 'NotFoundError') this.error.set('No se pudo abrir la búsqueda Bluetooth: ' + (e?.message ?? e));
      return;
    }

    this.busy.set('Conectando con el aparato…');
    const ad = await this.readAd(this.device);
    if (this.wifiMode) {
      // Chrome no deja filtrar por MAC: si el anuncio se puede leer, se comprueba que sea el aparato correcto
      if (ad && this.mac && ad.mac !== this.mac) {
        this.error.set('Ese no es este aparato (su MAC es otra). Vuelve a buscar y elige el correcto.');
        return;
      }
      this.changeWifi();
    } else if (ad) {
      this.choose(ad.productCode, false);
      this.mac = ad.mac;
      this.pair();
    } else {
      this.step.set('identify'); // tu Chrome no deja leer la MAC del anuncio: hay que escribirla
    }
  }

  /** watchAdvertisements está tras una flag experimental en Chrome; sin ella no se puede leer la MAC. */
  private readAd(device: any): Promise<AdInfo | null> {
    if (typeof device.watchAdvertisements !== 'function') return Promise.resolve(null);
    return new Promise(resolve => {
      const done = (r: AdInfo | null) => { clearTimeout(t); device.removeEventListener('advertisementreceived', on); resolve(r); };
      const on = (ev: any) => { const v = ev.manufacturerData?.get(COMPANY_ID); if (v) done(parseAd(v)); };
      const t = setTimeout(() => done(null), 6000);
      device.addEventListener('advertisementreceived', on);
      device.watchAdvertisements().catch(() => done(null));
    });
  }

  private add(text: string): number { this.log.update(l => [...l, { text, state: 'run' }]); return this.log().length - 1; }
  private set(i: number, state: 'ok' | 'err', text?: string) {
    this.log.update(l => l.map((x, j) => j === i ? { text: text ?? x.text, state } : x));
  }
  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  /** Pasos por Bluetooth comunes a agregar y cambiar Wi-Fi: conectar → hora → [vincular] → broker → Wi-Fi. */
  /** Devuelve si el aparato acusó recibo del Wi-Fi. */
  private async sendWifi(bind?: () => Promise<void>): Promise<boolean> {
    let i = this.add('Conectando por Bluetooth…');
    this.ble = new VontBle(this.device);
    await this.ble.connect();
    this.set(i, 'ok', 'Conectado por Bluetooth');

    await this.sleep(1000);
    i = this.add('Sincronizando la hora…');
    await this.ble.send(CMD.TIME, timePayload(Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset() * 60));
    this.set(i, 'ok', 'Hora sincronizada');

    if (bind) await bind();

    await this.sleep(500);
    i = this.add(`Enviando la red ${this.ssid}…`);
    const sendBoth = async () => {
      await this.ble!.send(CMD.BROKER, new TextEncoder().encode(MQTT_HOST));
      await this.sleep(300);
      const wait = this.ble!.waitFor(CMD.WIFI, 10000);
      await this.ble!.send(CMD.WIFI, wifiPayload(this.ssid, this.password));
      return wait;
    };
    let ack = null;
    try {
      ack = await sendBoth();
      // Sin respuesta al paquete entero: se repite en trozos por si el aparato no lo recibió completo
      if (!ack && !this.ble.chunked && this.ble.connected) { this.ble.chunked = true; ack = await sendBoth(); }
    } catch (e: any) {
      // El aparato suele cortar el Bluetooth en cuanto recibe la red, para conectarse al Wi-Fi: se espera a que salga en línea
      if (this.ble.connected) throw e;
      console.info('[ble] el aparato cortó el Bluetooth al enviar el Wi-Fi:', e?.message);
      this.set(i, 'ok', 'El aparato recibió el Wi-Fi y cortó el Bluetooth para conectarse');
      return true;
    }
    console.info('[ble] Wi-Fi', ack ? 'confirmado' : 'sin confirmar', this.ble.chunked ? 'en trozos' : 'entero');
    this.set(i, 'ok', ack ? 'El aparato recibió el Wi-Fi' : 'Wi-Fi enviado (el aparato no confirmó, seguimos esperando)');
    return !!ack;
  }

  private async run(work: () => Promise<string>) {
    this.step.set('pairing'); this.log.set([]); this.error.set(''); this.cancelled = false;
    try {
      const id = await work();
      this.saveWifi(); // solo se recuerda una red con la que sí se conectó
      this.newDeviceId.set(id);
      this.ble?.disconnect();
      this.step.set('done');
    } catch (e: any) {
      this.log.update(l => l.map(x => x.state === 'run' ? { ...x, state: 'err' as const } : x));
      this.error.set(e?.error?.error ?? e?.message ?? String(e));
      this.ble?.disconnect();
      this.step.set('fail');
    }
  }

  /** Secuencia de la app oficial al agregar: conectar → hora → vincular en la nube → broker → Wi-Fi → esperar online. */
  pair() {
    let uid = '';
    return this.run(async () => {
      const received = await this.sendWifi(async () => {
        const i = this.add('Registrando el aparato en tu cuenta…');
        uid = (await firstValueFrom(this.api.bind(this.productCode, this.mac))).uid;
        this.set(i, 'ok', 'Registrado en tu cuenta');
      });
      return this.waitOnline(uid, received);
    });
  }

  /** Lo mismo que hace la app oficial en Ajustes → Wi-Fi: igual que agregar, pero sin volver a vincular. */
  changeWifi() {
    const d = this.target()!;
    return this.run(async () => { return this.waitOnline(d.uid, await this.sendWifi()); });
  }

  private async waitOnline(uid: string, received: boolean): Promise<string> {
    let seenOffline = false, base: string | null | undefined;
    const i = this.add('Esperando que se conecte a internet (hasta 2 min)…');
    const end = Date.now() + 120_000;
    while (Date.now() < end && !this.cancelled) {
      try {
        const { devices } = await firstValueFrom(this.api.devices());
        const d = devices.find(x => x.uid === uid);
        if (d && base === undefined) base = d.changed;
        if (d && !d.online) seenOffline = true;
        if (d && realOnline(d.online, received, seenOffline, d.changed, base ?? null)) { this.set(i, 'ok', '¡En línea!'); return d.id; }
      } catch { /* reintenta */ }
      await this.sleep(5000);
    }
    throw new Error('El aparato no apareció en línea. Revisa la contraseña y que la red sea de 2.4 GHz.');
  }

  copied = signal(false);
  async copyFlags() {
    try {
      await navigator.clipboard.writeText('chrome://flags/#enable-experimental-web-platform-features');
      this.copied.set(true); setTimeout(() => this.copied.set(false), 2500);
    } catch { /* sin permiso de portapapeles: el texto sigue en las instrucciones */ }
  }

  validMac() { return /^[0-9a-fA-F]{12}$/.test(this.mac.replace(/[:\-\s]/g, '')); }

  retry() { this.ble?.disconnect(); this.ble = null; this.step.set('prepare'); this.log.set([]); this.error.set(''); }

  back() { const d = this.target(); return d ? `/device/${d.id}` : '/'; }

  openNew() { const id = this.newDeviceId(); this.router.navigateByUrl(id ? `/device/${id}` : '/'); }
}
