import type { Transaction } from 'dexie';
import type { Berth } from '../types/berth';
import type { PortCall } from '../types/call';
import type { FishingVessel, VesselChange } from '../types/vessel';
import { uid } from '../utils/format';
import { db } from './index';

/**
 * 判断渔船当前是否在港：存在「占用」状态的泊位即视为在港。
 * 在港期间提交的变更先挂起，等最后一条航次结束（出港释放泊位）后才生效。
 */
export async function isVesselInPort(vesselId: string): Promise<boolean> {
  const count = await db.berths
    .filter((b) => b.vesselId === vesselId && b.status === '占用')
    .count();
  return count > 0;
}

/** 应用一条已到期的变更：把变更快照（船名 / 船籍港 / 船主）写回渔船档案。 */
export async function applyChangeRecord(change: VesselChange): Promise<void> {
  await db.transaction('rw', db.vessels, db.vesselChanges, async () => {
    const vessel = await db.vessels.get(change.vesselId);
    if (!vessel) return;
    await db.vessels.update(vessel.id, {
      name: change.name,
      homePort: change.homePort,
      owner: change.owner,
    });
    await db.vesselChanges.update(change.id, {
      status: 'effective',
      appliedAt: new Date().toISOString(),
    });
  });
}

/**
 * 处理已到期且不在港的待生效变更（按生效时间先后应用）。
 * 船还在港时跳过，等最后一条航次结束后再由登记流程触发。
 * @returns 本次实际应用的变更条数
 */
export async function processDueChanges(vesselId?: string): Promise<number> {
  const now = Date.now();
  const all = await db.vesselChanges.where('status').equals('pending').toArray();
  const due = all
    .filter((c) => (vesselId ? c.vesselId === vesselId : true))
    .filter((c) => new Date(c.effectiveAt).getTime() <= now)
    .sort((a, b) => new Date(a.effectiveAt).getTime() - new Date(b.effectiveAt).getTime());

  let applied = 0;
  for (const change of due) {
    if (await isVesselInPort(change.vesselId)) continue;
    await applyChangeRecord(change);
    applied += 1;
  }
  return applied;
}

/**
 * 旧数据升级回填（Dexie v4 迁移与首次播种兜底共用）：
 * - 缺少 version 的渔船档案补版本号 1；
 * - 没有任何变更记录的渔船，补一条「初始建档」变更（版本 1，已生效）；
 * - 流水 / 泊位上缺失的船名快照按当前档案补齐，保证历史单据仍按当时船名展示。
 */
export async function backfillVesselChanges(tx: Transaction): Promise<void> {
  const vesselTable = tx.table<FishingVessel, string>('vessels');
  const changeTable = tx.table<VesselChange, string>('vesselChanges');
  const vessels = await vesselTable.toArray();

  for (const vessel of vessels) {
    if (vessel.version == null) {
      await vesselTable.update(vessel.id, { version: 1 });
      vessel.version = 1;
    }
    const count = await changeTable.where('vesselId').equals(vessel.id).count();
    if (count === 0) {
      await changeTable.put({
        id: uid('vc'),
        vesselId: vessel.id,
        version: 1,
        name: vessel.name,
        homePort: vessel.homePort,
        owner: vessel.owner,
        effectiveAt: vessel.createdAt,
        status: 'effective',
        baseVersion: 0,
        reason: '初始建档（旧数据回填）',
        createdAt: vessel.createdAt,
      });
    }
  }

  const nameOf = (id: string): string => vessels.find((v) => v.id === id)?.name ?? '';
  await tx
    .table<PortCall, string>('calls')
    .toCollection()
    .modify((call) => {
      if (!call.vesselName) call.vesselName = nameOf(call.vesselId);
    });
  await tx
    .table<Berth, string>('berths')
    .toCollection()
    .modify((berth) => {
      if (berth.status === '占用' && !berth.vesselName) berth.vesselName = nameOf(berth.vesselId ?? '');
    });
}
