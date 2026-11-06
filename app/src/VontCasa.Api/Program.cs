using Microsoft.AspNetCore.HttpOverrides;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using VontCasa.Api.Data;
using VontCasa.Api.Services;

var builder = WebApplication.CreateBuilder(args);

var jwtKey = builder.Configuration["Security:JwtKey"];
if (string.IsNullOrEmpty(jwtKey) || Encoding.UTF8.GetByteCount(jwtKey) < 32)
    throw new InvalidOperationException("Security:JwtKey debe tener al menos 32 bytes (configúralo en user-secrets).");

builder.Services.AddControllers();

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

// Topband cierra las conexiones inactivas antes que .NET: reusarlas daba "response ended prematurely"
builder.Services.AddHttpClient<TopbandService>()
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { PooledConnectionIdleTimeout = TimeSpan.FromSeconds(10) });
builder.Services.AddSingleton<VontTokenCache>();
builder.Services.AddSingleton<CryptoService>();
builder.Services.AddSingleton<JwtService>();
builder.Services.AddMemoryCache();
builder.Services.AddScoped<VontSessionService>();

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = false,
            ValidateLifetime = true,
            ValidAlgorithms = ["HS256"],
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
        };
    });
builder.Services.AddAuthorization();

// Rate limiting en el login (por IP) para frenar fuerza bruta de credenciales
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 8, Window = TimeSpan.FromMinutes(1) }));
    // Cada código manda un correo: límite estricto para que no sirva para llenar buzones ajenos
    o.AddPolicy("code", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 5, Window = TimeSpan.FromMinutes(15) }));
    // Vincular por MAC no tiene prueba de posesión (limitación del protocolo de Topband):
    // se limita por usuario para que no sirva para probar MACs en masa.
    o.AddPolicy("bind", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
            ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 5, Window = TimeSpan.FromMinutes(10) }));
});

const string CorsPolicy = "web";
builder.Services.AddCors(o => o.AddPolicy(CorsPolicy, p => p
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:4210"])
    .AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

// En IIS el API vive en la subaplicación /api: IIS quita "/api" del camino (PathBase) y los
// controladores, que ya llevan "api/" en su ruta, no lo encontrarían. Se le devuelve el camino completo.
app.Use((ctx, next) =>
{
    ctx.Request.Path = ctx.Request.PathBase.Add(ctx.Request.Path);
    ctx.Request.PathBase = PathString.Empty;
    return next();
});

// En Docker llegan por Caddy → nginx: sin esto todos comparten la IP de nginx y los límites por IP
// serían globales. El API no se publica al host (solo red interna), así que se confía en esos 2 saltos.
// En IIS no hay proxy delante: confiar en X-Forwarded-For dejaría a cualquiera saltarse los límites por IP.
if (builder.Configuration.GetValue<bool>("Security:BehindProxy"))
{
    var fwd = new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor, ForwardLimit = 2 };
    fwd.KnownIPNetworks.Clear(); fwd.KnownProxies.Clear();
    app.UseForwardedHeaders(fwd);
}

// aplica migraciones al arrancar (crea la BD si no existe)
using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();

// Solo cuando el API se expone directo a internet. Detrás de un reverse proxy
// (nginx) que termina el TLS, se deja en false y el proxy fuerza HTTPS.
if (builder.Configuration.GetValue<bool>("Security:RequireHttps"))
{
    app.UseHsts();
    app.UseHttpsRedirection();
}

app.UseRouting(); // explícito: debe ir después de devolver el camino completo (arriba)
app.UseCors(CorsPolicy);
app.UseAuthentication();
app.UseRateLimiter();   // después de auth: el límite de "bind" es por usuario
app.UseAuthorization();
app.MapControllers();

app.Run();
