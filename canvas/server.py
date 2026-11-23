"""短剧画布后端：只做三件事——给数据、存布局、算提示词。

不提交任何生成任务。生成是另一条路（`agent.py frame/video`），
画布只负责让你看见、改词、决定下一步。

启动：python canvas/server.py [--port 8766]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.request
import uuid
from urllib.parse import quote, unquote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

# 控制台若是 GBK（中文 Windows 默认），打印 ▶ / ✔ 这类符号会抛 UnicodeEncodeError，
# 而且是在出片任务的进度回调里抛，会直接把任务打断。统一把 stdout/stderr 改成 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import shutil
import time

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.dirname(HERE)
sys.path.insert(0, AGENT)

from core import refsheet, comfy, engines, graphs, progress as progress_mod, llm, media, multiview, prompts, refs as refs_mod, scenes as scene_defs, settings, sheets as sheet_defs, store, vocab  # noqa: E402
from core import keyframe_krea2 as krea2_kf  # noqa: E402
from core.edit_graph import krea2_edit  # noqa: E402

GROUP_OF = {
    "front": "turnaround", "three_quarter": "turnaround", "side": "turnaround",
    "back": "turnaround", "closeup": "expression", "costume": "costume",
}

FULL_BODY_HINT = (
    "full body from head to toe, the whole figure inside the frame with margin, feet visible, "
    "plain light grey background, no text, no annotations"
)


class BundleBody(BaseModel):
    ref: str
    views: list[str] = ["front", "right", "back"]
    seed: int = 0
    full_body: bool = True
    tile: bool = True          # True=生成后统一排版成 832x1248（D 方案），False=保留原图比例（C 方案）

def _allowed_roots() -> list[str]:
    """允许读写的目录：本工程产物 + 当前 ComfyUI 的 input/output（跟着设置走）。"""
    roots = [os.path.join(AGENT, "projects"), os.path.join(AGENT, "out"),
             os.path.join(AGENT, "素材")]
    root = settings.comfy_root()
    if root:
        roots += [os.path.join(root, "output"), os.path.join(root, "input")]
    return roots

app = FastAPI(title="短剧画布")


def _en_if_cn(text) -> str:
    """有中文就翻成英文（生图模型对中文不友好）；没有就原样返回。

    翻不了直接报错，不许把中文塞给 Krea2 白跑一轮。
    """
    text = str(text or "").strip()
    if not text or not re.search(r"[\u4e00-\u9fff]", text):
        return text
    try:
        return llm.translate_image(text, settings.load()["llm"])
    except llm.LLMError as e:
        raise HTTPException(status_code=400,
                            detail=f"翻译失败（生图要英文）：{e}\n点右上角「设置」检查密钥。") from None


def _sentence(text: str) -> str:
    """把一段短语整理成一句：去尾标点、首字母大写、补句号。"""
    text = str(text or "").strip().rstrip(".。")
    if not text:
        return ""
    return text[0].upper() + text[1:] + "."


def _aspect_of(ep: str) -> str:
    """项目级横竖屏 → Krea2 的 aspect_ratio 字符串。

    默认**竖屏**：前端下拉在 orientation 缺失时也按竖屏显示
    （app.js 的判断是 `orientation === 'landscape' ? 横 : 竖`）。
    两边默认值必须一致 —— 以前这里默认 landscape、前端默认 portrait，
    结果顶栏写着「竖屏 9:16」、后端按 16:9 出图。
    """
    proj = store.read(ep, "project")
    if str(proj.get("orientation") or "portrait").lower() != "portrait":
        return "16:9 (Widescreen)"
    return "9:16 (Portrait Widescreen)"


# 竖屏 / 横屏的目标分辨率。**只允许在这里改**：以前 store.create 用 1088×1920、
# patch_project 切方向时写 768×1344，切一次横屏再切回来尺寸就漂了。
SIZE_PORTRAIT = (1088, 1920)
SIZE_LANDSCAPE = (1920, 1088)


def _project_size(ep: str) -> tuple[int, int]:
    """这个项目出图该用的宽高：直接读 project.width/height，缺了按方向兜底。

    素材（角色/场景/道具）、文字生角色图、场景空镜、设定图都走这里，
    保证同一个项目里出来的图尺寸一致。首帧本来就走 project.width/height，不用这个函数。
    """
    proj = store.read(ep, "project")
    w = int(proj.get("width") or 0)
    h = int(proj.get("height") or 0)
    if w > 0 and h > 0:
        return w, h
    if str(proj.get("orientation") or "portrait").lower() == "portrait":
        return SIZE_PORTRAIT
    return SIZE_LANDSCAPE


@app.middleware("http")
async def no_store_static(request, call_next):
    """前端文件与所有 API 都不缓存：改完刷新就能看到新界面/新数据，不会拿到旧的。

    只覆盖页面和静态文件不够：/api/project 这类数据接口没缓存头时，浏览器按
    启发式缓存拿旧 JSON（旧 seed、旧视频路径），刷新后缩略图还是上一版；
    /api/file 同理，视频/图片也要 no-store。
    """
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".js", ".css", ".html")) or path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


APP_NAME = "GuoBaoCanvas · 短剧画布"
APP_REPO = "https://github.com/Aihuguobao/GuoBaoCanvas"
AUDIT_LOG = os.path.join(AGENT, "out", "audit.log")


@app.middleware("http")
async def audit_writes(request, call_next):
    """所有写操作留痕：时间 / 方法 / 路径 / 来源。

    为什么加：EP01 的 characters/shots/scenes 被写成空文件，
    而 uvicorn 是 log_level=warning、不记请求，事后完全查不出是谁在什么时候写的。
    数据出了问题却查不到来源，比数据出问题本身更糟。
    """
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        try:
            qs = request.url.query
            line = "%s %-6s %s%s  from %s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), request.method,
                request.url.path, ("?" + qs) if qs else "",
                (request.client.host if request.client else "?"))
            os.makedirs(os.path.dirname(AUDIT_LOG), exist_ok=True)
            with open(AUDIT_LOG, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass
    return await call_next(request)


class CanvasLayout(BaseModel):
    viewport: dict
    nodes: dict


class ShotPatch(BaseModel):
    act: str | None = None
    seconds: float | None = None
    link: bool | None = None
    image: dict | None = None
    video: dict | None = None
    beats: list[str] | None = None
    characters: list[str] | None = None
    scenes: list[str] | None = None
    props: list[str] | None = None


def _safe(path: str) -> str:
    r"""只允许读产物目录里的文件，挡住路径穿越。

    产物目录会被整理（`output\video` → `output\canvas\video\_legacy` 之类），
    所以记录里的老路径可能已经失效：这时按**文件名**在产物目录里再找一次，
    找到就返回新位置。否则画布上所有老视频都会变成
    “The element has no supported sources”。
    """
    real = os.path.abspath(unquote(path))

    def inside(root: str) -> bool:
        try:
            return os.path.commonpath([real, root]) == os.path.abspath(root)
        except ValueError:
            # 不同盘符会抛 ValueError，按"不在范围内"处理（以前这里 500）
            return False

    if not any(inside(root) for root in _allowed_roots()):
        raise HTTPException(status_code=403, detail="这个路径不在允许范围内")
    if os.path.isfile(real):
        return real

    moved = _find_moved(real)
    if moved:
        return moved
    raise HTTPException(status_code=404, detail=f"文件不存在：{real}")


def _find_moved(real: str) -> str:
    """按文件名在产物目录里找被整理走的文件。只认同名唯一命中的情况。"""
    name = os.path.basename(real)
    if not name:
        return ""
    hits = []
    for root in (comfy.output_dir(), comfy.input_dir()):
        if not root:
            continue
        for cur, _dirs, files in os.walk(root):
            if name in files:
                hits.append(os.path.join(cur, name))
                if len(hits) > 1:
                    return ""
    return hits[0] if len(hits) == 1 else ""


@app.exception_handler(KeyError)
def _missing_key(request, exc):
    """找不到集/镜头/角色时一律 404，不要 500。"""
    return JSONResponse(status_code=404, content={"detail": str(exc).strip("'\"")})


@app.exception_handler(FileNotFoundError)
def _missing_file(request, exc):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


# pythonw 起的进程没有控制台：子进程（ffmpeg / pip / powershell）会闪黑窗，
# 严重时直接 0xc0000142 起不来。统一给 CREATE_NO_WINDOW + 关掉 stdin。
def _nowin() -> dict:
    if os.name != "nt":
        return {}
    return {"creationflags": 0x08000000, "stdin": subprocess.DEVNULL}


_REMOTE_CACHE = {"at": 0.0, "sha": "", "ahead": False}


def _remote_state(local: str) -> tuple[str, bool]:
    """远端 master 的短哈希 + 它是否比本地新（只认 GitHub 的 compare 结论）。"""
    import urllib.request
    now = time.time()
    if _REMOTE_CACHE["at"] and now - _REMOTE_CACHE["at"] < 3600:
        return _REMOTE_CACHE["sha"], _REMOTE_CACHE["ahead"]
    sha, ahead = "", False
    try:
        api = "https://api.github.com/repos/Aihuguobao/GuoBaoCanvas"
        req = urllib.request.Request(f"{api}/commits/master",
                                     headers={"User-Agent": "GuoBaoCanvas"})
        with urllib.request.urlopen(req, timeout=3) as r:
            sha = str(json.loads(r.read()).get("sha") or "")[:7]
        if sha and local:
            req2 = urllib.request.Request(f"{api}/compare/{local}...{sha}",
                                          headers={"User-Agent": "GuoBaoCanvas"})
            with urllib.request.urlopen(req2, timeout=3) as r2:
                ahead = str(json.loads(r2.read()).get("status") or "") == "ahead"
    except Exception:  # noqa: BLE001
        ahead = False
    _REMOTE_CACHE.update({"at": now, "sha": sha, "ahead": ahead})
    return sha, ahead


@app.get("/api/version")
def app_version():
    local = _app_version()
    remote, ahead = _remote_state(local)
    return {"app": APP_NAME, "repo": APP_REPO, "version": local,
            "remote": remote, "newer": bool(ahead)}


def _app_version() -> str:
    import subprocess
    try:
        r = subprocess.run(["git", "-C", AGENT, "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


@app.get("/api/episodes")
def episodes():
    out = []
    for ep in store.episodes():
        proj = store.read(ep, "project")
        items = store.shots(ep)
        out.append({
            "episode": ep,
            "title": proj.get("title", ""),
            "shots": len(items),
            "framed": sum(1 for s in items if (s.get("state") or {}).get("kf")),
            "filmed": sum(1 for s in items if (s.get("state") or {}).get("video")),
        })
    return out


@app.get("/api/project/{ep}")
def project(ep: str):
    proj = store.read(ep, "project")
    return {
        "project": proj,
        "shots": store.shots(ep),
        "characters": store.read(ep, "characters", {"characters": []})["characters"],
        "scenes": store.read(ep, "scenes", {"scenes": []})["scenes"],
        "props": store.read(ep, "props", {"props": []})["props"],
        "steps": _steps(),
        "styles": prompts.style_names(),
    }


@app.put("/api/project/{ep}/canvas")
def save_canvas(ep: str, body: CanvasLayout):
    proj = store.read(ep, "project")
    proj["canvas"] = {"viewport": body.viewport, "nodes": body.nodes}
    store.write(ep, "project", proj)
    return {"ok": True, "nodes": len(body.nodes)}


@app.patch("/api/shot/{ep}/{sid}")
def patch_shot(ep: str, sid: str, body: ShotPatch):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    # video / image 的"按字段合并"交给 store.update_shot 在锁内做：
    # 在这里先合并会拿到旧的 shots.json 快照，把并发中别人刚写的键覆盖掉
    # 
    if not fields:
        return {"ok": True, "changed": []}
    store.update_shot(ep, sid, **fields)
    return {"ok": True, "changed": sorted(fields)}


def _shot_refs(ep: str, shot: dict) -> list[dict]:
    """这个镜头能用上的参考图，按「角色在前、场景在后」排序。

    每项：{"path", "label"(英文短标签，用于提示词指认), "kind": "char"|"scene"}
    槽位编号就是列表下标 + 1，和提示词里的 Image N 一一对应。
    """
    out: list[dict] = []
    chars = store.characters(ep)
    for cid in shot.get("characters") or []:
        c = chars.get(cid)
        if c and c.get("ref") and os.path.isfile(c["ref"]):
            out.append({"path": c["ref"], "label": c.get("label") or "",
                        "name": c.get("name") or "", "kind": "char"})
    if shot.get("scenes"):
        data = store.read(ep, "scenes", {"scenes": []})
        for sc in shot.get("scenes") or []:
            hit = next((x for x in data["scenes"] if x.get("id") == sc), None)
            if hit and hit.get("ref") and os.path.isfile(hit["ref"]):
                out.append({"path": hit["ref"], "label": hit.get("label") or "",
                            "name": hit.get("name") or "", "kind": "scene"})
    return out[:3]


def _expanded(shot: dict, refs: list[dict]) -> dict:
    """把动作/场景里的人类叫法（@1 / 角色1 / 英文标签）换成槽位指代。"""
    s2 = dict(shot)
    img = dict(shot.get("image") or {})
    img["action"] = prompts.expand_refs(img.get("action"), refs)
    img["scene"] = prompts.expand_refs(img.get("scene"), refs)
    s2["image"] = img
    return s2


@app.get("/api/prompt/{ep}/{sid}/sections")
def prompt_sections(ep: str, sid: str):
    """六段自动拼装的结果（给画布"自动填六段"按钮用）。

    只读：不改任何数据，把卡片/拍子/全剧保留项按 Ref2VA 官方六段拆开返回，
    用户在前端六个输入框里改完再保存 → 保存后出片时以他填的为准。
    """
    proj = store.read(ep, "project")
    shot = dict(store.shot(ep, sid))
    style = shot.get("style") or proj.get("style") or "cgphoto"
    retention = str(proj.get("retention") or "").strip()
    if retention:
        shot["_retention"] = retention
    sec = prompts._sections(shot, style)
    return {
        "subject_definitions": sec["subject_definitions"],
        "summary": sec["summary"],
        "retention_analysis": sec["retention_analysis"],
        "detailed_description": sec["detailed_description"],
        "overall_soundscape": sec["overall_soundscape"],
        "non_diegetic_music": sec["non_diegetic_music"],
        "beats": sec.get("_beats") or [],
    }


@app.post("/api/prompt/{ep}/{sid}")
def preview_prompt(ep: str, sid: str, body: dict | None = None):
    proj = store.read(ep, "project")
    shot = store.shot(ep, sid)
    style = shot.get("style") or proj.get("style") or "cgphoto"
    refs = _shot_refs(ep, shot)
    shot = _expanded(shot, refs)
    # 视频动作/拍子里的 @N 也要展开，预览才能反映真正送进模型的样子
    if refs:
        v2 = dict(shot.get("video") or {})
        v2["action"] = prompts.expand_refs(v2.get("action"), refs)
        shot = dict(shot)
        shot["video"] = v2
        if shot.get("beats"):
            shot["beats"] = [prompts.expand_refs(b, refs) for b in shot["beats"]]
    engine = ((body or {}).get("engine") or shot.get("engine")
              or proj.get("engine") or "h3ref")
    # 全剧保留项注入：文章的第一步是先定"必须跨镜保留"的特征，再写场面
    shot = dict(shot)
    shot["_retention"] = str(proj.get("retention") or "").strip()
    # H3 不分段：整段一句话，所以永远是 1 条拍子
    beats_needed = 1
    # 预览的视频段必须和出片走同一个函数：显示的字符串 = 实际发出去的字符串
    out = prompts.build(shot, style,
                        char_refs=sum(1 for r in refs if r["kind"] == "char"),
                        scene_refs=sum(1 for r in refs if r["kind"] == "scene"),
                        refs=[(r["label"], r["kind"]) for r in refs],
                        engine=engine, ref_full=refs)
    _raw = store.shot(ep, sid)
    # 出片模式：ref2v = 参考图（Ref2VA 六段）；fl2v = 首帧（I2VA 指令行 + 三字段）
    mode = str((body or {}).get("mode") or (_raw.get("video") or {}).get("mode") or "ref2v").lower()
    if mode == "fl2v":
        # 首帧模式走的是 H3 的 I2VA 模板
        engine = "h3"
        out = prompts.build(shot, style,
                            char_refs=sum(1 for r in refs if r["kind"] == "char"),
                            scene_refs=sum(1 for r in refs if r["kind"] == "scene"),
                            refs=[(r["label"], r["kind"]) for r in refs],
                            engine=engine, ref_full=refs)
    else:
        out["video"], _refs2 = prompts.video_text_for(ep, _raw, proj)
    out["mode"] = mode
    out["sent"] = out["video"]
    out["sent_sha"] = hashlib.sha256(out["video"].encode("utf-8")).hexdigest()[:16]
    out["beats_needed"] = beats_needed
    return out


@app.patch("/api/character/{ep}/{cid}")
def patch_character(ep: str, cid: str, body: dict):
    data = store.read(ep, "characters", {"characters": []})
    for c in data["characters"]:
        if c.get("id") == cid:
            c.update(body)
            store.write(ep, "characters", data)
            return {"ok": True}
    raise HTTPException(status_code=404, detail=f"没有角色 {cid}")


@app.patch("/api/scene/{ep}/{sid}")
def patch_scene(ep: str, sid: str, body: dict):
    data = store.read(ep, "scenes", {"scenes": []})
    for s in data["scenes"]:
        if s.get("id") == sid:
            s.update(body)
            store.write(ep, "scenes", data)
            return {"ok": True}
    raise HTTPException(status_code=404, detail=f"没有场景 {sid}")


MATERIAL_DIRS = {"char": "角色", "scene": "场景", "prop": "道具"}


def _material_dir(ep: str, kind: str) -> str:
    """素材目录：素材\\<集>\\角色|场景|道具。kind 收 char / scene / prop。"""
    folder = os.path.join(AGENT, "素材", store.slug(ep), MATERIAL_DIRS.get(kind, "角色"))
    os.makedirs(folder, exist_ok=True)
    return folder


@app.post("/api/upload/{ep}")
async def upload(ep: str, f: UploadFile = File(...), tag: str = "sheet"):
    """存进 素材\\<集>\\角色|场景|道具，返回绝对路径（前端拿它写进卡片）。"""
    ext = os.path.splitext(f.filename or "")[1].lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(status_code=400, detail="只收 png / jpg / webp")
    folder = _material_dir(ep, tag if tag in MATERIAL_DIRS else "char")
    name = f"{tag}_{time.strftime('%Y%m%d_%H%M%S')}_{f.filename}"
    dst = os.path.join(folder, name)
    with open(dst, "wb") as out:
        shutil.copyfileobj(f.file, out)
    return {"path": dst, "name": name}


@app.post("/api/sheet/{ep}/{eid}/{view}")
def gen_sheet(ep: str, eid: str, view: str, body: dict):
    """按视角生成一张角色设定图（Krea2 + Qwen-Edit 编码器，挂主参考图）。"""
    if view not in sheet_defs.VIEWS:
        raise HTTPException(status_code=400, detail=f"没有这个视角：{view}")
    group = GROUP_OF.get(view, "turnaround")
    ref = (body.get("ref") or "").strip()
    if not ref or not os.path.isfile(ref):
        raise HTTPException(status_code=400, detail="先设一张主参考图（正脸照最好）")

    seed = int(body.get("seed") or 0) or int(time.time()) % 1_000_000_007
    # 尺寸跟项目走（视角模板里原先写死 1024×1536 / 1024×1024，和素材主图对不上）
    w, h = _project_size(ep)
    prompt = sheet_defs.prompt_for(view)
    name = comfy.upload_image(ref, prefix="sheetref")
    graph = krea2_edit(name, prompt, seed=seed, prefix=f"canvas/sheets/{store.slug(ep)}_{eid}_{view}",
                       width=w, height=h)
    pid = comfy.submit(graph, f"{eid}/{view}")
    hist = comfy.wait(pid, f"{eid}/{view}")
    files = [f for f in comfy.produced(hist, ("images",)) if f["filename"].endswith(".png")]
    if not files:
        raise HTTPException(status_code=500, detail="跑完了但没有图")

    folder = _material_dir(ep, "char")
    dst = os.path.join(folder, f"{eid}_{view}_{seed}.png")
    shutil.copy2(comfy.local_path(files[0]), dst)

    data = store.read(ep, "characters", {"characters": []})
    item = {"path": dst, "label": sheet_defs.label_for(view), "view": view,
            "prompt": prompt, "seed": seed}
    for c in data["characters"]:
        if c.get("id") == eid:
            c.setdefault("sheets", {}).setdefault(group, []).append(item)
            c["sheets"].setdefault("turnaround", [])
            store.write(ep, "characters", data)
            return {"ok": True, "item": item, "entity": c}
    raise HTTPException(status_code=404, detail=f"没有角色 {eid}")


@app.post("/api/multiview/{ep}/{eid}")
def gen_bundle(ep: str, eid: str, body: BundleBody):
    """多角度：一张源图，一次提交跑完 N 条分支（Qwen-Image-Edit 2511 + 多角度 LoRA）。"""
    ref = (body.ref or "").strip()
    if not ref or not os.path.isfile(ref):
        raise HTTPException(status_code=400, detail="先设一张主参考图（正脸或半身都行）")
    views = body.views or ["front", "right", "back"]
    # 画风句跟着走
    _style_txt = prompts.render_text(store.read(ep, "project").get("style") or "cgphoto")
    prompts_list = [(v, f"{multiview.angle_prompt(v, 'eye', 'wide', FULL_BODY_HINT)} {_style_txt}")
                    for v in views]
    seed = int(body.seed or 0) or int(time.time()) % 1_000_000_007

    # D 方案：生成时保持源图比例（零畸变、不进补边），生成之后再统一排版成竖版
    name = comfy.upload_image(ref, prefix="canvas/bundle")
    graph = multiview.build(name, prompts_list, seed=seed,
                            prefix=f"canvas/bundle/{store.slug(ep)}_{eid}", save_prefix="b")
    pid = comfy.submit(graph, f"{eid} 多角度")
    hist = comfy.wait(pid, f"{eid} 多角度", timeout=3600)

    files = sorted((f for f in comfy.produced(hist, ("images",))
                    if f["filename"].endswith(".png")), key=lambda f: f["filename"])
    if len(files) < len(prompts_list):
        raise HTTPException(status_code=500, detail=f"只出了 {len(files)}/{len(prompts_list)} 张")

    folder = _material_dir(ep, "char")
    items = []
    for i, (view, prompt) in enumerate(prompts_list):
        raw = os.path.join(folder, f"{eid}_mv_{view}_{seed}.png")
        shutil.copy2(comfy.local_path(files[i]), raw)
        path = raw
        if body.tile:
            path = os.path.join(folder, f"{eid}_mv_{view}_{seed}_tile.png")
            media.fit_to_canvas(raw, path, *_project_size(ep))
        items.append({"path": path, "raw": raw, "label": multiview.AZIMUTH.get(view, view),
                      "view": view, "prompt": prompt, "seed": seed})

    data = store.read(ep, "characters", {"characters": []})
    for c in data["characters"]:
        if c.get("id") == eid:
            c.setdefault("sheets", {}).setdefault("turnaround", [])
            c["sheets"]["turnaround"].extend(items)
            store.write(ep, "characters", data)
            return {"ok": True, "items": items, "entity": c}
    raise HTTPException(status_code=404, detail=f"没有角色 {eid}")


@app.post("/api/shot/{ep}/{sid}/interp")
def shot_interp(ep: str, sid: str):
    _reload_pipeline()
    from steps import interp as interp_step
    try:
        return interp_step.run(ep, sid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/shot/{ep}/{sid}/forget")
def forget_run(ep: str, sid: str, body: dict):
    """把某条成片从这一镜移除。

    文件在画布 out 目录里的就一起删（连它自己的封面）；ComfyUI 那边的原片不动。
    删掉的正好是当前母版时，自动退回剩下的最后一条。
    """
    path = str((body or {}).get("path") or "").strip()
    shot = store.shot(ep, sid)
    st = shot.get("state") or {}
    runs = list(st.get("video_runs") or [])
    hit = next((r for r in runs if r.get("path") == path), None)
    if not hit:
        raise HTTPException(status_code=400, detail="这个路径不在本镜的成片列表里")

    removed, note = [], ""
    clip_root = os.path.realpath(os.path.join(AGENT, "out"))
    asset_root = os.path.realpath(os.path.join(AGENT, "projects"))
    targets = [("片子", path, clip_root), ("封面", str(hit.get("poster") or ""), asset_root)]
    for label, p, root in targets:
        if not p or not os.path.isfile(p):
            continue
        real = os.path.realpath(p)
        try:
            inside = os.path.commonpath([real, root]) == root
        except ValueError:
            inside = False
        if not inside:
            if label == "片子":
                note = "文件不在画布 out 目录里，只移除了记录"
            continue
        try:
            os.remove(real)
            removed.append(label)
        except OSError as exc:
            note = f"{label}删不掉：{exc}"

    runs = [r for r in runs if r.get("path") != path]
    patch: dict = {"video_runs": runs}
    if st.get("chosen_video") == path or st.get("video") == path:
        last = runs[-1] if runs else {}
        patch.update(video=last.get("path") or "", chosen_video=last.get("path") or "",
                     video_seed=last.get("seed") or 0, chosen_seed=last.get("seed") or 0,
                     interpolated_from="")
    store.set_state(ep, sid, **patch)
    return {"ok": True, "removed": removed, "note": note, "runs": len(runs),
            "video": patch.get("video", st.get("video") or "")}


@app.get("/api/film/{ep}/plan")
def film_plan(ep: str):
    _reload_pipeline()
    from steps import concat_film
    try:
        return concat_film.plan(ep)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _job_film(job_id: str, ep: str, seq: list[str]) -> None:
    job = JOBS[job_id]
    try:
        _reload_pipeline()
        from steps import concat_film
        job["status"] = "running"
        job["progress"] = "拼接中…"
        rep = concat_film.run(ep, seq, on_log=lambda m: job.update(progress=str(m).strip()[:120]))
        job["progress"] = "完成"
        if rep["ok"]:
            job["status"] = "done"
            job["result"] = rep
        else:
            job["status"] = "error"
            job["error"] = ("成片断言没过（片已写出，别当成品用）：\n"
                            + "\n".join(x for x in rep["report"].splitlines() if "🔴" in x))
            job["result"] = rep
    except Exception as e:  # noqa: BLE001 - 全部回传给前端
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        job["ended"] = time.time()


@app.post("/api/film/{ep}")
def film_concat(ep: str, body: dict):
    seq = [str(x).strip() for x in (body or {}).get("seq") or [] if str(x).strip()]
    if not seq:
        raise HTTPException(status_code=400, detail="没选要拼的镜头")
    if len(set(seq)) != len(seq):
        raise HTTPException(status_code=400, detail="同一镜重复出现在拼接顺序里")
    job_id = uuid.uuid4().hex[:8]
    JOBS[job_id] = {"id": job_id, "status": "queued", "ep": ep, "sid": "", "kind": "film",
                    "started": time.time(), "seq": seq}
    threading.Thread(target=_job_film, args=(job_id, ep, seq), daemon=True).start()
    return {"ok": True, "job": job_id}


@app.post("/api/film/rename")
def film_rename(body: dict):
    path = str((body or {}).get("path") or "").strip()
    name = str((body or {}).get("name") or "").strip()
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=400, detail="文件不存在")
    out_root = os.path.realpath(os.path.join(AGENT, "out"))
    real = os.path.realpath(path)
    if os.path.commonpath([real, out_root]) != out_root:
        raise HTTPException(status_code=400, detail="只允许改 out 目录里的文件")
    if not name:
        raise HTTPException(status_code=400, detail="给个名字")
    if name != os.path.basename(name) or ".." in name or any(c in name for c in '\\/:*?"<>|'):
        raise HTTPException(status_code=400, detail="名字里不能带路径或 \\ / : * ? \" < > |")
    if not name.lower().endswith(".mp4"):
        name += ".mp4"
    new_path = os.path.join(os.path.dirname(real), name)
    if os.path.exists(new_path) and os.path.realpath(new_path) != real:
        raise HTTPException(status_code=400, detail=f"已经有同名文件：{name}")
    os.replace(real, new_path)
    return {"ok": True, "path": new_path}


@app.post("/api/shot/{ep}/{sid}/frame")
def shot_frame(ep: str, sid: str, body: dict):
    """镜头出首帧：角色主参考 + 场景参考 + 镜头描述，一次生成一张。

    和出视频一样走后台任务：一张首帧 30–60 秒，同步等会把浏览器卡死。
    """
    shot = store.shot(ep, sid)
    refs = _shot_refs(ep, shot)
    if not refs:
        raise HTTPException(status_code=400, detail="这个镜头挂的角色/场景都还没有参考图")
    job_id = uuid.uuid4().hex[:8]
    JOBS[job_id] = {"id": job_id, "status": "queued", "ep": ep, "sid": sid,
                    "kind": "frame", "started": time.time()}
    threading.Thread(target=_job_frame,
                     args=(job_id, ep, sid, int(body.get("seed") or 0)), daemon=True).start()
    return {"ok": True, "job": job_id}


def _ref_xy(path: str) -> tuple[int, int]:
    """参考图原始像素，给 Krea2 的 ImageScale 算尺寸；读不到就按 1024 方图。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return tuple(im.size)          # type: ignore[return-value]
    except Exception:                       # noqa: BLE001 - 读不到不该挡住出图
        return (1024, 1024)


