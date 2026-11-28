"""ComfyUI 客户端：提交图、等结果、取产物、传图。

只做执行层，不含任何提示词逻辑。所有函数同步阻塞，便于在 CLI 和 HTTP 里共用。

**不写死任何路径**：ComfyUI 根目录与地址都问 `core.settings`，
顺序是「设置面板 > 环境变量 > 自动探测」。
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from . import settings

CLIENT_ID = "dsh-canvas-progress"  # 固定：与 core/progress.py 的 /ws clientId 对齐，采样进度才能回流


class ComfyError(RuntimeError):
    pass


# ---------------------------------------------------------------- 位置（每次都问设置，不缓存成常量）
def comfy_root() -> str:
    return settings.comfy_root()


def base() -> str:
    return settings.comfy_url()


def input_dir() -> str:
    root = comfy_root()
    return os.path.join(root, "input") if root else ""


def comfy_python() -> str:
    r"""找出 ComfyUI 自己用的解释器（体检里拿它验证某个包装没装）。找不到返回空串。

    先按常见布局找（整合包 / 便携包 / venv），都不中就**按端口反查正在跑的进程**——
    用户那套 ComfyUI 可能装在别的盘的随意位置，解释器未必在根目录旁边
    。
    """
    root = comfy_root()
    if root:
        cands = [
            os.path.join(root, os.pardir, "python", "python.exe"),          # 秋葉整合包
            os.path.join(root, os.pardir, "python_embeded", "python.exe"),  # 官方便携包
            os.path.join(root, "python.exe"),
            os.path.join(root, "venv", "Scripts", "python.exe"),
            os.path.join(root, ".venv", "Scripts", "python.exe"),
        ]
        for c in cands:
            c = os.path.normpath(c)
            if os.path.isfile(c):
                return c
    return _python_of_port(base())


def _python_of_port(url: str) -> str:
    """从"监听这个地址的进程"反查解释器路径（仅 Windows）。拿不到返回空串。"""
    if os.name != "nt":
        return ""
    try:
        port = urllib.parse.urlsplit(url).port or 8188
    except ValueError:
        port = 8188
    ps = (f"$p=(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue "
          f"| Select-Object -First 1).OwningProcess; if($p){{(Get-Process -Id $p).Path}}")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, timeout=20,
                           creationflags=0x08000000)
        out = (r.stdout or "").strip()
    except Exception:  # noqa: BLE001 - 没有 powershell / 超时都当拿不到
        return ""
    low = out.lower()
    if low.endswith(("python.exe", "pythonw.exe")) and os.path.isfile(out):
        return out
    return ""


def output_dir() -> str:
    root = comfy_root()
    return os.path.join(root, "output") if root else ""


def _req(path: str, body=None, timeout: int = 60):
    url = base() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise ComfyError(f"{path} -> HTTP {e.code}\n{detail[:1500]}") from None
    except urllib.error.URLError as e:
        raise ComfyError(f"连不上 ComfyUI ({base()})：{e.reason}") from None
    return json.loads(raw) if raw else None


def stats() -> dict:
    return _req("/system_stats", timeout=15)


def online() -> tuple[bool, str]:
    try:
        s = stats()
        dev = (s.get("devices") or [{}])[0]
        free = (dev.get("vram_free") or 0) / 2**30
        return True, f"{dev.get('name','?')} · 空闲 {free:.1f} GB"
    except ComfyError as e:
        return False, str(e)


def device_vram() -> dict:
    """当前设备的显存（GB）。拿不到就返回空 dict，别让体检因此出错。"""
    try:
        s = stats()
        d = (s.get("devices") or [{}])[0]
        return {
            "name": d.get("name", ""),
            "total_gb": round((d.get("vram_total") or 0) / 2**30, 1),
            "free_gb": round((d.get("vram_free") or 0) / 2**30, 1),
        }
    except ComfyError:
        return {}


def queue() -> dict:
    return _req("/queue", timeout=15)


def object_info(name: str | None = None):
    # 节点名可能带空格（如 "RIFE VFI"），必须转义，否则 urllib 直接抛 InvalidURL
    path = "/object_info" + ("/" + urllib.parse.quote(name, safe="") if name else "")
    return _req(path, timeout=120)


def upload_image(local_path: str, prefix: str = "ag") -> str:
    """把图放进 ComfyUI/input，返回节点里该写的文件名。同名同内容会复用，不重复占盘。"""
    if not os.path.isfile(local_path):
        raise ComfyError(f"图不存在：{local_path}")
    root_in = input_dir()
    if not root_in:
        raise ComfyError("没找到 ComfyUI 目录：在画布右上角「设置」里选一下 ComfyUI 文件夹")
    name = f"{prefix}_{os.path.basename(local_path)}"
    dst = os.path.join(root_in, name)
    if not (os.path.isfile(dst) and os.path.getsize(dst) == os.path.getsize(local_path)):
        os.makedirs(os.path.dirname(dst), exist_ok=True)  # prefix 带子目录（如 canvas/bundle）时要连子目录一起建
        with open(local_path, "rb") as src, open(dst, "wb") as out:
            while chunk := src.read(1 << 20):
                out.write(chunk)
        try:
            os.utime(root_in, None)   # 顶一下目录 mtime，让 ComfyUI 的文件列表重新扫
        except OSError:
            pass
    return name


def put_file(local_path: str, prefix: str = "ag") -> str:
    """把任意文件（视频）放进 ComfyUI/input，返回节点里该写的文件名。"""
    if not os.path.isfile(local_path):
        raise ComfyError(f"文件不存在：{local_path}")
    root_in = input_dir()
    if not root_in:
        raise ComfyError("没找到 ComfyUI 目录：在画布右上角「设置」里选一下 ComfyUI 文件夹")
    name = f"{prefix}_{os.path.basename(local_path)}"
    dst = os.path.join(root_in, name)
    if not (os.path.isfile(dst) and os.path.getsize(dst) == os.path.getsize(local_path)):
        os.makedirs(os.path.dirname(dst), exist_ok=True)  # prefix 带子目录（如 canvas/bundle）时要连子目录一起建
        with open(local_path, "rb") as src, open(dst, "wb") as out:
            while chunk := src.read(1 << 20):
                out.write(chunk)
        try:
            os.utime(root_in, None)   # 顶一下目录 mtime，让 ComfyUI 的文件列表重新扫
        except OSError:
            pass
    return name


def _trace_skill(label: str) -> None:
    import os as _os, time as _time
    path = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))),
                         "_agent", "out", "skill_trace.log")
    try:
        _os.makedirs(_os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"[skill: comfy-run] {_time.strftime('%Y-%m-%d %H:%M:%S')} 提交 {label}\n")
    except OSError:
        pass


def _loadimage_hint(errs: list[str]) -> str:
    """把「不在可选列表」翻译成人话：是没传进 input，还是传了但 ComfyUI 看不见。"""
    import re as _re

    names = _re.findall(r"LoadImage\.image = '([^']+)'", " ".join(errs))
    if not names:
        return ""
    d = input_dir()
    if not d:
        return "\n\n提示：没找到 ComfyUI 目录，先去「设置 → ComfyUI 文件夹」选一下。"
    missing = [n for n in names if not os.path.isfile(os.path.join(d, n))]
    if missing:
        return ("\n\n提示：这些文件在画布指的 input 里不存在：" + ", ".join(missing)
                + f"\n    画布指的 input：{d}"
                + "\n    要么参考图源文件没了（回角色/场景卡重新生成），要么图被传到了别的目录。")
    return ("\n\n提示：这些文件确实在 " + d + "，但 " + base() + " 这个 ComfyUI 看不到 —— "
            "多半是画布连的 ComfyUI 和文件所在的 ComfyUI 不是同一个（两台 ComfyUI / 换了端口）。"
            "先对一下「设置 → ComfyUI 地址」和正在跑的那个。")


def _precheck_guard(graph: dict) -> None:
    """**所有图**的提交前体检：结构 / 取值 / 专项规则，不合格就地拒绝，绝不进队列。

    为什么放在 submit 里：连交三版 Wan-Dancer 废片（漏 start_image / 漏 local 段 /
    漏官方提示词后缀），每版 10–77 分钟。检查必须发生在提交前，出片后再查 = 时间已经浪费。
    通用件在 tools/preflight.py：结构、取值、下拉合法性，缺一项就地拒绝。
    """
    import sys
    tools = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    import preflight  # noqa: PLC0415

    errs = preflight.check_graph(graph)
    if errs:
        # /object_info 是进程内缓存，而且 ComfyUI 那边也有目录列表缓存：刚上传的参考图
        # 可能还没进两份列表。清缓存 + 等一下，给两次机会；真是缺文件就还会报同样的错。
        import time as _t  # noqa: PLC0415
        for _ in range(2):
            preflight.reset_cache()
            _t.sleep(0.5)
            errs = preflight.check_graph(graph)
            if not errs:
                break
    if errs:
        raise ComfyError("体检未通过，拒绝提交：\n  - " + "\n  - ".join(errs) + _loadimage_hint(errs))


def submit(graph: dict, label: str = "") -> str:
    _precheck_guard(graph)
    r = _req("/prompt", {"prompt": graph, "client_id": CLIENT_ID}, timeout=120)
    pid = r.get("prompt_id")
    if not pid:
        raise ComfyError(f"提交被拒：{json.dumps(r, ensure_ascii=False)[:1200]}")
    if r.get("node_errors"):
        raise ComfyError(f"{label} 图有错：{json.dumps(r['node_errors'], ensure_ascii=False)[:1200]}")
    return pid


def wait(pid: str, label: str = "", timeout: float = 3600, on_tick=None) -> dict:
    t0 = time.time()
    last = ""
    fails = 0
    while time.time() - t0 < timeout:
        # 采样期间 ComfyUI 的 HTTP 会卡住（/history、/queue 都可能超时），
        # 这里必须吞掉暂时性失败继续重试，否则等待器会比任务先死。
        try:
            h = _req("/history/" + pid, timeout=30) or {}
            fails = 0
        except Exception:
            fails += 1
            time.sleep(min(3 * fails, 20))
            continue
        if pid in h:
            status = h[pid].get("status") or {}
            if status.get("status_str") == "error":
                msgs = [m for m in status.get("messages", [])
                        if m[0] in ("execution_error", "execution_interrupted")]
                raise ComfyError(f"{label} 执行失败：{json.dumps(msgs, ensure_ascii=False)[:2000]}")
            return h[pid]
        state = _queue_state(pid)
        if on_tick and state != last:
            on_tick(int(time.time() - t0), state)
        last = state
        time.sleep(4)
    raise ComfyError(f"{label} 超时（{timeout:.0f}s 未完成）")


def _queue_state(pid: str) -> str:
    try:
        q = queue()
        if pid in [x[1] for x in q.get("queue_running") or []]:
            return "运行中"
        if pid in [x[1] for x in q.get("queue_pending") or []]:
            return "排队中"
        return "收尾中"
    except ComfyError:
        return "?"


def produced(hist: dict, kinds=("images", "videos", "gifs", "audio")) -> list[dict]:
    """把 history 里的产物展平成 [{filename, subfolder, type, kind}]。"""
    out = []
    for _nid, node_out in (hist.get("outputs") or {}).items():
        for kind in kinds:
            for f in node_out.get(kind) or []:
                out.append({"filename": f.get("filename"), "subfolder": f.get("subfolder", ""),
                            "type": f.get("type", "output"), "kind": kind})
    return out


def local_path(item: dict) -> str:
    """ComfyUI 产物 → 本机绝对路径。根目录跟着设置走，不写死盘符。"""
    root = output_dir() if item.get("type", "output") == "output" else input_dir()
    if not root:
        raise ComfyError("没找到 ComfyUI 目录：在画布右上角「设置」里选一下 ComfyUI 文件夹")
    return os.path.join(root, item.get("subfolder") or "", item.get("filename") or "")


def newest(prefix: str, folder: str, exts=(".png",)) -> str:
    """按 mtime 找最新产物。不按字典序——混进别处拷来的文件时字典序会骗人。"""
    out_root = output_dir()
    if not out_root:
        return ""
    d = os.path.join(out_root, folder)
    if not os.path.isdir(d):
        return ""
    best, best_t = "", -1.0
    for fn in os.listdir(d):
        if fn.startswith(prefix) and fn.lower().endswith(exts):
            t = os.path.getmtime(os.path.join(d, fn))
            if t > best_t:
                best, best_t = fn, t
    return best


def free_vram():
    try:
        _req("/free", {"unload_models": True, "free_memory": True}, timeout=60)
    except ComfyError:
        pass


def interrupt() -> dict:
    """停掉 ComfyUI 上正在跑的任务，并清掉排队。

    画布进度卡片上的「停止」走这里。先删排队再中断：只中断当前那一条的话，
    排队的会立刻接着跑，用户会以为没停住。
    """
    deleted = 0
    try:
        q = queue()
        ids = [str(x[1]) for x in (q.get("queue_pending") or [])
               if isinstance(x, (list, tuple)) and len(x) > 1]
        if ids:
            _req("/queue", {"delete": ids}, timeout=15)
            deleted = len(ids)
    except ComfyError:
        pass
    _req("/interrupt", {}, timeout=15)
    return {"deleted": deleted}



def interrupt_old():
    try:
        _req("/interrupt", {}, timeout=15)
    except ComfyError:
        pass
