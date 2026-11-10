// 奶蛙大笑 —— 每轮结束随机播一段。
// 普通浏览器脚本（不是 ModuleLoader 客户端模块）：由注入行
// 以 <script src="/dsh-naiwa/player.js"> 载入，直接跑在页面里。
(function () {
  'use strict'

  var P = '/dsh-naiwa'
  if (window.__dshNaiwaInstalled) return
  window.__dshNaiwaInstalled = true

  var AC = null
  var decoded = Object.create(null)   // 文件名 -> AudioBuffer
  var inflight = Object.create(null)  // 文件名 -> Promise，避免重复 fetch
  var clips = []
  var mainClip = ''
  var lastSeq = -1                    // -1 = 还没对齐过，首轮只记录不播
  var composing = false
  var enabled = true
  var lastState = null

  function ac() {
    if (AC) return AC
    var C = window.AudioContext || window.webkitAudioContext
    if (!C) return null
    try { AC = new C() } catch (err) { AC = null }
    return AC
  }

  function suspendNow() {
    try {
      if (AC && AC.state === 'running') {
        var p = AC.suspend()
        if (p && p.catch) p.catch(function () {})
      }
    } catch (err) {}
  }

  function unlockNow() {
    var c = ac()
    if (!c) return
    try {
      if (c.state === 'suspended') {
        var p = c.resume()
        if (p && p.catch) p.catch(function () {})
      }
    } catch (err) {}
  }

  // 输入法组字期间一律不预热音频、不动 DOM。
  // 在 composition 中同步 new AudioContext() 会让微软拼音把候选直接上屏、光标跳到最前。
  try {
    document.addEventListener('compositionstart', function () { composing = true }, true)
    document.addEventListener('compositionend', function () { composing = false }, true)
  } catch (err) {}

  // 自动播放策略：AudioContext 初始 suspended，要有一次真实手势才能出声，
  // 而「任务结束」不是手势触发的，所以挂一次性解锁监听。
  function unlockOnce(ev) {
    try {
      if (composing || (ev && (ev.isComposing === true || ev.keyCode === 229))) return
    } catch (err) {}
    if (!enabled) return
    unlockNow()
    try { document.removeEventListener('pointerdown', unlockOnce, true) } catch (err) {}
    try { document.removeEventListener('keydown', unlockOnce, true) } catch (err) {}
  }
  try {
    document.addEventListener('pointerdown', unlockOnce, true)
    document.addEventListener('keydown', unlockOnce, true)
    // 页面被隐藏（切标签 / 最小化）时立刻挂起：running 状态的 AudioContext
    // 会让系统一直挂着 PreventUserIdleSystemSleep。
    document.addEventListener('visibilitychange', function () {
      try { if (document.hidden) suspendNow() } catch (err) {}
    })
  } catch (err) {}

  function startBuffer(buf, when) {
    var c = ac()
    if (!c || !buf) return
    try {
      if (c.state === 'suspended') {
        var rp = c.resume()
        if (rp && rp.catch) rp.catch(function () {})
      }
      var src = c.createBufferSource()
      src.buffer = buf
      var gain = c.createGain()
      gain.gain.value = 0.9
      src.connect(gain)
      gain.connect(c.destination)
      src.start(when || 0)
    } catch (err) {}
  }

  function fetchClip(name) {
    if (inflight[name]) return inflight[name]
    var p = fetch(P + '/a/' + name, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status)
        return res.arrayBuffer()
      })
      .then(function (ab) {
        var c = ac()
        if (!c) throw new Error('no audio context')
        return c.decodeAudioData(ab)
      })
      .then(function (buf) {
        decoded[name] = buf
        delete inflight[name]
        return buf
      })
      .catch(function (err) {
        delete inflight[name]
        throw err
      })
    inflight[name] = p
    return p
  }

  function preload(name) {
    if (!name || decoded[name] || inflight[name]) return
    try { fetchClip(name).catch(function () {}) } catch (err) {}
  }

  function playName(name) {
    if (!name) return
    if (decoded[name]) { startBuffer(decoded[name], 0); return }
    try {
      fetchClip(name).then(function (buf) { startBuffer(buf, 0) }).catch(function () {})
    } catch (err) {}
  }

  function playRandom() {
    if (!clips.length) return
    var i = Math.floor(Math.random() * clips.length)
    playName(clips[i])
  }

  function loadManifest() {
    fetch(P + '/manifest.json', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status)) })
      .then(function (data) {
        if (data && Array.isArray(data.clips) && data.clips.length) clips = data.clips
        if (data && typeof data.main === 'string') {
          mainClip = data.main
          preload(mainClip)   // 主音效先解码，保证第一次是秒响
        }
      })
      .catch(function () {})
  }

  function poll() {
    var ctrl = null
    try {
      if (typeof AbortController === 'function') {
        ctrl = new AbortController()
        setTimeout(function () { try { ctrl.abort() } catch (err) {} }, 2500)
      }
    } catch (err) { ctrl = null }
    fetch(P + '/state.json', ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status)) })
      .then(function (data) {
        lastState = data
        var s = data && typeof data.seq === 'number' ? data.seq : 0
        if (lastSeq < 0) { lastSeq = s; return }   // 首次对齐：刷新页面不该马上响
        if (s > lastSeq) {
          lastSeq = s
          if (enabled) playRandom()
        }
      })
      .catch(function () {})
  }

  // 控制台接口：想手动听一声、看池子、临时静音都走它
  try {
    window.__dshNaiwa = {
      play: function (name) { playName(name || null) },
      random: playRandom,
      list: function () { return clips.slice() },
      test: function () { playRandom() },
      state: function () { return lastState },
      setEnabled: function (v) { enabled = v !== false },
      stopAll: function () { try { suspendNow() } catch (err) {} },
    }
  } catch (err) {}

  loadManifest()
  poll()
  setInterval(poll, 500)
})()
