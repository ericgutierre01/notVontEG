import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from './api.service';
import { DisclaimerComponent } from './disclaimer.component';

/** Estilos de las pantallas de cuenta (login, crear cuenta, recuperar). */
export const AUTH_STYLES = `
    .login{min-height:100dvh;display:flex;flex-direction:column;justify-content:center;
      padding:24px 16px;max-width:400px;margin:0 auto;gap:24px}
    .brand{text-align:center}
    .logo{width:64px;height:64px;margin:0 auto 14px;border-radius:20px;display:grid;place-items:center;color:#fff;
      background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 12px 32px rgba(108,140,255,.35)}
    h1{margin:0;font-size:28px;letter-spacing:-.5px}
    .brand p{margin:6px 0 0;color:var(--muted)}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
      padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:var(--shadow)}
    label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);font-weight:500}
    .btn{margin-top:6px}
    .pass{position:relative;display:block}
    .pass .field{padding-right:52px}
    .eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:44px;height:44px;border:none;
      background:none;border-radius:12px;color:var(--muted);cursor:pointer;display:grid;place-items:center}
    .eye:hover{color:var(--text)}
    .field::placeholder{color:var(--faint)}
    .info{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);
      padding:14px 16px;font-size:13px;color:var(--muted);line-height:1.5}
    .info p{margin:0 0 6px}
    .info p:last-child{margin:0}
    .info-title{display:flex;align-items:center;gap:6px;color:var(--text);font-weight:600;font-size:14px}
    .err{margin:0;color:var(--danger);font-size:14px;text-align:center}
      .link{color:var(--accent);font-size:14px;font-weight:500;text-decoration:none}
    .link:hover{text-decoration:underline}
    .forgot{align-self:flex-end;margin-top:-4px;padding:4px 0}
    .alt{margin:0;text-align:center;font-size:14px;color:var(--muted)}
`;

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, DisclaimerComponent, RouterLink],
  template: `
<main class="login">
  <div class="brand">
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V17h5.2v-1.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>
    </div>
    <h1>Not Vont EG</h1>
    <p>Entra con tu cuenta de Vont</p>
  </div>
  <form (ngSubmit)="submit()" class="card">
    <label>Correo
      <input class="field" name="u" type="email" [(ngModel)]="user" autocomplete="username" required
             placeholder="tucorreo@ejemplo.com" inputmode="email" autocapitalize="off" spellcheck="false">
    </label>
    <label>Contraseña
      <span class="pass">
        <input class="field" name="p" [type]="showPass() ? 'text' : 'password'" [(ngModel)]="pass"
               autocomplete="current-password" required placeholder="Tu contraseña de Vont">
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
    <a class="link forgot" routerLink="/reset" [queryParams]="user ? { email: user } : {}">¿Olvidaste tu contraseña?</a>
    <button class="btn" type="submit" [disabled]="busy() || !user || !pass">
      {{ busy() ? 'Entrando…' : 'Entrar' }}
    </button>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
  </form>
  <p class="alt">¿No tienes cuenta de Vont? <a class="link" routerLink="/signup">Crear cuenta</a></p>
  <aside class="info">
    <p class="info-title">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      Usa tu cuenta de Vont
    </p>
    <p>Es el mismo correo y contraseña con los que entras a la app <strong>Vont Home</strong>. Si ya la tienes, no hace falta crear otra.</p>
  </aside>
  <app-disclaimer />
</main>`,
  styles: [AUTH_STYLES],
})
export class LoginComponent {
  user = ''; pass = '';
  busy = signal(false);
  error = signal('');
  showPass = signal(false);
  constructor(private api: Api, private router: Router, route: ActivatedRoute) {
    this.user = route.snapshot.queryParamMap.get('email') ?? '';
  }

  submit() {
    this.busy.set(true); this.error.set('');
    this.api.login(this.user, this.pass).subscribe({
      next: r => { this.api.setToken(r.token); this.router.navigateByUrl('/'); },
      error: e => {
        this.busy.set(false);
        this.error.set(e.status === 429 ? 'Demasiados intentos, espera un minuto.'
          : e.status === 401 ? 'Correo o contraseña incorrectos.' : 'No se pudo conectar con el servidor.');
      },
    });
  }
}
