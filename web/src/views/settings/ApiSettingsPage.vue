<script setup>
/** 个人 API 配置：以供应商管理地址、协议、密钥及模型清单，启停状态独立保存。 */
import { ref, onMounted } from 'vue'
import { api } from '../../api/client'
import { useAuth } from '../../stores/auth'
import { success, reportError, confirmAction } from '../../shared/feedback'

const auth = useAuth()
const providers = ref([]),
  busy = ref(false),
  saving = ref(false),
  testing = ref(false)
const open = ref(false),
  form = ref(null),
  discovered = ref([]),
  picked = ref([]),
  result = ref(null)
const formatLabel = (format) => (format === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions')

/** 刷新供应商清单和导航状态，不读取任何已保存的明文密钥。 */
async function load() {
  busy.value = true
  try {
    providers.value = await api('/me/settings/providers')
    auth.capabilities = await api('/auth/capabilities')
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/** 编辑使用独立副本，取消对话框不会改变清单。 */
function edit(provider) {
  form.value = provider
    ? { ...JSON.parse(JSON.stringify(provider)), apiKey: '' }
    : {
        name: '',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai-chat',
        apiKey: '',
        enabled: true,
        timeout: 180000,
        models: [{ model: '', label: '', enabled: true }]
      }
  discovered.value = []
  picked.value = []
  result.value = null
  open.value = true
}

/** 统一表单字段，模型展示名为空时沿用模型 ID。 */
function payload(value = form.value) {
  return { ...value, models: value.models.map((m) => ({ ...m, model: m.model.trim(), label: m.label.trim() || m.model.trim() })) }
}

/** 保存供应商及全部模型；新增与修改使用同一份字段约束。 */
async function save() {
  const body = payload()
  if (!body.name.trim() || !body.models.length || body.models.some((m) => !m.model)) return reportError(new Error('请填写供应商名称，并至少添加一个模型 ID'))
  saving.value = true
  try {
    await api('/me/settings/providers' + (body.id ? '/' + body.id : ''), { method: body.id ? 'PUT' : 'POST', body })
    form.value.apiKey = ''
    open.value = false
    await load()
    success('供应商配置已保存')
  } catch (e) {
    reportError(e)
  } finally {
    saving.value = false
  }
}

/** 快捷启停供应商或单个模型，失败时重新读取服务端状态。 */
async function toggle(provider, modelIndex) {
  saving.value = true
  try {
    const body = payload(provider)
    if (modelIndex === undefined) body.enabled = !body.enabled
    else body.models[modelIndex].enabled = !body.models[modelIndex].enabled
    await api('/me/settings/providers/' + provider.id, { method: 'PUT', body })
    await load()
  } catch (e) {
    reportError(e)
  } finally {
    saving.value = false
  }
}

/** 删除仅限当前供应商；清单和导航立即同步。 */
async function remove(provider) {
  if (!(await confirmAction('删除“' + provider.name + '”及其模型配置？历史用量会保留。'))) return
  saving.value = true
  try {
    await api('/me/settings/providers/' + provider.id, { method: 'DELETE' })
    await load()
    success('已删除供应商')
  } catch (e) {
    reportError(e)
  } finally {
    saving.value = false
  }
}

/** 测试只读取模型列表；导入由用户选择，不覆盖已存在模型的启停设置。 */
async function test() {
  testing.value = true
  result.value = null
  try {
    const response = await api('/me/settings/providers/test', { method: 'POST', body: { ...form.value, models: undefined } })
    discovered.value = response.models
    result.value = { ok: true, message: response.message }
  } catch (e) {
    result.value = { ok: false, message: e.message }
  } finally {
    testing.value = false
  }
}

/** 将选中的发现模型合并到草稿中，保存后才生效。 */
function importModels() {
  const existing = new Set(form.value.models.map((m) => m.model))
  form.value.models = form.value.models.filter((m) => m.model.trim())
  for (const model of picked.value) if (!existing.has(model)) form.value.models.push({ model, label: model, enabled: true })
  picked.value = []
}

onMounted(load)
</script>

<template>
  <div v-loading="busy" class="providers-view">
    <div class="panel-heading">
      <div>
        <h2>我的 API 供应商</h2>
        <p class="muted fine">为每个供应商设置地址、API 格式和模型，创作与评估时自由选择。</p>
      </div>
      <el-button type="primary" @click="edit()">新增供应商</el-button>
    </div>
    <el-empty v-if="!providers.length" description="还没有供应商，添加你的第一个 API 配置"><el-button @click="edit()">添加供应商</el-button></el-empty>
    <article v-for="provider in providers" :key="provider.id" class="panel provider-card">
      <div class="panel-heading">
        <div class="provider-title">
          <h2>{{ provider.name }}</h2>
          <el-tag :type="provider.enabled ? 'success' : 'info'">{{ provider.enabled ? '已启用' : '已停用' }}</el-tag>
        </div>
        <div class="provider-actions">
          <el-switch :model-value="provider.enabled" :disabled="saving" active-text="启用供应商" @change="toggle(provider)" />
          <el-button :disabled="saving" @click="edit(provider)">编辑</el-button>
          <el-button text type="danger" :disabled="saving" @click="remove(provider)">删除</el-button>
        </div>
      </div>
      <p class="provider-address">
        {{ provider.baseUrl }}
        <span>· {{ formatLabel(provider.apiFormat) }} · {{ provider.keyConfigured ? 'Key 已配置' : 'Key 未配置' }}</span>
      </p>
      <el-table :data="provider.models" size="small">
        <el-table-column prop="label" label="模型名称" />
        <el-table-column prop="model" label="模型 ID" />
        <el-table-column label="状态" width="150">
          <template #default="{ row, $index }">
            <el-switch :model-value="row.enabled" :disabled="saving" :active-text="row.enabled ? '已启用' : '已停用'" @change="toggle(provider, $index)" />
          </template>
        </el-table-column>
      </el-table>
    </article>
    <el-dialog v-model="open" :title="form?.id ? '编辑供应商' : '新增供应商'" width="760px" :close-on-click-modal="!saving && !testing" :show-close="!saving && !testing">
      <el-form v-if="form" label-position="top" :disabled="saving || testing" @submit.prevent="save">
        <div class="provider-fields">
          <el-form-item label="供应商名称"><el-input v-model="form.name" maxlength="80" placeholder="例如：我的 DeepSeek" /></el-form-item>
          <el-form-item label="API 格式">
            <el-select v-model="form.apiFormat">
              <el-option label="OpenAI Chat Completions（DeepSeek 等兼容服务）" value="openai-chat" />
              <el-option label="Anthropic Messages" value="anthropic-messages" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="baseURL">
          <el-input v-model="form.baseUrl" maxlength="500" placeholder="https://api.example.com/v1" />
          <p class="fine muted">填写公开 HTTPS 地址。若服务要求 /v1，请包含版本路径；不要填写 /chat/completions 或 /messages。</p>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" type="password" autocomplete="new-password" maxlength="512" :placeholder="form.keyConfigured ? '留空保留该供应商的原 Key' : '填写该供应商的 API Key'" />
          <p class="fine muted">密钥在后端加密保存，不回显。修改服务地址后需要重新填写 Key。</p>
        </el-form-item>
        <div class="provider-fields">
          <el-form-item label="请求超时（秒）"><el-input-number :model-value="form.timeout / 1000" :min="10" :max="600" :step="10" @update:model-value="form.timeout = $event * 1000" /></el-form-item>
          <el-form-item label="供应商状态"><el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" /></el-form-item>
        </div>
        <div class="panel-heading">
          <h3>模型列表</h3>
          <div>
            <el-button :loading="testing" @click="test">测试并获取模型</el-button>
            <el-button @click="form.models.push({ model: '', label: '', enabled: true })">手动添加</el-button>
          </div>
        </div>
        <el-alert v-if="result" :title="result.message" :type="result.ok ? 'success' : 'warning'" :closable="false" />
        <div v-if="discovered.length" class="model-import">
          <el-select v-model="picked" multiple filterable placeholder="选择要添加的模型"><el-option v-for="model in discovered" :key="model" :value="model" :label="model" /></el-select>
          <el-button :disabled="!picked.length" @click="importModels">添加所选</el-button>
        </div>
        <div v-for="(model, index) in form.models" :key="index" class="model-row">
          <el-input v-model="model.model" maxlength="100" placeholder="模型 ID（与供应商一致）" />
          <el-input v-model="model.label" maxlength="100" placeholder="展示名称（可选）" />
          <el-switch v-model="model.enabled" active-text="启用" />
          <el-button text type="danger" @click="form.models.splice(index, 1)">移除</el-button>
        </div>
        <div class="dialog-actions">
          <el-button @click="open = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="saving">保存供应商</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>

<style scoped>
.providers-view {
  max-width: 1100px;
}
.provider-card {
  margin-top: 20px;
}
.provider-title,
.provider-actions,
.model-import,
.model-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.provider-title h2 {
  margin: 0;
}
.provider-address {
  margin-bottom: 20px;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.provider-address span,
.muted {
  color: var(--el-text-color-secondary);
}
.panel-heading p {
  margin-top: 10px;
}
.provider-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.model-row,
.model-import {
  margin-top: 12px;
}
.model-row .el-input {
  flex: 1;
}
.el-form-item p {
  margin-top: 7px;
  line-height: 1.7;
}
@media (max-width: 800px) {
  .panel-heading,
  .provider-actions,
  .model-row {
    flex-wrap: wrap;
  }
  .provider-fields {
    grid-template-columns: 1fr;
  }
  .model-row .el-input {
    flex-basis: 40%;
  }
}
</style>
