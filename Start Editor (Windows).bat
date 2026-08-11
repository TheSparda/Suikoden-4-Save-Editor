@echo off
REM Double-click launcher (Windows). Starts the Suikoden IV editor.
cd /d "%~dp0Editor"
python s4editor.py "..\Base ISO\Suikoden IV (USA).iso"
pause
