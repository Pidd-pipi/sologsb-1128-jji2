/**
 * 本地数据变更通知。
 *
 * - 同页：档案变更、流水登记后各 store 据此互相同步（例如登记出港触发挂起档案生效）；
 * - 跨标签页：两个人在两个窗口同时操作同一条船时，通过 BroadcastChannel 通知对端重载，
 *   旧页面提交时会因修订号过期收到冲突提示，未提交的页面靠这里的广播自动刷新到最新档案。
 */

export type DataEvent = 'vessel-mutated' | 'call-registered';

type Handler = (event: DataEvent) => void;

const listeners = new Set<Handler>();
/** 每个事件待回显给本页的次数：仅用于抵消 includeLocal 广播对发起方自己的回声 */
const echoCounts: Record<DataEvent, number> = {
  'vessel-mutated': 0,
  'call-registered': 0,
};

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel !== null) return channel;
  if (typeof BroadcastChannel === 'undefined') {
    channel = null;
    return null;
  }
  channel = new BroadcastChannel('gbfishport-db-events');
  channel.onmessage = (event: MessageEvent<DataEvent>) => {
    if (event.data === 'vessel-mutated' || event.data === 'call-registered') {
      // 来自其它标签页：所有订阅者都正常处理（不计入本页回声）
      listeners.forEach((fn) => fn(event.data));
    }
  };
  return channel;
}

/** 订阅本地数据变更（同页广播 + 其它标签页消息）。返回取消订阅函数。 */
export function subscribeDataChange(handler: Handler): () => void {
  getChannel();
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/**
 * 广播数据变更。默认只通知其它标签页（本页发起方通常已自行刷新）。
 * includeLocal 为 true 时同时通知本页订阅者；调用方可先调用 markLocalEcho
 * 让自己的订阅跳过这一次回声，而其它订阅者照常收到。
 */
export function emitDataEvent(event: DataEvent, includeLocal = false): void {
  if (includeLocal) {
    listeners.forEach((fn) => fn(event));
  }
  try {
    getChannel()?.postMessage(event);
  } catch {
    // 广播失败不影响主流程
  }
}

/** 登记一次“即将发出的本页回声”，发起方订阅据此跳过下一次同类本页事件 */
export function markLocalEcho(event: DataEvent): void {
  echoCounts[event] += 1;
}

/** 发起方订阅调用：若这是自己刚发出的回声则返回 true（应跳过本次刷新） */
export function consumeLocalEcho(event: DataEvent): boolean {
  if (echoCounts[event] > 0) {
    echoCounts[event] -= 1;
    return true;
  }
  return false;
}