def _run_frame(ep: str, sid: str, seed: int) -> dict:
    shot = store.shot(ep, sid)
    proj = store.read(ep, "project")
    style = shot.get("style") or proj.get("style") or "cgphoto"
    refs = _shot_refs(ep, shot)
    if not refs:
        raise RuntimeError("这个镜头挂的角色/场景都还没有参考图")
    built = prompts.build(_expanded(shot, refs), style,
                          char_refs=sum(1 for r in refs if r["kind"] == "char"),
                          scene_refs=sum(1 for r in refs if r["kind"] == "scene"),
                          refs=[(r["label"], r["kind"]) for r in refs])
    prompt = built["image"]
    seed = seed or int(time.time()) % 1_000_000_007
    names = [comfy.upload_image(r["path"], prefix="shotref") for r in refs]
    # 首帧按项目方向出。写死 832×1248 时横屏项目拿到一张竖图，喂进 1344×768 出片会被拉伸。
    _kw = int(proj.get("width") or 832)
    _kh = int(proj.get("height") or 1248)
    # 走 Krea2 + krea2_identity_edit_v2：锁人靠 identity LoRA，换场景/换姿势靠
    # ref_position=bag of features。旧链路是 Qwen-Image-Edit 2511 多角度设定图那套，
    # 它只会照着参考图摆桩、人物跟背景两张皮，出不了镜头。
    _char = next((n for n, r in zip(names, refs) if r["kind"] == "char"), "")
    _scene = next((n for n, r in zip(names, refs) if r["kind"] == "scene"), "")
    if not _char:
        raise RuntimeError("首帧至少要挂一张角色参考图（Krea2 靠它锁人）")
    _char_path = next(r["path"] for r in refs if r["kind"] == "char")
    _scene_path = next((r["path"] for r in refs if r["kind"] == "scene"), "")
    graph = krea2_kf.build(_char, _scene, prompt, seed=seed, width=_kw, height=_kh,
                           prefix=f"canvas/keyframes/{store.slug(ep)}_{sid}_kf",
                           char_size=_ref_xy(_char_path),
                           scene_size=_ref_xy(_scene_path) if _scene_path else (1344, 768))
    pid = comfy.submit(graph, f"{sid} 首帧")
    hist = comfy.wait(pid, f"{sid} 首帧", timeout=1800)
    files = [f for f in comfy.produced(hist, ("images",)) if f["filename"].endswith(".png")]
    if not files:
        raise RuntimeError("跑完了但没有图")
    path = comfy.local_path(files[0])
    store.set_state(ep, sid, kf=path, kf_prompt=prompt, kf_seed=seed,
                    kf_at=time.strftime("%Y-%m-%d %H:%M:%S"), kf_refs=len(names),
                    confirmed_kf=False)
    return {"path": path, "prompt": prompt, "seed": seed, "refs": len(names)}


