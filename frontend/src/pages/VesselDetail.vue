<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { useVesselStore } from '../stores/vesselStore';
import { usePortStore } from '../stores/portStore';
import VesselSpecTable from '../components/common/VesselSpecTable.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { PortCall } from '../types/call';
import type { VesselChangeInput, VesselVersion } from '../types/vesselVersion';
import { emptyVesselChangeInput, versionStatusText } from '../types/vesselVersion';
import { ArchiveConflictError, ArchiveValidationError } from '../db/vesselArchive';
import { daysUntilExpiry, expiryText, powerTier, tonnageTier } from '../utils/tonnage';
import { formatDateTime, formatNumber } from '../utils/format';

const route = useRoute();
const router = useRouter();
const vesselStore = useVesselStore();
const portStore = usePortStore();

const vesselId = computed(() => String(route.params.id ?? ''));
const vessel = computed(() => vesselStore.vesselById(vesselId.value));
const loaded = ref(false);

const calls = computed<PortCall[]>(() => (vessel.value ? portStore.callsOfVessel(vessel.value.id) : []));

const versionList = computed<VesselVersion[]>(() =>
  vessel.value ? [...vesselStore.versionsOfVessel(vessel.value.id)].reverse() : [],
);
const outstanding = computed<VesselVersion | undefined>(() =>
  vessel.value ? vesselStore.outstandingVersion(vessel.value.id) : undefined,
);
const formerNames = computed(() => (vessel.value ? vesselStore.formerNames(vessel.value.id) : []));

const occupancy = computed(() => {
  if (!vessel.value) return [] as Array<{ portName: string; berthNo: string; berthAt: string | null }>;
  return portStore.berths
    .filter((b) => b.vesselId === vessel.value!.id && b.status === '占用')
    .map((b) => ({
      portName: portStore.portById(b.portId)?.name ?? b.portId,
      berthNo: b.berthNo,
      berthAt: b.berthAt,
    }));
});
const inPort = computed(() => occupancy.value.length > 0);

const expiryDays = computed(() => (vessel.value ? daysUntilExpiry(vessel.value.certificateExpiry) : Number.NaN));

const expiryTagType = computed(() => {
  const days = expiryDays.value;
  if (Number.isNaN(days)) return 'info';
  if (days < 0) return 'danger';
  if (days <= 90) return 'warning';
  return 'success';
});

const totals = computed(() => ({
  ice: calls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: calls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: calls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function timelineType(call: PortCall): 'primary' | 'success' {
  return call.type === '进港' ? 'primary' : 'success';
}

/** 历史流水发生时的船名（时点还原），用于在流水上标注当时船名 */
function callVesselName(call: PortCall): string {
  return vesselStore.nameAtTime(call.vesselId, call.time);
}
function showFormerName(call: PortCall): boolean {
  return Boolean(vessel.value) && callVesselName(call) !== vessel.value!.name;
}

async function bootstrap(): Promise<void> {
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!portStore.calls.length) await portStore.loadAll();
  loaded.value = true;
}

onMounted(bootstrap);
watch(vesselId, bootstrap);

/* ---------------- 档案变更 ---------------- */

const changeVisible = ref(false);
const changeSubmitting = ref(false);
const changeFormRef = ref<FormInstance>();
const changeForm = ref<VesselChangeInput>(emptyVesselChangeInput());
/** 打开弹窗时锁定的修订号（乐观锁），提交时比对 */
const changeExpectedRev = ref(0);

const changeRules: FormRules = {
  name: [{ required: true, message: '请输入新船名', trigger: 'blur' }],
  homePort: [{ required: true, message: '请输入新船籍港', trigger: 'blur' }],
  owner: [{ required: true, message: '请输入新船主', trigger: 'blur' }],
};

function openChangeDialog(): void {
  if (!vessel.value) return;
  changeForm.value = emptyVesselChangeInput(vessel.value);
  changeExpectedRev.value = vessel.value.rev;
  changeVisible.value = true;
}

async function submitChange(): Promise<void> {
  if (!changeFormRef.value || !vessel.value) return;
  const valid = await changeFormRef.value.validate().catch(() => false);
  if (!valid) return;
  changeSubmitting.value = true;
  try {
    const result = await vesselStore.submitChange(vessel.value.id, { ...changeForm.value }, changeExpectedRev.value);
    changeVisible.value = false;
    if (result.status === 'pending') {
      ElMessageBox.alert(
        `该船当前正在港（泊位占用中），变更已挂起。将在本航次结束——即该船先出港、再进港登记后自动生效，生效前流水、泊位与地图仍显示旧船名。`,
        '档案变更已挂起',
        { type: 'warning', confirmButtonText: '知道了' },
      );
    } else if (result.status === 'scheduled') {
      ElMessage.success(`档案变更已排期，将于 ${formatDateTime(result.version.effectiveAt)} 生效，生效前照旧`);
    } else {
      ElMessage.success(`档案变更已生效，此后流水与泊位按新船名「${result.version.name}」登记`);
    }
  } catch (error) {
    if (error instanceof ArchiveConflictError) {
      // 另一笔已成功 / 他人刚改过：旧页面必须重载
      ElMessageBox.alert(error.message, '档案已被他人变更，请重载', {
        type: 'error',
        confirmButtonText: '重载最新档案',
      })
        .then(() => vesselStore.reloadVersions())
        .catch(() => undefined);
    } else if (error instanceof ArchiveValidationError) {
      ElMessage.warning(error.message);
    } else {
      ElMessage.error(`办理失败：${(error as Error).message}`);
    }
  } finally {
    changeSubmitting.value = false;
  }
}

function versionTagType(status: VesselVersion['status']): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'current') return 'success';
  if (status === 'scheduled') return 'warning';
  if (status === 'pending') return 'danger';
  return 'info';
}
</script>

