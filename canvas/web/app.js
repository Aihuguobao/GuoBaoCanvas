'use strict'

const S = {
  ep: '',
  data: null,          // {project, shots, characters, scenes, steps, styles}
  view: { x: 0, y: 0, z: 1 },
  pos: {},             // key -> {x,y}  已保存的坐标
  sel: new Set(),
  layout: {},          // key -> {x,y}  默认布局
  size: {},
  els: new Map(),      // key -> element
  pad: true,           // 多角度输出是否统一排版成竖版（D 方案）
  genStatus: '',
  dirty: false,
}

const SIZES = {
  char: { w: 150, h: 186 },
  scene: { w: 150, h: 186 },
  shot: { w: 300, h: 206 },
  kf: { w: 190, h: 268 },
  vid: { w: 220, h: 176 },
  vidFold: { w: 220, h: 64 },
}

// 镜头网格：一列最多 5 个，超出往右开新列（2026-11-05 用户要求）
// 成片节点紧贴在镜头卡右侧（差 VID_DX），所以列宽 = VID_DX + 成片宽 + 列间距
const PER_COL = 5
const VID_DX = 330
const COL_W = VID_DX + 220 + 50

const $ = (id) => document.getElementById(id)

// 前端报错必须看得见：控制台里的红字用户不会去看
function showFatal(msg) {
  let el = document.getElementById('jsError')
  if (!el) {
    el = document.createElement('div')
    el.id = 'jsError'
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      'background:#7a1f1f;color:#fff;font:12px/1.5 monospace;padding:6px 10px;' +
      'white-space:pre-wrap;max-height:30vh;overflow:auto'
    document.body.appendChild(el)
  }
  el.textContent = '⚠ 前端报错：' + msg
  console.error(msg)
}
window.addEventListener('error', (e) => showFatal(e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno))
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e.reason && e.reason.message ? e.reason.message : e.reason)
  // 视频播放被打断（卡片重渲染时会 pause）属于浏览器正常噪音，不是 bug
  if (/play\(\) request was interrupted|AbortError/i.test(msg)) return
  showFatal('Promise: ' + msg)
})
const viewport = $('viewport')
const world = $('world')
const nodesEl = $('nodes')
const edgesEl = $('edges')
const insp = $('inspector')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const fpath = (p) => '/api/file?path=' + encodeURIComponent(p)

// 有新提交就提示一次（只提示，不自动改代码）。关掉之后同一版本不再弹。
async function checkUpdate() {
  try {
    const r = await api('/api/version')
    if (!r.newer) return
    const key = 'updSkip_' + (r.remote || '')
    if (localStorage.getItem(key)) return
    $('updText').textContent = `有新版本可用：本机 ${r.version} → 仓库 ${r.remote}`
    $('updBar').classList.remove('hidden')
    $('updClose').onclick = () => {
      $('updBar').classList.add('hidden')
      localStorage.setItem(key, '1')
    }
  } catch (e) { /* 网络不通就不提示 */ }
}
checkUpdate()
// 视频/封面会被同名文件覆盖（latest.mp4），URL 不变浏览器就复用旧缓存。
// 加时间戳强制换 URL —— 图片那边一直这么干，视频标签漏了。
const fpathLive = (p) => fpath(p) + '&t=' + Date.now()

async function api(url, opt) {
  const r = await fetch(url, opt)
  if (!r.ok) {
    // 服务端返回的是 {"detail": "..."}，要把 detail 原样抛出来，
    // 不然界面上只剩一个 "409 Conflict"，用户不知道哪一步不对
    let msg = ''
    const raw = await r.text()
    try {
      const j = JSON.parse(raw)
      msg = typeof j.detail === 'string' ? j.detail : (j.detail ? JSON.stringify(j.detail) : raw)
    } catch (e) {
      msg = raw
    }
    const err = new Error(msg || `HTTP ${r.status}`)
    err.status = r.status
    throw err
  }
  return r.json()
}

// ---------------------------------------------------------------- 启动
// 进页面先体检：配置有问题就把「设置」直接弹出来，别等点「生成角色」才报错。
// 判据只认**设置能修的那几项**：没有 ComfyUI 目录 / 缺必需权重 / 缺必需节点。
// ComfyUI 没开不算阻塞（那是去启动 8188，不是改设置），只挂一条提示。
async function preflightEnv() {
  let r
  try {
    r = await api('/api/env/check')
  } catch (e) {
    return                     // 体检接口自己挂了，不该把画布挡在门外
  }
  S.env = r
  const missReq = (r.nodes || []).filter((n) => n.required && !n.found && !n.unknown)
  // 用后端算好的 models_missing（已经排除可选权重），不要在前端拿 models[] 自己再过滤一遍：
  // 那样可选权重缺了也会被当成阻塞，验证时就是这样误弹的。
  // 注意也不能把 root_note 当故障 —— 「你选的是外壳目录，已自动纠正到 …\ComfyUI」也是 note 非空，
  // 失败时 root 一定是空的，所以只判 root 本身。
  const blocking = !r.root || (r.models_missing || 0) > 0 || missReq.length > 0
  if (!blocking) {
    if (!r.online) toast('ComfyUI 没启动（8188 连不上），出片前先开它', true)
    return
  }
  await openSettings()
  renderEnvReport(r)
  $('envStatus').textContent = '进页面前的体检没过：' + (r.hint || '')
}

// Qwen-Image-Edit 那套模型装了没。
// 依赖它的只有三处：卡片里的「生成多角度」「生成组」，以及场景卡的「把主参考里的人去掉」。
// 没装就把这些按钮隐掉 —— 让用户点下去再报缺模型，等于把 ComfyUI 的内部细节甩给他。
// 清单以后端为准（server.py 的 OPTIONAL_MODELS → 体检返回 models_optional_missing），
// 前端不再另抄一份 key 列表，否则两边迟早对不上。
// 体检没跑到（S.env 为空、比如接口挂了）时返回 true：宁可多显示，也别凭空藏掉功能。
function qwenEditReady() {
  if (!S.env) return true
  return !((S.env.models_optional_missing) || []).length
}

// 显存（GB）。从 ComfyUI /system_stats 拿；拿不到返回 0 = 未知，一切按"不拦"处理。
function vramGb() {
  const v = S.env && S.env.vram && S.env.vram.total_gb
  return Number(v) || 0
}

// 「用首帧出片」（FL2VA）没有低显存档版本：只有 int8 主模型 19.53 GB，
// 显存不到 12 GB 基本带不动，硬跑就是 OOM。低于这个数就把它禁掉。
const VRAM_FL2V_MIN = 12
function fl2vBlocked() {
  const v = vramGb()
  return v > 0 && v < VRAM_FL2V_MIN
}

// 显存不够时把这一集自动切到低显存档（W4A8），省得用户去右侧下拉里找。
// 只动 project.model_tier 一个字段；切不动就算了，不拿这个挡人。
async function autoTierIfLowVram() {
  const v = vramGb()
  if (!v || v >= VRAM_FL2V_MIN) return
  const proj = (S.data && S.data.project) || {}
  if (String(proj.model_tier || 'default') === 'w4a8') return
  try {
    await api('/api/project/' + S.ep, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_tier: 'w4a8' }),
    })
    proj.model_tier = 'w4a8'
    S.data.project = proj
    toast(`显存 ${v} GB：这一集的出片档位已自动切到低显存档（W4A8）`)
  } catch (e) {
    /* 切不动不改状态，也不弹错 */
  }
}

async function boot() {
  setTimeout(fitMainHeight, 0)
  await preflightEnv()
  const eps = await api('/api/episodes')
  try { S.vocab = await api('/api/vocab') } catch (e) { S.vocab = null }
  try { S.styles = await api('/api/styles') } catch (e) { S.styles = [] }
  try { S.engines = await api('/api/engines') } catch (e) { S.engines = [] }
  S.cameras = {}
  for (const id of ['h3ref']) {
    try { S.cameras[id] = await api('/api/cameras/' + id) } catch (e) { S.cameras[id] = [] }
  }
  const sel = $('epSelect')
  sel.innerHTML = eps.map((e) => `<option value="${e.episode}">${esc(e.episode)} · ${esc(e.title)}</option>`).join('')
  // 没有集的时候不留一个空下拉框：options 为空时它只剩个空壳，看着像坏控件
  sel.style.display = eps.length ? '' : 'none'
  if (!eps.length) {
    // 空画布的空状态。注意两点：
    //  1) 不能用 document.body.innerHTML 整个覆盖 —— 会连顶栏和刚弹出的「设置」一起抹掉
    //     （旧写法就是这个后果：页面上只剩左上角一行字，看起来像画布坏了）。
    //  2) 放在 #viewport 里，占满画布区域居中显示，而不是挂在 body 尾巴上。
    const box = document.createElement('div')
    box.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:14px;text-align:center'
    box.innerHTML = '<div style="font-size:20px">还没有项目</div>'
      + '<div style="font-size:13px;opacity:.7">「集」就是一部短剧，里面放角色、场景和镜头</div>'
      + '<button class="primary" id="emptyNewEp" style="padding:9px 20px;font-size:14px">新建第一集</button>'
    const vp = $('viewport')
    ;(vp || document.body).appendChild(box)
    const go = $('emptyNewEp')
    if (go) go.onclick = () => $('newEpBtn').click()
    return
  }
  const want = new URLSearchParams(location.search).get('ep')
  S.ep = (want && eps.some((e) => e.episode === want)) ? want : eps[0].episode
  sel.value = S.ep
  sel.onchange = () => { S.ep = sel.value; load() }
  await load()
}

// 新建空集：不预置任何角色/场景
$('newEpBtn').onclick = async () => {
  // 后端 slug() 的规则：以 ep 开头就转大写，没有前缀就补 EP。所以 "ep03" 和 "03" 都得到 EP03，
  // 前端这里再 toUpperCase() 兜一层。提示语要说清这件事，别写「小写字母/数字」却举个 EP03。
  const id = (prompt('新集编号，例如 EP03 或 03（字母会自动转成大写）') || '').trim().toUpperCase()
  if (!id) return
  const title = (prompt('这集的标题（可空）') || '').trim() || id
  const fps = confirm('这一集的出片帧率：\n\n'
    + '【确定】48fps —— 每镜出片后自动补帧（纯 CPU，5 秒片约 35 秒）\n'
    + '【取消】24fps —— 原速，不补帧\n\n'
    + '建完就定死，这一集里所有镜头都按这个帧率。')
    ? 48 : 24
  try {
    const r = await api('/api/episodes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, fps }),
    })
    // 服务端会把集名规整成 EPxx，跳转用它返回的那个
    location.href = `?ep=${encodeURIComponent(r.episode)}`
  } catch (e) {
    alert('新建失败：' + e.message)
  }
}

// 新建空镜头
$('newShotBtn').onclick = async () => {
  try {
    const r = await api(`/api/shot/${S.ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    // 新镜头接在最后一列后面：一列满 5 个就往右开新列（2026-11-05 用户要求）
    const key = 'shot:' + r.shot.id
    const shotH = (SIZES.shot && SIZES.shot.h) || 206
    const COL_X = 420
    const GAP_Y = 40
    const n = (S.data.shots || []).length
    const col = Math.floor(n / PER_COL)
    const row = n % PER_COL
    S.pos[key] = { x: COL_X + col * COL_W, y: 20 + row * (shotH + GAP_Y) }
    await load()
    S.sel.clear(); S.sel.add(key); refreshSel()
    // 位置立刻落盘，刷新后不会跳回默认网格
    if (S.pos[key]) {
      api(`/api/project/${S.ep}/canvas`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewport: S.view, nodes: S.pos }),
      }).catch(() => {})
    }
  } catch (e) {
    alert('新建镜头失败：' + e.message)
  }
}

async function load() {
  S.data = await api('/api/project/' + S.ep)
  S.pos = (S.data.project.canvas && S.data.project.canvas.nodes) || {}
  const vp = (S.data.project.canvas && S.data.project.canvas.viewport) || null
  S.sel.clear()
  buildSizesAndLayout()
  render()
  // 视口不持久化：每次打开按节点重新适配，避免一个旧视口把你锁在空白处
  requestAnimationFrame(fit)
  renderAssets()
  renderStats()
  renderInspector()

  // 深链接：?sel=char:char1 打开就定位到这个节点
  const want = new URLSearchParams(location.search).get('sel')
  if (want && S.layout[want]) {
    S.sel.clear()
    S.sel.add(want)
    refreshSel()
    requestAnimationFrame(() => focusOn(want))
  }
  if (new URLSearchParams(location.search).get('set')) $('setBtn').onclick()
  await autoTierIfLowVram()          // 换集 / 刷新后同样按显存把档位摆平
}

function buildSizesAndLayout() {
  S.layout = {}
  S.size = {}
  const { characters, scenes, shots } = S.data
  const charX = 40, sceneX = 40, shotX = 420, vidX = shotX + VID_DX
  characters.forEach((c, i) => {
    const k = 'char:' + c.id
    S.layout[k] = { x: charX, y: 60 + i * 210 }
    S.size[k] = SIZES.char
  })
  const sceneTop = 60 + characters.length * 210 + 40
  scenes.forEach((s, i) => {
    const k = 'scene:' + s.id
    S.layout[k] = { x: sceneX, y: sceneTop + i * 210 }
    S.size[k] = SIZES.scene
  })
  // 一列最多 5 个镜头，超出往右开新列（2026-11-05 用户要求：镜头多了别一直往下排）
  shots.forEach((s, i) => {
    const col = Math.floor(i / PER_COL)
    const row = i % PER_COL
    const x = shotX + col * COL_W
    const y = 60 + row * 300
    const ks = 'shot:' + s.id
    S.layout[ks] = { x, y }
    S.size[ks] = SIZES.shot
    // 每条成片一个节点；收起的只占一条窄条，位置按累计高度往下排
    let cursor = y
    videoRuns(s).forEach((r, j) => {
      const k = 'vid:' + s.id + '#' + j
      const collapsed = vidFolded(r.path)
      // 成片节点跟着自己那一列的镜头一起右移，不会跑到别的列上
      S.layout[k] = { x: x + (vidX - shotX), y: cursor }
      S.size[k] = collapsed ? SIZES.vidFold : SIZES.vid
      cursor += S.size[k].h + 14
    })
  })
}

const posOf = (k) => S.pos[k] || S.layout[k] || { x: 0, y: 0 }

// 逐条视频的收起状态（按文件路径记，只影响显示，不删数据）
const VFOLD_KEY = () => 'dsh.canvas.vidfold:' + (S.ep || '')
function vidFoldSet() {
  if (!S._vidFold) {
    try { S._vidFold = new Set(JSON.parse(localStorage.getItem(VFOLD_KEY()) || '[]')) }
    catch (e) { S._vidFold = new Set() }
  }
  return S._vidFold
}
function vidFolded(path) { return vidFoldSet().has(path) }
function setVidFolded(path, on) {
  const set = vidFoldSet()
  if (on) set.add(path); else set.delete(path)
  localStorage.setItem(VFOLD_KEY(), JSON.stringify([...set]))
}

// ---------------------------------------------------------------- 渲染
function render() {
  nodesEl.innerHTML = ''
  S.els.clear()
  const { shots, characters, scenes } = S.data

  characters.forEach((c) => addNode('char:' + c.id, charNode(c)))
  scenes.forEach((s) => addNode('scene:' + s.id, sceneNode(s)))
  shots.forEach((s) => {
    // 成片已经嵌在镜头卡片里，不再单独建 vid 节点（2026-11-04 用户要求：排版别乱）
    addNode('shot:' + s.id, shotNode(s))
  })
  drawEdges()
}

function addNode(key, html) {
  const p = posOf(key)
  const d = document.createElement('div')
  d.className = 'node' + (S.sel.has(key) ? ' sel' : '')
  d.dataset.key = key
  d.style.left = p.x + 'px'
  d.style.top = p.y + 'px'
  d.style.width = (S.size[key] || SIZES.vid).w + 'px'
  d.innerHTML = html
  nodesEl.appendChild(d)
  S.els.set(key, d)
}

function entityNode(kind, o, label, sub) {
  const groups = kind === 'char' ? SHEET_GROUPS.char : SHEET_GROUPS.scene
  const count = groups.reduce((n, [g]) => n + ((o.sheets && o.sheets[g]) ? o.sheets[g].length : 0), 0)
  const img = o.ref
    ? `<img draggable="false" class="thumb" src="${fpath(o.ref)}" style="height:160px;object-fit:contain">`
    : `<div class="thumb" style="height:96px;background:#10151b;display:flex;align-items:center;justify-content:center;color:#5a2f2f;font-size:11px">缺主参考</div>`
  return `<div class="head"><span class="dot ${o.ref ? 'ok' : ''}"></span>${label} · 设定集 ${count}</div>
    <div class="body">${img}
      <div class="title" style="margin-top:6px">${esc(o.name || o.id)}</div>
      <div class="meta">${esc((sub || '').slice(0, 34))}</div></div>`
}

function charNode(c) { return entityNode('char', c, '角色', c.look) }
function sceneNode(s) { return entityNode('scene', s, '场景', s.light) }

// 一镜的所有成片：一次跑多条时，画布上每条一个节点，可点选母版
function videoRuns(s) {
  const st = s.state || {}
  const runs = st.video_runs || []
  const chosen = st.chosen_video || ''
  if (runs.length) {
    return runs.map((r, i) => ({
      path: r.path,
      seed: r.seed,
      poster: r.poster || '',
      master: chosen ? r.path === chosen : i === runs.length - 1,
    }))
  }
  if (st.video) return [{ path: st.video, seed: st.video_seed, master: true }]
  return []
}

function shotNode(s) {
  const st = s.state || {}
  const runs = videoRuns(s)
  const dot = runs.length ? 'ok' : ((s.video || {}).summary ? 'pending' : '')
  const beats = (s.beats || []).length
  const cfgLink = String((s.video || {}).link || 'none')
  const recLink = String((s.state || {}).video_link || '')
  const lk = recLink || (runs.length ? '' : cfgLink)
  // 四种衔接方式各写各的，别再把「硬切 / 只打底」都显示成黑场
  const lkZh = ({ none: '硬切', black: '黑场', latent: '接续', latent_head: '只打底' })[lk] || ''
  // 成片直接放进镜头卡片里（2026-11-04 用户要求：视频别单独飘一个框，排版乱）
  const master = runs.find((r) => r.master) || runs[runs.length - 1]
  let vidBox = ''
  if (master) {
    const folded = vidFolded(master.path)
    const others = runs.length > 1 ? ` · 共 ${runs.length} 条` : ''
    const btns = `${master.master ? '<span class="badge master">母版</span>'
      : `<button class="pick" data-pick="${esc(master.path)}">用这条</button>`}
      <button class="pick" data-${folded ? 'vunfold' : 'vfold'}="${esc(master.path)}">${folded ? '展开' : '收起'}</button>`
    const thumb = folded
      ? '<div class="meta" style="padding:4px 0">已收起</div>'
      : `<video class="thumb" src="${fpathLive(master.path)}"${master.poster ? ` poster="${fpathLive(master.poster)}"` : ''}
           muted loop preload="metadata" onmouseenter="try{this.play().catch(()=>{})}catch(_){}" onmouseleave="try{this.pause()}catch(_){}"></video>`
    vidBox = `<div style="margin-top:8px;border-top:1px solid #222c38;padding-top:6px">
      <div class="meta" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
        <span class="badge">seed ${esc(String(master.seed || ''))}</span>${others}${btns}</div>
      ${thumb}</div>`
  }
  return `<div class="head"><span class="dot ${dot}"></span>${esc(s.id)} · ${esc(s.act || '')}</div>
    <div class="body">
      <div class="title">${esc(((s.video || {}).summary || (s.video || {}).action || '').slice(0, 40) || '（未写摘要）')}</div>
      <div class="meta" style="margin-top:6px">
        <span class="badge">${s.seconds || 6}s</span>
        <span class="badge">${beats} 拍</span>
        ${lkZh ? `<span class="badge master">${lkZh}</span>` : ''}
        <span class="badge">${runs.length ? runs.length + ' 条成片' : '缺视频'}</span>
        ${(() => {
          // 母版是不是补过帧的：状态里记着 interpolated_from，或者文件名带 _48fps
          const cur = String((s.state || {}).chosen_video || (s.state || {}).video || '')
          const from = String((s.state || {}).interpolated_from || '')
          if (!cur || !(/_48fps\b/i.test(cur) || from)) return ''
          if (from && cur !== from && !/_48fps\b/i.test(cur)) return ''
          return `<span class="badge interp" title="母版是补帧版：${esc(cur.split(/[\\/]/).pop())}（原片在成片列表里）">已补帧</span>`
        })()}
      </div>
      ${vidBox}
    </div>`
}

function vidNode(s, run, idx) {
  const p = run.path
  const seed = run.seed || ''
  const folded = vidFolded(p)
  const master = run.master ? '<span class="badge master">母版</span>' : ''
  const pick = run.master
    ? ''
    : `<button class="pick" data-pick="${esc(p)}">用这条</button>`
  const foldBtn = folded
    ? `<button class="pick" data-vunfold="${esc(p)}">展开</button>`
    : `<button class="pick" data-vfold="${esc(p)}">收起</button>`
  const head = `<div class="head"><span class="dot ${run.master ? 'ok' : ''}"></span>视频 ${idx + 1}
      <span class="badge">${esc(String(seed))}</span>${master}${pick}${foldBtn}</div>`
  if (folded) {
    return head + '<div class="body" style="padding:6px"><div class="meta">已收起</div></div>'
  }
  const cover = run.poster ? ` poster="${fpath(run.poster)}"` : ''
  return head + `<div class="body" style="padding:6px"><video class="thumb" src="${fpathLive(p)}"${cover} muted loop preload="metadata"
      onmouseenter="try{this.play().catch(()=>{})}catch(_){}" onmouseleave="try{this.pause()}catch(_){}"></video></div>`
}

// 收起状态下的占位节点：不删数据，只压缩显示
function drawEdges() {
  const { shots } = S.data
  const segs = []
  const rect = (k) => {
    const p = posOf(k), s = S.size[k]
    return p && s ? { x: p.x, y: p.y, w: s.w, h: s.h } : null
  }
  const link = (a, b) => {
    const ra = rect(a), rb = rect(b)
    if (!ra || !rb) return
    const x1 = ra.x + ra.w, y1 = ra.y + ra.h / 2
    const x2 = rb.x, y2 = rb.y + rb.h / 2
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.45)
    segs.push(`<path class="flow" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`)
  }
  // 虚线 + 文字标签（用于镜头衔接）
  const linkDash = (a, b, label) => {
    const ra = rect(a), rb = rect(b)
    if (!ra || !rb) return
    const x1 = ra.x + ra.w, y1 = ra.y + ra.h / 2
    const x2 = rb.x, y2 = rb.y + rb.h / 2
    const dx = Math.max(50, Math.abs(x2 - x1) * 0.45)
    segs.push(`<path class="flow dash" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`)
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 6
    segs.push(`<text class="edgelabel" x="${mx}" y="${my}">${label}</text>`)
  }

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]
    const chars = Array.isArray(s.characters) ? s.characters : []
    const scns = Array.isArray(s.scenes) ? s.scenes : []
    try {
      for (const id of chars) link('char:' + id, 'shot:' + s.id)
      for (const id of scns) link('scene:' + id, 'shot:' + s.id)
      const runs = videoRuns(s)
      // 视频节点已并入镜头卡片，不再画这条连线
      // 镜头衔接：镜头 → 镜头，虚线 + 方式标签（母版视频节点自身高亮）
      const lk = String((s.video || {}).link || 'none')
      if (lk !== 'none' && i > 0) {
        const prev = shots[i - 1]
        linkDash('shot:' + prev.id, 'shot:' + s.id,
                 lk === 'frame' ? '钉末帧'
                   : (lk === 'video' ? '参考视频' : '钉帧+参考'))
      }
    } catch (err) {
      throw new Error(`drawEdges 第 ${i} 个镜头 ${s.id} 出错：${err.message}` +
        `（chars=${Array.isArray(s.characters)} scns=${Array.isArray(s.scenes)}）`)
    }
  }
  edgesEl.innerHTML = segs.join('')
  let w = 0, h = 0
  Object.keys(S.layout).forEach((k) => {
    const p = posOf(k), s = S.size[k]
    w = Math.max(w, p.x + s.w + 200); h = Math.max(h, p.y + s.h + 200)
  })
  edgesEl.setAttribute('width', w)
  edgesEl.setAttribute('height', h)
}

function renderAssets() {
  const { characters, scenes } = S.data
  const props = S.data.props || []
  const cardRow = (key, o) => `<div class="asset" data-key="${key}">
       ${o.ref ? `<img draggable="false" src="${fpath(o.ref)}">` : `<div style="width:34px;height:34px;border-radius:4px;background:#10151b"></div>`}
       <div><div class="name">${esc(o.name || o.id)}</div><div class="sub">${esc(o.id)}</div></div>
     </div>`
  const addRow = (id, text) => `<div class="asset" id="${id}"><div style="width:34px;height:34px;border-radius:4px;background:#10151b;display:flex;align-items:center;justify-content:center;color:#4fa3ff">+</div><div><div class="name" style="color:#4fa3ff">${text}</div></div></div>`

  $('charList').innerHTML = (characters.length ? characters.map((c) => cardRow('char:' + c.id, c)).join('') : '<div class="sub" style="color:#4d5763">（还没有角色卡）</div>')
    + addRow('newChar', '新建角色')
  $('sceneList').innerHTML = (scenes.length ? scenes.map((s) => cardRow('scene:' + s.id, s)).join('') : '<div class="sub" style="color:#4d5763">（还没有场景卡）</div>')
    + addRow('newScene', '新建场景')
  $('propList').innerHTML = (props.length ? props.map((p) => cardRow('prop:' + p.id, p)).join('') : '<div class="sub" style="color:#4d5763">（还没有道具卡）</div>')
    + addRow('newProp', '新建道具')

  document.querySelectorAll('#charList .asset[data-key], #sceneList .asset[data-key]').forEach((el) => {
    el.onclick = () => {
      S.sel.clear(); S.sel.add(el.dataset.key)
      render(); renderInspector(); focusOn(el.dataset.key)
    }
  })
  // 道具卡不是画布节点（只在镜头面板里勾选），点一下给个提示；
  // 右端补一个 × 删卡——道具以前只有创建接口，建了就删不掉。
  document.querySelectorAll('#propList .asset[data-key]').forEach((el) => {
    const pid = el.dataset.key.slice(5)          // 'prop:xxx' → 'xxx'
    el.onclick = () => {
      const nm = el.querySelector('.name')
      toast('道具卡：' + (nm ? nm.textContent : '') + '（在镜头面板里勾选使用）')
    }
    const del = document.createElement('button')
    del.textContent = '×'
    del.title = '删除这张道具卡'
    del.style.cssText = 'margin-left:auto;flex:0 0 auto;background:none;border:0;color:#e8615a;font-size:15px;line-height:1;padding:0 4px;cursor:pointer'
    del.onclick = async (e) => {
      e.stopPropagation()
      const p = (S.data.props || []).find((x) => x.id === pid)
      if (!confirm(`删除道具「${(p && p.name) || pid}」？镜头里对它的绑定会一起摘掉。`)) return
      del.disabled = true
      try {
        await api(`/api/prop/${S.ep}/${pid}`, { method: 'DELETE' })
        S.sel.delete('prop:' + pid)
        await load()
      } catch (err) {
        del.disabled = false
        alert('删除失败：' + err.message)
      }
    }
    el.appendChild(del)
  })

  $('newChar').onclick = () => openCreate('character')
  $('newScene').onclick = () => openCreate('scene')
  $('newProp').onclick = () => openCreate('prop')
}

function renderStats() {
  const { shots } = S.data
  const takes = shots.reduce((n, s) => n + videoRuns(s).length, 0)
  const filmed = shots.filter((s) => videoRuns(s).length).length
  $('stat').textContent = `${shots.length} 镜 · 已出片 ${filmed} · 成片 ${takes} 条`
  // 横竖屏
  const ori = $('projOri')
  if (ori) ori.value = ((S.data.project || {}).orientation === 'landscape') ? 'landscape' : 'portrait'
  const fpsEl = $('epFps')
  if (fpsEl) {
    const epFps = Number((S.data.project || {}).fps) || 24
    fpsEl.textContent = epFps >= 48 ? '48fps · 出片后自动补帧' : '24fps'
    fpsEl.title = epFps >= 48
      ? '这一集是 48fps：每个镜头出片完自动补帧（建集时定的，改不了）'
      : '这一集是 24fps：出片不补帧（建集时定的）'
  }
}

if ($('delEpBtn')) $('delEpBtn').onclick = async () => {
  const typed = prompt(`删除这一集会把项目数据和画布里的片一起删掉，不可恢复。\n\n要删就把集名打一遍：${S.ep}`)
  if (typed === null) return
  if (typed.trim() !== S.ep) { toast('集名不对，没有删除'); return }
  try {
    const r = await api('/api/episodes/' + encodeURIComponent(S.ep), { method: 'DELETE' })
    const left = r.left || []
    toast(`已删除 ${S.ep}`)
    location.href = left.length ? `?ep=${encodeURIComponent(left[0])}` : '/'
  } catch (e) {
    toast('删除失败：' + String(e.message).slice(0, 160), true)
  }
}

$('projOri').onchange = async () => {
  const val = $('projOri').value
  await api(`/api/project/${S.ep}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation: val }),
  })
  S.data.project.orientation = val
}

