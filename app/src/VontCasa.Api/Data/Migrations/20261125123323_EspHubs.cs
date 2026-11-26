using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VontCasa.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class EspHubs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Hubs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    AppUserId = table.Column<int>(type: "int", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    KeyHash = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    LastSeen = table.Column<DateTime>(type: "datetime2", nullable: true),
                    Seen = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Hubs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Hubs_Users_AppUserId",
                        column: x => x.AppUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "HubDevices",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    HubId = table.Column<int>(type: "int", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Mac = table.Column<string>(type: "nvarchar(12)", maxLength: 12, nullable: true),
                    RemoteId = table.Column<int>(type: "int", nullable: false),
                    RemoteIndex = table.Column<int>(type: "int", nullable: false),
                    TxCount = table.Column<int>(type: "int", nullable: false),
                    State = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HubDevices", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HubDevices_Hubs_HubId",
                        column: x => x.HubId,
                        principalTable: "Hubs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_HubDevices_HubId",
                table: "HubDevices",
                column: "HubId");

            migrationBuilder.CreateIndex(
                name: "IX_Hubs_AppUserId",
                table: "Hubs",
                column: "AppUserId");

            migrationBuilder.CreateIndex(
                name: "IX_Hubs_KeyHash",
                table: "Hubs",
                column: "KeyHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "HubDevices");

            migrationBuilder.DropTable(
                name: "Hubs");
        }
    }
}
