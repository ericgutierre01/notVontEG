using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MQTTnet;
using MQTTnet.Formatter;

namespace VontCasa.Api.Services;

/// <summary>
/// Cliente de la nube Topband T-Smart (marca Vont). Protocolo extraído del APK
/// com.vont.smartlight. Login REST con token + control por MQTT/TLS publicando
/// data points. Ver PROTOCOL.md del repo vont-alexa-bridge para el detalle.
/// </summary>
public class TopbandService(HttpClient http, ILogger<TopbandService> log)
{
    const string CompanyId = "e1288ab93107470daf3f7bc3499654d9";
    const string ProjectId = "6512219a33df427cbd59ea300818701c";
    const string UserApi = "https://us-tsmart-user-api.topband-cloud.com/tsmart-user-api";
    const string DeviceApi = "https://us-tsmart-device-api.topband-cloud.com/tsmart-device-api";
    const string MqttHost = "us-tsmart-mqtt.topband-cloud.com";
    const int MqttPort = 8883;

    // Tipos de data point (DataTypeEnum del APK)
    const int TypeBool = 9, TypeByte = 1, TypeInt = 5;

    // Valida productId/uid antes de meterlos en el topic MQTT (evita inyección)
    static readonly Regex IdRe = new("^[A-Za-z0-9]{1,64}$", RegexOptions.Compiled);

    static string Md5(string s) =>
        Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    HttpRequestMessage Req(HttpMethod m, string url, object body, string? token = null)
    {
        var r = new HttpRequestMessage(m, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };
        r.Headers.Add("App-Project-Id", ProjectId);
        r.Headers.Add("Accept-Language", "en-US");
        if (token is not null) r.Headers.Add("Authorization", token);
        return r;
    }

    /// <summary>Inicia sesión en Topband. Devuelve el token (o null si credenciales inválidas).</summary>
    public async Task<string?> LoginAsync(string username, string password, CancellationToken ct = default)
    {
        var body = new { userName = username, password = Md5(password), companyId = CompanyId };
        using var resp = await http.SendAsync(Req(HttpMethod.Post, UserApi + "/appLogin/v2/login", body), ct);
        var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
        var token = json?["data"]?["token"]?.GetValue<string>() ?? json?["token"]?.GetValue<string>();
        if (string.IsNullOrEmpty(token))
            log.LogWarning("Login Topband sin token (status {Status})", (int)resp.StatusCode);
        return token;
    }

    // Registro y recuperación (sin token). type: 0 = crear cuenta, 2 = olvidé contraseña.
    // Devuelve el status de Topband (0 = ok; 200110 no existe, 200112 ya existe, 200116 código malo) y su mensaje.
    public async Task<(int Status, string? Message)> AccountCallAsync(string path, object body, CancellationToken ct)
    {
        using var resp = await http.SendAsync(Req(HttpMethod.Post, UserApi + path, body), ct);
        var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
        var status = json?["status"]?.GetValue<int>() ?? -1;
        if (status != 0) log.LogInformation("Topband {Path} status {Status}", path, status);
        return (status, json?["message"]?.GetValue<string>());
    }

    public Task<(int, string?)> SendCodeAsync(string user, int type, CancellationToken ct) =>
        AccountCallAsync("/code/v2/getCode", new { userName = user, companyId = CompanyId, type }, ct);

    public async Task<(int, string?)> RegisterAsync(string user, string password, string code, CancellationToken ct)
    {
        var check = await AccountCallAsync("/code/v2/checkCode", new { userName = user, code, companyId = CompanyId, type = 0 }, ct);
        if (check.Item1 != 0) return check;
        return await AccountCallAsync("/account/v2/regist",
            new { userName = user, code, os = "android", password = Md5(password), companyId = CompanyId }, ct);
    }

    public async Task<(int, string?)> ResetPasswordAsync(string user, string password, string code, CancellationToken ct)
    {
        var check = await AccountCallAsync("/code/v2/checkCode", new { userName = user, code, companyId = CompanyId, type = 2 }, ct);
        if (check.Item1 != 0) return check;
        return await AccountCallAsync("/account/v2/modifyPwdByCode", new { userName = user, code, password = Md5(password) }, ct);
    }

    public record Profile(string? Email, string? UserName, string? Photo);

