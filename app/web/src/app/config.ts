/**
 * Configuración que se cambia sin recompilar: public/config.json (en el servidor, config.json junto a index.html).
 * apiUrl: dónde está el API. "/api" = mismo dominio; también vale una dirección completa (https://otro.dominio.com/api).
 */
export const config = { apiUrl: '/api' };

export async function loadConfig() {
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (!r.ok) return; // sin archivo: se queda el valor por defecto
    const c = await r.json();
    if (typeof c?.apiUrl === 'string' && c.apiUrl.trim()) config.apiUrl = c.apiUrl.trim().replace(/\/+$/, '');
  } catch { /* sin red o JSON inválido: valor por defecto */ }
}
