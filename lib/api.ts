// Cliente HTTP central del CRM v3: todas las llamadas a /api pasan por aquí.
// v1.3: el JWT vive en cookie HttpOnly (el servidor la emite al iniciar
// sesión) y el navegador la envía sola (credentials: 'include'). El token
// de salón de 1 h sigue guardándose en localStorage como respaldo (Bearer)
// para el flujo entrar/volver del superadmin.
const TOKEN_KEY = 'salonos_token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* almacenamiento no disponible */ }
}

export function clearAuth(): void {
  setToken(null);
  try { localStorage.removeItem('salonos_session'); } catch { /* noop */ }
  // Revocar en el servidor (sube token_version): best-effort, sin await,
  // con fetch plano para no reentrar en apiFetch.
  try { fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {}); } catch { /* noop */ }
}

let reloading = false;

/** Igual que fetch, pero añade Authorization: Bearer <token> cuando hay sesión
 *  (token de salón) y siempre manda la cookie HttpOnly. Si el servidor
 *  responde 401 (sesión vencida o revocada) cierra la sesión y recarga una
 *  sola vez, salvo en el propio login (donde el 401 es esperado). */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(input, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && !input.includes('/api/auth/login') && !reloading) {
    reloading = true;
    clearAuth();
    window.location.reload();
  }
  return res;
}
