@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
if not exist .env (
  call npm.cmd run setup
  if errorlevel 1 goto failed
)
echo.
echo 创作系统：http://127.0.0.1:3003/
echo 首次管理员凭据：.local\首次登录.txt
echo 每个用户登录后，从左侧 API 配置填写自己的 DeepSeek Key。
echo 关闭本窗口停止前后端；独立数据库保留运行。
call npm.cmd run dev
goto end
:failed
echo 启动失败，请根据上方错误与 README.md 排查。
:end
pause
