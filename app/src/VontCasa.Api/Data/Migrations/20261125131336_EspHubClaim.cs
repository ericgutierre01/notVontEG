using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VontCasa.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class EspHubClaim : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "ClaimExpires",
                table: "Hubs",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ClaimHash",
                table: "Hubs",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ClaimExpires",
                table: "Hubs");

            migrationBuilder.DropColumn(
                name: "ClaimHash",
                table: "Hubs");
        }
    }
}
