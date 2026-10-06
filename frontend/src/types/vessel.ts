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
  /**
   * 档案修订号（乐观锁）：每成功提交一笔档案变更 +1。
   * 两个窗口同时编辑同一条船时，后提交方修订号过期，需重载后再提交。
   * 旧数据没有该字段，v4 迁移与运行时兜底统一回填为 1。
   */
  rev: number;
  createdAt: string;
}

/** 渔船检索条件（船名/曾用名 + 作业类型 + 功率区间 + 吨位 + 船籍港组合查询） */
export interface VesselQuery {
  /** 船名关键字，同时匹配当前船名与历史曾用名，更名后仍可找到同一艘船 */
  name: string;
  operationType: OperationType | '';
  powerMin: number | null;
  powerMax: number | null;
  tonnageMin: number | null;
  tonnageMax: number | null;
  homePort: string;
}

export function emptyVesselQuery(): VesselQuery {
  return {
    name: '',
    operationType: '',
    powerMin: null,
    powerMax: null,
    tonnageMin: null,
    tonnageMax: null,
    homePort: '',
  };
}
