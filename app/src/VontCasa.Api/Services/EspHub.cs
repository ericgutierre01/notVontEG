using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using VontCasa.Api.Data;

namespace VontCasa.Api.Services;

/// <summary>Bytes que emite la placa. Abanico: anuncio BLE del protocolo ZhiMei "fan v0" (el de la app
/// "Zhi Mei Deng Kong", descifrado por el proyecto ha-ble-adv). Tira: comandos ELK-BLEDOM por GATT (FFF3).</summary>
public static class EspCodec
{
    /// <summary>Anuncio completo: flags 0x19 + campo tipo 0x03 con [0x55, índice, tx, id(2, LE), cmd, a0, a1, a2, suma].</summary>
    public static string FanAdv(int remoteId, int index, int tx, byte cmd, byte a0 = 0, byte a1 = 0, byte a2 = 0)
    {
        byte[] body = [0x55, (byte)index, (byte)tx, (byte)remoteId, (byte)(remoteId >> 8), cmd, a0, a1, a2];
        var sum = (byte)body.Sum(b => b);
        return Convert.ToHexString([0x02, 0x01, 0x19, (byte)(body.Length + 2), 0x03, .. body, sum]);
    }

    public static string StripPower(bool on) => on ? "7E0004F00001FF00EF" : "7E0004000000FF00EF";
    public static string StripBrightness(int pct) => $"7E0001{Math.Clamp(pct, 1, 100):X2}00000000EF";
    public static string StripColor(int rgb) => $"7E000503{rgb & 0xFFFFFF:X6}00EF";

    static EspCodec()
    {
        // Vector de prueba de ha-ble-adv (emparejar, id 0xC002, índice 2, tx 18)
        if (FanAdv(0xC002, 2, 18, 0xB4, 0xAA, 0x66, 0x55) != "0201190B0355021202C0B4AA665544")
            throw new InvalidOperationException("EspCodec: el anuncio ZhiMei no coincide con el vector de prueba");
    }
}

/// <summary>Órdenes pendientes por placa. La placa las recoge con una petición larga (long polling).
/// shortcut: en memoria; si IIS recicla el proceso se pierden las órdenes en cola (son de segundos).</summary>
public class HubQueue
{
    readonly ConcurrentDictionary<int, Channel<JsonObject>> _q = new();

    Channel<JsonObject> Of(int hubId) => _q.GetOrAdd(hubId, _ => Channel.CreateBounded<JsonObject>(
        new BoundedChannelOptions(32) { FullMode = BoundedChannelFullMode.DropOldest }));

    public void Push(int hubId, JsonObject cmd) => Of(hubId).Writer.TryWrite(cmd);

    /// <summary>Espera hasta <paramref name="wait"/> la primera orden y devuelve esa más las que ya estén en cola.</summary>
    public async Task<List<JsonObject>> TakeAsync(int hubId, TimeSpan wait, CancellationToken ct)
    {
        var ch = Of(hubId);
        var list = new List<JsonObject>();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(wait);
        try { if (await ch.Reader.WaitToReadAsync(cts.Token)) while (list.Count < 8 && ch.Reader.TryRead(out var c)) list.Add(c); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        return list;
    }
}

/// <summary>Aparatos de las placas presentados como los de Topband (id "esp-N", data points), para que la
/// app y el resto del API los traten igual.</summary>
public class EspDeviceService(AppDbContext db, HubQueue queue)
{
    public const string Prefix = "esp-";
    public static readonly TimeSpan OnlineWindow = TimeSpan.FromSeconds(60);

    public static bool IsEsp(string id) => id.StartsWith(Prefix, StringComparison.Ordinal);

    public static string NewKey() => Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    public static string Hash(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));

    public static readonly TimeSpan ClaimTtl = TimeSpan.FromMinutes(30);

    /// <summary>Nuevo código de configuración (6 dígitos) para la placa; la clave anterior deja de valer al canjearlo.</summary>
    public static string NewClaim(Hub h)
    {
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        h.ClaimHash = Hash(code);
        h.ClaimExpires = DateTime.UtcNow + ClaimTtl;
        return code;
    }

