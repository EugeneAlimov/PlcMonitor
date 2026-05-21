using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using PlcMonitor.Web.Services;

namespace PlcMonitor.Web.Controllers
{
    [ApiController]
    [Route("api/monitor")]
    public class MonitorController : ControllerBase
    {
        private readonly LiveDataService _liveData;
        private readonly ProjectService  _project;

        public MonitorController(LiveDataService liveData, ProjectService project)
        {
            _liveData = liveData;
            _project  = project;
        }

        // ── GET /api/monitor/status ───────────────────────────────────────────
        // Список всех PlcSource с признаком активности мониторинга

        [HttpGet("status")]
        public IActionResult Status()
        {
            var project = _project.Current;
            if (project == null)
                return Ok(new { loaded = false, sources = new object[0] });

            var activeIds = _liveData.ActiveSourceIds;

            var sources = project.PlcSources.Select(s => new
            {
                id        = s.Id,
                name      = s.Name,
                ipAddress = s.IpAddress,
                isEnabled = s.IsEnabled,
                isActive  = activeIds.Contains(s.Id)
            });

            return Ok(new { loaded = true, sources });
        }

        // ── POST /api/monitor/start ───────────────────────────────────────────
        // Body: { "plcSourceId": "..." }

        [HttpPost("start")]
        public async Task<IActionResult> Start([FromBody] MonitorRequest req)
        {
            if (string.IsNullOrEmpty(req?.PlcSourceId))
                return BadRequest(new { error = "plcSourceId обязателен" });

            var err = await _liveData.StartMonitoringAsync(req.PlcSourceId);
            if (err != null)
                return BadRequest(new { error = err });

            return Ok(new { started = true, plcSourceId = req.PlcSourceId });
        }

        // ── POST /api/monitor/stop ────────────────────────────────────────────
        // Body: { "plcSourceId": "..." }

        [HttpPost("stop")]
        public async Task<IActionResult> Stop([FromBody] MonitorRequest req)
        {
            if (string.IsNullOrEmpty(req?.PlcSourceId))
                return BadRequest(new { error = "plcSourceId обязателен" });

            await _liveData.StopMonitoringAsync(req.PlcSourceId);
            return Ok(new { stopped = true, plcSourceId = req.PlcSourceId });
        }

        // ── POST /api/monitor/start-all ───────────────────────────────────────
        // Запустить мониторинг для всех включённых PlcSource

        [HttpPost("start-all")]
        public async Task<IActionResult> StartAll()
        {
            var project = _project.Current;
            if (project == null)
                return BadRequest(new { error = "Нет открытого проекта" });

            var errors = new System.Collections.Generic.List<string>();
            foreach (var src in project.PlcSources.Where(s => s.IsEnabled))
            {
                var err = await _liveData.StartMonitoringAsync(src.Id);
                if (err != null)
                    errors.Add($"{src.Name}: {err}");
            }

            return Ok(new { started = true, errors });
        }

        // ── POST /api/monitor/stop-all ────────────────────────────────────────

        [HttpPost("stop-all")]
        public async Task<IActionResult> StopAll()
        {
            var project = _project.Current;
            if (project == null) return Ok();

            foreach (var src in project.PlcSources)
                await _liveData.StopMonitoringAsync(src.Id);

            return Ok(new { stopped = true });
        }
    }

    public class MonitorRequest
    {
        public string PlcSourceId { get; set; }
    }
}