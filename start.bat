@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Останавливаем предыдущий экземпляр...
taskkill /f /im PlcMonitor.Web.exe 2>nul
timeout /t 1 /nobreak >nul

echo Сборка проекта...
dotnet build PlcMonitor.Web\PlcMonitor.Web.csproj -p:Platform=x64 -p:Configuration=Debug -v:quiet

if %errorlevel% neq 0 (
    echo ОШИБКА СБОРКИ
    pause
    exit /b 1
)

echo Запуск PlcMonitor...
cd PlcMonitor.Web
..\PlcMonitor.Web\bin\x64\Debug\net8.0-windows\PlcMonitor.Web.exe