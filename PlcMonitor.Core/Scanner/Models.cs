using System.Collections.Generic;

namespace PlcMonitor.Scanner
{
    // ─────────────────────────────────────────────
    // Типы тегов — откуда тег
    // ─────────────────────────────────────────────
    public enum TagSource
    {
        TagTable,       // Таблица тегов PLC (I/Q/M/...)
        GlobalDb,       // Глобальный DB
        InstanceDb,     // Инстанционный DB (от FB)
        FbStatic,       // Static переменная FB → хранится в Instance DB
        FbInput,        // Input FB → только во время вызова
        FbOutput,       // Output FB → только во время вызова
        FbInOut,        // InOut FB → только во время вызова
        FbTemp,         // Temp FB → только во время выполнения, не читаемо
        FcInput,        // Input FC → только во время вызова
        FcOutput,       // Output FC → только во время вызова
        FcInOut,        // InOut FC → только во время вызова
        FcTemp,         // Temp FC → не читаемо
        Manual          // Добавлен пользователем вручную
    }

    // Можно ли читать тег из ПЛК в реальном времени
    public static class TagSourceExtensions
    {
        public static bool IsMonitorable(this TagSource source) => source switch
        {
            TagSource.TagTable   => true,
            TagSource.GlobalDb   => true,
            TagSource.InstanceDb => true,
            TagSource.FbStatic   => true,
            TagSource.Manual     => true,
            // Всё остальное — только во время выполнения блока
            _                    => false
        };
    }

    // ─────────────────────────────────────────────
    // Один тег
    // ─────────────────────────────────────────────
    public class ScannedTag
    {
        // Отображаемое имя (последний сегмент пути)
        public string Name { get; set; }

        // Полный символьный путь: "DB_Motor".Motor_1.Speed
        public string SymbolicPath { get; set; }

        // Тип данных: Real, Bool, Int, DInt, ...
        public string DataType { get; set; }

        // Откуда тег
        public TagSource Source { get; set; }

        // Можно ли мониторить
        public bool IsMonitorable => Source.IsMonitorable();

        // Для DB тегов — номер DB (нужен для snap7)
        public int? DbNumber { get; set; }

        // Для Tag Table — абсолютный адрес (%MD0, %Q0.0, ...)
        public string AbsoluteAddress { get; set; }

        // Байтовое смещение в DB (вычисляется для optimized DB)
        // null = ещё не вычислено или не применимо
        public int? ByteOffset { get; set; }

        // Для Bool — номер бита внутри байта (0-7)
        public int? BitOffset { get; set; }

        // Начальное значение из проекта (для справки)
        public string StartValue { get; set; }

        // Комментарий из проекта
        public string Comment { get; set; }

        // Вложенные теги (если это Struct или UDT — разворачиваем)
        public List<ScannedTag> Children { get; set; } = new();

        // Признак что тип составной (Struct/UDT/Array)
        public bool IsComplex => Children.Count > 0;
    }

    // ─────────────────────────────────────────────
    // Таблица тегов PLC
    // ─────────────────────────────────────────────
    public class ScannedTagTable
    {
        public string Name { get; set; }
        public string GroupPath { get; set; } // путь группы в дереве
        public List<ScannedTag> Tags { get; set; } = new();
    }

    // ─────────────────────────────────────────────
    // Data Block
    // ─────────────────────────────────────────────
    public class ScannedDataBlock
    {
        public string Name { get; set; }
        public int Number { get; set; }           // номер DB
        public bool IsOptimized { get; set; }     // S7_Optimized_Access
        public bool IsInstanceDb { get; set; }    // Instance DB от FB
        public string InstanceOfFb { get; set; } // имя FB если Instance DB
        public string GroupPath { get; set; }
        public List<ScannedTag> Members { get; set; } = new();
    }

    // ─────────────────────────────────────────────
    // Function Block
    // ─────────────────────────────────────────────
    public class ScannedFunctionBlock
    {
        public string Name { get; set; }
        public int Number { get; set; }
        public string GroupPath { get; set; }

        // Разделяем по секциям интерфейса
        public List<ScannedTag> Input   { get; set; } = new();
        public List<ScannedTag> Output  { get; set; } = new();
        public List<ScannedTag> InOut   { get; set; } = new();
        public List<ScannedTag> Static  { get; set; } = new(); // ← читаемо
        public List<ScannedTag> Temp    { get; set; } = new(); // ← не читаемо
    }

    // ─────────────────────────────────────────────
    // Function (FC)
    // ─────────────────────────────────────────────
    public class ScannedFunction
    {
        public string Name { get; set; }
        public int Number { get; set; }
        public string GroupPath { get; set; }

        public List<ScannedTag> Input   { get; set; } = new();
        public List<ScannedTag> Output  { get; set; } = new();
        public List<ScannedTag> InOut   { get; set; } = new();
        public List<ScannedTag> Temp    { get; set; } = new(); // ← не читаемо
    }

    // ─────────────────────────────────────────────
    // Результат сканирования одного ПЛК
    // ─────────────────────────────────────────────
    public class PlcScanResult
    {
        public string PlcName { get; set; }
        public string DeviceType { get; set; }    // S7-1500, S7-1200, ...

        // Метаданные проекта (для инвалидации кэша)
        public string ProjectPath { get; set; }
        public System.DateTime ProjectModified { get; set; }
        public string ScanTimestamp { get; set; }

        // Таблицы тегов
        public List<ScannedTagTable> TagTables { get; set; } = new();

        // Data Blocks
        public List<ScannedDataBlock> DataBlocks { get; set; } = new();

        // Function Blocks
        public List<ScannedFunctionBlock> FunctionBlocks { get; set; } = new();

        // Functions
        public List<ScannedFunction> Functions { get; set; } = new();

        // Ошибки и предупреждения при сканировании
        public List<string> Warnings { get; set; } = new();
    }
}
