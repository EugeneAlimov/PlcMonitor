using System;
using PlcMonitor.Monitoring;

namespace PlcMonitor.Web.Services
{
    public class ProjectService
    {
        public MonitoringProject Current { get; private set; }
        public string CurrentFilePath { get; private set; }
        public bool IsLoaded => Current != null;

        public void New(string name)
        {
            Current = new MonitoringProject { Name = name };
            CurrentFilePath = null;
        }

        public void Load(string filePath)
        {
            Current = MonitoringProjectFile.Load(filePath);
            CurrentFilePath = filePath;
        }

        public void Save(string filePath = null)
        {
            if (Current == null) return;
            var path = filePath ?? CurrentFilePath;
            if (string.IsNullOrEmpty(path))
                throw new InvalidOperationException("Путь не указан");
            MonitoringProjectFile.Save(Current, path);
            CurrentFilePath = path;
        }
    }
}
