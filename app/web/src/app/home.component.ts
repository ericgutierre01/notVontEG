import { Component, OnDestroy, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, Device, glow, isBulb, isOn, remember, val, withOverrides } from './api.service';
import { DeviceIcon } from './device-icon.component';
import { DisclaimerComponent } from './disclaimer.component';
import { canPrompt, isIosSafari, isStandalone, promptInstall } from './install';

const readFlag = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const writeFlag = (k: string) => { try { localStorage.setItem(k, '1'); } catch { /* modo privado */ } };

/** Correo de la cuenta, leído del JWT de sesión. Solo para mostrar. */
function accountName(): string {
  try {
    const p = (localStorage.getItem('vont_token') ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(p));
    // .NET escribe ClaimTypes.Name con su URI larga, no como unique_name
    return c.unique_name ?? c['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ?? '';
  } catch { return ''; }
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, DeviceIcon, DisclaimerComponent],
  template: `
<main class="page">
  <header>
    <div>
      <p class="eyebrow">{{ greeting }}</p>
      <h1>Mi casa</h1>
    </div>
    <div class="actions">
    <a class="icon-btn add" routerLink="/add" aria-label="Agregar aparato" title="Agregar aparato">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </a>
    <div class="profile">
      <button class="icon-btn avatar" (click)="menu.set(!menu())" aria-label="Perfil" title="Perfil"
              [attr.aria-expanded]="menu()">@if (photo()) { <img [src]="photo()" alt="" (error)="photoBroken.set(true)"> } @else { {{ initial() }} }</button>
      @if (menu()) {
        <div class="scrim" (click)="menu.set(false)"></div>
        <div class="menu" role="menu">
          <div class="who">
            <span class="avatar lg">@if (photo()) { <img [src]="photo()" alt="" (error)="photoBroken.set(true)"> } @else { {{ initial() }} }</span>
            <div><strong>{{ name() || 'Mi cuenta Vont' }}</strong><span>{{ email() }}</span></div>
          </div>
          @if (editing()) {
            <form class="nick" (submit)="$event.preventDefault(); saveName(nick.value)">
              <label for="nick">Nombre (el correo no se puede cambiar)</label>
              <input #nick id="nick" class="field" [value]="name()" maxlength="32" autocomplete="nickname" required>
              <div class="nick-actions">
                <button type="button" class="menu-item" (click)="editing.set(false); nameError.set('')">Cancelar</button>
                <button type="submit" class="btn" [disabled]="savingName()">{{ savingName() ? 'Guardando…' : 'Guardar' }}</button>
              </div>
              @if (nameError()) { <p class="nick-err" role="alert">{{ nameError() }}</p> }
            </form>
          } @else {
            <label class="menu-item" role="menuitem" [class.busy]="savingPhoto()">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              {{ savingPhoto() ? 'Subiendo foto…' : 'Cambiar foto' }}
              <input type="file" accept="image/*" hidden [disabled]="savingPhoto()" (change)="pickPhoto($event)">
            </label>
            @if (photoError()) { <p class="nick-err pad" role="alert">{{ photoError() }}</p> }
            <button class="menu-item" role="menuitem" (click)="editing.set(true)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              Cambiar nombre
            </button>
          }
          @if (installable()) {
            <button class="menu-item" role="menuitem" (click)="install(); menu.set(false)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
              Instalar app
            </button>
          }
          <button class="menu-item danger" role="menuitem" (click)="api.logout()">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
            Cerrar sesión
          </button>
        </div>
      }
    </div>
    </div>
  </header>

  @if (installable() && !installDismissed()) {
    <div class="install-banner">
      <img src="icons/icon-192.png" alt="" width="40" height="40">
      <div><strong>Instala Not Vont EG</strong><span>Ábrela desde tu pantalla de inicio, como una app.</span></div>
      <button class="btn" (click)="install()">Instalar</button>
      <button class="x" (click)="dismissInstall()" aria-label="Cerrar">×</button>
    </div>
  }

  @if (iosHelp()) {
    <div class="scrim dim" (click)="iosHelp.set(false)"></div>
    <div class="sheet" role="dialog" aria-label="Instalar en iPhone">
      <h2>Instalar en iPhone</h2>
      <ol>
        <li>Toca <strong>Compartir</strong>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>
          en la barra de Safari.</li>
        <li>Elige <strong>Agregar a inicio</strong>.</li>
        <li>Toca <strong>Agregar</strong>. Ábrela desde el ícono nuevo.</li>
      </ol>
      <button class="btn" (click)="iosHelp.set(false)">Entendido</button>
    </div>
  }

  @if (devices().length) {
    <section class="summary">
      <div><strong>{{ onCount() }}</strong><span>encendidos</span></div>
      <div><strong>{{ onlineCount() }}/{{ devices().length }}</strong><span>en línea</span></div>
      <button class="btn ghost all-off" (click)="allOff()" [disabled]="!onCount()">Apagar todo</button>
    </section>
  }

  @if (loading() && !devices().length) {
    <div class="grid">@for (i of [1,2,3,4]; track i) { <div class="card skeleton"></div> }</div>
  } @else if (error()) {
    <div class="empty"><p>{{ error() }}</p><button class="btn ghost" (click)="load()">Reintentar</button></div>
  } @else {
    <div class="grid">
      @for (d of devices(); track d.id) {
        <a class="card" [class.on]="on(d)" [class.offline]="!d.online" [routerLink]="['/device', d.id]"
           [style.--glow]="glowOf(d)">
          <div class="row">
            <span class="ico"><device-icon [bulb]="bulb(d)" /></span>
            <button class="switch" [class.on]="on(d)" [disabled]="!d.online || busy().has(d.id)" [attr.aria-busy]="busy().has(d.id)"
                    (click)="toggle(d, $event)" [attr.aria-label]="(on(d) ? 'Apagar ' : 'Encender ') + d.name"></button>
          </div>
          <div class="name">{{ d.name }}</div>
          <div class="status">
            @if (!d.online) { <span class="dot off"></span>Sin conexión }
            @else if (on(d)) { <span class="dot ok"></span>Encendido{{ bulb(d) ? ' · ' + bright(d) + '%' : '' }} }
            @else { <span class="dot idle"></span>Apagado }
          </div>
        </a>
      }
    </div>
    <p class="hint">Toca un aparato para ver todas sus funciones. Se actualiza solo cada 20 s.</p>
    <app-disclaimer />
  }

  @if (toast()) { <div class="toast" role="status">{{ toast() }}</div> }
</main>`,
  styles: [`
    .page{max-width:880px;margin:0 auto;padding:max(20px,env(safe-area-inset-top)) 16px 40px}
    header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px}
    .eyebrow{margin:0;color:var(--muted);font-size:14px}
    h1{margin:2px 0 0;font-size:32px;letter-spacing:-.8px}
    .actions{display:flex;gap:8px}
    .icon-btn{width:44px;height:44px;border-radius:14px;border:1px solid var(--border);background:var(--surface);
      display:grid;place-items:center;cursor:pointer;color:var(--muted)}
    .icon-btn.add{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border:none}
    .actions{gap:12px}
    .profile{position:relative}
    .avatar{font-weight:700;font-size:17px;color:var(--text);border-radius:50%;overflow:hidden}
    .nick{display:flex;flex-direction:column;gap:8px;padding:6px 10px 10px}
    .nick label{font-size:12px;color:var(--muted)}
    .nick-actions{display:flex;gap:8px;justify-content:flex-end}
    .nick-actions .menu-item{width:auto}
    .nick-actions .btn{padding:10px 16px;min-height:auto}
    .nick-err{margin:0;color:var(--danger);font-size:13px}
    .nick-err.pad{padding:0 10px 6px}
    label.menu-item{cursor:pointer}
    label.menu-item.busy{opacity:.6;cursor:progress}
    .avatar img{width:100%;height:100%;object-fit:cover;display:block}
    .scrim{position:fixed;inset:0;z-index:20}
    .menu{position:absolute;right:0;top:52px;z-index:21;min-width:250px;background:var(--surface);
      border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);padding:8px}
    .who{display:flex;align-items:center;gap:12px;padding:10px 10px 12px;border-bottom:1px solid var(--border);margin-bottom:6px}
    .who div{display:flex;flex-direction:column;min-width:0}
    .who span{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .avatar.lg{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none;
      background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700}
    .menu-item{width:100%;display:flex;align-items:center;gap:10px;padding:12px 10px;border:none;background:none;
      border-radius:12px;cursor:pointer;font-weight:600;text-align:left}
    .menu-item:hover{background:var(--surface-2)}
    .menu-item.danger{color:var(--danger)}
    .install-banner{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);
      border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:14px}
    .install-banner img{border-radius:10px;flex:none}
    .install-banner div{display:flex;flex-direction:column;flex:1;min-width:0}
    .install-banner span{font-size:13px;color:var(--muted)}
    .install-banner .btn{padding:9px 14px}
    .install-banner .x{border:none;background:none;color:var(--muted);font-size:22px;cursor:pointer;padding:4px 6px}
    .scrim.dim{background:rgba(0,0,0,.45);z-index:30}
    .sheet{position:fixed;left:0;right:0;bottom:0;z-index:31;background:var(--surface);border-radius:24px 24px 0 0;
      padding:22px 20px calc(20px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px;
      max-width:560px;margin:0 auto;box-shadow:var(--shadow)}
    .sheet h2{margin:0;font-size:19px}
    .sheet ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px;line-height:1.5}
    .sheet svg{vertical-align:-3px;margin:0 2px}
    .summary{display:flex;gap:10px;align-items:stretch;margin-bottom:16px}
    .summary>div{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);
      padding:10px 14px;display:flex;flex-direction:column;min-width:96px}
    .summary strong{font-size:20px}
    .summary span{font-size:12px;color:var(--muted)}
    .all-off{margin-left:auto;padding:10px 16px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
    .card{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:6px;padding:16px;
      min-height:150px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--border);
      color:inherit;text-decoration:none;transition:transform .15s ease, border-color .2s}
    .card:active{transform:scale(.98)}
    .card.on{border-color:color-mix(in srgb, var(--glow, var(--ok)) 45%, transparent)}
    .card.on::before{content:"";position:absolute;inset:-40% -40% auto auto;width:180px;height:180px;border-radius:50%;
      background:var(--glow, transparent);opacity:.28;filter:blur(40px);pointer-events:none}
    .card.offline{opacity:.6}
    .row{display:flex;justify-content:space-between;align-items:flex-start;position:relative}
    .ico{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--surface-2);
      color:var(--muted)}
    .card.on .ico{background:color-mix(in srgb, var(--glow, var(--ok)) 22%, var(--surface-2));color:var(--glow, var(--ok))}
    .name{margin-top:auto;font-weight:600;font-size:16px;position:relative}
    .status{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px;position:relative}
    .dot{width:7px;height:7px;border-radius:50%}
    .dot.ok{background:var(--ok)} .dot.idle{background:var(--faint)} .dot.off{background:var(--danger)}
    .skeleton{animation:pulse 1.4s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.5}}
    .empty{text-align:center;color:var(--muted);padding:48px 0}
    .hint{color:var(--faint);font-size:12px;text-align:center;margin-top:22px}
  `],
})
export class HomeComponent implements OnDestroy {
  devices = signal<Device[]>([]);
  loading = signal(true);
  error = signal('');
  busy = signal(new Set<string>());
  toast = signal('');
  menu = signal(false);
  iosHelp = signal(false);
  installDismissed = signal(readFlag('install-dismissed'));
  /** Mostrar "Instalar": Android con aviso disponible, o Safari de iPhone, y aún no instalada. */
  installable = computed(() => !isStandalone() && (canPrompt() || isIosSafari()));

