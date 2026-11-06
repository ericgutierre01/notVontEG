import { Component, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from './api.service';
import { DisclaimerComponent } from './disclaimer.component';
import { AUTH_STYLES } from './login.component';

type Kind = 'register' | 'reset';

/** Crear cuenta (/signup) y olvidé mi contraseña (/reset): correo → código de 4 dígitos → contraseña. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [FormsModule, RouterLink, DisclaimerComponent],
  template: `
<main class="login">
  <div class="brand">
    <h1>{{ kind === 'register' ? 'Crear cuenta' : 'Recuperar contraseña' }}</h1>
    <p>{{ kind === 'register' ? 'Se crea una cuenta de Vont: sirve aquí y en la app Vont Home.'
                              : 'Te mandamos un código a tu correo para poner una contraseña nueva.' }}</p>
  </div>

  @if (step() === 1) {
    <form (ngSubmit)="send()" class="card">
      <label>Correo
        <input class="field" name="u" type="email" [(ngModel)]="user" autocomplete="username" required
               placeholder="tucorreo@ejemplo.com" inputmode="email" autocapitalize="off" spellcheck="false">
      </label>
      <button class="btn" type="submit" [disabled]="busy() || !user">
        {{ busy() ? 'Enviando…' : 'Enviar código' }}
      </button>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    </form>
  } @else {
    <form (ngSubmit)="finish()" class="card">
      <p class="sent" role="status">Te mandamos un código de 4 dígitos a <strong>{{ user }}</strong>.
        Llega de <em>topband&#64;mail.topband-cloud.com</em> (revisa spam) y dura 30 minutos.</p>
      <label>Código
        <input class="field code" name="c" [(ngModel)]="code" required inputmode="numeric"
               autocomplete="one-time-code" maxlength="8" placeholder="0000">
      </label>
      <label>{{ kind === 'register' ? 'Contraseña' : 'Contraseña nueva' }}
        <span class="pass">
          <input class="field" name="p" [type]="showPass() ? 'text' : 'password'" [(ngModel)]="pass"
                 autocomplete="new-password" required minlength="6" maxlength="32" placeholder="Mínimo 6 caracteres">
          <button type="button" class="eye" (click)="showPass.set(!showPass())"
                  [attr.aria-label]="showPass() ? 'Ocultar contraseña' : 'Mostrar contraseña'"
                  [attr.aria-pressed]="showPass()">
            @if (showPass()) {
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>
            } @else {
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            }
          </button>
        </span>
      </label>
      <button class="btn" type="submit" [disabled]="busy() || !code || pass.length < 6">
        {{ busy() ? 'Guardando…' : (kind === 'register' ? 'Crear cuenta' : 'Cambiar contraseña') }}
      </button>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      <p class="alt">
        <button type="button" class="link plain" (click)="send()" [disabled]="busy() || wait() > 0">
          {{ wait() > 0 ? 'Reenviar código en ' + wait() + ' s' : 'Reenviar código' }}</button>
        · <button type="button" class="link plain" (click)="step.set(1); error.set('')">Cambiar correo</button>
      </p>
    </form>
  }

  <p class="alt"><a class="link" routerLink="/login" [queryParams]="user ? { email: user } : {}">Volver a iniciar sesión</a></p>
  <app-disclaimer />
</main>`,
  styles: [AUTH_STYLES, `
    .sent{margin:0;font-size:14px;line-height:1.5;color:var(--muted)}
    .sent strong{color:var(--text);word-break:break-all}
    .code{font-size:22px;letter-spacing:8px;text-align:center}
    .plain{background:none;border:none;padding:4px;cursor:pointer;font:inherit;color:var(--accent);font-size:14px}
    .plain:disabled{color:var(--faint);cursor:default;text-decoration:none}
  `],
})
export class AccountComponent implements OnDestroy {
  kind: Kind;
  user = ''; code = ''; pass = '';
  step = signal<1 | 2>(1);
  busy = signal(false);
  error = signal('');
  showPass = signal(false);
  wait = signal(0);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private api: Api, private router: Router, route: ActivatedRoute) {
    this.kind = route.snapshot.data['kind'];
    this.user = route.snapshot.queryParamMap.get('email') ?? '';
  }

  send() {
    this.user = this.user.trim();
    this.busy.set(true); this.error.set('');
    this.api.sendCode(this.user, this.kind).subscribe({
      next: () => { this.busy.set(false); this.step.set(2); this.countdown(); },
      error: e => this.fail(e),
    });
  }

  finish() {
    this.busy.set(true); this.error.set('');
    this.api.account(this.kind, this.user, this.pass, this.code).subscribe({
      // listo: entra directo con la contraseña recién puesta
      next: () => this.api.login(this.user, this.pass).subscribe({
        next: r => { this.api.setToken(r.token); this.router.navigateByUrl('/'); },
        error: () => this.router.navigate(['/login'], { queryParams: { email: this.user } }),
      }),
      error: e => this.fail(e),
    });
  }

  private fail(e: any) {
    this.busy.set(false);
    this.error.set(e.status === 429 ? 'Demasiados intentos, espera unos minutos.'
      : e.error?.error ?? 'No se pudo conectar con el servidor.');
  }

  private countdown() {
    clearInterval(this.timer);
    this.wait.set(60);
    this.timer = setInterval(() => { this.wait.update(s => s - 1); if (this.wait() <= 0) clearInterval(this.timer); }, 1000);
  }

  ngOnDestroy() { clearInterval(this.timer); }
}
