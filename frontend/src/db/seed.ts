import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { VesselVersion } from '../types/vesselVersion';
import { toPlain } from '../utils/format';
import { db } from './index';
import { buildBerthRecords } from './berth';
import { addBaselineVersion } from './vesselArchive';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** 初始渔港 */
export const SEED_PORTS: FishingPort[] = [
  {
    id: 'p-1001',
    name: '石浦中心渔港',
    level: '中心渔港',
    longitude: 121.9437,
    latitude: 29.2119,
    berthCount: 6,
    berthDepth: 5.5,
    wharfLength: 420,
    shelterLevel: 12,
    supply: { fuel: true, ice: true, water: true },
    manager: '象山县渔港管理站',
    createdAt: daysAgo(420),
  },
  {
    id: 'p-1002',
    name: '沈家门中心渔港',
    level: '中心渔港',
    longitude: 122.2979,
    latitude: 29.9447,
    berthCount: 8,
    berthDepth: 6.2,
    wharfLength: 680,
    shelterLevel: 11,
    supply: { fuel: true, ice: true, water: false },
    manager: '普陀区渔港服务中心',
    createdAt: daysAgo(365),
  },
  {
    id: 'p-1003',
    name: '岱山高亭渔港',
    level: '一级渔港',
    longitude: 122.2031,
    latitude: 30.2567,
    berthCount: 5,
    berthDepth: 4.8,
    wharfLength: 300,
    shelterLevel: 10,
    supply: { fuel: false, ice: true, water: true },
    manager: '岱山县渔业合作社',
    createdAt: daysAgo(280),
  },
  {
    id: 'p-1004',
    name: '温岭石塘渔港',
    level: '二级渔港',
    longitude: 121.6612,
    latitude: 28.3407,
    berthCount: 4,
    berthDepth: 3.9,
    wharfLength: 210,
    shelterLevel: 9,
    supply: { fuel: false, ice: false, water: true },
    manager: '温岭市石塘镇渔业服务站',
    createdAt: daysAgo(150),
  },
];

/** 初始渔船档案 */
export const SEED_VESSELS: FishingVessel[] = [
  {
    id: 'v-2001',
    name: '浙象渔05123',
    vesselNo: 'ZXY05123',
    homePort: '石浦',
    length: 32.5,
    beam: 6.4,
    grossTonnage: 168,
    enginePower: 268,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '林海平',
    certificateExpiry: '2027-06-30',
    rev: 1,
    createdAt: daysAgo(300),
  },
  {
    id: 'v-2002',
    name: '浙普渔13208',
    vesselNo: 'ZPY13208',
    homePort: '沈家门',
    length: 28.6,
    beam: 5.8,
    grossTonnage: 120,
    enginePower: 202,
    operationType: '围网',
    hullMaterial: '钢质',
    owner: '王阿明',
    certificateExpiry: '2026-11-15',
    rev: 1,
    createdAt: daysAgo(260),
  },
  {
    id: 'v-2003',
    name: '浙岱渔07156',
    vesselNo: 'ZDY07156',
    homePort: '高亭',
    length: 24.2,
    beam: 5.1,
    grossTonnage: 88,
    enginePower: 158,
    operationType: '刺网',
    hullMaterial: '木质',
    owner: '郑友良',
    certificateExpiry: '2026-02-28',
    rev: 1,
    createdAt: daysAgo(210),
  },
  {
    id: 'v-2004',
    name: '浙岭渔09342',
    vesselNo: 'ZLY09342',
    homePort: '石塘',
    length: 19.8,
    beam: 4.6,
    grossTonnage: 56,
    enginePower: 96,
    operationType: '钓具',
    hullMaterial: '玻璃钢',
    owner: '陈小军',
    certificateExpiry: '2027-03-20',
    rev: 1,
    createdAt: daysAgo(180),
  },
  {
    id: 'v-2005',
    name: '浙象渔05288',
    vesselNo: 'ZXY05288',
    homePort: '石浦',
    length: 35.0,
    beam: 6.8,
    grossTonnage: 196,
    enginePower: 330,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '张卫国',
    certificateExpiry: '2028-01-10',
    rev: 1,
    createdAt: daysAgo(120),
  },
  {
    id: 'v-2006',
    name: '浙普渔13599',
    vesselNo: 'ZPY13566',
    homePort: '沈家门',
    length: 21.5,
    beam: 4.9,
    grossTonnage: 72,
    enginePower: 132,
    operationType: '围网',
    hullMaterial: '铝合金',
    owner: '周永福',
    certificateExpiry: '2026-08-05',
    rev: 2,
    createdAt: daysAgo(90),
  },
];

