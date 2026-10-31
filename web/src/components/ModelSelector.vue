<script setup>
/** 供应商分组的模型选择器：仅列出启用供应商下的启用模型，不缓存其他用户的配置。 */
import { ref, computed, onMounted } from 'vue'
import { api } from '../api/client'
import { reportError } from '../shared/feedback'

const props = defineProps({ modelValue: Object, disabled: Boolean })
const emit = defineEmits(['update:modelValue'])
const providers = ref([]),
  loading = ref(false)
const groups = computed(() => providers.value.filter((p) => p.enabled && p.keyConfigured && p.models.some((m) => m.enabled)))
const selected = computed({
  get: () => (props.modelValue ? JSON.stringify(props.modelValue) : ''),
  set: (value) => emit('update:modelValue', value ? JSON.parse(value) : undefined)
})

/** 保留仍可用的选择；首次加载自动选择第一项，空清单明确清空选择。 */
async function load() {
  loading.value = true
  try {
    providers.value = await api('/me/settings/providers')
    const current = props.modelValue
    if (!groups.value.some((p) => p.id === current?.providerId && p.models.some((m) => m.enabled && m.model === current.model))) {
      const first = groups.value[0]
      emit('update:modelValue', first ? { providerId: first.id, model: first.models.find((m) => m.enabled).model } : undefined)
    }
  } catch (e) {
    reportError(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <el-select
    v-model="selected"
    class="model-selector"
    :disabled="disabled"
    :loading="loading"
    filterable
    placeholder="选择供应商 / 模型"
    no-data-text="暂无启用模型，请先添加 API 配置"
    @visible-change="$event && load()">
    <el-option-group v-for="provider in groups" :key="provider.id" :label="provider.name">
      <el-option
        v-for="model in provider.models.filter((m) => m.enabled)"
        :key="model.model"
        :label="provider.name + ' / ' + model.label"
        :value="JSON.stringify({ providerId: provider.id, model: model.model })" />
    </el-option-group>
  </el-select>
</template>

<style scoped>
.model-selector {
  width: 100%;
  min-width: 180px;
}
</style>
