// 访问检查的单元验证：直接把插件装到假的 root 上，拿 route.resource 打真请求。
// 跑法：node test/guard.test.mjs
import assert from 'node:assert/strict'
import plugin from '../lib/index.js'

function load({ host = '127.0.0.1', protocol = 'http:', port = 65489 } = {}) {
  const routes = []
  const root = {
    effect() { return () => {} },
    on() { return () => {} },
    inject(_deps, cb) {
      cb({
        webServer: {
          host,
          protocol,
          port,
          register(route) { routes.push(route); return () => {} },
        },
        effect(fn) { fn(); return () => {} },
      })
    },
  }
  plugin.apply(root)
  assert.equal(routes.length, 1, 'exactly one route registered')
  return routes[0]
}

const get = (route, path, headers = {}, peer) =>
  route.resource(new Request('http://' + (headers.host ?? '127.0.0.1:65489') + path, { headers }), peer)

const cases = []
const t = (name, fn) => cases.push([name, fn])

t('same-origin page read passes', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/state.json', { host: '127.0.0.1:65489', 'sec-fetch-site': 'same-origin' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).seq, 0)
})

t('player.js from the page passes', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/player.js', { host: '127.0.0.1:65489', 'sec-fetch-site': 'same-origin' })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /__dshNaiwa/)
})

t('localhost spelling passes', async () => {
  const route = load()
  assert.equal((await get(route, '/dsh-naiwa/manifest.json', { host: 'localhost:65489' })).status, 200)
})

t('audio fetch for a known clip passes', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/a/naiwa-main.mp3', { host: '127.0.0.1:65489', 'sec-fetch-site': 'same-origin' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
})

t('origin equal to host passes', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/manifest.json', { host: '127.0.0.1:65489', origin: 'http://127.0.0.1:65489' })
  assert.equal(res.status, 200)
})

t('cross-site marker refused', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/state.json', { host: '127.0.0.1:65489', 'sec-fetch-site': 'cross-site' })
  assert.equal(res.status, 403)
})

t('foreign origin refused', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/state.json', { host: '127.0.0.1:65489', origin: 'https://evil.example' })
  assert.equal(res.status, 403)
})

t('opaque origin refused', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/state.json', { host: '127.0.0.1:65489', origin: 'null' })
  assert.equal(res.status, 403)
})

t('rebound host refused', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/state.json', { host: 'evil.example:65489', origin: 'http://evil.example:65489' })
  assert.equal(res.status, 403)
})

t('missing host refused', async () => {
  const route = load()
  const res = await route.resource(new Request('http://x/dsh-naiwa/state.json'))
  // Request 总会带 host: x —— 不是回环，所以同样该拒
  assert.equal(res.status, 403)
})

t('lan bind accepts its own literal', async () => {
  const route = load({ host: '192.168.1.5' })
  assert.equal((await get(route, '/dsh-naiwa/state.json', { host: '192.168.1.5:65489' })).status, 200)
  assert.equal((await get(route, '/dsh-naiwa/state.json', { host: 'evil.example:65489' })).status, 403)
})

t('in-process read with peer bypasses the fence', async () => {
  const route = load()
  const res = await get(route, '/dsh-naiwa/state.json', { host: 'evil.example:65489' }, {})
  assert.equal(res.status, 200)
})

t('path traversal still 404s', async () => {
  const route = load()
  for (const p of ['/dsh-naiwa/a/..%2F..%2Fpackage.json', '/dsh-naiwa/a/nope.txt', '/dsh-naiwa/m/..%2F..%2Fpackage.json']) {
    assert.equal((await get(route, p, { host: '127.0.0.1:65489' })).status, 404, p)
  }
})

let bad = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (err) {
    bad += 1
    console.error('  FAIL ' + name + ' — ' + (err && err.message))
  }
}
console.log(cases.length - bad + '/' + cases.length + ' passed')
process.exit(bad ? 1 : 0)