// ---------------------------------------------------------------- 视图
// 左上边界按「内容实际范围」算，不是死数字：
// 卡片被放在负坐标（画布原点左边/上边）时，必须还能拖回去看见它们
// （2026-11-04 我把边界写死成 80，结果用户放在 x=-2150 的卡片直接看不见了）
function viewLimits() {
  const pts = Object.values(S.pos || {})
  let minX = 0
  let minY = 0
  for (const p of pts) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  return { maxX: 80 - minX, maxY: 80 - minY }
}

function applyView() {
  const lim = viewLimits()
  if (S.view.x > lim.maxX) S.view.x = lim.maxX
  if (S.view.y > lim.maxY) S.view.y = lim.maxY
  world.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.z})`
  viewport.style.backgroundSize = `${40 * S.view.z}px ${40 * S.view.z}px`
  viewport.style.backgroundPosition = `${S.view.x}px ${S.view.y}px`
}

function fit() {
  const els = [...S.els.values()]
  if (!els.length) { S.view = { x: 60, y: 60, z: 1 }; applyView(); return }
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9
  els.forEach((el) => {
    const x = parseFloat(el.style.left) || 0
    const y = parseFloat(el.style.top) || 0
    x1 = Math.min(x1, x); y1 = Math.min(y1, y)
    x2 = Math.max(x2, x + el.offsetWidth); y2 = Math.max(y2, y + el.offsetHeight)
  })
  const r = viewport.getBoundingClientRect()
  if (r.width < 50 || r.height < 50) return
  const z = clamp(Math.min((r.width - 80) / (x2 - x1), (r.height - 80) / (y2 - y1)), 0.25, 1.2)
  S.view = {
    x: (r.width - (x2 - x1) * z) / 2 - x1 * z,
    y: (r.height - (y2 - y1) * z) / 2 - y1 * z,
    z,
  }
  applyView()
}

function focusOn(key) {
  const p = posOf(key), s = S.size[key]
  const r = viewport.getBoundingClientRect()
  S.view.x = r.width / 2 - (p.x + s.w / 2) * S.view.z
  S.view.y = r.height / 2 - (p.y + s.h / 2) * S.view.z
  applyView()
}

$('fitBtn').onclick = () => { fit(); scheduleSave() }

// 整理画布：丢掉手动拖过的镜头/成片坐标，回到默认网格（一列 5 个，多了往右开列）
$('tidyBtn').onclick = async () => {
  let n = 0
  Object.keys(S.pos).forEach((k) => {
    if (k.startsWith('shot:') || k.startsWith('vid:')) { delete S.pos[k]; n += 1 }
  })
  buildSizesAndLayout()
  render()
  fit()
  await saveLayout()
  toast(`已重新排列 ${n} 个节点（一列最多 5 个镜头）`)
}

// ---------------------------------------------------------------- 右侧面板：抽屉式
const PANEL_KEY = 'dsh.canvas.panel'
function applyPanel() {
  // 面板常显：开关按钮已删（2026-11-05），一旦收起来就没有入口再打开，
  // 之前正是这个状态导致面板 visible 但 overflow:hidden、滚不动。
  const el = document.getElementById('inspector') || document.getElementById('inspector')
  if (el) el.classList.remove('drawer-off')
  localStorage.setItem(PANEL_KEY, '1')
  requestAnimationFrame(fit)
}
// 面板开关按钮已按用户要求删除（2026-11-05）；仍可用 ?panel=0 / ?panel=1 深链接控制
// 深链接 ?panel=0 / ?panel=1 覆盖记忆值（方便截图和分享状态）
const panelParam = new URLSearchParams(location.search).get('panel')
applyPanel(panelParam === '0' || (panelParam !== '1' && localStorage.getItem(PANEL_KEY) === '0'))

// ---------------------------------------------------------------- 面板宽度：拖左边缘调整
const WIDTH_KEY = 'dsh.canvas.panelWidth'
const inspEl = document.getElementById('inspector')
const resizeEl = document.getElementById('inspResize')
const savedW = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10)
if (Number.isFinite(savedW) && savedW >= 240) inspEl.style.width = `${savedW}px`
resizeEl.onmousedown = (e) => {
  e.preventDefault()
  resizeEl.classList.add('active')
  const startX = e.clientX
  const startW = inspEl.getBoundingClientRect().width
  const move = (ev) => {
    // 往左拖变宽，往右拖变窄；夹在 240–760 之间
    const w = Math.max(240, Math.min(760, startW + (startX - ev.clientX)))
    inspEl.style.width = `${w}px`
  }
  const up = () => {
    resizeEl.classList.remove('active')
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    localStorage.setItem(WIDTH_KEY, String(Math.round(inspEl.getBoundingClientRect().width)))
    fit()
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

// ---------------------------------------------------------------- 悬停说明：body 级浮层
// 放在面板里会被 overflow 裁掉，所以统一挂到 body，按图标位置算坐标
const tipEl = document.getElementById('tip')
function showTip(icon) {
  const text = icon.dataset.tip
  if (!text) return
  tipEl.textContent = text
  tipEl.classList.remove('hidden')
  const r = icon.getBoundingClientRect()
  const box = tipEl.getBoundingClientRect()
  const gap = 10
  // 优先放左边，左边不够就放右边，再不够就贴边并夹在视口内
  let x = r.left - box.width - gap
  if (x < 8) x = r.right + gap
  if (x + box.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - box.width - 8)
  let y = r.top - 6
  if (y + box.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - box.height - 8)
  tipEl.style.left = `${x}px`
  tipEl.style.top = `${y}px`
}
function hideTip() { tipEl.classList.add('hidden') }
document.addEventListener('pointerover', (e) => {
  const icon = e.target.closest && e.target.closest('.help')
  if (icon) showTip(icon)
  else if (!e.target.closest || !e.target.closest('#tip')) hideTip()
})
document.addEventListener('scroll', hideTip, true)
window.addEventListener('resize', hideTip)
// 截图/调试用：?tip=<字段role> 直接把那个字段的气泡显示出来（无头浏览器没法 hover）
window.showTipFor = (role) => {
  const el = document.querySelector(`[data-role="${role}"]`)
  const icon = el && el.closest('.field') && el.closest('.field').querySelector('.help')
  if (icon) { requestAnimationFrame(() => showTip(icon)) }
}
const tipParam = new URLSearchParams(location.search).get('tip')
if (tipParam) {
  // 面板是异步渲染的，轮询等它出来（最多 6 秒）
  let tries = 0
  const t = setInterval(() => {
    tries += 1
    if (document.querySelector(`[data-role="${tipParam}"]`)) {
      clearInterval(t)
      window.showTipFor(tipParam)
    } else if (tries > 30) clearInterval(t)
  }, 200)
}

// ---------------------------------------------------------------- 交互
let drag = null

viewport.addEventListener('wheel', (e) => {
  e.preventDefault()
  const r = viewport.getBoundingClientRect()
  const mx = e.clientX - r.left, my = e.clientY - r.top
  const wx = (mx - S.view.x) / S.view.z, wy = (my - S.view.y) / S.view.z
  const z = clamp(S.view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.2, 2.2)
  S.view.x = mx - wx * z
  S.view.y = my - wy * z
  S.view.z = z
  applyView()
  scheduleSave()
}, { passive: false })

// 画布上点「用这条」把某个成片设为母版
viewport.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.pick')
  if (!btn) return
  e.stopPropagation()
  // 逐条视频的收起 / 展开：只改显示，不动数据
  if (btn.dataset.vfold) {
    setVidFolded(btn.dataset.vfold, true)
    buildSizesAndLayout(); render()
    return
  }
  if (btn.dataset.vunfold) {
    setVidFolded(btn.dataset.vunfold, false)
    buildSizesAndLayout(); render()
    return
  }
  const node = btn.closest('.node')
  const sid = node.dataset.key.split(':')[1].split('#')[0]   // key 形如 vid:S01#0
  btn.disabled = true
  try {
    const r = await api(`/api/shot/${S.ep}/${sid}/choose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: btn.dataset.pick }),
    })
    toast('母版：seed ' + r.seed)
    await load()
  } catch (err) {
    toast('✕ 选母版失败：' + String(err.message).slice(0, 100))
    btn.disabled = false
  }
})

viewport.addEventListener('pointerdown', (e) => {
  // 节点里的按钮/视频控件不能被拖拽吃掉：直接放行，让 click 正常触发
  if (e.target.closest('button, a, input, select, textarea, video')) return
  const node = e.target.closest('.node')
  const panMode = e.button === 1 || (e.button === 0 && (e.altKey || spaceDown))
  if (node && !panMode) {
    const key = node.dataset.key
    if (e.shiftKey) {
      S.sel.has(key) ? S.sel.delete(key) : S.sel.add(key)
    } else if (!S.sel.has(key)) {
      S.sel.clear(); S.sel.add(key)
    }
    refreshSel()
    drag = { mode: 'node', key, startX: e.clientX, startY: e.clientY,
             orig: Object.fromEntries([...S.sel].map((k) => [k, { ...posOf(k) }])) }
    node.setPointerCapture(e.pointerId)
    return
  }
  if (panMode) {
    e.preventDefault()            // 拦住原生选中/拖图
    drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, vx: S.view.x, vy: S.view.y }
    return
  }
  if (!node) {
    // 空白处左键拖动 = 平移画布（框选没人用，撤掉）
    if (!e.shiftKey) { S.sel.clear(); refreshSel() }
    drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, vx: S.view.x, vy: S.view.y }
    viewport.style.cursor = 'grabbing'
  }
})

let spaceDown = false
window.addEventListener('keydown', (e) => {
  // 空格会被浏览器当成"滚动/拖拽"的开关，先拦掉，否则按住空格拖画布会滚页、拖出图片
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable
  if (e.code === 'Space' && !typing) {
    e.preventDefault()
    spaceDown = true
    viewport.style.cursor = 'grab'
  }
  if (e.key === 'Escape') { S.sel.clear(); refreshSel() }
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; viewport.style.cursor = 'default' }
})
// 拖拽/选中兜底：画布里的图片、视频、文字一律不参与浏览器原生拖拽
document.addEventListener('dragstart', (e) => {
  if (e.target.closest && e.target.closest('#viewport, #inspector, #assets')) e.preventDefault()
})
document.addEventListener('selectstart', (e) => {
  if (spaceDown && e.target.closest && e.target.closest('#viewport')) e.preventDefault()
})

viewport.addEventListener('pointermove', (e) => {
  if (!drag) return
  if (drag.mode === 'pan') {
    S.view.x = drag.vx + (e.clientX - drag.startX)
    S.view.y = drag.vy + (e.clientY - drag.startY)
    applyView()
    return
  }
  if (drag.mode === 'node') {
    const dx = (e.clientX - drag.startX) / S.view.z
    const dy = (e.clientY - drag.startY) / S.view.z
    S.sel.forEach((k) => {
      const o = drag.orig[k]
      if (!o) return
      const p = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) }
      S.pos[k] = p
      const el = S.els.get(k)
      if (el) { el.style.left = p.x + 'px'; el.style.top = p.y + 'px' }
    })
    drawEdges()
    return
  }
})

window.addEventListener('pointerup', (e) => {
  if (!drag) return
  if (drag.mode === 'node' || drag.mode === 'pan') { scheduleSave(); renderStats() }
  drag = null
  viewport.style.cursor = spaceDown ? 'grab' : 'default'
  drawEdges()
})

function refreshSel() {
  S.els.forEach((el, k) => el.classList.toggle('sel', S.sel.has(k)))
  document.querySelectorAll('.asset').forEach((el) => el.classList.toggle('active', S.sel.has(el.dataset.key)))
  renderInspector()
}

// ---------------------------------------------------------------- 属性面板
// ---------------------------------------------------------------- 提示词高亮
// 只做显示层：把 token 上色。编辑的仍是 textarea，落盘的字节一个字不改。
const PROMPT_TOKEN = new RegExp('(<d>[\\s\\S]*?<\\/d>'
  + '|<(?:Subject|Picture|Video|Audio) ?\\d{1,9}(?![\\d>])'
  + '|<(?:Subject|Picture|Video|Audio) ?\\d{1,9}>'
  + '|<d>|<\\/d>'
  + '|@\\d{1,9})', 'g')

// 校验上下文：这一镜实际挂了几张图（<Picture N> / @N 的合法上限），
// 以及 subject_definitions 里定义了哪些 <Subject N>。
function hlCtx() {
  const pics = Number(insp.dataset.hlPics || '0') || 0
  const ta = document.querySelector('textarea[data-role="video.subject_definitions"]')
  const defs = ta ? ta.value : ''
  const subs = new Set()
  for (const m of defs.matchAll(/<Subject (\d{1,3})>/g)) subs.add(Number(m[1]))
  return { pics, subs }
}

function hlClass(tok, ctx, openCounts) {
  const num = (re) => {
    const m = tok.match(re)
    return m ? Number(m[1]) : NaN
  }
  if (tok === '<d>' || tok === '</d>') return 'tk-bad'   // 没配对的台词标记
  // 变量标记的破损形态：缺收尾 > / 数字太长 / 标签和数字之间没空格
  if (/^<(?:Subject|Picture|Video|Audio)/.test(tok)) {
    const m = tok.match(/^<([A-Za-z]+) ?(\d+)/)
    if (!tok.endsWith('>')) return 'tk-bad'
    if (!m) return 'tk-bad'
    if (!tok.startsWith('<' + m[1] + ' ')) return 'tk-bad'
    if (m[2].length > 3) return 'tk-bad'
  }
  if (tok.startsWith('<d>')) {
    return openCounts.dOpen === openCounts.dClose ? 'tk-dialogue' : 'tk-bad'
  }
  if (tok.startsWith('<Subject')) {
    const n = num(/^<Subject (\d{1,3})>/)
    if (ctx.subs.size > 0 && !ctx.subs.has(n)) return 'tk-bad'
    return 'tk-subject'
  }
  if (tok.startsWith('<Picture')) {
    const n = num(/^<Picture (\d{1,3})>/)
    return (ctx.pics > 0 && (n < 1 || n > ctx.pics)) ? 'tk-bad' : 'tk-picture'
  }
  if (tok.startsWith('<Video') || tok.startsWith('<Audio')) return 'tk-asset'
  const at = num(/^@(\d{1,2})$/)
  return (ctx.pics > 0 && (at < 1 || at > ctx.pics)) ? 'tk-bad' : 'tk-slot'
}

