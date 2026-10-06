<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { useVesselStore } from '../../stores/vesselStore';
import { usePortStore } from '../../stores/portStore';
import type { FishingVessel, VesselChangeInput } from '../../types/vessel';
import { formatDateTime, nowLocalInputValue } from '../../utils/format';

const props = defineProps<{
  modelValue: boolean;
  vessel: FishingVessel | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'changed'): void;
}>();

const vesselStore = useVesselStore();
const portStore = usePortStore();

const formRef = ref<FormInstance>();
const submitting = ref(false);
/** 打开弹窗时依据的档案版本（乐观锁 baseVersion） */
const baseVersion = ref(0);

const form = reactive<VesselChangeInput>({
  name: '',
  homePort: '',
  owner: '',
  effectiveAt: nowLocalInputValue(),
  reason: '',
});

const rules: FormRules = {
  name: [{ required: true, message: '请输入新船名', trigger: 'blur' }],
  homePort: [{ required: true, message: '请输入船籍港', trigger: 'blur' }],
  owner: [{ required: true, message: '请输入船主', trigger: 'blur' }],
  effectiveAt: [{ required: true, message: '请选择生效时间', trigger: 'change' }],
};

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

/** 该船当前是否在港（占用泊位）：在港时变更先挂起，等航次结束后生效 */
const inPort = computed(() => {
  if (!props.vessel) return null;
  return (
    portStore.berths.find((b) => b.vesselId === props.vessel!.id && b.status === '占用') ?? null
  );
});

const pendingChanges = computed(() =>
  props.vessel ? vesselStore.pendingChangesOf(props.vessel.id) : [],
);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open || !props.vessel) return;
    // 打开时重新从 DB 读取最新档案，尽量减少与他人并发提交的冲突
    const fresh = await vesselStore.refreshVessel(props.vessel.id);
    const current = fresh ?? props.vessel;
    baseVersion.value = current.version ?? 1;
    form.name = current.name;
    form.homePort = current.homePort;
    form.owner = current.owner;
    form.effectiveAt = nowLocalInputValue();
    form.reason = '';
  },
);

function reload(): void {
  window.location.reload();
}

async function submit(): Promise<void> {
  if (!props.vessel) return;
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  try {
    const result = await vesselStore.submitChange(props.vessel.id, { ...form }, baseVersion.value);
    if (!result.ok && result.reason === 'conflict') {
      // 旧页面提交：档案已被其他页面 / 人员修改，提示重载
      await ElMessageBox.confirm(
        '该渔船档案已被其他页面或人员修改，当前页面数据已过期。请刷新页面后重新提交变更。',
        '档案已变更',
        { confirmButtonText: '立即刷新', cancelButtonText: '稍后', type: 'warning' },
      )
        .then(() => reload())
        .catch(() => undefined);
      return;
    }
    if (result.pending) {
      ElMessage.warning(
        inPort.value
          ? `变更已登记，船还在港（泊位 ${inPort.value?.berthNo ?? ''}），将在最后一条航次结束（出港）后生效，生效前照旧。`
          : `变更已登记，将于 ${formatDateTime(result.change!.effectiveAt)} 生效，生效前照旧。`,
      );
    } else {
      ElMessage.success(`档案变更已生效：${result.change?.name ?? ''}`);
    }
    visible.value = false;
    emit('changed');
  } catch (error) {
    ElMessage.error(`变更失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="渔船档案变更（过户 / 更名 / 转港）" width="560px" data-testid="vessel-change-dialog">
    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="change-alert"
      title="生效前照旧：历史流水、泊位占用与时间线仍按当时船名留存，不会被本次变更覆盖。"
    />
    <el-alert
      v-if="inPort"
      type="warning"
      show-icon
      :closable="false"
      class="change-alert"
      :title="`该船当前在港（泊位 ${inPort.berthNo}），本次变更将先挂起，等最后一条航次结束（出港）后再生效。`"
    />

    <el-form ref="formRef" :model="form" :rules="rules" label-width="90px" class="change-form">
      <el-form-item label="新船名" prop="name">
        <el-input v-model="form.name" placeholder="如：浙象渔05123" data-testid="change-name" />
      </el-form-item>
      <el-form-item label="船籍港" prop="homePort">
        <el-input v-model="form.homePort" placeholder="如：石浦" data-testid="change-home-port" />
      </el-form-item>
      <el-form-item label="船主" prop="owner">
        <el-input v-model="form.owner" placeholder="如：林海平" data-testid="change-owner" />
      </el-form-item>
      <el-form-item label="生效时间" prop="effectiveAt">
        <el-date-picker
          v-model="form.effectiveAt"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm"
          placeholder="选择生效时间"
          style="width: 100%"
          data-testid="change-effective-at"
        />
      </el-form-item>
      <el-form-item label="变更原因">
        <el-input v-model="form.reason" placeholder="如：过户转让 / 更名（选填）" data-testid="change-reason" />
      </el-form-item>
      <el-form-item label="基础版本">
        <el-tag size="small" type="info" effect="plain" data-testid="change-base-version">v{{ baseVersion }}</el-tag>
        <span class="version-hint">提交时据此做并发校验，过期需刷新页面</span>
      </el-form-item>
    </el-form>

    <div v-if="pendingChanges.length" class="pending-hint" data-testid="pending-changes-hint">
      尚有 {{ pendingChanges.length }} 条变更待生效：
      <el-tag v-for="c in pendingChanges" :key="c.id" size="small" type="warning" effect="plain" class="pending-tag">
        {{ c.name }} · {{ formatDateTime(c.effectiveAt) }} 生效
      </el-tag>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" data-testid="submit-change" @click="submit">提交变更</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.change-alert {
  margin-bottom: 12px;
}
.change-form {
  margin-top: 4px;
}
.version-hint {
  margin-left: 8px;
  font-size: 12px;
  color: #9aa9b6;
}
.pending-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 12px;
  font-size: 12px;
  color: #b88230;
}
.pending-tag {
  margin: 0;
}
</style>
