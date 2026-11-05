@echo off
REM Launch the mpv built from your own source tree (bin\ folder).
REM Drag a video file onto this .bat, or run: run-mpv.bat "D:\movie.mkv"
start "" "%~dp0bin\mpv.exe" %*
