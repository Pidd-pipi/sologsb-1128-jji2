import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { applyChangeRecord, isVesselInPort, processDueChanges } from '../db/vesselChange';
import { toPlain, uid } from '../utils/format';
import {
  emptyVesselQuery,
  type FishingVessel,
  type VesselChange,
  type VesselChangeInput,
  type VesselQuery,
} from '../types/vessel';

export interface VesselInput {
  name: string;
  vesselNo: string;
  homePort: string;
  length: number;
  beam: number;
  grossTonnage: number;
  enginePower: number;
  operationType: FishingVessel['operationType'];
  hullMaterial: FishingVessel['hullMaterial'];
  owner: string;
  certificateExpiry: string;
}

/** 变更提交结果：conflict 表示基础版本已过期（旧页面需重载） */
export interface ChangeSubmitResult {
  ok: boolean;
  reason?: 'conflict';
  change?: VesselChange;
  /** 是否挂起（在港或生效时间未到，待航次结束 / 时间到期后生效） */
  pending?: boolean;
}

export const useVesselStore = defineStore('vessel', () => {
  const vessels = ref<FishingVessel[]>([]);
  const vesselChanges = ref<VesselChange[]>([]);
  const loading = ref(false);
  const query = ref<VesselQuery>(emptyVesselQuery());

  /** 组合查询：作业类型 + 主机功率区间 + 总吨位区间 + 船籍港 */
  const results = computed(() => {
    const q = query.value;
    const homePort = q.homePort.trim();
    return vessels.value.filter((v) => {
      if (q.operationType && v.operationType !== q.operationType) return false;
      if (q.powerMin !== null && v.enginePower < q.powerMin) return false;
      if (q.powerMax !== null && v.enginePower > q.powerMax) return false;
      if (q.tonnageMin !== null && v.grossTonnage < q.tonnageMin) return false;
      if (q.tonnageMax !== null && v.grossTonnage > q.tonnageMax) return false;
      if (homePort && !v.homePort.includes(homePort)) return false;
      return true;
    });
  });

  const homePorts = computed(() => Array.from(new Set(vessels.value.map((v) => v.homePort))).sort());

  function vesselById(id: string): FishingVessel | undefined {
    return vessels.value.find((v) => v.id === id);
  }

  /**
   * 按船名找渔船：现船名与历史船名都算（过户 / 更名后，时间线与历史流水
   * 仍能按当时船名定位到同一艘船）。
   */
  function vesselByName(name: string): FishingVessel | undefined {
    const target = name.trim();
    if (!target) return undefined;
    const hit = vessels.value.find((v) => v.name === target);
    if (hit) return hit;
    const changed = vesselChanges.value.find(
      (c) => c.name === target && c.status === 'effective',
    );
    return changed ? vesselById(changed.vesselId) : undefined;
  }

  /** 某条渔船的变更记录（按版本号升序） */
  function changesOf(vesselId: string): VesselChange[] {
    return vesselChanges.value
      .filter((c) => c.vesselId === vesselId)
      .sort((a, b) => a.version - b.version);
  }

  /** 某条渔船待生效的变更 */
  function pendingChangesOf(vesselId: string): VesselChange[] {
    return changesOf(vesselId).filter((c) => c.status === 'pending');
  }

  function resetQuery(): void {
    query.value = emptyVesselQuery();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      vessels.value = await db.vessels.toArray();
      vesselChanges.value = await db.vesselChanges.toArray();
      // 落地前先把到期的待生效变更处理掉（如在港期间跨了航次结束）
      const applied = await processDueChanges();
      if (applied > 0) {
        vessels.value = await db.vessels.toArray();
        vesselChanges.value = await db.vesselChanges.toArray();
      }
    } finally {
      loading.value = false;
    }
  }

  async function createVessel(input: VesselInput): Promise<FishingVessel> {
    const now = new Date().toISOString();
    const vessel: FishingVessel = {
      id: uid('v'),
      name: input.name.trim(),
      vesselNo: input.vesselNo.trim().toUpperCase(),
      homePort: input.homePort.trim(),
      length: Number(input.length),
      beam: Number(input.beam),
      grossTonnage: Number(input.grossTonnage),
      enginePower: Number(input.enginePower),
      operationType: input.operationType,
      hullMaterial: input.hullMaterial,
      owner: input.owner.trim(),
      certificateExpiry: input.certificateExpiry,
      version: 1,
      createdAt: now,
    };
    // 写库前脱代理，避免 DataCloneError
    await db.vessels.put(toPlain(vessel));
    // 同步写一条「初始建档」变更，作为版本 1 的依据
    const initial: VesselChange = {
      id: uid('vc'),
      vesselId: vessel.id,
      version: 1,
      name: vessel.name,
      homePort: vessel.homePort,
      owner: vessel.owner,
      effectiveAt: now,
      status: 'effective',
      baseVersion: 0,
      reason: '初始建档',
      createdAt: now,
    };
    await db.vesselChanges.put(toPlain(initial));
    vessels.value = [...vessels.value, vessel];
    vesselChanges.value = [...vesselChanges.value, initial];
    return vessel;
  }

  async function updateVessel(id: string, patch: Partial<FishingVessel>): Promise<void> {
    const hit = vesselById(id);
    if (!hit) return;
    const next: FishingVessel = { ...hit, ...patch };
    await db.vessels.put(toPlain(next));
    vessels.value = vessels.value.map((v) => (v.id === id ? next : v));
  }

  /**
   * 提交档案变更（过户 / 更名 / 转港）。
   *
   * 乐观锁：以页面加载时的 baseVersion 为凭据，在事务内 compare-and-swap——
   * 只有渔船档案当前版本仍等于 baseVersion 时才写入，因此两个人同时提交
   * 同一条船的变更只能成功一笔；版本不符时返回 conflict，由页面提示重载。
   *
   * 生效规则：生效时间已到且当前不在港 → 立即生效；否则挂起（pending），
   * 等最后一条航次结束（出港释放泊位）且生效时间到期后再生效，生效前照旧。
   */
  async function submitChange(
    vesselId: string,
    input: VesselChangeInput,
    baseVersion: number,
  ): Promise<ChangeSubmitResult> {
    const vessel = vesselById(vesselId);
    if (!vessel) throw new Error('渔船不存在');

    const now = new Date();
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt).toISOString() : now.toISOString();
    const inPort = await isVesselInPort(vesselId);
    const shouldApplyNow = new Date(effectiveAt).getTime() <= now.getTime() && !inPort;

    const result = await db.transaction('rw', db.vessels, db.vesselChanges, async () => {
      const current = await db.vessels.get(vesselId);
      if (!current) throw new Error('渔船档案不存在');
      if ((current.version ?? 1) !== baseVersion) {
        // 基础版本已过期：另一个人 / 页面先提交了变更，本笔作废
        return { ok: false as const, reason: 'conflict' as const };
      }
      const nextVersion = (current.version ?? 1) + 1;
      const change: VesselChange = {
        id: uid('vc'),
        vesselId,
        version: nextVersion,
        name: input.name.trim(),
        homePort: input.homePort.trim(),
        owner: input.owner.trim(),
        effectiveAt,
        status: shouldApplyNow ? 'effective' : 'pending',
        baseVersion,
        reason: input.reason?.trim() || undefined,
        createdAt: now.toISOString(),
      };
      await db.vesselChanges.add(toPlain(change));
      const patch: Partial<FishingVessel> = { version: nextVersion };
      if (shouldApplyNow) {
        patch.name = change.name;
        patch.homePort = change.homePort;
        patch.owner = change.owner;
      }
      await db.vessels.update(vesselId, patch);
      return { ok: true as const, change, pending: !shouldApplyNow };
    });

    if (result.ok && result.change) {
      const change = result.change;
      vesselChanges.value = [...vesselChanges.value, change];
      vessels.value = vessels.value.map((v) => {
        if (v.id !== vesselId) return v;
        const next: FishingVessel = { ...v, version: change.version };
        if (!result.pending) {
          next.name = change.name;
          next.homePort = change.homePort;
          next.owner = change.owner;
        }
        return next;
      });
    }
    return result;
  }

  /**
   * 处理到期的待生效变更（在港时跳过），并把已变更的档案同步回本地状态。
   * 登记进出港（航次结束）后、进入渔船详情时调用。
   */
  async function processDue(vesselId?: string): Promise<number> {
    const applied = await processDueChanges(vesselId);
    if (applied > 0) {
      if (vesselId) {
        const fresh = await db.vessels.get(vesselId);
        if (fresh) {
          vessels.value = vessels.value.map((v) => (v.id === vesselId ? fresh : v));
        }
      } else {
        vessels.value = await db.vessels.toArray();
      }
      vesselChanges.value = await db.vesselChanges.toArray();
    }
    return applied;
  }

  /** 从 IndexedDB 重新读取单条渔船档案（打开变更弹窗前调用，降低冲突概率）。 */
  async function refreshVessel(vesselId: string): Promise<FishingVessel | undefined> {
    const fresh = await db.vessels.get(vesselId);
    if (fresh) {
      vessels.value = vessels.value.map((v) => (v.id === vesselId ? fresh : v));
    }
    return fresh;
  }

  return {
    vessels,
    vesselChanges,
    loading,
    query,
    results,
    homePorts,
    vesselById,
    vesselByName,
    changesOf,
    pendingChangesOf,
    resetQuery,
    loadAll,
    createVessel,
    updateVessel,
    submitChange,
    processDue,
    refreshVessel,
  };
});
