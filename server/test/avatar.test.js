/** 头像回归：真实图片解码和独立 MySQL 测试库，验证归属、持久化、读取和恢复默认。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

process.env.DB_NAME = 'mujian_test'
const { q, pool } = await import('../src/db/index.js')
const { migrate } = await import('../scripts/migrate.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/modules/auth/service.js')

test('头像真实上传、版本更新、权限隔离及恢复默认', async () => {
  await migrate()
  const emails = [0, 1].map((index) => `avatar-${randomUUID()}-${index}@example.com`)
  const ids = [],
    cookies = []
  let server
  try {
    for (const email of emails) {
      const user = await q('INSERT INTO users(email,nickname) VALUES(?,?)', [email, '头像测试'])
      ids.push(user.insertId)
      await createSession(user.insertId, { cookie: (name, value) => cookies.push(`${name}=${value}`) })
    }
    server = createApp().listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const request = async (method, image, cookie = cookies[0]) => {
      const response = await fetch(base + '/api/me/avatar', {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: method === 'PUT' ? JSON.stringify({ image, userId: ids[1] }) : undefined
      })
      return { status: response.status, data: await response.json() }
    }
    const picture = await sharp({ create: { width: 720, height: 360, channels: 3, background: '#7761cf' } })
      .png()
      .toBuffer()
    const image = 'data:image/png;base64,' + picture.toString('base64')
    assert.equal((await request('PUT', image, '')).status, 401)
    let result = await request('PUT', image)
    assert.equal(result.status, 200, JSON.stringify(result.data))
    const url = result.data.avatarUrl
    assert.match(url, new RegExp(`^/api/avatars/${ids[0]}\\?v=[a-f0-9]{32}$`))
    assert.equal((await q('SELECT avatar_version FROM users WHERE id=?', [ids[1]]))[0].avatar_version, null)
    const saved = await fetch(base + url)
    assert.equal(saved.status, 200)
    assert.match(saved.headers.get('content-type'), /^image\/webp/)
    const rendered = await sharp(Buffer.from(await saved.arrayBuffer())).metadata()
    assert.equal(rendered.width, 512)
    assert.equal(rendered.height, 512)
    const me = await fetch(base + '/api/me', { headers: { Cookie: cookies[0] } })
    assert.equal((await me.json()).avatarUrl, url, '刷新后仍然返回持久化头像')
    assert.equal((await request('PUT', 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'))).status, 400)
    assert.equal((await request('PUT', 'data:image/png;base64,' + Buffer.from('not-an-image').toString('base64'))).status, 400)
    assert.equal((await request('PUT', 'data:image/jpeg;base64,' + picture.toString('base64'))).status, 400)
    assert.equal((await request('PUT', 'data:image/png;base64,' + Buffer.alloc(530000).toString('base64'))).status, 400)
    assert.equal((await fetch(base + url)).status, 200, '错误上传不能破坏已有头像')
    await request('DELETE', null, cookies[1])
    assert.equal((await fetch(base + url)).status, 200, '其他用户恢复默认不能删除本人的头像')
    result = await request('PUT', image)
    assert.equal(result.status, 200)
    assert.notEqual(result.data.avatarUrl, url, '换头像必须更新地址版本，避免缓存旧图')
    await q("UPDATE users SET status='disabled' WHERE id=?", [ids[0]])
    assert.equal((await fetch(base + result.data.avatarUrl)).status, 404)
    await q("UPDATE users SET status='active' WHERE id=?", [ids[0]])
    result = await request('DELETE')
    assert.equal(result.status, 200)
    assert.equal(result.data.avatarUrl, null)
    assert.equal((await fetch(base + url)).status, 404)
    assert.equal((await q('SELECT * FROM user_avatars WHERE user_id=?', [ids[0]])).length, 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const id of ids) await q('DELETE FROM users WHERE id=?', [id])
    await pool.end()
  }
})
