/**
 * 渔船档案变更（SCD2 缓慢变化维）。
 *
 * 同一条船（vesselId 不变）的每次过户 / 更名都会追加一条档案版本：
 * - 生效前流水、泊位与地图上的船名一律照旧（历史记录冗余的是当时快照，不回写）；
 * - 只有一条 current 版本；scheduled 为已排期、pending 为在港挂起；
 * - 船在港期间申请的变更先挂着，等这一航次结束（下一次进港）后再生效；
 * - 旧版本变为 superseded 永久保留，历史流水按时间可还原当时船名。
 */
import type { FishingVessel } from './vessel';

/** 档案版本状态 */
export type VesselVersionStatus = 'current' | 'scheduled' | 'pending' | 'superseded';

export const VESSEL_VERSION_STATUSES: VesselVersionStatus[] = ['current', 'scheduled', 'pending', 'superseded'];

/** 渔船档案版本（一条船的一个历史 / 当前 / 待生效档案） */
export interface VesselVersion {
  id: string;
  /** 渔船 id（稳定主键，过户更名都不变） */
  vesselId: string;
  /** 版本序号，从 1 开始 */
  versionNo: number;
  /** 状态：当前 / 已排期 / 在港挂起 / 已被取代 */
  status: VesselVersionStatus;
  /** 该版本的船名快照 */
  name: string;
  /** 该版本的船籍港快照 */
  homePort: string;
  /** 该版本的船主快照 */
  owner: string;
  /** 变更原因（过户 / 更名等，可空） */
  reason: string;
  /** 申请时间（ISO） */
  requestedAt: string;
  /** 申请时填写的期望生效时间（ISO）；挂起时可能早于实际生效时间 */
  effectiveAt: string;
  /** 实际生效时间（ISO）；current 版本必填，其余为空 */
  appliedAt: string | null;
  /** 失效时间（ISO）；被新版本取代时回填，current 为空 */
  endedAt: string | null;
  /**
   * 在港挂起标记：true 表示申请变更时船正占用泊位，必须先出港、再进港
   * （完整跑完一个航次）后才允许生效；期间出现的出港流水会把它置为 false。
   */
  awaitingVoyage: boolean;
}

/** 档案变更申请表单 */
export interface VesselChangeInput {
  /** 新船名 */
  name: string;
  /** 新船籍港 */
  homePort: string;
  /** 新船主 */
  owner: string;
  /** 期望生效时间（datetime-local 值，可空=立即生效） */
  effectiveAt: string;
  /** 变更原因 */
  reason: string;
}

/** 档案变更结果，供调用方提示与刷新 */
export interface VesselChangeResult {
  version: VesselVersion;
  /** 实际落库状态：立即生效 / 已排期 / 在港挂起 */
  status: Extract<VesselVersionStatus, 'current' | 'scheduled' | 'pending'>;
  /** 是否在港挂起 */
  pending: boolean;
  /** 生效前该船是否仍在港（挂起场景为 true） */
  inPort: boolean;
  /** 申请时该船的最新修订号 */
  rev: number;
}

export function emptyVesselChangeInput(current?: FishingVessel): VesselChangeInput {
  return {
    name: current?.name ?? '',
    homePort: current?.homePort ?? '',
    owner: current?.owner ?? '',
    effectiveAt: '',
    reason: '',
  };
}

/** 版本状态对应的中文文案 */
export function versionStatusText(status: VesselVersionStatus): string {
  switch (status) {
    case 'current':
      return '生效中';
    case 'scheduled':
      return '已排期';
    case 'pending':
      return '在港挂起';
    case 'superseded':
      return '历史档案';
  }
}
