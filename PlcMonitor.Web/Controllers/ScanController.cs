using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using PlcMonitor.Web.Services;
using System.Linq;

namespace PlcMonitor.Web.Controllers
{
    // ══════════════════════════════════════════════════════
    // SCAN
    // ══════════════════════════════════════════════════════
    [ApiController]
    [Route("api/scan")]
    public class ScanController : ControllerBase
    {
        private readonly ScannerService _scanner;
        public ScanController(ScannerService scanner) { _scanner = scanner; }

        [HttpGet("status")]
        public IActionResult GetStatus() => Ok(_scanner.Status);

        [HttpPost("start")]
        public IActionResult StartScan([FromBody] ScanRequest request)
        {
            if (string.IsNullOrEmpty(request?.ProjectPath))
                return BadRequest("projectPath обязателен");
            if (!System.IO.File.Exists(request.ProjectPath))
                return NotFound($"Файл не найден: {request.ProjectPath}");
            if (_scanner.Status.IsRunning)
                return Conflict("Сканирование уже запущено");
            _ = _scanner.ScanAsync(request.ProjectPath);
            return Ok(new { message = "Сканирование запущено", status = "running" });
        }

        [HttpGet("cache")]
        public IActionResult CheckCache([FromQuery] string projectPath)
        {
            if (string.IsNullOrEmpty(projectPath))
                return BadRequest("projectPath обязателен");
            var cached = _scanner.TryLoadCache(projectPath);
            return Ok(new
            {
                status          = cached.Status.ToString(),
                isValid         = cached.IsValid,
                isStale         = cached.IsStale,
                needsScan       = cached.NeedsScan,
                projectModified = cached.ProjectModified,
                cachedModified  = cached.CachedModified,
                results         = cached.Results
            });
        }
    }

    // ══════════════════════════════════════════════════════
    // PROJECT
    // ══════════════════════════════════════════════════════
    [ApiController]
    [Route("api/project")]
    public class ProjectController : ControllerBase
    {
        private readonly ProjectService _project;
        public ProjectController(ProjectService project) { _project = project; }

        [HttpDelete("plc/{plcId}")]
        public IActionResult DeletePlc(string plcId)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            var plc = _project.Current.PlcSources.FirstOrDefault(p => p.Id == plcId);
            if (plc == null) return NotFound();
            _project.Current.PlcSources.Remove(plc);
            return Ok();
        }

        [HttpGet]
        public IActionResult Get()
        {
            if (!_project.IsLoaded) return Ok(new { loaded = false });
            return Ok(new { loaded = true, project = _project.Current, filePath = _project.CurrentFilePath });
        }

        [HttpPost("new")]
        public IActionResult New([FromBody] NewProjectRequest request)
        {
            _project.New(request?.Name ?? "Новый проект");
            return Ok(_project.Current);
        }

        [HttpPost("load")]
        public IActionResult Load([FromBody] FilePathRequest request)
        {
            try { _project.Load(request.FilePath); return Ok(_project.Current); }
            catch (Exception ex) { return BadRequest(ex.Message); }
        }

        [HttpPost("save")]
        public IActionResult Save([FromBody] FilePathRequest request = null)
        {
            try
            {
                _project.Save(request?.FilePath);
                return Ok(new { saved = true, filePath = _project.CurrentFilePath });
            }
            catch (Exception ex) { return BadRequest(ex.Message); }
        }

