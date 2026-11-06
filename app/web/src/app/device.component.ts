import { rememberRemoved } from './ble';
import { Component, OnDestroy, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  Api, Device, glow, has, hexRgbInt, isBulb, isOn, mode, remember, rgbHex, val, withOverrides,
} from './api.service';
import { DeviceIcon } from './device-icon.component';
import { PRESET_COLORS, SCENE_GROUPS } from './scenes';
import {
  BulbTimer, DAYS, PlugTimer, daysLabel, decodeBulbTimer, decodeCountdown, decodePlugTimer,
  encodeBulbTimer, encodeCountdown, encodePlugTimer, fromHHMM, toHHMM,
} from './timers';

type Tab = 'control' | 'scenes' | 'schedule' | 'settings';

@Component({
  selector: 'app-device',
  standalone: true,
  imports: [FormsModule, RouterLink, DeviceIcon],
  templateUrl: './device.component.html',
  styleUrl: './device.component.css',
})
export class DeviceComponent implements OnDestroy {
  id = input.required<string>();
  d = signal<Device | null>(null);
  tab = signal<Tab>('control');
  toast = signal('');
  error = signal('');

  // edición local (no se envía hasta "Guardar")
  bulbTimer = signal<BulbTimer>(decodeBulbTimer(null));
  plugTimer = signal<PlugTimer>(decodePlugTimer(null));
  countdownMin = signal(30);
  countdownOn = signal(false);
  editingName = signal(false);
  newName = '';
  confirmUnbind = signal(false);
  unbindName = '';
  now = signal(Date.now());

  readonly days = DAYS;
  readonly groups = SCENE_GROUPS;
  readonly presets = PRESET_COLORS;

  bulb = computed(() => !!this.d() && isBulb(this.d()!));
  on = computed(() => !!this.d() && isOn(this.d()!));
  online = computed(() => !!this.d()?.online);
  mode = computed(() => this.d() ? mode(this.d()!) : 'color');
  glow = computed(() => (this.d() && glow(this.d()!)) || 'transparent');
  brightness = computed(() => Number(this.v('brightness') ?? 100));
  color = computed(() => rgbHex(Number(this.v('color_data') ?? 0xffffff)));
  temp = computed(() => Number(this.v('temp_value') ?? 50));
  hasTemp = computed(() => !!this.d() && has(this.d()!, 'temp_value'));
  scene = computed(() => this.mode() === 'scene' ? Number(this.v('scence_id')) : null);
  vacation = computed(() => {
    const x = this.v('Vacation_mode') ?? this.v('vacation_mode');
    return x === 'true' || x === '1';
  });
  vacationKey = computed(() => this.d() && has(this.d()!, 'Vacation_mode') ? 'Vacation_mode' : 'vacation_mode');
  countdown = computed(() => decodeCountdown(this.v('Auto_message')));
  countdownLeft = computed(() => {
    const c = this.countdown();
    const left = c.endsAt * 1000 - this.now();
    return c.enabled && left > 0 ? left : 0;
  });
  signalBars = computed(() => {
    const s = this.d()?.signal ?? -100;
    return s > -55 ? 4 : s > -65 ? 3 : s > -75 ? 2 : 1;
  });
  tabs = computed<{ key: Tab; label: string }[]>(() => this.bulb()
    ? [{ key: 'control', label: 'Control' }, { key: 'scenes', label: 'Escenas' },
       { key: 'schedule', label: 'Horario' }, { key: 'settings', label: 'Ajustes' }]
    : [{ key: 'control', label: 'Control' }, { key: 'schedule', label: 'Horario' },
       { key: 'settings', label: 'Ajustes' }]);

  private poll = setInterval(() => this.load(), 20000);
  private tick = setInterval(() => this.now.set(Date.now()), 1000);
  private debounce?: ReturnType<typeof setTimeout>;

  constructor(private api: Api, private router: Router) {}

  ngOnInit() { this.load(true); }
  ngOnDestroy() { clearInterval(this.poll); clearInterval(this.tick); clearTimeout(this.debounce); }

  v(k: string) { const d = this.d(); return d ? val(d, k) : null; }
  has(k: string) { const d = this.d(); return !!d && has(d, k); }

  load(first = false) {
    this.api.device(this.id()).subscribe({
      next: raw => {
        const d = withOverrides(raw);
        this.d.set(d);
        if (first) {
          this.bulbTimer.set(decodeBulbTimer(val(d, 'general_timer')));
          this.plugTimer.set(decodePlugTimer(val(d, 'Timer_message')));
        }
      },
      error: e => { if (e.status === 404) this.error.set('Este aparato ya no está en tu cuenta.'); },
    });
  }

  /** Cambio optimista: pinta ya, recuerda localmente y revierte si el servidor falla. */
  /** Acción esperando al servidor: 'save' (guardar con mensaje), 'rename' o 'unbind'; '' = libre */
  working = signal<'' | 'save' | 'rename' | 'unbind'>('');

