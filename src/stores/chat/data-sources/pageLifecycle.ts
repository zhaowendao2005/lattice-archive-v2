/**
 * [DATA SOURCE] 页面生命周期句柄：转入后台 / 关闭前回调（冷启动快照落盘时机）。
 */
export const pageLifecycle = {
  onPageHidden(callback: () => void): () => void {
    const handleVisibility = () => { if (document.visibilityState === 'hidden') callback(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', callback);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', callback);
    };
  },
};
