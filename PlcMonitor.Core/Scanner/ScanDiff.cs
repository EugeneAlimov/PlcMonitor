using System.Collections.Generic;
using System.Linq;

namespace PlcMonitor.Scanner
{
    /// <summary>
    /// Сравнивает два результата сканирования.
    /// Показывает что изменилось после перекомпиляции проекта.
    /// </summary>
    public class ScanDiff
    {
        public List<DiffEntry> Changes { get; set; } = new();

        public bool HasChanges            => Changes.Count > 0;
        public bool HasOffsetChanges      => Changes.Any(c => c.Type == DiffType.OffsetChanged);
        public bool HasStructureChanges   =>
            Changes.Any(c => c.Type is DiffType.Added or DiffType.Removed or DiffType.TypeChanged);
    }

    public enum DiffType
    {
        Added,          // Тег появился
        Removed,        // Тег удалён
        TypeChanged,    // Тип данных изменился
        OffsetChanged,  // Смещение изменилось (важно для snap7!)
        DbRenamed,      // DB переименован
    }

    public class DiffEntry
    {
        public DiffType Type        { get; set; }
        public string   Path        { get; set; } // символьный путь тега
        public string   OldValue    { get; set; }
        public string   NewValue    { get; set; }
        public string   Description { get; set; }
    }

    public class ScanDiffEngine
    {
        public ScanDiff Compare(PlcScanResult oldScan, PlcScanResult newScan)
        {
            var diff = new ScanDiff();

            // Сравниваем DB
            var oldDbs = oldScan.DataBlocks.ToDictionary(d => d.Name);
            var newDbs = newScan.DataBlocks.ToDictionary(d => d.Name);

            foreach (var name in oldDbs.Keys.Union(newDbs.Keys))
            {
                oldDbs.TryGetValue(name, out var oldDb);
                newDbs.TryGetValue(name, out var newDb);

                if (oldDb == null)
                {
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.Added,
                        Path        = $"\"{name}\"",
                        Description = $"Новый DB: {name} [{newDb.Number}]"
                    });
                    continue;
                }

                if (newDb == null)
                {
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.Removed,
                        Path        = $"\"{name}\"",
                        Description = $"Удалён DB: {name}"
                    });
                    continue;
                }

                // Сравниваем члены DB
                CompareMembers(
                    diff,
                    oldDb.Members,
                    newDb.Members,
                    $"\"{name}\"");
            }

            // Сравниваем таблицы тегов
            var oldTags = FlattenTagTables(oldScan.TagTables);
            var newTags = FlattenTagTables(newScan.TagTables);
            CompareFlatTags(diff, oldTags, newTags);

            return diff;
        }

        private void CompareMembers(
            ScanDiff diff,
            List<ScannedTag> oldMembers,
            List<ScannedTag> newMembers,
            string parentPath)
        {
            var oldMap = oldMembers.ToDictionary(m => m.Name);
            var newMap = newMembers.ToDictionary(m => m.Name);

            foreach (var name in oldMap.Keys.Union(newMap.Keys))
            {
                var path = $"{parentPath}.{name}";
                oldMap.TryGetValue(name, out var oldTag);
                newMap.TryGetValue(name, out var newTag);

                if (oldTag == null)
                {
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.Added,
                        Path        = path,
                        NewValue    = newTag.DataType,
                        Description = $"[+] {path} : {newTag.DataType}"
                    });
                    continue;
                }

                if (newTag == null)
                {
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.Removed,
                        Path        = path,
                        OldValue    = oldTag.DataType,
                        Description = $"[-] {path} : {oldTag.DataType}"
                    });
                    continue;
                }

                // Тип изменился
                if (oldTag.DataType != newTag.DataType)
                {
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.TypeChanged,
                        Path        = path,
                        OldValue    = oldTag.DataType,
                        NewValue    = newTag.DataType,
                        Description = $"[~] {path} : {oldTag.DataType} → {newTag.DataType}"
                    });
                }

                // Смещение изменилось (критично для snap7)
                if (oldTag.ByteOffset.HasValue && newTag.ByteOffset.HasValue &&
                    oldTag.ByteOffset != newTag.ByteOffset)
                {
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.OffsetChanged,
                        Path        = path,
                        OldValue    = $"offset:{oldTag.ByteOffset}",
                        NewValue    = $"offset:{newTag.ByteOffset}",
                        Description = $"[!] {path} смещение: {oldTag.ByteOffset} → {newTag.ByteOffset}"
                    });
                }

                // Рекурсивно в дочерние
                if (oldTag.Children.Count > 0 || newTag.Children.Count > 0)
                {
                    CompareMembers(diff, oldTag.Children, newTag.Children, path);
                }
            }
        }

        private Dictionary<string, ScannedTag> FlattenTagTables(
            List<ScannedTagTable> tables)
        {
            var result = new Dictionary<string, ScannedTag>();
            foreach (var table in tables)
            foreach (var tag in table.Tags)
                result[tag.SymbolicPath] = tag;
            return result;
        }

        private void CompareFlatTags(
            ScanDiff diff,
            Dictionary<string, ScannedTag> oldTags,
            Dictionary<string, ScannedTag> newTags)
        {
            foreach (var path in oldTags.Keys.Union(newTags.Keys))
            {
                oldTags.TryGetValue(path, out var oldTag);
                newTags.TryGetValue(path, out var newTag);

                if (oldTag == null)
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.Added,
                        Path        = path,
                        Description = $"[+] {path} : {newTag?.DataType}"
                    });
                else if (newTag == null)
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.Removed,
                        Path        = path,
                        Description = $"[-] {path}"
                    });
                else if (oldTag.DataType != newTag.DataType ||
                         oldTag.AbsoluteAddress != newTag.AbsoluteAddress)
                    diff.Changes.Add(new DiffEntry
                    {
                        Type        = DiffType.TypeChanged,
                        Path        = path,
                        OldValue    = $"{oldTag.DataType} {oldTag.AbsoluteAddress}",
                        NewValue    = $"{newTag.DataType} {newTag.AbsoluteAddress}",
                        Description = $"[~] {path} изменён"
                    });
            }
        }
    }
}