function hlHtml(text, ctx) {
  const s = String(text == null ? '' : text)
  const openCounts = {
    dOpen: (s.match(/<d>/g) || []).length,
    dClose: (s.match(/<\/d>/g) || []).length,
  }
  let out = ''
  let last = 0
  PROMPT_TOKEN.lastIndex = 0
  let m
  while ((m = PROMPT_TOKEN.exec(s)) !== null) {
    out += esc(s.slice(last, m.index))
    out += `<span class="${hlClass(m[0], ctx, openCounts)}">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  return out + esc(s.slice(last)) + '\n'
}

function attachHL(ta) {
  if (!ta || ta.tagName !== 'TEXTAREA') return
  if (ta.dataset.hl === '1' && ta._hlSync) { ta._hlSync(); return }
  const wrap = document.createElement('div')
  wrap.className = 'hl-wrap'
  ta.parentNode.insertBefore(wrap, ta)
  wrap.appendChild(ta)
  const layer = document.createElement('div')
  layer.className = 'hl-layer'
  wrap.insertBefore(layer, ta)
  ta.dataset.hl = '1'
  // 字体/内边距必须逐像素抄过来，否则高亮会偏
  const cs = getComputedStyle(ta)
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textIndent',
    'whiteSpace', 'wordBreak', 'overflowWrap', 'textAlign']) {
    layer.style[k] = cs[k]
  }
  const sync = () => {
    layer.innerHTML = hlHtml(ta.value, hlCtx())
    const cs = getComputedStyle(ta)
    const bL = parseFloat(cs.borderLeftWidth) || 0
    const bT = parseFloat(cs.borderTopWidth) || 0
    const pL = parseFloat(cs.paddingLeft) || 0
    const pR = parseFloat(cs.paddingRight) || 0
    const pT = parseFloat(cs.paddingTop) || 0
    const pB = parseFloat(cs.paddingBottom) || 0
    const s = layer.style
    s.left = (ta.offsetLeft + bL + pL) + 'px'
    s.top = (ta.offsetTop + bT + pT) + 'px'
    s.right = 'auto'
    s.bottom = 'auto'
    s.width = Math.max(0, ta.clientWidth - pL - pR) + 'px'
    s.height = Math.max(0, ta.clientHeight - pT - pB) + 'px'
    s.padding = '0'
    s.border = '0'
    s.boxSizing = 'content-box'
    layer.scrollTop = ta.scrollTop
    layer.scrollLeft = ta.scrollLeft
  }
  ta._hlSync = sync
  ta.addEventListener('input', () => {
    sync()
    if (ta.dataset.role === 'video.subject_definitions') {
      document.querySelectorAll('.hl-wrap > textarea').forEach((o) => {
        if (o !== ta && o._hlSync) o._hlSync()
      })
    }
  })
  ta.addEventListener('scroll', () => {
    layer.scrollTop = ta.scrollTop
    layer.scrollLeft = ta.scrollLeft
  })
  if (window.ResizeObserver) {
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; sync() })
    })
    ro.observe(ta)
  }
  sync()
}

function renderInspector() {
  if (S.sel.size === 0) { insp.innerHTML = '<div class="empty">选中一个节点</div>'; return }
  if (S.sel.size > 1) { insp.innerHTML = `<div class="empty">已选 ${S.sel.size} 个节点<br>（批量操作下一版接）</div>`; return }
  const key = [...S.sel][0]
  const parts = key.split(':')
  const type = parts[0]
  const id = parts[1] || ''
  const runIdx = parts[2] && parts[2].startsWith('#') ? Number(parts[2].slice(1)) : -1
  const { shots, characters, scenes } = S.data
  if (type === 'char') return charPanel(characters.find((c) => c.id === id))
  if (type === 'scene') return scenePanel(scenes.find((s) => s.id === id))
  if (type === 'shot') return shotPanel(shots.find((s) => s.id === id))
  if (type === 'kf' || type === 'vid') return mediaPanel(shots.find((s) => s.id === id), type, runIdx)
}

// 输入框悬停说明：每条都写中文模板 + 例子，鼠标放上去就能看到该怎么写
// 「① 谁、在哪」输入框的占位模板。经提示词那边反复验证：一行一个主体、只写职责、不写外观，
// 而且要用 <Picture N>（画布与官方 ref-en.txt 一致）。正常路径下这一格会被勾选自动填好，
// 模板只在空的时候露出来。
const SUBJ_DEF_PLACEHOLDER =
  '<Subject 1> is the man in <Picture 1>.\n'
  + '<Subject 2> is the young woman in <Picture 2>.\n'
  + '<Subject 3> is the alley in <Picture 3>.'

// 「整段写」的骨架提示。用 placeholder 而不是默认值：预填但不落盘等于
// 界面上看着"已经写了"、后端拿到的还是空，那是骗人的（① 那里踩过一次）。
const RAW_PROMPT_PLACEHOLDER =
  'subject_definitions:\n'
  + '<Subject 1> is the person in <Picture 1>.\n'
  + '<Subject 2> is the person in <Picture 2>.\n'
  + '<Subject 3> is the location in <Picture 3>.\n'
  + '<Subject 4> is the spoken line <d>[Chinese] 台词</d>.\n'
  + '\n'
  + 'summary:\n'
  + '（这一段发生什么：谁先动手、接触点在哪、东西最后落在哪）\n'
  + '\n'
  + 'retention_analysis:\n'
  + '<Subject 1> (appears in every shot): identity_preserved - 脸、发型、身体来自 <Picture 1>，服装是这一镜的起始状态。\n'
  + '<Subject 2> (appears in every shot): fully_preserved - 所在空间来自 <Picture 2>，整镜留在画面里。\n'
  + '\n'
  + 'detailed_description:\n'
  + '（一个动作一行，按先后顺序排，每行一句）\n'
  + '\n'
  + 'overall_soundscape:\n'
  + '（环境音：脚步声、呼吸、远处的声音）\n'
  + '\n'
  + 'non_diegetic_music:\n'
  + 'N/A'

const HELP = {
  'char.look': '外形锚点：只写"能拿帧核对"的细节。\n· 落在身体部位上，说明左右：右颧骨下方一颗小黑痣\n· 用量词，不写形容词：头发垂到锁骨、胡茬铺到下颌\n· 身高/体型必须写具体数字：身高168cm、身材匀称、腿部比例自然（别写"九头身/大长腿"，模型不认形容词，只认数字）\n· 3–8 条就够，越多越摊薄\n例：深眼窝，灰白胡茬铺到下颌，左眉尾一道旧疤，寸头，身高182cm，肩宽腿长',
  'char.outfit': '服装：从外到内逐层写，带材质和颜色，写中文即可（生图前会自动翻成英文）。\n· 层次写「外套罩着内搭」（例：白衬衫罩着黑色蕾丝胸罩），别把内衣和外衣并列列，模型会当成全露\n· 外套必须写清状态：「扣好/拉上/扣到领口」，否则模型会画成敞开\n· 想露边就点明「里面完全遮住，只露哪一处」（例：只露领口蕾丝边和两边肩带）\n· 例：白色衬衫扣到领口、罩着黑色蕾丝胸罩，胸罩完全被遮住只露两边肩带；黑色包臀裙，腰头只露一点白蕾丝；肉色丝袜，老爹鞋',
  'char.props': '道具：常随身、且跨镜不能变的东西，写清在哪只手。\n例：右手一把银色活动扳手；左手腕一块黑色手表',
  'char.name': '给人看的中文名，会出现在画布和提示词注释里。',
  'char.label': '可选。写进提示词时的英文短标签，留空就只用编号指代（推荐留空）。',
  'scene.look': '空间：写"构成"而不是"氛围"——有什么、什么材质、怎么排布。\n例：锈蚀钢管沿两侧墙面走，油污发动机组，钢格栅走道，头顶一盏红色工作灯',
  'scene.light': '光：光源 + 方向 + 软硬。\n例：头顶一盏红色工作灯，硬光从上方打下，墙面金属反光',
  'image.action': '这一格的定格状态：谁、在做什么、动作停在哪一瞬。\n有参考图时写 the subject in Image N，别复述长相。\n例：the subject in Image 1 crouches beside the engine gripping a wrench',
  'video.subject_definitions': '① 主体定义：每张参考图是谁、是什么地方。\n勾选角色 / 场景会自动写好，直接用。\n要补参考图里没有的东西（半身图的下半身、容器内部、画框外的背景）——写法见帮助文档 2.2.1「细化主体定义」。',
  'video.summary': '② 摘要：这一段整体发生什么，一句话说清因果。\n必答四问：谁先动手 / 接触点在哪 / 道具落在哪 / 结尾什么状态。\n可以带上段序号和景别/时间，先写 Segment 1 of five. A vertical shot at dusk. 再接动作。\n例：角色1把扳手搁在管子上走向角色2，角色2把检查板递过去，两人低头一起看',
  'video.retention': '③ 保留项：这一镜特别要求"不能变"的东西。\n每张参考图一行已由后端自动生成（形如 appears in [Shot 1]: fully_preserved - 与参考图一致），这里只补额外的。\n例：扳手必须一直是银色那把；她的安全帽不能摘',
  'beats': '④ 逐拍细节：一行一拍，按时间顺序写，每拍一个可看的动作。\n用先后词（先/然后/接着）连起来，别把两拍并成一拍。\n例：\n他把扳手搁在铁管上，松了手\n他往前迈两步，走近她\n她把检查板递过去，两人一起低头看',
  'video.soundscape': '⑤ 环境声：只写同期能听到的——环境声 + 动作声 + 呼吸。\n台词不写在这里（台词在拍子里）。\n例：滴水声、雨点打在铁皮上、靴子踩过湿钢格栅、两人的呼吸',
  'video.raw': '整段覆盖：这里写的会原样发给模型（只把名字归一成 <Subject N>）。\n用途：试验不同写法，或完全手控。留空则用六段。',
  'video.music': '⑥ 配乐：只写配器、速度、力度变化，不写情绪词。没有就留空（输出 N/A）。\n例：低频电子脉冲，慢速，结尾骤然停',
  'video.shot': '可选。这里写英文景别短语，覆盖上面下拉的结果。\n例：medium shot, waist up / wide establishing shot',
  'video.staging': '站位 / 相对大小：谁在画面哪一侧、谁更高更矮、相隔多远、朝哪站。\n不写也会自动补一句「所有人同底同比例」，因为参考图各自取景松紧不同，模型会误当成真实体型差。\n例：角色1站在画面左侧，角色2站在右侧，两人身高接近，男略高半个头',
  'gen.note': '空镜的补充描述：写材质、布局、能看见的东西，越具体越像真照片。\n中文即可，生成前会自动翻成英文。\n例：磨花的深色木地板、玻璃上有手印和灰尘、窗外城市灯光有光晕、35mm 实拍、轻微噪点',
  'project.retention': '全剧保留项：写一次，所有镜头都会带上。\n只写"跨镜必须不变"的：服装、标志性配饰、道具。\n例：角色1永远穿深蓝油布外套；角色2永远戴白安全帽和橙色反光背心；扳手始终是银色那把',
  'project.sage': '提速开关：把画面计算的算法换成更快的那个，一般能快一半左右，画质看不出差别。\n\n· 自动 —— 一般用这个，按显卡自己挑\n· 极速 —— 50 系显卡专用，通常最快；出错就退回「自动」\n· 关 —— 排查问题时用',
  'project.grade': '电影感调色：出片后自动跑一次 ffmpeg 垂直渐变，把画面下半幅压暗。\n\n为什么需要：模型自己能把上/下亮度差做到最多 19.5，而官方样例是 34.3——\n地面（尤其湿地反光）天生偏亮，提示词压不下去。一条渐变（顶 ×1.10 / 底 ×0.76）\n实测把差值拉到 32.7–35.0，暗部占比 33–35%，与样例基本重合。\n\n确定性操作，不引入随机性；原片保留为 *_raw.mp4，调色版为 *_graded.mp4。\n配合「5 秒 3 刀 + 人物占比 ≤1/6 + 逆光剪影」才完整，单开调色只是压暗。',
  // 角色卡和场景卡直接用 role 名（look/outfit/props/light），这里补一份
  'outfit': '服装：从外到内逐层写，带材质和颜色，写中文即可（生图前会自动翻成英文）。\n· 层次写「外套罩着内搭」（例：白衬衫罩着黑色蕾丝胸罩），别把内衣和外衣并列列，模型会当成全露\n· 外套必须写清状态：「扣好/拉上/扣到领口」，否则模型会画成敞开\n· 想露边就点明「里面完全遮住，只露哪一处」（例：只露领口蕾丝边和两边肩带）\n· 例：白色衬衫扣到领口、罩着黑色蕾丝胸罩，胸罩完全被遮住只露两边肩带；黑色包臀裙，腰头只露一点白蕾丝；肉色丝袜，老爹鞋',
  'props': '道具：跨镜不能变的东西，写清在哪只手。\n例：右手一把银色活动扳手；左手腕一块黑色手表',
  'name': '给人看的中文名，会出现在画布和提示词注释里。',
  'label': '可选。写进提示词时的英文短标签。留空更好——模型优先认编号指代。',
  'light': '光：光源 + 方向 + 软硬。\n例：头顶一盏红色工作灯，硬光从上方打下',
  'video.steps': '步数：走得越多画面越稳，但时间成倍涨。\n\n实测（同提示词、同种子、同 124 帧）：\n· 8 步：298 秒\n· 20 步：582 秒（快两倍的时间），画质和动作都没明显变好\n所以默认给你 8 步和 25 步两档，别的一概不收。',
  'video.mode': '两个页签就是两种出片方式：\n· 用参考图出片：拿角色图 + 场景图 + 你写的文字生成，人物最像，但镜头基本不动\n· 用首帧出片：先出一张首帧图，再让它往下演，镜头真的会动，同样长度还快一倍\n\n选法：要追、要打、要运镜 → 用首帧出片；对话、静镜、锁脸 → 用参考图出片。',
}

function helpIcon(key) {
  const tip = HELP[key]
  if (!tip) return ''
  return `<span class="help" data-tip="${esc(tip)}">?</span>`
}

function field(label, value, a, b) {
  // 兼容两种调用：field(label, value, opts) 和 field(label, value, null, opts)
  const opts = b !== undefined ? b : (a && typeof a === 'object' ? a : {})
  const role = opts.role || ''
  const v = value === 0 ? '0' : (value || '')
  const tip = HELP[opts.help || role]
  const icon = helpIcon(opts.help || role)
  const head = `<label>${label}${icon}</label>`
  const tipHtml = tip ? `<div class="field-tip">${esc(tip)}</div>` : ''
  if (opts.textarea) {
    return `<div class="field">${head}<textarea data-role="${role}"${role === 'look' ? ' style="min-height:200px"' : ''}>${esc(v)}</textarea>${tipHtml}</div>`
  }
  return `<div class="field">${head}<input type="text" data-role="${role}" value="${esc(v)}">${tipHtml}</div>`
}

// 一次跑多条时的成片列表：哪条当母版，衔接和末帧都跟着它
function runListHtml(s) {
  const st = s.state || {}
  const runs = st.video_runs || []
  if (runs.length < 2) return ''
  const chosen = st.chosen_video || ''
  const rows = runs.map((r, i) => {
    const name = String(r.path || '').split(/[\\/]/).pop()
    const isCur = chosen ? r.path === chosen : i === runs.length - 1
    return `<div class="runrow${isCur ? ' on' : ''}">
      <span class="meta" style="flex:1;word-break:break-all">${esc(String(r.seed))} · ${esc(name)}</span>
      <button type="button" class="ghost" data-pick="${esc(r.path)}"${isCur ? ' disabled' : ''}>${isCur ? '当前母版' : '用这条'}</button>
      <button type="button" class="ghost" data-forget="${esc(r.path)}" title="移除这条成片（画布 out 目录里的文件一起删）" style="padding:0 6px;color:#e8615a">删</button>
    </div>`
  }).join('')
  return `<div class="field"><label>本镜成片（${runs.length} 条）</label>
    ${rows}
    <div class="meta">衔接、末帧都取「当前母版」；没选就是最后一条</div></div>`
}

let pendingSave = null

async function flushSaves() {
  if (!pendingSave) return
  const p = pendingSave
  pendingSave = null
  try { await p } catch (e) { /* 保存失败各自 handler 会提示 */ }
}

function bindFields(handler) {
  insp.querySelectorAll('[data-role]').forEach((el) => {
    el.onchange = () => { pendingSave = handler(el.dataset.role, el.value) }
  })
}

function selectField(label, group, value) {
  const opts = (S.vocab && S.vocab[group]) || [['', '自动']]
  const cur = value || ''
  return `<div class="field"><label>${label}</label>
    <select data-vocab="${group}">${opts.map(([k, zh]) =>
      `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(zh)}</option>`).join('')}</select></div>`
}

// 镜头类型：写进提示词的景别短语，英文在前（模型读），中文标签给人看
const SHOT_OPTIONS = [
  ['', '自动（跟随画面景别）'],
  ['extreme wide shot', '大远景'],
  ['wide shot', '远景'],
  ['establishing shot', '交代环境'],
  ['full shot', '全景（全身）'],
  ['medium wide shot', '中远景（膝上）'],
  ['medium shot', '中景（腰上）'],
  ['medium close-up', '中近景（胸口上）'],
  ['close-up', '特写（脸）'],
  ['extreme close-up', '大特写（眼睛/局部）'],
  ['over-the-shoulder shot', '过肩镜头'],
  ['two-shot', '双人同框'],
  ['insert shot', '插入镜头（道具细节）'],
  ['point of view shot', '主观镜头'],
  ['low angle shot', '仰拍'],
  ['high angle shot', '俯拍'],
  ['dutch angle shot', '倾斜构图'],
  ['silhouette shot', '剪影'],
]

function shotField(value) {
  const cur = value || ''
  const known = SHOT_OPTIONS.some(([k]) => k === cur)
  // 手填过但不在列表里的，也保留成一个选项，别把它弄丢
  const extra = cur && !known ? `<option value="${esc(cur)}" selected>${esc(cur)}（自定义）</option>` : ''
  return `<div class="field"><label>镜头${helpIcon('video.shot')}</label>
    <select data-role="video.shot">${SHOT_OPTIONS.map(([k, zh]) =>
      `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(zh)}</option>`).join('')}${extra}</select></div>`
}

function styleField(label, value, fallback) {
  // 没有「跟随项目」了：默认直接显示项目当前用的那条画风，
  // 用户改了才算本镜覆盖；选「自定义」则出现输入框，自己写一句。
  const opts = S.styles || []
  const ids = opts.map((s) => s.id)
  const cur = String(value || fallback || '')
  const known = ids.includes(cur)
  const isCustom = !!cur && !known
  const customVal = isCustom ? cur : ''
  return `<div class="field"><label>${label}</label>
    <select data-style="1">
      ${opts.map((s) => `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${esc(s.zh)}</option>`).join('')}
      <option value="__custom__"${isCustom ? ' selected' : ''}>自定义（自己写一句）</option>
    </select>
    <div class="style-custom" style="display:${isCustom ? 'block' : 'none'};margin-top:6px">
      <textarea data-style-custom style="min-height:70px" placeholder="写一句整张图该怎么渲染，中英文都行。例：2D 卡通人物，平涂加描边，背景是实拍真实场景">${esc(customVal)}</textarea>
      <div class="meta">这句会原样拼到提示词最前面。</div>
    </div>
  </div>`
}

function moveField(engine, value) {
  const opts = ((S.cameras || {})[engine]) || []
  const cur = value || ''
  const known = opts.some((o) => o.id === cur)
  return `<div class="field"><label>运镜（H3 方括号指令）</label>
    <select data-move="1">
      <option value=""${cur ? '' : ' selected'}>自动</option>
      ${opts.map((o) => `<option value="${o.id}"${o.id === cur ? ' selected' : ''}>${esc(o.zh)}</option>`).join('')}
    </select>
    ${cur && !known ? `<div class="meta" style="color:#e0a33a">当前运镜「${esc(cur)}」这个引擎不支持，会被忽略</div>` : ''}</div>`
}

function durationField(engine, value) {
  const e = (S.engines || []).find((x) => x.id === engine) || {}
  const opts = e.durations || [4, 6, 8, 10]
  const cur = Number(value) || opts[0]
  return `<div class="field"><label>时长（${esc(e.name || engine)} 支持 ${opts.join(' / ')} 秒）</label>
    <select data-dur="1">${opts.map((sec) =>
      `<option value="${sec}"${sec === cur ? ' selected' : ''}>${sec} 秒</option>`).join('')}</select>
    ${opts.includes(cur) ? '' : `<div class="meta" style="color:#e0a33a">现在是 ${cur}s，这个引擎不支持，出片会按帧网格对齐</div>`}</div>`
}

// 「① 谁、在哪」的自动值：按这一镜勾选的角色/场景生成一行一个主体。
// 编号规则必须和后端 _shot_refs 完全一致 —— 角色在前、场景在后、各按勾选顺序、最多 3 个，
// 否则 <Picture N> 会和实际参考图错位。
// 用词优先取卡上的英文短标签（label），没有就用 the person / the location。
// 有定义就够了；参考图里看不到、需要补的部分（半身图的下半身、画框外的背景）由用户自己往这里加。
// ① 主体定义：从后端拿真实的 <Picture N>（含多角度/表情会跳号），不再自己数。
// refs 是 /api/shot/<集>/<镜>/refs 返回的列表；role=view 的辅助图并进主主体，不出新行。
function defsFromRefs(refs) {
  const word = { char: 'the person', scene: 'the location', prop: 'the object' }
  const cards = {}
  ;(S.data.characters || []).forEach((c) => { cards[c.id] = c })
  ;(S.data.scenes || []).forEach((x) => { cards[x.id] = x })
  ;(S.data.props || []).forEach((x) => { cards[x.id] = x })
  let subj = 0
  const lines = []
  for (const r of refs || []) {
    if (r.role === 'view') continue
    subj += 1
    const card = cards[r.id] || {}
    const label = card.label || word[r.kind] || 'the person'
    lines.push(`<Subject ${subj}> is ${label} in <Picture ${r.picture}>.`)
  }
  return lines.slice(0, 9).join('\n')
}

async function autoSubjectDefs(ep, sid) {
  const r = await api(`/api/shot/${ep}/${sid}/refs`)
  return defsFromRefs(r.shots || [])
}

// 判断这段文字是不是自动生成的格式（每行都是 <Subject N> is … in <Picture N>.）。
// 是就允许被新的勾选覆盖；用户手写过的（比如补了半身图的下半身）一律不动。
const AUTO_SUBJ_RE = /^<Subject \d+> is .+ in <Picture \d+>\.$/
function looksAutoSubject(text) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)
  return lines.length > 0 && lines.every((l) => AUTO_SUBJ_RE.test(l))
}

const REF_PICS = {}

function shotPanel(s) {
  if (!s) return
  const img = s.image || {}, vid = s.video || {}
  // 视频素材页签：Ref2VA 六段 / 首帧 FL2VA，默认跟当前出片模式走
  const _fl2vBlocked = fl2vBlocked()
  // 变量按钮：同一套按钮，整段写和分段写各放一份（离输入框近，少跑鼠标）
  const tokChips = (target) => (refSlots.length ? `<div class="chips" data-tok-in="${target || ''}" style="margin:6px 0 6px">${refSlots.map((r) =>
    `<button type="button" class="chip ins" data-tok="<Subject ${r.i}>" title="插入 <Subject ${r.i}>（${esc(r.name)}）">&lt;Subject ${r.i}&gt;</button>`).join('')}
    <button type="button" class="chip ins" data-tok="<d></d>" title="插入台词块，光标落在中间">&lt;d&gt;台词&lt;/d&gt;</button>
  </div>` : '')
  const videoTab = _fl2vBlocked
    ? 'ref2v'
    : (S.videoTab || ((vid.mode || 'ref2v') === 'fl2v' ? 'fl2v' : 'ref2v'))
  const cast = s.characters || []
  const sets = s.scenes || []
  const propsOn = s.props || []
  // 勾选的卡片上标 <Picture N>：编号由后端按 refs.py 算（含辅助图与 9 张上限）
  const picsKey = `${S.ep}/${s.id}`
  if (REF_PICS[picsKey] === undefined) {
    REF_PICS[picsKey] = null
    api(`/api/shot/${S.ep}/${s.id}/refs`)
      .then((r) => {
        REF_PICS[picsKey] = r.shots || []
        if (S.sel.size === 1 && [...S.sel][0] === 'shot:' + s.id) renderInspector()
      })
      .catch(() => {})
  }
  const picOf = (id) => {
    const list = REF_PICS[picsKey]
    if (!list) return ''
    const hit = list.find((x) => x.id === id)
    return hit ? 'P' + hit.picture : ''
  }
  const picTag = (id) => {
    const p = picOf(id)
    return p ? `<span style="opacity:.72;margin-left:4px">${p}</span>` : ''
  }
  const charChips = S.data.characters.map((c) => `
    <label class="chip ${cast.includes(c.id) ? 'on' : ''}">
      <input type="checkbox" data-cast="char" value="${c.id}" ${cast.includes(c.id) ? 'checked' : ''}>
      ${esc(c.name || c.id)}${c.ref ? picTag(c.id) : '（缺参考）'}
    </label>`).join('')
  const sceneChips = S.data.scenes.map((x) => `
    <label class="chip ${sets.includes(x.id) ? 'on' : ''}">
      <input type="checkbox" data-cast="scene" value="${x.id}" ${sets.includes(x.id) ? 'checked' : ''}>
      ${esc(x.name || x.id)}${x.ref ? picTag(x.id) : '（缺参考）'}
    </label>`).join('')
  // 道具卡：一件道具 = 一个 <Subject N>，固定靠 <Picture N> 绑定；
  // 挂太多会挤掉场景（9 张上限），预算在 core/refs.py 里按场景+道具数扣
  const propChips = (S.data.props || []).map((x) => `
    <label class="chip ${propsOn.includes(x.id) ? 'on' : ''}">
      <input type="checkbox" data-cast="prop" value="${x.id}" ${propsOn.includes(x.id) ? 'checked' : ''}>
      ${esc(x.name || x.id)}${x.ref ? picTag(x.id) : '（缺参考）'}
    </label>`).join('')

  const sceneRefCount = S.data.scenes.filter((x) => sets.includes(x.id) && x.ref).length
  const charRefCount = S.data.characters.filter((x) => cast.includes(x.id) && x.ref).length

  // 目前只有一个模式：Ref2VA（多参考图 → 音视频）。引擎选择先收起来。
  const engineKey = 'h3ref'
  // 段数由锚点决定：首帧起 1 段，有尾帧再起 1 段
  const beatsNeeded = 1 + ((s.state || {}).tail_frame ? 1 : 0)

  // 槽位顺序必须和服务端一致：角色在前、场景在后
  const refSlots = []
  cast.forEach((id) => {
    const c = S.data.characters.find((x) => x.id === id)
    if (c && c.ref) refSlots.push({ i: refSlots.length + 1, name: c.name || c.id })
  })
  sets.forEach((id) => {
    const sc = S.data.scenes.find((x) => x.id === id)
    if (sc && sc.ref) refSlots.push({ i: refSlots.length + 1, name: sc.name || sc.id })
  })
  // 服务端顺序是 角色 → 场景 → 道具（core/refs.py），这里必须照抄，否则编号会错位
  propsOn.forEach((id) => {
    const pr = (S.data.props || []).find((x) => x.id === id)
    if (pr && pr.ref) refSlots.push({ i: refSlots.length + 1, name: pr.name || pr.id })
  })

  // 只影响出片的三个设置（模型档位 / 调色 / 提速）。
  // 首帧页签里它们要塞进「② 用这张图出视频」绿框，Ref2VA 页签留在原位，所以抽出来复用。
  const _proj = S.data.project || {}
  const videoOnlySettings = `<div class="field"><label>出片模型档位</label>
      <select data-role="project.model_tier">
        <option value="default"${(_proj.model_tier || 'default') === 'default' ? ' selected' : ''}>标准（上面选的模型，需要 ≥16 GB 显存）</option>
        <option value="w4a8"${_proj.model_tier === 'w4a8' ? ' selected' : ''}>显存不够时用（8G 显卡能跑，出图小一点）</option>
      </select></div>
    <div class="field"><label>电影感调色${helpIcon('project.grade')}</label>
      <select data-role="project.grade">
        <option value=""${!_proj.grade ? ' selected' : ''}>关（原片直出）</option>
        <option value="cinematic"${_proj.grade === 'cinematic' ? ' selected' : ''}>开 · 垂直渐变压暗地面</option>
      </select>
      <div class="meta">出片后自动跑一次 ffmpeg 调色，完全确定性；原片保留为 <code>*_raw</code>。</div></div>
    <div class="field"><label>提速开关${helpIcon('project.sage')}</label>
      <select data-role="project.sage">
        <option value="auto"${(_proj.sage || 'auto') === 'auto' ? ' selected' : ''}>开 · 自动（按显卡自己挑，一般用这个）</option>
        <option value="sageattn_qk_int8_pv_fp8_cuda++"${_proj.sage === 'sageattn_qk_int8_pv_fp8_cuda++' ? ' selected' : ''}>开 · 极速（50 系显卡专用，最快）</option>
        <option value="disabled"${_proj.sage === 'disabled' ? ' selected' : ''}>关（排查问题时用，慢一倍）</option>
      </select>
      <div class="meta">全项目生效，单镜可用 <code>sage</code> 字段覆盖。开关画质看不出差别。</div></div>`

  // 两个页签都要用的「出片尾巴」：种子 / 衔接 / 接续帧数 / 控制 / 步数 / 出视频按钮。
  // 抽成变量是因为首帧页签要把它们包进绿框、Ref2VA 页签按普通顺序排——
  // 以前靠跨分支拼 <div> 实现，结果 Ref2VA 那边多出一个孤立 </div>、衔接下拉也丢了。
  const videoTailHtml = `<div class="row">
      <div class="field"><label>种子${helpIcon('video.seed')}</label>
        <input type="text" data-role="video.seed"
               value="${esc(String(vid.seed || (s.state || {}).video_seed || ''))}"
               placeholder="留空=复用上次"></div>
      <div class="field"><label>&nbsp;</label>
        <button type="button" class="ghost" id="btnRandSeed">随机一次</button></div>
    </div>
    <div class="field"><label>与上一镜的衔接${helpIcon('video.link')}</label>
      <select data-role="video.link">
        <option value="none"${(vid.link || 'none') === 'none' ? ' selected' : ''}>硬切（不接上一镜）</option>
        <option value="black"${vid.link === 'black' ? ' selected' : ''}>黑场（头尾淡入淡出）</option>
        <option value="latent"${vid.link === 'latent' ? ' selected' : ''}>接着上一镜往下演（接得最顺，推荐）</option>
        <option value="latent_head"${vid.link === 'latent_head' ? ' selected' : ''}>只给下一镜打底，自己从头演</option>
        <option value="frame"${vid.link === 'frame' ? ' selected' : ''}>钉住上一镜最后一帧（接缝最准）</option>
      </select></div>
    <div class="field"><label>接续帧数${helpIcon('video.link_frames')}</label>
      <select data-role="video.link_frames">
        <option value="5"${((Number(vid.link_frames) || 22) === 5) ? ' selected' : ''}>5 帧（0.2 秒，只给接续线索）</option>
        <option value="22"${((Number(vid.link_frames) || 22) === 22) ? ' selected' : ''}>22 帧（0.9 秒，动作延续更明显 · 默认）</option>
        <option value="39"${(Number(vid.link_frames) === 39) ? ' selected' : ''}>39 帧（1.6 秒，最连贯但最占动作时间）</option>
      </select></div>
    <div class="field"><label>步数${helpIcon('video.steps')}</label>
      <select data-role="video.steps">
        <option value="8"${(Number(vid.steps) || 8) === 8 ? ' selected' : ''}>8 步（快，画质略降）</option>
        <option value="25"${Number(vid.steps) === 25 ? ' selected' : ''}>25 步（慢，画面更稳）</option>
      </select></div>
    <div class="actions">
      <button id="btnVideo">出视频</button>
      <select id="runCount" title="连跑几条：每条换一个新种子，提示词不变" style="width:auto">
        <option value="1">跑 1 条</option>
        <option value="2">跑 2 条</option>
        <option value="3">跑 3 条</option>
      </select>
    </div>`

  insp.innerHTML = `
    <h3>${esc(s.id)} · 镜头</h3>
    <button class="ghost" id="btnDelShot" style="color:#e8615a;font-size:11px;padding:2px 8px;margin-bottom:8px">删除这个镜头</button>
    ${runListHtml(s)}
    <div class="field"><label>这一镜有谁（角色，可多选）</label>
      <div class="chips">${charChips || '<span class="meta">还没有角色卡</span>'}</div></div>
    <div class="field"><label>这一镜在哪（场景）</label>
      <div class="chips">${sceneChips || '<span class="meta">还没有场景卡</span>'}</div></div>
    <div class="field"><label>这一镜里的道具（道具卡，可多选）</label>
      <div class="chips">${propChips || '<span class="meta">还没有道具卡</span>'}</div></div>
    <h3 style="margin-top:14px">视频 · 提示词素材</h3>
    <div style="display:flex;gap:6px;margin:4px 0 8px">
      <button type="button" class="ghost" data-vtab="ref2v" style="flex:1;${videoTab !== 'fl2v' ? 'background:#233445;border-color:#3a5a7a;color:#cfe0ef' : ''}">用参考图出片</button>
      <button type="button" class="ghost" data-vtab="fl2v"${_fl2vBlocked ? ` disabled title="显存 ${vramGb()} GB：用首帧出片只有 int8 主模型（19.53 GB），显存不到 ${VRAM_FL2V_MIN} GB 跑不动"` : ''} style="flex:1;${videoTab === 'fl2v' ? 'background:#233445;border-color:#3a5a7a;color:#cfe0ef' : ''}${_fl2vBlocked ? ';opacity:.45;cursor:not-allowed' : ''}">用首帧出片${_fl2vBlocked ? '（显存不足）' : ''}</button>
    </div>
    ${_fl2vBlocked ? `<div class="meta" style="margin:-2px 0 8px;color:#e0a33a">显存 ${vramGb()} GB：这条链没有低显存档版本（只有 int8 主模型 19.53 GB），已禁用。要用的话请上 ${VRAM_FL2V_MIN} GB 以上的显卡。</div>` : ''}
    <div class="meta" style="margin:-2px 0 8px;color:#8fa3b8">画幅（横屏 / 竖屏）在右上角切，它同时管出片尺寸和空镜比例。</div>
    ${videoTab === 'fl2v' ? '' : videoOnlySettings}
    ${videoTab === 'fl2v' ? '' : `<div class="row">${moveField(engineKey, vid.move)}${shotField(vid.shot)}</div>`}
    ${videoTab === 'fl2v' ? '' : `<div class="field"><div style="display:flex;justify-content:space-between;align-items:center">
      <span>站位 / 相对大小（谁在哪、谁高谁矮）${helpIcon('video.staging')}</span>
      <button type="button" class="ghost" data-trans="video.staging" style="padding:1px 7px;font-size:11px">译成英文</button></div>
      <textarea data-role="video.staging">${esc(vid.staging || '')}</textarea>
      <div class="meta">不写也会自动补一句「所有人同底同比例」——防止参考图取景松紧被模型当成真实体型差</div>
      <div class="meta" style="color:#8fa3b8">例：角色1站在画面左侧，角色2站在右侧，两人身高接近，男略高半个头</div></div>`}
    ${videoTab === 'fl2v' ? `<div style="border:1px solid var(--line);border-left:3px solid #4fa3ff;border-radius:6px;padding:8px 10px 2px;margin:10px 0 0;background:var(--panel2)">
    <h3 style="margin:0 0 4px;font-size:12px">① 生成首帧图 · 点下面的「出首帧」</h3>
    <div class="meta" style="margin:0 0 8px">下面的参数只进<b>图片</b>提示词，决定这张图长什么样，不影响出片耗时。</div>
    ${styleField('画风', s.style, (S.data.project || {}).style)}
    <div class="row">${selectField('景别', 'size', img.size)}${selectField('机位角度', 'angle', img.angle)}</div>
    <div class="row">${selectField('焦距', 'lens', img.lens)}${selectField('景深', 'depth', img.depth)}</div>
    <div class="row">${selectField('光', 'light', img.light_key)}${selectField('色调', 'tone', img.tone)}</div>
    <div class="row">${selectField('主体位置', 'position', img.position)}${selectField('视线', 'gaze', img.gaze)}</div>
    <div class="row">${selectField('前景', 'foreground', img.foreground)}<div></div></div>
    <div class="meta" style="margin:-4px 0 8px">不选这三项，模型会给"居中 + 看镜头 + 背景糊"的保底构图，看着精致但假</div>
    <h3 style="margin:10px 0 4px;font-size:12px">画面内容 · 场景 / 人物 / 动作</h3>
    ${sceneRefCount
      ? '<div class="meta" style="margin-bottom:8px">场景：来自场景卡参考图，不用文字描述</div>'
      : field('场景（文字）', img.scene, null, { role: 'image.scene' })}
    ${charRefCount
      ? '<div class="meta" style="margin-bottom:8px">人物：来自角色卡参考图，不用文字描述</div>'
      : field('主体（文字）', img.subject, null, { role: 'image.subject' })}
    <div class="field"><div style="display:flex;justify-content:space-between;align-items:center">
      <span>动作（这一格在发生什么）</span>
      <button type="button" class="ghost" id="btnTrans" style="padding:1px 7px;font-size:11px">译成英文</button></div>
      <textarea data-role="image.action">${esc(img.action || '')}</textarea></div>
    ${refSlots.length ? `<div class="chips" style="margin:-4px 0 8px">${
      refSlots.map((r) => `<button class="chip ins" data-insert="@${r.i}" title="把这张图的指代插到动作里">@${r.i} ${esc(r.name)}</button>`).join('')
    }</div>
    <div class="meta" style="margin:-4px 0 8px">槽位对应：${refSlots.map((r) => `Image ${r.i}=${esc(r.name)}`).join(' · ')}</div>` : ''}
    ${field('景别补充（手写，可空）', img.shot, null, { role: 'image.shot' })}
    ${field('光补充（手写，可空）', img.light, null, { role: 'image.light' })}
    <div class="field" style="margin-top:8px"><label>出图种子（留空 = 每次都不一样）</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="kfSeed" type="text" style="flex:1" placeholder="留空 = 每次都不一样"
               value="${esc(String((s.state || {}).kf_seed || ''))}">
        <button type="button" class="ghost" id="kfSeedRand" style="padding:1px 9px;font-size:11px;flex:none">随机一次</button>
      </div>
      <div class="meta">想复现同一张图，就填上次那个号码（出完会自动记在这里）。</div></div>
    <div style="margin:8px 0 6px"><button id="btnFrame" style="width:100%">出首帧</button></div>
    </div>
    <div style="border:1px solid var(--line);border-left:3px solid #3ecf8e;border-radius:6px;padding:8px 10px 2px;margin:10px 0 0;background:var(--panel2)">
    <h3 style="margin:0 0 4px;font-size:12px">② 用这张图出视频 · 点下面的「出视频」</h3>
    <div class="meta" style="margin:0 0 8px">拿上面那张首帧往下演。这里写的是<b>画面怎么动</b>，不是给上图用的。</div>
    <div class="field"><label>首帧提示词（这一帧之后怎么演）</label>
      <textarea data-role="video.fl2v_text" style="min-height:170px">${esc(vid.fl2v_text || '')}</textarea></div>
    <div class="field"><label>哪些东西不能变（可空，全剧通用）${helpIcon('project.retention')}</label>
      <textarea data-role="project.retention" style="min-height:52px">${esc((S.data.project || {}).retention || '')}</textarea>
      <div class="meta">写一次，所有镜头都带上；填了会接在上面的提示词末尾。</div>
      <div class="meta" style="color:#8fa3b8">例：她那双球鞋全剧都是黑色；眼镜不能摘</div></div>
    <div class="row">${moveField(engineKey, vid.move)}${shotField(vid.shot)}</div>
    <div class="meta" style="margin:10px 0 6px;color:#8fa3b8;text-align:center">—— 下面这些只管出片，不影响上面那张图 ——</div>
    ${videoOnlySettings}
    ${videoTailHtml}
    </div>` : `<details id="rawBox" ${S.rawOpen ? 'open' : ''} style="margin:0 0 12px;border:1px solid #4a4433;border-left:4px solid #e8b84b;border-radius:6px;padding:10px 12px;background:#221f18">
      <summary style="cursor:pointer;color:#e8b84b;font-size:13px;font-weight:600;line-height:1.5">整段写 —— 直接写一整套提示词</summary>
      <div class="meta" style="margin:6px 0 0;color:#c9b98a">填在这里，下面①②③④⑤⑥就全部作废，一个字都不用管。</div>
      <div class="field" style="margin-top:8px"><label>整段提示词（原样发给模型）</label>
        <textarea data-role="video.raw_prompt" placeholder="${esc(RAW_PROMPT_PLACEHOLDER)}">${esc(vid.raw_prompt || '')}</textarea>
        ${tokChips('video.raw_prompt')}
        <div class="meta">写法见 <a href="/doc/help#2-2-多参考图-ref2va-六段式" target="_blank" style="color:var(--accent)">帮助文档 · 2.2 多参考图</a>（六项怎么写、整段怎么用）</div></div>
    </details>
    <details id="segBox" ${S.segOpen === false ? '' : 'open'} style="margin:0 0 12px;border:1px solid var(--line);border-left:4px solid #4a6d8c;border-radius:6px;padding:10px 12px;background:var(--panel2)">
      <summary style="cursor:pointer;color:#9fc4e0;font-size:13px;font-weight:600;line-height:1.5">分段写 —— 一项一项填，下面六项</summary>
      <div class="meta" style="margin:6px 0 0;color:#8fa3b8">这个框填了就用它；上面「整段写」也填了的话，整段优先。</div>
      ${tokChips('')}
    <div class="field"><label style="display:flex;justify-content:space-between;align-items:center">
      <span>① 谁、在哪${helpIcon('video.subject_definitions')}</span></label>
      <textarea data-role="video.subject_definitions" placeholder="${esc(SUBJ_DEF_PLACEHOLDER)}">${esc(vid.subject_definitions || '')}</textarea>
      <div class="meta">勾选上面的角色 / 场景会自动写好，直接用；要补参考图里没有的东西，见
        <a href="/doc/help#2-2-1-细化主体定义" target="_blank" style="color:var(--accent)">帮助文档 · 2.2.1 细化主体定义</a></div></div>
    <div class="field"><div style="display:flex;justify-content:space-between;align-items:center">
      <span>② 这一段发生什么${helpIcon('video.summary')}</span>
      <button type="button" class="ghost" data-trans="video.summary" style="padding:1px 7px;font-size:11px">译成英文</button></div>
      <textarea data-role="video.summary">${esc(vid.summary || vid.action || '')}</textarea>
      <div class="meta">写因果：谁先动手、接触点在哪、东西最后落在哪</div>
      <div class="meta" style="color:#8fa3b8">例：角色1把扳手搁在管子上走向角色2，角色2把检查板递过去，两人低头一起看</div></div>
    <div class="field"><div style="display:flex;justify-content:space-between;align-items:center">
      <span>③ 哪些东西不能变（可空）${helpIcon('video.retention')}</span>
      <button type="button" class="ghost" data-trans="video.retention" style="padding:1px 7px;font-size:11px">译成英文</button></div>
      <textarea data-role="video.retention">${esc(vid.retention || '')}</textarea>
      <div class="meta">每张参考图一行已由后端自动生成（与参考图一致），这里只补额外的</div>
      <div class="meta" style="color:#8fa3b8">例：扳手必须一直是银色那把；角色2的安全帽不能摘</div></div>
    <div class="field"><div style="display:flex;justify-content:space-between;align-items:center">
      <span>④ 一个动作一行${helpIcon('beats')}</span>
      <button type="button" class="ghost" data-trans="beats" style="padding:1px 7px;font-size:11px">逐行译成英文</button></div>
      <textarea data-role="beats">${esc((s.beats || []).join('\n'))}</textarea>
      <div class="meta">这些行会按顺序拼进视频提示词</div>
      <div class="meta" style="color:#8fa3b8">例（一行一拍，带先后词）：<br>角色1把扳手搁在铁管上，松了手<br>角色1往前迈两步，走近角色2<br>角色2递过检查板，两人一起低头看</div></div>
    <div class="field"><div style="display:flex;justify-content:space-between;align-items:center">
      <span>⑤ 环境音（脚步声、球声）${helpIcon('video.soundscape')}</span>
      <button type="button" class="ghost" data-trans="video.soundscape" style="padding:1px 7px;font-size:11px">译成英文</button></div>
      <textarea data-role="video.soundscape">${esc(vid.soundscape || vid.audio || '')}</textarea>
      <div class="meta" style="color:#8fa3b8">例：滴水声、雨点打在铁皮上、靴子踩过湿钢格栅、两人的呼吸</div></div>
    <div class="field"><label style="display:flex;justify-content:space-between;align-items:center">
      <span>⑥ 配乐（可空）</span></label>
      <input type="text" data-role="video.music" value="${esc(vid.music || '')}"></div>
    <div class="meta" style="margin-top:-4px;color:#8fa3b8">例：低频电子脉冲，慢速，结尾骤然停（留空输出 N/A）</div>
    </details>`}
    ${videoTab === 'fl2v' ? '' : `<button type="button" class="ghost" id="btnAutoSix" style="width:100%;margin:4px 0 8px">自动填好上面六项（再手动改）</button>
    <button type="button" class="primary" id="btnTransAll" style="width:100%;margin:2px 0 6px">全部译成英文（六段一起翻）</button>
    ${videoTailHtml}`}
    <div class="note">「用参考图出片」：直接拿角色图 + 场景图 + 你写的文字去生成，不需要首帧。<br>
      「用首帧出片」：先在上面出好一张首帧图，再让它往下演——镜头会真的动起来。</div>`

  // 两个折叠框都记住展开 / 收起（重渲染后要还原，否则点一次按钮框就关了）
  {
    const seg = insp.querySelector('#segBox')
    if (seg) {
      seg.addEventListener('toggle', () => { S.segOpen = seg.open })
      if (S.segOpen === undefined) S.segOpen = seg.open
    }
    const rawBox = insp.querySelector('#rawBox')
    if (rawBox) {
      rawBox.addEventListener('toggle', () => { S.rawOpen = rawBox.open })
      if (S.rawOpen === undefined) S.rawOpen = rawBox.open
    }
  }

  // 视频素材页签：Ref2VA / 首帧，切换同时落盘 video.mode（出片读的就是它）
  insp.querySelectorAll('button[data-vtab]').forEach((b) => {
    b.onclick = async () => {
      const v = b.dataset.vtab
      S.videoTab = v
      await api(`/api/shot/${S.ep}/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video: { mode: v } }),
      })
      s.video = Object.assign(s.video || {}, { mode: v })
      renderInspector()
    }
  })

  // 2026-11-06：这两个按钮用直连 onclick，不依赖 data-act 事件链（点不动过一次）
  {
    const jobBtn = insp.querySelector('button[data-act="importjob"]')
    const refBtn = insp.querySelector('button[data-act="refsheet"]')
    const statusEl = () => document.getElementById('genStatus')
    const say = (m) => { const el = statusEl(); if (el) el.textContent = m }
    if (jobBtn) {
      jobBtn.onclick = async () => {
        const box = document.getElementById('jobIdBox')
        const pid = (box && box.value || '').trim()
        if (!pid) { say('先粘贴 ComfyUI 的任务 ID'); return }
        jobBtn.disabled = true
        say('正在从任务里读人设与种子…')
        try {
          const r = await api(`/api/character/${S.ep}/${o.id}/importjob`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: pid }),
          })
          say(`已导入：种子 ${r.seed || '(没读到)'}，提示词 ${(r.prompt || '').length} 字`)
        } catch (e) {
          say('✗ ' + String(e.message).slice(0, 200))
        } finally {
          jobBtn.disabled = false
        }
      }
    }
    if (refBtn) {
      refBtn.onclick = async () => {
        const old = refBtn.textContent
        refBtn.disabled = true
        refBtn.textContent = '生成中…'
        say('正在跑 4 视角 + 4 姿势 + 服装条…')
        try {
          const r = await api(`/api/refsheet/${S.ep}/${o.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          o.ref = r.path
          o.sheets = { turnaround: [{ path: r.path, label: '拼接' }] }
          say('拼接参考图已生成并设为主参考')
          render(); renderAssets()
        } catch (e) {
          say('✗ ' + String(e.message).slice(0, 200))
        } finally {
          refBtn.disabled = false
          refBtn.textContent = old
        }
      }
    }
  }

  bindFields(async (role, value) => {
    const patch = {}
    if (role === 'video.seed') {
      const n = parseInt(value, 10)
      patch.video = { seed: Number.isFinite(n) && n > 0 ? n : 0 }
    }
    else if (role.startsWith('image.')) patch.image = { [role.slice(6)]: value }
    // 只发改动的这一个键，由服务端和现有 video 合并。
    // 原来发的是 `{...vid}` 整块（vid 是渲染时的旧快照），并发保存时会把别人刚写的字段冲掉
    // ——「自动填六段」一次触发 5 个 PATCH，落盘只剩 1 个（2026-11-04 修）。
    else if (role.startsWith('video.')) {
      patch.video = { [role.slice(6)]: value }
      // 选「钉上一镜末帧 frame」时接续帧数自动落 1：它的语义就是单帧钉帧，
      // 留着 22 会走片段钉帧分支（steps/video.py 里 want_frames>1 走 clip）。
      if (role === 'video.link' && value === 'frame') patch.video.link_frames = 5
    }
    else if (role.startsWith('project.')) {
      // 项目级字段，走另一个接口
      const key = role.slice(8)
      await api(`/api/project/${S.ep}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
      S.data.project[key] = value
      setGenStatus(key === 'sage'
        ? (value === 'disabled' ? '提速已关（会慢一倍）' : `提速已开（${value}）`)
        : key === 'grade'
          ? (value ? '电影感调色已开：出片后自动压暗地面' : '电影感调色已关')
          : '全剧保留项已保存，所有镜头都会带上')
      return
    }
    else if (role === 'beats') patch.beats = value.split('\n').map((x) => x.trim()).filter(Boolean)
    else if (role === 'seconds') patch.seconds = Number(value) || 4
    else patch[role] = value
    await api(`/api/shot/${S.ep}/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    // 注意：patch.video 只是「改了一个键」，不能整块替换本地快照，
    // 否则同一个镜头里别的 video 字段会在下一次渲染时丢掉
    // （2026-11-04 用户实测：选 latent 后接续帧数变回默认 5，再选 22 帧衔接又变回黑场）。
    if (patch.video) s.video = Object.assign(s.video || {}, patch.video)
    if (patch.image) s.image = Object.assign(s.image || {}, patch.image)
    const rest = Object.assign({}, patch)
    delete rest.video
    delete rest.image
    Object.assign(s, rest)
    render(); renderStats()
    S.sel.clear(); S.sel.add('shot:' + s.id)
    refreshSel()
  })

  // 时长：按引擎给选项
  const durSel = insp.querySelector('select[data-dur]')
  if (durSel) durSel.onchange = async () => {
    const sec = Number(durSel.value)
    await api(`/api/shot/${S.ep}/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: sec }),
    })
    s.seconds = sec
    render(); renderStats()
    S.sel.clear(); S.sel.add('shot:' + s.id); refreshSel()
  }

  // 运镜：按引擎的选项写入
  const mvSel = insp.querySelector('select[data-move]')
  if (mvSel) mvSel.onchange = async () => {
    const v2 = { ...(s.video || {}), move: mvSel.value }
    await api(`/api/shot/${S.ep}/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video: v2 }),
    })
    s.video = v2
    setGenStatus(mvSel.value ? `运镜：${mvSel.options[mvSel.selectedIndex].text}` : '运镜：自动')
  }

  // 视频引擎：单镜覆盖
  const engSel = insp.querySelector('select[data-engine]')
  if (engSel) engSel.onchange = async () => {
    const val = engSel.value
    const key = val || 'h3ref'
    const panel = { engine: val || null }
    // 时长要落在新引擎支持的档位里，否则出片时长会被帧网格带偏
    const opts = (((S.engines || []).find((e) => e.id === key)) || {}).durations || []
    const cur = Number(s.seconds) || 4
    let note = ''
    if (opts.length && !opts.includes(cur)) {
      const near = opts.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a), opts[0])
      panel.seconds = near
      note = `；时长从 ${cur}s 调到 ${near}s（新引擎只支持 ${opts.join('/')}）`
    }
    const curMove = (s.video || {}).move || ''
    const okList = ((S.cameras || {})[key] || []).map((o) => o.id)
    const badMove = curMove && !okList.includes(curMove)
    await api(`/api/shot/${S.ep}/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(panel),
    })
    s.engine = val || null
    if (panel.seconds) s.seconds = panel.seconds
    S.sel.clear(); S.sel.add('shot:' + s.id); renderInspector()
    setGenStatus((badMove
      ? `已切引擎；原运镜「${curMove}」在新引擎里没有，请重选`
      : `本镜引擎：${val ? engSel.options[engSel.selectedIndex].text : '跟随项目'}`) + note)
  }

  // 单镜画风：选预设就存 id；选「自定义」则展开输入框，输入的内容原样存进 style
  const styleSel = insp.querySelector('select[data-style]')
  if (styleSel) {
    const box = insp.querySelector('.style-custom')
    const area = insp.querySelector('[data-style-custom]')
    const saveStyle = async (val) => {
      await api(`/api/shot/${S.ep}/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style: val }),
      })
      s.style = val || null
    }
    styleSel.onchange = async () => {
      const val = styleSel.value
      if (val === '__custom__') {
        if (box) box.style.display = 'block'
        if (area) { area.value = s.style && !(S.styles || []).some((x) => x.id === s.style) ? s.style : ''; area.focus() }
        setGenStatus('自定义画风：在下面的框里写一句')
        return
      }
      if (box) box.style.display = 'none'
      await saveStyle(val)
      setGenStatus(`本镜画风：${styleSel.options[styleSel.selectedIndex].text}`)
    }
    if (area) area.onchange = async () => {
      const txt = area.value.trim()
      if (!txt) { setGenStatus('自定义画风是空的，会退回项目画风'); return }
      await saveStyle(txt)
      setGenStatus('本镜画风：自定义')
    }
  }

  // 镜头语言下拉：选完直接写固定英文短语，不做二次翻译
  insp.querySelectorAll('select[data-vocab]').forEach((sel) => {
    sel.onchange = async () => {
      const group = sel.dataset.vocab
      let patch, target
      if (group === 'move') {
        target = { ...vid, move: sel.value }
        patch = { video: target }
      } else {
        const key = group === 'light' ? 'light_key' : group
        target = { ...img, [key]: sel.value }
        patch = { image: target }
      }
      await api(`/api/shot/${S.ep}/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (group === 'move') Object.assign(vid, target)
      else Object.assign(img, target)
      render(); renderStats()
      S.sel.clear(); S.sel.add('shot:' + s.id)
      refreshSel()
    }
  })

  // 把 @N 插进动作框（模型只认 the subject in Image N，不认"角色1"）
  // 两个坑：① 点按钮会让 textarea 先失焦，失焦又触发 onchange 保存、面板可能重渲染，
  //         于是第一次点击只起到"保存"作用，得点第二下才插进去；
  //        ② 失焦之后 selectionStart 不可靠，插入位置会跑掉。
  // 解法：mousedown 上 preventDefault 抢在失焦之前，顺手记下当时的光标位置。
  insp.querySelectorAll('button[data-insert]').forEach((btn) => {
    let savedPos = null
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const ta = insp.querySelector('textarea[data-role="image.action"]')
      if (ta && ta.selectionStart != null) savedPos = ta.selectionStart
    })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      const ta = insp.querySelector('textarea[data-role="image.action"]')
      if (!ta) return
      const tok = btn.dataset.insert
      const pos = savedPos != null ? savedPos
        : (ta.selectionStart == null ? ta.value.length : ta.selectionStart)
      ta.value = ta.value.slice(0, pos) + tok + ' ' + ta.value.slice(pos)
      ta.focus()
      const next = pos + tok.length + 1
      ta.selectionStart = ta.selectionEnd = next
      savedPos = next
      if (ta.onchange) ta.onchange()
    })
  })


  insp.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.forget
      const name = String(p).split(/[\\/]/).pop()
      if (!confirm(`把这条成片删掉？\n\n${name}\n\n画布 out 目录里的文件会一起删；ComfyUI 里的原片不动。`)) return
      b.disabled = true
      try {
        const r = await api(`/api/shot/${S.ep}/${s.id}/forget`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        })
        toast(r.removed && r.removed.length
          ? `已删除（${r.removed.join('/')}）`
          : (r.note || '已从成片列表移除'))
        await load()
        S.sel.clear(); S.sel.add('shot:' + s.id); refreshSel()
      } catch (e) {
        toast('删除失败：' + String(e.message).slice(0, 160), true)
        b.disabled = false
      }
    }
  })

  // 变量按钮：插到目标框的光标处。
  //   · 整段写那排写死了 data-tok-in，就只往整段那个框里插；
  //   · 分段写那排没写死，就插到最后点过的框里。
  // 光标不在目标框里时追加到末尾——不然会出现"点了没反应"（字进到别的框去了）。
  let lastTa = null
  insp.addEventListener('focusin', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA') lastTa = e.target
  })
  const tokTarget = (btn) => {
    const host = btn.closest('.chips')
    const forced = host && host.dataset.tokIn
    if (forced) return insp.querySelector(`textarea[data-role="${forced}"]`)
    return lastTa
  }
  insp.querySelectorAll('button[data-tok]').forEach((btn) => {
    let pos = null
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const ta = tokTarget(btn)
      const focused = ta && document.activeElement === ta
      pos = (focused && ta.selectionStart != null) ? ta.selectionStart : null
    })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      const ta = tokTarget(btn)
      if (!ta) return
      const tok = btn.dataset.tok
      let at = pos != null ? pos : ta.value.length
      // 光标如果正落在某个 <...> 里面，先挪到那个 token 的末尾，
      // 否则插进去会把原 token 剖开，拼出 <Subject 11111> 这种残件
      const v = ta.value
      const left = v.lastIndexOf('<', at - 1)
      const right = v.indexOf('>', left < 0 ? at : left)
      if (left >= 0 && right >= at - 1 && v.lastIndexOf('>', at - 1) < left) {
        at = right + 1
      }
      ta.value = ta.value.slice(0, at) + tok + ' ' + ta.value.slice(at)
      const next = tok === '<d></d>' ? at + 3 : at + tok.length + 1
      ta.focus()
      ta.selectionStart = ta.selectionEnd = next
      pos = next
      // 保存可能触发面板重渲染，重渲染会把 focus 丢掉 —— 登记一下，重渲染后再落回这个框
      const role = ta.dataset.role
      S.pendingFocus = { role, pos: next }
      setTimeout(() => {
        if (S.pendingFocus && S.pendingFocus.role === role) S.pendingFocus = null
      }, 1200)
      ta.dispatchEvent(new Event('input'))
      if (ta.onchange) ta.onchange()
    })
  })

  // 提示词高亮 + 引用校验
  insp.dataset.hlPics = String(refSlots.length)
  insp.querySelectorAll('textarea[data-role]').forEach(attachHL)

  // 刚点过变量按钮：焦点和光标还回那个框（重渲染后 textarea 是新节点，得重新定位）
  if (S.pendingFocus) {
    const pf = S.pendingFocus
    const t2 = insp.querySelector(`textarea[data-role="${pf.role}"]`)
    if (t2) {
      t2.focus()
      const at2 = Math.min(pf.pos, t2.value.length)
      t2.selectionStart = t2.selectionEnd = at2
      S.pendingFocus = null
    }
  }

  // 一张卡带几张参考图：主参考 1 张 + 多角度/表情/服装图各算 1 张（和 core/refs.py 的预算同口径）
  const cardRefCount = (kind, id) => {
    if (kind === 'char') {
      const c = (S.data.characters || []).find((x) => x.id === id)
      if (!c) return 0
      let n = c.ref ? 1 : 0
      const sh = c.sheets || {}
      for (const g of ['turnaround', 'poses', 'expression', 'costume', 'props']) n += (sh[g] || []).length
      return n
    }
    const list = kind === 'scene' ? (S.data.scenes || []) : (S.data.props || [])
    const x = list.find((y) => y.id === id)
    return x && x.ref ? 1 : 0
  }

  // 这一镜谁在场：改完立刻存，并重画连线
  insp.querySelectorAll('input[data-cast]').forEach((box) => {
    box.onchange = async () => {
      delete REF_PICS[`${S.ep}/${s.id}`]
      const kind = box.dataset.cast
      const key = kind === 'char' ? 'characters' : (kind === 'prop' ? 'props' : 'scenes')
      const picked = [...insp.querySelectorAll(`input[data-cast="${kind}"]:checked`)].map((x) => x.value)
      // 参考图上限 9（H3 ref_images）：新勾的这张加上后超限就回滚，不让他添加
      if (box.checked) {
        let sum = cardRefCount(kind, box.value)
        for (const k2 of ['char', 'scene', 'prop']) {
          const key2 = k2 === 'char' ? 'characters' : (k2 === 'prop' ? 'props' : 'scenes')
          for (const id2 of (s[key2] || [])) {
            if (k2 === kind && id2 === box.value) continue
            sum += cardRefCount(k2, id2)
          }
        }
        if (sum > 9) {
          box.checked = false
          showModal('参考图超上限',
            `这一镜的参考图加起来会到 ${sum} 张，最多只认 9 张（多角度 / 表情 / 服装图都算在内）。\n\n先把某个角色的辅助图收一收，或者少挂一张卡。`)
          return
        }
      }
      // 勾选变化后，① 的默认值要跟着重写：主体编号是按勾选顺序排的，不重写就会错位。
      // 只覆盖「空」或「还是自动格式」的内容 —— 用户手写/补充过的保持原样。
      const curDefs = String((s.video || {}).subject_definitions || '')
      const willWriteDefs = !curDefs.trim() || looksAutoSubject(curDefs)
      await api(`/api/shot/${S.ep}/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: picked }),
      })
      s[key] = picked
      // 勾选先落盘，再按新的参考顺序重写 ①（编号以服务端 refs 为准）
      if (willWriteDefs) {
        try {
          const defs = await autoSubjectDefs(S.ep, s.id)
          await api(`/api/shot/${S.ep}/${s.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video: { subject_definitions: defs } }),
          })
          s.video = { ...(s.video || {}), subject_definitions: defs }
        } catch (e) { /* 取不到就保持原样，别挡住勾选 */ }
      }
      render(); renderStats()
      S.sel.clear(); S.sel.add('shot:' + s.id)
      refreshSel()
    }
  })

  // 选母版：点哪条，哪条就成为衔接与末帧的来源
  insp.querySelectorAll('button[data-pick]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true
      try {
        const r = await api(`/api/shot/${S.ep}/${s.id}/choose`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: btn.dataset.pick }),
        })
        s.state = Object.assign(s.state || {}, {
          chosen_video: r.chosen, chosen_seed: r.seed, chosen_last_frame: r.last_frame,
          video: r.chosen, video_seed: r.seed,
        })
        render()
        S.sel.clear(); S.sel.add('shot:' + s.id); refreshSel()
        setGenStatus('母版已换成 seed ' + r.seed)
      } catch (e) {
        setGenStatus('✗ 选母版失败：' + String(e.message).slice(0, 120))
        btn.disabled = false
      }
    }
  })

  // 随机一次：换一个新种子并立刻存进这一镜，输入框当场更新
  const randBtn = $('btnRandSeed')
  if (randBtn) randBtn.onclick = async () => {
    const n = Math.floor(Math.random() * 1_000_000_000)
    try {
      await api(`/api/shot/${S.ep}/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video: { ...vid, seed: n } }),
      })
      vid.seed = n
      const el = insp.querySelector('[data-role="video.seed"]')
      if (el) el.value = String(n)
      setGenStatus(`新种子 ${n}（下次出片生效）`)
    } catch (e) {
      setGenStatus('✗ 换种子失败：' + String(e.message).slice(0, 120))
    }
  }

  // 自动填六段：把卡片/拍子拼好的结果灌进六个框，用户再手改（留空才会走自动拼装）
  const autoSix = $('btnAutoSix')
  if (autoSix) autoSix.onclick = async () => {
    const old = autoSix.textContent
    autoSix.disabled = true
    try {
      autoSix.textContent = '拼装中…'
      const r = await api(`/api/prompt/${S.ep}/${s.id}/sections`)
      const map = {
        'video.subject_definitions': r.subject_definitions,
        'video.summary': r.summary,
        'video.retention': r.retention_analysis,
        'video.soundscape': r.overall_soundscape,
        'video.music': r.non_diegetic_music === 'none' ? '' : r.non_diegetic_music,
      }
      for (const [role, val] of Object.entries(map)) {
        const el = insp.querySelector(`[data-role="${role}"]`)
        if (el) { el.value = val || ''; el.dispatchEvent(new Event('change')) }
      }
      const beatsEl = insp.querySelector('[data-role="beats"]')
      if (beatsEl && (r.beats || []).length) {
        beatsEl.value = r.beats.join('\n')
        beatsEl.dispatchEvent(new Event('change'))
      }
      toast('六段已填好，改完直接点出片就行')
    } catch (e) {
      toast('✗ ' + String(e.message).slice(0, 160), true)
    } finally {
      autoSix.disabled = false
      autoSix.textContent = old
    }
  }

  // 一键把视频段整段译成英文（H3 / Ref2VA 的正文最好是英文）
  const transAll = $('btnTransAll')
  if (transAll) transAll.onclick = async () => {
    const roles = ['video.subject_definitions', 'video.summary', 'video.retention',
      'video.soundscape']
    const old = transAll.textContent
    transAll.disabled = true
    let done = 0
    try {
      for (const role of roles) {
        const el = insp.querySelector(`[data-role="${role}"]`)
        if (!el) continue
        const raw = String(el.value || '').trim()
        if (!raw) continue
        transAll.textContent = `翻译中… ${role.replace('video.', '')}`
        const r = await api('/api/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: raw, slots: refSlots }),
        })
        el.value = r.text
        if (el.onchange) el.onchange()
        done += 1
      }
      const ta = insp.querySelector('[data-role="beats"]')
      if (ta && String(ta.value || '').trim()) {
        transAll.textContent = '翻译中… 拍子'
        const out = []
        for (const line of String(ta.value).split('\n').map((x) => x.trim()).filter(Boolean)) {
          const r = await api('/api/translate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line, slots: refSlots }),
          })
          out.push(r.text)
        }
        ta.value = out.join('\n')
        if (ta.onchange) ta.onchange()
        done += 1
      }
      setGenStatus(done ? `已译 ${done} 段为英文` : '没有需要翻译的内容')
    } catch (e) {
      showModal('翻译失败', String(e.message).slice(0, 400) + '\n\n点右上角「设置」填接口地址和 API Key。')
    } finally {
      transAll.disabled = false
      transAll.textContent = old
    }
  }

  // 译成英文：任何带 data-trans 的按钮都能用（画面动作 / 视频动作 / 拍子）
  insp.querySelectorAll('button[data-trans]').forEach((btn) => {
    btn.onclick = async () => {
      const role = btn.dataset.trans
      const ta = insp.querySelector(`[data-role="${role}"]`)
      if (!ta) return
      const raw = String(ta.value || '').trim()
      if (!raw) { showModal('翻译', '这一栏是空的'); return }
      const old = btn.textContent
      btn.disabled = true
      btn.textContent = '翻译中…'
      try {
        if (role === 'beats') {
          // 拍子是每段一句，逐行翻，别让模型合并
          const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean)
          const out = []
          for (const line of lines) {
            const r = await api('/api/translate', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: line, slots: refSlots }),
            })
            out.push(r.text)
          }
          ta.value = out.join('\n')
        } else {
          const r = await api('/api/translate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: raw, slots: refSlots }),
          })
          ta.value = r.text
        }
        if (ta.onchange) ta.onchange()
        setGenStatus(`译成英文完成（角色引用已转成 @N 槽位）`)
      } catch (e) {
        showModal('翻译失败', String(e.message).slice(0, 400) + '\n\n点右上角「设置」填接口地址和 API Key。')
      } finally {
        btn.disabled = false
        btn.textContent = old
      }
    }
  })

  // 译成英文：走用户在「设置」里填的接口
  const transBtn = $('btnTrans')
  if (transBtn) transBtn.onclick = async () => {
    const ta = insp.querySelector('textarea[data-role="image.action"]')
    const text = (ta.value || '').trim()
    if (!text) { showModal('翻译', '动作框是空的'); return }
    transBtn.disabled = true
    const old = transBtn.textContent
    transBtn.textContent = '翻译中…'
    try {
      const r = await api('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, slots: refSlots }),
      })
      ta.value = r.text
      if (ta.onchange) ta.onchange()
      const disobeyed = /(character|person)\s*\d/i.test(r.text)
      setGenStatus(disobeyed
        ? `已译成英文（${r.model}）；但返回里还有 Character N，出图时会自动归一化`
        : `已用 ${r.model} 译成英文，角色引用是 @N 槽位`)
    } catch (e) {
      showModal('翻译失败', String(e.message).slice(0, 400) + '\n\n点右上角「设置」填接口地址和 API Key。')
    } finally {
      transBtn.disabled = false
      transBtn.textContent = old
    }
  }

  // 删除镜头（2026-11-04 用户报：画布删不了镜头）
  const delShot = $('btnDelShot')
  if (delShot) delShot.onclick = async () => {
    if (!confirm(`删除镜头「${s.id}」？成片文件会留在磁盘上，画布里这条记录会消失。`)) return
    try {
      await api(`/api/shot/${S.ep}/${s.id}`, { method: 'DELETE' })
      S.sel.delete('shot:' + s.id)
      await load()
    } catch (e) { alert('删除镜头失败：' + e.message) }
  }

  const vBtn = $('btnVideo')
  if (vBtn) vBtn.onclick = async () => {
    // 模式决定前置条件：参考图模式要参考图，首帧模式要一张确认过的首帧
    const mode0 = String((vid || {}).mode || (s.state || {}).video_mode || 'ref2v')
    const refCount = (s.characters || []).length + (s.scenes || []).length + (s.props || []).length
    if (mode0 === 'fl2v') {
      if (!((s.state || {}).kf)) {
        showModal('出视频', '首帧模式要先有首帧：先点「出首帧」，确认后再出视频。')
        return
      }
    } else if (!refCount) {
      showModal('出视频', '这一镜没有挂角色、场景或道具，Ref2VA 至少需要一张参考图。')
      return
    }
    // 生成前停：先把视频提示词给用户看（模式取上面页签落盘的 video.mode）
    await flushSaves()
    const mode = String((vid || {}).mode || (s.state || {}).video_mode || 'ref2v')
    let built
    try {
      built = await api(`/api/prompt/${S.ep}/${s.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
    } catch (e) { showModal('提示词生成失败', String(e.message)); return }
    const eng = mode === 'fl2v' ? 'MiniMax H3 · FL2VA（首帧）' : 'MiniMax H3 · Ref2VA（参考图）'
    const rawUsed = String((vid || {}).raw_prompt || '').trim()
    const ok = await askConfirm(
      `出视频确认 · ${s.id}`,
      `引擎：${eng}` +
      (rawUsed ? '（提示词来源：整段覆盖，原样发送）' : '（提示词来源：上面六段自动拼装）') + '\n\n' +
      `提示词全文（${built.video.length} 字符）：\n${'─'.repeat(40)}\n${built.video}\n${'─'.repeat(40)}\n` +
      `sha256[:16] = ${built.sent_sha}　（同一串会打进 ComfyUI 的 prompt 字段）\n\n` +
      (built.problems && built.problems.length ? `自检提醒：\n- ${built.problems.join('\n- ')}\n\n` : '') +
      '时长用下面那个下拉选：选完就按这个帧数生成（会同时改工作流里的 length）。',
      '开始生成',
      { seconds: ((vid || {}).chosen_seconds || s.seconds || 5) })
    if (!ok) return
    const pickedFrames = Number($('askSeconds').value) || 0
    if (!pickedFrames) {
      // 不许悄悄退回默认时长（2026-11-04：选了 5.88 秒却按 5.0 秒跑）
      showModal('出视频失败', '时长下拉没取到值，先在上面选一个时长再点「开始生成」。')
      return
    }
    const pickedSeconds = pickedFrames / 24
    // 记住这次选的时长，下次弹框默认就是它（镜头面板里的时长框已于 2026-11-04 删除）
    if (pickedFrames) {
      api(`/api/shot/${S.ep}/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video: { chosen_seconds: pickedSeconds } }),
      }).catch(() => {})
    }
    vBtn.disabled = true
    setGenStatus('提交视频任务…')
    try {
      const cntSel = $('runCount')
      const count = cntSel ? (parseInt(cntSel.value, 10) || 1) : 1
      const r = await api(`/api/shot/${S.ep}/${s.id}/video`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: mode === 'fl2v' ? 'h3fl2v' : 'h3ref',
          mode,
          seed: Number(vid.seed) || 0,
          count,
          seconds: pickedSeconds,
          frames: pickedFrames,
        }),
      })
      await pollVideo(r.job)
    } catch (e) {
      // 配置类问题（409 权重没装齐 / 400 缺参考图）直接弹窗说清楚
      if (e.status === 409 || e.status === 400) {
        showModal('出视频被拦住了', String(e.message))
        setGenStatus('✗ ' + String(e.message).split('\n')[0])
      } else {
        setGenStatus('✗ ' + String(e.message).slice(0, 300))
      }
    } finally {
      vBtn.disabled = false
    }
  }

  // 出首帧：弹框里生成、预览、可换种子重来，满意再「用这张作为首帧」
  if ($('btnFrame')) $('btnFrame').onclick = () => openFrameGen(S.ep, s.id)

  // 出图种子的「随机一次」：只填框，不提交，点出首帧才生效
  if ($('kfSeedRand')) $('kfSeedRand').onclick = () => {
    const inp = $('kfSeed')
    inp.value = String(Math.floor(Math.random() * 4294967295))
    inp.focus()
    inp.select()
  }

  // 确认首帧：视频步骤看这个标记
  const cfBtn = $('btnConfirmKf')
  if (cfBtn) cfBtn.onclick = async () => {
    const now = !(s.state || {}).confirmed_kf
    await api(`/api/shot/${S.ep}/${s.id}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kf: now }),
    })
    s.state = Object.assign(s.state || {}, { confirmed_kf: now })
    render()
    S.sel.clear(); S.sel.add('shot:' + s.id); refreshSel()
    toast(now ? '首帧已确认，可以出视频' : '已取消确认')
  }
}