        [HttpPost("plc")]
        public IActionResult AddPlc([FromBody] AddPlcRequest request)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            var plc = new PlcMonitor.Monitoring.PlcSource
            {
                Name = request.Name, IpAddress = request.IpAddress,
                Rack = request.Rack, Slot = request.Slot,
                TiaProjectPath = request.TiaProjectPath,
                PlcNameInProject = request.PlcNameInProject
            };
            _project.Current.PlcSources.Add(plc);
            return Ok(plc);
        }

        [HttpPost("group")]
        public IActionResult CreateGroup([FromBody] CreateGroupRequest request)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            return Ok(_project.Current.CreateGroup(request.Name, request.PollIntervalMs));
        }

        [HttpPost("tag")]
        public IActionResult AddTag([FromBody] AddTagRequest request)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            var tag = _project.Current.AddTagManual(
                request.PlcSourceId, request.SymbolicPath, request.DataType,
                request.DbNumber, request.ByteOffset, request.AbsoluteAddress,
                request.DisplayName, request.GroupId);
            return Ok(tag);
        }

        [HttpPost("group/{groupId}/tag/{tagId}")]
        public IActionResult AddTagToGroup(string groupId, string tagId)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            _project.Current.AddTagToGroup(tagId, groupId);
            return Ok();
        }

        [HttpDelete("group/{groupId}/tag/{tagId}")]
        public IActionResult RemoveTagFromGroup(string groupId, string tagId)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            _project.Current.RemoveTagFromGroup(tagId, groupId);
            return Ok();
        }

        [HttpPatch("tag/{tagId}/enable")]
        public IActionResult EnableTag(string tagId)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            _project.Current.EnableTag(tagId);
            return Ok();
        }

        [HttpPatch("tag/{tagId}/disable")]
        public IActionResult DisableTag(string tagId)
        {
            if (!_project.IsLoaded) return BadRequest("Проект не открыт");
            _project.Current.DisableTag(tagId);
            return Ok();
        }
    }

    // ══════════════════════════════════════════════════════
    // CONFIG — defaults + file/folder dialogs
    // ══════════════════════════════════════════════════════
    [ApiController]
    [Route("api/config")]
    public class ConfigController : ControllerBase
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();
        private static void BringToFront()
        {
            try { SetForegroundWindow(GetConsoleWindow()); } catch { }
        }

        [HttpGet("check-path")]
        public IActionResult CheckPath([FromQuery] string path)
        {
            if (string.IsNullOrEmpty(path))
                return Ok(new { exists = false });
            return Ok(new { exists = System.IO.File.Exists(path) });
        }

        [HttpGet("defaults")]
        public IActionResult GetDefaults()
        {
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Ok(new
            {
                defaultSaveDir = Path.Combine(docs, "PlcMonitor"),
                username       = Environment.UserName
            });
        }

        [HttpGet("browse-folder")]
        public IActionResult BrowseFolder([FromQuery] string initial = null)
        {
            try
            {
                var selectedPath = string.Empty;
                var startPath = initial?.TrimEnd('\\').TrimEnd('/') ??
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);

                var thread = new System.Threading.Thread(() =>
                {
                    BringToFront();
                    var dialog = new System.Windows.Forms.FolderBrowserDialog
                    {
                        Description         = "Выберите папку для сохранения проекта",
                        ShowNewFolderButton = true,
                        SelectedPath        = Directory.Exists(startPath) ? startPath :
                            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
                    };
                    if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                        selectedPath = dialog.SelectedPath;
                });
                thread.SetApartmentState(System.Threading.ApartmentState.STA);
                thread.Start();
                thread.Join();

                if (string.IsNullOrEmpty(selectedPath))
                    return Ok(new { cancelled = true,  path = (string)null });
                return Ok(new     { cancelled = false, path = selectedPath });
            }
            catch (Exception ex) { return BadRequest(ex.Message); }
        }

        [HttpGet("plc-names")]
        public IActionResult GetPlcNames([FromQuery] string projectPath)
        {
            if (string.IsNullOrEmpty(projectPath) || !System.IO.File.Exists(projectPath))
                return Ok(new { plcs = Array.Empty<object>() });
            try
            {
                var scanner = new PlcMonitor.Scanner.TiaProjectScanner();
                var names   = scanner.GetPlcNames(projectPath);
                return Ok(new { plcs = names });
            }
            catch (Exception ex)
            {
                return Ok(new { plcs = Array.Empty<object>(), error = ex.Message });
            }
        }

        [HttpGet("browse-file")]
        public IActionResult BrowseFile()
        {
            try
            {
                var selectedPath = string.Empty;
                var initialDir   = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    "PlcMonitor");

                var thread = new System.Threading.Thread(() =>
                {
                    BringToFront();
                    var dialog = new System.Windows.Forms.OpenFileDialog
                    {
                        Title            = "Открыть проект мониторинга",
                        Filter           = "PLC Monitor (*.plcmon)|*.plcmon|Все файлы (*.*)|*.*",
                        InitialDirectory = Directory.Exists(initialDir) ? initialDir :
                            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
                    };
                    if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                        selectedPath = dialog.FileName;
                });
                thread.SetApartmentState(System.Threading.ApartmentState.STA);
                thread.Start();
                thread.Join();

                if (string.IsNullOrEmpty(selectedPath))
                    return Ok(new { cancelled = true,  path = (string)null });
                return Ok(new     { cancelled = false, path = selectedPath });
            }
            catch (Exception ex) { return BadRequest(ex.Message); }
        }

        [HttpGet("browse-tia")]
        public IActionResult BrowseTiaProject()
        {
            try
            {
                var selectedPath = string.Empty;
                var initialDir   = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    "Automation");

                var thread = new System.Threading.Thread(() =>
                {
                    BringToFront();
                    var dialog = new System.Windows.Forms.OpenFileDialog
                    {
                        Title            = "Открыть проект TIA Portal",
                        Filter           = "TIA Portal (*.ap15;*.ap16;*.ap17;*.ap18;*.ap19;*.ap20;*.ap21)|*.ap15;*.ap16;*.ap17;*.ap18;*.ap19;*.ap20;*.ap21|Все файлы (*.*)|*.*",
                        InitialDirectory = Directory.Exists(initialDir) ? initialDir :
                            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
                    };
                    if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                        selectedPath = dialog.FileName;
                });
                thread.SetApartmentState(System.Threading.ApartmentState.STA);
                thread.Start();
                thread.Join();

                if (string.IsNullOrEmpty(selectedPath))
                    return Ok(new { cancelled = true,  path = (string)null });
                return Ok(new     { cancelled = false, path = selectedPath });
            }
            catch (Exception ex) { return BadRequest(ex.Message); }
        }
    }   

    // ══════════════════════════════════════════════════════
    // REQUEST MODELS
    // ══════════════════════════════════════════════════════
    public class ScanRequest       { public string ProjectPath    { get; set; } }
    public class FilePathRequest   { public string FilePath       { get; set; } }
    public class NewProjectRequest { public string Name           { get; set; } }

    public class AddPlcRequest
    {
        public string Name             { get; set; }
        public string IpAddress        { get; set; }
        public int    Rack             { get; set; } = 0;
        public int    Slot             { get; set; } = 1;
        public string TiaProjectPath   { get; set; }
        public string PlcNameInProject { get; set; }
    }

    public class CreateGroupRequest
    {
        public string Name           { get; set; }
        public int    PollIntervalMs { get; set; } = 500;
    }

    public class AddTagRequest
    {
        public string PlcSourceId     { get; set; }
        public string SymbolicPath    { get; set; }
        public string DataType        { get; set; }
        public string DisplayName     { get; set; }
        public int?   DbNumber        { get; set; }
        public int?   ByteOffset      { get; set; }
        public string AbsoluteAddress { get; set; }
        public string GroupId         { get; set; }
    }

}   // ← конец namespace