import { onMounted, onUnmounted } from 'vue';
import { applyDueScheduled } from '../db/vesselArchive';
import { emitDataEvent, markLocalEcho } from '../db/events';

/**
 * 定时处理“已排期且到点”的档案变更：船不在港（在海上，本航次已结束）立即生效。
 * 在港挂起的版本不走这里，由进出港流水事件驱动。
 */
export function useScheduledArchiveTicker(intervalMs = 30_000): void {
  let timer: number | undefined;

  async function tick(): Promise<void> {
    try {
      const applied = await applyDueScheduled();
      if (applied.length) {
        // 通知本页各视图与其它标签页刷新档案与泊位（发起方 store 自行跳过回声）
        markLocalEcho('vessel-mutated');
        emitDataEvent('vessel-mutated', true);
      }
    } catch {
      // 轮询失败不打扰用户，下一轮再试
    }
  }

  onMounted(() => {
    void tick();
    timer = window.setInterval(() => void tick(), intervalMs);
  });

  onUnmounted(() => {
    if (timer !== undefined) window.clearInterval(timer);
  });
}
