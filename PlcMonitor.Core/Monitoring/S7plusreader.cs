using System;
using System.Collections.Generic;
using System.Linq;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;

namespace PlcMonitor.Monitoring
{
    // ─────────────────────────────────────────────────────────────────────────
    // DTO — результат чтения одного тега
    // ─────────────────────────────────────────────────────────────────────────
    public class TagReadResult
    {
        public string TagId       { get; set; }
        public string Value       { get; set; }  // null если IsGood == false
        public bool   IsGood      { get; set; }
        public long   TimestampMs { get; set; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    /// <summary>
    /// Обёртка над S7CommPlusDriver для PlcMonitor.
    /// Один экземпляр = одно соединение с одним ПЛК.
    ///
    /// Жизненный цикл:
    ///   Connect(ip)        → подключение TLS + Browse (кэш VarInfo)
    ///   BuildTagList(tags) → MonitoredTag → PlcTag через Browse-кэш
    ///   ReadAll()          → один батч-запрос, возвращает TagReadResult[]
    ///   Disconnect() / Dispose()
    ///
    /// Все операции синхронные (S7CommPlusDriver синхронный).
    /// Вызывать из Task.Run чтобы не блокировать поток ASP.NET.
    /// </summary>
    // ─────────────────────────────────────────────────────────────────────────
    public class S7PlusReader : IDisposable
    {
        private S7CommPlusConnection _conn;
        private readonly Action<string> _log;

        // Browse-кэш: нормализованное имя → VarInfo
        // Нормализация: убрать " → "DB_Name".Member → DB_Name.Member
        private Dictionary<string, VarInfo> _varCache;

        // Tag-кэш: MonitoredTag.Id → PlcTag (типизированный объект драйвера)
        private Dictionary<string, PlcTag> _tagCache;

        // Для обнаружения изменений набора тегов без лишних BuildTagList
        private HashSet<string> _lastTagIds = new HashSet<string>();

        public bool IsConnected   { get; private set; }
        public int  BrowsedCount  => _varCache?.Count ?? 0;
        public int  ResolvedCount => _tagCache?.Count ?? 0;

        // ── Конструктор ───────────────────────────────────────────────────────

        public S7PlusReader(Action<string> log = null)
        {
            _log = log ?? (_ => { });
        }

        // ── Connect ───────────────────────────────────────────────────────────

        /// <summary>
        /// Подключается к ПЛК и выполняет Browse.
        /// S7CommPlusDriver не использует Rack/Slot — только IP.
        /// </summary>
        /// <returns>0 при успехе, ненулевой код ошибки иначе</returns>
        public int Connect(string ipAddress, string password = "")
        {
            _conn = new S7CommPlusConnection();
            _log($"Подключение к {ipAddress}...");

            int res = _conn.Connect(ipAddress, password);
            if (res != 0)
            {
                _log($"Ошибка подключения: код={res}");
                return res;
            }

            IsConnected = true;
            _log("Подключено. Запуск Browse...");

            res = DoBrowse();
            if (res != 0)
                _log($"Browse завершился с ошибкой: код={res}");

            return res;
        }

        // ── Browse ────────────────────────────────────────────────────────────

        private static readonly string[] AreaPrefixes =
            { "IArea.", "QArea.", "MArea.", "S7Timers.", "S7Counters." };

        private int DoBrowse()
        {
            int res = _conn.Browse(out List<VarInfo> varInfoList);
            if (res != 0) return res;

            _varCache = new Dictionary<string, VarInfo>(StringComparer.OrdinalIgnoreCase);

            foreach (var vi in varInfoList)
            {
                var key = NormalizePath(vi.Name);
                if (!string.IsNullOrEmpty(key) && !_varCache.ContainsKey(key))
                    _varCache[key] = vi;
            }

            // Теги из таблиц тегов драйвер отдаёт с префиксом области:
            // "MArea.Clock_2Hz", "IArea.Start", "QArea.Lamp", "S7Timers.T1".
            // В TIA (и в нашем скане) они называются просто "Clock_2Hz".
            // Имена PLC-тегов уникальны в пределах ПЛК, а ключи DB всегда
            // содержат точку ("DB.member"), так что алиас без префикса безопасен.
            int aliases = 0;
            foreach (var vi in varInfoList)
            {
                var name = NormalizePath(vi.Name);
                foreach (var area in AreaPrefixes)
                {
                    if (!name.StartsWith(area, StringComparison.OrdinalIgnoreCase)) continue;
                    var alias = name.Substring(area.Length);
                    if (alias.Length > 0 && !_varCache.ContainsKey(alias))
                    {
                        _varCache[alias] = vi;
                        aliases++;
                    }
                    break;
                }
            }

            _log($"Browse OK: {_varCache.Count} переменных в кэше (из них {aliases} алиасов I/Q/M/T/C)");
            return 0;
        }

        // ── BuildTagList ──────────────────────────────────────────────────────

        /// <summary>
        /// Разрешает список MonitoredTag в PlcTag-объекты через Browse-кэш.
        /// Вызывать после Connect() и при изменении набора тегов.
        /// Неразрешённые теги (не найдены в Browse) пропускаются с логом.
        /// </summary>
        public void BuildTagList(IEnumerable<MonitoredTag> tags)
        {
            if (_varCache == null)
            {
                _log("BuildTagList: Browse-кэш пуст, пропуск");
                return;
            }

            _tagCache = new Dictionary<string, PlcTag>();
            int found = 0, notFound = 0;

            foreach (var tag in tags)
            {
                if (!tag.IsEnabled) continue;

                var key = NormalizePath(tag.SymbolicPath);

                if (_varCache.TryGetValue(key, out var vi))
                {
                    var plcTag = PlcTags.TagFactory(
                        name:         tag.Id,
                        address:      new ItemAddress(vi.AccessSequence),
                        softdatatype: vi.Softdatatype);

                    if (plcTag != null)
                    {
                        _tagCache[tag.Id] = plcTag;
                        found++;
                    }
                    else
                    {
                        _log($"TagFactory вернул null: {tag.SymbolicPath} (softdatatype={vi.Softdatatype})");
                        notFound++;
                    }
                }
                else
                {
                    _log($"Не найден в Browse: {tag.SymbolicPath}");
                    notFound++;
                }
            }

            // Запоминаем ЗАПРОШЕННЫЙ набор, а не разрешённый — иначе каждый
            // неразрешённый тег заставляет TagsChanged() возвращать true
            // и BuildTagList крутится на каждом цикле опроса.
            _lastTagIds = new HashSet<string>(
                tags.Where(t => t.IsEnabled).Select(t => t.Id));
            _log($"BuildTagList: {found} разрешено, {notFound} не найдено");
        }

        /// <summary>
        /// Проверяет, изменился ли набор активных тегов с последнего BuildTagList.
        /// Используется в цикле опроса для lazy-перестройки.
        /// </summary>
        public bool TagsChanged(IEnumerable<MonitoredTag> currentTags)
        {
            var currentIds = new HashSet<string>(
                currentTags.Where(t => t.IsEnabled).Select(t => t.Id));
            return !currentIds.SetEquals(_lastTagIds);
        }

        // ── ReadAll ───────────────────────────────────────────────────────────

        /// <summary>
        /// Читает все разрешённые теги одним батч-запросом к ПЛК.
        /// После вызова у каждого PlcTag обновлены .Value и .Quality.
        /// При ошибке чтения IsConnected → false (сигнал для переподключения).
        /// </summary>
        public List<TagReadResult> ReadAll()
        {
            if (_tagCache == null || _tagCache.Count == 0)
                return new List<TagReadResult>();

            // Один вызов = один батч-запрос (ReadTags сам разбивает на чанки
            // если тегов больше чем TagsPerReadRequestMax ПЛК)
            long t0  = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            int  res = _conn.ReadTags(_tagCache.Values);
            long t1  = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            if (res != 0)
            {
                _log($"ReadTags ошибка: код={res}");
                IsConnected = false;  // сигнал для reconnect-цикла
                return new List<TagReadResult>();
            }

            // Середина запроса — лучшая оценка момента, когда ПЛК отдал значения
            long tsMs = (t0 + t1) / 2;
            var results = new List<TagReadResult>(_tagCache.Count);

            foreach (var kv in _tagCache)
            {
                var plcTag = kv.Value;
                bool isGood = (plcTag.Quality & PlcTagQC.TAG_QUALITY_MASK)
                              == PlcTagQC.TAG_QUALITY_GOOD;

                results.Add(new TagReadResult
                {
                    TagId       = kv.Key,
                    Value       = isGood ? ExtractValue(plcTag.ToString()) : null,
                    IsGood      = isGood,
                    TimestampMs = tsMs
                });
            }

            return results;
        }

        // ── Disconnect ────────────────────────────────────────────────────────

        public void Disconnect()
        {
            if (_conn == null) return;
            try   { _conn.Disconnect(); }
            catch (Exception ex) { _log($"Disconnect error: {ex.Message}"); }
            finally
            {
                IsConnected = false;
                _tagCache   = null;
            }
        }

        public void Dispose() => Disconnect();

        // ── Вспомогательные ───────────────────────────────────────────────────

        /// <summary>
        /// Убирает кавычки TIA Portal из символьного пути.
        /// "DB_Signals".Temperature  →  DB_Signals.Temperature
        /// </summary>
        private static string NormalizePath(string path)
            => path?.Replace("\"", "").Trim() ?? string.Empty;

        /// <summary>
        /// PlcTag.ToString() → "C0: 3.14"  (качество HEX + двоеточие + значение).
        /// Возвращает только значение.
        /// </summary>
        private static string ExtractValue(string tagString)
        {
            if (string.IsNullOrEmpty(tagString)) return string.Empty;
            int idx = tagString.IndexOf(": ", StringComparison.Ordinal);
            return idx >= 0 ? tagString.Substring(idx + 2) : tagString;
        }
    }
}