const SHEET_GROUPS = {
  // 2026-11-06 用户定：姿势板 / 表情 / 服装细节 / 道具 这四块不再用，
  // 角色参考图统一走「生成拼接参考图」那一个按钮（4 视角 + 4 姿势 + 服装条一张图）。
  char: [
    ['turnaround', '参考图（主参考 / 拼接图）'],
  ],
  scene: [
    ['plate', '空镜 / 去人'],
    ['front', '正面'], ['right', '右侧'], ['rear', '背面'], ['left', '左侧'],
    ['wide', '广角建立镜'], ['detail', '细节'],
  ],
}

function shortPath(p) {
  const parts = String(p || '').split(/[\\/]/)
  return parts.slice(-2).join('\\')
}

function pickFile() {
  return new Promise((res) => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/*'
    inp.onchange = () => res(inp.files[0] || null)
    inp.click()
  })
}

const GROUP_OF = {
  front: 'turnaround', three_quarter: 'turnaround', side: 'turnaround',
  back: 'turnaround', closeup: 'expression', costume: 'costume',
}

function sheetBlock(owner, group, label, kind) {
  const items = (owner.sheets && owner.sheets[group]) || []
  const canGen = kind === 'char' && group === 'turnaround'
  const canGroup = kind === 'char' && ['poses', 'expression', 'costume', 'props'].includes(group)
  const grid = items.map((it, i) => `
    <div class="sheet-item">
      <img draggable="false" src="${fpath(it.path)}" title="${esc(it.label || group)}"
           data-zoom="${esc(it.path)}" style="cursor:zoom-in">
      ${it.view ? `<button data-act="regen" data-g="${group}" data-i="${i}" title="重新生成这张">↻</button>` : ''}
      <button data-act="ref" data-g="${group}" data-i="${i}" title="设为主参考">★</button>
      <button data-act="del" data-g="${group}" data-i="${i}" title="移除">×</button>
    </div>`).join('')
  return `<div class="sheet-sec">
    <div class="sheet-head"><span>${label} <b>${items.length}</b></span>
      <span>
        ${canGen && qwenEditReady() ? `<label class="mini"><input type="checkbox" data-role="pad" ${S.pad ? 'checked' : ''}> 竖版</label>` : ''}
        ${canGen && qwenEditReady() ? '<button data-act="genall" data-g="turnaround">生成多角度(3)</button>' : ''}
        ${canGroup && qwenEditReady() ? `<button data-act="gengroup" data-g="${group}">生成</button>` : ''}
        <button data-act="add" data-g="${group}">上传</button>
      </span></div>
    <div class="sheet-grid">${grid || '<span class="meta">（空）</span>'}</div>
  </div>`
}

// 点缩略图看原图：复用出首帧那个弹框里的图片区（#askImg），只留一个关闭按钮
function zoomImage(path) {
  const m = $('askModal')
  const wrap = $('askImgWrap')
  const img = $('askImg')
  const no = $('askNo')
  $('askTitle').textContent = '看大图'
  $('askBody').textContent = ''
  $('askExtra').style.display = 'none'
  $('askYes').style.display = 'none'
  $('askAgain').style.display = 'none'
  img.style.maxHeight = '74vh'
  img.style.cursor = 'zoom-out'
  img.onclick = () => no.onclick && no.onclick()
  img.src = fpath(path) + '&t=' + Date.now()
  wrap.style.display = 'block'
  no.textContent = '关闭'
  no.onclick = () => {
    m.classList.add('hidden')
    wrap.style.display = 'none'
    img.removeAttribute('src')
    img.style.maxHeight = ''
    img.style.cursor = ''
    img.onclick = null
    $('askYes').style.display = ''
    no.textContent = '取消'
    no.onclick = null
  }
  m.classList.remove('hidden')
}

function setGenStatus(text) {
  S.genStatus = text
  const el = document.getElementById('genStatus')
  if (el) el.textContent = text
}

async function genOne(kind, o, view, seed) {
  const r = await api(`/api/sheet/${S.ep}/${o.id}/${view}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: o.ref, seed: seed || 0 }),
  })
  const g = GROUP_OF[view] || 'turnaround'
  o.sheets = o.sheets || {}
  o.sheets[g] = o.sheets[g] || []
  o.sheets[g].push(r.item)
  return r
}

async function genBundle(kind, o, views, notify) {
  views = views || ['front', 'right', 'back']
  const say = (t) => { setGenStatus(t); if (notify) notify(t) }
  say(`生成中：${views.length} 个角度一次出…`)
  try {
    const r = await api(`/api/multiview/${S.ep}/${o.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: o.ref, views, full_body: true, tile: S.pad }),
    })
    const g = 'turnaround'
    o.sheets = o.sheets || {}
    o.sheets[g] = o.sheets[g] || []
    o.sheets[g].push(...r.items)
    refreshEntity(kind, o)
    say(`完成：${r.items.length} 张已进设定集`)
    return r
  } catch (e) {
    say(`✗ 失败：${String(e.message).slice(0, 160)}`)
    return null
  }
}

async function genAll(kind, o, views) {
  return genBundle(kind, o, views)
}

function toast(text, isErr) {
  const el = $('toast')
  if (!el) return
  el.textContent = text
  el.classList.toggle('err', !!isErr)
  el.classList.remove('hidden')
  if (!isErr && !/…/.test(text)) setTimeout(() => el.classList.add('hidden'), 6000)
}

// 通用任务轮询：首帧、视频共用
async function pollJob(jobId, label) {
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    let j
    try {
      j = await api('/api/job/' + jobId)
    } catch (e) {
      toast(`${label}：查询失败 ${String(e.message).slice(0, 120)}`, true)
      return null
    }
    const secs = Math.round((Date.now() - t0) / 1000)
    if (j.status === 'done') {
      toast(`${label}完成（${secs}s）`)
      await load()
      return j.result
    }
    if (j.status === 'error') {
      toast(`${label}失败：${String(j.error || '').slice(0, 220)}`, true)
      return null
    }
    toast(`${label}中… ${secs}s`)
  }
}

async function pollVideo(jobId) {
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    let j
    try {
      j = await api('/api/job/' + jobId)
    } catch (e) {
      setGenStatus('✗ 查询任务失败：' + String(e.message).slice(0, 120))
      return
    }
    const secs = Math.round((Date.now() - t0) / 1000)
    if (j.status === 'done') {
      setGenStatus(`✓ 视频完成：${(j.result && j.result.path || '').split(/[\\/]/).pop()}（${secs}s）`)
      await load()
      return
    }
    if (j.status === 'error') {
      const msg = String(j.error || '失败')
      setGenStatus('✗ ' + msg.slice(0, 300))
      showModal('出视频失败 · ' + j.engine, msg)   // 只写一行小字用户根本看不见
      return
    }
    setGenStatus(`生成中… ${secs}s（${j.engine}${j.progress ? ' · ' + j.progress : ''}）`)
  }
}

function selectGen(label, group, value) {
  const opts = (S.vocab && S.vocab[group]) || [['', '自动']]
  const cur = value || ''
  return `<div class="field"><label>${label}</label>
    <select data-gen="${group}">${opts.map(([k, zh]) =>
      `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(zh)}</option>`).join('')}</select></div>`
}

function genBlock(o) {
  const gen = o.gen || {}
  return `<div class="sheet-sec">
    <div class="sheet-head"><span>造一张空镜</span><button class="primary" data-act="plate">生成空镜</button></div>
    <div class="row">${selectGen('时间', 'time', gen.time)}${selectGen('天气', 'weather', gen.weather)}</div>
    <div class="row">${selectGen('光', 'light', gen.light)}${selectGen('色调', 'tone', gen.tone)}</div>
    ${field('补充（中文即可，可空，会自动翻英文）', gen.note, null, { role: 'gen.note' })}
    ${o.ref && qwenEditReady() ? '<button class="ghost" data-act="clean" style="width:100%;margin-top:2px">把主参考里的人去掉</button>' : ''}
    <div class="meta">场景内容以顶部「空间」为准（中文即可），这里只补时间/天气/光/色调。</div>
    <div class="meta">空镜不含人。参考图里一旦有人影，出图会把它当场景元素搬进画面。</div>
  </div>`
}

function entityPanel(kind, o, fieldDefs, note) {
  if (!o) return
  const groups = SHEET_GROUPS[kind]
  const title = kind === 'char' ? '角色' : '场景'
  insp.innerHTML = `<h3>${title} · ${esc(o.name || o.id)}</h3>
    ${kind === 'char'
      ? '<button class="ghost" data-act="delchar" style="color:#e8615a;font-size:11px;padding:2px 8px">删除这个角色</button>'
      : '<button class="ghost" data-act="delscene" style="color:#e8615a;font-size:11px;padding:2px 8px">删除这个场景</button>'}
    ${fieldDefs.map(([label, key, ta]) => field(label, o[key], null, { role: key, textarea: ta })).join('')}
    ${kind === 'char' ? `<div class="field"><label>生成这张参考图用的画风</label>
      <select data-entity-pick="style">
        ${(S.styles || []).map((st) => `<option value="${st.id}"${(o.style || '') === st.id ? ' selected' : ''}>${esc(st.zh)}</option>`).join('')}
        <option value=""${!o.style ? ' selected' : ''}>（没记录）</option>
      </select>
      <div class="meta">只记录这张图当初用的画风，改它不会改变已经出好的图。</div></div>
    <div class="field"><label>生成这张参考图用的种子</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input data-entity-pick="seed" type="text" style="flex:1" value="${esc(String(o.seed || ''))}" placeholder="没记录">
        <button type="button" class="ghost" data-act="entrandseed" style="padding:1px 9px;font-size:11px;flex:none">随机</button>
      </div></div>` : ''}
    ${kind === 'scene' ? genBlock(o) : ''}
    <div class="sheet-sec">
      <div class="sheet-head"><span>主参考 <b>${o.ref ? '已设' : '未设'}</b></span>
        <button class="primary" data-act="addref">上传并设为主参考</button></div>
      ${kind === 'char'
        ? `<button class="ghost" data-act="textref" style="width:100%;margin-top:6px">用文字生成主参考图（填了外观/服装才能用）</button>
           <div class="row" style="margin-top:6px;gap:6px">
             <input type="text" id="jobIdBox" placeholder="ComfyUI 任务 ID（粘进来即可）" style="flex:1">
             <button class="ghost" data-act="importjob">导入人设/种子</button>
           </div>
           <button class="primary" data-act="refsheet" style="width:100%;margin-top:6px">生成拼接参考图（4 视角+4 姿势+服装 · 只用文字人设+种子）</button>`
        : ''}
      <div class="meta" style="word-break:break-all">${o.ref ? esc(shortPath(o.ref)) : '生成前必须先设一张主参考'}</div>
    </div>
    ${groups.map(([g, label]) => sheetBlock(o, g, label, kind)).join('')}
    <div id="genStatus" class="meta" style="margin-top:8px">${esc(S.genStatus || '')}</div>
    <div class="note">${note}</div>`

  bindFields(async (role, value) => {
    // 角色只留一个「人物长什么样」框：写进 look，同时把老的 outfit / props 清空，
    // 不然同一段描述会在提示词里出现两遍。
    const patch = (kind === 'char' && role === 'look')
      ? { look: value, outfit: '', props: '' }
      : { [role]: value }
    await saveEntity(kind, o, patch)
    o[role] = value
    if (kind === 'char' && role === 'look') { o.outfit = ''; o.props = '' }
    render()
    renderAssets()
    S.sel.clear(); S.sel.add(`${kind === 'char' ? 'char' : 'scene'}:${o.id}`)
    refreshSel()
  })

  // 画风 / 种子：只做记录，让卡片和「新建角色」弹窗的信息对得上
  // 缩略图点开看原图（不然 190×268 的小图根本看不出细节）
  insp.querySelectorAll('img[data-zoom]').forEach((el) => {
    el.onclick = () => zoomImage(el.dataset.zoom)
  })

  const pickStyle = insp.querySelector('[data-entity-pick="style"]')
  if (pickStyle) pickStyle.onchange = async () => {
    await saveEntity(kind, o, { style: pickStyle.value })
    o.style = pickStyle.value || ''
    toast(pickStyle.value ? '已记录画风' : '清掉了画风记录')
  }
  const pickSeed = insp.querySelector('[data-entity-pick="seed"]')
  if (pickSeed) pickSeed.onchange = async () => {
    const v = Number(pickSeed.value) || 0
    await saveEntity(kind, o, { seed: v })
    o.seed = v
    toast(v ? `已记录种子 ${v}` : '清掉了种子记录')
  }
  const entRand = insp.querySelector('[data-act="entrandseed"]')
  if (entRand) entRand.onclick = async () => {
    const n = Math.floor(Math.random() * 4294967295)
    if (pickSeed) pickSeed.value = String(n)
    await saveEntity(kind, o, { seed: n })
    o.seed = n
    toast(`种子记成 ${n}`)
  }

  // 场景空镜的选项目：写进 scene.gen
  insp.querySelectorAll('select[data-gen]').forEach((sel) => {
    sel.onchange = async () => {
      const gen = { ...(o.gen || {}), [sel.dataset.gen]: sel.value }
      await api(`/api/scene/${S.ep}/${o.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gen }),
      })
      o.gen = gen
    }
  })
  const noteBox = insp.querySelector('[data-role="gen.note"]')
  if (noteBox) noteBox.onchange = async () => {
    const gen = { ...(o.gen || {}), note: noteBox.value }
    await api(`/api/scene/${S.ep}/${o.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gen }),
    })
    o.gen = gen
  }

  const padBox = insp.querySelector('input[data-role="pad"]')
  if (padBox) padBox.onchange = () => { S.pad = padBox.checked }

  insp.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation()
      const g = btn.dataset.g
      const i = Number(btn.dataset.i)
      o.sheets = o.sheets || {}
      o.sheets[g] = o.sheets[g] || []

      if (btn.dataset.act === 'plate' || btn.dataset.act === 'clean') {
        const isClean = btn.dataset.act === 'clean'
        if (isClean && !o.ref) { setGenStatus('先设一张主参考图'); return }
        btn.disabled = true
        const old = btn.textContent
        btn.textContent = isClean ? '去人中…' : '生成中…'
        setGenStatus(isClean ? '把主参考里的人擦掉…' : '造空镜…')
        try {
          const r = await api(`/api/scene/${S.ep}/${o.id}/${isClean ? 'clean' : 'plate'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isClean ? {} : { gen: o.gen || {} }),
          })
          if (r.scene) { Object.assign(o, r.scene) }
          else {
            o.sheets = o.sheets || {}
            o.sheets.plate = o.sheets.plate || []
            o.sheets.plate.push({ path: r.path, label: isClean ? '去人' : '空镜', seed: r.seed })
          }
          await load()
          S.sel.clear(); S.sel.add('scene:' + o.id); refreshSel()
          setGenStatus(`完成：${shortPath(r.path)}${r.set_as_ref ? '（已设为主参考）' : ''}`)
        } catch (e) {
          setGenStatus(`✗ 失败：${String(e.message).slice(0, 160)}`)
        } finally {
          btn.disabled = false
          btn.textContent = old
        }
        return
      }

      if (btn.dataset.act === 'delchar') {
        if (!confirm(`删除角色「${o.name || o.id}」？镜头里的绑定也会一起摘掉。`)) return
        try {
          await api(`/api/character/${S.ep}/${o.id}`, { method: 'DELETE' })
          await load()
        } catch (e) { alert('删除失败：' + e.message) }
        return
      }

      if (btn.dataset.act === 'delscene') {
        if (!confirm(`删除场景「${o.name || o.id}」？镜头里对它的绑定也会一起摘掉。`)) return
        try {
          await api(`/api/scene/${S.ep}/${o.id}`, { method: 'DELETE' })
          await load()
        } catch (e) { alert('删除失败：' + e.message) }
        return
      }

      if (btn.dataset.act === 'textref') {
        if (!(o.look || o.outfit)) { setGenStatus('先在「人物长什么样」里写点内容，文字生图要用'); return }
        btn.disabled = true
        const old = btn.textContent
        btn.textContent = '生成中…'
        // 种子用面板上「生成这张参考图用的种子」那个框：填了就复现，
        // 空着就每张都不一样——只改一处描述重出时，靠它把其余部分钉住。
        const seedInp = insp.querySelector('[data-entity-pick="seed"]')
        const seed = Number(seedInp && seedInp.value) || 0
        // 画风也从下拉现读：别指望 onchange 一定先于这次点击落盘
        const styleSel2 = insp.querySelector('[data-entity-pick="style"]')
        const style = styleSel2 ? styleSel2.value : ''
        setGenStatus(seed ? `文字生主参考图（种子 ${seed}）` : '文字生主参考图（种子随机）')
        try {
          const r = await api(`/api/character/${S.ep}/${o.id}/textref`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seed, style }),
          })
          o.ref = r.path
          o.sheets = o.sheets || {}
          o.sheets.turnaround = [{ path: r.path, label: '文字生图' },
            ...(o.sheets.turnaround || [])]
          // 一次把 ref / 图组 / 种子 / 画风全写回（saveEntity 会同步内存），
          // 否则重新渲染时这三样都还是旧的
          await saveEntity(kind, o, {
            ref: r.path, sheets: o.sheets,
            seed: r.seed || 0, style: r.style || o.style || '',
          })
          refreshEntity(kind, o)
          setGenStatus(`主参考图已生成 · 种子 ${r.seed || 0} · 画风 ${r.style || ''}`)
        } catch (e) {
          setGenStatus('✗ ' + String(e.message).slice(0, 200))
          btn.disabled = false
          btn.textContent = old
        }
        return
      }

      if (btn.dataset.act === 'gengroup') {
        const grp = btn.dataset.g
        if (!o.ref) { setGenStatus('先上传一张主参考图'); return }
        btn.disabled = true
        const old = btn.textContent
        btn.textContent = '生成中…'
        setGenStatus(`生成 ${grp}：一次提交出整组`)
        try {
          const r = await api(`/api/sheetgen/${S.ep}/${o.id}/${grp}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: o.ref }),
          })
          o.sheets = o.sheets || {}
          o.sheets[grp] = o.sheets[grp] || []
          o.sheets[grp].push(...r.items)
          refreshEntity(kind, o)
          setGenStatus(`完成：${r.items.length} 张已进「${grp}」`)
        } catch (e) {
          setGenStatus(`✗ 失败：${String(e.message).slice(0, 160)}`)
        } finally {
          btn.disabled = false
          btn.textContent = old
        }
        return
      }

      if (btn.dataset.act === 'addref') {
        const file = await pickFile()
        if (!file) return
        const fd = new FormData()
        fd.append('f', file)
        const up = await fetch(`/api/upload/${S.ep}?tag=${kind}_ref`, { method: 'POST', body: fd }).then((r) => r.json())
        const firstGroup = kind === 'char' ? 'turnaround' : 'front'
        o.sheets = o.sheets || {}
        o.sheets[firstGroup] = o.sheets[firstGroup] || []
        o.sheets[firstGroup].push({ path: up.path, label: '上传' })
        o.ref = up.path
        await saveEntity(kind, o, { ref: o.ref, sheets: o.sheets })
        refreshEntity(kind, o)
        // 2026-11-06 起不再自动生成三视角（默认改由用户点「生成全部视角」）
        return
      }

      if (btn.dataset.act === 'importjob') {
        const box = document.getElementById('jobIdBox')
        const pid = (box && box.value || '').trim()
        if (!pid) { setGenStatus('先粘贴 ComfyUI 的任务 ID'); return }
        btn.disabled = true
        try {
          const r = await api(`/api/character/${S.ep}/${o.id}/importjob`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: pid }),
          })
          setGenStatus(`已导入：种子 ${r.seed || '(没读到)'}，提示词 ${(r.prompt || '').length} 字`)
          render(); renderAssets()
        } catch (e) {
          setGenStatus('✗ ' + String(e.message).slice(0, 200))
        } finally {
          btn.disabled = false
        }
        return
      }

      if (btn.dataset.act === 'refsheet') {
        const old = btn.textContent
        btn.disabled = true
        btn.textContent = '生成中…'
        setGenStatus('正在跑 4 视角 + 4 姿势 + 服装条…')
        try {
          const r = await api(`/api/refsheet/${S.ep}/${o.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          o.ref = r.path
          o.sheets = { turnaround: [{ path: r.path, label: '拼接' }] }
          setGenStatus('拼接参考图已生成并设为主参考')
          render(); renderAssets()
        } catch (e) {
          setGenStatus('✗ ' + String(e.message).slice(0, 200))
        } finally {
          btn.disabled = false
          btn.textContent = old
        }
        return
      }

      if (btn.dataset.act === 'add') {
        const file = await pickFile()
        if (!file) return
        const fd = new FormData()
        fd.append('f', file)
        const up = await fetch(`/api/upload/${S.ep}?tag=${kind}_${g}`, { method: 'POST', body: fd }).then((r) => r.json())
        const fresh = !o.ref
        o.sheets[g].push({ path: up.path, label: g })
        if (fresh) o.ref = up.path                 // 第一张上传图直接当主参考
        await saveEntity(kind, o, { sheets: o.sheets, ref: o.ref })
        refreshEntity(kind, o)
        // 2026-11-06：不再自动生成三视角
        return
      }

      if (btn.dataset.act === 'genall') {
        if (!o.ref) { setGenStatus('先上传一张正脸或半身图当主参考'); return }
        genBundle(kind, o, ['front', 'right', 'back'])
        return
      }

      if (btn.dataset.act === 'regen') {
        const it = o.sheets[g][i]
        const view = it && it.view
        if (!view) { setGenStatus('这张不是生成的，没法重生成'); return }
        setGenStatus(`重新生成：${view}`)
        try {
          o.sheets[g].splice(i, 1)
          await saveEntity(kind, o, { sheets: o.sheets })
          await genBundle(kind, o, [view])
        } catch (err) {
          setGenStatus(`✗ ${view} 失败：${String(err.message).slice(0, 120)}`)
        }
        return
      }

      if (btn.dataset.act === 'del') {
        o.sheets[g].splice(i, 1)
        await saveEntity(kind, o, { sheets: o.sheets })
      } else if (btn.dataset.act === 'ref') {
        o.ref = o.sheets[g][i].path
        await saveEntity(kind, o, { ref: o.ref })
      }
      refreshEntity(kind, o)
    }
  })
}

function refreshEntity(kind, o) {
  render()
  renderAssets()
  S.sel.clear(); S.sel.add(`${kind === 'char' ? 'char' : 'scene'}:${o.id}`)
  refreshSel()
}

async function saveEntity(kind, o, patch) {
  const url = kind === 'char' ? `/api/character/${S.ep}/${o.id}` : `/api/scene/${S.ep}/${o.id}`
  await api(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  // 存完必须同步内存：面板拿到的是对象拷贝（比如 charPanel 传的是 {...c}），
  // 只改拷贝的话，后端已经更新了、重新渲染却还从 S.data 读旧值，
  // 表现就是「生成完了但下拉弹回原来那个、图也不换」。
  const arr = kind === 'char' ? (S.data.characters || []) : (S.data.scenes || [])
  const real = arr.find((x) => x.id === o.id)
  if (real) Object.assign(real, patch)
  Object.assign(o, patch)
}

function charPanel(c) {
  // 外观 / 服装 / 道具本来就会被后端拼成一段（prompts.py 的 detail_parts），
  // 拆三个框只是让人多点三次。合并成一个「人物长什么样」，保存时写进 look 并把另外两个清空，
  // 否则后端会把同一段内容重复拼两遍。
  const merged = [c.look, c.outfit, c.props]
    .map((x) => String(x || '').trim()).filter(Boolean).join('\n')
  entityPanel('char', { ...c, look: merged }, [
    ['名字', 'name'],
    ['人物长什么样（外观 · 服装 · 道具，写中文就行）', 'look', true],
  ])
}

function scenePanel(s) {
  entityPanel('scene', s, [
    ['名字', 'name'],
    ['空间（中文即可，自动翻英文）', 'look', true],
    ['光（英文）', 'light'],
  ], '同一集里场景的光向要一致；四向图用来对位，不直接进提示词。')
}

function mediaPanel(s, type, runIdx) {
  if (!s) return
  const st = s.state || {}
  let p = type === 'kf' ? st.kf : st.video
  let seed = st.video_seed
  if (type === 'vid' && runIdx >= 0) {
    const r = videoRuns(s)[runIdx]
    if (r) { p = r.path; seed = r.seed }
  }
  const media = type === 'kf'
    ? `<img draggable="false" src="${fpath(p)}" style="width:100%;border-radius:6px">`
    : `<video src="${fpathLive(p)}" controls style="width:100%;border-radius:6px"></video>`
  insp.innerHTML = `<h3>${type === 'kf' ? '首帧' : '视频'} · ${esc(s.id)}</h3>${media}
    <div class="field" style="margin-top:10px"><label>文件</label><div class="meta" style="word-break:break-all">${esc(p)}</div></div>
    ${type === 'vid' ? `<div class="field"><label>时长 / 引擎</label><div class="meta">${st.video_seconds || '?'}s · ${st.video_engine || '?'}</div></div>` : ''}
    <div class="actions"><button class="primary" id="btnOpen">在文件夹里打开</button></div>`
  $('btnOpen').onclick = () => showModal('文件路径', p)
}

// ---------------------------------------------------------------- 弹窗
function showModal(title, body, foot) {
  $('modalTitle').textContent = title
  $('modalBody').textContent = body
  const f = $('modalFoot')
  if (f) { f.textContent = foot || ''; f.style.display = foot ? '' : 'none' }
  $('modal').classList.remove('hidden')
}
$('modalClose').onclick = () => $('modal').classList.add('hidden')
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden') }

// 可滚动的确认框：原生长 confirm() 会把长提示词截断、还没法滚动，
// 用户看到的就是"这不是我粘的东西"（2026-11-04 实际踩到）。返回 Promise<boolean>。
function askConfirm(title, body, yesText, opts) {
  return new Promise((resolve) => {
    const m = $('askModal')
    $('askTitle').textContent = title
    $('askBody').textContent = body
    $('askYes').textContent = yesText || '开始生成'
    const o = opts || {}
    const extra = $('askExtra')
    const secRow = $('askSecRow')
    const seedRow = $('askSeedRow')
    let anyExtra = false
    if (o.seconds) {
      // H3 合法帧数 17k+5，训练区间 124–362 → 下拉只给这些帧数对应的秒
      const sel = $('askSeconds')
      if (!sel.options.length) {
        for (let f = 39; f <= 362; f += 17) {
          const sec = (f / 24).toFixed(2)
          const op = document.createElement('option')
          op.value = String(f)
          op.textContent = `${sec} 秒 · ${f} 帧`
          sel.appendChild(op)
        }
      }
      let want = Math.round(Number(o.seconds) * 24)
      want = Math.max(39, Math.min(362, Math.round((want - 5) / 17) * 17 + 5))
      sel.value = String(want)
      secRow.style.display = 'flex'
      anyExtra = true
    } else {
      secRow.style.display = 'none'
    }
    if (o.seed) {
      // 出首帧这类「一次一张」的任务：留空 = 随机，填了就复现
      const inp = $('askSeed')
      inp.value = o.seedValue != null ? String(o.seedValue) : ''
      seedRow.style.display = 'flex'
      $('askSeedRand').onclick = () => {
        inp.value = String(Math.floor(Math.random() * 4294967295))
        inp.focus()
      }
      anyExtra = true
    } else {
      seedRow.style.display = 'none'
    }
    extra.style.display = anyExtra ? 'flex' : 'none'
    m.classList.remove('hidden')
    const done = (v) => {
      m.classList.add('hidden')
      $('askYes').onclick = null
      $('askNo').onclick = null
      resolve(v)
    }
    $('askYes').onclick = () => done(true)
    $('askNo').onclick = () => done(false)
  })
}

// ---------------------------------------------------------------- 出首帧弹框
// 点「出首帧」→ 弹框里先看提示词 → 生成 → 图直接显示在框里 →
// 不满意就改种子点「换一张」→ 满意了按「用这张作为首帧」才关框并确认。
// 为什么不在框外生成：以前生成完框就关了，用户既看不到图满不满意，
// 也换不了种子，只能关掉再点一次。
async function openFrameGen(ep, sid) {
  const m = $('askModal')
  const imgWrap = $('askImgWrap')
  const img = $('askImg')
  const yes = $('askYes')
  const no = $('askNo')
  const again = $('askAgain')
  let generated = ''
  let busy = false

  $('askTitle').textContent = `出首帧 · ${sid}`
  $('askBody').textContent = '正在取提示词…'
  $('askExtra').style.display = 'none'
  imgWrap.style.display = 'none'
  img.removeAttribute('src')
  again.style.display = 'none'
  yes.textContent = '开始生成'
  yes.disabled = true
  no.textContent = '关闭'
  m.classList.remove('hidden')

  try {
    await flushSaves()
    const prev = await api(`/api/prompt/${ep}/${sid}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fl2v' }),
    })
    const txt = String((prev && prev.image) || '')
    $('askBody').textContent =
      `图片提示词（${txt.length} 字符）：\n${'─'.repeat(40)}\n${txt}\n${'─'.repeat(40)}\n\n` +
      '这段只进「生成首帧图」，不影响出片。\n' +
      '种子在右侧面板「出图种子」框里改，留空 = 每次都不一样。'
    $('askExtra').style.display = 'flex'
    $('askSecRow').style.display = 'none'
    $('askSeedRow').style.display = 'none'
  } catch (e) {
    $('askBody').textContent = '取提示词失败：' + String(e.message).slice(0, 300)
  }
  yes.disabled = false

  const close = () => {
    m.classList.add('hidden')
    yes.onclick = null
    no.onclick = null
    again.onclick = null
    imgWrap.style.display = 'none'
    img.removeAttribute('src')
    again.style.display = 'none'
    yes.textContent = '开始生成'
    no.textContent = '取消'
  }

  const doGen = async () => {
    if (busy) return
    busy = true
    const inp = $('kfSeed')
    const seed = Number(inp && inp.value) || 0
    yes.disabled = true
    again.disabled = true
    yes.textContent = '生成中…'
    try {
      const r = await api(`/api/shot/${ep}/${sid}/frame`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
      })
      const res = await pollJob(r.job, '出首帧')
      if (res && res.path) {
        generated = res.path
        img.src = '/api/file?path=' + encodeURIComponent(generated)
        imgWrap.style.display = 'block'
        again.style.display = ''
        yes.textContent = '用这张作为首帧'
      } else {
        yes.textContent = '重试'
      }
    } catch (e) {
      showModal('出首帧失败', String(e.message).slice(0, 500))
      yes.textContent = '重试'
    } finally {
      busy = false
      yes.disabled = false
      again.disabled = false
    }
  }

  yes.onclick = async () => {
    if (!generated) { doGen(); return }
    try {
      await api(`/api/shot/${ep}/${sid}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kf: true }),
      })
      toast('已设为这一镜的首帧')
      close()
      await load()
    } catch (e) {
      showModal('确认失败', String(e.message).slice(0, 300))
    }
  }

  again.onclick = () => {
    generated = ''
    imgWrap.style.display = 'none'
    img.removeAttribute('src')
    again.style.display = 'none'
    yes.textContent = '开始生成'
    doGen()
  }

  no.onclick = () => close()
}

// ---------------------------------------------------------------- 新建素材卡（角色 / 场景 / 道具）
// 2026-11-09 用户要求：入口合并——顶栏那三个「生成」按钮删掉，统一从左栏「新建」进来。
// 弹窗一次给全：名字 + 提示词 + 画风。点「生成」= 建卡 + 生成图 + 直接把这张图设为主参考；
// 点「跳过」= 只建空卡（之后可以在卡面板里上传参考图或文字生成）。
let genKind = 'character'        // 卡片类型：character / scene / prop
let genCardId = ''               // 已建好的卡 id（「再来一张」复用同一张卡）
let genLast = null
const GEN_ENDPOINT = { character: 'character', scene: 'background', prop: 'prop' }
const GEN_STYLE_DEFAULT = { character: 'semireal', scene: 'photoreal', prop: 'semireal' }
const GEN_LABEL = { character: '角色', scene: '场景', prop: '道具' }
// 每种素材的输入提示都不一样：角色只写人和穿着，场景只写空间/材质/光，道具只写这一件。
// 以前三类共用角色那句示例，建场景时会把人往"写个人"带偏（2026-11-09 用户指出）。
const GEN_TEXT = {
  character: {
    namePh: '例：林小满',
    label: '人物长什么样（中文即可，越具体越好）',
    ph: '例：二十岁出头的年轻女子，黑长发，酒红织金齐胸长裙，金色发簪，赤足',
    note: '只写人和穿着。全身、纯色背景、正面站姿这些模型已经按角色卡拼好，不用重复写。',
  },
  scene: {
    namePh: '例：废旧健身房',
    label: '这个地方长什么样（不写人）',
    ph: '例：废旧健身房，锈蚀钢管沿两侧墙走，钢格栅走道，顶上一盏灯亮一盏灭，地胶磨得发白',
    note: '写空间、材质、陈设和光。不要写人，画面里不出现人。',
  },
  prop: {
    namePh: '例：银色活动扳手',
    label: '这件东西长什么样（只写这一件）',
    ph: '例：一把银色活动扳手，钢制，手柄缠黑色胶带，表面有使用划痕',
    note: '只写这一件道具的材质和尺寸。不要手、不要人。',
  },
}
const genStylePref = {}          // 每种素材上次选的画风，本页内记住（不写数据）

// 角色图是纯灰底的全身像，用不上「CG 人物 + 实拍背景」这类带场景的画风，
// 选了只会让模型去编一个背景。这里只在「新建角色」弹窗里过滤掉，别处不动。
const GEN_STYLE_SKIP = { character: new Set(['cgphoto']) }

function fillStyleSelect(sel) {
  if (!sel || sel.dataset.filled === '1') return
  const skip = GEN_STYLE_SKIP[genKind] || new Set()
  const styles = (S.styles || []).filter((s) => !skip.has(s.id))
  sel.innerHTML = styles.map((s) => `<option value="${s.id}">${esc(s.zh || s.id)}</option>`).join('')
  sel.dataset.filled = '1'
}

function updateGenStyleNote() {
  const sel = $('genStyle')
  if (!sel) return
  const s = (S.styles || []).find((x) => x.id === sel.value)
  $('genStyleNote').textContent = s && s.note ? s.note : ''
}

function openCreate(kind) {
  genKind = kind
  genCardId = ''
  genLast = null
  $('genTitle').textContent = '新建' + (GEN_LABEL[kind] || '素材')
  const t = GEN_TEXT[kind] || GEN_TEXT.character
  $('genName').placeholder = t.namePh
  $('genTextLabel').textContent = t.label
  $('genText').placeholder = t.ph
  $('genTextNote').textContent = t.note
  fillStyleSelect($('genStyle'))
  const saved = ((S.data.project || {}).gen_style || {})[kind]
  const want = genStylePref[kind] || saved || GEN_STYLE_DEFAULT[kind] || 'semireal'
  // 被过滤掉的画风（比如角色的 cgphoto）不能当默认值，否则下拉会停在第一项、看着像没选
  const skip = GEN_STYLE_SKIP[kind] || new Set()
  $('genStyle').value = skip.has(want) ? 'semireal' : want
  updateGenStyleNote()
  $('genName').value = ''
  $('genText').value = ''
  $('genSeed').value = ''
  $('genSeedNote').textContent = '留空：每次点生成都换新种子；填数字：固定用这个种子（同提示词能复现同一张）。'
  $('genStatus').textContent = ''
  $('genPreview').style.display = 'none'
  $('genConfirm').disabled = true
  $('genGoSheet').style.display = kind === 'character' ? '' : 'none'
  $('genGoSheet').disabled = false
  $('genModal').classList.remove('hidden')
  $('genName').focus()
}

// 只建卡不生成图
async function createEmptyCard() {
  const name = $('genName').value.trim()
  if (!name) { $('genStatus').textContent = '先给个名字'; $('genName').focus(); return }
  const url = {
    character: `/api/character/${S.ep}`, scene: `/api/scene/${S.ep}`, prop: `/api/prop/${S.ep}`,
  }[genKind]
  $('genSkip').disabled = true
  try {
    const r = await api(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const card = r.character || r.scene || r.prop || {}
    await load()
    renderAssets()
    if (genKind !== 'prop' && card.id) { S.sel.clear(); S.sel.add(genKind + ':' + card.id); refreshSel() }
    $('genModal').classList.add('hidden')
    toast('已建卡：' + (card.name || card.id))
  } catch (e) {
    $('genStatus').textContent = '✗ ' + String(e.message).slice(0, 200)
  } finally {
    $('genSkip').disabled = false
  }
}

// 生成图并挂成这张卡的主参考（第一次建卡；之后「再来一张」复用同一张卡）
// 只生成图，不建卡；满意后点「确认」才把这张挂成该卡的主参考。
async function generateForCard(mode = 'single') {
  const name = $('genName').value.trim()
  if (!name) { $('genStatus').textContent = '先给个名字'; $('genName').focus(); return }
  const text = $('genText').value.trim()
  if (text.length < 2) { $('genStatus').textContent = '先写「要生成成什么样」'; return }
  const style = $('genStyle').value || ''
  genStylePref[genKind] = style
  let seed = 0
  const raw = $('genSeed').value.trim()
  if (raw) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
      $('genStatus').textContent = '种子要填 0 ~ 4294967295 的整数，留空表示随机'
      $('genSeed').focus()
      return
    }
    seed = n
  }
  const t0 = Date.now()
  $('genGo').disabled = true
  $('genGoSheet').disabled = true
  $('genSkip').disabled = true
  $('genConfirm').disabled = true
  $('genStatus').textContent = mode === 'sheet'
    ? '已提交：四视角图（慢），一张出四个角度，正在生成…'
    : '已提交：单图（快），正在生成…'
  try {
    const g = await api('/api/gen/' + GEN_ENDPOINT[genKind], {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // ep 必须带上：服务端按项目的横竖屏定出图尺寸，不带就只能猜
      body: JSON.stringify({ text, seed: seed || 0, style, ep: S.ep, mode }),
    })
    genLast = g
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    $('genImg').src = g.url + '&t=' + Date.now()
    $('genPreview').style.display = 'block'
    $('genPath').textContent = '路径：' + g.path
    $('genStatus').textContent = `已生成${mode === 'sheet' ? '（四视角图）' : '（单图）'} · 用时 ${secs} 秒 · 画风 ${g.style_zh || g.style} · 种子 ${g.seed} —— 满意就点下面「确认」`
    $('genSeedNote').textContent = `上一次用的种子：${g.seed}（填回上面的框就能复现）`
    $('genConfirm').disabled = false
  } catch (e) {
    $('genStatus').textContent = '✗ ' + String(e.message).slice(0, 200)
  } finally {
    $('genGo').disabled = false
    $('genGoSheet').disabled = false
    $('genSkip').disabled = false
  }
}

// 确认：把刚才这张设成该卡的主参考（第一次=建卡；之后再确认=更新同一张卡）
async function confirmCard() {
  if (!genLast || !genLast.path) { $('genStatus').textContent = '先生成一张图'; return }
  const name = $('genName').value.trim()
  if (!name) { $('genStatus').textContent = '先给个名字'; $('genName').focus(); return }
  $('genConfirm').disabled = true
  $('genGo').disabled = true
  $('genSkip').disabled = true
  $('genStatus').textContent = '正在写入…'
  try {
    const a = await api('/api/adopt-gen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: genKind, ep: S.ep, path: genLast.path, name,
                             prompt: genLast.prompt || '', seed: genLast.seed || 0,
                             style: genLast.style || '',
                             look: $('genText').value.trim(),
                             id: genCardId || '', reuse: !!genCardId }),
    })
    genCardId = a.id
    await load()
    renderAssets()
    if (genKind !== 'prop') { S.sel.clear(); S.sel.add(genKind + ':' + a.id); refreshSel() }
    $('genStatus').textContent = `已设为主参考：卡 ${a.id}${a.updated ? '（更新了原卡）' : ''}`
    toast('已设为主参考：' + (name || a.id))
    // 这张已经选定了，弹窗里再「重 roll / 再来一张」没有意义：直接关掉，回画布看卡。
    $('genModal').classList.add('hidden')
  } catch (e) {
    $('genStatus').textContent = '✗ ' + String(e.message).slice(0, 200)
  } finally {
    $('genConfirm').disabled = false
    $('genGo').disabled = false
    $('genSkip').disabled = false
  }
}

$('genStyle').onchange = async () => {
  const val = $('genStyle').value
  genStylePref[genKind] = val
  updateGenStyleNote()
  // 记到项目里，下次打开还是这个画风（记不住也不影响生成本身）
  try {
    const next = { ...((S.data.project || {}).gen_style || {}), [genKind]: val }
    await api(`/api/project/${S.ep}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gen_style: next }),
    })
    S.data.project.gen_style = next
  } catch (e) { /* 忽略 */ }
}
$('genClose').onclick = () => $('genModal').classList.add('hidden')
$('genGo').onclick = () => generateForCard('single')
$('genGoSheet').onclick = () => generateForCard('sheet')
$('genConfirm').onclick = confirmCard
$('genSkip').onclick = createEmptyCard
$('genSeedRand').onclick = () => {
  $('genSeed').value = String(Math.floor(Math.random() * 1_000_000_007))
  $('genSeedNote').textContent = '已抽一个种子填进去；不想锁死就清空它。'
}