/** 初始进出港流水 */
export const SEED_CALLS: PortCall[] = [
  {
    id: 'c-3001',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '进港',
    time: hoursAgo(5),
    berthNo: 'B01',
    iceKg: 1200,
    fuelL: 800,
    unloadKg: 8600,
    visaStatus: '已签证',
    createdAt: hoursAgo(5),
  },
  {
    id: 'c-3002',
    vesselId: 'v-2005',
    vesselName: '浙象渔05288',
    type: '进港',
    time: hoursAgo(3),
    berthNo: 'B02',
    iceKg: 900,
    fuelL: 1200,
    unloadKg: 12400,
    visaStatus: '已签证',
    createdAt: hoursAgo(3),
  },
  {
    id: 'c-3003',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '进港',
    time: hoursAgo(2),
    berthNo: 'B01',
    iceKg: 600,
    fuelL: 0,
    unloadKg: 5200,
    visaStatus: '待签证',
    createdAt: hoursAgo(2),
  },
  {
    id: 'c-3004',
    vesselId: 'v-2003',
    vesselName: '浙岱渔07156',
    type: '进港',
    time: hoursAgo(1),
    berthNo: 'B01',
    iceKg: 300,
    fuelL: 260,
    unloadKg: 2100,
    visaStatus: '免签',
    createdAt: hoursAgo(1),
  },
  {
    id: 'c-3005',
    vesselId: 'v-2004',
    vesselName: '浙岭渔09342',
    type: '出港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 0,
    fuelL: 420,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    id: 'c-3006',
    vesselId: 'v-2006',
    vesselName: '浙普渔13599',
    type: '进港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 480,
    fuelL: 300,
    unloadKg: 3600,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    // 更名前的历史流水，船名是当时快照，永久保留旧名
    id: 'c-3009',
    vesselId: 'v-2006',
    vesselName: '浙普渔13566',
    type: '进港',
    time: daysAgo(40),
    berthNo: 'B04',
    iceKg: 420,
    fuelL: 280,
    unloadKg: 3100,
    visaStatus: '已签证',
    createdAt: daysAgo(40),
  },
  {
    id: 'c-3010',
    vesselId: 'v-2006',
    vesselName: '浙普渔13566',
    type: '出港',
    time: daysAgo(38),
    berthNo: 'B04',
    iceKg: 0,
    fuelL: 360,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(38),
  },
  {
    id: 'c-3007',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '出港',
    time: daysAgo(2),
    berthNo: 'B01',
    iceKg: 0,
    fuelL: 950,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(2),
  },
  {
    id: 'c-3008',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '出港',
    time: daysAgo(4),
    berthNo: 'B03',
    iceKg: 200,
    fuelL: 540,
    unloadKg: 0,
    visaStatus: '待签证',
    createdAt: daysAgo(4),
  },
];

/**
 * 演示用档案版本：v-2006 在 30 天前过户更名（旧名 浙普渔13566 / 刘建军 → 新名 浙普渔13599 / 周永福）。
 * 历史流水 c-3009 / c-3010 仍保留旧船名，可按当时船名追溯同一艘船。
 */
export const SEED_VERSION_OVERRIDES: Record<string, VesselVersion[]> = {
  'v-2006': [
    {
      id: 'vv-2006-1',
      vesselId: 'v-2006',
      versionNo: 1,
      status: 'superseded',
      name: '浙普渔13566',
      homePort: '沈家门',
      owner: '刘建军',
      reason: '初始档案',
      requestedAt: daysAgo(90),
      effectiveAt: daysAgo(90),
      appliedAt: daysAgo(90),
      endedAt: daysAgo(30),
      awaitingVoyage: false,
    },
    {
      id: 'vv-2006-2',
      vesselId: 'v-2006',
      versionNo: 2,
      status: 'current',
      name: '浙普渔13599',
      homePort: '沈家门',
      owner: '周永福',
      reason: '船舶过户更名',
      requestedAt: daysAgo(30),
      effectiveAt: daysAgo(30),
      appliedAt: daysAgo(30),
      endedAt: null,
      awaitingVoyage: false,
    },
  ],
};

/**
 * 首次进入时写入演示数据，并为缺少泊位记录的渔港补齐泊位。
 * 写库前统一 toPlain 脱代理，避免 DataCloneError。
 */
export async function ensureSeedData(): Promise<void> {
  const portCount = await db.ports.count();
  if (portCount === 0) {
    await db.ports.bulkPut(toPlain(SEED_PORTS));
    await db.vessels.bulkPut(toPlain(SEED_VESSELS));
    await db.calls.bulkPut(toPlain(SEED_CALLS));
    // 与渔船档案一起写入档案版本（SCD2 起点）；有预置版本链的用预置版本
    for (const vessel of SEED_VESSELS) {
      const override = SEED_VERSION_OVERRIDES[vessel.id];
      if (override) {
        await db.vesselVersions.bulkPut(toPlain(override));
      } else {
        await addBaselineVersion(vessel);
      }
    }
  }
  const ports = await db.ports.toArray();
  for (const port of ports) {
    const existing = await db.berths.where('portId').equals(port.id).count();
    if (existing === 0) {
      await db.berths.bulkPut(toPlain(buildBerthRecords(port)));
    }
  }
}
