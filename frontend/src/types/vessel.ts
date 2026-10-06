/** 作业类型 */
export type OperationType = '拖网' | '围网' | '刺网' | '钓具';

export const OPERATION_TYPES: OperationType[] = ['拖网', '围网', '刺网', '钓具'];

/** 船体材质 */
export type HullMaterial = '钢质' | '木质' | '玻璃钢' | '铝合金';

export const HULL_MATERIALS: HullMaterial[] = ['钢质', '木质', '玻璃钢', '铝合金'];

/** 渔船技术档案 */
export interface FishingVessel {
  id: string;
  /** 船名 */
  name: string;
  /** 渔船编号 */
  vesselNo: string;
  /** 船籍港 */
  homePort: string;
  /** 船长 m */
  length: number;
  /** 型宽 m */
  beam: number;
  /** 总吨位 */
  grossTonnage: number;
  /** 主机功率 kW */
  enginePower: number;
  /** 作业类型 */
  operationType: OperationType;
  /** 船体材质 */
  hullMaterial: HullMaterial;
  /** 船主 */
  owner: string;
  /** 证书有效期（YYYY-MM-DD） */
  certificateExpiry: string;
  /** 档案版本号（乐观锁：每次变更 +1，旧页面提交时据此提示重载） */
  version: number;
  createdAt: string;
}

/** 档案变更状态：pending 待生效（在港等最后一条航次结束）/ effective 已生效 */
export type VesselChangeStatus = 'pending' | 'effective';

/**
 * 渔船档案变更记录（过户 / 更名 / 转港）。
 * 只记录船名、船籍港、船主三项可变更内容，生效前档案照旧；
 * 历史流水、泊位占用与时间线按「当时船名」留存快照，不随变更被覆盖。
 */
export interface VesselChange {
  id: string;
  /** 所属渔船 id */
  vesselId: string;
  /** 变更后的档案版本号（乐观锁，提交成功即 +1） */
  version: number;
  /** 变更后船名 */
  name: string;
  /** 变更后船籍港 */
  homePort: string;
  /** 变更后船主 */
  owner: string;
  /** 生效时间（ISO 字符串）；生效前照旧 */
  effectiveAt: string;
  /** 状态：pending 待生效 / effective 已生效 */
  status: VesselChangeStatus;
  /** 提交时的基础版本（乐观锁 compare-and-swap） */
  baseVersion: number;
  /** 变更原因 / 备注 */
  reason?: string;
  createdAt: string;
  /** 实际生效时间（ISO 字符串） */
  appliedAt?: string;
}

/** 档案变更表单模型 */
export interface VesselChangeInput {
  name: string;
  homePort: string;
  owner: string;
  /** 生效时间（datetime-local 值 YYYY-MM-DDTHH:mm） */
  effectiveAt: string;
  reason?: string;
}

/** 渔船检索条件（作业类型 + 功率区间 + 吨位 + 船籍港组合查询） */
export interface VesselQuery {
  operationType: OperationType | '';
  powerMin: number | null;
  powerMax: number | null;
  tonnageMin: number | null;
  tonnageMax: number | null;
  homePort: string;
}

export function emptyVesselQuery(): VesselQuery {
  return {
    operationType: '',
    powerMin: null,
    powerMax: null,
    tonnageMin: null,
    tonnageMax: null,
    homePort: '',
  };
}
