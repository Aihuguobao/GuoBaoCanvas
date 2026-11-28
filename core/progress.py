"""实时进度：后台连 ComfyUI 的 WebSocket，把采样进度记下来给画布读。

ComfyUI 的 /ws 会推：
  {"type":"progress","data":{"value":n,"max":m,"prompt_id":...,"node":...}}
  {"type":"executing","data":{"node":"131","prompt_id":...}}   node 为 null 表示整条结束
  {"type":"execution_start" / "execution_success" / "execution_error"}
  {"type":"status","data":{"status":{"exec_queue_remaining":n}}}

这里只做一件事：维护一个 dict，画布轮询 /api/comfy/progress 就能显示进度条。
断开自动重连，不影响主服务。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

def _http() -> str:
    """ComfyUI 地址跟着设置走（设置面板 > 环境变量 > 默认 8188），不写死。"""
    from . import settings
    return settings.comfy_url()


def _ws_base() -> str:
    u = _http()
    for scheme in ("https://", "http://"):
        if u.startswith(scheme):
            return "ws" + ("s" if scheme == "https://" else "") + "://" + u[len(scheme):] + "/ws"
    return "ws://127.0.0.1:8188/ws"

STATE: dict = {
    "connected": False,
    "running": False,
    "value": 0,
    "max": 0,
    "percent": 0.0,
    "node": "",
    "prompt_id": "",
    "queued": 0,
    "started": 0.0,
    "elapsed": 0.0,
    "eta": 0.0,
    "step_seconds": 0.0,
    "updated": 0.0,
    "event": "",
}


def _reset_job() -> None:
    STATE.update(running=True, value=0, max=0, percent=0.0, started=time.time(),
                 elapsed=0.0, eta=0.0, step_seconds=0.0, updated=time.time())


def _handle(msg: dict) -> None:
    t = msg.get("type")
    data = msg.get("data") or {}
    if t == "progress":
        val, mx = int(data.get("value") or 0), int(data.get("max") or 0)
        if mx <= 0:
            return
        if not STATE["running"] or STATE["started"] == 0:
            _reset_job()
        STATE.update(value=val, max=mx, percent=round(val / mx * 100, 1),
                     node=str(data.get("node") or ""), prompt_id=str(data.get("prompt_id") or ""),
                     updated=time.time())
        elapsed = time.time() - STATE["started"]
        STATE["elapsed"] = round(elapsed, 1)
        # 一步大约多久：用已完成步数估算，剩下的乘一下
        done = max(val, 1)
        STATE["step_seconds"] = round(elapsed / done, 2)
        STATE["eta"] = round(max(mx - val, 0) * STATE["step_seconds"], 1)
    elif t == "executing":
        node = data.get("node")
        STATE["event"] = "executing"
        if node is None:
            STATE.update(running=False, percent=100.0 if STATE["max"] else 0.0,
                         eta=0.0, node="", updated=time.time())
        else:
            STATE.update(node=str(node), updated=time.time())
            if not STATE["running"]:
                _reset_job()
    elif t == "execution_start":
        _reset_job()
        STATE["event"] = "start"
    elif t in ("execution_success", "execution_error", "execution_interrupted"):
        STATE.update(running=False, eta=0.0, event=t, updated=time.time())
        if t == "execution_success" and STATE["max"]:
            STATE.update(percent=100.0)
    elif t == "status":
        st = (data.get("status") or {})
        STATE["queued"] = int(st.get("exec_queue_remaining") or 0)


def _running_client_id() -> str:
    """当前任务的提交者 client_id。

    ComfyUI 0.42 起，`progress` / `progress_state` 用 `send_sync(..., client_id)` 只发给
    **提交任务的那个客户端**（浏览器标签），不是广播（源码 `main.py:464`）——
    我们的监听连上去只能收到开头的 status，之后永远静默。
    好在 `/queue` 的每一项里带 `extra_data.client_id`，拿它的 id 去连就能收到进度。
    """
    try:
        import urllib.request

        with urllib.request.urlopen(_http() + "/queue", timeout=3) as r:
            data = json.load(r)
        for item in (data.get("queue_running") or []):
            extra = item[3] if len(item) > 3 else {}
            cid = str((extra or {}).get("client_id") or "")
            if cid:
                return cid
    except Exception:  # noqa: BLE001 - 查不到就沿用上一次的 id
        pass
    return ""


async def _run() -> None:
    import websockets

    cid = ""
    while True:
        latest = await asyncio.to_thread(_running_client_id)
        if latest:
            cid = latest
        url = _ws_base() + "?clientId=" + (cid or "dsh-canvas-progress")
        try:
            async with websockets.connect(url, max_size=None, ping_interval=20) as ws:
                STATE["connected"] = True
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        # 每 5 秒对一次"提交者 id 变了没"：变了就重连到新的那个
                        now = await asyncio.to_thread(_running_client_id)
                        if now and now != cid:
                            cid = now
                            break
                        continue
                    try:
                        _handle(json.loads(raw))
                    except (ValueError, TypeError):
                        continue
        except Exception:  # noqa: BLE001 - 连不上就等一会儿再试
            STATE["connected"] = False
            await asyncio.sleep(3)
        finally:
            STATE["connected"] = False


def start() -> threading.Thread:
    def _thread() -> None:
        asyncio.run(_run())

    th = threading.Thread(target=_thread, name="comfy-progress", daemon=True)
    th.start()
    return th


def snapshot() -> dict:
    out = dict(STATE)
    if STATE["running"] and STATE["started"]:
        out["elapsed"] = round(time.time() - STATE["started"], 1)
    silent = (time.time() - STATE["updated"]) if STATE["updated"] else 1e9

    # 队列才是唯一真相，别拿"多久没进度"判生死：
    # H3 实测每步 193 秒，远大于原来 120 秒的阈值 —— 每跨一步就有一分多钟被误判成
    # "任务结束了"，进度条收起来、下一步又弹出来（2026-11-28 用户看到的闪断）。
    q_run, q_pend, q_ids = (-1, -1, [])
    try:
        import urllib.request as _u

        with _u.urlopen(_http() + "/queue", timeout=2) as _r:
            _q = json.load(_r)
        q_run = len(_q.get("queue_running") or [])
        q_pend = len(_q.get("queue_pending") or [])
        q_ids = [str(i[1]) for i in (_q.get("queue_running") or []) if len(i) > 1]
    except Exception:            # noqa: BLE001 - 查不到就按沉默时长兜底
        pass

    if q_run > 0 or q_pend > 0:
        # 还在队列里＝还在跑。哪怕 websocket 半天没推 step，也不能显示成"完成"。
        out["running"] = True
        out["stale"] = False
        out["queued"] = q_pend
        if q_ids and not out.get("prompt_id"):
            out["prompt_id"] = q_ids[0]
        if out.get("started"):
            out["elapsed"] = round(time.time() - out["started"], 1)
        return out

    if q_run == 0 and q_pend == 0:
        # 队列空 → 确实结束了
        out["running"] = False
        out["eta"] = 0.0
        if out.get("percent") and out["percent"] < 100:
            out["percent"] = 0.0
        out["stale"] = silent > 300
        return out

    # 查不到队列：退回"沉默 5 分钟算结束"（原来的 120 秒对长步太激进）
    out["stale"] = silent > 300
    if out["stale"]:
        out["running"] = False
    return out
