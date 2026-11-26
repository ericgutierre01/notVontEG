namespace VontCasa.Api.Data;

/// <summary>Usuario de la app. Se identifica con su cuenta Vont; guardamos la
/// contraseña Vont cifrada para poder renovar el token contra Topband.</summary>
public class AppUser
{
    public int Id { get; set; }
    public string VontUsername { get; set; } = "";
    public string VontPasswordEnc { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastLoginAt { get; set; } = DateTime.UtcNow;

    public List<ActivityLog> Logs { get; set; } = new();
}

/// <summary>Registro de cada acción de control (auditoría).</summary>
public class ActivityLog
{
    public long Id { get; set; }
    public int AppUserId { get; set; }
    public AppUser? AppUser { get; set; }
    public string DeviceName { get; set; } = "";
    public string Action { get; set; } = "";
    public DateTime At { get; set; } = DateTime.UtcNow;
}

/// <summary>Placa ESP32 de la casa: hace de puente Bluetooth para aparatos sin nube (abanico, tira LED).
/// Se autentica con una clave propia; solo guardamos su hash.</summary>
public class Hub
{
    public int Id { get; set; }
    public int AppUserId { get; set; }
    public AppUser? AppUser { get; set; }
    public string Name { get; set; } = "";
    public string KeyHash { get; set; } = "";
    /// <summary>Código de 6 dígitos para configurar la placa (hash). Se canjea una vez por la clave.</summary>
    public string? ClaimHash { get; set; }
    public DateTime? ClaimExpires { get; set; }
    public DateTime? LastSeen { get; set; }
    /// <summary>MACs de tiras LED que la placa ve cerca (para agregarlas sin teclear la MAC).</summary>
    public string Seen { get; set; } = "";
    public List<HubDevice> Devices { get; set; } = new();
}

/// <summary>Aparato controlado por una placa. Kind: "fan" (receptor ZhiMei) o "strip" (ELK-BLEDOM).
/// El estado es el último que pedimos: estos aparatos no informan el suyo.</summary>
public class HubDevice
{
    public int Id { get; set; }
    public int HubId { get; set; }
    public Hub? Hub { get; set; }
    public string Kind { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Tira: MAC Bluetooth (12 hex).</summary>
    public string? Mac { get; set; }
    /// <summary>Abanico: id e índice del "control" que imitamos (el receptor lo aprende al emparejar).</summary>
    public int RemoteId { get; set; }
    public int RemoteIndex { get; set; } = 1;
    public int TxCount { get; set; }
    public string State { get; set; } = "{}";
}
