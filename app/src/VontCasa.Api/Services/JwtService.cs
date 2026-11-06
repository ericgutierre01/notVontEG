using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace VontCasa.Api.Services;

public class JwtService(IConfiguration cfg)
{
    public string Issue(int userId, string vontUsername)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(
            cfg["Security:JwtKey"] ?? throw new InvalidOperationException("Falta Security:JwtKey")));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            claims: [new Claim(ClaimTypes.NameIdentifier, userId.ToString()),
                     new Claim(ClaimTypes.Name, vontUsername)],
            expires: DateTime.UtcNow.AddDays(30),
            signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
