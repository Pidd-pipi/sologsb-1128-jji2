import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import type { VesselVersion } from '../types/vesselVersion';
import { buildBerthRecords } from '../db/berth';
import { consumeLocalEcho, emitDataEvent, markLocalEcho, subscribeDataChange } from '../db/events';
import { versionAt } from '../db/vesselArchive';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  manager: string;
}

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c] = await Promise.all([db.ports.toArray(), db.berths.toArray(), db.calls.toArray()]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
    } finally {
      loading.value = false;
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (berthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    const hit = berths.value.find((b) => b.id === berthId);
    if (!hit) return;
    const next: Berth = {
      ...hit,
      status,
      vesselId: status === '占用' ? hit.vesselId : null,
      vesselName: status === '占用' ? hit.vesselName : null,
      berthAt: status === '占用' ? hit.berthAt ?? new Date().toISOString() : hit.berthAt,
      leaveAt: status === '空闲' ? new Date().toISOString() : null,
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 登记一条进出港记录，并同步泊位占用状态（进港 → 占用，出港 → 释放）。
   *
   * 关键顺序（与渔船档案变更配合，全部在一个事务里）：
   * 1. 先处理这笔流水可能触发的档案生效（在港挂起 → 航次结束 / 排期到点）；
   * 2. 再按“当时生效的档案版本”解析船名快照写入流水——新档案生效后的第一笔流水就是新船名；
   * 3. 历史流水的 vesselName 永不回写，历史记录按当时船名可追溯同一艘船。
   */
  async function registerCall(draft: CallDraft, portId: string): Promise<{ call: PortCall; appliedVersion: VesselVersion | null }> {
    const timeIso = draft.time ? new Date(draft.time).toISOString() : new Date().toISOString();
    const result = await db.transaction(
      'rw',
      [db.calls, db.berths, db.vessels, db.vesselVersions],
      async () => {
        const vessel = await db.vessels.get(draft.vesselId);
        if (!vessel) throw new Error('渔船档案不存在，请重载页面后重试');

        const call: PortCall = {
          id: uid('c'),
          vesselId: draft.vesselId,
          vesselName: vessel.name, // 先占位，下面按时点档案覆盖
          type: draft.type,
          time: timeIso,
          berthNo: draft.berthNo,
          iceKg: Number(draft.iceKg) || 0,
          fuelL: Number(draft.fuelL) || 0,
          unloadKg: Number(draft.unloadKg) || 0,
          visaStatus: draft.visaStatus,
          createdAt: new Date().toISOString(),
        };

        // 出港流水：船离港，可能直接让到点排期的档案生效
        if (draft.type === '出港') {
          await applyCallArchiveEvent(draft.vesselId, '出港', timeIso);
        }

        // 进港流水：先记进港（占用泊位），再判断在港挂起档案是否在本次航次结束后生效
        await persistCallAndBerth(call, portId);
        if (draft.type === '进港') {
          await applyCallArchiveEvent(draft.vesselId, '进港', timeIso);
        }

        // 重新读取生效后的版本，按“当时船名”回填这笔流水与占用泊位
        const versions = await db.vesselVersions.where('vesselId').equals(draft.vesselId).toArray();
        const atVersion: VesselVersion | undefined = versionAt(versions, draft.vesselId, timeIso);
        const snapshotName = atVersion?.name ?? vessel.name;
        call.vesselName = snapshotName;
        await db.calls.put(toPlain(call));

        // 档案恰在本笔流水生效：占用泊位同步为新船名（仅当前占用，历史不动）
        if (snapshotName !== vessel.name) {
          await db.berths
            .where('vesselId')
            .equals(draft.vesselId)
            .filter((b) => b.status === '占用')
            .modify((b) => {
              b.vesselName = snapshotName;
            });
        }
        return { call, appliedVersion: snapshotName !== vessel.name ? atVersion ?? null : null };
      },
    );

    // 事务提交后再同步内存，避免读到中间态；广播给本页其它 store 与其它标签页
    await reloadAfterMutation();
    markLocalEcho('call-registered');
    emitDataEvent('call-registered', true);
    return result;
  }

  /** 写一条流水并更新对应泊位占用（事务内调用） */
  async function persistCallAndBerth(call: PortCall, portId: string): Promise<void> {
    await db.calls.put(toPlain(call));
    const berth = await db.berths
      .where('portId')
      .equals(portId)
      .filter((b) => b.berthNo === call.berthNo)
      .first();
    if (!berth) return;
    const next: Berth =
      call.type === '进港'
        ? { ...berth, status: '占用', vesselId: call.vesselId, vesselName: call.vesselName, berthAt: call.time, leaveAt: null }
        : { ...berth, status: '空闲', vesselId: null, vesselName: null, berthAt: null, leaveAt: call.time };
    await db.berths.put(toPlain(next));
  }

  /** 事务内驱动档案挂起 / 排期生效（逻辑在 vesselArchive 中） */
  async function applyCallArchiveEvent(
    vesselId: string,
    type: '进港' | '出港',
    timeIso: string,
  ): Promise<void> {
    // 动态引入避免 store 与 db 层循环依赖
    const { processVesselCallEvent } = await import('../db/vesselArchive');
    await processVesselCallEvent(vesselId, type, timeIso);
  }

  /** 重新拉取本表相关数据（calls / berths） */
  async function reloadAfterMutation(): Promise<void> {
    const [b, c] = await Promise.all([db.berths.toArray(), db.calls.toArray()]);
    berths.value = b;
    calls.value = c;
  }

  // 其它标签页登记流水或办理档案变更（立即生效会改在港泊位船名）后，本页静默刷新。
  // 本页自己登记流水的回声通过 consumeLocalEcho 跳过，避免与显式 reloadAfterMutation 重复。
  subscribeDataChange((event) => {
    if (event === 'call-registered' && consumeLocalEcho('call-registered')) return;
    void reloadAfterMutation();
  });

  return {
    ports,
    berths,
    calls,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    portById,
    berthsOf,
    callsOfVessel,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
  };
});
