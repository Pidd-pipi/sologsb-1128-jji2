import { db } from './index';
import type { Table } from 'dexie';
import type { FishingVessel } from '../types/vessel';
import type { Berth } from '../types/berth';
import type {
  VesselChangeInput,
  VesselChangeResult,
  VesselVersion,
} from '../types/vesselVersion';
import { uid } from '../utils/format';

/** 档案变更并发冲突 / 校验失败：调用方据此提示重载页面 */
export class ArchiveConflictError extends Error {}
export class ArchiveValidationError extends Error {}

interface ArchiveTables {
  vessels: Table<FishingVessel, string>;
  vesselVersions: Table<VesselVersion, string>;
}

/** 一条船的档案版本按版本号排序 */
export function versionsOf(versions: VesselVersion[], vesselId: string): VesselVersion[] {
  return versions
    .filter((v) => v.vesselId === vesselId)
    .sort((a, b) => a.versionNo - b.versionNo);
}

export function currentVersionOf(versions: VesselVersion[], vesselId: string): VesselVersion | undefined {
  return versions.find((v) => v.vesselId === vesselId && v.status === 'current');
}

/** 待生效版本（已排期 / 在港挂起），同一艘船至多一条 */
export function outstandingVersionOf(
  versions: VesselVersion[],
  vesselId: string,
): VesselVersion | undefined {
  return versions.find(
    (v) => v.vesselId === vesselId && (v.status === 'scheduled' || v.status === 'pending'),
  );
}

/**
 * 时点档案还原：返回某一时刻生效的版本（历史流水 / 泊位 / 时间线据此显示当时船名）。
 * current 与 superseded 版本用 [appliedAt, endedAt) 生命周期覆盖时间轴。
 */
export function versionAt(
  versions: VesselVersion[],
  vesselId: string,
  atIso: string,
): VesselVersion | undefined {
  const t = new Date(atIso).getTime();
  if (Number.isNaN(t)) return currentVersionOf(versions, vesselId);
  const list = versionsOf(versions, vesselId).filter(
    (v) => v.status === 'current' || v.status === 'superseded',
  );
  const hit = list.find((v) => {
    const start = v.appliedAt ? new Date(v.appliedAt).getTime() : Number.NEGATIVE_INFINITY;
    const end = v.endedAt ? new Date(v.endedAt).getTime() : Number.POSITIVE_INFINITY;
    return t >= start && t < end;
  });
  if (hit) return hit;
  // 时间早于首版生效等回填场景：退回到最早一条档案，保证同一艘船仍可识别
  return list
    .filter((v) => v.appliedAt)
    .sort((a, b) => new Date(a.appliedAt as string).getTime() - new Date(b.appliedAt as string).getTime())[0];
}

/** 某时刻的船名（找不到时由调用方回退当前档案） */
export function nameAt(versions: VesselVersion[], vesselId: string, atIso: string): string | undefined {
  return versionAt(versions, vesselId, atIso)?.name;
}

/** 该船历史上用过的全部船名（含当前），按版本顺序去重，用于按旧船名检索同一艘船 */
export function allNamesOf(versions: VesselVersion[], vesselId: string): string[] {
  const names: string[] = [];
  for (const v of versionsOf(versions, vesselId)) {
    if (v.name && !names.includes(v.name)) names.push(v.name);
  }
  return names;
}

/** 曾用名（不含当前船名） */
export function formerNamesOf(versions: VesselVersion[], vesselId: string): string[] {
  const current = currentVersionOf(versions, vesselId);
  return allNamesOf(versions, vesselId).filter((n) => n !== current?.name);
}

function baselineVersion(vessel: FishingVessel): VesselVersion {
  return {
    id: uid('vv'),
    vesselId: vessel.id,
    versionNo: 1,
    status: 'current',
    name: vessel.name,
    homePort: vessel.homePort,
    owner: vessel.owner,
    reason: '初始档案',
    requestedAt: vessel.createdAt,
    effectiveAt: vessel.createdAt,
    appliedAt: vessel.createdAt,
    endedAt: null,
    awaitingVoyage: false,
  };
}

/** 新建档渔船补一条基线版本 */
export async function addBaselineVersion(vessel: FishingVessel): Promise<VesselVersion> {
  const version = baselineVersion(vessel);
  await db.vesselVersions.put(version);
  return version;
}

/**
 * 旧数据兜底：为缺少档案版本的渔船回填 current 基线版本，并补齐 rev 修订号。
 * v4 迁移钩子与 db ready 钩子都会调用，已回填的不会重复处理。
 */
