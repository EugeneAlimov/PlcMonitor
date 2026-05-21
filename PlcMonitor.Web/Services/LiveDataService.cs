using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PlcMonitor.Monitoring;
using PlcMonitor.Web.Hubs;

namespace PlcMonitor.Web.Services
{
    /// <summary>
    /// BackgroundService — живое чтение данных из ПЛК.
    ///
    /// Управление:
    ///   StartMonitoringAsync(plcSourceId)  — подключить и начать опрос
    ///   StopMonitoringAsync(plcSourceId)   — остановить и отключить
    ///
    /// Поток данных:
    ///   S7PlusReader → ReadAll() → SignalR "tagValues" → браузер
    ///
    /// По одному S7PlusReader + poll-loop на каждый активный PlcSource.
    /// Все блокирующие вызовы драйвера выполняются в Task.Run.
    /// </summary>
    public class LiveDataService : BackgroundService
    {
        private readonly ILogger<LiveDataService> _logger;
        private readonly ProjectService           _projectService;
        private readonly IHubContext<LiveDataHub> _hub;

        // plcSourceId → (reader, cancellation)
        private readonly ConcurrentDictionary<string, ActiveSource> _sources = new();

        private class ActiveSource
        {
            public S7PlusReader            Reader { get; set; }
            public CancellationTokenSource Cts    { get; set; }
        }

        // ── Конструктор ───────────────────────────────────────────────────────

        public LiveDataService(
            ILogger<LiveDataService> logger,
            ProjectService projectService,
            IHubContext<LiveDataHub> hub)
        {
            _logger         = logger;
            _projectService = projectService;
            _hub            = hub;
        }

        // ── BackgroundService ─────────────────────────────────────────────────

        protected override Task ExecuteAsync(CancellationToken stoppingToken)
        {
            stoppingToken.Register(() => _ = StopAllAsync());
            return Task.CompletedTask;
        }

        public override async Task StopAsync(CancellationToken ct)
        {
            await StopAllAsync();
            await base.StopAsync(ct);
        }

        // ── Публичный API (вызывается из MonitorController) ──────────────────

        public IReadOnlyCollection<string> ActiveSourceIds =>
            (IReadOnlyCollection<string>)_sources.Keys;

        /// <summary>
        /// Запускает мониторинг PlcSource.
        /// Подключение и Browse выполняются в фоне — метод возвращается сразу.
        /// Возвращает null при успехе или строку с ошибкой.
        /// </summary>
        public Task<string> StartMonitoringAsync(string plcSourceId)
        {
            if (_sources.ContainsKey(plcSourceId))
                return Task.FromResult<string>(null); // уже запущен

            var project = _projectService.Current;
            if (project == null)
                return Task.FromResult("Нет открытого проекта");

            var source = project.PlcSources.FirstOrDefault(s => s.Id == plcSourceId);
            if (source == null)    return Task.FromResult($"PlcSource '{plcSourceId}' не найден");
            if (!source.IsEnabled) return Task.FromResult("PlcSource отключён");

            var cts    = new CancellationTokenSource();
            var reader = new S7PlusReader(msg =>
                _logger.LogDebug("[{Plc}] {Msg}", source.Name, msg));

            _sources[plcSourceId] = new ActiveSource { Reader = reader, Cts = cts };

            // Запускаем loop в фоне — не блокируем HTTP-запрос
            _ = Task.Run(() => PollLoopAsync(plcSourceId, source.IpAddress, cts.Token));

            return Task.FromResult<string>(null);
        }

        /// <summary>Останавливает мониторинг и отключает ПЛК.</summary>
        public async Task StopMonitoringAsync(string plcSourceId)
        {
            if (!_sources.TryRemove(plcSourceId, out var entry)) return;

            entry.Cts.Cancel();

            await Task.Run(() =>
            {
                try   { entry.Reader.Dispose(); }
                catch { /* ignore */ }
            });

            await SendStatusAsync(plcSourceId, "disconnected");
            _logger.LogInformation("Мониторинг остановлен: {Id}", plcSourceId);
        }

        // ── Poll loop ─────────────────────────────────────────────────────────

