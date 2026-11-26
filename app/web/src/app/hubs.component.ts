import { Component, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, Hub, HubCode } from './api.service';
import { config } from './config';
import { flashMicroPython, pickPort, usbSupported, writeFiles } from './usb-installer';

/** Placas ESP32: puente Bluetooth para aparatos sin nube (abanico ZhiMei, tira ELK-BLEDOM). */
@Component({
  selector: 'app-hubs',
  standalone: true,
  imports: [FormsModule, RouterLink],
  styleUrl: './device.component.css',
  styles: [`.code{margin:4px 0;font-size:40px;font-weight:700;letter-spacing:6px;text-align:center;font-variant-numeric:tabular-nums}
    .usb{display:flex;flex-direction:column;gap:10px}
    .check{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--muted)}
    details{color:var(--muted);font-size:14px} details .field{margin-top:8px}
    .steps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px;line-height:1.5}`],
  template: `
<main class="page">
  <nav class="top">
    <a routerLink="/" class="back" aria-label="Volver">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <div class="title"><h1>Placas ESP32</h1>
      <p class="sub">Para el abanico y la tira LED, que no tienen nube</p></div>
  </nav>

  @if (code(); as c) {
    <section class="panel">
      <h2>Configura «{{ nameOf(c.id) }}»</h2>
      <p class="code" aria-label="Código">{{ c.code.slice(0, 3) }} {{ c.code.slice(3) }}</p>
      <ol class="steps">
        <li>Enchufa la placa. Si ya estaba configurada, mantén su botón <strong>BOOT</strong> 5 segundos.</li>
        <li>En el teléfono, conéctate a la red Wi-Fi <strong>NotVontEG-…</strong>. Se abre una página sola.</li>
        <li>Elige tu Wi-Fi, escribe su contraseña y este código. Vence en {{ c.minutes }} minutos.</li>
      </ol>
      <p class="note">¿En una computadora con Chrome? También puedes configurarla por cable USB más abajo.</p>
      <button class="btn ghost wide" (click)="code.set(null)">Cerrar</button>
    </section>
  }

  @for (h of hubs(); track h.id) {
    <section class="panel list">
      <div class="item">
        <div><strong>{{ h.name }}</strong>
          <span>@if (h.online) {En línea} @else {Sin conexión{{ h.lastSeen ? ' · vista ' + ago(h.lastSeen) : ' · nunca se ha conectado' }}}</span></div>
        <div class="row2">
          <button class="btn ghost" [disabled]="busy()" (click)="newCode(h)">Configurar</button>
          <button class="btn ghost" [disabled]="busy()" (click)="remove(h)">Quitar</button>
        </div>
      </div>
      @for (d of h.devices; track d.id) {
        <a class="item" [routerLink]="['/device', d.id]">
          <div><strong>{{ d.name }}</strong><span>{{ d.kind === 'fan' ? 'Abanico' : 'Tira LED' }}</span></div>
          <span class="val">›</span>
        </a>
      }
    </section>

    <section class="panel">
      <h2>Agregar a {{ h.name }}</h2>
      <div class="seg">
        <button [class.active]="kind() === 'fan'" (click)="kind.set('fan')">Abanico</button>
        <button [class.active]="kind() === 'strip'" (click)="kind.set('strip')">Tira LED</button>
      </div>
      <form class="rename" (ngSubmit)="add(h)">
        <input class="field" name="n" [(ngModel)]="devName" maxlength="64" required
               [placeholder]="kind() === 'fan' ? 'Abanico de la sala' : 'Tira del cuarto'" aria-label="Nombre">
        @if (kind() === 'strip') {
          @if (h.seen.length) {
            <select class="field" name="mac" [(ngModel)]="mac" required aria-label="Tira">
              <option value="" disabled>Elige la tira</option>
              @for (m of h.seen; track m) { <option [value]="m">{{ m }}</option> }
            </select>
          } @else {
            <p class="note">La placa no ve ninguna tira cerca. Enchúfala, cierra su app en el teléfono y reinicia la placa.</p>
          }
        } @else {
          <input class="field" name="rid" [(ngModel)]="remoteId" maxlength="4"
                 placeholder="Id de control (opcional, si ya estaba emparejado)" aria-label="Id de control">
        }
        <button class="btn" type="submit" [disabled]="busy() || !devName.trim() || (kind() === 'strip' && !mac)">Agregar</button>
      </form>
      @if (kind() === 'fan') {
        <p class="note">Después ábrelo y usa <strong>Ajustes → Emparejar</strong>.</p>
      }
    </section>
  }

  <section class="panel">
    <h2>Nueva placa</h2>
    <form class="rename" (ngSubmit)="create()">
      <input class="field" name="hub" [(ngModel)]="hubName" maxlength="64" placeholder="Placa de la sala" required aria-label="Nombre de la placa">
      <button class="btn" type="submit" [disabled]="busy() || !hubName.trim()">Crear</button>
    </form>
    <p class="note">La placa debe quedar cerca de la tira (2–3 m): con señal débil la tira no acepta la conexión.
      El abanico tolera más distancia.</p>
  </section>

  @if (usb && hubs().length) {
    <section class="panel">
      <h2>Configurar por cable USB</h2>
      <p class="note">Conecta la placa a esta computadora. Sirve también para una placa nueva: instala el programa.
        La contraseña del Wi-Fi va directo a la placa por el cable.</p>
      <form class="usb" (ngSubmit)="install()">
        <select class="field" name="hub" [(ngModel)]="usbHub" required aria-label="Placa">
          @for (h of hubs(); track h.id) { <option [ngValue]="h.id">{{ h.name }}</option> }
        </select>
        <input class="field" name="ssid" [(ngModel)]="ssid" required placeholder="Nombre del Wi-Fi (2.4 GHz)" autocomplete="off" aria-label="Nombre del Wi-Fi">
        <input class="field" name="wpass" [(ngModel)]="wifiPass" type="password" placeholder="Contraseña del Wi-Fi" autocomplete="off" aria-label="Contraseña del Wi-Fi">
        <label class="check"><input type="checkbox" name="fw" [(ngModel)]="withFirmware"> Instalar el programa (placa nueva o reinstalar; borra la placa)</label>
        <details><summary>Avanzado</summary>
          <input class="field" name="server" [(ngModel)]="server" required aria-label="Servidor"></details>
        <button class="btn wide" type="submit" [disabled]="!!usbStep() || !ssid.trim() || !usbHub" [attr.aria-busy]="!!usbStep()">
          @if (usbStep()) {<span class="spin" aria-hidden="true"></span>{{ usbStep() }}} @else {Conectar e instalar}</button>
      </form>
    </section>
  }

  @if (toast()) { <div class="toast" role="status">{{ toast() }}</div> }
</main>`,
})
export class HubsComponent implements OnDestroy {
  hubs = signal<Hub[]>([]);
  busy = signal(false);
  toast = signal('');
  code = signal<HubCode | null>(null);
  kind = signal<'fan' | 'strip'>('fan');
  hubName = '';
  devName = '';
  mac = '';
  remoteId = '';

