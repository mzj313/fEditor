//! 插件契约：插件只依赖这里的类型，不直接引用主程序内部模块，
//! 主程序也只通过 mount 返回值（清理函数）与插件交互。

export interface PluginFilePayload {
  path: string;
  content: string;
}

/** 宿主提供给插件的受控能力，插件拿不到 TabStore / 编辑器等核心对象 */
export interface PluginContext {
  /** 弹出系统文件选择框，返回选中的绝对路径 */
  pickFiles(): Promise<string[]>;
  /** 读取文本文件（二进制会抛错） */
  readFile(path: string): Promise<PluginFilePayload>;
  /** 在状态栏闪现一条提示 */
  showStatus(text: string): void;
}

export interface ToolPlugin {
  /** 唯一标识，用于防重复挂载 */
  id: string;
  /** 面板标题 */
  title: string;
  /** 对应的原生菜单项 id；主程序据此把菜单动作路由到插件 */
  menuId?: string;
  /** 默认快捷键，进设置面板后可由用户修改 */
  shortcut?: string;
  /** 打开时的建议面板高度（px），用户仍可拖动调整；不填沿用上次高度 */
  preferredHeight?: number;
  /**
   * 把插件内容挂到 host 上。
   * 返回值可选：关闭面板时调用，用来清定时器、解绑全局事件等。
   */
  mount(host: HTMLElement, ctx: PluginContext): void | (() => void);
}