export async function ensureVesselBaselines(tables: ArchiveTables): Promise<void> {
  const [vessels, versions] = await Promise.all([
    tables.vessels.toArray(),
    tables.vesselVersions.toArray(),
  ]);
  const missing: VesselVersion[] = [];
  for (const vessel of vessels) {
    const owns = versions.filter((x) => x.vesselId === vessel.id);
    if (!owns.some((x) => x.status === 'current' || x.status === 'scheduled' || x.status === 'pending')) {
      const maxNo = owns.reduce((max, x) => Math.max(max, x.versionNo), 0);
      const baseline = baselineVersion(vessel);
      if (maxNo > 0) baseline.versionNo = maxNo + 1;
      missing.push(baseline);
    }
  }
  if (missing.length) await tables.vesselVersions.bulkPut(missing);

  const staleRev = vessels.filter((v) => typeof v.rev !== 'number');
  for (const vessel of staleRev) {
    await tables.vessels.put({ ...vessel, rev: 1 });
  }
}

/** 该船当前是否占用着泊位（在港） */
async function isVesselInPort(vesselId: string): Promise<boolean> {
  const count = await db.berths
    .where('vesselId')
    .equals(vesselId)
    .filter((b: Berth) => b.status === '占用')
    .count();
  return count > 0;
}

/**
 * 生效一条新版本：旧 current → superseded，新版本 → current，
 * 同步主档案船名 / 船籍港 / 船主与修订号，并把在港占用泊位改成新船名。
 * 注意：只改“当前占用”，历史流水里的船名快照一律不动。
 */
async function applyVersion(
  vessel: FishingVessel,
  previous: VesselVersion,
  next: VesselVersion,
  appliedAtIso: string,
): Promise<VesselVersion> {
  const ended: VesselVersion = { ...previous, status: 'superseded', endedAt: appliedAtIso };
  const applied: VesselVersion = {
    ...next,
    status: 'current',
    appliedAt: appliedAtIso,
    endedAt: null,
    awaitingVoyage: false,
  };
  await db.vesselVersions.bulkPut([ended, applied]);
  await db.vessels.put({
    ...vessel,
    name: next.name,
    homePort: next.homePort,
    owner: next.owner,
    rev: (vessel.rev ?? 1) + 1,
  });
  await db.berths
    .where('vesselId')
    .equals(vessel.id)
    .filter((b: Berth) => b.status === '占用')
    .modify((b: Berth) => {
      b.vesselName = next.name;
    });
  return applied;
}

export interface SubmitChangeOptions {
  vesselId: string;
  input: VesselChangeInput;
  /** 页面打开时读到的修订号（乐观锁依据） */
  expectedRev: number;
  nowIso?: string;
}

/**
 * 办理一笔渔船档案变更（同一事务内完成校验 + 落库）。
 * - 船在港：挂起（pending），等下一航次结束（下次进港）再生效；
 * - 不在港且生效时间已到：立即生效；
 * - 不在港且生效时间在未来：排期（scheduled），到点且不在港时生效；
 * - 修订号过期或已存在待生效变更：抛 ArchiveConflictError，前端提示重载。
 */
export async function submitVesselChange(options: SubmitChangeOptions): Promise<VesselChangeResult> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const now = Date.parse(nowIso);
  const name = options.input.name.trim();
  const homePort = options.input.homePort.trim();
  const owner = options.input.owner.trim();
  const reason = options.input.reason.trim();
  const effectiveIso = options.input.effectiveAt
    ? new Date(options.input.effectiveAt).toISOString()
    : nowIso;

  return db.transaction(
    'rw',
    [db.vesselVersions, db.vessels, db.berths],
    async (): Promise<VesselChangeResult> => {
      const vessel = await db.vessels.get(options.vesselId);
      if (!vessel) {
        throw new ArchiveValidationError('渔船档案不存在或已被删除，请重载页面后重试');
      }
      if ((vessel.rev ?? 1) !== options.expectedRev) {
        throw new ArchiveConflictError(
          `该船档案刚被他人变更过（修订号 ${options.expectedRev} → ${vessel.rev ?? 1}），请重载页面获取最新档案后再提交`,
        );
      }
      const all = await db.vesselVersions.where('vesselId').equals(options.vesselId).toArray();
      if (all.some((v) => v.status === 'scheduled' || v.status === 'pending')) {
        throw new ArchiveConflictError('该船已有一笔待生效的档案变更，同一艘船同一时间只能成功一笔，请重载页面查看');
      }
      const current = all.find((v) => v.status === 'current');
      if (!current) {
        throw new ArchiveValidationError('缺少当前档案版本，请先刷新页面完成旧数据升级');
      }
      if (name === current.name && homePort === current.homePort && owner === current.owner) {
        throw new ArchiveValidationError('新船名、船籍港、船主与当前档案完全相同，无需办理变更');
      }

      const nextNo = all.reduce((max, v) => Math.max(max, v.versionNo), 0) + 1;
      const inPort = await isVesselInPort(options.vesselId);
      // 在港一律先挂起（哪怕填了未来生效时间，也不得早于本航次结束）；
      // 不在港：生效时间已到立即生效，否则排期到点生效。
      const immediate = !inPort && Date.parse(effectiveIso) <= now;
      const status: VesselChangeResult['status'] = inPort ? 'pending' : immediate ? 'current' : 'scheduled';

      const draft: VesselVersion = {
        id: uid('vv'),
        vesselId: options.vesselId,
        versionNo: nextNo,
        status,
        name,
        homePort,
        owner,
        reason,
        requestedAt: nowIso,
        effectiveAt: effectiveIso,
        appliedAt: immediate ? nowIso : null,
        endedAt: null,
        // 申请时船正在港：必须先出港再进港（跑完一个航次）后才生效
        awaitingVoyage: status === 'pending',
      };

      // 任何成功提交都推进修订号，让另一个窗口的旧页面在提交时收到冲突、提示重载
      if (immediate) {
        const applied = await applyVersion(vessel, current, draft, nowIso);
        return { version: applied, status: 'current', pending: false, inPort: false, rev: vessel.rev + 1 };
      }
      await db.vessels.put({ ...vessel, rev: (vessel.rev ?? 1) + 1 });
      await db.vesselVersions.put(draft);
      return {
        version: draft,
        status,
        pending: status === 'pending',
        inPort,
        rev: (vessel.rev ?? 1) + 1,
      };
    },
  );
}

