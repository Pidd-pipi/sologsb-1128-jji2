/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 进出港记录 */
export interface PortCall {
  id: string;
  /** 渔船 id（稳定主键，更名过户后历史流水仍指向同一艘船） */
  vesselId: string;
  /** 登记当时的船名快照，档案变更后绝不回写，保证历史流水可按当时船名追溯 */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /** 泊位号 */
  berthNo: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  createdAt: string;
}

/** 进出港登记表单模型 */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  time: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
}

export function emptyCallDraft(berthNo = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: '',
    berthNo,
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
  };
}
