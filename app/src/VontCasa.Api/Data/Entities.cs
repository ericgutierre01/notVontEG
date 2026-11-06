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
