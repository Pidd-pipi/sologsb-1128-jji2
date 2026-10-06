import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel, VesselChange } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import { buildBerthRecords } from './berth';
import { backfillVesselChanges } from './vesselChange';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 新增 vesselChanges 表（档案变更与乐观锁版本），并为缺版本的旧数据回填版本号与初始变更记录。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  vesselChanges!: Table<VesselChange, string>;

  constructor() {
    super('gbfishport-db');

    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });

    this.version(2)
      .stores({
        calls: 'id, vesselId, type, time',
      })
      .upgrade(async (tx) => {
        // v2 迁移：新增 calls 表与 vesselId 索引，回填历史记录的冗余字段
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.vesselName) call.vesselName = '';
            if (!call.visaStatus) call.visaStatus = '待签证';
          });
      });

    this.version(3)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // v3 迁移：新增 berths 表，并按每个渔港登记的泊位数生成初始泊位记录
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const berthTable = tx.table<Berth, string>('berths');
        for (const port of ports) {
          const existing = await berthTable.where('portId').equals(port.id).count();
          if (existing === 0) {
            await berthTable.bulkPut(buildBerthRecords(port));
          }
        }
      });

    this.version(4)
      .stores({
        // 档案变更按渔船 + 版本检索；vessels 增加 version 索引列用于乐观锁
        vesselChanges: 'id, vesselId, version, status, effectiveAt',
        vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage, version',
      })
      .upgrade(async (tx) => {
        // v4 迁移：缺版本的旧渔船档案回填版本号 1，补一条「初始建档」变更记录，
        // 并补齐流水 / 泊位上缺失的船名快照（旧数据升级回填）。
        await backfillVesselChanges(tx);
      });
  }
}

export const db = new FishPortDatabase();