  // la placa se configura desde otro aparato: revisar seguido para ver cuándo queda en línea
  private poll = setInterval(() => this.load(true), 5000);

  // instalador USB
  readonly usb = usbSupported();
  usbStep = signal('');
  usbHub: number | null = null;
  ssid = '';
  wifiPass = '';
  withFirmware = true;
  /** Dirección completa del API tal como la verá la placa (no sirve "localhost": usa la IP o el dominio). */
  server = new URL(config.apiUrl, location.href).href.replace(/\/$/, '');

  constructor(private api: Api) { this.load(); }

  async install() {
    let port;
    try { port = await pickPort(); } catch { return; } // el usuario cerró el selector
    const hubId = this.usbHub!;
    try {
      this.usbStep.set('Preparando…');
      const code = await new Promise<HubCode>((ok, ko) => this.api.hubCode(hubId).subscribe({ next: ok, error: ko }));
      if (this.withFirmware) {
        this.usbStep.set('Instalando programa…');
        await flashMicroPython(port, pct => this.usbStep.set(`Instalando programa… ${pct}%`));
        await new Promise(r => setTimeout(r, 3000)); // primer arranque de MicroPython
      }
      const [main, setup, screen, ssd1306] = await Promise.all(
        ['esp32/main.py', 'esp32/setup.py', 'esp32/screen.py', 'esp32/ssd1306.py'].map(u => fetch(u).then(r => {
        if (!r.ok) throw new Error('No se pudo descargar ' + u);
        return r.text();
      })));
      const cfg = JSON.stringify({ ssid: this.ssid.trim(), password: this.wifiPass, server: this.server.trim(), code: code.code });
      await writeFiles(port, { 'ssd1306.py': ssd1306, 'screen.py': screen, 'setup.py': setup, 'main.py': main, 'config.json': cfg },
        m => this.usbStep.set(m));
      this.wifiPass = '';
      this.code.set(code); // muestra el código y avisa cuando la placa se conecte
      this.flash('Listo: la placa se reinicia y se conecta');
    } catch (e) {
      this.flash(e instanceof Error ? e.message : 'No se pudo instalar');
    } finally {
      this.usbStep.set('');
    }
  }
  ngOnDestroy() { clearInterval(this.poll); }

