/**
 * 冒烟测试夹具：用 fake-indexeddb 提供内存 IndexedDB，载入真实的 db 层逻辑。
 * 每个场景用同一 Dexie 实例、清空全部表来隔离。
 */
import 'fake-indexeddb/auto';
import * as dbMod from '../src/db/index.ts';
import * as archive from '../src/db/vesselArchive.ts';

const db = dbMod.db;

async function wipe() {
  await Promise.all([
    db.ports.clear(),
    db.vessels.clear(),
    db.calls.clear(),
    db.berths.clear(),
    db.vesselVersions.clear(),
  ]);
}

function vessel(id, name, owner = '船主', homePort = '石浦') {
  return {
    id,
    name,
    vesselNo: id.toUpperCase(),
    homePort,
    length: 20,
    beam: 5,
    grossTonnage: 80,
    enginePower: 150,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner,
    certificateExpiry: '2027-12-31',
    rev: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function setBaseDB({ versions = true, occupying = '' } = {}) {
  await wipe();
  await db.vessels.bulkPut([
    vessel('v-a', '浙象渔05123', '林海平'),
    vessel('v-b', '浙象渔05288', '张卫国'),
    vessel('v-c', '浙普渔13208', '王阿明', '沈家门'),
    vessel('v-d', '浙岱渔07156', '郑友良', '高亭'),
    vessel('v-e', '浙岭渔09342', '陈小军', '石塘'),
  ]);
  if (versions) {
    for (const v of await db.vessels.toArray()) {
      await archive.addBaselineVersion(v);
    }
  }
  if (occupying) {
    await db.berths.put({
      id: 'berth-occ',
      portId: 'p-x',
      berthNo: 'B01',
      vesselId: occupying,
      vesselName: (await db.vessels.get(occupying)).name,
      berthAt: '2026-08-30T00:00:00.000Z',
      leaveAt: null,
      status: '占用',
      designDepth: 5,
    });
  }
  return { db, archive };
}

async function resetDB() {
  await wipe();
}

export { setBaseDB, resetDB };
