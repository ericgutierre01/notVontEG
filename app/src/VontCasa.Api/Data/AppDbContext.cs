using Microsoft.EntityFrameworkCore;

namespace VontCasa.Api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<ActivityLog> ActivityLogs => Set<ActivityLog>();
    public DbSet<Hub> Hubs => Set<Hub>();
    public DbSet<HubDevice> HubDevices => Set<HubDevice>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<AppUser>().HasIndex(u => u.VontUsername).IsUnique();
        b.Entity<AppUser>().Property(u => u.VontUsername).HasMaxLength(256);
        b.Entity<ActivityLog>().Property(l => l.DeviceName).HasMaxLength(128);
        b.Entity<ActivityLog>().Property(l => l.Action).HasMaxLength(64);
        b.Entity<Hub>().Property(h => h.Name).HasMaxLength(64);
        b.Entity<Hub>().Property(h => h.KeyHash).HasMaxLength(64);
        b.Entity<Hub>().HasIndex(h => h.KeyHash).IsUnique();
        b.Entity<Hub>().Property(h => h.Seen).HasMaxLength(512);
        b.Entity<Hub>().Property(h => h.ClaimHash).HasMaxLength(64);
        b.Entity<HubDevice>().Property(d => d.Kind).HasMaxLength(16);
        b.Entity<HubDevice>().Property(d => d.Name).HasMaxLength(64);
        b.Entity<HubDevice>().Property(d => d.Mac).HasMaxLength(12);
        b.Entity<HubDevice>().Property(d => d.State).HasMaxLength(512);
    }
}