def _job_frame(job_id: str, ep: str, sid: str, seed: int) -> None:
    job = JOBS[job_id]
    try:
        job["status"] = "running"
        _reload_pipeline()
        job["result"] = _run_frame(ep, sid, seed)
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        job["ended"] = time.time()


@app.post("/api/shot/{ep}/{sid}/confirm")
def confirm_shot(ep: str, sid: str, body: dict):
    """确认首帧（或取消确认）。视频步骤看这个标记。"""
    ok = bool((body or {}).get("kf", True))
    store.set_state(ep, sid, confirmed_kf=ok)
    return {"ok": True, "confirmed_kf": ok}


@app.post("/api/character/{ep}/{cid}/textref")
def gen_char_textref(ep: str, cid: str, body: dict):
    """用角色卡上的文字，从零生成第一张主参考图（文生图，无人可依时用）。"""
    c = store.characters(ep).get(cid)
    if not c:
        raise HTTPException(status_code=404, detail=f"没有角色 {cid}")
    look = _en_if_cn(c.get("look"))
    outfit = _en_if_cn(c.get("outfit"))
    props = _en_if_cn(c.get("props"))
    if not (look or outfit):
        raise HTTPException(status_code=400,
                            detail="先在角色卡上填「外观」或「服装」，文字生图需要它们")
    proj = store.read(ep, "project")
    # 画风优先级：本次请求带的 > 卡片上记的 > 项目级。
    # 第一项是为了躲开前端「改下拉 → 点生成」的竞态：下拉的 onchange 保存和生成请求
    # 是同时发出的，后端有可能先读到还没落盘的旧值。
    style = (str((body or {}).get("style") or "").strip()
             or str(c.get("style") or "").strip()
             or str(proj.get("style") or "").strip() or "cgphoto")
    # 画风句必须排在最前面。Krea 的写法规矩第一条就是「把媒介放开头」，
    # 而这里原先把它拼在整段末尾——前面一大段外观描述会把它压过去，
    # 表现为「右边改画风重新生成，出来的还是上一个画风」。
    # 同时和 /api/gen/character 的拼法保持一致（那边一直是画风在前）。
    parts = [prompts.render_text(style)]
    for piece in (look, outfit, props):
        if piece:
            parts.append(_sentence(piece))
    parts.append(
        "Full body character sheet, neutral standing pose, facing the camera, "
        "simple solid light grey background, soft even studio lighting, clear silhouette, "
        "high detail, no text, no logos, no watermarks."
    )
    prompt = " ".join(parts)
    seed = int((body or {}).get("seed") or 0) or int(time.time()) % 1_000_000_007
    # 尺寸跟项目走（竖屏 1088×1920 / 横屏 1920×1088），和「新建角色」「拼接参考图」
    # 以及场景/道具保持同一套；以前这里写死 832×1248，只能出 2:3 的图。
    _cw, _ch = _project_size(ep)
    graph = graphs.krea2(prompt, seed=seed,
                         prefix=f"charref/{store.slug(ep)}_{cid}",
                         width=_cw, height=_ch)
    pid = comfy.submit(graph, f"{cid} 文字生图")
    hist = comfy.wait(pid, f"{cid} 文字生图", timeout=1200)
    files = comfy.produced(hist, ("images",))
    if not files:
        raise HTTPException(status_code=500, detail="没出图")
    folder = _material_dir(ep, "char")
    # 文件名带时间戳：同一个种子重生成会得到同名文件，浏览器按 URL 缓存旧图，
    # 结果就是 ComfyUI 里明明换了、画布上的缩略图还是上一张。
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = os.path.join(folder, f"{cid}_textref_{stamp}_{seed}.png")
    shutil.copyfile(comfy.local_path(files[0]), dst)

    data = store.read(ep, "characters", {"characters": []})
    for x in data["characters"]:
        if x.get("id") == cid:
            sheets = x.setdefault("sheets", {})
            sheets.setdefault("turnaround", []).insert(0, {"path": dst, "label": "文字生图"})
            x["ref"] = dst
            x["prompt_used"] = prompt
            x["seed"] = seed          # 不存种子的话，拼接参考图没法复现同一张脸
            x["style"] = style        # 也不存画风的话，下次回来重新生成会换风格
            break
    store.write(ep, "characters", data)
    return {"ok": True, "path": dst, "prompt": prompt, "seed": seed, "style": style}


@app.post("/api/character/{ep}/{cid}/importjob")
def import_from_job(ep: str, cid: str, body: dict):
    """从 ComfyUI 的任务 ID 里把「提示词 + 种子」扒出来写进角色卡，省掉手抄。"""
    pid = str((body or {}).get("prompt_id") or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="给一个 ComfyUI 任务 ID")
    try:
        hist = json.load(urllib.request.urlopen(f"http://127.0.0.1:8188/history/{pid}", timeout=30))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"读 history 失败：{type(e).__name__}")
    if not hist:
        raise HTTPException(status_code=404, detail="history 里没有这个任务（可能是服务重启前的）")
    graph = (list(hist.values())[0].get("prompt") or [None, None, {}])[2] or {}
    text, seed, models = "", 0, {}
    for node in graph.values():
        ct = str(node.get("class_type", ""))
        inp = node.get("inputs") or {}
        if ct.startswith("CLIPTextEncode") or ct in ("T5TextEncode", "TextEncodeQwenImageEdit"):
            t = str(inp.get("text") or "").strip()
            if len(t) > len(text):
                text = t
        for k in ("seed", "noise_seed"):
            v = inp.get(k)
            if isinstance(v, (int, float)) and not seed:
                seed = int(v)
        for k in ("unet_name", "ckpt_name", "clip_name", "vae_name"):
            v = inp.get(k)
            if isinstance(v, str):
                models[k] = v
    if not text:
        raise HTTPException(status_code=422, detail="这个任务里没有文本编码节点，扒不到提示词")
    data = store.read(ep, "characters", {"characters": []})
    for x in data["characters"]:
        if x.get("id") == cid:
            x["prompt_used"] = text
            if seed:
                x["seed"] = seed
            if models:
                x["models"] = models
            store.write(ep, "characters", data)
            return {"ok": True, "prompt": text, "seed": seed, "models": models, "entity": x}
    raise HTTPException(status_code=404, detail=f"没有角色 {cid}")


def _auto_card_id(cards: list[dict], prefix: str) -> str:
    """新卡自动编号：char1 / char2 …（用户只在弹窗里填名字时用）。"""
    ids = {c.get("id") for c in cards}
    n = 1
    while f"{prefix}{n}" in ids:
        n += 1
    return f"{prefix}{n}"


@app.post("/api/character/{ep}")
def create_character(ep: str, body: dict):
    """新建角色：id 可省略（自动 char1 这种），name 中文。"""
    data = store.read(ep, "characters", {"characters": []})
    cid = (body.get("id") or "").strip().lower()
    if cid:
        if not cid.replace("_", "").isalnum():
            raise HTTPException(status_code=400, detail="id 只能用小写字母、数字、下划线")
        if any(c.get("id") == cid for c in data["characters"]):
            raise HTTPException(status_code=400, detail=f"角色 {cid} 已存在")
    else:
        cid = _auto_card_id(data["characters"], "char")
    item = {"id": cid, "name": body.get("name") or cid,
            # 留空就是留空：提示词会退回中性的 the subject。
            # 以前这里硬塞 "the character"，导致面板上写着「留空更好」、
            # 用户却发现自己从没填过的格子里有字，还以为自己忘了改。
            "label": body.get("label") or "",
            "look": "", "outfit": "", "props": "",
            "sheets": {"turnaround": [], "expression": [], "costume": [], "props": []}}
    data["characters"].append(item)
    store.write(ep, "characters", data)
    return {"ok": True, "character": item}


@app.delete("/api/character/{ep}/{cid}")
def delete_character(ep: str, cid: str):
    data = store.read(ep, "characters", {"characters": []})
    before = len(data["characters"])
    data["characters"] = [c for c in data["characters"] if c.get("id") != cid]
    if len(data["characters"]) == before:
        raise HTTPException(status_code=404, detail=f"没有角色 {cid}")
    store.write(ep, "characters", data)
    # 镜头里也要摘掉
    shots = store.shots(ep)
    for s in shots:
        if cid in (s.get("characters") or []):
            s["characters"] = [x for x in s["characters"] if x != cid]
    store.save_shots(ep, shots)
    return {"ok": True}


@app.delete("/api/scene/{ep}/{sid}")
def delete_scene(ep: str, sid: str):
    """删掉一个场景卡。

    和删角色一样要连带清理：镜头里对该场景的绑定，以及引用它的场景参考图。
    """
    data = store.read(ep, "scenes", {"scenes": []})
    before = len(data["scenes"])
    data["scenes"] = [x for x in data["scenes"] if x.get("id") != sid]
    if len(data["scenes"]) == before:
        raise HTTPException(status_code=404, detail=f"没有场景 {sid}")
    store.write(ep, "scenes", data)
    shots = store.shots(ep)
    for s in shots:
        if sid in (s.get("scenes") or []):
            s["scenes"] = [x for x in s["scenes"] if x != sid]
    store.save_shots(ep, shots)
    return {"ok": True}


@app.delete("/api/prop/{ep}/{pid}")
def delete_prop(ep: str, pid: str):
    """删掉一张道具卡。

    以前道具只有 POST 创建接口，画布上建了就删不掉（角色和场景早就各有 DELETE）。
    连带清理和删角色/场景一致：把镜头里对它的绑定一起摘掉。
    """
    data = store.read(ep, "props", {"props": []})
    before = len(data["props"])
    data["props"] = [x for x in data["props"] if x.get("id") != pid]
    if len(data["props"]) == before:
        raise HTTPException(status_code=404, detail=f"没有道具 {pid}")
    store.write(ep, "props", data)
    shots = store.shots(ep)
    for s in shots:
        if pid in (s.get("props") or []):
            s["props"] = [x for x in s["props"] if x != pid]
    store.save_shots(ep, shots)
    return {"ok": True}


