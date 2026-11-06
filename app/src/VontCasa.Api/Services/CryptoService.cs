using System.Security.Cryptography;
using System.Text;

namespace VontCasa.Api.Services;

/// <summary>Cifra/descifra la contraseña de Vont en reposo (AES-GCM). La clave
/// viene de configuración (Security:EncryptionKey, 32 bytes base64).</summary>
public class CryptoService
{
    readonly byte[] _key;

    public CryptoService(IConfiguration cfg)
    {
        var b64 = cfg["Security:EncryptionKey"]
            ?? throw new InvalidOperationException("Falta Security:EncryptionKey");
        _key = Convert.FromBase64String(b64);
        if (_key.Length != 32) throw new InvalidOperationException("EncryptionKey debe ser 32 bytes base64");
    }

    public string Encrypt(string plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[data.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, data, cipher, tag);
        return $"{Convert.ToBase64String(nonce)}.{Convert.ToBase64String(cipher)}.{Convert.ToBase64String(tag)}";
    }

    public string Decrypt(string enc)
    {
        var parts = enc.Split('.');
        var nonce = Convert.FromBase64String(parts[0]);
        var cipher = Convert.FromBase64String(parts[1]);
        var tag = Convert.FromBase64String(parts[2]);
        var plain = new byte[cipher.Length];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(nonce, cipher, tag, plain);
        return Encoding.UTF8.GetString(plain);
    }
}
