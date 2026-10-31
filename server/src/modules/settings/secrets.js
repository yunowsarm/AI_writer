/** 用户密钥加密：MySQL 仅存密文，主密钥留在后端私有目录，认证标签绑定用户 ID。 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const keyFile =
  process.env.AI_KEY_FILE || fileURLToPath(new URL('../../../../.local/ai-master.key', import.meta.url))
let keyPromise

/** 复用本进程的主密钥加载；首次安装创建随机主密钥，已有文件绝不覆盖。 */
function masterKey() {
  if (!keyPromise)
    keyPromise = (async () => {
      await mkdir(dirname(keyFile), { recursive: true })
      try {
        return await readFile(keyFile)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const key = randomBytes(32)
        try {
          await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 })
          return key
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          return readFile(keyFile)
        }
      }
    })()
  return keyPromise
}

/** 每次使用独立随机 IV，以用户 ID 作为附加认证数据，防止跨账号挪用密文。 */
export async function sealApiKey(userId, value) {
  if (!value) return null
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', await masterKey(), iv)
  cipher.setAAD(Buffer.from(String(userId)))
  const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64')
}

/** 仅在当前用户真正调用模型时解密，原文不进入接口响应、审计或用量记录。 */
export async function openApiKey(userId, value) {
  if (!value) return ''
  const bytes = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', await masterKey(), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(String(userId)))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}
