r"""一键启动画布：已在跑就直接开浏览器，没跑就先起服务再开。

为什么用 Python 而不是纯 bat：纯 bat 里 `timeout` 在重定向 stdin 时会报错、
`start /min` 容易把 cmd 卡住不退出。这些坑都不值得踩。

**这个脚本由 pythonw.exe 启动（无控制台）**，`sys.stdout` / `sys.stderr` 都是 None。
所以绝对不能用 `print()`——直接 print 在第一行就抛 AttributeError，
浏览器永远不会打开。
所有输出走 `_say()`，同时落到 `_agent\out\canvas_launch.log` 方便事后查。
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import traceback
import webbrowser

PORT = 8766
HERE = os.path.dirname(os.path.abspath(__file__))          # _agent/tools
AGENT = os.path.dirname(HERE)                              # _agent


def _arg_port() -> int:
    """端口：--port N > 环境变量 CANVAS_PORT > 默认 8766。

    发布版固定 8766：本地版（主工程）用 8765，两边能同时跑、互不打架。
    """
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            try:
                return int(sys.argv[i + 1])
            except ValueError:
                pass
        elif a.startswith("--port="):
            try:
                return int(a.split("=", 1)[1])
            except ValueError:
                pass
    try:
        return int(os.environ.get("CANVAS_PORT") or PORT)
    except ValueError:
        return PORT


def _url(port: int) -> str:
    return f"http://127.0.0.1:{port}/"


def _python() -> str:
    """用**当前跑这个脚本的那个解释器**，别假设它装在哪。

    用户在另一台机器上双击 `启动画布.bat`，报"找不到 python.exe"：
    原来写的是 `..\\python\\python.exe`，那是秋葉整合包的目录结构，
    标准 ComfyUI / 自建 venv / 系统 Python 都没有这个目录。

    另外 pythonw.exe 没有控制台，用它跑 server.py 会丢掉 stdout（日志全丢），
    所以如果是 pythonw，换成同目录的 python.exe。
    """
    exe = sys.executable or ""
    if not exe:
        return "python"
    base, name = os.path.split(exe)
    if name.lower() == "pythonw.exe":
        cand = os.path.join(base, "python.exe")
        if os.path.isfile(cand):
            return cand
    return exe
LAUNCH_LOG = os.path.join(AGENT, "out", "canvas_launch.log")
NO_WINDOW = 0x08000000


def _say(msg: str) -> None:
    """输出一行：能显示就显示在控制台，同时一定写进 canvas_launch.log。

    调试阶段用 python.exe 跑（bat 里就是），控制台是 GBK——中文没问题，
    但 `…` 这类字符在 GBK 下可能编码失败被静默吞掉，所以出错时按 replace 再写一次，
    宁可显示成问号，也别整行消失（看不见输出等于没法查）。
    """
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        if sys.stdout is not None:
            try:
                sys.stdout.write(line + "\n")
            except UnicodeEncodeError:
                enc = sys.stdout.encoding or "gbk"
                sys.stdout.write(line.encode(enc, "replace").decode(enc) + "\n")
            sys.stdout.flush()
    except Exception:  # noqa: BLE001 - pythonw 下 stdout 是 None
        pass
    try:
        os.makedirs(os.path.dirname(LAUNCH_LOG), exist_ok=True)
        with open(LAUNCH_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _alert(msg: str) -> None:
    """没有控制台（pythonw 双击启动）时，用系统对话框把话说明白。"""
    if sys.stdout is not None:
        return
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "GuoBaoCanvas", 0x10)
    except Exception:  # noqa: BLE001
        pass


def port_open(port: int, timeout: float = 0.6) -> bool:
    with socket.socket() as s:
        s.settimeout(timeout)
        return s.connect_ex(("127.0.0.1", port)) == 0


def open_browser(url: str) -> bool:
    """开浏览器。**cmd start 放第一位**，这是实测唯一可靠的那条。

    实测（用 Edge 窗口标题验证）：`cmd /c start "" <url>` 真的打开新页面；
    而在 pythonw（无控制台）里，`webbrowser.open` → 底层 os.startfile
    **返回 True 但浏览器不弹**，排在第一就会提前 return，永远走不到能用的那条。
    所以顺序是：cmd start → os.startfile → webbrowser。
    """
    if os.name == "nt":
        try:
            subprocess.Popen(["cmd", "/c", "start", "", url],
                             creationflags=NO_WINDOW,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _say("已用 cmd start 打开浏览器")
            return True
        except OSError as exc:
            _say(f"cmd start 失败：{exc}")
        try:
            os.startfile(url)          # noqa: S606 - 就是要调 ShellExecute
            _say("已用 os.startfile 打开浏览器")
            return True
        except OSError as exc:
            _say(f"os.startfile 失败：{exc}")
    try:
        if webbrowser.open(url, new=0, autoraise=True):
            _say("已用 webbrowser 打开浏览器")
            return True
        _say("webbrowser.open 返回 False")
    except Exception as exc:  # noqa: BLE001
        _say(f"webbrowser.open 抛错：{type(exc).__name__}: {exc}")
    return False


# 画布后端需要的第三方包（模块名, pip 包名）。缺了 server.py 会在第 22 行
# `from fastapi import ...` 就崩，而且崩在 detached 子进程里——控制台只看到一串
# traceback。
# 只在启动前用**同一个解释器**试 import，缺什么就点名报什么，别让人去猜。
_DEPS = [
    ("fastapi", "fastapi"), ("uvicorn", "uvicorn"), ("pydantic", "pydantic"),
    ("python_multipart", "python-multipart"), ("multipart", "python-multipart"),
    ("numpy", "numpy"), ("cv2", "opencv-python"), ("PIL", "Pillow"),
    ("websockets", "websockets"), ("imageio_ffmpeg", "imageio-ffmpeg"),
]


def _missing_deps(py: str) -> str:
    """试 import 画布依赖，返回缺的 pip 包名（逗号分隔；空串 = 齐了）。"""
    code = (
        "import importlib, json\n"
        "mods = " + repr(_DEPS) + "\n"
        "bad = []\n"
        "for mod, pkg in mods:\n"
        "    try:\n"
        "        importlib.import_module(mod)\n"
        "    except Exception:\n"
        "        bad.append(pkg)\n"
        "print(json.dumps(bad))\n"
    )
    try:
        r = subprocess.run([py, "-c", code], capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        return f"解释器跑不起来（{type(exc).__name__}: {exc}）"
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()
        return tail[-1] if tail else "解释器执行失败"
    try:
        bad = json.loads((r.stdout or "").strip() or "[]")
    except Exception:  # noqa: BLE001
        return ""
    seen = []
    for pkg in bad:          # python_multipart / multipart 两个模块名对应同一个包，只报一次
        if pkg not in seen:
            seen.append(pkg)
    return ", ".join(seen)


def main() -> int:
    port = _arg_port()
    url = _url(port)
    no_browser = "--no-browser" in sys.argv

    if port_open(port):
        _say(f"画布已在运行：{url}")
        if not no_browser and not open_browser(url):
            _say(f"服务在跑，但没能自动打开浏览器，手动打开这个地址：{url}")
        return 0

    py = _python()
    missing = _missing_deps(py)
    if missing:
        _say(f"缺 Python 依赖：{missing}")
        _say("一键装：双击同目录的「安装依赖.bat」")
        _say(f"手动装（必须用同一个解释器）：\"{py}\" -m pip install -r \"{os.path.join(AGENT, 'requirements.txt')}\"")
        _say("如果这台机器装了 ComfyUI，也可以改用 ComfyUI 自带的 python 跑（它通常已经有这些依赖）。")
        _say("装完再双击一次 启动画布.bat。")
        _alert(f"缺 Python 依赖：{missing}\n\n"
               f"双击同目录的「安装依赖.bat」即可。\n\n"
               f"手动装（必须用同一个解释器）：\n\"{py}\" -m pip install -r "
               f"\"{os.path.join(AGENT, 'requirements.txt')}\"")
        return 1

    _say(f"启动画布 {url} …")
    try:
        log = open(os.path.join(AGENT, "out", "canvas.log"), "ab")
    except OSError:
        log = subprocess.DEVNULL
    kwargs = {}
    if os.name == "nt":
        # 脱离当前控制台，关掉这个窗口也不影响服务
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    server = os.path.join(AGENT, "canvas", "server.py")
    try:
        proc = subprocess.Popen(
            [py, server, "--port", str(port)],
            cwd=AGENT, stdout=log, stderr=log, stdin=subprocess.DEVNULL, **kwargs)
    except OSError as exc:
        _say(f"起不来 python：{exc}")
        _say(f"试着自己跑：\"{py}\" \"{server}\" --port {port}")
        _alert(f"起不来 python：{exc}\n\n试着手动跑：\n\"{py}\" \"{server}\" --port {port}")
        return 1

    # **必须等端口真的通了再开浏览器**。以前 bat 里等固定 4 秒，冷启动
    # （import fastapi 等）比 4 秒慢，浏览器先开出来就是"无法连接"。
    for _ in range(90):          # 最多等 45 秒
        if port_open(port):
            break
        if proc.poll() is not None:      # 进程已经死了
            _say("服务启动失败，看这个日志：" + os.path.join(AGENT, "out", "canvas.log"))
            _alert("画布服务没起来。日志：\n" + os.path.join(AGENT, "out", "canvas.log"))
            return 1
        time.sleep(0.5)
    else:
        _say("等了 45 秒端口还没起来，看日志：" + os.path.join(AGENT, "out", "canvas.log"))
        _alert("端口 45 秒没起来。日志：\n" + os.path.join(AGENT, "out", "canvas.log"))
        return 1

    _say(f"已启动（PID {proc.pid}），端口 {port} 已就绪")
    if not no_browser and not open_browser(url):
        _say(f"服务起来了，但没能自动打开浏览器，手动打开这个地址：{url}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise                      # 正常退出，别记成崩溃
    except BaseException:
        # pythonw 下崩了没人看得见，至少留一条痕迹
        _say("启动器崩了：\n" + traceback.format_exc())
        _alert("启动器崩了：\n" + traceback.format_exc()[-1200:])
        raise
