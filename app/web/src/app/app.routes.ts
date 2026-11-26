import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { Api } from './api.service';

const authGuard = () => inject(Api).authed() || inject(Router).parseUrl('/login');

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./login.component').then(m => m.LoginComponent) },
  { path: 'signup', data: { kind: 'register' }, loadComponent: () => import('./account.component').then(m => m.AccountComponent) },
  { path: 'reset', data: { kind: 'reset' }, loadComponent: () => import('./account.component').then(m => m.AccountComponent) },
  { path: '', canActivate: [authGuard], loadComponent: () => import('./home.component').then(m => m.HomeComponent) },
  { path: 'add', canActivate: [authGuard], loadComponent: () => import('./add-device.component').then(m => m.AddDeviceComponent) },
  { path: 'device/:id/wifi', canActivate: [authGuard], data: { mode: 'wifi' }, loadComponent: () => import('./add-device.component').then(m => m.AddDeviceComponent) },
  { path: 'esp', canActivate: [authGuard], loadComponent: () => import('./hubs.component').then(m => m.HubsComponent) },
  { path: 'device/:id', canActivate: [authGuard], loadComponent: () => import('./device.component').then(m => m.DeviceComponent) },
  { path: '**', redirectTo: '' },
];
