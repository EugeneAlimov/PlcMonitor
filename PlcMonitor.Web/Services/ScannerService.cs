using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using PlcMonitor.Scanner;
using System.IO;
using System.Linq; 

namespace PlcMonitor.Web.Services
{
    public class ScannerService
    {
        private readonly TiaProjectScanner _scanner;
        private readonly ScanCache _cache;
        public ScanStatus Status { get; private set; } = new();

        public ScannerService()
        {
            _scanner = new TiaProjectScanner(msg =>
            {
                Status.LastMessage = msg;
                Status.Log.Add($"{DateTime.Now:HH:mm:ss} {msg}");
                if (Status.Log.Count > 200) Status.Log.RemoveAt(0);
            });
            _cache = new ScanCache();
        }

public Task<List<PlcScanResult>> ScanAsync(string projectPath)
{
    Status = new ScanStatus { IsRunning = true, ProjectPath = projectPath };
    Status.Log.Add($"{DateTime.Now:HH:mm:ss} Начинаем сканирование: {projectPath}");

    return Task.Run(() =>
    {
        try
        {
            // Ищем PlcMonitor.Scanner.exe рядом с нашим exe
            var scannerExe = System.IO.Path.Combine(
                System.IO.Path.GetDirectoryName(
                    System.Reflection.Assembly.GetExecutingAssembly().Location),
                "PlcMonitor.Scanner.exe");

            if (!System.IO.File.Exists(scannerExe))
                throw new FileNotFoundException(
                    $"Не найден PlcMonitor.Scanner.exe: {scannerExe}");

            Status.Log.Add($"{DateTime.Now:HH:mm:ss} Запускаем сканер...");

            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName               = scannerExe,
                Arguments              = $"\"{projectPath}\"",
                UseShellExecute        = false,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                CreateNoWindow         = true
            };

            string cachePath = null;
            var proc = System.Diagnostics.Process.Start(psi);

            proc.OutputDataReceived += (s, e) =>
            {
                if (string.IsNullOrEmpty(e.Data)) return;
                if (e.Data.StartsWith("SCAN_OK:"))
                    cachePath = e.Data.Substring(8);
                else
                    Status.Log.Add($"{DateTime.Now:HH:mm:ss} {e.Data}");
                if (Status.Log.Count > 200) Status.Log.RemoveAt(0);
                Status.LastMessage = e.Data;
            };

            proc.ErrorDataReceived += (s, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    Status.Log.Add($"{DateTime.Now:HH:mm:ss} ОШИБКА: {e.Data}");
            };

            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            proc.WaitForExit();

            if (proc.ExitCode != 0)
                throw new Exception(Status.Log.LastOrDefault() ?? "Сканирование завершилось с ошибкой");

            // Читаем результат из кэша
            var loadResult = _cache.Load(cachePath, projectPath);
            Status.IsRunning  = false;
            Status.IsComplete = true;
            Status.Results    = loadResult.Results;
            Status.Log.Add($"{DateTime.Now:HH:mm:ss} Готово.");
            return loadResult.Results;
        }
        catch (Exception ex)
        {
            Status.IsRunning = false;
            Status.Error = ex.Message;
            Status.Log.Add($"{DateTime.Now:HH:mm:ss} ОШИБКА: {ex.Message}");
            throw;
        }
    });
}
        public CacheLoadResult TryLoadCache(string projectPath)
        {
            var cachePath = ScanCache.GetCachePath(projectPath, "scan");
            return _cache.Load(cachePath, projectPath);
        }
    }

    public class ScanStatus
    {
        public bool IsRunning { get; set; }
        public bool IsComplete { get; set; }
        public string ProjectPath { get; set; }
        public string LastMessage { get; set; }
        public string Error { get; set; }
        public List<string> Log { get; set; } = new();
        public List<PlcScanResult> Results { get; set; }
    }
}