  load(quiet = false) {
    this.api.hubs().subscribe({
      next: h => {
        if (this.usbHub === null && h.length) this.usbHub = h[0].id;
        const c = this.code();
        const now = h.find(x => x.id === c?.id);
        // la placa canjeó el código y ya pidió órdenes: conectada
        if (c && now && !now.pending && now.online) {
          this.code.set(null);
          this.flash(`¡${now.name} conectada!`);
        }
        this.hubs.set(h);
      },
      error: () => { if (!quiet) this.flash('No se pudieron cargar las placas'); },
    });
  }

  create() {
    this.busy.set(true);
    this.api.createHub(this.hubName.trim()).subscribe({
      next: r => { this.busy.set(false); this.hubName = ''; this.code.set(r); this.load(); },
      error: e => this.fail(e, 'No se pudo crear la placa'),
    });
  }

  newCode(h: Hub) {
    this.busy.set(true);
    this.api.hubCode(h.id).subscribe({
      next: r => { this.busy.set(false); this.code.set(r); },
      error: e => this.fail(e, 'No se pudo generar el código'),
    });
  }

  nameOf(id: number) { return this.hubs().find(h => h.id === id)?.name ?? 'la placa'; }

  add(h: Hub) {
    this.busy.set(true);
    const body = this.kind() === 'fan'
      ? { kind: 'fan' as const, name: this.devName.trim(), remoteId: this.remoteId.trim() || undefined }
      : { kind: 'strip' as const, name: this.devName.trim(), mac: this.mac };
    this.api.addHubDevice(h.id, body).subscribe({
      next: () => { this.busy.set(false); this.devName = ''; this.mac = ''; this.remoteId = ''; this.flash('Agregado'); this.load(); },
      error: e => this.fail(e, 'No se pudo agregar'),
    });
  }

  remove(h: Hub) {
    if (!confirm(`¿Quitar la placa "${h.name}" y sus ${h.devices.length} aparatos?`)) return;
    this.busy.set(true);
    this.api.deleteHub(h.id).subscribe({
      next: () => { this.busy.set(false); this.load(); },
      error: e => this.fail(e, 'No se pudo quitar'),
    });
  }

  ago(iso: string) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
  }

  private fail(e: { error?: { error?: string } }, msg: string) { this.busy.set(false); this.flash(e.error?.error ?? msg); }
  private flash(m: string) { this.toast.set(m); setTimeout(() => this.toast.set(''), 2800); }
}
