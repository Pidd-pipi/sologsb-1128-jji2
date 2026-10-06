import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyVesselQuery, type FishingVessel, type VesselQuery } from '../types/vessel';
import type { VesselChangeInput, VesselChangeResult, VesselVersion } from '../types/vesselVersion';
import {
  addBaselineVersion,
  allNamesOf,
  currentVersionOf,
  formerNamesOf,
  outstandingVersionOf,
  submitVesselChange,
  versionAt,
  versionsOf,
} from '../db/vesselArchive';
import { consumeLocalEcho, emitDataEvent, markLocalEcho, subscribeDataChange } from '../db/events';

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

export const useVesselStore = defineStore('vessel', () => {
  const vessels = ref<FishingVessel[]>([]);
  const versions = ref<VesselVersion[]>([]);
  const loading = ref(false);
  const query = ref<VesselQuery>(emptyVesselQuery());

  /**
   * 组合查询：作业类型 + 主机功率区间 + 总吨位区间 + 船籍港。
   * 船名关键字隐藏在 query.homePort 之外另算；这里保留原条件，
   * 历史曾用名命中也能把同一艘船查出来。
   */
  const results = computed(() => {
    const q = query.value;
    const homePort = q.homePort.trim();
    const nameKw = q.name.trim();
    return vessels.value.filter((v) => {
      if (nameKw) {
        // 同时匹配当前船名与历史曾用名：更名后按旧船名仍能找到同一艘船
        const names = [v.name, ...allNamesOf(versions.value, v.id)];
        if (!names.some((n) => n.includes(nameKw))) return false;
      }
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

  function vesselByName(name: string): FishingVessel | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    // 先按当前船名，再按历史曾用名，保证更名后仍能定位同一艘船
    return (
      vessels.value.find((v) => v.name === trimmed) ??
      vessels.value.find((v) => allNamesOf(versions.value, v.id).includes(trimmed))
    );
  }

  function versionsOfVessel(vesselId: string): VesselVersion[] {
    return versionsOf(versions.value, vesselId);
  }

  function currentVersion(vesselId: string): VesselVersion | undefined {
    return currentVersionOf(versions.value, vesselId);
  }

  function outstandingVersion(vesselId: string): VesselVersion | undefined {
    return outstandingVersionOf(versions.value, vesselId);
  }

  function versionOfVesselAt(vesselId: string, atIso: string): VesselVersion | undefined {
    return versionAt(versions.value, vesselId, atIso);
  }

  /** 某条历史流水发生时的船名（时点还原），缺版本时回退当前档案 */
  function nameAtTime(vesselId: string, atIso: string): string {
    return versionAt(versions.value, vesselId, atIso)?.name ?? vesselById(vesselId)?.name ?? '未知船舶';
  }

  function formerNames(vesselId: string): string[] {
    return formerNamesOf(versions.value, vesselId);
  }

  function resetQuery(): void {
    query.value = emptyVesselQuery();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [v, vv] = await Promise.all([db.vessels.toArray(), db.vesselVersions.toArray()]);
      vessels.value = v;
      versions.value = vv;
    } finally {
      loading.value = false;
    }
  }

  /** 只刷新档案版本（变更 / 流水导致版本状态变化后调用） */
  async function reloadVersions(): Promise<void> {
    versions.value = await db.vesselVersions.toArray();
    vessels.value = await db.vessels.toArray();
  }

  async function createVessel(input: VesselInput): Promise<FishingVessel> {
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
      rev: 1,
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.vessels.put(toPlain(vessel));
    const baseline = await addBaselineVersion(vessel);
    vessels.value = [...vessels.value, vessel];
    versions.value = [...versions.value, baseline];
    return vessel;
  }

  /**
   * 办理渔船档案变更（过户 / 更名 / 变更船籍港、船主）。
   * 并发冲突由 db 层 ArchiveConflictError 抛出，页面捕获后提示重载。
   */
  async function submitChange(
    vesselId: string,
    input: VesselChangeInput,
    expectedRev: number,
  ): Promise<VesselChangeResult> {
    const result = await submitVesselChange({ vesselId, input, expectedRev });
    await reloadVersions();
    // 通知本页其它视图与其它标签页：档案已变（其它标签页据此重载，未重载就提交会收到冲突提示）
    markLocalEcho('vessel-mutated');
    emitDataEvent('vessel-mutated', true);
    return result;
  }

  // 其它标签页登记流水（可能触发挂起档案生效）或办理变更后，本页静默刷新；
  // 本页自己提交的那次回声通过 consumeLocalEcho 跳过，避免与上面的显式刷新重复。
  subscribeDataChange((event) => {
    if (event === 'vessel-mutated' && consumeLocalEcho('vessel-mutated')) return;
    void reloadVersions();
  });

  return {
    vessels,
    versions,
    loading,
    query,
    results,
    homePorts,
    vesselById,
    vesselByName,
    versionsOfVessel,
    currentVersion,
    outstandingVersion,
    versionOfVesselAt,
    nameAtTime,
    formerNames,
    resetQuery,
    loadAll,
    reloadVersions,
    createVessel,
    submitChange,
  };
});
