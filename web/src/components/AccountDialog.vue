<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { LoaderCircle, Info } from '@lucide/vue'
import { api } from '../api'
import { notify } from '../console'
import type { Account } from '../types'
import ModalShell from './ModalShell.vue'

const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: [] }>()

const a = computed(() => props.account)
const rawEmail = (a.value?.email ?? '').replace(/@phone\.local$/i, '')
const form = reactive({
  identity: rawEmail,
  name: a.value?.name ?? '',
  weight: a.value?.manualWeight ?? 1,
  realm: a.value?.realm === 'intl' ? 'intl' : a.value?.realm === 'cn' ? 'cn' : '',
})
const saving = ref(false)
const error = ref('')

function detectRealm(value: string) {
  if (/^1\d{10}$/.test(value)) form.realm = 'cn'
  else if (value.includes('@')) form.realm = 'intl'
}

async function save() {
  error.value = ''
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      email: form.identity.trim() || undefined,
      name: form.name.trim() || undefined,
      weight: Number(form.weight),
      ...(form.realm ? { realm: form.realm } : {}),
    }
    if (a.value) {
      await api(`/accounts/${encodeURIComponent(a.value.id)}`, 'PATCH', body)
      notify('账号身份已更新')
    } else {
      await api('/accounts', 'POST', body)
      notify('账号已接入')
    }
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalShell
    :title="a ? '编辑账号身份' : '手动接入账号'"
    :subtitle="a ? [a.name, a.uid].filter(Boolean).join(' · ') : '粘贴 Token 或授权后的账号'"
    @close="emit('close')"
    ><div class="modal-body">
      <div class="settings-fields">
        <label
          >显示身份<small>国内填 11 位手机号（自动脱敏），国际填邮箱地址</small>
          <input
            v-model="form.identity"
            placeholder="13800138000 或 you@example.com"
            @input="detectRealm(form.identity)"
        /></label>
        <label
          >备注昵称<small>仅用于面板展示</small>
          <input v-model="form.name" placeholder="主力号 / Google 二号" />
        </label>
        <label
          >调度权重<small>0 ~ 20，实际权重 = 自动分 × 手动权重；0 = 软暂停（全冷却时仍可兜底）</small>
          <div class="unit-input">
            <input v-model.number="form.weight" type="number" min="0" max="20" step="0.5" required /><span
              >×</span
            >
          </div>
        </label>
        <label
          >账号归属<small>影响面板分组与身份识别</small>
          <div class="realm-picker">
            <button
              type="button"
              class="button"
              :class="{ primary: form.realm === 'cn' }"
              @click="form.realm = 'cn'"
            >
              国内（手机号）
            </button>
            <button
              type="button"
              class="button"
              :class="{ primary: form.realm === 'intl' }"
              @click="form.realm = 'intl'"
            >
              国际（邮箱）
            </button>
          </div>
        </label>
        <div v-if="a" class="note-box">
          <Info :size="15" /><span
            >彻底停用账号请在「账号管理」表格的批量操作或更多菜单里切换，停用后不参与任何调度。</span
          >
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" @click="emit('close')">取消</button
        ><button class="button primary" :disabled="saving" @click="save">
          <LoaderCircle v-if="saving" class="spin" :size="14" />保存设置
        </button>
      </div>
    </footer></ModalShell
  >
</template>

<style scoped>
.realm-picker {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.realm-picker .button {
  flex: 1;
}
</style>
