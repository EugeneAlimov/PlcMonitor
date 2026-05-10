using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using PlcMonitor.Scanner;

namespace PlcMonitor.Monitoring
{
    public class PlcSource
    {
        public bool NameIsAuto { get; set; } = false;
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string Name { get; set; }
        public string IpAddress { get; set; }
        public int Rack { get; set; } = 0;
        public int Slot { get; set; } = 1;
        public string TiaProjectPath { get; set; }
        public string PlcNameInProject { get; set; }
        public bool IsEnabled { get; set; } = true;
        public PlcScanResult ScanResult { get; set; }
    }

    public class MonitoredTag
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string PlcSourceId { get; set; }
        public string SymbolicPath { get; set; }
        public string DataType { get; set; }
        public string DisplayName { get; set; }
        public int? DbNumber { get; set; }
        public int? ByteOffset { get; set; }
        public int? BitOffset { get; set; }
        public string AbsoluteAddress { get; set; }
        [JsonConverter(typeof(StringEnumConverter))]
        public TagSource Source { get; set; }
        public bool IsEnabled { get; set; } = true;
        public bool IsManual { get; set; } = false;

        [JsonIgnore] public object LastValue { get; set; }
        [JsonIgnore] public DateTime LastUpdate { get; set; }
        [JsonIgnore] public bool IsOnline { get; set; }
    }

    public class MonitorGroup
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string Name { get; set; }
        public int PollIntervalMs { get; set; } = 500;
        public bool IsEnabled { get; set; } = true;
        public List<string> TagIds { get; set; } = new List<string>();
        public string Color { get; set; }
    }

    public class MonitoringProject
    {
        public string Version { get; set; } = "1.0";
        public string Name { get; set; }
        public DateTime Created { get; set; } = DateTime.UtcNow;
        public DateTime Modified { get; set; } = DateTime.UtcNow;
        public List<PlcSource> PlcSources { get; set; } = new List<PlcSource>();
        public List<MonitoredTag> Tags { get; set; } = new List<MonitoredTag>();
        public List<MonitorGroup> Groups { get; set; } = new List<MonitorGroup>();

        public PlcSource GetPlcSource(string id) =>
            PlcSources.FirstOrDefault(p => p.Id == id);
        public MonitoredTag GetTag(string id) =>
            Tags.FirstOrDefault(t => t.Id == id);
        public List<MonitoredTag> GetGroupTags(MonitorGroup group) =>
            group.TagIds.Select(id => GetTag(id)).Where(t => t != null).ToList();
        public List<MonitoredTag> GetEnabledTagsForGroup(MonitorGroup group) =>
            GetGroupTags(group).Where(t => t.IsEnabled).ToList();
        public List<MonitoredTag> GetAllActiveTags() =>
            Tags.Where(t => t.IsEnabled &&
                Groups.Any(g => g.IsEnabled && g.TagIds.Contains(t.Id))).ToList();

        public MonitoredTag AddTagFromScan(string plcSourceId, ScannedTag scannedTag, string groupId = null)
        {
            var existing = Tags.FirstOrDefault(t =>
                t.PlcSourceId == plcSourceId && t.SymbolicPath == scannedTag.SymbolicPath);
            if (existing != null)
            {
                if (groupId != null) AddTagToGroup(existing.Id, groupId);
                return existing;
            }
            var tag = new MonitoredTag
            {
                PlcSourceId = plcSourceId, SymbolicPath = scannedTag.SymbolicPath,
                DataType = scannedTag.DataType, DisplayName = scannedTag.Name,
                DbNumber = scannedTag.DbNumber, ByteOffset = scannedTag.ByteOffset,
                BitOffset = scannedTag.BitOffset, AbsoluteAddress = scannedTag.AbsoluteAddress,
                Source = scannedTag.Source, IsManual = false
            };
            Tags.Add(tag);
            if (groupId != null) AddTagToGroup(tag.Id, groupId);
            return tag;
        }

        public MonitoredTag AddTagManual(
            string plcSourceId, string symbolicPath, string dataType,
            int? dbNumber = null, int? byteOffset = null,
            string absoluteAddress = null, string displayName = null, string groupId = null)
        {
            var tag = new MonitoredTag
            {
                PlcSourceId = plcSourceId, SymbolicPath = symbolicPath,
                DataType = dataType, DisplayName = displayName ?? symbolicPath,
                DbNumber = dbNumber, ByteOffset = byteOffset,
                AbsoluteAddress = absoluteAddress, Source = TagSource.Manual, IsManual = true
            };
            Tags.Add(tag);
            if (groupId != null) AddTagToGroup(tag.Id, groupId);
            Modified = DateTime.UtcNow;
            return tag;
        }

        public MonitorGroup CreateGroup(string name, int pollIntervalMs = 500)
        {
            var group = new MonitorGroup { Name = name, PollIntervalMs = pollIntervalMs };
            Groups.Add(group);
            Modified = DateTime.UtcNow;
            return group;
        }

        public void AddTagToGroup(string tagId, string groupId)
        {
            var group = Groups.FirstOrDefault(g => g.Id == groupId);
            if (group != null && !group.TagIds.Contains(tagId))
            {
                group.TagIds.Add(tagId);
                Modified = DateTime.UtcNow;
            }
        }

        public void RemoveTagFromGroup(string tagId, string groupId)
        {
            Groups.FirstOrDefault(g => g.Id == groupId)?.TagIds.Remove(tagId);
            Modified = DateTime.UtcNow;
        }

        public void EnableTag(string tagId)
        {
            var tag = GetTag(tagId);
            if (tag != null) { tag.IsEnabled = true; Modified = DateTime.UtcNow; }
        }

        public void DisableTag(string tagId)
        {
            var tag = GetTag(tagId);
            if (tag != null) { tag.IsEnabled = false; Modified = DateTime.UtcNow; }
        }
    }

    public class MonitoringProjectFile
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            Formatting = Formatting.Indented,
            NullValueHandling = NullValueHandling.Ignore,
            Converters = { new StringEnumConverter() }
        };

        public const string Extension = ".plcmon";

        public static void Save(MonitoringProject project, string filePath)
        {
            project.Modified = DateTime.UtcNow;
            var dir = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(filePath,
                JsonConvert.SerializeObject(project, Settings),
                System.Text.Encoding.UTF8);
        }

        public static MonitoringProject Load(string filePath)
        {
            if (!File.Exists(filePath))
                throw new FileNotFoundException($"Файл не найден: {filePath}");
            return JsonConvert.DeserializeObject<MonitoringProject>(
                File.ReadAllText(filePath, System.Text.Encoding.UTF8), Settings);
        }

        public static bool TryLoad(string filePath, out MonitoringProject project)
        {
            try { project = Load(filePath); return true; }
            catch { project = null; return false; }
        }

        public static string DefaultPath(string name) =>
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "PlcMonitor", $"{name}{Extension}");
    }
}