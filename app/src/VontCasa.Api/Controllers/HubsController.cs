using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using VontCasa.Api.Data;
using VontCasa.Api.Services;

namespace VontCasa.Api.Controllers;

/// <summary>Placas ESP32 del usuario y los aparatos que controlan.</summary>
[ApiController]
[Authorize]
[Route("api/hubs")]
public class HubsController(AppDbContext db, VontSessionService sessions, EspDeviceService esp) : ControllerBase
{
    int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var hubs = await db.Hubs.Where(h => h.AppUserId == UserId).Include(h => h.Devices).OrderBy(h => h.Id).ToListAsync(ct);
        return Ok(hubs.Select(h => new
        {
            h.Id, h.Name, online = EspDeviceService.HubOnline(h), h.LastSeen,
            // tiene un código de configuración sin canjear
            pending = h.ClaimHash != null && h.ClaimExpires > DateTime.UtcNow,
            // tiras cerca que aún no están agregadas
            seen = h.Seen.Split(',', StringSplitOptions.RemoveEmptyEntries)
                .Where(m => h.Devices.All(d => d.Mac != m)).ToArray(),
            devices = h.Devices.Select(d => new { id = EspDeviceService.Prefix + d.Id, d.Name, d.Kind }),
        }));
    }

    public record HubDto(string Name);

    /// <summary>Crea una placa y devuelve su código de configuración (6 dígitos, 30 min).</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] HubDto dto, CancellationToken ct)
    {
        var name = dto.Name?.Trim() ?? "";
        if (name.Length is 0 or > 64) return BadRequest(new { error = "nombre inválido (1-64 caracteres)" });
        if (await db.Hubs.CountAsync(h => h.AppUserId == UserId, ct) >= 10) return BadRequest(new { error = "máximo 10 placas" });
        // clave provisional al azar: la real la recibe la placa al canjear el código
        var hub = new Hub { AppUserId = UserId, Name = name, KeyHash = EspDeviceService.Hash(EspDeviceService.NewKey()) };
        var code = EspDeviceService.NewClaim(hub);
        db.Hubs.Add(hub);
        await db.SaveChangesAsync(ct);
        await sessions.LogAsync(UserId, name, "hub-create", ct);
        return Ok(new { hub.Id, code, minutes = (int)EspDeviceService.ClaimTtl.TotalMinutes });
    }

    /// <summary>Código nuevo para reconfigurar una placa existente (cambio de Wi-Fi, placa reemplazada).</summary>
    [HttpPost("{id:int}/code")]
    public async Task<IActionResult> NewCode(int id, CancellationToken ct)
    {
        var hub = await db.Hubs.FirstOrDefaultAsync(h => h.Id == id && h.AppUserId == UserId, ct);
        if (hub is null) return NotFound();
        var code = EspDeviceService.NewClaim(hub);
        await db.SaveChangesAsync(ct);
        return Ok(new { hub.Id, code, minutes = (int)EspDeviceService.ClaimTtl.TotalMinutes });
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var hub = await db.Hubs.Include(h => h.Devices).FirstOrDefaultAsync(h => h.Id == id && h.AppUserId == UserId, ct);
        if (hub is null) return NotFound();
        db.HubDevices.RemoveRange(hub.Devices);
        db.Hubs.Remove(hub);
        await db.SaveChangesAsync(ct);
        await sessions.LogAsync(UserId, hub.Name, "hub-delete", ct);
        return Ok(new { ok = true });
    }

    /// <summary>Kind "fan": RemoteId opcional (hex de 4 dígitos) para reusar un emparejamiento ya hecho.
    /// Kind "strip": la MAC de una tira que la placa vio cerca.</summary>
    public record HubDeviceDto(string Kind, string Name, string? Mac, string? RemoteId);

    [HttpPost("{id:int}/devices")]
    public async Task<IActionResult> AddDevice(int id, [FromBody] HubDeviceDto dto, CancellationToken ct)
    {
        var hub = await db.Hubs.Include(h => h.Devices).FirstOrDefaultAsync(h => h.Id == id && h.AppUserId == UserId, ct);
        if (hub is null) return NotFound();
        var name = dto.Name?.Trim() ?? "";
        if (name.Length is 0 or > 64) return BadRequest(new { error = "nombre inválido (1-64 caracteres)" });
        if (hub.Devices.Count >= 16) return BadRequest(new { error = "máximo 16 aparatos por placa" });

        var dev = new HubDevice { HubId = hub.Id, Name = name, Kind = dto.Kind };
        if (dto.Kind == "fan")
        {
            if (string.IsNullOrWhiteSpace(dto.RemoteId))
                dev.RemoteId = Random.Shared.Next(0x1000, 0xFFFF);
            else if (int.TryParse(dto.RemoteId, System.Globalization.NumberStyles.HexNumber, null, out var rid) && rid is > 0 and <= 0xFFFF)
                dev.RemoteId = rid;
            else return BadRequest(new { error = "id de control inválido (hex, 4 dígitos)" });
        }
        else if (dto.Kind == "strip")
        {
            var mac = TopbandService.NormalizeMac(dto.Mac ?? "")?.ToUpperInvariant();
            if (mac is null) return BadRequest(new { error = "MAC inválida" });
            if (hub.Devices.Any(d => d.Mac == mac)) return Conflict(new { error = "esa tira ya está agregada" });
            dev.Mac = mac;
        }
        else return BadRequest(new { error = "tipo no soportado" });

        db.HubDevices.Add(dev);
        await db.SaveChangesAsync(ct);
        await sessions.LogAsync(UserId, name, "hub-add-" + dto.Kind, ct);
        return Ok(new { id = EspDeviceService.Prefix + dev.Id });
    }

    /// <summary>Abanico: emite "emparejar" 60 s. Hay que cortar y dar la corriente al receptor mientras tanto.</summary>
    [HttpPost("pair/{deviceId}")]
    public async Task<IActionResult> Pair(string deviceId, CancellationToken ct)
    {
        var d = await esp.FindAsync(UserId, deviceId, ct);
        if (d is null || d.Kind != "fan") return NotFound();
        if (!EspDeviceService.HubOnline(d.Hub!)) return Conflict(new { error = "la placa está sin conexión" });
        await esp.PairAsync(d, ct);
        await sessions.LogAsync(UserId, d.Name, "pair", ct);
        return Ok(new { ok = true, seconds = 60 });
    }
}

