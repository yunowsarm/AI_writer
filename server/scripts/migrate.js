/** 迁移与种子入口：表结构可重复执行，正式环境不插入演示账号。 */
import { readFile } from 'node:fs/promises'
import bcrypt from 'bcryptjs'
import { q, pool } from '../src/db/index.js'

/** 按顺序执行可重复创建的表结构语句，不清空现有业务数据。 */
export async function migrate() {
  const sql = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8')
  for (const statement of sql
    .replace(/^--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await q(statement)
  await ensureAiRequestCacheColumns()
  await ensureProviderColumns()
  // 旧邮箱不能推定已验证，保留空值，用户可在个人中心补验。
  const emailVerified = await q("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='email_verified_at'")
  if (!emailVerified.length) await q('ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL')
  const avatar = await q("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='avatar_version'")
  if (!avatar.length) await q('ALTER TABLE users ADD COLUMN avatar_version CHAR(32) NULL')
  const visibility = await q("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='templates' AND COLUMN_NAME='visibility'")
  if (!visibility.length) await q("ALTER TABLE templates ADD COLUMN visibility ENUM('private','public') NOT NULL DEFAULT 'private'")
  const columns = await q("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_jobs' AND COLUMN_NAME='progress_json'")
  if (!columns.length) await q('ALTER TABLE ai_jobs ADD COLUMN progress_json JSON NULL')
}

/** 增量增加调用来源快照；历史记录保留空值，避免错误推断供应商。 */
async function ensureProviderColumns() {
  const columns = await q("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_requests'")
  const names = new Set(columns.map((column) => column.COLUMN_NAME))
  if (!names.has('provider_name')) await q("ALTER TABLE ai_requests ADD COLUMN provider_name VARCHAR(80) NOT NULL DEFAULT ''")
  if (!names.has('provider_base_url')) await q("ALTER TABLE ai_requests ADD COLUMN provider_base_url VARCHAR(500) NOT NULL DEFAULT ''")
  await q("ALTER TABLE ai_requests MODIFY phase ENUM('outline','episode','rewrite','evaluation','consistency','verification','planning') NOT NULL")
}

/**
 * 为升级前已存在的 ai_requests 表补齐缓存 Token 字段。
 * 旧版 MySQL 不支持 ADD COLUMN IF NOT EXISTS，因此先读 information_schema 再执行精确变更。
 */
async function ensureAiRequestCacheColumns() {
  const columns = await q(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_requests' AND COLUMN_NAME IN ('prompt_cache_hit_tokens','prompt_cache_miss_tokens')"
  )
  const names = new Set(columns.map((column) => column.COLUMN_NAME))
  if (!names.has('prompt_cache_hit_tokens')) await q('ALTER TABLE ai_requests ADD COLUMN prompt_cache_hit_tokens BIGINT UNSIGNED NULL AFTER total_tokens')
  if (!names.has('prompt_cache_miss_tokens')) await q('ALTER TABLE ai_requests ADD COLUMN prompt_cache_miss_tokens BIGINT UNSIGNED NULL AFTER prompt_cache_hit_tokens')
}

/**
 * 准备初始管理员与官方模板，只在相应记录缺失时插入。
 * 管理员密码由初始化环境传入并哈希保存，不在代码中写死演示密码。
 */
export async function seed() {
  if (process.env.ADMIN_PASSWORD) {
    const rows = await q('SELECT id FROM users WHERE email=?', [process.env.ADMIN_EMAIL || 'admin@mujian.local'])
    if (!rows.length)
      await q('INSERT INTO users(email,password_hash,nickname,role) VALUES(?,?,?,?)', [
        process.env.ADMIN_EMAIL || 'admin@mujian.local',
        await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
        '幕间管理员',
        'admin'
      ])
  }
  const count = await q("SELECT COUNT(*) n FROM templates WHERE kind='official'")
  if (!count[0].n) {
    for (const [style, title, description] of [
      ['逆袭', '绝地翻盘', '从低谷出发，寻找主角反击的力量。'],
      ['甜宠', '命中注定的你', '从意外相遇到双向奔赴。'],
      ['悬疑', '迷雾背后', '线索环环相扣，结尾揭晓意外真相。'],
      ['家庭', '亲爱的家人', '围绕家庭关系，讲述真实而细腻的情感。'],
      ['复仇', '她的复仇计划', '主角隐藏身份，步步为营揭露真相。'],
      ['都市', '你好，另一种人生', '从职场转折开始，找到新的生活方向。']
    ])
      await q('INSERT INTO templates(kind,title,genre,description,params,outline) VALUES(?,?,?,?,?,?)', [
        'official',
        title,
        style,
        description,
        JSON.stringify({
          theme: description,
          people: '',
          background: '当代都市',
          style,
          episodes: 3,
          duration: 2,
          twist: '每集结尾留悬念，人物行为符合动机。'
        }),
        '起：危机与目标；承：尝试与阻碍；转：真相与反击；合：成长与回应。'
      ])
  }
}
if (process.argv[1]?.endsWith('migrate.js')) {
  try {
    await migrate()
    await seed()
    console.log('数据库迁移与初始模板准备完成')
  } finally {
    await pool.end()
  }
}
