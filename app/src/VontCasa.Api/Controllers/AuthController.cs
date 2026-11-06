using System.Net.Mail;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;
using VontCasa.Api.Services;

namespace VontCasa.Api.Controllers;

public record LoginDto(string Username, string Password);
public record CodeDto(string Username, string Purpose);
public record AccountDto(string Username, string Password, string Code);

[ApiController]
[Route("api/auth")]
[EnableRateLimiting("login")]
public class AuthController(VontSessionService sessions, JwtService jwt, TopbandService topband, IMemoryCache cache) : ControllerBase
{
    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginDto dto, CancellationToken ct)
    {
        var userId = await sessions.LoginAsync(dto.Username, dto.Password, ct);
        if (userId is null) return Unauthorized(new { error = "Correo o contraseña incorrectos" });
        return Ok(new { token = jwt.Issue(userId.Value, dto.Username) });
    }

    /// <summary>Pide a Topband que mande el código de 4 dígitos al correo. purpose: "register" | "reset".</summary>
    [HttpPost("code")]
    [EnableRateLimiting("code")]
    public async Task<IActionResult> Code([FromBody] CodeDto dto, CancellationToken ct)
    {
        if (Canon(dto.Username) is not { } email) return BadRequest(new { error = "Escribe un correo válido." });
        int? type = dto.Purpose switch { "register" => 0, "reset" => 2, _ => null };
        if (type is null) return BadRequest(new { error = "Solicitud inválida." });
        // además del límite por IP: máx. 3 correos por hora a una misma dirección
        if (Exceeded("code:" + email.ToLowerInvariant(), 3, TimeSpan.FromHours(1))) return TooMany();
        return Result(await topband.SendCodeAsync(email, type.Value, ct));
    }

    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] AccountDto dto, CancellationToken ct) =>
        Validate(dto) ?? Result(await topband.RegisterAsync(Canon(dto.Username)!, dto.Password, dto.Code.Trim(), ct));

    // El código es de 4 dígitos: máx. 5 intentos por correo en su vida útil (30 min) para que no se pueda adivinar
    // desde muchas IPs. shortcut: contador en memoria, se pierde al reiniciar; pasar a BD si hay varias instancias.
    IActionResult? Validate(AccountDto dto) =>
        ValidateFields(dto) ?? (Exceeded("try:" + Canon(dto.Username)!.ToLowerInvariant(), 5, TimeSpan.FromMinutes(30)) ? TooMany() : null);

    [HttpPost("reset")]
    public async Task<IActionResult> Reset([FromBody] AccountDto dto, CancellationToken ct) =>
        Validate(dto) ?? Result(await topband.ResetPasswordAsync(Canon(dto.Username)!, dto.Password, dto.Code.Trim(), ct));

    /// <summary>Correo validado (sin nombre visible ni adornos): lo que va a Topband; en minúsculas es la clave de los límites.</summary>
    static string? Canon(string? s) =>
        !string.IsNullOrWhiteSpace(s) && s.Length <= 100 && MailAddress.TryCreate(s.Trim(), out var a)
        && a.DisplayName.Length == 0 && a.Address == s.Trim() ? a.Address : null;

    ObjectResult TooMany() => StatusCode(429, new { error = "Demasiados intentos con ese correo. Espera un rato." });

    bool Exceeded(string key, int limit, TimeSpan window)
    {
        var n = cache.GetOrCreate(key, e => { e.AbsoluteExpirationRelativeToNow = window; return new int[1]; })!;
        return Interlocked.Increment(ref n[0]) > limit;
    }

    IActionResult? ValidateFields(AccountDto dto)
    {
        if (Canon(dto.Username) is null) return BadRequest(new { error = "Escribe un correo válido." });
        if (string.IsNullOrWhiteSpace(dto.Code) || dto.Code.Trim().Length is < 4 or > 8)
            return BadRequest(new { error = "Escribe el código que te llegó al correo." });
        if (dto.Password is null || dto.Password.Length is < 6 or > 32)
            return BadRequest(new { error = "La contraseña debe tener entre 6 y 32 caracteres." });
        return null;
    }

    IActionResult Result((int Status, string? Message) r) => r.Status switch
    {
        0 => Ok(new { ok = true }),
        200110 => BadRequest(new { error = "No hay ninguna cuenta de Vont con ese correo." }),
        200112 => BadRequest(new { error = "Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña." }),
        200116 => BadRequest(new { error = "El código es incorrecto o ya venció (dura 30 minutos)." }),
        -1 => StatusCode(502, new { error = "No se pudo conectar con el servidor de Vont." }),
        _ => BadRequest(new { error = r.Message ?? "No se pudo completar. Intenta de nuevo." }),
    };
}