// ---------------------------------------------------------------- 保存布局
let saveTimer = null
function scheduleSave() {
  S.dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveLayout, 600)
}

async function saveLayout() {
  try {
    await api(`/api/project/${S.ep}/canvas`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewport: S.view, nodes: S.pos }),
    })
    S.dirty = false
  } catch (e) {
    console.warn('布局保存失败', e)
  }
}

// ---------------------------------------------------------------- 设置（ComfyUI 路径 / 权重文件 / LLM 翻译）

function renderEnvReport(r) {
  const row = (name, okText, badText, ok) =>
    `<div style="margin:2px 0">${ok ? '✔' : '✘'} <b>${name}</b> ${ok ? esc(okText) : esc(badText)}</div>`
  const srcTag = { setting: '你选的', auto: '自动探测', env: '环境变量' }[r.root_source] || ''
  const tag = srcTag ? ` <span style="opacity:.6">[${esc(srcTag)}]</span>` : ''
  const parts = []
  if (r.build) {
    parts.push(row('画布版本', (r.build.commit || '非 git 安装') + (r.build.built ? '（' + r.build.built + ' 更新）' : ''), '', true))
  }
  if (r.root) {
    parts.push(`<div style="margin:2px 0">✔ <b>目录</b>${tag} ${esc(r.root)}`
      + (r.root_note ? `<br><span style="opacity:.7;margin-left:14px">${esc(r.root_note)}</span>` : '')
      + '</div>')
  } else {
    parts.push(`<div style="margin:2px 0">✘ <b>目录</b>${tag} ${esc(r.root_note || '没找到 —— 点「浏览…」选 ComfyUI 文件夹')}</div>`)
  }
  parts.push(row('服务', r.device || '在线', `连不上 ${r.url} —— ComfyUI 没开？`, !!r.online))
  if (r.vram && r.vram.total_gb) {
    const low = r.vram.total_gb < 12
    parts.push(`<div style="margin:2px 0">${low ? '⚠' : '✔'} <b>显存</b> ${r.vram.total_gb} GB`
      + `（空闲 ${r.vram.free_gb} GB）`
      + (low ? ' —— 偏低，H3 出片很可能 OOM：给 ComfyUI 加 <code>--lowvram</code>，详见 README「显存不够（OOM）」' : '')
      + '</div>')
  }
  if (r.root) {
    const bad = Object.keys(r.dirs || {}).filter((d) => !r.dirs[d])
    parts.push(row('子目录', 'models / input / output 都在', '缺：' + bad.join('、'), bad.length === 0))
  }
  const miss = (r.models || []).filter((m) => !m.exist)
  if (!miss.length) {
    parts.push(row('权重', `${(r.models || []).length} 个文件都在`, '', true))
  } else {
    parts.push(`<div style="margin:6px 0 2px">✘ <b>权重</b> 缺 ${miss.length} 个：</div>`)
    parts.push('<div style="margin-left:14px">' + miss.map((m) =>
      `<div style="margin:2px 0">· ${esc(m.note)}<br><span style="opacity:.7">models\\${esc(m.subdir)}\\${esc(m.file)}</span></div>`
    ).join('') + '</div>')
  }
  const hfLinks = (m) => {
    const t = []
    if (m.hf) t.push(`<a href="${esc(m.hf)}" target="_blank" rel="noopener">HF 下载</a>`)
    if (m.mirror) t.push(`<a href="${esc(m.mirror)}" target="_blank" rel="noopener">hf-mirror 镜像</a>`)
    return t.join(' · ')
  }
  if (r.ram && r.ram.total_gb) {
    parts.push(`<div style="margin:2px 0">✔ <b>内存</b> ${r.ram.total_gb} GB（可用 ${r.ram.free_gb} GB）</div>`)
  }
  if (r.vram && r.vram.total_gb && r.vram.total_gb < 12) {
    const _ram = (r.ram || {}).total_gb || 0
    if (_ram >= 48) {
      parts.push(`<div style="margin:2px 0 2px 14px">→ 显存不够、但内存有 ${_ram} GB：给 ComfyUI 加 <code>--lowvram</code> 能跑，一条 5 秒片通常几十分钟以上</div>`)
    } else {
      parts.push(`<div style="margin:2px 0 2px 14px;color:#e0a33a">→ 显存 ${r.vram.total_gb} GB：别用标准档硬跑，往下看「8 GB 显存方案」（W4A8 主模型 + 4B 编码器 + ClipProj，社区实测 8GB+16GB 内存能跑）</div>`)
    }
  }
  if (r.lowvram && r.lowvram.length) {
    const lv = r.lowvram_note || {}
    parts.push('<hr style="border:none;border-top:1px dashed #2a3542;margin:10px 0 6px">')
    parts.push('<div style="margin:2px 0"><b>8 GB 显存方案（社区实测）</b>'
      + ' <span style="opacity:.7">（和标准档互不影响）</span></div>')
    parts.push('<div style="margin:2px 0 2px 14px;opacity:.85">实测机器：' + esc(lv.tested || '') + ' · '
      + '<a href="' + esc(lv.repo || '') + '" target="_blank" rel="noopener">来源仓库</a></div>')
    parts.push('<div style="margin:2px 0 2px 14px">'
      + (r.clipproj_ok
        ? '✔ 节点 ComfyUI-ClipProj 已装（ClipProjApply 可用）'
        : '✘ 节点 ComfyUI-ClipProj 没装 —— <code>git clone ' + esc(lv.clip_node || '') + '</code>'
          + '（放进 ComfyUI\\custom_nodes\\，需要 ≥0.1.13）')
      + '</div>')
    parts.push('<div style="margin-left:14px">' + r.lowvram.map((g) => {
      const links = hfLinks(g)
      return '<div style="margin:4px 0">' + (g.exist ? '✔ 已就位' : '✘ 还没下载') + ' ' + esc(g.note) + '<br>'
        + '<span style="opacity:.7">存放：ComfyUI\\models\\' + esc(g.subdir) + '\\' + esc(g.file) + '</span>'
        + (links ? '<br><span>下载：' + links + '</span>' : '')
        + '</div>'
    }).join('') + '</div>')
    parts.push('<div style="margin-left:14px;opacity:.75">'
      + '启动参数：<code>' + esc(lv.flags || '') + '</code><br>'
      + '推荐参数：' + esc(lv.params || '') + (lv.runtime ? '；实测 ' + esc(lv.runtime) : '') + '<br>'
      + '画布里直接用：右侧「出片模型档位」选「低显存（W4A8 + 4B 编码器）」，尺寸会自动切到 608×352 / 480×864' + '</div>')
  }
  if (r.nodes_checked === false) {
    parts.push(`<div style="margin:2px 0;opacity:.75">? <b>节点</b> ComfyUI 没开，问不到 —— 启动后再点一次体检</div>`)
  } else {
    const nbad = (r.nodes || []).filter((n) => !n.found)
    if (!nbad.length) {
      parts.push(row('节点', '需要的都在', '', true))
    } else {
      parts.push('<div style="margin:6px 0 2px">✘ <b>节点</b> 缺：</div>')
      parts.push('<div style="margin-left:14px">' + nbad.map((n) => {
        let hint = ''
        if (n.dir_ok) {
          hint = `<br><span style="opacity:.85">文件夹已经在 ComfyUI\\custom_nodes\\${esc(n.folder)}，`
            + '但 ComfyUI 启动时没加载成功 —— 去看启动日志里的 import 报错（一般是缺依赖），不用重装。</span>'
        } else if (n.git) {
          hint = `<br><span style="opacity:.85">装：<code>git clone ${esc(n.git)}</code>（放进 ComfyUI\\custom_nodes\\）</span>`
        }
        return `<div style="margin:4px 0">· ${esc(n.name)} ${n.required ? '<b>（必需）</b>' : '（可选）'} → ${esc(n.pkg)}${hint}</div>`
      }).join('') + '</div>')
    }
  }
  if (r.sage && r.sage.node) {
    if (r.sage.dep === true) {
      parts.push(row('SageAttention 依赖', '已装，可用', '', true))
    } else if (r.sage.dep === false) {
      parts.push('<div style="margin:2px 0">✘ <b>SageAttention 依赖</b> <code>sageattention</code> 导入失败'
        + '（没装，或版本跟 torch/CUDA 不匹配）'
        + ' <button class="ghost" id="envInstallSage" style="margin-left:6px">安装 / 重装</button>'
        + (r.sage.python ? '<br><span style="opacity:.7">将使用：' + esc(r.sage.python) + '</span>' : '')
        + (r.sage.error ? '<br><span style="opacity:.75;word-break:break-all">报错：' + esc(r.sage.error) + '</span>' : '')
        + (r.sage.error && /no module named 'triton'/i.test(r.sage.error)
          ? '<br><span style="opacity:.75">缺 triton：Windows 上装 <code>pip install triton-windows</code>'
            + '（不是 triton），装完再点「安装 / 重装」</span>'
          : '')
        + '</div>')
    } else {
      parts.push('<div style="margin:2px 0;opacity:.75">? <b>SageAttention 依赖</b> 测不了（没找到 ComfyUI 的解释器'
        + (r.sage.python ? '：' + esc(r.sage.python) : '') + '）</div>')
    }
  }  if (r.h3 && (r.h3.unet || r.h3.lora)) {
    parts.push(`<div style="margin-top:6px;opacity:.75">H3 自动匹配：${esc(r.h3.unet || '无 unet')} + ${esc(r.h3.lora || '无 LoRA')}</div>`)
  }
  $('envReport').innerHTML = parts.join('')
    .replace(/✔/g, '<span style="color:#4caf50;font-weight:700">✔</span>')
    .replace(/✘/g, '<span style="color:#e8615a;font-weight:700">✘</span>')
    .replace(/⚠/g, '<span style="color:#e0a33a;font-weight:700">⚠</span>')
  const sagBtn = $('envInstallSage')
  if (sagBtn) sagBtn.onclick = async () => {
    sagBtn.disabled = true
    $('envStatus').textContent = '正在用 ComfyUI 的 pip 装 sageattention（几分钟）…'
    try {
      const x = await api('/api/env/install/sage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      if (x.dep) {
        $('envStatus').textContent = 'sageattention 装好了，正在复查…'
        $('setCheck').click()
      } else {
        $('envStatus').textContent = 'pip 跑完了但 import 还失败，多半是版本不匹配。日志尾部：'
          + String(x.log || '').slice(-200)
      }
    } catch (e) {
      $('envStatus').textContent = '安装失败：' + String(e.message).slice(0, 200)
    } finally {
      sagBtn.disabled = false
    }
  }
}

