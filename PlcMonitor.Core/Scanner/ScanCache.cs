using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace PlcMonitor.Scanner
{
    public class ScanCache
    {
        // Метод вместо статического поля — устраняет TypeInitializationException
        private static JsonSerializerSettings MakeSettings() => new JsonSerializerSettings
        {
            Formatting        = Formatting.Indented,
            NullValueHandling = NullValueHandling.Ignore,
            Converters        = { new StringEnumConverter() }
        };

        public void Save(List<PlcScanResult> results, string cacheFilePath)
        {
            var dir = Path.GetDirectoryName(cacheFilePath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            var json = JsonConvert.SerializeObject(results, MakeSettings());
            File.WriteAllText(cacheFilePath, json, System.Text.Encoding.UTF8);
        }

        public CacheLoadResult Load(string cacheFilePath, string projectPath)
        {
            if (!File.Exists(cacheFilePath))
                return new CacheLoadResult { Status = CacheStatus.NotFound };
            try
            {
                var json    = File.ReadAllText(cacheFilePath, System.Text.Encoding.UTF8);
                var results = JsonConvert.DeserializeObject<List<PlcScanResult>>(json, MakeSettings());
                if (results == null || results.Count == 0)
                    return new CacheLoadResult { Status = CacheStatus.NotFound };

                var projectModified = File.GetLastWriteTime(projectPath);
                var cachedModified  = results[0].ProjectModified;
                var status = projectModified > cachedModified
                    ? CacheStatus.Stale
                    : CacheStatus.Valid;

                return new CacheLoadResult
                {
                    Status          = status,
                    Results         = results,
                    ProjectModified = projectModified,
                    CachedModified  = cachedModified
                };
            }
            catch (Exception ex)
            {
                return new CacheLoadResult { Status = CacheStatus.Error, Message = ex.Message };
            }
        }

        public static string GetCachePath(string projectPath, string plcName)
        {
            var dir      = Path.GetDirectoryName(projectPath);
            var projName = Path.GetFileNameWithoutExtension(projectPath);
            return Path.Combine(dir, ".plcmonitor", $"{projName}_{plcName}_scan.json");
        }
    }

    public enum CacheStatus { Valid, Stale, NotFound, Error }

    public class CacheLoadResult
    {
        public CacheStatus         Status          { get; set; }
        public List<PlcScanResult> Results         { get; set; }
        public DateTime            ProjectModified { get; set; }
        public DateTime            CachedModified  { get; set; }
        public string              Message         { get; set; }

        public bool IsValid   => Status == CacheStatus.Valid;
        public bool IsStale   => Status == CacheStatus.Stale;
        public bool NeedsScan => Status is CacheStatus.NotFound or CacheStatus.Error;

        public TimeSpan ProjectAge => DateTime.Now - ProjectModified;
    }
}