  send(values: Record<string, unknown>, okMsg?: string) {
    const d = this.d();
    if (!d) return;
    if (okMsg) this.working.set('save');
    const before = { ...d.points };
    const points = { ...d.points };
    for (const [k, value] of Object.entries(values))
      if (points[k]) points[k] = { ...points[k], value: String(value) };
    this.d.set({ ...d, points });
    this.api.setDp(d.id, values).subscribe({
      next: () => { remember(d.id, values); if (okMsg) { this.working.set(''); this.flash(okMsg); } },
      error: e => {
        if (okMsg) this.working.set('');
        this.d.set({ ...this.d()!, points: before });
        this.flash(e.error?.error ?? 'No se pudo aplicar el cambio');
      },
    });
  }

  sendDebounced(values: Record<string, unknown>) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.send(values), 250);
  }

  // ---------- control ----------
  togglePower() { this.send({ power_onoff: !this.on() }); }
  setBrightness(n: number) {
    this.sendDebounced(this.mode() === 'white'
      ? { power_onoff: true, brightness: n, warm_switch: true }
      : { power_onoff: true, brightness: n });
  }
  setColor(hex: string) {
    this.send({ power_onoff: true, warm_switch: false, work_mode: 2, color_data: hexRgbInt(hex) });
  }
  setWhite() {
    this.send({ power_onoff: true, warm_switch: true, brightness: this.brightness() });
  }
  setTemp(n: number) { this.sendDebounced({ power_onoff: true, warm_switch: true, temp_value: n }); }
  setScene(id: number, name: string) {
    this.send({ power_onoff: true, warm_switch: false, work_mode: 3, scence_id: id }, `Escena: ${name}`);
  }

  // ---------- horarios ----------
  toggleDay(kind: 'bulb' | 'plug', i: number) {
    const bit = 1 << i;
    if (kind === 'bulb') this.bulbTimer.update(t => ({ ...t, days: t.days ^ bit }));
    else this.plugTimer.update(t => ({ ...t, days: t.days ^ bit }));
  }
  hasDay(mask: number, i: number) { return (mask & (1 << i)) !== 0; }
  patchBulbTimer(p: Partial<BulbTimer>) { this.bulbTimer.update(t => ({ ...t, ...p })); }
  patchPlugTimer(p: Partial<PlugTimer>) { this.plugTimer.update(t => ({ ...t, ...p })); }
  hhmm = toHHMM;
  fromHHMM = fromHHMM;
  daysLabel = daysLabel;

  saveBulbTimer() {
    const t = this.bulbTimer();
    if (t.enabled && t.start === t.end) { this.flash('La hora de inicio y fin no pueden ser iguales'); return; }
    this.send({ general_timer: encodeBulbTimer(t) }, t.enabled ? 'Horario guardado en el bombillo' : 'Horario desactivado');
  }
  savePlugTimer() {
    this.send({ Timer_message: encodePlugTimer(this.plugTimer()) },
      this.plugTimer().enabled ? 'Horario guardado en el enchufe' : 'Horario desactivado');
  }
  startCountdown() {
    const m = this.countdownMin();
    if (!(m >= 1 && m <= 1440)) { this.flash('Elige entre 1 minuto y 24 horas'); return; }
    this.send({ Auto_message: encodeCountdown(m, this.countdownOn()) },
      `Se ${this.countdownOn() ? 'encenderá' : 'apagará'} en ${m} min`);
  }
  cancelCountdown() {
    const c = this.countdown();
    this.send({ Auto_message: encodeCountdown(0, c.turnOn, false) }, 'Cuenta regresiva cancelada');
  }
  fmtLeft(ms: number) {
    const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h} h ${m} min` : `${m}:${String(r).padStart(2, '0')}`;
  }

  // ---------- ajustes ----------
  toggleVacation() {
    const next = !this.vacation();
    const key = this.vacationKey();
    this.send({ [key]: key === 'Vacation_mode' ? (next ? 1 : 0) : next },
      next ? 'Modo vacaciones activado' : 'Modo vacaciones desactivado');
  }
  toggleLed() { this.send({ Plug_status_light: this.v('Plug_status_light') !== 'true' }); }

  startRename() { this.newName = this.d()?.name ?? ''; this.editingName.set(true); }
  saveName() {
    const name = this.newName.trim();
    const d = this.d();
    if (!d || !name || name === d.name) { this.editingName.set(false); return; }
    this.working.set('rename');
    this.api.rename(d.id, name).subscribe({
      next: () => { this.working.set(''); this.d.set({ ...d, name }); this.editingName.set(false); this.flash('Nombre actualizado'); },
      error: e => { this.working.set(''); this.flash(e.error?.error ?? 'No se pudo renombrar'); },
    });
  }

  unbind() {
    const d = this.d();
    if (!d) return;
    this.working.set('unbind');
    this.api.unbind(d.id, this.unbindName).subscribe({
      next: () => { if (d.mac) rememberRemoved({ name: d.name, productId: d.productId, mac: d.mac }); this.router.navigateByUrl('/'); },
      error: e => { this.working.set(''); this.flash(e.error?.error ?? 'No se pudo desvincular'); },
    });
  }

  private flash(m: string) { this.toast.set(m); setTimeout(() => this.toast.set(''), 2800); }
}