async function openSettings() {
  const s = await api('/api/settings')
  const cf = s.comfy || {}
  $('setBase').value = s.base_url || ''
  $('setModel').value = s.model || ''
  $('setKey').value = ''
  $('setKey').placeholder = s.has_key ? `已保存（${s.key_hint}），留空不改` : '填你的 API Key'
  $('setRoot').value = cf.root || ''
  $('setRoot').placeholder = cf.root_effective ? `自动探测到 ${cf.root_effective}` : '留空 = 自动探测'
  $('setUrl').value = cf.url || ''
  $('envReport').innerHTML = ''
  $('setSimFree').checked = false
  $('envStatus').textContent = cf.root_note
    ? ('注意：' + cf.root_note)
    : (cf.root_source === 'auto'
      ? '当前路径是自动探测的；想验证「设置」这条链路，勾上「模拟未配置」再点体检'
      : '点一下「体检」看缺什么')
  $('setStatus').textContent = s.has_key ? '当前已有密钥' : '还没设密钥，翻译不能用'
  $('setModal').classList.remove('hidden')
}
$('setBtn').onclick = () => openSettings()
$('setClose').onclick = () => $('setModal').classList.add('hidden')
$('setModal').onclick = (e) => { if (e.target.id === 'setModal') $('setModal').classList.add('hidden') }