@app.delete("/api/shot/{ep}/{sid}")
def delete_shot(ep: str, sid: str):
    """删掉一个镜头。

    连带清理：shots.json 里这一条 + 画布 layout 里 shot:Sxx / kf:Sxx / vid:Sxx#N 的坐标。
    产物文件不删（用户可能还要看），只从数据里移除。
    """
    shots = store.shots(ep)
    before = len(shots)
    kept = [s for s in shots if s.get("id") != sid]
    if len(kept) == before:
        raise HTTPException(status_code=404, detail=f"没有镜头 {sid}")
    store.save_shots(ep, kept)

    proj = store.read(ep, "project")
    canvas = proj.get("canvas") or {}
    nodes = canvas.get("nodes") or {}
    removed = [k for k in list(nodes.keys())
               if k.split(":")[-1].split("#")[0] == sid]
    for k in removed:
        nodes.pop(k, None)
    if removed:
        canvas["nodes"] = nodes
        proj["canvas"] = canvas
        store.write(ep, "project", proj)
    return {"ok": True, "id": sid, "layout_removed": len(removed)}


@app.get("/api/vocab")
def get_vocab():
    """镜头词汇表：前端用来渲染下拉（中文标签 + 固定英文短语）。"""
    return {name: [[k, zh] for k, (zh, _en) in table.items()]
            for name, table in vocab.SETS.items()}


@app.get("/api/characters/{ep}")
def list_characters(ep: str):
    return store.read(ep, "characters", {"characters": []})["characters"]


@app.post("/api/sheetgen/{ep}/{eid}/{group}")
def gen_sheet_group(ep: str, eid: str, group: str, body: dict):
    """表情 / 服装细节 / 道具：挂角色主参考图，一次提交出整组。"""
    chars = store.characters(ep)
    c = chars.get(eid)
    if not c:
        raise HTTPException(status_code=404, detail=f"没有角色 {eid}")
    ref = (body.get("ref") or c.get("ref") or "").strip()
    if not ref or not os.path.isfile(ref):
        raise HTTPException(status_code=400, detail="这个角色还没有主参考图")
    items_def = sheet_defs.group_items(group)
    seed = int(body.get("seed") or 0) or int(time.time()) % 1_000_000_007

    name = comfy.upload_image(ref, prefix=f"{eid}_{group}")
    # 画风句跟着走：不然表情/服装/道具这组永远出同一个调子
    # 变量名不要叫 prompts：那样会让 Python 把模块名当成本地变量，
    # 第 599 行就抛 UnboundLocalError
    _style_txt = prompts.render_text(store.read(ep, "project").get("style") or "cgphoto")
    items_prompts = [(key, f"{p} {_style_txt}".strip()) for key, _zh, _w, _h, p in items_def]
    # 和三视图同一条规矩：按源图比例生成（不写死尺寸，否则会被拉伸），
    # 出图之后再统一排版到 832x1248
    graph = multiview.build(name, items_prompts, seed=seed,
                            prefix=f"canvas/sheetgen/{store.slug(ep)}_{eid}_{group}",
                            save_prefix=f"{group}_")
    pid = comfy.submit(graph, f"{eid} {group}")
    hist = comfy.wait(pid, f"{eid} {group}", timeout=2400)
    files = sorted((f for f in comfy.produced(hist, ("images",))
                    if f["filename"].endswith(".png")), key=lambda f: f["filename"])
    if len(files) < len(items_def):
        raise HTTPException(status_code=500, detail=f"只出了 {len(files)}/{len(items_def)} 张")

    folder = _material_dir(ep, "char")
    tiles = []
    for i, (key, zh, _w, _h, prompt) in enumerate(items_def):
        raw = os.path.join(folder, f"{eid}_{group}_{key}_{seed}.png")
        shutil.copy2(comfy.local_path(files[i]), raw)
        tile = os.path.join(folder, f"{eid}_{group}_{key}_{seed}_tile.png")
        media.fit_to_canvas(raw, tile, *_project_size(ep))
        tiles.append(tile)

    # 拼成一张参考板：设定集里只放这一张，参考组才不会一个槽塞进 N 张图。
    # 列数按项数定：1–2 项一列，3–4 项两列，5–6 项三列，7 项以上五列。
    n = len(tiles)
    cols = 1 if n <= 2 else (2 if n <= 4 else (3 if n <= 6 else 5))
    sheet_path = os.path.join(folder, f"{eid}_{group}_{seed}_sheet.png")
    media.compose_grid(tiles, sheet_path, cols=cols, height=520)
    zh_all = " / ".join(zh for _k, zh, _w, _h, _p in items_def)
    new_items = [{"path": sheet_path, "raw": folder, "label": zh_all, "view": "sheet",
                  "prompt": "", "seed": seed}]

    data = store.read(ep, "characters", {"characters": []})
    for cc in data["characters"]:
        if cc.get("id") == eid:
            cc.setdefault("sheets", {}).setdefault(group, [])
            cc["sheets"][group] = new_items
            store.write(ep, "characters", data)
            return {"ok": True, "items": new_items, "tiles": tiles, "entity": cc}
    raise HTTPException(status_code=404, detail="角色在写入时消失了，重试")


@app.post("/api/refsheet/{ep}/{eid}")
def gen_refsheet(ep: str, eid: str, body: dict):
    """一键生成角色拼接参考图：4 视角 + 4 姿势 + 服装条（同种子，只改姿态段）。"""
    chars = store.characters(ep)
    c = chars.get(eid)
    if not c:
        raise HTTPException(status_code=404, detail=f"没有角色 {eid}")
    prompt = str(c.get("prompt_used") or "").strip()
    seed = int(c.get("seed") or 0)
    ref = str(c.get("ref") or "").strip()
    if not prompt or not seed:
        raise HTTPException(status_code=400,
                            detail="这个角色还没有「文字人设 + 种子」；先用「用文字生成主参考图」，或上传一张并在角色里填好人设")
    # 不再要求主参考图——正面由人设 + 种子现生成，
    # 否则"删掉的主参考图"会作为第一格混进拼盘（用户踩到过）。
    if not ref:
        ref = ""

    stamp = time.strftime("%Y%m%d_%H%M%S")
    folder = _material_dir(ep, "char")
    out_path = os.path.join(folder, f"{eid}_{stamp}.png")
    workdir = os.path.join(folder, f"_work_{eid}_{stamp}")
    # 关键：这里不能给默认服装！给了默认值，下面的"从人设自动抽单品"就永远轮不到执行，
    # 结果每个角色都是同一句"整套服装"→ 同一张图。
    costume = body.get("costume") or []
    costume = [(str(k), str(v)) for k, v in costume]

    try:
        refsheet.build(prompt=prompt, seed=seed, front_path=ref, out_path=out_path,
                       workdir=workdir, costume_items=costume, size=_project_size(ep))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"生成失败：{type(e).__name__}: {e}")

    data = store.read(ep, "characters", {"characters": []})
    for cc in data["characters"]:
        if cc.get("id") == eid:
            cc["ref"] = out_path
            cc["sheets"] = {"turnaround": [{"path": out_path, "label": "拼接", "view": "sheet",
                                            "prompt": "", "seed": seed}]}
            store.write(ep, "characters", data)
            return {"ok": True, "path": out_path, "entity": cc}
    raise HTTPException(status_code=404, detail="写入时角色消失了，重试")


# ---------------------------------------------------------------- 环境体检 / 选文件夹
# 权重清单：键 → (模型子目录, 中文用途, HF repo, HF 文件路径)。
# 文件名由 settings.model() 给（设置里可覆盖）；repo/path 是下载源，写死。
# 完整下载 URL = https://huggingface.co/{repo}/resolve/main/{path}
MODEL_DOC = {
    "krea2_unet": ("diffusion_models", "Krea2 主模型：出首帧 / 角色设定图 / 场景空镜",
                   "Comfy-Org/Krea-2", "diffusion_models/krea2_turbo_fp8_scaled.safetensors"),
    "krea2_clip": ("text_encoders", "Krea2 文本编码器",
                   "Comfy-Org/Krea-2", "text_encoders/qwen3vl_4b_fp8_scaled.safetensors"),
    "krea2_vae": ("vae", "Krea2 / Qwen-Edit 共用 VAE",
                  "Comfy-Org/Krea-2", "vae/qwen_image_vae.safetensors"),
    "qwen_edit_unet": ("diffusion_models", "Qwen-Image-Edit 2511：多角度三视图 / 场景去人",
                       "Comfy-Org/Qwen-Image-Edit", "split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors"),
    "qwen_edit_clip": ("text_encoders", "Qwen-Image-Edit 文本编码器",
                       "Comfy-Org/HunyuanVideo_1.5_repackaged", "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"),
    "qwen_edit_vae": ("vae", "同 qwen_image_vae，填一样即可",
                      "Comfy-Org/Krea-2", "vae/qwen_image_vae.safetensors"),
    "qwen_lora_angles": ("loras", "多角度 LoRA",
                         "fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA", "qwen-image-edit-2511-multiple-angles-lora.safetensors"),
    "qwen_lora_lightning": ("loras", "Qwen-Edit 4 步加速 LoRA",
                            "lightx2v/Qwen-Image-Edit-2511-Lightning", "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"),
    "h3_clip": ("text_encoders", "H3 文本编码器",
                "Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
    "h3_video_vae": ("vae", "H3 视频 VAE",
                     "Kijai/MiniMax-H3-experimental", "minimax_h3_video_vae_int8_convrot.safetensors"),
    "h3_audio_vae": ("vae", "H3 音频 VAE",
                     "Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors"),
}

# 可选权重：缺了不影响画布主流程，只是「生成多角度 / 生成组 / 场景去人」这几个按钮用不了。
# 两处行为都按这份清单走：
#   1. 体检不把它们算进「必须齐」—— 缺了不弹设置、不挡着进画布；
#   2. 前端据此隐藏依赖它们的按钮（否则用户点下去才报缺模型，等于把 ComfyUI 的细节甩给他）。
# 这套是 Qwen-Image-Edit 链路，多下十几个 GB；用户只用主流程就不必装。
OPTIONAL_MODELS = {
    "qwen_edit_unet", "qwen_edit_clip", "qwen_edit_vae",
    "qwen_lora_angles", "qwen_lora_lightning",
}


# 低配档只剩 W4A8 一条：主模型换 W4A8、文本编码器换 4B + ClipProj 投影。
# 8 GB 显存方案（社区验证）。
# 来源：github.com/reventadirecta/MiniMax-H3-ComfyUI-8GB-VRAM（RTX 4060 Laptop 8GB + 16GB RAM）
LOWVRAM_DOC = [
    ("w4a8_unet", "diffusion_models", "H3 ref2va W4A8 主模型（约 11.7 GiB，原版 int8 是 19.5 GiB）",
     "starsfriday/MiniMax-H3-w4a8", "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors"),
    ("w4a8_clip", "text_encoders", "Qwen3-VL 4B 文本编码器（小一号，替代 32B 那个 14.6 GiB）",
     "Stick9190/qwen3vl_4b_int8_convrot", "qwen3vl_4b_int8_convrot.safetensors"),
    ("w4a8_proj", "clip_projections", "ClipProj 4B 投影矩阵（4B 编码器必须配它）",
     "NicoLab28/ClipProj-MiniMax-H3", "mmh3-4b-ClipProj-v3-mlp.safetensors"),
]
LOWVRAM_NOTE = {
    "repo": "https://github.com/reventadirecta/MiniMax-H3-ComfyUI-8GB-VRAM",
    "clip_node": "https://github.com/nicolab28/ComfyUI-ClipProj",
    "flags": "--lowvram --fp16-vae（别加 --cpu-vae）",
    "params": "480×864、158 帧、20 步、euler + simple（25 步在他们的 8GB 机器上不稳）",
    "tested": "8 GB 显存 + 32 GB 内存笔记本；社区参考：RTX 4060 Laptop 8GB + 16GB 内存",
    "runtime": "5 秒片约 7 分钟（608×352、20 步、--lowvram --fp16-vae）",
}

def _hf_urls(repo: str, path: str) -> dict:
    """一个 HF 文件的官方 + 镜像下载地址。国内直连 HF 经常超时，镜像兜底。"""
    if not repo or not path:
        return {}
    return {
        "hf": f"https://huggingface.co/{repo}/resolve/main/{path}",
        "mirror": f"https://hf-mirror.com/{repo}/resolve/main/{path}",
    }

# 每个权重该问哪个 loader 节点。ComfyUI 的 object_info 是唯一权威来源：
# 它已经把所有挂载路径（ComfyUI\models + extra_model_paths.yaml）合并好了。
MODEL_LOADER = {
    "krea2_unet": "UNETLoader", "krea2_clip": "CLIPLoader", "krea2_vae": "VAELoader",
    "qwen_edit_unet": "UNETLoader", "qwen_edit_clip": "CLIPLoader", "qwen_edit_vae": "VAELoader",
    "qwen_lora_angles": "LoraLoaderModelOnly", "qwen_lora_lightning": "LoraLoaderModelOnly",
    "h3_clip": "CLIPLoader", "h3_video_vae": "VAELoader", "h3_audio_vae": "VAELoader",
}
LOADER_FIELD = {"UNETLoader": "unet_name", "CLIPLoader": "clip_name",
                "VAELoader": "vae_name", "LoraLoaderModelOnly": "lora_name"}

# 必需节点：类名 → (来源包, 是否硬性必需, git 安装地址)。
# git 为空 = ComfyUI 官方核心节点，升级 ComfyUI 即可，无需单独装。
# 除这 8 个外，本工程用到的其余节点全是 ComfyUI 官方核心（nodes / comfy_extras）。
REQUIRED_NODES = {
    "MiniMaxH3ReferenceToVideo": ("ComfyUI 官方（H3 支持，需新版本）", True, ""),
    "MiniMaxH3SigmaShift": ("ComfyUI 官方（H3 支持）", True, ""),
    "SpectrumApplyMiniMaxH3": ("ComfyUI-Spectrum-MiniMax-H3", True,
                               "https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3"),
    "H3RelayCopyBridge": ("ComfyUI-H3-Latent-Relay", False,
                          "https://github.com/ZenHG/ComfyUI-H3-Latent-Relay"),
    "H3RelayLatentSave": ("ComfyUI-H3-Latent-Relay", False,
                          "https://github.com/ZenHG/ComfyUI-H3-Latent-Relay"),
    "PathchSageAttentionKJ": ("comfyui-kjnodes（缺了自动退回 SDPA，只是慢）", False,
                              "https://github.com/kijai/ComfyUI-KJNodes"),
    "BiRefNetRMBG": ("ComfyUI-RMBG（只影响场景「去人」）", False,
                     "https://github.com/1038lab/ComfyUI-RMBG"),
    "RIFE VFI": ("comfyui-frame-interpolation（只影响补帧）", False,
                 "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation"),
}

# 节点类 → 它在 custom_nodes 里的文件夹名。体检用它区分两种情况：
#   「文件夹都没有」= 真没装；「文件夹在但节点没注册」= 装了但 ComfyUI 启动时导入失败。
# 后者再提示去 git clone 就是误导。
NODE_FOLDER = {
    "SpectrumApplyMiniMaxH3": "ComfyUI-Spectrum-MiniMax-H3",
    "H3RelayCopyBridge": "ComfyUI-H3-Latent-Relay",
    "H3RelayLatentSave": "ComfyUI-H3-Latent-Relay",
    "PathchSageAttentionKJ": "ComfyUI-KJNodes",
    "BiRefNetRMBG": "ComfyUI-RMBG",
    "RIFE VFI": "comfyui-frame-interpolation",
}

# H3 的 unet / turbo LoRA 由 object_info 关键词自动匹配（改名也能认），不在 MODEL_DOC 里，
# 但缺的时候也得给下载路径。这里单独列，体检时和动态匹配结果一起报。
H3_EXTRA = {
    "h3_unet_ref2va": ("diffusion_models", "H3 ref2va 出片主模型（参考图生成）",
                       "Comfy-Org/MiniMax-H3", "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"),
    "h3_unet_fl2va": ("diffusion_models", "H3 fl2va 出片主模型（图生视频）",
                      "Comfy-Org/MiniMax-H3", "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
    "h3_lora_ref2v": ("loras", "H3 ref2v 8 步 turbo LoRA（加速，当前档位）",
                      "lightx2v/Minimax-h3-Turbo", "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"),
    "h3_lora_fl2v": ("loras", "H3 fl2v 8 步 turbo LoRA（加速，只有图生视频路线才要）",
                     "lightx2v/Minimax-h3-Turbo", "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"),
}


SOURCE_ZH = {"setting": "你选的", "env": "环境变量", "auto": "自动探测到的", "": "未配置"}


def _sys_ram() -> dict:
    """系统物理内存（GB）。--lowvram 是把权重放内存里换，内存不够一样跑不动。"""
    if os.name != "nt":
        return {}
    try:
        import ctypes  # noqa: PLC0415

        class _MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        m = _MS()
        m.dwLength = ctypes.sizeof(_MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return {"total_gb": round(m.ullTotalPhys / 2**30, 1),
                "free_gb": round(m.ullAvailPhys / 2**30, 1)}
    except Exception:  # noqa: BLE001
        return {}

def _build_info() -> dict:
    """画布这份代码的版本：git 短哈希 + 本文件修改时间。

    体检顶部显示它，用来判断"这台机器到底有没有 pull 到最新"
    。
    """
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    commit = ""
    try:
        gitdir = os.path.join(root, ".git")
        head = open(os.path.join(gitdir, "HEAD"), encoding="utf-8").read().strip()
        if head.startswith("ref:"):
            ref = head.split(":", 1)[1].strip()
            commit = open(os.path.join(gitdir, *ref.split("/")), encoding="utf-8").read().strip()[:7]
        else:
            commit = head[:7]
    except OSError:
        commit = ""
    try:
        built = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(__file__)))
    except OSError:
        built = ""
    return {"commit": commit, "built": built}


@app.post("/api/env/install/sage")
def install_sage():
    """用 ComfyUI 自己的解释器装 sageattention（体检里点「一键安装」触发）。

    只跑 pip，不碰别的东西；装完立刻复验 import，把日志尾巴回给前端看。
    """
    py = comfy.comfy_python()
    if not py:
        raise HTTPException(status_code=400,
                            detail="没找到 ComfyUI 的解释器：先在设置里选对 ComfyUI 文件夹，再点一次")
    import subprocess  # noqa: PLC0415
    try:
        r = subprocess.run([py, "-m", "pip", "install", "sageattention"], capture_output=True, text=True, timeout=1800, **_nowin())
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504,
                            detail="pip 超过 30 分钟没结束，停下来去 ComfyUI 那边手动装吧") from None
    log = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()

    def _import_check() -> tuple[bool | None, str]:
        try:
            chk = subprocess.run([py, "-c", "import sageattention"], capture_output=True, text=True, timeout=90, **_nowin())
            return (chk.returncode == 0,
                    ((chk.stderr or "") + (chk.stdout or "")).strip()[-600:])
        except Exception as exc:  # noqa: BLE001
            return (None, f"{type(exc).__name__}: {exc}")

    dep, err = _import_check()
    if dep is False:
        # pip 说已满足、import 还是失败 = 装的那份跟 torch/CUDA 不匹配 → 强制重装一次
        log += "\n\n[已安装但导入失败，改用 --force-reinstall 重装一次]\n"
        try:
            r2 = subprocess.run([py, "-m", "pip", "install", "--force-reinstall", "sageattention"], capture_output=True, text=True, timeout=1800, **_nowin())
            log += ((r2.stdout or "") + "\n" + (r2.stderr or "")).strip()
        except subprocess.TimeoutExpired:
            log += "\n[强装超时]"
        dep, err = _import_check()
    if dep is False and "no module named 'triton'" in err.lower():
        # sageattention 依赖 triton；Windows 上官方 triton 没有 wheel，要装 triton-windows
        log += "\n\n[缺 triton：改装 triton-windows]\n"
        try:
            r3 = subprocess.run([py, "-m", "pip", "install", "triton-windows"], capture_output=True, text=True, timeout=1800, **_nowin())
            log += ((r3.stdout or "") + "\n" + (r3.stderr or "")).strip()
        except subprocess.TimeoutExpired:
            log += "\n[triton-windows 安装超时]"
        dep, err = _import_check()
    return {"ok": r.returncode == 0, "dep": dep, "error": err,
            "python": py, "log": log[-4000:]}


