<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useVesselStore } from '../stores/vesselStore';
import { usePortStore } from '../stores/portStore';
import VesselSpecTable from '../components/common/VesselSpecTable.vue';
import VesselChangeDialog from '../components/common/VesselChangeDialog.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { PortCall } from '../types/call';
import type { VesselChange } from '../types/vessel';
import { daysUntilExpiry, expiryText, powerTier, tonnageTier } from '../utils/tonnage';
import { formatDateTime, formatDate, formatNumber } from '../utils/format';

const route = useRoute();
const router = useRouter();
const vesselStore = useVesselStore();
const portStore = usePortStore();

const vesselId = computed(() => String(route.params.id ?? ''));
const vessel = computed(() => vesselStore.vesselById(vesselId.value));
const loaded = ref(false);

const changeDialogVisible = ref(false);

const calls = computed<PortCall[]>(() => (vessel.value ? portStore.callsOfVessel(vessel.value.id) : []));

/** 该船的档案变更记录（按版本升序） */
const changes = computed<VesselChange[]>(() =>
  vessel.value ? vesselStore.changesOf(vessel.value.id) : [],
);

/** 待生效变更（在港等航次结束 / 等生效时间） */
const pendingChanges = computed<VesselChange[]>(() => changes.value.filter((c) => c.status === 'pending'));

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

async function bootstrap(): Promise<void> {
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!portStore.calls.length) await portStore.loadAll();
  // 进入详情时先落地到期的待生效变更（如在港期间航次已结束）
  if (vesselId.value) await vesselStore.processDue(vesselId.value);
  loaded.value = true;
}

onMounted(bootstrap);
watch(vesselId, bootstrap);
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
          </p>
        </div>
        <div class="page__head-actions">
          <el-tag effect="dark">{{ vessel.operationType }}</el-tag>
          <el-tag type="info" effect="plain">{{ vessel.hullMaterial }}</el-tag>
          <el-button type="primary" data-testid="open-change-dialog" @click="changeDialogVisible = true">档案变更</el-button>
          <el-button @click="router.push('/calls')">登记进出港</el-button>
        </div>
      </header>

      <el-alert
        v-for="c in pendingChanges"
        :key="c.id"
        type="warning"
        show-icon
        :closable="false"
        class="pending-alert"
        :title="`变更待生效：${c.name}（${c.homePort} · ${c.owner}），${formatDateTime(c.effectiveAt)} 生效${
          portStore.berths.some((b) => b.vesselId === vessel?.id && b.status === '占用')
            ? '；当前在港，将在最后一条航次结束（出港）后生效'
            : ''
        }`"
      />

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
        <template #header><span class="card-title">进出港记录时间线（{{ calls.length }} 条）</span></template>
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
              <el-tag
                v-if="call.vesselName && call.vesselName !== vessel.name"
                size="small"
                type="warning"
                effect="plain"
                data-testid="former-name-tag"
              >曾用名 {{ call.vesselName }}</el-tag>
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

      <el-card shadow="never" class="detail-card">
        <template #header><span class="card-title">档案变更记录（{{ changes.length }} 条）</span></template>
        <el-table :data="changes" size="small" border empty-text="暂无档案变更记录" data-testid="change-history-table">
          <el-table-column label="版本" width="70">
            <template #default="scope">
              <el-tag size="small" :type="scope.row.status === 'pending' ? 'warning' : 'info'" effect="plain">
                v{{ scope.row.version }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="船名" min-width="130" />
          <el-table-column prop="homePort" label="船籍港" min-width="90" />
          <el-table-column prop="owner" label="船主" min-width="90" />
          <el-table-column label="生效时间" min-width="150">
            <template #default="scope">{{ formatDateTime(scope.row.effectiveAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="scope">
              <el-tag size="small" :type="scope.row.status === 'pending' ? 'warning' : 'success'">
                {{ scope.row.status === 'pending' ? '待生效' : '已生效' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="reason" label="变更原因" min-width="120">
            <template #default="scope">{{ scope.row.reason || '—' }}</template>
          </el-table-column>
          <el-table-column label="登记时间" min-width="150">
            <template #default="scope">{{ formatDate(scope.row.createdAt) }}</template>
          </el-table-column>
        </el-table>
        <p class="detail-hint">
          生效前照旧：待生效期间流水与泊位仍按原船名登记；生效后按新档案登记，历史记录保留当时船名。
        </p>
      </el-card>
    </template>

    <EmptyState v-else-if="loaded" title="未找到该渔船" description="该渔船档案可能尚未建立，返回检索页建档后再查看。">
      <el-button type="primary" @click="router.push('/vessels')">返回渔船检索</el-button>
    </EmptyState>

    <VesselChangeDialog v-model="changeDialogVisible" :vessel="vessel ?? null" @changed="bootstrap" />
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
.page__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.timeline-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.pending-alert {
  margin-bottom: 16px;
  border-radius: 10px;
}
</style>
