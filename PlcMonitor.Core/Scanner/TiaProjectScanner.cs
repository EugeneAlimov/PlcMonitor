using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Siemens.Engineering;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;

namespace PlcMonitor.Scanner
{
    public class TiaProjectScanner
    {
        private readonly Action<string> _log;

        public TiaProjectScanner(Action<string> log = null)
        {
            _log = log ?? Console.WriteLine;
        }

    public List<PlcInfo> GetPlcNames(string projectPath)
    {
        TiaPortal tia = TryAttachToRunningInstance();
        if (tia == null)
            throw new InvalidOperationException("TIA Portal не запущен");

        Project project = null;
        bool weOpened   = false;

        try
        {
            foreach (var p in tia.Projects)
            {
                if (string.Equals(p.Path?.FullName, projectPath,
                    StringComparison.OrdinalIgnoreCase))
                { project = p; break; }
            }

            if (project == null)
            {
                project  = tia.Projects.Open(new FileInfo(projectPath));
                weOpened = true;
            }

            var result = new List<PlcInfo>();
            foreach (var device in project.Devices)
            {
                foreach (var deviceItem in device.DeviceItems)
                {
                    var container = deviceItem.GetService<SoftwareContainer>();
                    if (container?.Software is PlcSoftware)
                        result.Add(new PlcInfo { Name = deviceItem.Name });
                }
            }
            return result;
        }
        finally
        {
            if (weOpened && project != null)
                try { project.Close(); } catch { }
        }
    }

    public class PlcInfo
{
    public string Name { get; set; }
}
        // ─────────────────────────────────────────────
        // ТОЧКА ВХОДА
        // ─────────────────────────────────────────────
        public List<PlcScanResult> ScanProject(string projectPath)
        {
            _log($"Открываем проект: {projectPath}");

            TiaPortal tia = TryAttachToRunningInstance();

            if (tia == null)
            {
                _log("TIA Portal не найден.");
                _log("Откройте TIA Portal вручную и повторите сканирование.");
                throw new InvalidOperationException(
                    "TIA Portal не запущен. Откройте TIA Portal и нажмите " +
                    "\"Сканировать\" снова. TIA Portal можно оставить на любом экране — " +
                    "проект откроется автоматически.");
            }

            _log("Подключились к TIA Portal.");

            Project project = null;
            bool weOpenedProject = false;

            try
            {
                // Ищем проект среди уже открытых в TIA Portal
                foreach (var p in tia.Projects)
                {
                    if (string.Equals(p.Path?.FullName, projectPath,
                        StringComparison.OrdinalIgnoreCase))
                    {
                        project = p;
                        _log($"Проект уже открыт в TIA Portal: {p.Name}");
                        break;
                    }
                }

                // Если не открыт — открываем
                if (project == null)
                {
                    _log("Открываем проект в TIA Portal...");
                    project = tia.Projects.Open(new FileInfo(projectPath));
                    weOpenedProject = true;
                    _log($"Проект открыт: {project.Name}");
                }

                var results = new List<PlcScanResult>();

                foreach (var device in project.Devices)
                {
                    foreach (var deviceItem in device.DeviceItems)
                    {
                        var container = deviceItem.GetService<SoftwareContainer>();
                        if (container == null) continue;
                        var sw = container.Software as PlcSoftware;
                        if (sw == null) continue;

                        _log($"Сканируем ПЛК: {deviceItem.Name}");
                        var result = ScanPlc(sw, deviceItem.Name, projectPath);
                        result.ProjectModified = File.GetLastWriteTime(projectPath);
                        result.ScanTimestamp   = DateTime.UtcNow.ToString("O");
                        results.Add(result);
                    }
                }

                if (weOpenedProject)
                {
                    project.Close();
                    _log("Проект закрыт.");
                }

                return results;
            }
            catch
            {
                if (weOpenedProject && project != null)
                {
                    try { project.Close(); } catch { }
                }
                throw;
            }
            // НЕ вызываем tia.Dispose() — не трогаем TIA Portal пользователя
        }

        // ─────────────────────────────────────────────
        // СКАНИРОВАНИЕ ОДНОГО ПЛК
        // ─────────────────────────────────────────────
        private PlcScanResult ScanPlc(PlcSoftware plc, string plcName, string projectPath)
        {
            var result = new PlcScanResult
            {
                PlcName     = plcName,
                ProjectPath = projectPath
            };

            _log("  -> Таблицы тегов...");
            ScanTagTableGroup(plc.TagTableGroup, result, "");

            _log("  -> Program Blocks...");
            ScanBlockGroup(plc.BlockGroup, result, "");

            _log($"  Готово. TagTables:{result.TagTables.Count} " +
                 $"DBs:{result.DataBlocks.Count} " +
                 $"FBs:{result.FunctionBlocks.Count} " +
                 $"FCs:{result.Functions.Count}");

            return result;
        }

