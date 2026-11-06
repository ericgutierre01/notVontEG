import { Component, input } from '@angular/core';

@Component({
  selector: 'device-icon',
  standalone: true,
  template: `
@if (bulb()) {
  <svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V17h5.2v-1.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>
  </svg>
} @else {
  <svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="3" width="14" height="18" rx="4"/><path d="M10 9v2M14 9v2M12 15v2"/>
  </svg>
}`,
})
export class DeviceIcon {
  bulb = input(true);
  size = input(22);
}