$('setPick').onclick = async () => {
  $('envStatus').textContent = '在弹出的窗口里选 ComfyUI 文件夹…'
  try {
    const r = await api('/api/env/pick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial: $('setRoot').value.trim() }),
    })
    if (r.ok) {
      $('setRoot').value = r.path || ''
      $('envStatus').textContent = (r.note ? '已选好（' + r.note + '）' : '已选好') + '，点「保存」生效'
    } else if (r.picked) {
      $('envStatus').textContent = String(r.detail || '这个目录不是 ComfyUI')
    } else {
      $('envStatus').textContent = r.detail ? '没选：' + String(r.detail).slice(0, 140) : '没选'
    }
  } catch (e) {
    $('envStatus').textContent = '打开对话框失败：' + String(e.message).slice(0, 140)
  }
}

$('setCheck').onclick = async () => {
  const sim = $('setSimFree').checked
  $('envStatus').textContent = sim ? '正在查（已忽略自动探测）…' : '正在查…'
  try {
    const r = await api('/api/env/check' + (sim ? '?fresh=true' : ''))
    renderEnvReport(r)
    $('envStatus').textContent = r.hint
  } catch (e) {
    $('envStatus').textContent = '体检失败：' + String(e.message).slice(0, 140)
  }
}

$('setSave').onclick = async () => {
  const body = {
    comfy: { root: $('setRoot').value.trim(), url: $('setUrl').value.trim() },
    llm: { base_url: $('setBase').value.trim(), model: $('setModel').value.trim() },
  }
  const key = $('setKey').value.trim()
  if (key) body.llm.api_key = key
  try {
    const s = await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const cf = s.comfy || {}
    $('setRoot').placeholder = cf.root_effective ? `自动探测到 ${cf.root_effective}` : '留空 = 自动探测'
    $('setStatus').textContent = (s.has_key
      ? `已保存（密钥 ${s.key_hint}）`
      : '已保存，但没有密钥（不影响出片）')
      + (cf.root_effective ? `　ComfyUI：${cf.root_effective}` : '　ComfyUI 还没找到，点「浏览…」')
      + (cf.root_note ? `（${cf.root_note}）` : '')
  } catch (e) {
    $('setStatus').textContent = '保存失败：' + String(e.message).slice(0, 140)
  }
}

