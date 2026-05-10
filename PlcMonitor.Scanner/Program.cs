using System;
using System.Collections.Generic;
using PlcMonitor.Scanner;

// Аргументы: projectPath [cachePath]
if (args.Length == 0)
{
    Console.Error.WriteLine("Usage: PlcMonitor.Scanner.exe <projectPath>");
    Environment.Exit(1);
}

var projectPath = args[0];
Console.OutputEncoding = System.Text.Encoding.UTF8;

try
{
    var scanner = new TiaProjectScanner(msg => Console.WriteLine(msg));
    var results = scanner.ScanProject(projectPath);

    var cachePath = ScanCache.GetCachePath(projectPath, "scan");
    var cache = new ScanCache();
    cache.Save(results, cachePath);

    Console.WriteLine($"SCAN_OK:{cachePath}");
    Environment.Exit(0);
}
catch (Exception ex)
{
    Console.Error.WriteLine($"SCAN_ERROR:{ex.Message}");
    Environment.Exit(2);
}