        // ─────────────────────────────────────────────
        // ТАБЛИЦЫ ТЕГОВ
        // ─────────────────────────────────────────────
        private void ScanTagTableGroup(
            PlcTagTableGroup group, PlcScanResult result, string parentPath)
        {
            foreach (var subGroup in group.Groups)
            {
                var path = string.IsNullOrEmpty(parentPath)
                    ? subGroup.Name : $"{parentPath}/{subGroup.Name}";
                ScanTagTableGroup(subGroup, result, path);
            }

            foreach (var table in group.TagTables)
            {
                var scannedTable = new ScannedTagTable
                {
                    Name      = table.Name,
                    GroupPath = parentPath
                };

                foreach (PlcTag tag in table.Tags)
                {
                    try
                    {
                        scannedTable.Tags.Add(new ScannedTag
                        {
                            Name            = tag.Name,
                            SymbolicPath    = tag.Name,
                            DataType        = tag.DataTypeName,
                            Source          = TagSource.TagTable,
                            AbsoluteAddress = tag.LogicalAddress,
                            Comment         = GetTagComment(tag)
                        });
                    }
                    catch (Exception ex)
                    {
                        result.Warnings.Add($"Tag/{table.Name}/{tag.Name}: {ex.Message}");
                    }
                }

                result.TagTables.Add(scannedTable);
            }
        }

        // ─────────────────────────────────────────────
        // БЛОКИ
        // ─────────────────────────────────────────────
        private void ScanBlockGroup(
            PlcBlockGroup group, PlcScanResult result, string parentPath)
        {
            foreach (var subGroup in group.Groups)
            {
                var path = string.IsNullOrEmpty(parentPath)
                    ? subGroup.Name : $"{parentPath}/{subGroup.Name}";
                ScanBlockGroup(subGroup, result, path);
            }

            foreach (var block in group.Blocks)
            {
                try
                {
                    if (block is DataBlock db)
                        result.DataBlocks.Add(ScanDataBlock(db, parentPath, result));
                    else if (block is FB fb)
                        result.FunctionBlocks.Add(ScanFB(fb, parentPath, result));
                    else if (block is FC fc)
                        result.Functions.Add(ScanFC(fc, parentPath, result));
                }
                catch (Exception ex)
                {
                    result.Warnings.Add($"Block/{block.Name}: {ex.Message}");
                }
            }
        }

        // ─────────────────────────────────────────────
        // DATA BLOCK
        // ─────────────────────────────────────────────
        private ScannedDataBlock ScanDataBlock(
            DataBlock db, string groupPath, PlcScanResult result)
        {
            // В TIA Portal V20 атрибут называется MemoryLayout
            // Значения: "Optimized" или "Standard"
            bool isOptimized = false;
            try
            {
                var layout = db.GetAttribute("MemoryLayout")?.ToString();
                isOptimized = layout == "Optimized";
            }
            catch { }

            bool isInstance = db is InstanceDB;
            string instanceOf = null;
            if (db is InstanceDB idb)
            {
                try { instanceOf = (string)idb.GetAttribute("InstanceOfName"); }
                catch { }
            }

            var scanned = new ScannedDataBlock
            {
                Name         = db.Name,
                Number       = db.Number,
                IsOptimized  = isOptimized,
                IsInstanceDb = isInstance,
                InstanceOfFb = instanceOf,
                GroupPath    = groupPath
            };

            try
            {
                foreach (IEngineeringObject member in db.Interface.Members)
                {
                    scanned.Members.Add(ScanMember(
                        member, $"\"{db.Name}\"", TagSource.GlobalDb, db.Number));
                }
            }
            catch (Exception ex)
            {
                result.Warnings.Add($"DB/{db.Name}/Members: {ex.Message}");
            }

            return scanned;
        }

        // ─────────────────────────────────────────────
        // FUNCTION BLOCK
        // ─────────────────────────────────────────────
        private ScannedFunctionBlock ScanFB(
            FB fb, string groupPath, PlcScanResult result)
        {
            var scanned = new ScannedFunctionBlock
            {
                Name      = fb.Name,
                Number    = fb.Number,
                GroupPath = groupPath
            };

            try
            {
                var iface = fb.GetType().GetProperty("Interface")?.GetValue(fb);
                if (iface == null) return scanned;

                var sections = iface.GetType().GetProperty("Sections")?.GetValue(iface) as IEnumerable;
                if (sections == null) return scanned;

                foreach (var section in sections)
                {
                    string sectionName = section.GetType().GetProperty("Name")
                        ?.GetValue(section)?.ToString() ?? "";

                    var (list, src) = sectionName switch
                    {
                        "Input"  => (scanned.Input,  TagSource.FbInput),
                        "Output" => (scanned.Output, TagSource.FbOutput),
                        "InOut"  => (scanned.InOut,  TagSource.FbInOut),
                        "Static" => (scanned.Static, TagSource.FbStatic),
                        "Temp"   => (scanned.Temp,   TagSource.FbTemp),
                        _        => ((List<ScannedTag>)null, TagSource.FbTemp)
                    };
                    if (list == null) continue;

                    var members = section.GetType().GetProperty("Members")
                        ?.GetValue(section) as IEnumerable;
                    if (members == null) continue;

                    foreach (var member in members)
                    {
                        if (member is IEngineeringObject engMember)
                            list.Add(ScanMember(engMember, $"\"{fb.Name}\"", src, null));
                    }
                }
            }
            catch (Exception ex)
            {
                result.Warnings.Add($"FB/{fb.Name}: {ex.Message}");
            }

            return scanned;
        }