    public static bool HubOnline(Hub h) => h.LastSeen is { } t && DateTime.UtcNow - t < OnlineWindow;

    static int? ParseId(string id) => IsEsp(id) && int.TryParse(id[Prefix.Length..], out var n) ? n : null;

    public Task<HubDevice?> FindAsync(int userId, string id, CancellationToken ct) =>
        ParseId(id) is { } n
            ? db.HubDevices.Include(d => d.Hub).FirstOrDefaultAsync(d => d.Id == n && d.Hub!.AppUserId == userId, ct)
            : Task.FromResult<HubDevice?>(null);

    public async Task<List<TopbandService.DeviceDetail>> ListAsync(int userId, CancellationToken ct) =>
        (await db.HubDevices.Include(d => d.Hub).Where(d => d.Hub!.AppUserId == userId).OrderBy(d => d.Id).ToListAsync(ct))
        .Select(ToDetail).ToList();

    // Tipos de data point como en Topband: 9 = bool, 2 = entero
    static TopbandService.DataPoint B(JsonObject s, string k) => new(0, 9, (s[k]?.GetValue<bool>() ?? false) ? "true" : "false");
    static TopbandService.DataPoint I(JsonObject s, string k, int def) => new(0, 2, (s[k]?.GetValue<int>() ?? def).ToString());

    public static TopbandService.DeviceDetail ToDetail(HubDevice d)
    {
        var s = JsonNode.Parse(d.State) as JsonObject ?? new JsonObject();
        var points = d.Kind == "fan"
            ? new Dictionary<string, TopbandService.DataPoint>
            {
                // "encendido" de la tarjeta = luz o aspas en marcha
                ["power_onoff"] = new(0, 9, ((s["light"]?.GetValue<bool>() ?? false) || (s["fan_speed"]?.GetValue<int>() ?? 0) > 0) ? "true" : "false"),
                ["light"] = B(s, "light"), ["fan_speed"] = I(s, "fan_speed", 0),
                ["fan_reverse"] = B(s, "fan_reverse"), ["breeze"] = B(s, "breeze"),
            }
            : new Dictionary<string, TopbandService.DataPoint>
            {
                ["power_onoff"] = B(s, "power_onoff"), ["brightness"] = I(s, "brightness", 100),
                ["color_data"] = I(s, "color_data", 0xFFFFFF),
            };
        return new TopbandService.DeviceDetail(Prefix + d.Id, d.Name, d.Kind == "fan" ? "ESP-FAN" : "ESP-STRIP",
            "esp", d.Hub?.Name ?? "", d.Hub is { } h && HubOnline(h), null, null, points, d.Mac, null);
    }

    static readonly HashSet<string> FanPoints = ["power_onoff", "light", "fan_speed", "fan_reverse", "breeze"];
    static readonly HashSet<string> StripPoints = ["power_onoff", "brightness", "color_data"];

    /// <summary>Traduce los data points pedidos a órdenes para la placa y guarda el nuevo estado.
    /// Devuelve un error legible, o null si todo bien.</summary>
    public async Task<string?> ApplyAsync(HubDevice d, IEnumerable<(string Name, JsonNode Value)> points, CancellationToken ct)
    {
        var s = JsonNode.Parse(d.State) as JsonObject ?? new JsonObject();
        var cmds = new List<JsonObject>();
        var allowed = d.Kind == "fan" ? FanPoints : StripPoints;
        try
        {
            foreach (var (name, value) in points)
            {
                if (!allowed.Contains(name)) return $"este aparato no soporta: {name}";
                var c = d.Kind == "fan" ? Fan(d, s, name, value) : Strip(d, s, name, value);
                c["l"] = $"{d.Name}: {Label(name, value)}"; // lo muestra la pantalla de la placa
                cmds.Add(c);
            }
        }
        catch (Exception e) when (e is FormatException or InvalidOperationException or OverflowException or ArgumentException)
        { return "valor inválido"; }

        d.State = s.ToJsonString();
        await db.SaveChangesAsync(ct);
        foreach (var c in cmds) queue.Push(d.HubId, c);
        return null;
    }

