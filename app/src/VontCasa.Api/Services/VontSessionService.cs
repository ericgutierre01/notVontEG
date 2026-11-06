using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using VontCasa.Api.Data;

namespace VontCasa.Api.Services;

/// <summary>Caché en memoria del token de Topband por usuario de la app.</summary>
public class VontTokenCache
{
    readonly ConcurrentDictionary<int, (string Token, DateTime Expires)> _cache = new();
    static readonly TimeSpan Ttl = TimeSpan.FromMinutes(55);

    public string? Get(int userId) =>
        _cache.TryGetValue(userId, out var e) && e.Expires > DateTime.UtcNow ? e.Token : null;

    public void Set(int userId, string token) =>
        _cache[userId] = (token, DateTime.UtcNow + Ttl);
}

public class VontSessionService(
    AppDbContext db, TopbandService topband, CryptoService crypto, VontTokenCache cache)
{
    /// <summary>Valida las credenciales Vont, crea/actualiza el usuario y cachea el token.
    /// Devuelve el id del usuario de la app, o null si las credenciales son inválidas.</summary>
    public async Task<int?> LoginAsync(string username, string password, CancellationToken ct = default)
    {
        var token = await topband.LoginAsync(username, password, ct);
        if (token is null) return null;

        var user = await db.Users.FirstOrDefaultAsync(u => u.VontUsername == username, ct);
        if (user is null)
        {
            user = new AppUser { VontUsername = username };
            db.Users.Add(user);
        }
        user.VontPasswordEnc = crypto.Encrypt(password);
        user.LastLoginAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        cache.Set(user.Id, token);
        return user.Id;
    }

    /// <summary>Token válido para el usuario: de la caché, o renovando con las credenciales guardadas.</summary>
    public async Task<string?> GetTokenAsync(int userId, CancellationToken ct = default)
    {
        var cached = cache.Get(userId);
        if (cached is not null) return cached;

        var user = await db.Users.FindAsync([userId], ct);
        if (user is null) return null;
        var token = await topband.LoginAsync(user.VontUsername, crypto.Decrypt(user.VontPasswordEnc), ct);
        if (token is not null) cache.Set(userId, token);
        return token;
    }

    public async Task LogAsync(int userId, string device, string action, CancellationToken ct = default)
    {
        static string Cap(string s, int n) => s.Length > n ? s[..n] : s;
        db.ActivityLogs.Add(new ActivityLog
        {
            AppUserId = userId,
            DeviceName = Cap(device, 128),
            Action = Cap(action, 64),
        });
        await db.SaveChangesAsync(ct);
    }
}
