using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using VontCasa.Api.Services;

namespace VontCasa.Api.Controllers;

/// <summary>Perfil de la cuenta de Vont (correo, nombre y foto) para el menú Perfil.</summary>
[ApiController]
[Authorize]
[Route("api/me")]
public class MeController(VontSessionService sessions, TopbandService topband) : ControllerBase
{
    int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var p = await topband.GetProfileAsync(token, ct);
        if (p is null) return StatusCode(502, new { error = "No se pudo leer el perfil." });
        return Ok(new { email = p.Email, name = p.UserName, photo = TopbandService.Https(p.Photo) });
    }

    public record AvatarDto(string Image);

    /// <summary>Foto nueva: JPEG o PNG en base64 (la web ya la recorta cuadrada y la achica).</summary>
    [HttpPut("photo")]
    [RequestSizeLimit(4_000_000)]
    public async Task<IActionResult> SetPhoto([FromBody] AvatarDto dto, CancellationToken ct)
    {
        byte[] img;
        try { img = Convert.FromBase64String(dto.Image ?? ""); } catch (FormatException) { img = []; }
        var isJpeg = img.Length > 3 && img[0] == 0xFF && img[1] == 0xD8 && img[2] == 0xFF;
        var isPng = img.Length > 8 && img.AsSpan(0, 8).SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        if (!isJpeg && !isPng) return BadRequest(new { error = "La foto debe ser JPG o PNG." });
        if (img.Length > 2_000_000) return BadRequest(new { error = "La foto es muy pesada (máx. 2 MB)." });
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        var url = await topband.SetAvatarAsync(token, img, ct);
        if (url is null) return StatusCode(502, new { error = "Vont no aceptó la foto." });
        await sessions.LogAsync(UserId, "cuenta", "avatar", ct);
        return Ok(new { photo = TopbandService.Https(url) });
    }

    public record NameDto(string Name);

    [HttpPut("name")]
    public async Task<IActionResult> SetName([FromBody] NameDto dto, CancellationToken ct)
    {
        var name = dto.Name?.Trim() ?? "";
        if (name.Length is < 1 or > 32) return BadRequest(new { error = "El nombre debe tener entre 1 y 32 caracteres." });
        var token = await sessions.GetTokenAsync(UserId, ct);
        if (token is null) return Unauthorized();
        if (!await topband.SetNicknameAsync(token, name, ct)) return StatusCode(502, new { error = "Vont no aceptó el cambio." });
        await sessions.LogAsync(UserId, "cuenta", "nickname", ct);
        return Ok(new { name });
    }
}
