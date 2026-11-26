# Vont Casa

App web propia para controlar los aparatos Vont/Topband, independiente de la app
oficial de Vont, de Alexa y de AWS. Inicias sesión con tu cuenta Vont y controlas
encendido/apagado, brillo y color.

- **Backend:** ASP.NET Core (.NET 10) + EF Core + SQL Server. Habla con la nube
  Topband (login REST con token + control por MQTT/TLS). Ver `../alexa/PROTOCOL.md`.
- **Frontend:** Angular 19 (standalone).
- **Base de datos:** SQL Server — usuarios (contraseña Vont cifrada con AES-GCM) y auditoría.
- **Placa ESP32 (opcional):** puente Bluetooth para un abanico ZhiMei y tiras LED ELK-BLEDOM. Ver `esp32/README.md`.

## Desarrollo (local)

Requisitos: .NET 10 SDK, Node 22, y acceso a un SQL Server.

```bash
# 1) Backend: configura secretos (una vez)
cd src/VontCasa.Api
dotnet user-secrets set "ConnectionStrings:Default" "Server=HOST,1433;Database=notvont;User Id=USER;Password=PASS;TrustServerCertificate=True;Encrypt=True"
dotnet user-secrets set "Security:JwtKey" "$(openssl rand -base64 48)"
dotnet user-secrets set "Security:EncryptionKey" "$(openssl rand -base64 32)"
dotnet run --launch-profile http        # aplica migraciones y escucha en :5090
```

```bash
# 2) Frontend
cd web
npm install
npx ng serve --port 4210   # http://localhost:4210
```

Las migraciones crean las tablas solas al arrancar el API. En dev, `ng serve` pasa
`/api` al API en `http://localhost:5090` (`web/proxy.conf.json`).

**Dirección del API sin recompilar:** `config.json` junto a `index.html` (en el código,
`web/public/config.json`):

```json
{ "apiUrl": "/api" }
```

`/api` = mismo dominio (`https://tu-dominio.com/api`). También acepta una dirección
completa (`https://otro.dominio.com/api`; entonces agrégala a `Cors__Origins` del API).
Se lee al abrir la página: edítalo y recarga.

## Despliegue (VPS con Docker)

El SQL Server es externo (tu instancia). nginx sirve el Angular y hace proxy de
`/api` al backend, así todo va por un solo dominio (sin CORS ni puertos sueltos).

```bash
cp .env.example .env     # rellena CONNECTION_STRING, JWT_KEY, ENCRYPTION_KEY, DOMAIN
docker compose up -d --build
```

La web queda en `https://TU_DOMINIO`. Caddy obtiene y renueva el certificado
(Let's Encrypt) y redirige HTTP→HTTPS; el API y la web solo existen en la red
interna de Docker, así que tu contraseña Vont nunca viaja en texto plano.

## Despliegue (Windows / IIS, p. ej. Plesk)

Plantillas en `deploy/iis/`.

- **Raíz del sitio:** la web (`web/dist/web/browser/*`) + `deploy/iis/web.config` con la regla SPA
  (rutas → `index.html`, excepto `/api`), tipos MIME y caché.
- **`/api`:** `dotnet publish -c Release -r win-x64 --self-contained true` + `deploy/iis/api/web.config` relleno
  (AspNetCoreModuleV2, `httpErrors existingResponse="PassThrough"` y las variables
  `ConnectionStrings__Default`, `Security__JwtKey`, `Security__EncryptionKey`, `Cors__Origins__0`).
  Es una subaplicación: IIS le quita `/api` al camino y `Program.cs` se lo devuelve.
- Para actualizar el backend: sube `app_offline.htm` a `/api`, reemplaza los archivos y bórralo
  (si no, IIS tiene el `.dll` bloqueado).
- Los `web.config` del servidor llevan secretos: no están en git.

## Notas de seguridad

- Claves y cadena de conexión van en user-secrets (dev) o `.env` (prod); nunca en git.
- La contraseña Vont se guarda cifrada (AES-GCM) para renovar el token sin re-login;
  rota la `ENCRYPTION_KEY` y las credenciales si sospechas una fuga.
- Rate limiting por IP en `/api/auth/login`. Detrás de proxy, configura
  `ForwardedHeaders` con el proxy de confianza para que el límite sea por IP real.