    /// <summary>Perfil de la cuenta (/account/v2/getSelfInfo): correo, nombre y foto (headImgUrl).</summary>
    public async Task<Profile?> GetProfileAsync(string token, CancellationToken ct = default)
    {
        var d = (await PostAsync(UserApi + "/account/v2/getSelfInfo", new { }, token, ct))?["data"];
        if (d is null) return null;
        string? S(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;
        return new Profile(S(d["email"]), S(d["userName"]), S(d["appUserInfo"]?["headImgUrl"]));
    }

    /// <summary>Cambia el nickname (lo que getSelfInfo devuelve como userName); el correo de login no cambia.</summary>
    public async Task<bool> SetNicknameAsync(string token, string nickName, CancellationToken ct = default) =>
        (await PostAsync(UserApi + "/account/v2/editAccountInfo", new { nickName }, token, ct))?["status"]?.GetValue<int>() == 0;

    /// <summary>Sube la foto de perfil (base64 sin prefijo, como la app). Devuelve la URL nueva o null.</summary>
    public async Task<string?> SetAvatarAsync(string token, byte[] image, CancellationToken ct = default)
    {
        var json = await PostAsync(UserApi + "/account/v2/headImg", new { headImage = Convert.ToBase64String(image) }, token, ct);
        if (json?["status"]?.GetValue<int>() != 0) { log.LogWarning("headImg status {S}", json?["status"]); return null; }
        return json?["data"]?["url"]?.GetValue<string>();
    }

    public record Device(string Id, string Name, string Model, string ProductId, string Uid, bool IsBulb);

    public async Task<List<Device>> GetDevicesAsync(string token, CancellationToken ct = default)
    {
        using var resp = await http.SendAsync(Req(HttpMethod.Post, DeviceApi + "/device/all", new { }, token), ct);
        var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
        var rows = json?["data"]?["rows"] as JsonArray ?? new JsonArray();
        var list = new List<Device>();
        foreach (var d in rows)
        {
            var model = d?["model"]?.GetValue<string>() ?? "";
            list.Add(new Device(
                d?["id"]?.GetValue<string>() ?? "",
                d?["deviceName"]?.GetValue<string>() ?? "Vont",
                model,
                d?["productId"]?.GetValue<string>() ?? "",
                d?["gatewayUid"]?.GetValue<string>() ?? "",
                model.StartsWith("SLB", StringComparison.OrdinalIgnoreCase)));
        }
        return list;
    }

    /// <summary>Data point del aparato: índice, tipo (DataTypeEnum) y valor actual (texto).</summary>
    public record DataPoint(int Index, int Type, string? Value);

    public record DeviceDetail(
        string Id, string Name, string Model, string ProductId, string Uid,
        bool Online, int? Signal, string? Firmware, Dictionary<string, DataPoint> Points, string? Mac, DateTime? Changed);

    /// <summary>Detalle con estado real: online, señal, firmware y valores actuales de cada data point.</summary>
    public async Task<DeviceDetail?> GetDetailAsync(string token, string deviceId, CancellationToken ct = default)
    {
        using var resp = await http.SendAsync(
            Req(HttpMethod.Post, DeviceApi + "/device/v2/detail", new { deviceId }, token), ct);
        var data = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct))?["data"];
        if (data is null) return null;
        var f = data["deviceFields"];
        var points = new Dictionary<string, DataPoint>();
        if (data["pointDataMap"] is JsonObject map)
            foreach (var (name, p) in map)
            {
                if (p is null) continue;
                points[name] = new DataPoint(
                    p["pointIndex"]?.GetValue<int>() ?? 0,
                    p["pointType"]?.GetValue<int>() ?? 0,
                    p["value"]?.ToString());
            }
        var versions = data["deviceVersions"] as JsonArray;
        return new DeviceDetail(
            deviceId,
            data["deviceName"]?.GetValue<string>() ?? "Vont",
            data["model"]?.GetValue<string>() ?? "",
            f?["productId"]?.GetValue<string>() ?? "",
            f?["uid"]?.GetValue<string>() ?? "",
            (f?["online"]?.GetValue<int>() ?? 0) == 1,
            f?["signal"]?.GetValue<int>(),
            versions?.FirstOrDefault()?["softwareVersion"]?.GetValue<string>(),
            points,
            // MAC del Bluetooth: con ella la app reconoce el aparato al cambiarle el Wi-Fi
            NormalizeMac((f?["extAddr"] ?? data["extAddr"])?.ToString() ?? ""),
            // Último cambio que reportó el aparato (UTC). La nube tarda minutos en marcarlo offline: esto distingue
            // un "online" viejo de uno nuevo al emparejar.
            DateTime.TryParse((f?["updateTime"] ?? data["updateTime"])?.ToString(), CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var ch) ? ch : null);
    }

    static readonly Regex HexRe = new("^[0-9A-Fa-f]{0,512}$", RegexOptions.Compiled);

    /// <summary>Convierte el valor según el tipo del data point:
    /// BOOL(9)→true/false, BYTE_ARRAY(8)→hex, numéricos→entero.</summary>
    public static object EncodeValue(int type, JsonNode value) => type switch
    {
        9 => value.GetValueKind() == JsonValueKind.True
             || (value.GetValueKind() == JsonValueKind.String && value.GetValue<string>() is "true" or "1"),
        8 => value.GetValue<string>() is var hex && HexRe.IsMatch(hex) && hex.Length % 2 == 0
             ? hex.ToUpperInvariant() : throw new FormatException("hex inválido"),
        _ => value.GetValueKind() == JsonValueKind.String
             ? long.Parse(value.GetValue<string>())
             : value.GetValue<long>(),
    };

    /// <summary>Envía uno o varios data points en un solo comando (escenas y modo blanco lo necesitan).</summary>
    public Task SendDpsAsync(string token, string productId, string uid,
        IEnumerable<(int Index, int Type, JsonNode Value)> points, CancellationToken ct = default) =>
        PublishAsync(token, productId, uid,
            points.Select(p => (object)new { i = p.Index, t = p.Type, v = EncodeValue(p.Type, p.Value) }).ToArray(), ct);

    async Task<JsonNode?> PostAsync(string url, object body, string token, CancellationToken ct)
    {
        using var resp = await http.SendAsync(Req(HttpMethod.Post, url, body, token), ct);
        return JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
    }

    /// <summary>Id de la "familia" (hogar) de la cuenta; lo exigen renombrar y desvincular.</summary>
    async Task<string?> GetFamilyIdAsync(string token, CancellationToken ct) =>
        (await PostAsync(UserApi + "/family/list", new { }, token, ct))?["data"]?[0]?["id"]?.ToString();

    public async Task<bool> RenameAsync(string token, string deviceId, string name, CancellationToken ct = default)
    {
        var familyId = await GetFamilyIdAsync(token, ct);
        var json = await PostAsync(DeviceApi + "/device/name/modify",
            new { familyId, deviceId, deviceName = name }, token, ct);
        return json?["status"]?.GetValue<int>() == 0;
    }

    /// <summary>Códigos de producto del anuncio BLE → productId de Topband (de /device/app_product_category/list).</summary>
    public static readonly Dictionary<int, (string ProductId, string Name)> Catalog = new()
    {
        [100108] = ("2cfe78a968a549f1a4591b4fd9e2965e", "Bombillo color (SLB01/02/03)"),
        [100223] = ("6ad269d0b5e24e8f875a69f95926d26d", "Bombillo color Pro (SLB04)"),
        [300020] = ("4d453c7de94b4d5991a4a5507459a527", "Enchufe (SP01)"),
    };

    /// <summary>Topband da sus archivos en http (se bloquearían en la app con HTTPS); su servidor también sirve https.</summary>
    public static string? Https(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme is "https" or "http"
            ? new UriBuilder(u) { Scheme = "https", Port = -1 }.Uri.ToString() : null;

    /// <summary>Foto de cada producto según la nube (/device/app_product_category/list), por productCode.</summary>
    public async Task<Dictionary<int, string?>> GetProductImagesAsync(string token, CancellationToken ct = default)
    {
        var res = new Dictionary<int, string?>();
        void Walk(JsonNode? n)
        {
            if (n is JsonArray a) { foreach (var x in a) Walk(x); return; }
            if (n is not JsonObject o) return;
            if (int.TryParse(o["productCode"]?.ToString(), out var code) && Catalog.ContainsKey(code) && !res.ContainsKey(code))
                res[code] = o["image"]?.ToString();
            foreach (var (_, v) in o) Walk(v);
        }
        Walk((await PostAsync(DeviceApi + "/device/app_product_category/list", new { }, token, ct))?["data"]);
        return res;
    }

    static readonly Regex MacRe = new("^[0-9a-f]{12}$", RegexOptions.Compiled);

    /// <summary>uid con el que la nube identifica al aparato: MD5(productId + mac), en minúsculas.</summary>
    public static string UidFor(string productId, string mac) => Md5(productId.ToLowerInvariant() + mac);

    public static string? NormalizeMac(string mac)
    {
        var m = mac.Replace(":", "").Replace("-", "").Trim().ToLowerInvariant();
        return MacRe.IsMatch(m) ? m : null;
    }

    public record BindResult(bool Ok, string? Uid, string? Error);

    /// <summary>Vincula un aparato recién emparejado a la familia (antes de mandarle el Wi-Fi, como la app).</summary>
    public async Task<BindResult> BindAsync(string token, string productId, string mac, CancellationToken ct = default)
    {
        var uid = UidFor(productId, mac);
        var familyId = await GetFamilyIdAsync(token, ct);
        // La app exige ubicación; Topband acepta cualquier coordenada válida.
        var json = await PostAsync(DeviceApi + "/family/device/bind/v2",
            new { familyId, uid, checkOnline = 0, longitude = 0.0, latitude = 0.0 }, token, ct);
        var status = json?["status"]?.GetValue<int>();
        if (status == 0) return new BindResult(true, uid, null);
        // 200215 = ya vinculado. Si es a esta misma cuenta (re-emparejar uno tuyo), no es error: se sigue con el Wi-Fi.
        if (status == 200215)
            return (await GetDevicesAsync(token, ct)).Any(d => d.Uid == uid)
                ? new BindResult(true, uid, null)
                : new BindResult(false, uid, "Ese aparato está vinculado a otra cuenta de Vont. Hay que quitarlo de esa cuenta primero.");
        // Mensaje único al cliente (no revelar si existe o de quién es); el detalle va al log.
        log.LogWarning("Bind rechazado por Topband: {Status} {Message}", status, json?["message"]?.ToString());
        return new BindResult(false, uid,
            "No se pudo vincular. Revisa el tipo y la MAC, y que el aparato no esté en otra cuenta.");
    }

    /// <summary>Desvincula el aparato de la cuenta. Irreversible sin re-emparejar con la app Vont.</summary>
    public async Task<bool> UnbindAsync(string token, string uid, CancellationToken ct = default)
    {
        var familyId = await GetFamilyIdAsync(token, ct);
        var json = await PostAsync(DeviceApi + "/family/device/unbind/v2", new { familyId, uid }, token, ct);
        return json?["status"]?.GetValue<int>() == 0;
    }

    // --------------------------- control por MQTT ---------------------------
    async Task PublishAsync(string token, string productId, string uid, object[] attrs, CancellationToken ct)
    {
        if (!IdRe.IsMatch(productId) || !IdRe.IsMatch(uid))
            throw new ArgumentException("productId/uid inválidos");
        var payload = new
        {
            method = "command",
            common = new
            {
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                serial = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "01",
                productId,
                uid,
            },
            data = new[] { new { mac = "", cmd = 99, command = attrs } },
        };
        var factory = new MqttClientFactory();
        using var client = factory.CreateMqttClient();
        var opts = new MqttClientOptionsBuilder()
            .WithProtocolVersion(MqttProtocolVersion.V311)
            .WithTcpServer(MqttHost, MqttPort)
            .WithClientId("vb-" + Guid.NewGuid().ToString("N")[..16]) // id aleatorio no-vacío
            .WithCredentials("app/" + token, token)
            .WithTlsOptions(o => o.UseTls())
            .Build();
        await client.ConnectAsync(opts, ct);
        var topic = $"{productId}/{uid}/download/point/data";
        await client.PublishAsync(new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(JsonSerializer.Serialize(payload))
            .Build(), ct);
        await Task.Delay(400, ct); // deja salir el paquete QoS0 antes de cerrar
        await client.DisconnectAsync();
    }

    public Task SetPowerAsync(string token, string productId, string uid, bool on, CancellationToken ct = default) =>
        PublishAsync(token, productId, uid, [new { i = 1, t = TypeBool, v = on }], ct);

    public Task SetBrightnessAsync(string token, string productId, string uid, int pct, CancellationToken ct = default) =>
        PublishAsync(token, productId, uid, [new { i = 7, t = TypeByte, v = Math.Clamp(pct, 0, 100) }], ct);

    public Task SetColorAsync(string token, string productId, string uid, int r, int g, int b, CancellationToken ct = default) =>
        PublishAsync(token, productId, uid,
            [new { i = 6, t = TypeInt, v = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255) }], ct);
}
