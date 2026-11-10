import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Package root: lib/index.js -> package root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(PACKAGE_ROOT, 'assets')
const PLAYER_SRC = path.join(PACKAGE_ROOT, 'lib', 'player.js')

const PREFIX = '/dsh-naiwa'

// —— 桌面端（Electron）注入行 ——
// 桌面壳的 index.html 由安装包静态直出，页面变换过不去；唯一通道是
// webserver/index-inject 推的结构化行。但解释器对两类 script 行处理不对称：
//   kind: 'script'     -> createElement + textContent + append，没有 await，不可能"加载失败"
//   kind: 'script-src' -> await loadScript(src)，失败即 reject __DSH_BOOT_READY__ ⇒ 整个应用起不来
// 且外壳把注入表在宿主启动时收集一次后缓存，运行期关插件也不会摘掉这一行。
// 所以用内联行，由脚本自建 <script src> 并吞掉 onerror：路由在就加载，路由不在就静默失败，
// 宿主永远不会因为本插件起不来。
const BOOT_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;' +
  'if(!d)return;if(window.__dshNaiwaBooted){return}window.__dshNaiwaBooted=1;' +
  'var s=document.createElement("script");s.src="' + PREFIX + '/player.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function notFound() {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
}

// 只认 assets 目录里形如 name.mp3 的直接文件名，任何路径分隔符与 ..
// 都不可能落进这个字符集，因此不存在目录穿越。
const ASSET_NAME = /^[A-Za-z0-9_-]+\.mp3$/
// README 里用的表情包：只认 assets/memes/ 下的单层文件名。
const MEME_NAME = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/

// 每次请求都重读文件。player.js 只有几 KB，读一遍的开销可以忽略，
// 换来的是「改完前端刷新页面即生效」—— 不用为改一行脚本重启整个 DSH。
function readPlayerJs() {
  try {
    return fs.readFileSync(PLAYER_SRC, 'utf8')
  } catch (err) {
    return ''
  }
}

export default {
  name: 'naiwa-laugh',

  // 有意不用对象级 inject：桌面端的注入表是宿主启动时一次性收集的，apply 一旦被推迟到
  // 服务就绪之后，注册注入行就可能晚于收集发生 —— 表现是插件完全不出现。
  // 这里 apply 立刻执行，第一件事就注册注入行（它不依赖任何服务），其余逻辑局部等待。
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })

    // ① 结构化注入行：桌面端唯一能生效的通道
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/dsh-naiwa/player.js') >= 0) return
          if (row.kind === 'script-src' && row.src === PREFIX + '/player.js') return
        }
        table.push({ kind: 'script', placement: 'body', text: BOOT_TEXT })
      } catch (err) {}
    }))

    // ② 每轮结束计数。turn/end 是「这一轮 agent 回合走完了」的提交后事件，
    //    aborted / error 这类收尾同样算一轮结束。
    let seq = 0
    let lastReason = ''
    disposers.push(root.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'turn/end') return
        seq += 1
        const reason = event.data && event.data.reason
        lastReason = reason && reason.kind ? String(reason.kind) : ''
      } catch (err) {}
    }))

    // ③ HTTP 路由：一个前缀路由供出 player.js / manifest / state / 音频
    root.inject(['webServer'], (ctx) => {
      const clips = (() => {
        try {
          const names = fs.readdirSync(ASSETS).filter((n) => ASSET_NAME.test(n)).sort()
          return names
        } catch (err) {
          return []
        }
      })()
      // naiwa-main.mp3 是从音效合集里挑出来的「最正宗原版」，抽中概率双份。
      // 所以它在抽签里拿双份。laugh-01 是另一段已确认的正宗大笑，单份。
      const MAIN_CANDIDATES = ['naiwa-main.mp3', 'laugh-01.mp3']
      const mainClip = MAIN_CANDIDATES.find((c) => clips.indexOf(c) >= 0) || clips[0]
      // 主音效（正宗大笑）在抽签里占两份，其余各一份。
      const pool = []
      for (const c of clips) {
        pool.push(c)
        if (c === mainClip) pool.push(c)
      }

      const route = {
        kind: 'prefix',
        path: PREFIX,
        resource: async (request) => {
          let pathname = ''
          try {
            pathname = new URL(request.url).pathname
          } catch (err) {
            return notFound()
          }
          if (pathname === PREFIX + '/player.js') {
            const body = readPlayerJs()
            if (!body) return notFound()
            return new Response(body, {
              headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
            })
          }
          if (pathname === PREFIX + '/manifest.json') {
            return jsonResponse({ clips: pool, main: mainClip })
          }
          if (pathname === PREFIX + '/state.json') {
            return jsonResponse({ seq, reason: lastReason, time: Date.now() })
          }
          if (pathname.startsWith(PREFIX + '/a/')) {
            const name = pathname.slice((PREFIX + '/a/').length)
            if (!ASSET_NAME.test(name)) return notFound()
            try {
              const buf = await fs.promises.readFile(path.join(ASSETS, name))
              return new Response(new Uint8Array(buf), {
                headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400' },
              })
            } catch (err) {
              return notFound()
            }
          }
          // README 里的表情包（图片只从 assets/memes 这一层读）
          if (pathname.startsWith(PREFIX + '/m/')) {
            const name = pathname.slice((PREFIX + '/m/').length)
            if (!MEME_NAME.test(name)) return notFound()
            try {
              const buf = await fs.promises.readFile(path.join(ASSETS, 'memes', name))
              const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
              const type =
                ext === 'png' ? 'image/png'
                  : ext === 'webp' ? 'image/webp'
                    : ext === 'gif' ? 'image/gif'
                      : 'image/jpeg'
              return new Response(new Uint8Array(buf), {
                headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
              })
            } catch (err) {
              return notFound()
            }
          }
          return notFound()
        },
      }

      ctx.effect(() => ctx.webServer.register(route))
    })
  },
}