        // ─────────────────────────────────────────────
        // FUNCTION
        // ─────────────────────────────────────────────
        private ScannedFunction ScanFC(
            FC fc, string groupPath, PlcScanResult result)
        {
            var scanned = new ScannedFunction
            {
                Name      = fc.Name,
                Number    = fc.Number,
                GroupPath = groupPath
            };

            try
            {
                var iface = fc.GetType().GetProperty("Interface")?.GetValue(fc);
                if (iface == null) return scanned;

                var sections = iface.GetType().GetProperty("Sections")
                    ?.GetValue(iface) as IEnumerable;
                if (sections == null) return scanned;

                foreach (var section in sections)
                {
                    string sectionName = section.GetType().GetProperty("Name")
                        ?.GetValue(section)?.ToString() ?? "";

                    var (list, src) = sectionName switch
                    {
                        "Input"  => (scanned.Input,  TagSource.FcInput),
                        "Output" => (scanned.Output, TagSource.FcOutput),
                        "InOut"  => (scanned.InOut,  TagSource.FcInOut),
                        "Temp"   => (scanned.Temp,   TagSource.FcTemp),
                        _        => ((List<ScannedTag>)null, TagSource.FcTemp)
                    };
                    if (list == null) continue;

                    var members = section.GetType().GetProperty("Members")
                        ?.GetValue(section) as IEnumerable;
                    if (members == null) continue;

                    foreach (var member in members)
                    {
                        if (member is IEngineeringObject engMember)
                            list.Add(ScanMember(engMember, $"\"{fc.Name}\"", src, null));
                    }
                }
            }
            catch (Exception ex)
            {
                result.Warnings.Add($"FC/{fc.Name}: {ex.Message}");
            }

            return scanned;
        }

        // ─────────────────────────────────────────────
        // ОБХОД ЧЛЕНА — через IEngineeringObject
        // ─────────────────────────────────────────────
        private ScannedTag ScanMember(
            IEngineeringObject member,
            string parentPath,
            TagSource source,
            int? dbNumber)
        {
            string name     = TryGetAttr(member, "Name") ?? "Unknown";
            string dataType = TryGetAttr(member, "DataTypeName") ?? "Unknown";
            string path     = $"{parentPath}.{name}";

            var tag = new ScannedTag
            {
                Name         = name,
                SymbolicPath = path,
                DataType     = dataType,
                Source       = source,
                DbNumber     = dbNumber,
                StartValue   = TryGetAttr(member, "StartValue"),
                Comment      = TryGetAttr(member, "Comment")
            };

            try
            {
                var membersProp = member.GetType().GetProperty("Members");
                if (membersProp != null)
                {
                    var children = membersProp.GetValue(member) as IEnumerable;
                    if (children != null)
                    {
                        foreach (var child in children)
                        {
                            if (child is IEngineeringObject childObj)
                                tag.Children.Add(ScanMember(childObj, path, source, dbNumber));
                        }
                    }
                }
            }
            catch { }

            return tag;
        }

        // ─────────────────────────────────────────────
        // ВСПОМОГАТЕЛЬНЫЕ
        // ─────────────────────────────────────────────
        private string TryGetAttr(IEngineeringObject obj, string attrName)
        {
            try
            {
                var val = obj.GetAttribute(attrName);
                if (val == null) return null;
                if (val is MultilingualText ml)
                    return ml.Items.FirstOrDefault()?.Text;
                return val.ToString();
            }
            catch { return null; }
        }

        private string GetTagComment(PlcTag tag)
        {
            try
            {
                var ml = tag.GetAttribute("Comment") as MultilingualText;
                return ml?.Items.FirstOrDefault()?.Text;
            }
            catch { return null; }
        }

        private TiaPortal TryAttachToRunningInstance()
        {
            try
            {
                var instances = TiaPortal.GetProcesses();
                _log($"TIA Portal процессов найдено: {instances.Count}");
                if (instances.Count > 0)
                {
                    _log($"Найден TIA Portal (PID: {instances[0].Id}), подключаемся...");
                    return instances[0].Attach();
                }
            }
            catch (Exception ex)
            {
                _log($"Ошибка подключения к TIA Portal: {ex.Message}");
            }
            return null;
        }
    }
}