using System.Security.Claims;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using VontCasa.Api.Services;

namespace VontCasa.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/devices")]
public class DevicesController(VontSessionService sessions, TopbandService topband) : ControllerBase
{
    int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    // Data points que la app permite escribir. Se excluyen los de solo lectura
    // (Wifi_RSSI, working_times), el reset de fábrica y los que no tienen encoder
    // conocido (wakeup/sleeping) o dependen del micrófono del teléfono (música).
    static readonly HashSet<string> Writable =
    [
        "power_onoff", "brightness", "color_data", "warm_switch", "temp_value",
        "work_mode", "scence_id", "DIY_scene", "general_timer",
        "vacation_mode", "Vacation_mode", "Plug_status_light", "Timer_message", "Auto_message",
    ];

    /// <summary>Lista con estado real (online, encendido, brillo, color...) de cada aparato.</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var devices = await topband.GetDevicesAsync(token, ct);
        var details = await Task.WhenAll(devices.Select(d => topband.GetDetailAsync(token, d.Id, ct)));
        return Ok(new { devices = details.Where(d => d is not null) });
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Detail(string id, CancellationToken ct)
    {
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var d = await topband.GetDetailAsync(token, id, ct);
        return d is null ? NotFound() : Ok(d);
    }

    public record DpItem(string Name, JsonNode Value);
    public record DpDto(List<DpItem> Points);

    /// <summary>Cambia una o varias funciones en un solo comando (las escenas y el modo blanco
    /// necesitan varias juntas). El aparato y el tipo de cada dato se resuelven en el servidor
    /// desde TU cuenta; no se confía en el cliente.</summary>
    [HttpPost("{id}/dp")]
    public async Task<IActionResult> SetDp(string id, [FromBody] DpDto dto, CancellationToken ct)
    {
        if (dto.Points is not { Count: > 0 and <= 8 }) return BadRequest(new { error = "sin funciones" });
        if (dto.Points.FirstOrDefault(p => !Writable.Contains(p.Name)) is { } bad)
            return BadRequest(new { error = $"función no permitida: {bad.Name}" });

        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var d = await topband.GetDetailAsync(token, id, ct);
        if (d is null) return NotFound();
        if (!d.Online) return Conflict(new { error = "el aparato está sin conexión" });

        var points = new List<(int, int, JsonNode)>();
        foreach (var p in dto.Points)
        {
            if (!d.Points.TryGetValue(p.Name, out var dp))
                return BadRequest(new { error = $"este aparato no soporta: {p.Name}" });
            try { TopbandService.EncodeValue(dp.Type, p.Value); }
            catch (Exception e) when (e is FormatException or InvalidOperationException or OverflowException)
            { return BadRequest(new { error = $"valor inválido para {p.Name}" }); }
            points.Add((dp.Index, dp.Type, p.Value));
        }

        await topband.SendDpsAsync(token, d.ProductId, d.Uid, points, ct);
        await sessions.LogAsync(UserId, d.Name, string.Join(",", dto.Points.Select(p => p.Name)), ct);
        return Ok(new { ok = true });
    }

    /// <summary>Tipos de aparato que se pueden emparejar (código del anuncio Bluetooth → nombre).</summary>
    [HttpGet("catalog")]
    public async Task<IActionResult> Catalog(CancellationToken ct)
    {
        var token = await sessions.GetTokenAsync(UserId, ct);
        var images = token is null ? new() : await topband.GetProductImagesAsync(token, ct);
        return Ok(TopbandService.Catalog.Select(kv => new
        {
            productCode = kv.Key, productId = kv.Value.ProductId, name = kv.Value.Name,
            image = TopbandService.Https(images.GetValueOrDefault(kv.Key)),
        }));
    }

    public record BindDto(int ProductCode, string Mac);

    /// <summary>Paso de nube del emparejamiento: vincula el aparato a tu cuenta y devuelve su uid.
    /// La contraseña del Wi-Fi NO pasa por aquí: va del navegador al aparato por Bluetooth.</summary>
    [HttpPost("bind")]
    [Microsoft.AspNetCore.RateLimiting.EnableRateLimiting("bind")]
    public async Task<IActionResult> Bind([FromBody] BindDto dto, CancellationToken ct)
    {
        if (!TopbandService.Catalog.TryGetValue(dto.ProductCode, out var product))
            return BadRequest(new { error = "tipo de aparato no soportado" });
        var mac = TopbandService.NormalizeMac(dto.Mac ?? "");
        if (mac is null) return BadRequest(new { error = "MAC inválida (12 dígitos hexadecimales)" });

        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var r = await topband.BindAsync(token, product.ProductId, mac, ct);
        if (!r.Ok) return BadRequest(new { error = r.Error });
        await sessions.LogAsync(UserId, product.Name, "bind", ct);
        return Ok(new { uid = r.Uid });
    }

    public record UnbindDto(string ConfirmName);

    /// <summary>Desvincula el aparato. Destructivo: exige reescribir el nombre exacto como confirmación.</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Unbind(string id, [FromBody] UnbindDto dto, CancellationToken ct)
    {
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var d = await topband.GetDetailAsync(token, id, ct);
        if (d is null) return NotFound();
        if (dto.ConfirmName != d.Name) return BadRequest(new { error = "el nombre de confirmación no coincide" });
        if (!await topband.UnbindAsync(token, d.Uid, ct)) return BadRequest(new { error = "no se pudo desvincular" });
        await sessions.LogAsync(UserId, d.Name, "unbind", ct);
        return Ok(new { ok = true });
    }

    public record RenameDto(string Name);

    [HttpPut("{id}/name")]
    public async Task<IActionResult> Rename(string id, [FromBody] RenameDto dto, CancellationToken ct)
    {
        var name = dto.Name?.Trim() ?? "";
        if (name.Length is 0 or > 64) return BadRequest(new { error = "nombre inválido (1-64 caracteres)" });
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        if (!await topband.RenameAsync(token, id, name, ct)) return BadRequest(new { error = "no se pudo renombrar" });
        await sessions.LogAsync(UserId, name, "rename", ct);
        return Ok(new { ok = true });
    }
}
