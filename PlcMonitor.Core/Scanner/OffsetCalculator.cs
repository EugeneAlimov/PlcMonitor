using System.Collections.Generic;
using System.Linq;

namespace PlcMonitor.Scanner
{
    /// <summary>
    /// Вычисляет байтовые смещения для оптимизированных DB.
    ///
    /// Алгоритм Siemens для оптимизированных DB:
    /// Компилятор НЕ хранит переменные в порядке объявления.
    /// Он группирует их по размеру типа — от большего к меньшему,
    /// внутри группы — в порядке объявления.
    ///
    /// Порядок групп:
    ///   1. 8 байт: LReal, LInt, ULInt, LWord, LTime, LDT, LTOD
    ///   2. 4 байта: Real, DInt, UDInt, DWord, Time, Date_And_Time, TOD, DT
    ///   3. 2 байта: Int, UInt, Word, Date, S5Time, WChar
    ///   4. 1 байт:  Byte, Char, SInt, USInt
    ///   5. 1 бит:   Bool (упаковываются побайтово, по 8 штук)
    ///   6. Сложные: Struct, UDT, Array (рекурсивно)
    ///   7. String, WString (в конце)
    ///
    /// ВАЖНО: Это приближение. Для точных смещений нужна верификация
    /// через TIA Portal онлайн или через экспорт скомпилированных данных.
    /// </summary>
    public class OptimizedDbOffsetCalculator
    {
        // Размеры базовых типов в байтах
        private static readonly Dictionary<string, int> TypeByteSize =
            new Dictionary<string, int>(System.StringComparer.OrdinalIgnoreCase)
        {
            // 8 байт
            ["LReal"]  = 8, ["LInt"]  = 8, ["ULInt"] = 8,
            ["LWord"]  = 8, ["LTime"] = 8, ["LDT"]   = 8, ["LTOD"] = 8,

            // 4 байта
            ["Real"]   = 4, ["DInt"]  = 4, ["UDInt"] = 4,
            ["DWord"]  = 4, ["Time"]  = 4, ["TOD"]   = 4,
            ["Date_And_Time"] = 8,          // DT = 8 байт (BCD формат)
            ["DT"]     = 8,

            // 2 байта
            ["Int"]    = 2, ["UInt"]  = 2, ["Word"]  = 2,
            ["Date"]   = 2, ["S5Time"]= 2, ["WChar"] = 2,

            // 1 байт
            ["Byte"]   = 1, ["Char"]  = 1, ["SInt"]  = 1, ["USInt"] = 1,

            // 1 бит (специальная обработка)
            ["Bool"]   = 0,  // 0 = обрабатываем отдельно как битовые
        };

        // Приоритет группы для сортировки (меньше = раньше в памяти)
        private static int GetGroupPriority(string dataType)
        {
            if (!TypeByteSize.TryGetValue(dataType, out var size))
                return 6; // Struct/UDT/Array

            return size switch
            {
                8 => 1,
                4 => 2,
                2 => 3,
                1 => 4,
                0 => 5,  // Bool
                _ => 6
            };
        }

        /// <summary>
        /// Вычисляет смещения для списка членов оптимизированного DB.
        /// Модифицирует теги на месте — проставляет ByteOffset и BitOffset.
        /// </summary>
        public void Calculate(List<ScannedTag> members)
        {
            // Стартуем с нулевого смещения
            var ctx = new LayoutContext();
            LayoutMembers(members, ctx);
        }

        private void LayoutMembers(List<ScannedTag> members, LayoutContext ctx)
        {
            // Разбиваем членов на группы по размеру типа
            // ВАЖНО: внутри каждой группы сохраняем порядок объявления
            var grouped = members
                .Select((m, idx) => (member: m, order: idx,
                                     priority: GetGroupPriority(m.DataType)))
                .OrderBy(x => x.priority)
                .ThenBy(x => x.order)
                .ToList();

            // Сначала раскладываем все Bool отдельно (они упакованы)
            var bools   = grouped.Where(x => x.priority == 5).ToList();
            var nonBool = grouped.Where(x => x.priority != 5).ToList();

            // Раскладываем не-Bool типы
            foreach (var (member, _, _) in nonBool)
            {
                LayoutSingleMember(member, ctx);
            }

            // Раскладываем Bool (побайтовая упаковка)
            if (bools.Count > 0)
            {
                // Выравниваем на байтовую границу если нужно
                // Bool блок начинается с текущего байта
                int bitPos = 0;
                foreach (var (member, _, _) in bools)
                {
                    member.ByteOffset = ctx.CurrentByte;
                    member.BitOffset  = bitPos;

                    bitPos++;
                    if (bitPos == 8)
                    {
                        bitPos = 0;
                        ctx.CurrentByte++;
                    }
                }

                // Если последний байт не заполнен полностью — переходим к следующему
                if (bitPos > 0) ctx.CurrentByte++;
            }
        }

        private void LayoutSingleMember(ScannedTag member, LayoutContext ctx)
        {
            var dataType = member.DataType ?? "";

            // Если это составной тип (Struct/UDT) — рекурсивно
            if (member.IsComplex)
            {
                // Struct выравнивается по наибольшему из своих членов
                int alignment = GetStructAlignment(member.Children);
                ctx.Align(alignment);
                member.ByteOffset = ctx.CurrentByte;

                var innerCtx = new LayoutContext(ctx.CurrentByte);
                LayoutMembers(member.Children, innerCtx);
                ctx.CurrentByte = innerCtx.CurrentByte;
                return;
            }

            // Примитивный тип
            if (!TypeByteSize.TryGetValue(dataType, out var size) || size == 0)
            {
                // Неизвестный тип — пропускаем с предупреждением
                member.ByteOffset = ctx.CurrentByte;
                return;
            }

            // Выравнивание: тип размером N байт выравнивается по N
            ctx.Align(size);
            member.ByteOffset = ctx.CurrentByte;
            ctx.CurrentByte += size;
        }

        private int GetStructAlignment(List<ScannedTag> members)
        {
            // Выравнивание структуры = максимальное выравнивание среди членов
            int max = 1;
            foreach (var m in members)
            {
                if (TypeByteSize.TryGetValue(m.DataType ?? "", out var s) && s > max)
                    max = s;
            }
            return max > 8 ? 8 : max; // максимум 8 байт
        }

        // ─────────────────────────────────────────────
        // Вспомогательный класс — текущая позиция в памяти
        // ─────────────────────────────────────────────
        private class LayoutContext
        {
            public int CurrentByte { get; set; }

            public LayoutContext(int startByte = 0)
            {
                CurrentByte = startByte;
            }

            // Выровнять на границу alignment байт
            public void Align(int alignment)
            {
                if (alignment <= 1) return;
                int remainder = CurrentByte % alignment;
                if (remainder != 0)
                    CurrentByte += alignment - remainder;
            }
        }
    }
}
