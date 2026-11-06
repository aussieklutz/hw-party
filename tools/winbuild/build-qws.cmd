@echo on
setlocal

:: Build the Qt WebSockets module against the already-installed Qt 6
set "QT_WEBSOCKETS_SRC=Z:/Qt/qtwebsockets-everywhere-src-6.10.1"
set "QT_INSTALL_DIR=Z:/Qt/Qt6"
set "MINGW_BIN=Z:/w64devkit/bin"
set "CMAKE_ROOT=Z:/cmake-4.2.1-windows-x86_64"
set "NINJA_ROOT=Z:/ninja"

set "PATH=%MINGW_BIN%;%CMAKE_ROOT%/bin;%NINJA_ROOT%;%PATH%"

mkdir BuildWS
cd BuildWS

echo Configuring Qt WebSockets...
call "%QT_INSTALL_DIR%\bin\qt-configure-module.bat" "%QT_WEBSOCKETS_SRC%"
if %errorlevel% neq 0 (
    echo Configure failed!
    exit /b 1
)

echo Building Qt WebSockets...
cmake --build . --parallel
if %errorlevel% neq 0 (
    echo Build failed!
    exit /b 1
)

echo Installing Qt WebSockets...
cmake --install .
if %errorlevel% neq 0 (
    echo Install failed!
    exit /b 1
)

cd ..
del /s /q BuildWS