/// <summary>Lo que llama la placa: no usa JWT sino su clave (cabecera X-Hub-Key).</summary>
[ApiController]
[AllowAnonymous]
[Route("api/hub")]
public class HubAgentController(AppDbContext db, HubQueue queue) : ControllerBase
{
    static readonly Regex SeenRe = new("^([0-9A-F]{12})(,[0-9A-F]{12}){0,15}$", RegexOptions.Compiled);

    public record ClaimDto(string Code);

    /// <summary>La placa canjea el código de 6 dígitos por su clave (una sola vez).</summary>
    [HttpPost("claim")]
    [Microsoft.AspNetCore.RateLimiting.EnableRateLimiting("claim")]
    public async Task<IActionResult> Claim([FromBody] ClaimDto dto, CancellationToken ct)
    {
        if (dto.Code is not { Length: 6 } || !dto.Code.All(char.IsAsciiDigit)) return BadRequest(new { error = "código inválido" });
        var hash = EspDeviceService.Hash(dto.Code);
        var now = DateTime.UtcNow;
        var hub = await db.Hubs.FirstOrDefaultAsync(h => h.ClaimHash == hash && h.ClaimExpires > now, ct);
        if (hub is null) return NotFound(new { error = "código incorrecto o vencido" });
        var key = EspDeviceService.NewKey();
        hub.KeyHash = EspDeviceService.Hash(key);
        hub.ClaimHash = null; hub.ClaimExpires = null;
        await db.SaveChangesAsync(ct);
        return Ok(new { key, name = hub.Name });
    }

    /// <summary>Long polling: espera hasta 20 s por órdenes. <paramref name="seen"/>: MACs de tiras cerca.</summary>
    [HttpGet("poll")]
    public async Task<IActionResult> Poll([FromHeader(Name = "X-Hub-Key")] string? key, [FromQuery] string? seen, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(key) || key.Length > 64) return Unauthorized();
        var hash = EspDeviceService.Hash(key);
        var hub = await db.Hubs.FirstOrDefaultAsync(h => h.KeyHash == hash, ct);
        if (hub is null) return Unauthorized();

        hub.LastSeen = DateTime.UtcNow;
        var s = seen?.ToUpperInvariant();
        if (s is not null && (s.Length == 0 || SeenRe.IsMatch(s))) hub.Seen = s;
        await db.SaveChangesAsync(ct);

        var cmds = await queue.TakeAsync(hub.Id, TimeSpan.FromSeconds(20), ct);
        return Ok(new { cmds });
    }
}