  async install() {
    if (canPrompt()) await promptInstall();
    else this.iosHelp.set(true);
  }
  dismissInstall() { this.installDismissed.set(true); writeFlag('install-dismissed'); }
  // Del JWT al instante; nombre y foto llegan de Topband (/api/me) un momento después
  email = signal(accountName());
  name = signal('');
  private photoUrl = signal('');
  photoBroken = signal(false);
  editing = signal(false);
  savingPhoto = signal(false);
  photoError = signal('');
  savingName = signal(false);
  nameError = signal('');
  photo = computed(() => this.photoBroken() ? '' : this.photoUrl());
  initial = computed(() => ((this.name() || this.email())[0] ?? 'V').toUpperCase());
  onCount = computed(() => this.devices().filter(d => d.online && isOn(d)).length);
  onlineCount = computed(() => this.devices().filter(d => d.online).length);
  greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; })();
  private timer = setInterval(() => this.load(true), 20000);

  constructor(public api: Api) {
    this.load();
    api.me().subscribe({
      next: p => { if (p.email) this.email.set(p.email); this.name.set(p.name ?? ''); this.photoUrl.set(p.photo ?? ''); },
      error: () => { /* sin perfil: se queda con correo e inicial */ },
    });
  }
  /** Recorta al centro en cuadrado, achica a 512 px y sube como JPEG (lo mismo que hace la app al recortar). */
  async pickPhoto(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.photoError.set(''); this.savingPhoto.set(true);
    try {
      const bmp = await createImageBitmap(file);
      const side = Math.min(bmp.width, bmp.height), size = Math.min(512, side);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
      bmp.close();
      const b64 = canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
      this.api.setPhoto(b64).subscribe({
        next: r => { this.photoBroken.set(false); this.photoUrl.set(r.photo ?? ''); this.savingPhoto.set(false); },
        error: e => { this.savingPhoto.set(false); this.photoError.set(e.error?.error ?? 'No se pudo subir la foto.'); },
      });
    } catch {
      this.savingPhoto.set(false);
      this.photoError.set('No se pudo leer esa imagen. Prueba con una JPG o PNG.');
    }
  }

  saveName(value: string) {
    const v = value.trim();
    if (!v) { this.nameError.set('Escribe un nombre.'); return; }
    this.savingName.set(true); this.nameError.set('');
    this.api.setNickname(v).subscribe({
      next: r => { this.name.set(r.name); this.savingName.set(false); this.editing.set(false); },
      error: e => { this.savingName.set(false); this.nameError.set(e.error?.error ?? 'No se pudo guardar.'); },
    });
  }
  ngOnDestroy() { clearInterval(this.timer); }

  on = isOn; bulb = isBulb;
  glowOf = (d: Device) => glow(d) ?? 'var(--ok)';
  bright = (d: Device) => val(d, 'brightness') ?? '100';

  load(silent = false) {
    if (!silent) this.loading.set(true);
    this.api.devices().subscribe({
      next: r => { this.devices.set(r.devices.map(withOverrides)); this.loading.set(false); this.error.set(''); },
      error: e => { this.loading.set(false); if (e.status !== 401 && !silent) this.error.set('No se pudieron cargar tus aparatos.'); },
    });
  }

  private patch(id: string, value: string) {
    this.devices.update(ds => ds.map(d => d.id !== id ? d : {
      ...d, points: { ...d.points, power_onoff: { ...d.points['power_onoff'], value } } }));
  }

  toggle(d: Device, ev: Event) {
    ev.preventDefault(); ev.stopPropagation();
    const next = !isOn(d);
    this.patch(d.id, String(next));
    this.busy.update(s => new Set(s).add(d.id));
    this.api.setDp(d.id, { power_onoff: next }).subscribe({
      next: () => { remember(d.id, { power_onoff: next }); this.done(d.id); },
      error: () => { this.patch(d.id, String(!next)); this.done(d.id); this.flash('No se pudo cambiar ' + d.name); },
    });
  }

  allOff() {
    for (const d of this.devices().filter(x => x.online && isOn(x))) {
      this.patch(d.id, 'false');
      this.busy.update(s => new Set(s).add(d.id)); // su interruptor queda en espera hasta que responda
      this.api.setDp(d.id, { power_onoff: false }).subscribe({
        next: () => { this.done(d.id); remember(d.id, { power_onoff: false }); },
        error: () => { this.done(d.id); this.flash('Falló apagar ' + d.name); },
      });
    }
  }

  private done(id: string) { this.busy.update(s => { const n = new Set(s); n.delete(id); return n; }); }
  private flash(m: string) { this.toast.set(m); setTimeout(() => this.toast.set(''), 2800); }
}
