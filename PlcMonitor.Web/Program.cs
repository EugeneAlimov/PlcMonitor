using System;
using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using PlcMonitor.Web.Hubs;
using PlcMonitor.Web.Services;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.UseUrls("http://localhost:5000");

builder.Services.AddControllers();
builder.Services.AddSignalR();
builder.Services.AddSingleton<ScannerService>();
builder.Services.AddSingleton<ProjectService>();
builder.Services.AddSingleton<LiveDataService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveDataService>());
builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

var app = builder.Build();

app.UseDefaultFiles();   // index.html по умолчанию
app.UseStaticFiles();    // статические файлы из wwwroot
app.UseCors();
app.UseRouting();
app.MapControllers();
app.MapHub<LiveDataHub>("/ws/live");

var url = "http://localhost:5000";
Console.WriteLine($"Сервер запущен: {url}");
Console.WriteLine("Ctrl+C для остановки");

try
{
    Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
}
catch { }

app.Run();