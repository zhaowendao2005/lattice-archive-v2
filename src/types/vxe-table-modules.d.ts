// vxe-table 4.16 publishes runtime subpath modules without adjacent declarations.
// Map those modules to the official component types so only table/column load.
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
