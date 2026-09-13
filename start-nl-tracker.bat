@echo off
REM Startet den NL Tracker als einzelnen Prozess (Build + Server auf einem
REM Port). Funktioniert unabhaengig vom aktuellen Arbeitsverzeichnis, auch aus
REM der Windows-Aufgabenplanung/Autostart heraus (siehe README.md).
setlocal
cd /d "%~dp0"

echo ============================================
echo  NL Tracker wird gestartet (npm run serve)
echo  Danach erreichbar unter http://localhost:3001
echo  Dieses Fenster offen lassen - schliessen beendet den Server.
echo ============================================
echo.

call npm run serve

echo.
echo NL Tracker wurde beendet.
