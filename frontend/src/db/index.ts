import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { VesselVersion } from '../types/vesselVersion';
import { buildBerthRecords } from './berth';
import { ensureVesselBaselines } from './vesselArchive';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 新增 vesselVersions 档案版本表，vessels 增加 rev 修订号（乐观锁），并为旧数据回填基线档案版本。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  vesselVersions!: Table<VesselVersion, string>;

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
        // rev 为新增的非索引字段，索引清单与 v3 保持一致即可
        vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
        vesselVersions: 'id, vesselId, status, effectiveAt',
      })
      .upgrade(async (tx) => {
        // v4 迁移：旧渔船档案没有修订号，先补 rev=1，再回填一条 current 基线档案版本
        await tx
          .table<FishingVessel, string>('vessels')
          .toCollection()
          .modify((vessel) => {
            if (typeof vessel.rev !== 'number') vessel.rev = 1;
          });
        await ensureVesselBaselines({
          vessels: tx.table<FishingVessel, string>('vessels'),
          vesselVersions: tx.table<VesselVersion, string>('vesselVersions'),
        });
      });

    // 新装库（或旧数据跳过迁移钩子的兜底场景）：打开后补齐缺失的基线版本与修订号
    this.on('ready', () => ensureVesselBaselines(this));
  }
}

export const db = new FishPortDatabase();