@app.get("/api/env/check")
def env_check(fresh: bool = False):
    """体检：ComfyUI 目录 / 服务在线 / 三个子目录 / 权重文件 / 必需节点。

    只读，不改任何东西。别人第一次配置就看这张清单。

    `fresh=true` 会忽略设置、环境变量和自动探测，完全模拟"全新安装、什么都没配"——
    自动探测在本机几乎总能成功，不关掉就永远看不出配置那条链路对不对。
    """
    root, source, note = settings.resolve_root(simulate_fresh=fresh)
    cfg = settings.load().get("comfy") or {}
    url = settings.comfy_url()

    dirs = {d: bool(root and os.path.isdir(os.path.join(root, d)))
            for d in ("models", "input", "output")}

    build = _build_info()
    online, device = comfy.online()
    vram = comfy.device_vram()
    ram = _sys_ram()

    # 在线时问 ComfyUI 要真实清单：那是唯一权威来源，能涵盖 extra_model_paths.yaml
    # 甚至别的方式挂进来的目录（踩到：模型挂在别的盘会误报
    # 只看 ComfyUI\models 会误报"缺 1 个权重"）。
    avail: dict[str, set | None] = {}
    for cls in ("UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly"):
        avail[cls] = None
        if not online:
            continue
        try:
            req = comfy.object_info(cls)[cls]["input"]["required"]
            avail[cls] = set(req[LOADER_FIELD[cls]][0] or [])
        except Exception:  # noqa: BLE001 - 查不到就退回文件系统
            avail[cls] = None

    models = []
    for key, (subdir, desc, repo, path) in MODEL_DOC.items():   # 变量名别叫 note：会盖掉上面 resolve_root 的说明
        fn = settings.model(key)
        loader = MODEL_LOADER.get(key, "")
        names = avail.get(loader)
        where, exist, real_dir = "", False, ""
        if names is not None:
            exist = fn in names
            where = loader if exist else ""
            if exist:
                # 有真实目录就显示路径（比类名有用），顺便量出实际大小
                for d in settings.model_dirs(subdir):
                    if os.path.isfile(os.path.join(d, fn)):
                        real_dir, where = d, d
                        break
        if not exist:
            # 离线，或者在线但清单里没有：再按目录挨个找（含 extra_model_paths 挂的盘）
            for d in settings.model_dirs(subdir):
                if os.path.isfile(os.path.join(d, fn)):
                    exist, real_dir = True, d
                    where = d
                    break
        gb = 0.0
        if real_dir:
            try:
                gb = round(os.path.getsize(os.path.join(real_dir, fn)) / 2**30, 2)
            except OSError:
                gb = 0.0
        elif exist and root:
            p = os.path.join(root, "models", subdir, fn)
            try:
                gb = round(os.path.getsize(p) / 2**30, 2)
            except OSError:
                gb = 0.0
        models.append({
            "key": key, "file": fn, "subdir": subdir, "note": desc,
            "exist": exist, "gb": gb, "where": where,
            "override": key in (settings.load().get("models") or {}),
            **_hf_urls(repo, path),
        })

    custom_dir = os.path.join(root, "custom_nodes") if root else ""
    nodes = []
    for name, (pkg, required, git) in REQUIRED_NODES.items():
        found = False
        if online:
            try:
                found = bool(comfy.object_info(name))
            except Exception:  # noqa: BLE001 - 查不到就当没有
                found = False
        folder = NODE_FOLDER.get(name, "")
        dir_ok = bool(custom_dir and folder and os.path.isdir(os.path.join(custom_dir, folder)))
        # ComfyUI 没开时 object_info 问不到，这不等于"缺包"，标 unknown 别吓人
        nodes.append({"name": name, "pkg": pkg, "required": required, "git": git,
                      "folder": folder, "dir_ok": dir_ok,
                      "found": found, "unknown": not online})

    # H3 的 unet / turbo LoRA 是按关键词从 ComfyUI 实际列表里挑的（改名也能认）
    h3_unet, h3_lora = ("", "")
    if online:
        try:
            h3_unet, h3_lora = graphs._pick_h3_weights("ref2va")
        except Exception:  # noqa: BLE001
            pass

    # H3 动态权重缺了也要给下载路径（ref2va + fl2va 两条链路都查）
    h3_missing = []
    if online:
        for kind, (u_key, l_key) in (("ref2va", ("h3_unet_ref2va", "h3_lora_ref2v")),
                                     ("fl2va", ("h3_unet_fl2va", "h3_lora_fl2v"))):
            try:
                u, l = graphs._pick_h3_weights(kind)
            except Exception:  # noqa: BLE001
                u, l = "", ""
            if not u:
                h3_missing.append(u_key)
            if not l:
                h3_missing.append(l_key)
    h3_missing = [{"key": k, "subdir": H3_EXTRA[k][0], "note": H3_EXTRA[k][1],
                   "file": H3_EXTRA[k][3].rsplit("/", 1)[-1],
                   **_hf_urls(H3_EXTRA[k][2], H3_EXTRA[k][3])}
                  for k in dict.fromkeys(h3_missing)]

    # 8 GB 低显存方案：单独一段，缺了不算"必须齐"
    lowvram = []
    for _key, _subdir, _desc, *rest in LOWVRAM_DOC:
        _fn = settings.model(_key)
        _path = ""
        for _d in settings.model_dirs(_subdir):
            _p = os.path.join(_d, _fn)
            if os.path.isfile(_p):
                _path = _p
                break
        _item = {"key": _key, "file": _fn, "subdir": _subdir, "note": _desc,
                 "exist": bool(_path), "where": _path}
        if rest:  # pub 版是 (key, subdir, desc, repo, path) 五元组
            _item.update(_hf_urls(rest[0], rest[1]))
        lowvram.append(_item)
    clipproj_ok = False
    if online:
        try:
            clipproj_ok = bool(comfy.object_info("ClipProjApply"))
        except Exception:  # noqa: BLE001
            clipproj_ok = False
    # SageAttention 依赖：节点在 ≠ 能跑。KJNodes 的 import 写在函数里，节点注册得上、
    # 执行到 patch 才 ModuleNotFoundError。这里用 ComfyUI 自己的
    # 解释器试一次 import，提前发现；找不到解释器就标"测不了"，不假装通过。
    sage_node = next((n["found"] for n in nodes if n["name"] == "PathchSageAttentionKJ"), False)
    sage = {"node": sage_node, "dep": None, "python": ""}
    if online and sage_node:
        py = comfy.comfy_python()
        sage["python"] = py
        if py:
            import subprocess  # noqa: PLC0415
            try:
                r = subprocess.run([py, "-c", "import sageattention"], capture_output=True, text=True, timeout=90, **_nowin())
                sage["dep"] = (r.returncode == 0)
                if not sage["dep"]:
                    # 装了但 import 失败 = 二进制跟 torch/CUDA 不匹配，把真正的报错带出去
                    sage["error"] = ((r.stderr or "") + (r.stdout or "")).strip()[-600:]
            except Exception as exc:  # noqa: BLE001 - 解释器跑不起来就当测不了
                sage["dep"] = None
                sage["error"] = f"{type(exc).__name__}: {exc}"

    miss_models = [m for m in models if not m["exist"] and m["key"] not in OPTIONAL_MODELS]
    miss_optional = [m for m in models if not m["exist"] and m["key"] in OPTIONAL_MODELS]
    # 只有"在线但查不到"才算缺；离线导致的一律不算
    miss_nodes = [n for n in nodes if not n["found"] and not n["unknown"]]
    miss_nodes_req = [n for n in miss_nodes if n["required"]]
    ok = bool(root) and online and not miss_models and not miss_nodes_req

    if not root:
        if source == "setting":
            hint = f"你设的路径用不了：{note or '不认这个目录'}"
        elif fresh:
            hint = "模拟未配置：现在跟全新安装一样。点「浏览…」选 ComfyUI 文件夹，看纠正对不对"
        else:
            hint = "没找到 ComfyUI 目录，点「浏览…」选一下"
    elif not online:
        hint = "ComfyUI 没启动：目录和权重都正常（目录探测不依赖 8188），启动后再点一次确认节点"
    elif miss_models or miss_nodes_req:
        hint = f"还缺 {len(miss_models)} 个权重文件 / {len(miss_nodes_req)} 个必需节点"
    else:
        hint = "可以出片"
    # 可选权重缺失：不影响「能不能用」，只说清少哪几个按钮，不吓人
    if miss_optional:
        hint += f"（可选：多角度/去人那套缺 {len(miss_optional)} 个文件，相关按钮已隐藏）"
    if vram and vram.get("total_gb", 99) < 12:
        hint += f"（显存 {vram['total_gb']} GB 偏低，出片可能 OOM，见 README）"
    return {
        "root": root, "root_set": str(cfg.get("root") or ""), "url": url,
        "root_source": source, "root_source_zh": SOURCE_ZH.get(source, source),
        "root_note": note, "fresh": bool(fresh),
        "online": online, "device": device, "vram": vram, "ram": ram, "dirs": dirs, "build": build,
        "models": models, "models_missing": len(miss_models),
        "models_optional_missing": [m["key"] for m in miss_optional],
        "models_optional_note": ("可选权重缺 " + str(len(miss_optional)) + " 个："
                                 "「生成多角度 / 生成组 / 场景去人」用不了，主流程不受影响"
                                 if miss_optional else ""),
        "nodes": nodes, "nodes_missing": [n["name"] for n in miss_nodes],
        "nodes_checked": online,
        "h3": {"unet": h3_unet, "lora": h3_lora},
        "h3_missing": h3_missing,
        "lowvram": lowvram,
        "lowvram_note": LOWVRAM_NOTE,
        "clipproj_ok": clipproj_ok,
        "sage": sage,
        "ok": ok, "hint": hint,
    }


