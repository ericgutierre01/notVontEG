import { Component } from '@angular/core';

@Component({
  selector: 'app-disclaimer',
  standalone: true,
  template: `
<footer class="disclaimer">
  <strong>Not Vont EG</strong> es un proyecto independiente: no forma parte de Vont ni está afiliado,
  patrocinado o respaldado por Vont ni por ninguna empresa relacionada. Se creó únicamente porque la
  empresa Vont desapareció y dejó sin soporte a quienes ya habían comprado sus aparatos. "Vont" es una
  marca de su respectivo dueño y se menciona solo para identificar los aparatos compatibles.
</footer>`,
  styles: [`
    .disclaimer{font-size:12px;line-height:1.5;color:var(--faint);text-align:center;
      max-width:520px;margin:8px auto 0;padding:0 8px}
    .disclaimer strong{color:var(--muted);font-weight:600}
  `],
})
export class DisclaimerComponent {}