        private async Task PollLoopAsync(
            string plcSourceId, string ipAddress, CancellationToken ct)
        {
            if (!_sources.TryGetValue(plcSourceId, out var entry)) return;
            var reader = entry.Reader;

            // ── 1. Подключение ──────────────────────────────────────────────

            await SendStatusAsync(plcSourceId, "connecting");

            int res = await Task.Run(() => reader.Connect(ipAddress), ct);

            if (res != 0 || ct.IsCancellationRequested)
            {
                await SendStatusAsync(plcSourceId, "error",
                    $"Ошибка подключения: код={res}");
                _sources.TryRemove(plcSourceId, out _);
                return;
            }

            await SendStatusAsync(plcSourceId, "connected",
                $"Browse: {reader.BrowsedCount} переменных");
            _logger.LogInformation("Подключено: {Ip}, Browse: {N} переменных",
                ipAddress, reader.BrowsedCount);

            // ── 2. Основной цикл опроса ─────────────────────────────────────

            while (!ct.IsCancellationRequested)
            {
                var project = _projectService.Current;
                if (project == null) break;

                var activeTags = GetActiveTags(project, plcSourceId);

                // Перестраиваем список тегов если конфигурация изменилась
                if (reader.TagsChanged(activeTags))
                {
                    await Task.Run(() => reader.BuildTagList(activeTags), ct);
                    _logger.LogDebug("[{Plc}] Список тегов перестроен: {N} разрешено",
                        plcSourceId, reader.ResolvedCount);
                }

                // Читаем значения
                if (reader.ResolvedCount > 0)
                {
                    List<TagReadResult> results;
                    try
                    {
                        results = await Task.Run(() => reader.ReadAll(), ct);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (Exception ex)
                    {
                        _logger.LogWarning("[{Plc}] ReadAll исключение: {Ex}",
                            plcSourceId, ex.Message);
                        results = null;
                    }

                    // Соединение потеряно — переподключаемся
                    if (!reader.IsConnected)
                    {
                        _logger.LogWarning("[{Plc}] Соединение потеряно", plcSourceId);
                        await SendStatusAsync(plcSourceId, "error", "Соединение потеряно");
                        await ReconnectAsync(plcSourceId, ipAddress, reader, ct);
                        continue;
                    }

                    if (results?.Count > 0)
                        await PushTagValuesAsync(plcSourceId, results);
                }

                // Ждём следующего цикла
                int interval = GetMinInterval(project, plcSourceId);
                try   { await Task.Delay(interval, ct); }
                catch (OperationCanceledException) { break; }
            }

            _logger.LogInformation("[{Plc}] Poll loop завершён", plcSourceId);
        }

        // ── Reconnect ─────────────────────────────────────────────────────────

        private async Task ReconnectAsync(
            string plcSourceId, string ipAddress,
            S7PlusReader reader, CancellationToken ct)
        {
            int delay    = 3_000;
            int maxDelay = 30_000;

            while (!ct.IsCancellationRequested)
            {
                await SendStatusAsync(plcSourceId, "connecting");

                try   { await Task.Delay(delay, ct); }
                catch (OperationCanceledException) { return; }

                int res = await Task.Run(() => reader.Connect(ipAddress), ct);
                if (res == 0)
                {
                    await SendStatusAsync(plcSourceId, "connected",
                        $"Reconnected. Browse: {reader.BrowsedCount} vars");
                    _logger.LogInformation("[{Plc}] Переподключено", plcSourceId);
                    return;
                }

                delay = Math.Min(delay * 2, maxDelay);
                _logger.LogWarning("[{Plc}] Reconnect неудачен, следующая попытка через {D}с",
                    plcSourceId, delay / 1000);
            }
        }

        // ── SignalR push ──────────────────────────────────────────────────────

        private async Task PushTagValuesAsync(
            string plcSourceId, List<TagReadResult> results)
        {
            var payload = results.Select(r => new
            {
                tagId       = r.TagId,
                value       = r.Value,
                isGood      = r.IsGood,
                timestampMs = r.TimestampMs
            }).ToList();

            try
            {
                await _hub.Clients.All.SendAsync("tagValues", plcSourceId, payload);
            }
            catch (Exception ex)
            {
                _logger.LogDebug("SignalR push ошибка: {Ex}", ex.Message);
            }
        }

        private async Task SendStatusAsync(
            string plcSourceId, string status, string message = null)
        {
            try
            {
                await _hub.Clients.All.SendAsync("plcStatus", plcSourceId, status, message);
            }
            catch { /* ignore */ }
        }

        // ── Вспомогательные ──────────────────────────────────────────────────

        /// <summary>Активные теги для данного ПЛК — включены и состоят в активной группе.</summary>
        private static List<MonitoredTag> GetActiveTags(
            MonitoringProject project, string plcSourceId)
        {
            return project.Tags
                .Where(t => t.IsEnabled
                         && t.PlcSourceId == plcSourceId
                         && project.Groups.Any(g =>
                                g.IsEnabled && g.TagIds.Contains(t.Id)))
                .ToList();
        }

        /// <summary>Минимальный интервал опроса среди групп с тегами от этого ПЛК.</summary>
        private static int GetMinInterval(
            MonitoringProject project, string plcSourceId)
        {
            return project.Groups
                .Where(g => g.IsEnabled
                         && g.TagIds.Any(tid =>
                                project.Tags.Any(t =>
                                    t.Id == tid
                                    && t.PlcSourceId == plcSourceId
                                    && t.IsEnabled)))
                .Select(g => g.PollIntervalMs)
                .Where(ms => ms > 0)
                .DefaultIfEmpty(1000)
                .Min();
        }

        private async Task StopAllAsync()
        {
            var ids = _sources.Keys.ToList();
            foreach (var id in ids)
                await StopMonitoringAsync(id);
        }
    }
}