@app.post("/api/env/pick")
def env_pick(body: dict | None = None):
    """弹本机原生「选择文件夹」对话框，返回选中的绝对路径。

    浏览器给不了本地路径（`webkitdirectory` 只回文件名），所以这一步必须在后端做。
    选完立刻在**选中路径的上下几层**里纠正层级（选成外壳目录 / 选深一层都是常事），
    不扫全盘。纠正不了就老实报"这不是 ComfyUI 目录"。
    """
    import subprocess
    script = os.path.join(AGENT, "tools", "pick_dir.py")
    if not os.path.isfile(script):
        raise HTTPException(status_code=500, detail="缺 tools/pick_dir.py")
    initial = str((body or {}).get("initial") or "").strip() or settings.comfy_root()
    cmd = [sys.executable, script, "--initial", initial]
    flags = 0x08000000 if os.name == "nt" else 0    # CREATE_NO_WINDOW：别闪黑框
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=180, creationflags=flags)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="对话框等了 180 秒，再点一次") from None
    out = (r.stdout or b"").decode("utf-8", "replace").strip()
    if not out:
        err = (r.stderr or b"").decode("utf-8", "replace").strip()
        return {"ok": False, "cancelled": True, "detail": err[:300]}

    root, note = settings.normalize_root(out)
    if not root:
        # 选了但不是 ComfyUI：把原文回给前端显示，路径不写进设置
        return {"ok": False, "cancelled": False, "picked": out, "detail": note}
    return {"ok": True, "path": root, "picked": out, "note": note}


@app.get("/api/settings")
def get_settings():
    return settings.public()


@app.put("/api/settings")
def put_settings(body: dict):
    settings.save(body or {})
    return settings.public()


@app.post("/api/translate")
def do_translate(body: dict):
    """把中文镜头描述翻成英文。用户自己填的密钥，本机发出请求。"""
    text = str(body.get("text") or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail="没有要翻译的内容")
    cfg = settings.load()["llm"]
    slots = body.get("slots") or []
    try:
        out = llm.translate(text, cfg, slots=slots)
    except llm.LLMError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {"ok": True, "text": out, "model": cfg.get("model", "")}


@app.post("/api/scene/{ep}/{sid}/plate")
def gen_scene_plate(ep: str, sid: str, body: dict):
    """文生图造一张空镜（无人），可直接当场景参考。"""
    gen = dict(body.get("gen") or {})
    card = next((x for x in store.read(ep, "scenes", {"scenes": []})["scenes"]
                 if x.get("id") == sid), {})
    # 场景卡的「空间」是主描述，永远参与拼装——
    # 不能因为下拉里选了时间/天气就把它丢掉（那样用户写的空间等于白写）。
    look = str(card.get("look") or "").strip()
    note = str(gen.get("note") or "").strip()
    if look and note and look != note:
        gen["note"] = f"{look}；{note}"
    else:
        gen["note"] = look or note
    if gen.get("note"):
        gen["note"] = _en_if_cn(gen["note"])   # 中文 note 自动翻英文（Krea2）
    prompt = scene_defs.build_plate(gen)
    if not prompt or len(prompt) < 20:
        raise HTTPException(status_code=400,
                            detail="场景卡里还没有描述：先在「空间」里写清楚，才能造空镜")
    seed = int(body.get("seed") or 0) or int(time.time()) % 1_000_000_007
    # 空镜尺寸跟项目走：它是要当整帧背景用的，必须和出片同比例。
    # 以前走 aspect + megapixels，算出来的像素和素材图对不上。
    _pw, _ph = _project_size(ep)
    graph = graphs.krea2(prompt, seed=seed,
                         prefix=f"canvas/scenes/{store.slug(ep)}_{sid}_plate",
                         width=_pw, height=_ph)
    pid = comfy.submit(graph, f"{sid} plate")
    hist = comfy.wait(pid, f"{sid} plate", timeout=1200)
    files = comfy.produced(hist, ("images",))
    if not files:
        raise HTTPException(status_code=500, detail="没出图")
    folder = _material_dir(ep, "scene")
    dst = os.path.join(folder, f"{sid}_plate_{seed}.png")
    shutil.copy2(comfy.local_path(files[-1]), dst)

    data = store.read(ep, "scenes", {"scenes": []})
    for sc in data["scenes"]:
        if sc.get("id") == sid:
            sc.setdefault("sheets", {}).setdefault("plate", []).append(
                {"path": dst, "label": "空镜", "prompt": prompt, "seed": seed})
            sc.setdefault("gen", {}).update(gen)
            if not sc.get("ref"):
                sc["ref"] = dst          # 没有主参考时，直接用它
            store.write(ep, "scenes", data)
            return {"ok": True, "path": dst, "prompt": prompt, "seed": seed,
                    "set_as_ref": sc.get("ref") == dst, "scene": sc}
    raise HTTPException(status_code=404, detail=f"没有场景 {sid}")


@app.post("/api/scene/{ep}/{sid}/clean")
def clean_scene(ep: str, sid: str, body: dict):
    """把场景图里的人 / 人影擦掉（Qwen-Image-Edit 单图编辑）。"""
    data = store.read(ep, "scenes", {"scenes": []})
    sc = next((x for x in data["scenes"] if x.get("id") == sid), None)
    if not sc:
        raise HTTPException(status_code=404, detail=f"没有场景 {sid}")
    src = (body.get("path") or sc.get("ref") or "").strip()
    if not src or not os.path.isfile(src):
        raise HTTPException(status_code=400, detail="这个场景还没有图")
    seed = int(body.get("seed") or 0) or int(time.time()) % 1_000_000_007
    prompt = scene_defs.clean_prompt(body.get("extra") or "")
    name = comfy.upload_image(src, prefix=f"{sid}_clean")
    graph = multiview.build_edit([name], prompt, seed=seed,
                                 prefix=f"canvas/scenes/{store.slug(ep)}_{sid}_clean")
    pid = comfy.submit(graph, f"{sid} clean")
    hist = comfy.wait(pid, f"{sid} clean", timeout=1200)
    files = comfy.produced(hist, ("images",))
    if not files:
        raise HTTPException(status_code=500, detail="没出图")
    folder = _material_dir(ep, "scene")
    dst = os.path.join(folder, f"{sid}_clean_{seed}.png")
    shutil.copy2(comfy.local_path(files[-1]), dst)
    for x in data["scenes"]:
        if x.get("id") == sid:
            x.setdefault("sheets", {}).setdefault("plate", []).append(
                {"path": dst, "label": "去人", "prompt": prompt, "seed": seed})
            store.write(ep, "scenes", data)
            return {"ok": True, "path": dst, "prompt": prompt, "seed": seed}
    raise HTTPException(status_code=404, detail="写入失败")


@app.get("/api/styles")
def get_styles():
    """画风预设：id + 中文名 + 说明（render 也给，方便看看到底加了什么词）。"""
    out = []
    for sid in prompts.style_names():
        path = os.path.join(AGENT, "styles", f"{sid}.json")
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        out.append({"id": sid, "zh": d.get("zh", sid), "render": d.get("render", ""),
                    "note": d.get("note", "")})
    return out


@app.patch("/api/project/{ep}")
def patch_project(ep: str, body: dict):
    data = store.read(ep, "project")
    data.update(body or {})
    # 横竖屏和宽高必须同时改：只切 orientation 的话，出图/出片读的还是旧的 width/height，
    # 表现就是「顶上写了竖屏，出的还是横屏图」。
    # 目标分辨率统一取 SIZE_PORTRAIT / SIZE_LANDSCAPE，别再各写一套数字。
    ori = str(data.get("orientation") or "portrait").lower()
    if "orientation" in (body or {}) or not data.get("width") or not data.get("height"):
        data["width"], data["height"] = SIZE_LANDSCAPE if ori != "portrait" else SIZE_PORTRAIT
    store.write(ep, "project", data)
    return {"ok": True, "project": data}


JOBS: dict[str, dict] = {}


def _reload_pipeline() -> None:
    """每次跑任务前重载流水线模块。

    为什么：编辑了 core/*.py 或 steps/*.py 之后，Python 进程里还是旧模块，
    接口会按旧代码跑（这个坑已经踩了三次）。重载一次代价很小，换来"改完即生效"。
    """
    import importlib

    from core import comfy as _c, engines as _e, graphs as _g, llm as _l, media as _m
    from core import prompts as _p, scenes as _sc, refs as _rs
    for m in (_c, _e, _g, _l, _m, _p, _sc, _rs):
        importlib.reload(m)
    from steps import video as _v
    importlib.reload(_v)
    for _name in ("interp", "concat_film"):
        try:
            importlib.reload(importlib.import_module(f"steps.{_name}"))
        except Exception:  # noqa: BLE001
            pass


def _job_video(job_id: str, ep: str, sid: str, engine: str, seed: int,
               count: int = 1, seconds: float = 0) -> None:
    """出视频。count>1 时串行跑多条：第一条用给定种子，之后每条换新种子。

    串行而不是并发：显存只有一份，并发只会互相拖慢。
    """
    job = JOBS[job_id]
    runs: list[dict] = []
    _fps48 = int((store.read(ep, "project") or {}).get("fps") or 24) >= 48
    try:
        _reload_pipeline()
        from steps import video as video_step
        import random as _random

        for i in range(max(1, min(3, int(count or 1)))):
            if i > 0:
                seed = _random.randint(1, 1_000_000_000)
            job["status"] = "running"
            job["progress"] = f"第 {i + 1}/{count} 条"
            print(f"  > {job['progress']}  种子 {seed}", flush=True)
            try:
                with open(os.path.join(AGENT, "out", "video_seconds.log"), "a", encoding="utf-8") as _f:
                    _f.write(f"{time.strftime('%H:%M:%S')} JOB {ep}/{sid} seconds={seconds!r}\n")
            except Exception:
                pass
            out = video_step.run(ep, sid, engine=engine, force=True, seed=seed,
                                 seconds_override=float(seconds or 0))
            _poster = ""
            try:
                _poster = media.poster(
                    out.get("path") or "",
                    os.path.join(AGENT, "projects", store.slug(ep), "assets",
                                 f"{sid}_poster_{out.get('seed')}.png"))
            except Exception as _exc:  # noqa: BLE001 - 封面失败不影响出片
                print(f"  ! 抽封面失败：{_exc}")
            runs.append({"path": out.get("path"), "seed": out.get("seed"),
                         "prompt": out.get("prompt"), "poster": _poster,
                         "at": time.strftime("%Y-%m-%d %H:%M:%S")})
            # 每跑完一条就落盘一次完整列表，别等最后（中间可能被打断）
            store.set_state(ep, sid, video_runs=list(runs))
            if _fps48:
                job["progress"] = f"第 {i + 1}/{count} 条 · 补帧 48fps"
                try:
                    from steps import interp as interp_step
                    interp_step.run(ep, sid, out.get("path") or "")
                    runs = list((store.shot(ep, sid).get("state") or {}).get("video_runs") or [])
                except Exception as _exc:  # noqa: BLE001 - 补帧失败不该毁掉已出的片
                    print(f"  ! 自动补帧失败，保留 24fps 母版：{_exc}")
        job["status"] = "done"
        job["result"] = {"path": runs[-1].get("path") if runs else None,
                         "prompt": runs[-1].get("prompt") if runs else None,
                         "engine": engine, "runs": runs}
    except Exception as e:  # noqa: BLE001 - 全部回传给前端
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        job["ended"] = time.time()


@app.post("/api/shot/{ep}/{sid}/choose")
def choose_run(ep: str, sid: str, body: dict):
    """指定这一镜用哪一条成片当母版（衔接、末帧都以它为准）。"""
    path = str((body or {}).get("path") or "").strip()
    shot = store.shot(ep, sid)
    runs = (shot.get("state") or {}).get("video_runs") or []
    hit = next((r for r in runs if r.get("path") == path), None)
    if not hit:
        raise HTTPException(status_code=400, detail="这个路径不在本镜的成片列表里")
    if not os.path.isfile(path):
        raise HTTPException(status_code=400, detail=f"文件不存在：{path}")
    # 顺带把这个母版的末帧抽出来，承接时直接用，避免每次重抽
    last_png = os.path.join(AGENT, "projects", store.slug(ep), "assets",
                            f"{sid}_chosen_last.png")
    try:
        media.last_frame(path, last_png)
    except RuntimeError as exc:
        print(f"  ! 抽末帧失败：{exc}")
        last_png = ""
    store.set_state(ep, sid, chosen_video=path, chosen_seed=hit.get("seed"),
                    chosen_last_frame=last_png, video=path, video_seed=hit.get("seed"))
    return {"ok": True, "chosen": path, "seed": hit.get("seed"),
            "last_frame": last_png}