<template>
  <section class="page">
    <el-breadcrumb separator="/">
      <el-breadcrumb-item :to="{ path: '/vessels' }">渔船检索</el-breadcrumb-item>
      <el-breadcrumb-item>{{ vessel ? vessel.name : '渔船档案' }}</el-breadcrumb-item>
    </el-breadcrumb>

    <template v-if="vessel">
      <header class="page__head">
        <div>
          <h1>{{ vessel.name }}</h1>
          <p class="page__sub">
            渔船编号 {{ vessel.vesselNo }} · 船籍港 {{ vessel.homePort }} · 船主 {{ vessel.owner }}
            <el-tag v-if="formerNames.length" size="small" type="info" effect="plain" class="former-tag">
              曾用名 {{ formerNames.join('、') }}
            </el-tag>
          </p>
        </div>
        <div class="page__head-actions">
          <el-tag effect="dark">{{ vessel.operationType }}</el-tag>
          <el-tag type="info" effect="plain">{{ vessel.hullMaterial }}</el-tag>
          <el-tag :type="inPort ? 'warning' : 'success'" effect="plain" data-testid="in-port-tag">
            {{ inPort ? '在港' : '不在港' }}
          </el-tag>
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
          <el-button type="warning" data-testid="open-change-dialog" @click="openChangeDialog">办理档案变更</el-button>
        </div>
      </header>

      <el-alert
        v-if="outstanding"
        :type="outstanding.status === 'pending' ? 'error' : 'warning'"
        show-icon
        :closable="false"
        class="outstanding-alert"
        data-testid="outstanding-alert"
      >
        <template #title>
          存在一笔「{{ versionStatusText(outstanding.status) }}」的档案变更：
          {{ outstanding.name }} · {{ outstanding.homePort }} · 船主 {{ outstanding.owner }}
        </template>
        <template #default>
          <template v-if="outstanding.status === 'pending'">
            申请时该船在港，已挂起；将在本航次结束（先出港、再进港登记）后自动生效，生效前一律照旧船名。
          </template>
          <template v-else>
            计划 {{ formatDateTime(outstanding.effectiveAt) }} 生效，生效前流水、泊位与地图仍显示旧档案。
          </template>
        </template>
      </el-alert>

      <el-row :gutter="16">
        <el-col :lg="16" :md="24">
          <VesselSpecTable :vessels="[vessel]" :clickable="false" />
        </el-col>
        <el-col :lg="8" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">档案要点</span></template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="总吨位">
                {{ formatNumber(vessel.grossTonnage) }} t（{{ tonnageTier(vessel.grossTonnage) }}）
              </el-descriptions-item>
              <el-descriptions-item label="主机功率">
                {{ formatNumber(vessel.enginePower, 0) }} kW（{{ powerTier(vessel.enginePower) }}）
              </el-descriptions-item>
              <el-descriptions-item label="证书有效期">
                {{ vessel.certificateExpiry }}
                <el-tag size="small" :type="expiryTagType" data-testid="expiry-tag">{{ expiryText(vessel.certificateExpiry) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="累计进出港">{{ calls.length }} 次</el-descriptions-item>
              <el-descriptions-item label="累计加冰 / 加油">
                {{ formatNumber(totals.ice, 0) }} kg / {{ formatNumber(totals.fuel, 0) }} L
              </el-descriptions-item>
              <el-descriptions-item label="累计卸货">{{ formatNumber(totals.unload, 0) }} kg</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">当前泊位</span></template>
            <el-table :data="occupancy" size="small" border empty-text="该船当前不在港">
              <el-table-column prop="portName" label="渔港" min-width="130" />
              <el-table-column prop="berthNo" label="泊位号" width="90" />
              <el-table-column label="靠泊时间" min-width="150">
                <template #default="scope">{{ formatDateTime(scope.row.berthAt) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">渔船档案时间线（{{ versionList.length }} 个版本，按当时船名追溯同一艘船）</span>
        </template>
        <el-timeline data-testid="version-timeline">
          <el-timeline-item
            v-for="v in versionList"
            :key="v.id"
            :timestamp="`v${v.versionNo} · ${v.status === 'current' ? '生效于 ' + formatDateTime(v.appliedAt) : v.status === 'superseded' ? formatDateTime(v.appliedAt) + ' 至 ' + formatDateTime(v.endedAt) : '申请于 ' + formatDateTime(v.requestedAt)}`"
            :type="v.status === 'current' ? 'success' : v.status === 'superseded' ? 'info' : 'warning'"
            placement="top"
          >
            <div class="version-row">
              <el-tag size="small" :type="versionTagType(v.status)">{{ versionStatusText(v.status) }}</el-tag>
              <b>{{ v.name }}</b>
              <span>船籍港 {{ v.homePort }}</span>
              <span>船主 {{ v.owner }}</span>
              <el-tag v-if="v.status === 'pending'" size="small" type="danger" effect="plain">等待本航次结束</el-tag>
              <el-tag v-else-if="v.status === 'scheduled'" size="small" type="warning" effect="plain">
                {{ formatDateTime(v.effectiveAt) }} 生效
              </el-tag>
              <span v-if="v.reason" class="version-reason">（{{ v.reason }}）</span>
            </div>
          </el-timeline-item>
        </el-timeline>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <template #header><span class="card-title">进出港记录时间线（{{ calls.length }} 条，船名为登记当时快照）</span></template>
        <el-timeline v-if="calls.length" data-testid="call-timeline">
          <el-timeline-item
            v-for="call in calls"
            :key="call.id"
            :timestamp="formatDateTime(call.time)"
            :type="timelineType(call)"
            placement="top"
          >
            <div class="timeline-row">
              <el-tag size="small" :type="call.type === '进港' ? 'primary' : 'success'">{{ call.type }}</el-tag>
              <b>{{ call.vesselName }}</b>
              <el-tag v-if="showFormerName(call)" size="small" type="info" effect="plain" data-testid="former-call-tag">
                当时船名（现 {{ vessel.name }}）
              </el-tag>
              <span>泊位 {{ call.berthNo }}</span>
              <span>加冰 {{ formatNumber(call.iceKg, 0) }} kg</span>
              <span>加油 {{ formatNumber(call.fuelL, 0) }} L</span>
              <span>卸货 {{ formatNumber(call.unloadKg, 0) }} kg</span>
              <el-tag size="small" type="info" effect="plain">{{ call.visaStatus }}</el-tag>
            </div>
          </el-timeline-item>
        </el-timeline>
        <EmptyState v-else title="暂无进出港记录" description="该渔船尚未登记进出港流水，可前往登记页补录。">
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </EmptyState>
      </el-card>
    </template>

    <EmptyState v-else-if="loaded" title="未找到该渔船" description="该渔船档案可能尚未建立，返回检索页建档后再查看。">
      <el-button type="primary" @click="router.push('/vessels')">返回渔船检索</el-button>
    </EmptyState>

    <el-dialog v-model="changeVisible" title="办理渔船档案变更（过户 / 更名）" width="640px" data-testid="change-dialog">
      <el-alert
        :type="inPort ? 'error' : 'info'"
        show-icon
        :closable="false"
        class="change-alert"
        data-testid="change-hint"
      >
        <template #title>
          {{ inPort ? '该船当前在港：变更将先挂起，待本航次结束（出港后再次进港）才生效' : '该船当前不在港' }}
        </template>
        <template #default>
          生效前旧流水、泊位占用与地图船名一律照旧；生效后新流水按新档案登记，历史记录仍可按当时船名追溯。
        </template>
      </el-alert>
      <el-form ref="changeFormRef" :model="changeForm" :rules="changeRules" label-width="110px">
        <el-form-item label="新船名" prop="name">
          <el-input id="change-name" v-model="changeForm.name" placeholder="如：浙象渔06688" />
        </el-form-item>
        <el-form-item label="新船籍港" prop="homePort">
          <el-input id="change-home-port" v-model="changeForm.homePort" placeholder="如：石浦" />
        </el-form-item>
        <el-form-item label="新船主" prop="owner">
          <el-input id="change-owner" v-model="changeForm.owner" placeholder="过户后的船主姓名" />
        </el-form-item>
        <el-form-item label="生效时间">
          <el-date-picker
            id="change-effective-at"
            v-model="changeForm.effectiveAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="留空 = 立即生效（在港则挂起）"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="变更原因">
          <el-input id="change-reason" v-model="changeForm.reason" placeholder="如：船舶过户 / 更名登记" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="changeVisible = false">取消</el-button>
        <el-button type="primary" :loading="changeSubmitting" data-testid="submit-change" @click="submitChange">
          提交变更
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.former-tag {
  margin-left: 8px;
}
.page__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.outstanding-alert,
.change-alert {
  border-radius: 10px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.version-row,
.timeline-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.version-reason {
  color: #97a6b4;
}
</style>
