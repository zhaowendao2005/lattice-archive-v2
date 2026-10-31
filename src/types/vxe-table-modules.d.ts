// vxe-table 4.16 publishes runtime subpath modules without adjacent declarations.
// Map those modules to the official component types so only table/column load.
/**
 * vxe-table 4.16 的运行时子路径缺少类型声明文件，这里手工补齐三个入口：
 * table（表格本体）/ column（列定义）/ ui（全局配置 VxeUI）。
 * 只映射现有类型，不新增类型——若 vxe-table 升级后自带 d.ts，可删除本文件。
 */
declare module 'vxe-table/es/table' {
  import VxeTable from 'vxe-pc-ui/types/components/table';
  export { VxeTable };
  export default VxeTable;
}
declare module 'vxe-table/es/ui' {
  import type { VxeUIExport } from 'vxe-pc-ui';
  export const VxeUI: VxeUIExport;
  export default VxeUI;
}
declare module 'vxe-table/es/column' {
  import VxeColumn from 'vxe-pc-ui/types/components/column';
  export { VxeColumn };
  export default VxeColumn;
}
