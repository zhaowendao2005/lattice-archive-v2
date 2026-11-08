/**
 * ============================================================================
 * 归档工作台 DOM 句柄注册表 (Archive DOM Handle Registry DataSource)
 * ============================================================================
 * 严格遵循 `.rules/frontend-architecture.md`「视图零本地 ref」原则：
 * 将画布容器、分组网格容器、上下文菜单容器等非业务 DOM 引用收敛在单例 Data Source。
 */
class ArchiveDomRegistry {
  private boardEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private folderModalEl: HTMLElement | null = null;
  private folderGridEl: HTMLElement | null = null;
  private groupGridEls = new Map<string, HTMLElement>();

  public setBoardEl(el: unknown): void {
    this.boardEl = el instanceof HTMLElement ? el : null;
  }

  public getBoardEl(): HTMLElement | null {
    return this.boardEl;
  }

  /** 文件夹弹窗卡片容器（用于判断指针是否已拖出弹窗范围） */
  public setFolderModalEl(el: unknown): void {
    this.folderModalEl = el instanceof HTMLElement ? el : null;
  }

  public getFolderModalEl(): HTMLElement | null {
    return this.folderModalEl;
  }

  /** 文件夹弹窗内部的像素网格容器（用于计算插入位置） */
  public setFolderGridEl(el: unknown): void {
    this.folderGridEl = el instanceof HTMLElement ? el : null;
  }

  public getFolderGridEl(): HTMLElement | null {
    return this.folderGridEl;
  }

  public setMenuEl(el: unknown): void {
    this.menuEl = el instanceof HTMLElement ? el : null;
  }

  public getMenuEl(): HTMLElement | null {
    return this.menuEl;
  }

  public setContextMenuEl(el: unknown): void {
    this.setMenuEl(el);
  }

  public getContextMenuEl(): HTMLElement | null {
    return this.getMenuEl();
  }

  public setGroupGridEl(groupId: string, el: unknown): void {
    if (el instanceof HTMLElement) {
      this.groupGridEls.set(groupId, el);
    } else {
      this.groupGridEls.delete(groupId);
    }
  }

  public getGroupGridEl(groupId: string): HTMLElement | null {
    return this.groupGridEls.get(groupId) ?? null;
  }
}

export const archiveDomRegistry = new ArchiveDomRegistry();