/**
 * 进出港事件驱动的挂起 / 排期生效（由 registerCall 在同一事务内调用）：
 * - 出港：在港挂起版本清除“等待航次”标记（本航次已开始）；已排期且到点的，船已离港即生效。
 * - 进港：仅当挂起版本已经出过一次海（!awaitingVoyage）时才算“最后一条航次结束”并生效；
 *   已排期且到点的版本生效。
 * 生效时间点取流水时间，保证这条流水按新档案登记。
 */
export async function processVesselCallEvent(
  vesselId: string,
  type: '进港' | '出港',
  timeIso: string,
): Promise<{ applied: VesselVersion[] }> {
  const applied: VesselVersion[] = [];
  await db.transaction('rw', [db.vesselVersions, db.vessels, db.berths], async () => {
    const vessel = await db.vessels.get(vesselId);
    if (!vessel) return;
    const all = await db.vesselVersions.where('vesselId').equals(vesselId).toArray();
    let current = all.find((v) => v.status === 'current');
    if (!current) return;
    const t = Date.parse(timeIso);
    const arriving = type === '进港';

    if (type === '出港') {
      // 出港 = 本航次开始：挂起版本不再“等待首个航次”，下一次进港即可生效
      for (const v of all.filter((x) => x.status === 'pending' && x.awaitingVoyage)) {
        await db.vesselVersions.put({ ...v, awaitingVoyage: false });
        v.awaitingVoyage = false;
      }
    }

    const candidates = all
      .filter((v) => {
        const due = Date.parse(v.effectiveAt) <= t;
        if (v.status === 'scheduled') return due;
        // 在港挂起：已出过海（本次进港=航次结束）且不早于约定生效时间才生效
        if (v.status === 'pending' && arriving) return !v.awaitingVoyage && due;
        return false;
      })
      .sort((a, b) => a.versionNo - b.versionNo);

    for (const candidate of candidates) {
      const appliedVersion = await applyVersion(vessel, current, candidate, timeIso);
      current = { ...candidate, status: 'current' };
      applied.push(appliedVersion);
    }
  });
  return { applied };
}

/**
 * 定时生效：到点的待生效版本，只要船当前不在港（已离港出海，本航次已结束）就立即生效。
 * - scheduled：到点且不在港即生效；
 * - pending：已出过海（awaitingVoyage=false）、到点且不在港时生效（不强制等下一次进港）；
 * 仍在港的版本跳过，由出港 / 进港流水事件继续驱动。由 store 定时轮询调用。
 */
export async function applyDueScheduled(nowIso = new Date().toISOString()): Promise<VesselVersion[]> {
  const applied: VesselVersion[] = [];
  const nowTs = Date.parse(nowIso);
  const [scheduled, pending] = await Promise.all([
    db.vesselVersions.where('status').equals('scheduled').toArray(),
    db.vesselVersions.where('status').equals('pending').toArray(),
  ]);
  const due = [...scheduled, ...pending]
    .filter(
      (v) =>
        Date.parse(v.effectiveAt) <= nowTs &&
        (v.status === 'scheduled' || !v.awaitingVoyage),
    )
    .sort((a, b) => a.versionNo - b.versionNo);

  const byVessel = new Map<string, VesselVersion[]>();
  for (const v of due) {
    const list = byVessel.get(v.vesselId) ?? [];
    list.push(v);
    byVessel.set(v.vesselId, list);
  }

  for (const [vesselId, list] of byVessel) {
    await db.transaction('rw', [db.vesselVersions, db.vessels, db.berths], async () => {
      if (await isVesselInPort(vesselId)) return; // 在港：等出港事件
      const vessel = await db.vessels.get(vesselId);
      if (!vessel) return;
      let current = (await db.vesselVersions.where('vesselId').equals(vesselId).toArray()).find(
        (v) => v.status === 'current',
      );
      if (!current) return;
      for (const candidate of list) {
        const appliedVersion = await applyVersion(vessel, current, candidate, nowIso);
        current = { ...candidate, status: 'current' };
        applied.push(appliedVersion);
      }
    });
  }
  return applied;
}