@app.post("/api/shot/{ep}/{sid}/video")
def gen_video(ep: str, sid: str, body: dict):
    """出视频：后台跑（2–5 分钟），返回 job id，前端轮询 /api/job/{id}。"""
    shot = store.shot(ep, sid)
    st = shot.get("state") or {}
    proj = store.read(ep, "project")
    # 两种模式：ref2v（参考图 Ref2VA）/ fl2v（首帧 FL2VA）。历史值一律回落到 ref2v。
    _mode = str((body or {}).get("mode") or "").lower()
    if _mode not in ("ref2v", "fl2v"):
        _mode = "fl2v" if (body or {}).get("engine") == "h3fl2v" else "ref2v"
    if _mode == "fl2v":
        engine = "h3fl2v"
        # 首帧模式必须有画布确认过的首帧，否则当场拒绝（否则后台几分钟后才报错）
        if not st.get("kf"):
            raise HTTPException(status_code=400,
                                detail="首帧模式要先出首帧：在这一镜点「出首帧」，确认后再出视频")
        _unet, _lora = graphs._pick_h3_weights("fl2va")
        _miss = []
        if not _unet:
            _miss.append("缺 fl2va 权重：minimax_h3_fl2va_pruned_int8_convrot.safetensors → models/diffusion_models")
        if not _lora:
            _miss.append("缺 fl2v turbo LoRA：minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors → models/loras")
        if _miss:
            raise HTTPException(status_code=409, detail="模型没装齐：\n  - " + "\n  - ".join(_miss))
    else:
        engine = "h3ref"
        # 没参考图就当场拒绝：否则会排进后台、几分钟后才报错
        if not refs_mod.shot_refs(ep, shot):
            raise HTTPException(status_code=400,
                                detail="这一镜没有挂角色或场景，Ref2VA 至少需要一张参考图")
        # 权重/LoRA 不对也当场拒绝，别让用户等后台报错
        _unet, _lora = graphs._pick_h3_weights("ref2va")
        _miss = []
        if not _unet:
            _miss.append("缺 ref2va 权重：minimax_h3_ref2va_pruned_int8_convrot.safetensors → models/diffusion_models")
        if not _lora:
            _miss.append("缺 ref2v turbo LoRA：minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors → models/loras")
        if _miss:
            raise HTTPException(status_code=409,
                                detail="模型没装齐，跑出来参考图不生效：\n  - " + "\n  - ".join(_miss))
    count = max(1, min(3, int((body or {}).get("count") or 1)))
    # 调试：把前端传进来的秒数记下来
    try:
        with open(os.path.join(AGENT, "out", "video_seconds.log"), "a", encoding="utf-8") as _f:
            _f.write("%s POST %s/%s body.seconds=%r\n"
                     % (time.strftime("%H:%M:%S"), ep, sid, (body or {}).get("seconds")))
    except Exception:
        pass
    job_id = uuid.uuid4().hex[:8]
    JOBS[job_id] = {"id": job_id, "status": "queued", "ep": ep, "sid": sid,
                    "engine": engine, "started": time.time(), "count": count}
    # 优先拿整数帧（前端下拉给的就是 17k+5 的帧数），没有再用秒数
    _fr = int((body or {}).get("frames") or 0)
    _sec = (_fr / 24.0) if _fr else float((body or {}).get("seconds") or 0)
    threading.Thread(target=_job_video,
                     args=(job_id, ep, sid, engine, int(body.get("seed") or 0), count, _sec),
                     daemon=True).start()
    return {"ok": True, "job": job_id, "engine": engine}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="没有这个任务")
    out = dict(job)
    out["elapsed"] = round(time.time() - job.get("started", time.time()), 1)
    return out


@app.get("/api/comfy/progress")
def comfy_progress():
    """当前 ComfyUI 任务进度（采样步数 / 百分比 / 预估剩余）。"""
    return progress_mod.snapshot()


@app.get("/doc/{name}")
def get_doc(name: str):
    r"""帮助页：读 _agent\素材\学习材料\<name>.md 并渲染成简单 HTML。

    和 /skill 分开：skill 文件是给 agent 的流程约束，这里只放人看的写作参考。
    白名单 ASCII 文件名，避免路径穿越。
    """
    import re as _re
    if not _re.fullmatch(r"[a-z0-9\-]{1,60}", name or ""):
        raise HTTPException(status_code=400, detail="非法文档名")

    md = _md_to_html(_doc_body(name))
    html = ("<!doctype html><meta charset='utf-8'><title>" + name + "</title>"
            "<style>body{background:#0f1318;color:#d6dee8;font:15px/1.75 -apple-system,"
            "'Segoe UI',system-ui,'Microsoft YaHei',sans-serif;padding:26px 30px;max-width:1080px;margin:auto}"
            "h1{font-size:22px;border-bottom:1px solid #2b3542;padding-bottom:8px;margin:26px 0 14px}"
            "h2{font-size:18px;color:#8fd0ff;margin:22px 0 10px}"
            "h3{font-size:16px;color:#c9d6e3;margin:18px 0 8px}"
            "table{border-collapse:collapse;width:100%;margin:10px 0 16px;font-size:14px}"
            "th,td{border:1px solid #2b3542;padding:6px 9px;text-align:left;vertical-align:top}"
            "th{background:#18212b;color:#9fb3c8}"
            "code{background:#18212b;padding:1px 5px;border-radius:4px;font-size:13px}"
            "pre{background:#121a22;border:1px solid #2b3542;border-radius:8px;padding:12px 14px;"
            "white-space:pre-wrap;font:13px/1.6 ui-monospace,Consolas,monospace;color:#cfe0ef}"
            "blockquote{border-left:3px solid #2b3542;margin:10px 0;padding:4px 12px;color:#9fb3c8}"
            "hr{border:0;border-top:1px solid #2b3542;margin:22px 0}</style>"
            + md)
    from fastapi.responses import HTMLResponse
    return HTMLResponse(html)


def _doc_body(name: str) -> str:
    """按顺序找文档：素材\\学习材料 → docs（发布版用）。"""
    for d in (os.path.join(AGENT, "素材", "学习材料"), os.path.join(AGENT, "docs")):
        p = os.path.join(d, name + ".md")
        if os.path.isfile(p):
            return open(p, encoding="utf-8").read()
    raise HTTPException(status_code=404, detail=f"没有这份文档：{name}")


def _md_to_html(text: str) -> str:
    """极简 Markdown 渲染：标题 / 表格 / 代码块 / 引用 / 粗体 / 行内代码 / 分隔线。

    只求能读，不追求完整语法；无法识别的按段落原样输出（已转义）。
    """
    import html as _h
    import re as _re

    def inline(s: str) -> str:
        s = _h.escape(s, quote=False)
        s = _re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = _re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
        return s

    def slug(t: str) -> str:
        """标题 → 锚点 id：保留中文/字母/数字，其余压成单个连字符。

        有了它，画布里的「帮助文档 · 2.2」这类链接才能直接跳到那一节，
        而不是每次打开都停在文档顶部。
        """
        s = _re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", t).strip("-").lower()
        return s or "sec"

    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(_h.escape(lines[i], quote=False))
                i += 1
            i += 1
            out.append("<pre>" + "\n".join(buf) + "</pre>")
            continue
        if _re.match(r"^\|.*\|\s*$", ln) and i + 1 < len(lines) and _re.match(r"^\|[\s:\-|]+\|\s*$", lines[i + 1]):
            rows = []
            i += 2
            while i < len(lines) and _re.match(r"^\|.*\|\s*$", lines[i]):
                rows.append(lines[i])
                i += 1
            head = [c.strip() for c in ln.strip().strip("|").split("|")]
            parts = ["<table>", "<tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr>"]
            for r in rows:
                cells = [c.strip() for c in r.strip().strip("|").split("|")]
                parts.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells) + "</tr>")
            parts.append("</table>")
            out.append("".join(parts))
            continue
        if _re.match(r"^#{1,6}\s", ln):
            lvl = len(ln) - len(ln.lstrip("#"))
            title = ln[lvl:].strip()
            out.append(f'<h{min(lvl,3)} id="{slug(title)}">{inline(title)}</h{min(lvl,3)}>')
        elif ln.strip() == "---":
            out.append("<hr>")
        elif ln.startswith(">"):
            out.append("<blockquote>" + inline(ln.lstrip("> ").strip()) + "</blockquote>")
        elif ln.strip() == "":
            out.append("")
        elif ln.startswith("- ") or _re.match(r"^\d+\.\s", ln):
            out.append("<div>" + inline(ln) + "</div>")
        else:
            out.append("<p>" + inline(ln) + "</p>")
        i += 1
    return "\n".join(out)


@app.on_event("startup")
def _start_progress() -> None:
    progress_mod.start()


@app.get("/skill/{name}")
def get_skill(name: str):
    r"""把 _agent\skills\<name>\SKILL.md 直接展示出来（画布里点"提示词速查"用）。

    只允许白名单字符，避免路径穿越。
    """
    import re as _re
    if not _re.fullmatch(r"[a-z0-9\-]{1,40}", name or ""):
        raise HTTPException(status_code=400, detail="非法 skill 名")
    p = os.path.join(AGENT, "skills", name, "SKILL.md")
    if not os.path.isfile(p):
        raise HTTPException(status_code=404, detail=f"没有这个 skill：{name}")
    body = open(p, encoding="utf-8").read()
    html = ("<!doctype html><meta charset='utf-8'><title>" + name + "</title>"
            "<style>body{background:#0f1318;color:#d6dee8;font:14px/1.7 ui-monospace,Consolas,monospace;"
            "padding:28px 34px;max-width:900px;margin:auto}pre{white-space:pre-wrap}</style>"
            "<pre>" + body.replace("&", "&amp;").replace("<", "&lt;") + "</pre>")
    from fastapi.responses import HTMLResponse
    return HTMLResponse(html)


@app.get("/api/engines")
def get_engines():
    # 当前只开放一个模式：Ref2VA。其余引擎代码保留但不暴露，
    # 等这条链路能稳定产出成片后再放开。
    return [{"id": "h3ref", **engines.ENGINES["h3ref"]}]


@app.get("/api/cameras/{engine}")
def get_cameras(engine: str):
    """这个引擎能用的运镜：H3 官方封闭的 15 个指令。"""
    return [{"id": k, "zh": zh} for k, zh in engines.camera_options(engine)]


@app.post("/api/episodes")
def create_episode(body: dict):
    """新建空集：只有技术参数，不含任何角色/场景/镜头预设。"""
    raw = str((body or {}).get("id") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="给个集名，例如 EP03")
    # 目录名统一走 store.slug（EP03 / EP03_名字），和已有集保持一致的命名
    key = store.slug(raw)
    if not re.fullmatch(r"EP[A-Z0-9_]+", key):
        raise HTTPException(status_code=400,
                            detail="集名只能用英文、数字、下划线，例如 EP03 或 EP03_rain")
    if key in store.episodes():
        raise HTTPException(status_code=400, detail=f"{key} 已存在")
    try:
        fps = int((body or {}).get("fps") or 24)
    except (TypeError, ValueError):
        fps = 24
    if fps not in (24, 48):
        raise HTTPException(status_code=400, detail="帧率只支持 24 或 48")
    proj = store.create(key, (body or {}).get("title") or key, fps=fps)
    return {"ok": True, "episode": proj["episode"], "project": proj}


@app.get("/api/shot/{ep}/{sid}/refs")
def shot_refs_list(ep: str, sid: str):
    """这一镜的参考图顺序：每条对应一个 <Picture N>（顺序和提示词里完全一致）。"""
    import importlib
    refs_mod = importlib.import_module("core.refs")
    shot = store.shot(ep, sid)
    chars = store.characters(ep)
    scenes = {x.get("id"): x for x in store.read(ep, "scenes", {"scenes": []})["scenes"]}
    props = {x.get("id"): x for x in store.read(ep, "props", {"props": []})["props"]}
    owner = {}
    for cid, c in chars.items():
        if c.get("ref"):
            owner[c["ref"]] = cid
        for arr in (c.get("sheets") or {}).values():
            for it in arr or []:
                p = str(it.get("path") or "")
                if p:
                    owner[p] = cid
    for cid, x in scenes.items():
        if x.get("ref"):
            owner[x["ref"]] = cid
    for pid, x in props.items():
        if x.get("ref"):
            owner[x["ref"]] = pid
    items = [{"picture": i, "kind": x.get("kind"), "role": x.get("role") or "main",
              "id": owner.get(x.get("path"), ""), "name": x.get("name") or ""}
             for i, x in enumerate(refs_mod.shot_refs(ep, shot), start=1)]
    return {"shots": items}


@app.delete("/api/episodes/{ep}")
def delete_episode(ep: str):
    """删掉一整集：项目数据 + 画布 out 里属于它的片。ComfyUI 的原片不动。"""
    import shutil
    key = store.slug(ep)
    if key not in store.episodes():
        raise HTTPException(status_code=404, detail=f"没有 {key} 这一集")
    proj_dir = os.path.dirname(store.path(key, "project"))
    removed = []
    for d in (proj_dir,
              os.path.join(AGENT, "out", "单片", key),
              os.path.join(AGENT, "out", "成片", key)):
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
            removed.append(d)
    print(f"删除集 {key}：{len(removed)} 个目录", flush=True)
    return {"ok": True, "removed": removed, "left": store.episodes()}