    static string Label(string name, JsonNode v) => name switch
    {
        "power_onoff" => AsBool(v) ? "encender" : "apagar",
        "light" => AsBool(v) ? "luz on" : "luz off",
        "fan_speed" => AsInt(v) == 0 ? "aspas off" : $"vel. {AsInt(v)}",
        "fan_reverse" => AsBool(v) ? "reversa" : "normal",
        "breeze" => AsBool(v) ? "brisa on" : "brisa off",
        "brightness" => $"brillo {AsInt(v)}%",
        _ => $"color #{AsInt(v):X6}",
    };

    static bool AsBool(JsonNode v) => (bool)TopbandService.EncodeValue(9, v);
    static int AsInt(JsonNode v) => checked((int)(long)TopbandService.EncodeValue(2, v));

    static JsonObject Adv(HubDevice d, byte cmd, byte a0 = 0, byte a1 = 0, byte a2 = 0, int ms = 1200)
    {
        d.TxCount = d.TxCount % 125 + 1; // el receptor ignora un tx repetido
        return new JsonObject { ["t"] = "adv", ["d"] = EspCodec.FanAdv(d.RemoteId, d.RemoteIndex, d.TxCount, cmd, a0, a1, a2), ["ms"] = ms };
    }

    static JsonObject Fan(HubDevice d, JsonObject s, string name, JsonNode v)
    {
        switch (name)
        {
            case "power_onoff":
                if (AsBool(v)) { s["light"] = true; return Adv(d, 0xA6, 2); }
                s["light"] = false; s["fan_speed"] = 0; s["breeze"] = false;
                return Adv(d, 0xB2); // apaga luz y aspas
            case "light":
                var on = AsBool(v); s["light"] = on; return Adv(d, 0xA6, (byte)(on ? 2 : 1));
            case "fan_speed":
                var n = AsInt(v);
                if (n is < 0 or > 6) throw new ArgumentException("velocidad 0-6");
                s["fan_speed"] = n; s["breeze"] = false;
                return n == 0 ? Adv(d, 0xD1) : Adv(d, 0xD3, (byte)n);
            case "fan_reverse":
                var rev = AsBool(v); s["fan_reverse"] = rev; return Adv(d, rev ? (byte)0xDA : (byte)0xD9);
            default: // breeze
                var br = AsBool(v); s["breeze"] = br;
                var speed = Math.Max(s["fan_speed"]?.GetValue<int>() ?? 0, 1);
                if (br) s["fan_speed"] = speed;
                return br ? Adv(d, 0xDB) : Adv(d, 0xD3, (byte)speed);
        }
    }

    static JsonObject Strip(HubDevice d, JsonObject s, string name, JsonNode v)
    {
        string hex;
        switch (name)
        {
            case "power_onoff": var on = AsBool(v); s["power_onoff"] = on; hex = EspCodec.StripPower(on); break;
            case "brightness":
                var b = AsInt(v); if (b is < 1 or > 100) throw new ArgumentException("brillo 1-100");
                s["brightness"] = b; hex = EspCodec.StripBrightness(b); break;
            default:
                var c = AsInt(v); if (c is < 0 or > 0xFFFFFF) throw new ArgumentException("color");
                s["color_data"] = c; hex = EspCodec.StripColor(c); break;
        }
        return new JsonObject { ["t"] = "gatt", ["m"] = d.Mac, ["d"] = hex };
    }

    /// <summary>Emite la orden de emparejar durante 60 s: hay que darle corriente al receptor mientras tanto.</summary>
    public async Task PairAsync(HubDevice d, CancellationToken ct)
    {
        var c = Adv(d, 0xB4, 0xAA, 0x66, 0x55, ms: 60_000);
        c["l"] = $"{d.Name}: emparejando 60 s";
        await db.SaveChangesAsync(ct);
        queue.Push(d.HubId, c);
    }
}