// ---------------------------------------------------------------- 布局兜底
// 用 JS 直接给 main 写死像素高度：不依赖 flex/calc 的浏览器差异，
// 保证右侧面板底（出视频那排按钮）永远在窗口内，面板自己出现滚动条。
function fitMainHeight() {
  const bar = document.getElementById('bar')
  const m = document.querySelector('main')
  if (!bar || !m) return
  const h = Math.max(300, window.innerHeight - bar.getBoundingClientRect().height)
  m.style.height = h + 'px'
  m.style.maxHeight = h + 'px'
  m.style.minHeight = h + 'px'
  if (new URLSearchParams(location.search).get('dbg') === '1') showDbg()
}

const FILM = { rows: [], order: [], sel: new Set(), busy: false, dragId: null }

async function filmOpen() {
  const m = $('filmModal')
  if (!m) return
  $('filmTitle').textContent = `拼成片 · ${S.ep}`
  $('filmStatus').textContent = ''
  FILM.sel.clear()
  m.classList.remove('hidden')
  await filmLoad()
}

async function filmLoad() {
  const box = $('filmList')
  const sum = $('filmSummary')
  if (!box) return
  box.innerHTML = '<div class="meta">正在读本集镜头…</div>'
  let plan
  try {
    plan = await api(`/api/film/${S.ep}/plan`)
  } catch (e) {
    box.innerHTML = `<div class="meta" style="color:#e8615a">读不到：${esc(String(e.message))}</div>`
    return
  }
  FILM.rows = plan.shots || []
  const kept = FILM.order.filter((id) => FILM.rows.some((r) => r.id === id))
  if (kept.length !== FILM.order.length || !kept.length) {
    FILM.order = FILM.rows.map((r) => r.id)
  }
  FILM.sel = new Set([...FILM.sel].filter((id) => {
    const r = FILM.rows.find((x) => x.id === id)
    return r && r.exists && !(r.problems || []).length
  }))
  if (!FILM.sel.size) {
    FILM.rows.forEach((r) => { if (r.exists && !(r.problems || []).length) FILM.sel.add(r.id) })
  }
  filmRender()
  if (sum && plan.relay_error) sum.textContent = `relay 不可用：${plan.relay_error}`
}

function filmRender() {
  const box = $('filmList')
  if (!box) return
  const rows = FILM.order.map((id) => FILM.rows.find((r) => r.id === id)).filter(Boolean)
  box.innerHTML = rows.map((r, i) => {
    const probs = r.problems || []
    const on = FILM.sel.has(r.id)
    const srcPath = r.poster || r.path || ''
    const media = !r.exists
      ? '<div class="meta" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">无成片</div>'
      : (r.poster
        ? `<img src="${fpathLive(r.poster)}" draggable="false" style="width:100%;height:100%;object-fit:cover">`
        : `<video src="${fpathLive(r.path)}" muted preload="metadata" draggable="false"
             style="width:100%;height:100%;object-fit:cover"></video>`)
    return `<div class="film-tile" draggable="true" data-film-id="${esc(r.id)}"
      title="${esc(r.name || '')}"
      style="width:132px;padding:6px;border-radius:8px;background:#151b23;cursor:grab;
             border:1px solid ${probs.length ? '#e8615a' : 'var(--line)'};opacity:${on ? 1 : 0.45}">
      <div style="position:relative;width:100%;aspect-ratio:9/16;overflow:hidden;border-radius:5px;background:#0d131a">
        ${media}
        <input type="checkbox" data-film-check="${esc(r.id)}"${on ? ' checked' : ''}${r.exists && !probs.length ? '' : ' disabled'}
          style="position:absolute;top:4px;left:4px;width:15px;height:15px;cursor:pointer">
        <span style="position:absolute;top:4px;right:4px;background:#000b;color:#cfe0ef;border-radius:4px;
          padding:0 5px;font-size:11px;line-height:17px">${i + 1}</span>
      </div>
      <div class="meta" style="margin-top:4px;line-height:1.35">
        <b>${esc(r.id)}</b>${r.exists ? ` · ${r.width}×${r.height}<br>${r.fps}fps · ${r.seconds}s` : ''}
      </div>
      ${probs.length ? `<div class="meta" style="color:#e8615a;margin-top:3px">${probs.map(esc).join('；')}</div>` : ''}
      <div style="height:${srcPath ? 0 : 0}px"></div>
    </div>`
  }).join('')

  box.querySelectorAll('[data-film-check]').forEach((el) => {
    el.onchange = () => {
      if (el.checked) FILM.sel.add(el.dataset.filmCheck)
      else FILM.sel.delete(el.dataset.filmCheck)
      const tile = el.closest('.film-tile')
      if (tile) tile.style.opacity = el.checked ? 1 : 0.45
      filmUpdateSummary()
    }
  })

  box.querySelectorAll('.film-tile').forEach((tile) => {
    tile.addEventListener('dragstart', (e) => {
      FILM.dragId = tile.dataset.filmId
      tile.style.opacity = 0.3
      try {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', FILM.dragId)
      } catch (_) { /* 老浏览器 */ }
    })
    tile.addEventListener('dragover', (e) => {
      if (!FILM.dragId || FILM.dragId === tile.dataset.filmId) return
      e.preventDefault()
      const rect = tile.getBoundingClientRect()
      const after = (e.clientX - rect.left) > rect.width / 2
      const target = tile.dataset.filmId
      FILM.order = FILM.order.filter((x) => x !== FILM.dragId)
      let idx = FILM.order.indexOf(target)
      if (idx < 0) idx = FILM.order.length - 1
      FILM.order.splice(after ? idx + 1 : idx, 0, FILM.dragId)
      const dragEl = box.querySelector(`.film-tile[data-film-id="${FILM.dragId}"]`)
      if (dragEl) box.insertBefore(dragEl, after ? tile.nextSibling : tile)
      filmUpdateSummary()
    })
    tile.addEventListener('dragend', () => {
      FILM.dragId = null
      filmRender()
    })
  })

  filmUpdateSummary()
}

function filmUpdateSummary() {
  const sum = $('filmSummary')
  const go = $('filmGo')
  const rows = FILM.order.map((id) => FILM.rows.find((r) => r.id === id)).filter(Boolean)
  const picked = FILM.order.filter((id) => FILM.sel.has(id))
  const total = rows.filter((r) => FILM.sel.has(r.id)).reduce((n, r) => n + (Number(r.seconds) || 0), 0)
  if (sum) {
    sum.textContent = picked.length
      ? `已选 ${picked.length} 段 · 合计 ${total.toFixed(2)} 秒 · 顺序：${picked.join(' → ')}`
      : '一段都没勾'
  }
  if (go) go.disabled = FILM.busy || !picked.length
}

async function filmGo() {
  if (FILM.busy) return
  const seq = FILM.order.filter((id) => FILM.sel.has(id))
  if (!seq.length) return
  const go = $('filmGo')
  const st = $('filmStatus')
  FILM.busy = true
  if (go) go.disabled = true
  if (st) st.textContent = '提交…'
  let job
  try {
    const r = await api(`/api/film/${S.ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq }),
    })
    job = r.job
  } catch (e) {
    if (st) st.textContent = '✗ ' + String(e.message).slice(0, 200)
    FILM.busy = false
    filmRender()
    return
  }
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500))
    let j
    try {
      j = await api('/api/job/' + job)
    } catch (e) {
      if (st) st.textContent = '✗ 查询失败：' + String(e.message).slice(0, 160)
      break
    }
    const secs = Math.round((Date.now() - t0) / 1000)
    if (j.status === 'running' || j.status === 'queued') {
      if (st) st.textContent = `${j.progress || '拼接中…'}（${secs}s）`
      continue
    }
    if (j.status === 'done') {
      const res = j.result || {}
      if (st) st.textContent = `✓ 完成：${String(res.out || '').split(/[\\/]/).pop()} · ${res.seconds}s · ${res.frames} 帧 · ${res.mb} MB · ${res.took}s（${res.mode}）`
      const base = String(res.out || '').split(/[\\/]/).pop().replace(/\.mp4$/i, '')
      const name = prompt('成片已写出，要不要改个名字？（留空保持默认）', base)
      if (name !== null && name.trim() && name.trim() !== base) {
        try {
          const rn = await api('/api/film/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: res.out, name: name.trim() }),
          })
          if (st) st.textContent = `✓ 完成：${String(rn.path).split(/[\\/]/).pop()}`
        } catch (e) {
          toast('改名失败：' + String(e.message).slice(0, 120), true)
        }
      }
      break
    }
    if (st) st.textContent = '✗ ' + String(j.error || '拼接失败').slice(0, 300)
    if (j.result && j.result.report) showModal('拼接报告', String(j.result.report))
    break
  }
  FILM.busy = false
  filmRender()
}

if ($('filmBtn')) $('filmBtn').onclick = () => filmOpen()
if ($('filmClose')) $('filmClose').onclick = () => $('filmModal').classList.add('hidden')
if ($('filmReload')) $('filmReload').onclick = () => filmLoad()
if ($('filmGo')) $('filmGo').onclick = () => filmGo()
if ($('filmModal')) $('filmModal').onclick = (e) => { if (e.target.id === 'filmModal') $('filmModal').classList.add('hidden') }

function showDbg() {
  const m = document.querySelector('main')
  const insp = document.getElementById('inspector')
  let box = document.getElementById('dbgBox')
  if (!box) {
    box = document.createElement('div')
    box.id = 'dbgBox'
    box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;background:#000c;color:#0f0;' +
      'font:12px/1.4 monospace;padding:8px;border:1px solid #0f0;white-space:pre;pointer-events:none'
    document.body.appendChild(box)
  }
  box.textContent = [
    'win  = ' + window.innerHeight,
    'bar  = ' + document.getElementById('bar').getBoundingClientRect().height.toFixed(0),
    'main = ' + (m ? m.clientHeight : -1) + ' / scroll ' + (m ? m.scrollHeight : -1),
    'insp = ' + (insp ? insp.clientHeight : -1) + ' / scroll ' + (insp ? insp.scrollHeight : -1),
    'inspY= ' + getComputedStyle(insp).overflowY,
    'body = ' + document.body.clientHeight + ' / ' + getComputedStyle(document.body).overflow,
  ].join('\n')
}

window.addEventListener('resize', fitMainHeight)

boot().catch((e) => {
  document.body.innerHTML =
    `<pre style="padding:30px;color:#e8615a;white-space:pre-wrap">启动失败：${esc(e.message)}\n\n${esc(e.stack || '')}</pre>`
})