@app.post("/api/scene/{ep}")
def create_scene(ep: str, body: dict):
    """新建空场景卡（id 可省略，自动 sec1 这种；内容由用户填或点「造空镜」）。"""
    data = store.read(ep, "scenes", {"scenes": []})
    sid = str((body or {}).get("id") or "").strip().lower()
    if sid:
        if not sid.replace("_", "").isalnum():
            raise HTTPException(status_code=400, detail="场景 id 只能用小写字母、数字、下划线")
        if any(s.get("id") == sid for s in data["scenes"]):
            raise HTTPException(status_code=400, detail=f"场景 {sid} 已存在")
    else:
        sid = _auto_card_id(data["scenes"], "sec")
    item = {"id": sid, "name": (body or {}).get("name") or sid, "label": "",
            "look": "", "light": "", "sheets": {}}
    data["scenes"].append(item)
    store.write(ep, "scenes", data)
    return {"ok": True, "scene": item}


@app.post("/api/prop/{ep}")
def create_prop(ep: str, body: dict):
    """新建空道具卡（一件道具一张参考图，用来锁住跨镜头的道具外观）。"""
    data = store.read(ep, "props", {"props": []})
    pid = str((body or {}).get("id") or "").strip().lower()
    if pid:
        if not pid.replace("_", "").isalnum():
            raise HTTPException(status_code=400, detail="道具 id 只能用小写字母、数字、下划线")
        if any(p.get("id") == pid for p in data["props"]):
            raise HTTPException(status_code=400, detail=f"道具 {pid} 已存在")
    else:
        pid = _auto_card_id(data["props"], "prop")
    item = {"id": pid, "name": (body or {}).get("name") or pid, "label": "", "ref": ""}
    data["props"].append(item)
    store.write(ep, "props", data)
    return {"ok": True, "prop": item}


@app.post("/api/shot/{ep}")
def create_shot(ep: str, body: dict):
    """新建空镜头：内容全空，只给默认技术参数。"""
    proj = store.read(ep, "project")
    sid = (body or {}).get("id") or store.next_id(ep)
    shots = store.shots(ep)
    if any(s.get("id") == sid for s in shots):
        raise HTTPException(status_code=400, detail=f"镜头 {sid} 已存在")
    item = {
        "id": sid, "act": "", "seconds": 6, "link": False,
        "characters": [], "scenes": [], "beats": [],
        "image": {"shot": "", "scene": "", "subject": "", "action": "", "light": "", "tail": "",
                  "size": "", "angle": "", "lens": "", "light_key": "", "depth": "", "tone": ""},
        "video": {"shot": "", "scene": "", "action": "", "character": "", "camera": "", "audio": "",
                  "music": "", "move": "", "structured": True},
        "style": None, "engine": None, "state": {},
    }
    shots.append(item)
    store.save_shots(ep, shots)
    return {"ok": True, "shot": item}


@app.get("/api/file")
def file(path: str):
    real = _safe(path)
    media = "video/mp4" if real.lower().endswith(".mp4") else None
    return FileResponse(real, media_type=media)


# ---------------------------------------------------------------- 素材生成（和出片分开）
# 用户 要求：生图和出片拆成两条路。顶栏三个按钮各管一种素材。
# 默认画风：角色 / 道具 = 写实 CG，背景 = 写实照片；起弹窗里可下拉换，
# 下面 GEN_KINDS 里的 style 只是**默认值**，请求里带 style 就以请求为准。
GEN_KINDS = {
    "character": {
        "style": "semireal",          # 默认：写实 CG（PBR 材质、体积光、清晰轮廓）
        # 尺寸不在这里写：按项目方向走 _project_size()（竖屏 1088×1920 / 横屏 1920×1088）。
        # 以前这里写死 832×1248，选了竖屏也没用。
        # 尾巴只写构图/背景，**不写介质词**：介质由画风行给（style 句排在最前面）。
        # 以前这里写 "character sheet"，选「写实照片」时会被这个词往概念图方向拉。
        "tail": ("Full body shot from head to feet, standing, facing the camera, "
                 "simple solid light grey background, soft even studio lighting, "
                 "clear silhouette, no text, no logos, no watermark."),
        "label": "角色",
    },
    "background": {
        "style": "photoreal",         # 默认：写实照片（35mm、自然光）
        # 尺寸同样走 _project_size()：以前写死 1152×768，所以不管选什么都是横图。
        # 同样不放 35mm / film grain —— 那是 photoreal 画风行负责的，选别的画风时不打架
        "tail": ("Empty scene, no people, no characters, no text, no watermark, natural light."),
        "label": "背景",
    },
    # 道具卡：一件道具一张，方形产品图。用途见 _agent\调研_健身房四问题.md 问题 4——
    # 跨镜头同一道具靠一张固定参考图 + <Subject N> defined by <Picture N> 锁住。
    "prop": {
        "style": "semireal",          # 默认和角色卡同画风，避免道具比人更写实
        # 尺寸跟项目走（原先固定 1024×1024 方图，与另两种素材不一致）。
        "tail": ("Exactly one object centered on a seamless light grey studio background, "
                 "the whole object in frame with margin around it, soft even studio lighting "
                 "from the front left, clear silhouette, sharp detail on material and surface "
                 "finish, no hands, no people, no text, no logos, no watermark."),
        "label": "道具",
    },
}


def _has_lora(name: str) -> bool:
    """ComfyUI 的 lora 清单里有没有这个文件。查不到就当没有，别让用户提交后才看到报错。"""
    try:
        info = comfy.object_info("LoraLoaderModelOnly")
        return name in (info["LoraLoaderModelOnly"]["input"]["required"]["lora_name"][0] or [])
    except Exception:  # noqa: BLE001 - 离线/接口异常都按"没有"处理
        return False


@app.get("/api/gen/info")
def gen_info():
    """素材生成面板要显示的东西：每个 kind 的默认画风 + 可选画风清单。

    画风可在弹窗里下拉改；改完的选择随 /api/gen/{kind} 发回来。
    尺寸不再按 kind 区分（原先角色竖、场景横、道具方），统一跟项目方向走，
    所以这里不再返回 size —— 三张素材必须同尺寸，否则同框比例对不上。
    """
    kinds = [{"kind": k, "label": v["label"], "style": v["style"],
              "style_zh": prompts.style_label(v["style"])} for k, v in GEN_KINDS.items()]
    return {"kinds": kinds, "styles": prompts.style_options()}


@app.post("/api/gen/{kind}")
def gen_asset(kind: str, body: dict):
    """单独生成一张素材图，不碰集/镜头/出片。返回 png 路径。"""
    meta = GEN_KINDS.get(kind)
    if not meta:
        raise HTTPException(status_code=404, detail="只支持 character / background / prop")
    text = str((body or {}).get("text") or "").strip()
    if len(text) < 2:
        raise HTTPException(status_code=400, detail="先把要生成的内容写进输入框")
    style = str((body or {}).get("style") or "").strip() or meta["style"]
    if style not in prompts.style_names():
        raise HTTPException(status_code=400, detail=f"没有这个画风：{style}")
    # 尺寸跟项目走：同一集里的角色 / 场景 / 道具必须同尺寸，
    # 否则挂进同一镜时构图比例对不上（以前各写死一套，场景永远是横的）。
    ep = str((body or {}).get("ep") or "").strip()
    if not ep:
        _eps = store.episodes()
        if not _eps:
            raise HTTPException(status_code=400, detail="先建一个集，素材要有项目才能定尺寸")
        ep = _eps[0]
    w, h = _project_size(ep)
    # 画风句放**最前面**。Krea2 官方 prompting guide 说得很直白：这个模型是探索型的，
    # 光给主体它会同时给出照片 / 插画 / 3D；加一个风格提示才会收窄。风格词越靠前越能锁介质，
    # 否则用户选了「写实照片」也可能拿到一张动画片。
    prompt = " ".join([prompts.render_text(style), _sentence(text), meta["tail"]])
    seed = int((body or {}).get("seed") or 0) or int(time.time()) % 1_000_000_007
    if (body or {}).get("mode") == "sheet":
        # 四视角参考表（脸特写 + 正 + 侧 + 背）：一条图跑完，前半段文生图出正面图，
        # 后半段拿它当 source_latent 出四格，中间图不落盘。
        # 四格是一笔画出来的，衣服/污渍/配件在四个视角天然一致。
        if not _has_lora(multiview.QUADVIEW_LORA):
            raise HTTPException(
                status_code=400,
                detail="缺四视角 LoRA：QuadView_krea2_v1.safetensors → models\\loras（见 README 第 7 步）")
        sheet_prompt = f"{_sentence(text)} {multiview.QUADVIEW_TRIGGER}"
        graph = multiview.build_quadview_from_text(
            prompt, sheet_prompt, seed=seed, width=w, height=h,
            prefix=f"canvas/sheet/{store.slug(ep)}")
    else:
        graph = graphs.krea2(prompt, seed=seed, prefix=f"canvas/gen/{kind}",
                             width=w, height=h)
    name = f"素材{meta['label']}"
    pid = comfy.submit(graph, name)
    hist = comfy.wait(pid, name, timeout=1800)
    files = comfy.produced(hist, ("images",))
    if not files:
        raise HTTPException(status_code=500, detail="没出图（看 ComfyUI 控制台）")
    src = comfy.local_path(files[-1])
    # 四视角表固定 1536x1024（LoRA 的版式尺寸），和项目横竖屏无关；其余素材按项目尺寸走。
    out_size = [1536, 1024] if (body or {}).get("mode") == "sheet" else [w, h]
    return {"ok": True, "kind": kind, "path": src,
            "url": "/api/file?path=" + quote(src), "prompt": prompt,
            "seed": seed, "size": out_size, "style": style,
            "style_zh": prompts.style_label(style)}


@app.post("/api/adopt-gen")   # 注意：不能叫 /api/gen/adopt——会被上面 /api/gen/{kind} 抢先匹配成 kind=adopt
def gen_adopt(body: dict):
    """把生成的那张图挂成角色卡 / 场景卡 / 道具卡的**主参考**。

    满意的直接加进画布，不用手动去挑文件。
    入口合并到左侧「新建」——前端带名字过来，id 由服务端排；
                 带 reuse=true + id 时表示"同一个卡再生成一张"，只更新主参考、
                 **不再新建第二张卡**。
    """
    kind = str((body or {}).get("kind") or "character")
    src = _safe(str((body or {}).get("path") or ""))
    if not os.path.isfile(src):
        raise HTTPException(status_code=400, detail="这张图不在了，重新生成一次")
    ep = str((body or {}).get("ep") or "").strip()
    if not ep:
        raise HTTPException(status_code=400, detail="缺集号")
    name = str((body or {}).get("name") or "").strip()
    folder = _material_dir(ep, {"character": "char", "scene": "scene",
                                "prop": "prop"}.get(kind, "char"))

    _doc, prefix = {"character": ("characters", "char"), "scene": ("scenes", "sec"),
                    "prop": ("props", "prop")}.get(kind, ("scenes", "sec"))
    data = store.read(ep, _doc, {_doc: []})
    cards = data[_doc]
    ids = {c.get("id") for c in cards}

    want = re.sub(r"[^a-z0-9_]+", "_",
                  str((body or {}).get("id") or "").strip().lower()).strip("_")[:32]
    reuse = bool((body or {}).get("reuse")) and want in ids
    if reuse:
        cid = want
    else:
        slug = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")[:24]
        # 中文名会被整段剥掉，只剩里面的数字：「角色1」-> "1"、「第2个」-> "2"。
        # 纯数字当 id 既没意义又和编号冲突，这种情况按"没有可用 slug"处理，回退 char1/char2。
        if slug.isdigit() or len(slug) < 2:
            slug = ""
        base = want or slug
        if base:
            cid, n = base, 2
            while cid in ids:
                cid, n = f"{base}_{n}", n + 1
        else:
            # 中文名字 slug 出来是空：退回 char1 / char2 这种编号
            n = 1
            while f"{prefix}{n}" in ids:
                n += 1
            cid = f"{prefix}{n}"

    dst = os.path.join(folder, f"{cid}.png")
    shutil.copyfile(src, dst)
    prompt_used = str((body or {}).get("prompt") or "")
    seed = int((body or {}).get("seed") or 0)
    # 画风也存下来：卡片面板要能显示「这张图是用哪个画风生成的」，
    # 不然新建弹窗里有画风、点进卡片却找不到，用户会以为自己选丢了。
    style_used = str((body or {}).get("style") or "").strip()
    # 「外形锚点」：前端把生成时写的描述一起带过来 ——
    # 让出片时的 subject_definitions 和生成这张图用的是同一份描述，不至于两张皮。
    # 只填 look 一个字段：服装/道具没法从一句话里可靠拆开，留给人手改。
    look_in = str((body or {}).get("look") or "").strip()
    sheet = {"path": dst, "label": "生成"}

    cur = next((c for c in cards if c.get("id") == cid), None)
    if cur is not None:
        cur["ref"] = dst
        cur["prompt_used"] = prompt_used
        cur["seed"] = seed
        if style_used:
            cur["style"] = style_used
        if name:
            cur["name"] = name
        # 只在原来是空的时候补，别覆盖用户手改过的锚点
        if look_in and kind != "prop" and not str(cur.get("look") or "").strip():
            cur["look"] = look_in
        if kind != "prop":
            cur.setdefault("sheets", {}).setdefault("turnaround", []).append(sheet)
    else:
        card = {"id": cid, "name": name or cid, "label": "", "ref": dst,
                "prompt_used": prompt_used, "seed": seed}
        if style_used:
            card["style"] = style_used
        if kind == "prop":
            cards.append(card)          # 道具只有一张产品图，没有多角度组
        else:
            card["look"] = look_in
            card["sheets"] = {"turnaround": [sheet]}
            if kind == "character":
                card["outfit"] = ""
                card["props"] = ""
            else:
                card["light"] = ""
                card["outfit"] = ""
            cards.append(card)

    store.write(ep, _doc, data)
    return {"ok": True, "id": cid, "path": dst, "kind": kind,
            "updated": cur is not None}


def _steps() -> list[dict]:
    import json
    with open(os.path.join(AGENT, "steps", "steps.json"), encoding="utf-8") as f:
        return json.load(f)["steps"]


app.mount("/", StaticFiles(directory=os.path.join(HERE, "web"), html=True), name="web")


def main() -> int:
    import uvicorn
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    print(f"{APP_NAME} → http://{a.host}:{a.port}", flush=True)
    print(f"来源 {APP_REPO} · 版本 {_app_version() or '-'}", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
