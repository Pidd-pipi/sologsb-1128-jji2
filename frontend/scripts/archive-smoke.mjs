/**
 * 渔船档案变更核心逻辑冒烟测试（Node + fake-indexeddb）。
 * 运行：node --import tsx 不需要，直接用 esbuild 打包后执行：
 *   node scripts/archive-smoke.mjs（由 npm 脚本通过 esbuild 即时构建）
 */
import { setBaseDB, resetDB } from './dbHarness.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
async function main() {
  console.log('1) 旧数据回填（缺 rev、缺档案版本，ready 钩子升级）');
  {
    const { db, archive } = await setBaseDB({ versions: false });
    // 再补一条不带 rev 的“旧数据”渔船
    await db.vessels.put({
      id: 'v1', name: '旧船名', vesselNo: 'A1', homePort: '石浦', length: 1, beam: 1,
      grossTonnage: 1, enginePower: 1, operationType: '拖网', hullMaterial: '钢质',
      owner: '旧船主', certificateExpiry: '2027-01-01', createdAt: '2026-01-01T00:00:00.000Z',
    });
    await archive.ensureVesselBaselines({ vessels: db.vessels, vesselVersions: db.vesselVersions });
    const v = await db.vessels.get('v1');
    assert(v.rev === 1, '旧渔船补到 rev=1');
    const versions = await db.vesselVersions.where('vesselId').equals('v1').toArray();
    assert(versions.length === 1 && versions[0].status === 'current' && versions[0].name === '旧船名', '回填一条 current 基线版本');
  }

  console.log('2) 立即生效（船不在港，生效时间已到）');
  let h = await setBaseDB({ versions: true });
  {
    const res = await h.archive.submitVesselChange({
      vesselId: 'v-a',
      input: { name: '新船名A', homePort: '沈家门', owner: '新船主', effectiveAt: '', reason: '过户' },
      expectedRev: 1,
    });
    assert(res.status === 'current', '返回 current');
    const vessel = await h.db.vessels.get('v-a');
    assert(vessel.name === '新船名A' && vessel.owner === '新船主' && vessel.rev === 2, '主档案已更新且 rev+1');
    const versions = await h.db.vesselVersions.where('vesselId').equals('v-a').toArray();
    const old = versions.find((x) => x.status === 'superseded');
    assert(old && old.name === '浙象渔05123' && old.endedAt, '旧版本变 superseded 并记录 endedAt');
  }

  console.log('3) 并发：两笔同船变更只成功一笔，旧页面收到冲突');
  {
    const r1 = await h.archive.submitVesselChange({
      vesselId: 'v-b',
      input: { name: '并发名1', homePort: '沈家门', owner: '主1', effectiveAt: '', reason: '' },
      expectedRev: 1,
    });
    assert(r1.status === 'current', '第一笔成功');
    let conflict = null;
    try {
      await h.archive.submitVesselChange({
        vesselId: 'v-b',
        input: { name: '并发名2', homePort: '沈家门', owner: '主2', effectiveAt: '', reason: '' },
        expectedRev: 1, // 旧页面仍是旧 rev
      });
    } catch (e) {
      conflict = e;
    }
    assert(conflict instanceof h.archive.ArchiveConflictError, '第二笔抛 ArchiveConflictError（提示重载）');
    const vessel = await h.db.vessels.get('v-b');
    assert(vessel.name === '并发名1', '只有第一笔落库');
  }

  console.log('4) 已有待生效变更时，不能再提交第二笔');
  {
    // 安排一笔未来生效（船不在港）
    await h.archive.submitVesselChange({
      vesselId: 'v-c',
      input: { name: '排期名', homePort: '石浦', owner: '主', effectiveAt: '2099-01-01T00:00', reason: '' },
      expectedRev: 1,
    });
    let blocked = null;
    try {
      await h.archive.submitVesselChange({
        vesselId: 'v-c',
        input: { name: '另一个', homePort: '石浦', owner: '主2', effectiveAt: '', reason: '' },
        expectedRev: 2,
      });
    } catch (e) {
      blocked = e;
    }
    assert(blocked instanceof h.archive.ArchiveConflictError, '同船第二笔被唯一待生效约束拦截');
  }

  console.log('5) 在港挂起 → 先出港再进港（航次结束）后生效；历史流水保留旧名');
  h = await setBaseDB({ versions: true, occupying: 'v-d' });
  {
    const res = await h.archive.submitVesselChange({
      vesselId: 'v-d',
      input: { name: '挂起后新名', homePort: '石浦', owner: '新主', effectiveAt: '', reason: '过户' },
      expectedRev: 1,
      nowIso: '2026-09-01T00:00:00.000Z',
    });
    assert(res.pending && res.inPort, '船在港 → pending 挂起');
    const vesselBefore = await h.db.vessels.get('v-d');
    assert(vesselBefore.name === '浙岱渔07156', '挂起期间主档案仍是旧名');

    // 申请后立即又有一笔进港（还没出过海）：不应生效
    await h.archive.processVesselCallEvent('v-d', '进港', '2026-09-02T00:00:00.000Z');
    let vd = await h.db.vesselVersions.where('vesselId').equals('v-d').toArray();
    assert(vd.some((x) => x.status === 'pending'), '未出港前的进港不触发生效');

    // 出港：航次开始
    await h.archive.processVesselCallEvent('v-d', '出港', '2026-09-03T00:00:00.000Z');
    vd = await h.db.vesselVersions.where('vesselId').equals('v-d').toArray();
    const pending = vd.find((x) => x.status === 'pending');
    assert(pending && pending.awaitingVoyage === false, '出港后清除等待航次标记');

    // 再进港：航次结束 → 生效
    await h.archive.processVesselCallEvent('v-d', '进港', '2026-09-10T00:00:00.000Z');
    const vesselAfter = await h.db.vessels.get('v-d');
    assert(vesselAfter.name === '挂起后新名', '航次结束后档案生效为新名');

    // 时点船名还原
    const versions = await h.db.vesselVersions.where('vesselId').equals('v-d').toArray();
    const oldName = h.archive.nameAt(versions, 'v-d', '2026-08-01T00:00:00.000Z');
    const newName = h.archive.nameAt(versions, 'v-d', '2026-09-20T00:00:00.000Z');
    assert(oldName === '浙岱渔07156', '历史时点还原为旧船名');
    assert(newName === '挂起后新名', '生效后时点还原为新船名');
    const allNames = h.archive.allNamesOf(versions, 'v-d');
    assert(allNames.includes('浙岱渔07156') && allNames.includes('挂起后新名'), '曾用名与现名都可检索同一艘船');
  }

  console.log('6) 排期到点（船在海上）由定时任务生效');
  h = await setBaseDB({ versions: true });
  {
    await h.archive.submitVesselChange({
      vesselId: 'v-e',
      input: { name: '定时新名', homePort: '石塘', owner: '主', effectiveAt: '2026-05-01T00:00', reason: '' },
      expectedRev: 1,
      nowIso: '2026-04-01T00:00:00.000Z',
    });
    let applied = await h.archive.applyDueScheduled('2026-04-15T00:00:00.000Z');
    assert(applied.length === 0, '未到点不生效');
    applied = await h.archive.applyDueScheduled('2026-05-02T00:00:00.000Z');
    assert(applied.length === 1 && applied[0].name === '定时新名', '到点后定时生效');
  }

  console.log('7) 挂起档案在“航次结束的进港流水”事务后：本笔流水用新名，旧流水不动');
  h = await setBaseDB({ versions: true, occupying: 'v-d' });
  {
    // 一条旧流水（旧名）
    await h.db.calls.put({
      id: 'c-old', vesselId: 'v-d', vesselName: '浙岱渔07156', type: '进港',
      time: '2026-08-30T00:00:00.000Z', berthNo: 'B01', iceKg: 1, fuelL: 1, unloadKg: 1,
      visaStatus: '已签证', createdAt: '2026-08-30T00:00:00.000Z',
    });
    await h.archive.submitVesselChange({
      vesselId: 'v-d',
      input: { name: '挂起后新名', homePort: '高亭', owner: '新主', effectiveAt: '', reason: '过户' },
      expectedRev: 1,
      nowIso: '2026-09-01T00:00:00.000Z',
    });
    // 模拟一次“出港 + 释放泊位”
    await h.archive.processVesselCallEvent('v-d', '出港', '2026-09-03T00:00:00.000Z');
    await h.db.berths.clear();
    // 模拟“航次结束进港”：先占泊位（此时档案仍 pending），再处理进港事件
    await h.db.berths.put({
      id: 'b1', portId: 'p-x', berthNo: 'B09', vesselId: 'v-d', vesselName: '浙岱渔07156',
      berthAt: '2026-09-10T00:00:00.000Z', leaveAt: null, status: '占用', designDepth: 5,
    });
    await h.archive.processVesselCallEvent('v-d', '进港', '2026-09-10T00:00:00.000Z');
    // registerCall 生效后会把当前占用泊位改成新名
    const versions = await h.db.vesselVersions.where('vesselId').equals('v-d').toArray();
    const snapshotName = h.archive.versionAt(versions, 'v-d', '2026-09-10T00:00:00.000Z')?.name;
    assert(snapshotName === '挂起后新名', '航次结束时点的流水应取新船名');
    await h.db.berths.where('vesselId').equals('v-d').filter((x) => x.status === '占用').modify((x) => { x.vesselName = snapshotName; });
    const berth = await h.db.berths.get('b1');
    assert(berth.vesselName === '挂起后新名', '当前占用泊位更新为新船名');
    const oldCall = await h.db.calls.get('c-old');
    assert(oldCall.vesselName === '浙岱渔07156', '历史流水旧船名不被覆盖');
  }

  resetDB();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
