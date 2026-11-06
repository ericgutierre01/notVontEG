using Microsoft.EntityFrameworkCore;

namespace VontCasa.Api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<ActivityLog> ActivityLogs => Set<ActivityLog>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<AppUser>().HasIndex(u => u.VontUsername).IsUnique();
        b.Entity<AppUser>().Property(u => u.VontUsername).HasMaxLength(256);
        b.Entity<ActivityLog>().Property(l => l.DeviceName).HasMaxLength(128);
        b.Entity<ActivityLog>().Property(l => l.Action).HasMaxLength(64);
    }
}
