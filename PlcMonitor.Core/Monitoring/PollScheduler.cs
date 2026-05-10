using System;
using System.Collections.Generic;
using System.Linq;

namespace PlcMonitor.Monitoring
{
    // ─────────────────────────────────────────────
    // Один запрос к ПЛК — читаем кусок DB или M-область
    // ─────────────────────────────────────────────
    public class PlcReadRequest
    {
        public enum AreaType { DataBlock, Merker, Input, Output }

        public AreaType Area { get; set; }
        public int DbNumber { get; set; }       // для DB
        public int ByteOffset { get; set; }
        public int Length { get; set; }          // сколько байт читать

        // Теги которые извлекаются из этого запроса
        public List<MonitoredTag> Tags { get; set; } = new();
    }

    // ─────────────────────────────────────────────
    // Пачка опроса — всё что читаем за один интервал
    // ─────────────────────────────────────────────
    public class PollBatch
    {
        public string PlcSourceId { get; set; }
        public int IntervalMs { get; set; }
        public List<PlcReadRequest> Requests { get; set; } = new();
        public List<MonitoredTag> AllTags { get; set; } = new();
    }

    // ─────────────────────────────────────────────
    // Планировщик — строит пачки из конфигурации проекта
    // ─────────────────────────────────────────────
    public class PollScheduler
    {
        // Строит все пачки для проекта
        // Вызывается один раз при старте или при изменении конфигурации
        public List<PollBatch> BuildBatches(MonitoringProject project)
        {
            var result = new List<PollBatch>();

            // Группируем по ПЛК
            foreach (var plcSource in project.PlcSources.Where(p => p.IsEnabled))
            {
                var plcBatches = BuildBatchesForPlc(project, plcSource);
                result.AddRange(plcBatches);
            }

            return result;
        }

        private List<PollBatch> BuildBatchesForPlc(
            MonitoringProject project,
            PlcSource plcSource)
        {
            // Собираем все активные теги для этого ПЛК
            var allActiveTags = project.GetAllActiveTags()
                .Where(t => t.PlcSourceId == plcSource.Id)
                .ToList();

            if (allActiveTags.Count == 0)
                return new List<PollBatch>();

            // Определяем уникальные интервалы опроса
            var intervals = project.Groups
                .Where(g => g.IsEnabled)
                .Select(g => g.PollIntervalMs)
                .Distinct()
                .OrderBy(i => i)
                .ToList();

            var batches = new List<PollBatch>();

            // Для каждого интервала — своя пачка
            // Теги которые нужны в быстрой пачке не дублируются в медленной
            var alreadyCoveredTagIds = new HashSet<string>();

            foreach (var interval in intervals)
            {
                // Теги которые нужны хотя бы в одной группе с этим интервалом
                var tagsForInterval = project.Groups
                    .Where(g => g.IsEnabled && g.PollIntervalMs == interval)
                    .SelectMany(g => project.GetEnabledTagsForGroup(g))
                    .Where(t => t.PlcSourceId == plcSource.Id)
                    .Select(t => t.Id)
                    .Distinct()
                    .Select(id => project.GetTag(id))
                    .Where(t => t != null)
                    .ToList();

                // Убираем теги которые уже покрываются более быстрой пачкой
                var uniqueTags = tagsForInterval
                    .Where(t => !alreadyCoveredTagIds.Contains(t.Id))
                    .ToList();

                if (uniqueTags.Count == 0) continue;

                var batch = new PollBatch
                {
                    PlcSourceId = plcSource.Id,
                    IntervalMs  = interval,
                    AllTags     = uniqueTags,
                    Requests    = BuildRequests(uniqueTags)
                };

                batches.Add(batch);

                foreach (var t in uniqueTags)
                    alreadyCoveredTagIds.Add(t.Id);
            }

            return batches;
        }

        // Группируем теги в минимальное количество запросов (батчинг по DB)
        private List<PlcReadRequest> BuildRequests(List<MonitoredTag> tags)
        {
            var requests = new List<PlcReadRequest>();

            // Группируем DB теги по номеру DB
            var dbTags = tags
                .Where(t => t.DbNumber.HasValue && t.ByteOffset.HasValue)
                .GroupBy(t => t.DbNumber.Value);

            foreach (var dbGroup in dbTags)
            {
                var dbNumber = dbGroup.Key;
                var tagsInDb = dbGroup.OrderBy(t => t.ByteOffset).ToList();

                // Вычисляем минимальный диапазон байт для чтения
                int minOffset = tagsInDb.Min(t => t.ByteOffset.Value);
                int maxEnd    = tagsInDb.Max(t => t.ByteOffset.Value + GetTypeSize(t.DataType));

                requests.Add(new PlcReadRequest
                {
                    Area       = PlcReadRequest.AreaType.DataBlock,
                    DbNumber   = dbNumber,
                    ByteOffset = minOffset,
                    Length     = maxEnd - minOffset,
                    Tags       = tagsInDb
                });
            }

            // M-область теги
            var merkerTags = tags
                .Where(t => t.AbsoluteAddress != null &&
                            t.AbsoluteAddress.StartsWith("%M"))
                .ToList();

            if (merkerTags.Count > 0)
            {
                requests.Add(new PlcReadRequest
                {
                    Area   = PlcReadRequest.AreaType.Merker,
                    Tags   = merkerTags
                });
            }

            return requests;
        }

        private int GetTypeSize(string dataType) => dataType?.ToUpper() switch
        {
            "BOOL"  => 1,
            "BYTE"  => 1, "SINT"  => 1, "USINT" => 1, "CHAR"  => 1,
            "WORD"  => 2, "INT"   => 2, "UINT"  => 2, "DATE"  => 2,
            "DWORD" => 4, "DINT"  => 4, "UDINT" => 4, "REAL"  => 4, "TIME" => 4,
            "LWORD" => 8, "LINT"  => 8, "ULINT" => 8, "LREAL" => 8,
            _ => 4  // по умолчанию 4 байта
        };
    }

    // ─────────────────────────────────────────────
    // Сводка — удобно для отладки и UI
    // ─────────────────────────────────────────────
    public static class PollSchedulerExtensions
    {
        public static string Summarize(this List<PollBatch> batches)
        {
            var lines = new List<string>();
            lines.Add($"Пачек опроса: {batches.Count}");
            foreach (var batch in batches.OrderBy(b => b.IntervalMs))
            {
                lines.Add($"  [{batch.IntervalMs}ms] " +
                          $"{batch.AllTags.Count} тегов, " +
                          $"{batch.Requests.Count} запросов к ПЛК");
                foreach (var req in batch.Requests)
                {
                    if (req.Area == PlcReadRequest.AreaType.DataBlock)
                        lines.Add($"    DB{req.DbNumber} offset:{req.ByteOffset} len:{req.Length} " +
                                  $"({req.Tags.Count} тегов)");
                    else
                        lines.Add($"    {req.Area} ({req.Tags.Count} тегов)");
                }
            }
            return string.Join("\n", lines);
        }
    }
}
